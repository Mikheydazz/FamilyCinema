const express = require('express');
const http = require('http');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 3000;
const DATA_FILE = path.join(__dirname, 'data.json');
const MAX_CHANNELS = 20;

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ---------- DB ----------
let db = { users: [], servers: [], nextUserId: 1, nextServerId: 1, nextChannelId: 1 };
function loadDb() {
  try {
    db = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    db.users ||= []; db.servers ||= [];
    db.channelMessages ||= {};
    db.dms ||= {};
    db.nextUserId ||= (db.users.reduce((m, u) => Math.max(m, +u.id), 0) || 0) + 1;
    db.nextServerId ||= (db.servers.reduce((m, s) => Math.max(m, +s.id), 0) || 0) + 1;
    db.nextChannelId ||= 1;
    // Миграция пользователей
    for (const u of db.users) {
      u.description ||= '';
      u.avatar ||= '';
    }

    // Миграция сообщений: проставить id там, где его нет
    const ensureMsgId = (m) => { if (!m.id) m.id = crypto.randomBytes(8).toString('hex'); };
    for (const arr of Object.values(db.channelMessages || {})) {
      if (Array.isArray(arr)) arr.forEach(ensureMsgId);
    }
    for (const arr of Object.values(db.dms || {})) {
      if (Array.isArray(arr)) arr.forEach(ensureMsgId);
    }

    // Проставляем отсутствующие поля у серверов
    for (const s of db.servers) {
      s.members ||= s.ownerId ? [s.ownerId] : [];
      s.channels ||= [];
      s.roles ||= [];
      s.userRoles ||= {};
    }
  } catch {}
}
function saveDb() { fs.writeFileSync(DATA_FILE, JSON.stringify(db, null, 2)); }
loadDb();

let _saveTimer = null;
function scheduleSave() {
  if (_saveTimer) return;
  _saveTimer = setTimeout(() => {
    _saveTimer = null;
    try { saveDb(); } catch (e) { console.error('saveDb failed', e); }
  }, 500);
}

// ---------- Auth ----------
function hashPassword(password, salt) {
  const s = salt || crypto.randomBytes(16).toString('hex');
  return { salt: s, hash: crypto.scryptSync(password, s, 64).toString('hex') };
}
function verifyPassword(password, salt, hash) {
  const h = crypto.scryptSync(password, salt, 64).toString('hex');
  try { return crypto.timingSafeEqual(Buffer.from(h, 'hex'), Buffer.from(hash, 'hex')); }
  catch { return false; }
}
const sessions = new Map();
function createToken() { return crypto.randomBytes(24).toString('hex'); }

app.post('/api/register', (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) return res.status(400).json({ error: 'Заполните все поля' });
  if (username.length < 3 || username.length > 20) return res.status(400).json({ error: 'Имя: 3–20 символов' });
  if (password.length < 4) return res.status(400).json({ error: 'Пароль: минимум 4 символа' });
  if (db.users.find(u => u.username.toLowerCase() === username.toLowerCase())) {
    return res.status(400).json({ error: 'Имя занято' });
  }
  const { salt, hash } = hashPassword(password);
  const user = { id: String(db.nextUserId++), username, salt, hash, createdAt: Date.now() };
  db.users.push(user); saveDb();
  const token = createToken(); sessions.set(token, user.id);
  res.json({ token, user: { id: user.id, username: user.username } });
});

app.post('/api/login', (req, res) => {
  const { username, password } = req.body || {};
  const user = db.users.find(u => u.username.toLowerCase() === String(username || '').toLowerCase());
  if (!user || !verifyPassword(password || '', user.salt, user.hash)) {
    return res.status(400).json({ error: 'Неверное имя или пароль' });
  }
  const token = createToken(); sessions.set(token, user.id);
  res.json({ token, user: { id: user.id, username: user.username } });
});

// ---------- WS ----------
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });

const clients = new Map();      // ws -> client
const byUser = new Map();       // userId -> Set<ws>
const textMessages = new Map(); // channelId -> [msg]
const cinemaState = new Map();  // channelId -> state
const voiceMembers = new Map(); // channelId -> Set<userId>

// Гидратируем историю текстовых сообщений из сохранённой БД
for (const [chId, msgs] of Object.entries(db.channelMessages || {})) {
  if (Array.isArray(msgs)) textMessages.set(chId, msgs);
}

function send(ws, obj) { if (ws.readyState === 1) ws.send(JSON.stringify(obj)); }
function userWs(userId) { return [...(byUser.get(userId) || [])]; }
function broadcastToAll(obj) {
  const data = JSON.stringify(obj);
  for (const ws of clients.keys()) if (ws.readyState === 1) ws.send(data);
}
function broadcastToServer(serverId, obj, exceptWs = null) {
  const data = JSON.stringify(obj);
  for (const [ws, c] of clients) if (c.serverId === serverId && ws !== exceptWs && ws.readyState === 1) ws.send(data);
}
function broadcastToChannel(serverId, channelId, obj, exceptWs = null) {
  const data = JSON.stringify(obj);
  for (const [ws, c] of clients) if (c.serverId === serverId && c.channelId === channelId && ws !== exceptWs && ws.readyState === 1) ws.send(data);
}
function broadcastPresence() {
  broadcastToAll({ type: 'presence', users: [...byUser.keys()] });
}
function voiceMembersView(channelId) {
  const ids = [...(voiceMembers.get(channelId) || [])];
  return ids.map(uid => {
    const u = db.users.find(x => x.id === uid);
    if (!u) return null;
    let muted = false;
    for (const [, c] of clients) if (c.userId === uid && c.voiceChannelId === channelId) { muted = c.muted; break; }
    return { id: u.id, username: u.username, muted };
  }).filter(Boolean);
}
function hasPerm(server, userId, perm) {
  if (!server) return false;
  if (server.ownerId === userId) return true;
  const roleIds = (server.userRoles || {})[userId] || [];
  for (const rid of roleIds) {
    const r = (server.roles || []).find(r => r.id === rid);
    if (!r) continue;
    if (r.permissions?.admin) return true;
    if (r.permissions?.[perm]) return true;
  }
  return false;
}

function serverView(s) {
  return {
    id: s.id, name: s.name, ownerId: s.ownerId,
    channels: s.channels.map(ch => ({
      id: ch.id, name: ch.name, type: ch.type,
      voiceMembers: ch.type === 'voice' ? voiceMembersView(ch.id) : undefined
    })),
    roles: s.roles || [],
    userRoles: s.userRoles || {},
    members: s.members.map(uid => {
      const u = db.users.find(x => x.id === uid);
      return u ? { id: u.id, username: u.username, description: u.description || '', avatar: u.avatar || '' } : null;
    }).filter(Boolean),
  };
}
function broadcastVoiceState(serverId, channelId) {
  broadcastToServer(serverId, {
    type: 'voice-state', channelId, members: voiceMembersView(channelId)
  });
}
function leaveVoice(client) {
  const chId = client.voiceChannelId;
  if (!chId) return;
  client.voiceChannelId = null;
  const set = voiceMembers.get(chId);
  if (set) { set.delete(client.userId); if (!set.size) voiceMembers.delete(chId); }
  if (client.serverId) broadcastVoiceState(client.serverId, chId);
}

wss.on('connection', (ws, req) => {
  const url = new URL(req.url, 'http://x');
  const token = url.searchParams.get('token');
  const userId = sessions.get(token);
  const user = userId && db.users.find(u => u.id === userId);
  if (!user) { send(ws, { type: 'auth-error', message: 'Сессия истекла' }); ws.close(); return; }

  const client = {
    userId: user.id, username: user.username,
    serverId: null, channelId: null, voiceChannelId: null, muted: false
  };
  clients.set(ws, client);
  if (!byUser.has(user.id)) byUser.set(user.id, new Set());
  byUser.get(user.id).add(ws);

  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });

  const myServers = db.servers.filter(s => s.members.includes(user.id));
  const userPublic = { id: user.id, username: user.username, description: user.description || '', avatar: user.avatar || '' };
  send(ws, {
    type: 'ready',
    user: userPublic,
    servers: myServers.map(s => ({ id: s.id, name: s.name })),
    users: db.users.map(u => ({ id: u.id, username: u.username, description: u.description || '', avatar: u.avatar || '' })),
    online: [...byUser.keys()]
  });
  broadcastPresence();
  broadcastToAll({ type: 'user-joined', user: userPublic });

  ws.on('message', (raw) => {
    let msg; try { msg = JSON.parse(raw.toString()); } catch { return; }
    handle(ws, client, msg);
  });

  ws.on('close', () => {
    if (client.voiceChannelId) leaveVoice(client);
    if (client.serverId) broadcastToServer(client.serverId, { type: 'member-left', userId: client.userId }, ws);
    clients.delete(ws);
    const set = byUser.get(user.id);
    if (set) { set.delete(ws); if (!set.size) byUser.delete(user.id); }
    broadcastPresence();
  });
});

function handle(ws, client, msg) {
  switch (msg.type) {
    case 'list-all-servers': {
      send(ws, {
        type: 'all-servers',
        servers: db.servers.map(s => ({
          id: s.id, name: s.name, member: s.members.includes(client.userId)
        }))
      });
      break;
    }

    case 'get-server': {
      const server = db.servers.find(s => s.id === msg.serverId && s.members.includes(client.userId));
      if (!server) return send(ws, { type: 'error', message: 'Нет доступа к серверу' });
      if (client.serverId && client.serverId !== server.id) {
        broadcastToServer(client.serverId, { type: 'member-left', userId: client.userId }, ws);
        if (client.voiceChannelId) leaveVoice(client);
      }
      client.serverId = server.id;
      client.channelId = null;
      send(ws, { type: 'server', server: serverView(server) });
      break;
    }

    case 'create-server': {
      const name = String(msg.name || '').trim().slice(0, 40);
      if (!name) return;
      const server = {
        id: String(db.nextServerId++), name, ownerId: client.userId,
        members: [client.userId],
        roles: [],
        userRoles: {},
        channels: [
          { id: String(db.nextChannelId++), name: 'general', type: 'text' },
          { id: String(db.nextChannelId++), name: 'кино', type: 'cinema' },
          { id: String(db.nextChannelId++), name: 'голосовой', type: 'voice' },
        ]
      };
      db.servers.push(server); saveDb();
      broadcastToAll({ type: 'server-list-add', server: { id: server.id, name: server.name }, members: server.members });
      handle(ws, client, { type: 'get-server', serverId: server.id });
      break;
    }

    case 'join-existing-server': {
      const server = db.servers.find(s => s.id === msg.serverId);
      if (!server) return;
      if (!server.members.includes(client.userId)) {
        server.members.push(client.userId); saveDb();
        broadcastToAll({ type: 'server-list-add', server: { id: server.id, name: server.name }, members: server.members });
      }
      handle(ws, client, { type: 'get-server', serverId: server.id });
      break;
    }

    case 'create-channel': {
        const server = db.servers.find(s => s.id === client.serverId);
        if (!server || !hasPerm(server, client.userId, 'manageChannels')) return send(ws, { type: 'error', message: 'Нет права управлять каналами' });
        if (server.channels.length >= MAX_CHANNELS) {
            return send(ws, { type: 'error', message: `Максимум ${MAX_CHANNELS} каналов на сервере` });
        }
        const name = String(msg.name || '').trim().slice(0, 30);
        const type = ['text', 'voice', 'cinema'].includes(msg.channelType) ? msg.channelType : 'text';
        if (!name) return;
        const ch = { id: String(db.nextChannelId++), name, type };
        server.channels.push(ch); saveDb();
        broadcastToServer(server.id, { type: 'channel-created', channel: ch });
        break;
        }

    case 'rename-channel': {
        const server = db.servers.find(s => s.id === client.serverId);
        if (!server || !hasPerm(server, client.userId, 'manageChannels')) return send(ws, { type: 'error', message: 'Нет права управлять каналами' });
        const ch = server.channels.find(c => c.id === msg.channelId);
        if (!ch) return send(ws, { type: 'error', message: 'Канал не найден' });
        const name = String(msg.name || '').trim().slice(0, 30);
        if (!name) return send(ws, { type: 'error', message: 'Введите название' });
        ch.name = name;
        saveDb();
        broadcastToServer(server.id, { type: 'channel-renamed', channelId: ch.id, name });
        break;
    }

    case 'delete-channel': {
        const server = db.servers.find(s => s.id === client.serverId);
        if (!server || !hasPerm(server, client.userId, 'manageChannels')) return send(ws, { type: 'error', message: 'Нет права управлять каналами' });
        const idx = server.channels.findIndex(c => c.id === msg.channelId);
        if (idx === -1) return;
        const ch = server.channels[idx];
        server.channels.splice(idx, 1);
        saveDb();

        // чистим состояние канала
        textMessages.delete(ch.id);
        cinemaState.delete(ch.id);
        voiceMembers.delete(ch.id);
        if (db.channelMessages) delete db.channelMessages[ch.id];
        scheduleSave();
        for (const [, c] of clients) {
            if (c.channelId === ch.id) c.channelId = null;
            if (c.voiceChannelId === ch.id) c.voiceChannelId = null;
        }

        broadcastToServer(server.id, { type: 'channel-deleted', channelId: ch.id });
        break;
    }

        case 'create-role': {
      const server = db.servers.find(s => s.id === client.serverId);
      if (!server || !hasPerm(server, client.userId, 'manageRoles')) return send(ws, { type: 'error', message: 'Нет права управлять ролями' });
      if ((server.roles || []).length >= 30) return send(ws, { type: 'error', message: 'Максимум 30 ролей' });
      const name = String(msg.name || '').trim().slice(0, 30);
      if (!name) return;
      const role = {
        id: 'role-' + crypto.randomBytes(4).toString('hex'),
        name,
        color: /^#[0-9a-f]{6}$/i.test(msg.color) ? msg.color : '#99aab5',
        permissions: {
          admin: !!msg.permissions?.admin,
          manageChannels: !!msg.permissions?.manageChannels,
          manageRoles: !!msg.permissions?.manageRoles,
          manageCinema: !!msg.permissions?.manageCinema
        }
      };
      server.roles.push(role); saveDb();
      broadcastToServer(server.id, { type: 'role-created', role });
      break;
    }

    case 'update-role': {
      const server = db.servers.find(s => s.id === client.serverId);
      if (!server || !hasPerm(server, client.userId, 'manageRoles')) return send(ws, { type: 'error', message: 'Нет права управлять ролями' });
      const role = server.roles.find(r => r.id === msg.roleId);
      if (!role) return;
      if (msg.name !== undefined) {
        const n = String(msg.name).trim().slice(0, 30);
        if (n) role.name = n;
      }
      if (typeof msg.color === 'string' && /^#[0-9a-f]{6}$/i.test(msg.color)) role.color = msg.color;
      if (msg.permissions) {
        role.permissions = {
          admin: !!msg.permissions.admin,
          manageChannels: !!msg.permissions.manageChannels,
          manageRoles: !!msg.permissions.manageRoles,
          manageCinema: !!msg.permissions.manageCinema
        };
      }
      saveDb();
      broadcastToServer(server.id, { type: 'role-updated', role });
      break;
    }

    case 'delete-role': {
      const server = db.servers.find(s => s.id === client.serverId);
      if (!server || !hasPerm(server, client.userId, 'manageRoles')) return send(ws, { type: 'error', message: 'Нет права управлять ролями' });
      const idx = server.roles.findIndex(r => r.id === msg.roleId);
      if (idx === -1) return;
      server.roles.splice(idx, 1);
      for (const uid of Object.keys(server.userRoles)) {
        server.userRoles[uid] = (server.userRoles[uid] || []).filter(r => r !== msg.roleId);
      }
      saveDb();
      broadcastToServer(server.id, { type: 'role-deleted', roleId: msg.roleId });
      break;
    }

    case 'assign-role': {
      const server = db.servers.find(s => s.id === client.serverId);
      if (!server || !hasPerm(server, client.userId, 'manageRoles')) return send(ws, { type: 'error', message: 'Нет права управлять ролями' });
      if (!server.roles.find(r => r.id === msg.roleId)) return;
      if (!server.members.includes(msg.userId)) return;
      if (msg.userId === server.ownerId) return;
      if (!server.userRoles[msg.userId]) server.userRoles[msg.userId] = [];
      if (!server.userRoles[msg.userId].includes(msg.roleId)) {
        server.userRoles[msg.userId].push(msg.roleId);
        saveDb();
        broadcastToServer(server.id, { type: 'role-assigned', userId: msg.userId, roleId: msg.roleId });
      }
      break;
    }

    case 'unassign-role': {
      const server = db.servers.find(s => s.id === client.serverId);
      if (!server || !hasPerm(server, client.userId, 'manageRoles')) return send(ws, { type: 'error', message: 'Нет права управлять ролями' });
      if (!server.userRoles[msg.userId]) return;
      server.userRoles[msg.userId] = server.userRoles[msg.userId].filter(r => r !== msg.roleId);
      saveDb();
      broadcastToServer(server.id, { type: 'role-unassigned', userId: msg.userId, roleId: msg.roleId });
      break;
    }

    case 'join-channel': {
      const server = db.servers.find(s => s.id === client.serverId);
      if (!server) return;
      const ch = server.channels.find(c => c.id === msg.channelId);
      if (!ch) return;
      client.channelId = ch.id;
      send(ws, { type: 'channel', channel: { id: ch.id, name: ch.name, type: ch.type } });
      if (ch.type === 'text') {
        send(ws, { type: 'messages', channelId: ch.id, messages: (textMessages.get(ch.id) || []).slice(-200) });
      } else if (ch.type === 'cinema') {
        const st = cinemaState.get(ch.id) || { source: '', time: 0, paused: true, updatedAt: Date.now() };
        send(ws, { type: 'cinema-state', channelId: ch.id, state: st });
      } else if (ch.type === 'voice') {
        send(ws, { type: 'voice-state', channelId: ch.id, members: voiceMembersView(ch.id) });
      }
      break;
    }

    case 'chat': {
      const server = db.servers.find(s => s.id === client.serverId);
      if (!server) return;
      const ch = server.channels.find(c => c.id === client.channelId && c.type === 'text');
      if (!ch) return;
      const text = String(msg.text || '').slice(0, 500);
      let image = '';
      if (typeof msg.image === 'string' && msg.image) {
        if (msg.image.length > 2_000_000) return send(ws, { type: 'error', message: 'Картинка слишком большая (макс ~1.5 МБ)' });
        if (!/^https?:\/\//i.test(msg.image) && !/^data:image\//i.test(msg.image)) {
          return send(ws, { type: 'error', message: 'Недопустимый формат картинки' });
        }
        image = msg.image;
      }
      if (!text && !image) return;
      const m = { id: crypto.randomBytes(8).toString('hex'), from: client.username, fromId: client.userId, text, ts: Date.now() };
      if (image) m.image = image;
      if (!textMessages.has(ch.id)) textMessages.set(ch.id, []);
      const arr = textMessages.get(ch.id);
      arr.push(m); if (arr.length > 500) arr.splice(0, arr.length - 500);
      db.channelMessages = db.channelMessages || {};
      db.channelMessages[ch.id] = arr;
      scheduleSave();
      broadcastToServer(server.id, { type: 'chat', channelId: ch.id, message: m });
      break;
    }

    case 'dm': {
      const text = String(msg.text || '').slice(0, 500);
      let image = '';
      if (typeof msg.image === 'string' && msg.image) {
        if (msg.image.length > 2_000_000) return send(ws, { type: 'error', message: 'Картинка слишком большая (макс ~1.5 МБ)' });
        if (!/^https?:\/\//i.test(msg.image) && !/^data:image\//i.test(msg.image)) {
          return send(ws, { type: 'error', message: 'Недопустимый формат картинки' });
        }
        image = msg.image;
      }
      if (!text && !image) return;
      const m = { id: crypto.randomBytes(8).toString('hex'), from: client.username, fromId: client.userId, text, ts: Date.now() };
      if (image) m.image = image;
      const key = [client.userId, msg.targetId].sort().join('|');
      db.dms = db.dms || {};
      if (!db.dms[key]) db.dms[key] = [];
      db.dms[key].push(m);
      if (db.dms[key].length > 500) db.dms[key].splice(0, db.dms[key].length - 500);
      scheduleSave();
      send(ws, { type: 'dm', message: m, threadWith: msg.targetId });
      for (const tws of userWs(msg.targetId)) {
        send(tws, { type: 'dm', message: m, threadWith: client.userId });
      }
      break;
    }

    case 'edit-chat': {
      const server = db.servers.find(s => s.id === client.serverId);
      if (!server) return;
      const ch = server.channels.find(c => c.id === msg.channelId && c.type === 'text');
      if (!ch) return;
      const arr = textMessages.get(ch.id) || [];
      const m = arr.find(x => x.id === msg.messageId);
      if (!m) return;
      if (m.fromId !== client.userId) return send(ws, { type: 'error', message: 'Можно редактировать только свои сообщения' });
      const text = String(msg.text || '').slice(0, 500);
      if (!text && !m.image) return;
      m.text = text;
      m.edited = Date.now();
      scheduleSave();
      broadcastToServer(server.id, { type: 'chat-edited', channelId: ch.id, messageId: m.id, text, edited: m.edited });
      break;
    }

    case 'delete-chat': {
      const server = db.servers.find(s => s.id === client.serverId);
      if (!server) return;
      const ch = server.channels.find(c => c.id === msg.channelId && c.type === 'text');
      if (!ch) return;
      const arr = textMessages.get(ch.id) || [];
      const idx = arr.findIndex(x => x.id === msg.messageId);
      if (idx === -1) return;
      if (arr[idx].fromId !== client.userId) return send(ws, { type: 'error', message: 'Можно удалять только свои сообщения' });
      arr.splice(idx, 1);
      scheduleSave();
      broadcastToServer(server.id, { type: 'chat-deleted', channelId: ch.id, messageId: msg.messageId });
      break;
    }

    case 'edit-dm': {
      const key = [client.userId, msg.otherId].sort().join('|');
      const arr = (db.dms && db.dms[key]) || [];
      const m = arr.find(x => x.id === msg.messageId);
      if (!m) return;
      if (m.fromId !== client.userId) return;
      const text = String(msg.text || '').slice(0, 500);
      if (!text && !m.image) return;
      m.text = text;
      m.edited = Date.now();
      scheduleSave();
      send(ws, { type: 'dm-edited', threadWith: msg.otherId, messageId: m.id, text, edited: m.edited });
      for (const tws of userWs(msg.otherId)) {
        send(tws, { type: 'dm-edited', threadWith: client.userId, messageId: m.id, text, edited: m.edited });
      }
      break;
    }

    case 'delete-dm': {
      const key = [client.userId, msg.otherId].sort().join('|');
      const arr = (db.dms && db.dms[key]) || [];
      const idx = arr.findIndex(x => x.id === msg.messageId);
      if (idx === -1) return;
      if (arr[idx].fromId !== client.userId) return;
      arr.splice(idx, 1);
      scheduleSave();
      send(ws, { type: 'dm-deleted', threadWith: msg.otherId, messageId: msg.messageId });
      for (const tws of userWs(msg.otherId)) {
        send(tws, { type: 'dm-deleted', threadWith: client.userId, messageId: msg.messageId });
      }
      break;
    }

    case 'get-dm-history': {
      const other = db.users.find(u => u.id === msg.otherId);
      const key = [client.userId, msg.otherId].sort().join('|');
      const arr = (db.dms && db.dms[key]) || [];
      send(ws, { type: 'dm-history', otherId: msg.otherId, otherUsername: other?.username || '', messages: arr });
      break;
    }

    case 'cinema-source': {
      const server = db.servers.find(s => s.id === client.serverId);
      const ch = server && server.channels.find(c => c.id === client.channelId && c.type === 'cinema');
      if (!ch) return;
      if (!hasPerm(server, client.userId, 'manageCinema')) return send(ws, { type: 'error', message: 'Нет права управлять кинотеатром' });
      const st = { source: String(msg.source || ''), time: 0, paused: true, updatedAt: Date.now() };
      cinemaState.set(ch.id, st);
      broadcastToChannel(server.id, ch.id, { type: 'cinema-state', channelId: ch.id, state: st }, ws);
      break;
    }

    case 'cinema-sync': {
      const server = db.servers.find(s => s.id === client.serverId);
      const ch = server && server.channels.find(c => c.id === client.channelId && c.type === 'cinema');
      if (!ch) return;
      const prev = cinemaState.get(ch.id) || {};
      const st = {
        source: msg.source ?? prev.source ?? '',
        time: Number(msg.time) || 0,
        paused: !!msg.paused,
        updatedAt: Date.now()
      };
      cinemaState.set(ch.id, st);
      broadcastToChannel(server.id, ch.id, { type: 'cinema-sync', channelId: ch.id, state: st, by: client.userId }, ws);
      break;
    }

    case 'cinema-time': {
      const server = db.servers.find(s => s.id === client.serverId);
      const ch = server && server.channels.find(c => c.id === client.channelId && c.type === 'cinema');
      if (!ch) return;
      broadcastToChannel(server.id, ch.id, {
        type: 'cinema-time', channelId: ch.id, userId: client.userId,
        time: Number(msg.time) || 0, paused: !!msg.paused
      }, ws);
      break;
    }

    case 'voice-join': {
      const server = db.servers.find(s => s.id === client.serverId);
      const ch = server && server.channels.find(c => c.id === msg.channelId && c.type === 'voice');
      if (!ch) return;
      if (client.voiceChannelId) leaveVoice(client);
      client.voiceChannelId = ch.id;
      if (!voiceMembers.has(ch.id)) voiceMembers.set(ch.id, new Set());
      voiceMembers.get(ch.id).add(client.userId);
      broadcastVoiceState(server.id, ch.id);
      break;
    }

    case 'voice-leave': {
      leaveVoice(client);
      break;
    }

    case 'voice-mute': {
      client.muted = !!msg.muted;
      if (client.voiceChannelId && client.serverId) broadcastVoiceState(client.serverId, client.voiceChannelId);
      break;
    }

    case 'voice-signal': {
      if (!client.voiceChannelId) return;
      for (const tws of userWs(msg.targetId)) {
        send(tws, { type: 'voice-signal', from: client.userId, data: msg.data, channelId: client.voiceChannelId });
      }
      break;
    }

    case 'update-profile': {
      const u = db.users.find(x => x.id === client.userId);
      if (!u) return;
      if (msg.username !== undefined) {
        const name = String(msg.username).trim().slice(0, 20);
        if (name.length < 3) return send(ws, { type: 'error', message: 'Ник: минимум 3 символа' });
        if (db.users.find(x => x.id !== u.id && x.username.toLowerCase() === name.toLowerCase())) {
          return send(ws, { type: 'error', message: 'Имя занято' });
        }
        u.username = name;
        client.username = name;
      }
      if (msg.description !== undefined) {
        u.description = String(msg.description).slice(0, 500);
      }
      if (msg.avatar !== undefined) {
        const av = String(msg.avatar);
        if (av.length > 50000) return send(ws, { type: 'error', message: 'Слишком длинный URL аватара' });
        u.avatar = av;
      }
      saveDb();
      const payload = { id: u.id, username: u.username, description: u.description || '', avatar: u.avatar || '' };
      broadcastToAll({ type: 'user-updated', user: payload });
      break;
    }
  }
}

setInterval(() => {
  for (const ws of wss.clients) {
    if (ws.isAlive === false) return ws.terminate();
    ws.isAlive = false;
    ws.ping();
  }
}, 30000);

server.listen(PORT, () => console.log(`http://localhost:${PORT}`));