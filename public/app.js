const $ = id => document.getElementById(id);

// ---------- State ----------
let ws = null;
let me = null;
let token = localStorage.getItem('token');

let servers = [];                 // [{id, name}]
let allServers = [];              // [{id, name, member}]
let users = [];                   // [{id, username}]
let onlineSet = new Set();

let viewMode = 'home';            // 'home' | 'server'
let activeServer = null;          // full server view
let activeChannel = null;         // {id, name, type}
let activeDM = null;              // userId

const channelMessages = new Map();// channelId -> [msg]
const dmThreads = new Map();      // userId -> { messages: [...] }
const cinemaTimes = new Map();    // userId -> { time, paused }
const unreadChannels = new Map(); // channelId -> count
const unreadDMs = new Map();      // userId -> count

// voice
let localStream = null;
let localMuted = false;
let localSpeaking = false;
let myVoiceChannelId = null;
const pcs = new Map();
const analysers = new Map();
const speakingPeers = new Set();

// cinema
let player = null;
let playerKind = 'none';
let currentSource = '';
let applyingRemote = false;

// ---------- Utils ----------
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}
function fmtTime(t) {
  if (!Number.isFinite(t) || t < 0) t = 0;
  return `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, '0')}`;
}
function wsSend(obj) { if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj)); }

function getUser(id) {
  return users.find(u => u.id === id);
}
function userColor(id) {
  let h = 0;
  const s = String(id || '');
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return `hsl(${Math.abs(h) % 360}, 55%, 45%)`;
}
function avatarHtml(user, size = 32, extraClass = '') {
  const name = user?.username || '?';
  const url = user?.avatar;
  const letter = escapeHtml(name.slice(0, 1).toUpperCase());
  if (url) {
    return `<img class="user-avatar ${extraClass}" src="${escapeHtml(url)}" alt="${escapeHtml(name)}" style="width:${size}px;height:${size}px">`;
  }
  const bg = userColor(user?.id || name);
  return `<span class="user-avatar user-avatar-letter ${extraClass}" style="width:${size}px;height:${size}px;background:${bg};font-size:${Math.round(size * 0.45)}px">${letter}</span>`;
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

// ---------- Auth ----------
async function doAuth(endpoint) {
  const username = $('authName').value.trim();
  const password = $('authPass').value;
  if (!username || !password) { $('authError').textContent = 'Заполните поля'; return; }
  try {
    const res = await fetch(endpoint, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password })
    });
    const data = await res.json();
    if (!res.ok) { $('authError').textContent = data.error || 'Ошибка'; return; }
    token = data.token;
    localStorage.setItem('token', token);
    me = data.user;
    connectWS();
  } catch (err) {
    $('authError').textContent = 'Сеть недоступна';
  }
}
$('loginBtn').addEventListener('click', () => doAuth('/api/login'));
$('registerBtn').addEventListener('click', () => doAuth('/api/register'));
$('authPass').addEventListener('keydown', e => { if (e.key === 'Enter') doAuth('/api/login'); });

// ---------- WS ----------
function connectWS() {
  const proto = location.protocol === 'https:' ? 'wss://' : 'ws://';
  ws = new WebSocket(proto + location.host + '/ws?token=' + encodeURIComponent(token));
  ws.onmessage = onMessage;
  ws.onclose = () => { ws = null; setTimeout(() => { if (token) connectWS(); }, 1500); };
  ws.onerror = () => {};
}

function onMessage(ev) {
  let msg; try { msg = JSON.parse(ev.data); } catch { return; }

  switch (msg.type) {
    case 'auth-error':
      localStorage.removeItem('token');
      token = null;
      $('authError').textContent = msg.message;
      if (ws) { try { ws.close(); } catch {} ws = null; }
      $('auth').hidden = false;
      $('app').hidden = true;
      break;

    case 'ready':
      me = msg.user;
      servers = msg.servers;
      users = msg.users;
      onlineSet = new Set(msg.online);
      $('auth').hidden = true;
      $('app').hidden = false;
      showHome();
      renderRail();
      break;

    case 'presence':
      onlineSet = new Set(msg.users);
      renderRail();
      renderSidebar();
      renderMembers();
      break;

    case 'user-joined': {
      const idx = users.findIndex(u => u.id === msg.user.id);
      if (idx >= 0) users[idx] = msg.user;
      else users.push(msg.user);
      if (viewMode === 'server') renderMembers();
      renderSidebar();
      break;
    }

    case 'user-updated': {
      const idx = users.findIndex(u => u.id === msg.user.id);
      if (idx >= 0) users[idx] = msg.user;
      else users.push(msg.user);
      if (activeServer) {
        const m = activeServer.members.find(x => x.id === msg.user.id);
        if (m) Object.assign(m, msg.user);
      }
      if (viewMode === 'server') renderMembers();
      renderSidebar();
      break;
    }

    case 'server-list-add':
      if (msg.members.includes(me.id) && !servers.find(s => s.id === msg.server.id)) {
        servers.push(msg.server);
        renderRail();
      }
      break;

    case 'server':
      activeServer = msg.server;
      viewMode = 'server';
      activeDM = null;
      // сохраняем voice-состояние из view
      for (const ch of activeServer.channels) {
        if (ch.type === 'voice') voiceStateUpdate(ch.id, ch.voiceMembers || []);
      }
      renderRail(); renderSidebar(); renderMain(); renderMembers();
      break;

    case 'channel-created':
        if (activeServer) {
            activeServer.channels.push({ ...msg.channel });
            renderSidebar();
        }
        break;

    case 'channel-renamed':
        if (activeServer) {
            const ch = activeServer.channels.find(c => c.id === msg.channelId);
            if (ch) ch.name = msg.name;
            if (activeChannel?.id === msg.channelId) activeChannel.name = msg.name;
            renderSidebar(); renderMain();
        }
        break;

    case 'channel-deleted':
        if (activeServer) {
            activeServer.channels = activeServer.channels.filter(c => c.id !== msg.channelId);
            if (activeChannel?.id === msg.channelId) {
            if (myVoiceChannelId === msg.channelId) leaveVoice();
            activeChannel = null;
            destroyPlayer();
            currentSource = '';
            }
            renderSidebar(); renderMain(); renderMembers();
        }
        break;

        case 'role-created':
      if (activeServer) {
        activeServer.roles = activeServer.roles || [];
        activeServer.roles.push(msg.role);
        renderSidebar(); renderMembers();
      }
      break;

    case 'role-updated':
      if (activeServer) {
        const r = (activeServer.roles || []).find(x => x.id === msg.role.id);
        if (r) Object.assign(r, msg.role);
        renderSidebar(); renderMembers();
      }
      break;

    case 'role-deleted':
      if (activeServer) {
        activeServer.roles = (activeServer.roles || []).filter(r => r.id !== msg.roleId);
        for (const uid of Object.keys(activeServer.userRoles || {})) {
          activeServer.userRoles[uid] = activeServer.userRoles[uid].filter(r => r !== msg.roleId);
        }
        renderSidebar(); renderMembers();
      }
      break;

    case 'role-assigned':
      if (activeServer) {
        activeServer.userRoles = activeServer.userRoles || {};
        if (!activeServer.userRoles[msg.userId]) activeServer.userRoles[msg.userId] = [];
        if (!activeServer.userRoles[msg.userId].includes(msg.roleId)) activeServer.userRoles[msg.userId].push(msg.roleId);
        renderMembers();
      }
      break;

    case 'role-unassigned':
      if (activeServer) {
        activeServer.userRoles = activeServer.userRoles || {};
        if (activeServer.userRoles[msg.userId]) {
          activeServer.userRoles[msg.userId] = activeServer.userRoles[msg.userId].filter(r => r !== msg.roleId);
        }
        renderMembers();
      }
      break;

    case 'channel':
      activeChannel = msg.channel;
      unreadChannels.delete(msg.channel.id);
      cinemaTimes.clear();
      if (msg.channel.type !== 'cinema') destroyPlayer();
      renderSidebar(); renderMain(); renderMembers();
      break;

    case 'messages':
      channelMessages.set(msg.channelId, msg.messages || []);
      if (activeChannel?.id === msg.channelId) renderMain();
      break;

    case 'chat':
      if (!channelMessages.has(msg.channelId)) channelMessages.set(msg.channelId, []);
      channelMessages.get(msg.channelId).push(msg.message);
      if (viewMode === 'server' && activeChannel?.id === msg.channelId) {
        appendChatMessage(msg.message);
      } else if (activeServer) {
        unreadChannels.set(msg.channelId, (unreadChannels.get(msg.channelId) || 0) + 1);
        renderSidebar();
      }
      break;

    case 'chat-edited':
      if (channelMessages.has(msg.channelId)) {
        const m = channelMessages.get(msg.channelId).find(x => x.id === msg.messageId);
        if (m) { m.text = msg.text; m.edited = msg.edited; }
      }
      if (viewMode === 'server' && activeChannel?.id === msg.channelId) rerenderChannelMessages();
      break;

    case 'chat-deleted':
      if (channelMessages.has(msg.channelId)) {
        channelMessages.set(msg.channelId, channelMessages.get(msg.channelId).filter(x => x.id !== msg.messageId));
      }
      if (viewMode === 'server' && activeChannel?.id === msg.channelId) rerenderChannelMessages();
      break;

    case 'dm-edited': {
      const thread = dmThreads.get(msg.threadWith);
      if (thread) {
        const m = thread.messages.find(x => x.id === msg.messageId);
        if (m) { m.text = msg.text; m.edited = msg.edited; }
      }
      if (viewMode === 'home' && activeDM === msg.threadWith) renderMain();
      break;
    }

    case 'dm-deleted': {
      const thread = dmThreads.get(msg.threadWith);
      if (thread) thread.messages = thread.messages.filter(x => x.id !== msg.messageId);
      if (viewMode === 'home' && activeDM === msg.threadWith) renderMain();
      break;
    }

    case 'dm': {
      const otherId = msg.threadWith === me.id ? msg.message.fromId : msg.threadWith;
      if (!dmThreads.has(otherId)) dmThreads.set(otherId, { messages: [], loaded: false });
      dmThreads.get(otherId).messages.push(msg.message);
      const isViewing = viewMode === 'home' && activeDM === otherId;
      if (isViewing) {
        renderMain();
      } else {
        unreadDMs.set(otherId, (unreadDMs.get(otherId) || 0) + 1);
        renderRail();
        if (viewMode === 'home') renderSidebar();
      }
      break;
    }

    case 'dm-history': {
      let thread = dmThreads.get(msg.otherId);
      if (!thread) {
        thread = { messages: [], loaded: true };
        dmThreads.set(msg.otherId, thread);
      }
      const seen = new Set(thread.messages.map(m => m.id || m.ts));
      for (const m of msg.messages || []) {
        if (!seen.has(m.id || m.ts)) thread.messages.push(m);
      }
      thread.messages.sort((a, b) => (a.ts || 0) - (b.ts || 0));
      thread.loaded = true;
      if (viewMode === 'home' && activeDM === msg.otherId) renderMain();
      break;
    }

    case 'cinema-state':
      if (activeChannel?.id === msg.channelId) applyCinemaState(msg.state, false);
      break;

    case 'cinema-sync':
      if (activeChannel?.id === msg.channelId) applyCinemaState(msg.state, true);
      break;

    case 'cinema-time':
      if (activeChannel?.id === msg.channelId) {
        cinemaTimes.set(msg.userId, { time: msg.time, paused: msg.paused });
        renderMembers();
      }
      break;

    case 'voice-state':
      voiceStateUpdate(msg.channelId, msg.members);
      renderSidebar();
      if (activeChannel?.id === msg.channelId) renderMain();
      renderMembers();
      break;

    case 'voice-signal':
      handleVoiceSignal(msg.from, msg.data);
      break;

    case 'member-left':
      // можно отобразить, не критично
      break;

    case 'error':
      alert(msg.message);
      break;
  }
}

function voiceStateUpdate(channelId, members) {
  if (!activeServer) return;
  const ch = activeServer.channels.find(c => c.id === channelId);
  if (ch) ch.voiceMembers = members;

  // Обновляем WebRTC, если это мой текущий голосовой канал
  if (myVoiceChannelId === channelId) {
    syncVoicePeers(members || []);
  } else if (myVoiceChannelId && channelId !== myVoiceChannelId) {
    // Ничего: чужой канал
  }
}

// ---------- Rail ----------
function renderRail() {
  const rail = $('serverRail');
  rail.innerHTML = '';
  for (const s of servers) {
    const btn = document.createElement('button');
    btn.className = 'server-btn' + (viewMode === 'server' && activeServer?.id === s.id ? ' active' : '');
    btn.innerHTML = `<span class="server-initial">${escapeHtml(s.name.slice(0, 2))}</span>`;
    btn.title = s.name;
    btn.addEventListener('click', () => joinServer(s.id));
    rail.appendChild(btn);
  }
  $('homeBtn').classList.toggle('active', viewMode === 'home');

  const homeBtn = $('homeBtn');
  let badge = homeBtn.querySelector('.badge');
  const totalDMUnread = [...unreadDMs.values()].reduce((a, b) => a + b, 0);
  if (totalDMUnread > 0) {
    if (!badge) {
      badge = document.createElement('span');
      badge.className = 'badge';
      homeBtn.appendChild(badge);
    }
    badge.textContent = totalDMUnread > 99 ? '99+' : String(totalDMUnread);
  } else if (badge) {
    badge.remove();
  }
}

// ---------- Sidebar ----------
function renderSidebar() {
  const el = $('sidebar');
  el.innerHTML = '';
  if (viewMode === 'home') {
    const h = document.createElement('div');
    h.className = 'sidebar-header';
    h.textContent = 'Личные сообщения';
    el.appendChild(h);
    const list = document.createElement('div');
    list.className = 'dm-list';
    const others = users.filter(u => u.id !== me?.id);
    others.sort((a, b) => (onlineSet.has(b.id) ? 1 : 0) - (onlineSet.has(a.id) ? 1 : 0) || a.username.localeCompare(b.username));
    for (const u of others) {
      const item = document.createElement('button');
      item.className = 'dm-item' + (activeDM === u.id ? ' active' : '');
      const online = onlineSet.has(u.id);
      item.innerHTML = `<span class="status ${online ? 'online' : ''}"></span><span>${escapeHtml(u.username)}</span>`;
      const unread = unreadDMs.get(u.id) || 0;
      if (unread > 0 && activeDM !== u.id) {
        const b = document.createElement('span');
        b.className = 'badge';
        b.textContent = unread > 99 ? '99+' : String(unread);
        item.appendChild(b);
      }
      item.onclick = () => openDM(u.id);
      list.appendChild(item);
    }
    el.appendChild(list);
    return;
  }

  if (!activeServer) return;

  const header = document.createElement('div');
  header.className = 'sidebar-header';
  header.innerHTML = `<span>${escapeHtml(activeServer.name)}</span>`;
  el.appendChild(header);

  const groups = [
    { type: 'text', label: 'Текстовые', icon: '#' },
    { type: 'voice', label: 'Голосовые', icon: '🔊' },
    { type: 'cinema', label: 'Кинотеатр', icon: '🎬' },
  ];
  const canManageChannels = hasPerm(activeServer, me.id, 'manageChannels');
  const canManageRoles = hasPerm(activeServer, me.id, 'manageRoles');

  for (const g of groups) {
    const chans = activeServer.channels.filter(c => c.type === g.type);
    const lbl = document.createElement('div');
    lbl.className = 'channel-group-label';
    lbl.textContent = g.label + (canManageChannels ? '  +' : '');
    if (canManageChannels) {
      lbl.style.cursor = 'pointer';
      lbl.title = 'Создать канал';
      lbl.onclick = () => openCreateChannelDialog(g.type);
    }
    el.appendChild(lbl);

    for (const ch of chans) {
      const btn = document.createElement('button');
      btn.className = 'channel-item' + (activeChannel?.id === ch.id ? ' active' : '');
      btn.innerHTML = `<span class="icon">${g.icon}</span><span>${escapeHtml(ch.name)}</span>`;
      const unread = unreadChannels.get(ch.id) || 0;
      if (unread > 0 && activeChannel?.id !== ch.id) {
        const b = document.createElement('span');
        b.className = 'badge';
        b.textContent = unread > 99 ? '99+' : String(unread);
        btn.appendChild(b);
      }
      btn.onclick = () => openChannel(ch.id);
      el.appendChild(btn);

      if (canManageChannels) {
        btn.addEventListener('contextmenu', (e) => {
          e.preventDefault();
          e.stopPropagation();
          showChannelContextMenu(e.pageX, e.pageY, ch);
        });
      }

      if (g.type === 'voice' && ch.voiceMembers && ch.voiceMembers.length) {
        const vm = document.createElement('div');
        vm.className = 'voice-members';
        for (const m of ch.voiceMembers) {
          const speaking = speakingPeers.has(m.id) || (m.id === me.id && localSpeaking && !localMuted);
          const div = document.createElement('div');
          div.className = 'voice-member';
          div.innerHTML = `<span class="speak-indicator${speaking ? ' on' : ''}" data-uid="${m.id}"></span>${escapeHtml(m.username)}${m.muted ? ' 🔇' : ''}`;
          vm.appendChild(div);
        }
        el.appendChild(vm);
      }
    }
  }

  const rolesLbl = document.createElement('div');
  rolesLbl.className = 'channel-group-label';
  rolesLbl.textContent = 'Роли';
  el.appendChild(rolesLbl);

  for (const r of activeServer.roles || []) {
    const row = document.createElement('div');
    row.className = 'role-list-item';
    row.innerHTML = `<span class="role-dot" style="background:${escapeHtml(r.color)}"></span><span>${escapeHtml(r.name)}</span>`;
    el.appendChild(row);
  }

  if (canManageRoles) {
    const manageBtn = document.createElement('button');
    manageBtn.className = 'channel-item';
    manageBtn.innerHTML = `<span class="icon">⚙️</span><span>Управление ролями</span>`;
    manageBtn.onclick = openRolesManagerModal;
    el.appendChild(manageBtn);
  }
}

// ---------- Main ----------
function renderMain() {
  const el = $('main');
  el.innerHTML = '';

  if (viewMode === 'home') {
    if (!activeDM) {
      el.innerHTML = `<div class="placeholder">Выберите друга слева, чтобы начать переписку</div>`;
      return;
    }
    const u = users.find(x => x.id === activeDM);
    el.innerHTML = `<div class="main-header">@ ${escapeHtml(u?.username || '?')}</div>`;
    renderDMChat(el, activeDM);
    return;
  }

  if (!activeServer || !activeChannel) {
    el.innerHTML = `<div class="placeholder">Выберите канал</div>`;
    return;
  }

  const ch = activeChannel;
  if (ch.type === 'text') renderTextChannel(el, ch);
  else if (ch.type === 'cinema') renderCinemaChannel(el, ch);
  else if (ch.type === 'voice') renderVoiceChannel(el, ch);
}

// ---------- Text channel ----------
function renderTextChannel(el, ch) {
  const header = document.createElement('div');
  header.className = 'main-header';
  header.textContent = `# ${ch.name}`;
  el.appendChild(header);

  const content = document.createElement('div');
  content.className = 'main-content';
  const msgs = document.createElement('div');
  msgs.className = 'chat-messages';
  msgs.id = 'chatMessages';
  content.appendChild(msgs);
  el.appendChild(content);

  const list = channelMessages.get(ch.id) || [];
  const ctx = { kind: 'channel', channelId: ch.id };
  for (const m of list) appendTo(msgs, m, ctx);

  const compose = document.createElement('form');
  compose.className = 'compose';
  compose.innerHTML = `
    <div class="compose-row">
      <button type="button" class="compose-btn" data-act="image" title="Прикрепить картинку">📎</button>
      <button type="button" class="compose-btn" data-act="emoji" title="Эмодзи">😀</button>
      <input placeholder="Написать в #${escapeHtml(ch.name)}" autocomplete="off">
    </div>
    <div class="compose-attach" hidden>
      <img alt="">
      <button type="button" class="compose-attach-remove">✖</button>
    </div>
    <input type="file" accept="image/*" hidden>
  `;
  const input = compose.querySelector('input[type=text], input:not([type])');
  const fileInput = compose.querySelector('input[type=file]');
  const attachBox = compose.querySelector('.compose-attach');
  const attachImg = compose.querySelector('.compose-attach img');
  const attachRemove = compose.querySelector('.compose-attach-remove');

  let attachedImage = null;
  const clearAttach = () => { attachedImage = null; attachBox.hidden = true; attachImg.src = ''; };
  attachRemove.onclick = clearAttach;

  compose.querySelector('[data-act="image"]').onclick = () => fileInput.click();
  compose.querySelector('[data-act="emoji"]').onclick = (e) => {
    e.preventDefault();
    openEmojiPicker(e.currentTarget, (emoji) => insertAtCursor(input, emoji));
  };

  fileInput.addEventListener('change', () => {
    const file = fileInput.files[0];
    fileInput.value = '';
    if (!file) return;
    if (file.size > 1_500_000) return alert('Картинка слишком большая (макс ~1.5 МБ)');
    const reader = new FileReader();
    reader.onload = () => {
      attachedImage = reader.result;
      attachImg.src = attachedImage;
      attachBox.hidden = false;
      input.focus();
    };
    reader.readAsDataURL(file);
  });

  compose.addEventListener('submit', e => {
    e.preventDefault();
    const text = input.value.trim();
    if (!text && !attachedImage) return;
    wsSend({ type: 'chat', text, image: attachedImage || undefined });
    input.value = '';
    clearAttach();
  });
  el.appendChild(compose);
  input.focus();
  msgs.scrollTop = msgs.scrollHeight;
}

function isImageUrl(text) {
  const t = String(text || '').trim();
  if (!t) return false;
  if (/^https?:\/\/\S+\.(png|jpe?g|gif|webp|avif)(\?\S*)?$/i.test(t)) return true;
  if (/^https?:\/\/(media\d*\.tenor\.com|media\d*\.giphy\.com|c\.tenor\.com)\/\S+\.(gif|webp|mp4)/i.test(t)) return true;
  return false;
}

function appendTo(parent, m, ctx) {
  const div = document.createElement('div');
  div.className = 'chat-msg';
  div.dataset.id = m.id || '';
  const u = getUser(m.fromId);
  const time = new Date(m.ts || Date.now());
  const hh = String(time.getHours()).padStart(2, '0');
  const mm = String(time.getMinutes()).padStart(2, '0');
  const displayName = u?.username || m.from || '?';
  const avatar = avatarHtml(u || { id: m.fromId, username: displayName }, 36);
  const mine = m.fromId === me?.id;
  const edited = m.edited ? `<span class="ts">(изменено)</span>` : '';

  let bodyHtml = `<span class="author">${escapeHtml(displayName)}</span>`;
  if (m.text) {
    if (!m.image && isImageUrl(m.text)) {
      bodyHtml += `<div class="msg-image"><img src="${escapeHtml(m.text.trim())}" alt="" loading="lazy"></div>`;
    } else {
      bodyHtml += `<span class="msg-text">${escapeHtml(m.text)}</span>`;
    }
  }
  bodyHtml += `<span class="ts">${hh}:${mm}</span>${edited}`;
  if (m.image) bodyHtml += `<div class="msg-image"><img src="${escapeHtml(m.image)}" alt="" loading="lazy"></div>`;

  div.innerHTML = `
    <div class="chat-msg-avatar">${avatar}</div>
    <div class="chat-msg-body">${bodyHtml}</div>
    ${mine && m.id ? `<div class="msg-actions"><button class="msg-edit" title="Изменить">✎</button><button class="msg-del" title="Удалить">🗑</button></div>` : ''}
  `;

  if (m.fromId) {
    const authorEl = div.querySelector('.author');
    if (authorEl) {
      authorEl.addEventListener('click', (e) => {
        e.stopPropagation();
        openProfileModal(m.fromId);
      });
    }
  }

  if (mine && m.id && ctx) {
    div.querySelector('.msg-edit').addEventListener('click', () => startInlineEdit(div, m, ctx));
    div.querySelector('.msg-del').addEventListener('click', () => {
      if (!confirm('Удалить сообщение?')) return;
      if (ctx.kind === 'channel') wsSend({ type: 'delete-chat', channelId: ctx.channelId, messageId: m.id });
      else if (ctx.kind === 'dm') wsSend({ type: 'delete-dm', otherId: ctx.otherId, messageId: m.id });
    });
  }

  parent.appendChild(div);
}

function startInlineEdit(msgEl, m, ctx) {
  const body = msgEl.querySelector('.chat-msg-body');
  if (!body) return;
  body.innerHTML = `
    <input class="msg-edit-input" value="${escapeHtml(m.text || '')}" maxlength="500">
    <div class="msg-edit-actions">
      <button class="edit-save">Сохранить</button>
      <button class="edit-cancel ghost">Отмена</button>
    </div>
  `;
  const input = body.querySelector('.msg-edit-input');
  input.focus();
  input.select();
  const cancel = () => {
    if (ctx.kind === 'channel') rerenderChannelMessages();
    else if (viewMode === 'home' && activeDM === ctx.otherId) renderMain();
  };
  body.querySelector('.edit-cancel').onclick = cancel;
  body.querySelector('.edit-save').onclick = () => {
    const text = input.value.trim();
    if (!text && !m.image) return;
    if (ctx.kind === 'channel') wsSend({ type: 'edit-chat', channelId: ctx.channelId, messageId: m.id, text });
    else if (ctx.kind === 'dm') wsSend({ type: 'edit-dm', otherId: ctx.otherId, messageId: m.id, text });
  };
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') body.querySelector('.edit-save').click();
    if (e.key === 'Escape') cancel();
  });
}

function rerenderChannelMessages() {
  const msgs = $('chatMessages');
  if (!msgs || !activeChannel) return;
  msgs.innerHTML = '';
  const list = channelMessages.get(activeChannel.id) || [];
  const ctx = { kind: 'channel', channelId: activeChannel.id };
  for (const m of list) appendTo(msgs, m, ctx);
  msgs.scrollTop = msgs.scrollHeight;
}

function insertAtCursor(input, text) {
  const start = input.selectionStart ?? input.value.length;
  const end = input.selectionEnd ?? input.value.length;
  input.value = input.value.slice(0, start) + text + input.value.slice(end);
  const pos = start + text.length;
  input.selectionStart = input.selectionEnd = pos;
  input.focus();
}

const EMOJI_LIST = [
  '😀','😂','🤣','😍','🥰','😎','🤔','😢','😡','👍','👎','🔥','❤️','🎉','✅','❌',
  '😴','🤯','🙃','😅','😊','😉','🙄','😱','🤗','🤝','👀','💀','🎬','🍿','🕹️','😇',
  '🥳','🤩','😏','😬','🥺','🤤','😷','🤢','👻','💩','🤖','💪','🎮','🎵','🌟','⚡',
  '☀️','🌈','🍕','🍔','🍺','☕','🛒','📌','📎','🔗','⏰','📷','🎁','💯','🚀','🐱'
];

function closeEmojiPicker() {
  const p = document.getElementById('emojiPicker');
  if (p) p.remove();
}

function openEmojiPicker(anchorEl, insertCb) {
  closeEmojiPicker();
  const picker = document.createElement('div');
  picker.className = 'emoji-picker';
  picker.id = 'emojiPicker';
  const grid = document.createElement('div');
  grid.className = 'emoji-grid';
  for (const emoji of EMOJI_LIST) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.textContent = emoji;
    btn.onclick = () => { insertCb(emoji); closeEmojiPicker(); };
    grid.appendChild(btn);
  }
  picker.appendChild(grid);
  document.body.appendChild(picker);

  const rect = anchorEl.getBoundingClientRect();
  picker.style.left = Math.max(8, rect.left) + 'px';
  picker.style.bottom = (window.innerHeight - rect.top + 8) + 'px';

  setTimeout(() => {
    const onDocClick = (e) => {
      if (!picker.contains(e.target) && e.target !== anchorEl) {
        closeEmojiPicker();
        document.removeEventListener('click', onDocClick);
      }
    };
    document.addEventListener('click', onDocClick);
  }, 0);
}

function appendChatMessage(m) {
  const msgs = $('chatMessages');
  if (!msgs || !activeChannel) return;
  appendTo(msgs, m, { kind: 'channel', channelId: activeChannel.id });
  msgs.scrollTop = msgs.scrollHeight;
}

// ---------- DM ----------
function renderDMChat(el, otherId) {
  const content = document.createElement('div');
  content.className = 'main-content';
  const msgs = document.createElement('div');
  msgs.className = 'chat-messages';
  msgs.id = 'dmMessages';
  content.appendChild(msgs);
  el.appendChild(content);

  const thread = dmThreads.get(otherId) || { messages: [] };
  for (const m of thread.messages) {
    appendTo(msgs, m, { kind: 'dm', otherId });
  }

  const compose = document.createElement('form');
  compose.className = 'compose';
  compose.innerHTML = `
    <div class="compose-row">
      <button type="button" class="compose-btn" data-act="image" title="Прикрепить картинку">📎</button>
      <button type="button" class="compose-btn" data-act="emoji" title="Эмодзи">😀</button>
      <input placeholder="Личное сообщение" autocomplete="off">
    </div>
    <div class="compose-attach" hidden>
      <img alt="">
      <button type="button" class="compose-attach-remove">✖</button>
    </div>
    <input type="file" accept="image/*" hidden>
  `;
  const input = compose.querySelector('input[type=text], input:not([type])');
  const fileInput = compose.querySelector('input[type=file]');
  const attachBox = compose.querySelector('.compose-attach');
  const attachImg = compose.querySelector('.compose-attach img');
  const attachRemove = compose.querySelector('.compose-attach-remove');

  let attachedImage = null;
  const clearAttach = () => { attachedImage = null; attachBox.hidden = true; attachImg.src = ''; };
  attachRemove.onclick = clearAttach;

  compose.querySelector('[data-act="image"]').onclick = () => fileInput.click();
  compose.querySelector('[data-act="emoji"]').onclick = (e) => {
    e.preventDefault();
    openEmojiPicker(e.currentTarget, (emoji) => insertAtCursor(input, emoji));
  };

  fileInput.addEventListener('change', () => {
    const file = fileInput.files[0];
    fileInput.value = '';
    if (!file) return;
    if (file.size > 1_500_000) return alert('Картинка слишком большая (макс ~1.5 МБ)');
    const reader = new FileReader();
    reader.onload = () => {
      attachedImage = reader.result;
      attachImg.src = attachedImage;
      attachBox.hidden = false;
      input.focus();
    };
    reader.readAsDataURL(file);
  });

  compose.addEventListener('submit', e => {
    e.preventDefault();
    const text = input.value.trim();
    if (!text && !attachedImage) return;
    wsSend({ type: 'dm', targetId: otherId, text, image: attachedImage || undefined });
    input.value = '';
    clearAttach();
  });
  el.appendChild(compose);
  input.focus();
  msgs.scrollTop = msgs.scrollHeight;
}

// ---------- Cinema channel ----------
function renderCinemaChannel(el, ch) {
  const header = document.createElement('div');
  header.className = 'main-header';
  header.textContent = `🎬 ${ch.name}`;
  el.appendChild(header);

  const wrap = document.createElement('div');
  wrap.className = 'cinema-wrap';
  wrap.innerHTML = `
    <div class="cinema-bar">
      <input id="cinemaSource" placeholder="YouTube / RuTube / MP4 — вставьте ссылку">
      <button id="cinemaLoad">Загрузить</button>
      <button id="cinemaSyncBtn" class="ghost">⏱ Синхронизировать</button>
      <span id="cinemaKind" class="hint"></span>
    </div>
    <div class="player-container" id="playerContainer"></div>
  `;
  el.appendChild(wrap);

  $('cinemaSource').value = currentSource;
  $('cinemaLoad').addEventListener('click', () => {
    const url = $('cinemaSource').value.trim();
    if (url) { loadCinemaSource(url, false); wsSend({ type: 'cinema-source', source: url }); }
  });
  $('cinemaSyncBtn').addEventListener('click', () => {
    if (!player) return alert('Сначала загрузите видео');
    wsSend({ type: 'cinema-sync', source: currentSource, time: player.getTime(), paused: player.isPaused() });
  });

  if (currentSource && !player) loadCinemaSource(currentSource, true);
}

// ---------- Voice channel ----------
function renderVoiceChannel(el, ch) {
  const header = document.createElement('div');
  header.className = 'main-header';
  header.textContent = `🔊 ${ch.name}`;
  el.appendChild(header);

  const members = ch.voiceMembers || [];
  const joined = myVoiceChannelId === ch.id;

  const view = document.createElement('div');
  view.className = 'voice-view';
  view.innerHTML = `<h2>${escapeHtml(ch.name)}</h2>`;

  const participants = document.createElement('div');
  participants.className = 'voice-participants';
  if (!members.length) {
    participants.innerHTML = `<p class="hint">Никого нет в канале</p>`;
  }
  for (const m of members) {
    const speaking = speakingPeers.has(m.id) || (m.id === me.id && localSpeaking && !localMuted);
    const tile = document.createElement('div');
    tile.className = 'voice-tile' + (speaking ? ' speaking' : '');
    tile.innerHTML = `
      <div class="avatar">${escapeHtml(m.username.slice(0, 1).toUpperCase())}</div>
      <div class="name">${escapeHtml(m.username)}</div>
      ${m.muted ? '<div class="mute">🔇 выкл. микрофон</div>' : ''}
    `;
    participants.appendChild(tile);
  }
  view.appendChild(participants);

  const actions = document.createElement('div');
  actions.style.display = 'flex';
  actions.style.gap = '8px';
  if (joined) {
    const muteBtn = document.createElement('button');
    muteBtn.className = localMuted ? 'danger' : '';
    muteBtn.textContent = localMuted ? '🔇 Микрофон выключен' : '🎤 Микрофон включён';
    muteBtn.onclick = toggleMute;
    actions.appendChild(muteBtn);

    const leaveBtn = document.createElement('button');
    leaveBtn.className = 'ghost';
    leaveBtn.textContent = 'Отключиться';
    leaveBtn.onclick = leaveVoice;
    actions.appendChild(leaveBtn);
  } else {
    const joinBtn = document.createElement('button');
    joinBtn.textContent = 'Войти в канал';
    joinBtn.onclick = () => joinVoice(ch.id);
    actions.appendChild(joinBtn);
  }
  view.appendChild(actions);
  el.appendChild(view);
}

// ---------- Members panel ----------
function renderMembers() {
  const panel = $('membersPanel');
  panel.innerHTML = '';
  if (viewMode !== 'server' || !activeServer) return;

  const inVoice = myVoiceChannelId && activeChannel?.type === 'voice';
  const inCinema = activeChannel?.type === 'cinema';
  const canManageRoles = hasPerm(activeServer, me.id, 'manageRoles');

  for (const m of activeServer.members) {
    const online = onlineSet.has(m.id);
    const div = document.createElement('div');
    div.className = 'member' + (!online ? ' offline' : '');

    let indicator = '';
    if (inVoice && activeChannel.voiceMembers?.some(v => v.id === m.id)) {
      const speaking = speakingPeers.has(m.id) || (m.id === me.id && localSpeaking && !localMuted);
      indicator = `<span class="speak-indicator${speaking ? ' on' : ''}" data-uid="${m.id}"></span>`;
    } else {
      indicator = `<span class="status ${online ? 'online' : ''}"></span>`;
    }

    let time = '';
    if (inCinema && cinemaTimes.has(m.id)) {
      const t = cinemaTimes.get(m.id);
      time = `<span class="mt">${fmtTime(t.time)}${t.paused ? ' ⏸' : ' ▶'}</span>`;
    }

    // Цвет ника по первой назначенной роли (кроме владельца — у него золотой)
    let color = null;
    if (m.id === activeServer.ownerId) {
      color = '#f0b232';
    } else {
      const roleIds = (activeServer.userRoles || {})[m.id] || [];
      const firstRole = roleIds
        .map(rid => (activeServer.roles || []).find(r => r.id === rid))
        .find(Boolean);
      if (firstRole && firstRole.color && firstRole.color !== '#99aab5') color = firstRole.color;
    }
    const nameStyle = color ? ` style="color:${escapeHtml(color)}"` : '';

    const avatar = avatarHtml(m, 24);
    div.innerHTML = `
      ${indicator}
      <span class="member-avatar">${avatar}</span>
      <span class="member-name"${nameStyle}>${escapeHtml(m.username)}${m.id === me.id ? ' (вы)' : ''}</span>
      ${time}
    `;

    div.style.cursor = 'pointer';
    div.title = 'Открыть профиль';
    div.addEventListener('click', () => openProfileModal(m.id));

    panel.appendChild(div);
  }
}

// ---------- Navigation ----------
function showHome() {
  viewMode = 'home';
  activeServer = null;
  activeChannel = null;
  activeDM = null;
  destroyPlayer();
  renderRail(); renderSidebar(); renderMain(); renderMembers();
  document.getElementById('app').classList.add('home');
}

function joinServer(serverId) {
  document.getElementById('app').classList.remove('home');
  viewMode = 'server';
  wsSend({ type: 'get-server', serverId });
}

function openChannel(channelId) {
  if (!activeServer) return;
  const ch = activeServer.channels.find(c => c.id === channelId);
  if (!ch) return;
  if (myVoiceChannelId && myVoiceChannelId !== ch.id && ch.type !== 'voice') {
    // При переходе в не-голосовой канал голос остаётся, как в Discord
  }
  wsSend({ type: 'join-channel', channelId });
}

function openDM(userId) {
  if (!userId || userId === me.id) return;
  activeDM = userId;
  unreadDMs.delete(userId);
  renderRail();
  if (!dmThreads.has(userId)) dmThreads.set(userId, { messages: [], loaded: false });
  const thread = dmThreads.get(userId);
  if (!thread.loaded) {
    thread.loaded = true;
    wsSend({ type: 'get-dm-history', otherId: userId });
  }
  if (viewMode === 'home') { renderSidebar(); renderMain(); }
}

$('homeBtn').addEventListener('click', showHome);

// ---------- Server / channel modals ----------
$('addServerBtn').addEventListener('click', () => {
  wsSend({ type: 'list-all-servers' });
  // Ответ придёт сообщением all-servers, но нам нужен обработчик
  // Временно добавим обработчик через один раз
  const onceHandler = (ev) => {
    let m; try { m = JSON.parse(ev.data); } catch { return; }
    if (m.type !== 'all-servers') return;
    ws.removeEventListener('message', onceHandler);
    openAddServerModal(m.servers);
  };
  ws.addEventListener('message', onceHandler);
});

function openAddServerModal(list) {
  const box = $('modalBox');
  box.innerHTML = `
    <button class="modal-close" id="modalClose">×</button>
    <h2>Создать сервер</h2>
    <input id="mNewName" placeholder="Название сервера">
    <button id="mCreate">Создать</button>
    <h3>Существующие серверы</h3>
    <div id="mList"></div>
  `;
  $('modal').hidden = false;
  $('modalClose').onclick = () => $('modal').hidden = true;

  const listEl = $('mList');
  const notMember = list.filter(s => !s.member);
  if (!notMember.length) listEl.innerHTML = `<p class="hint">Вы уже во всех серверах</p>`;
  for (const s of notMember) {
    const row = document.createElement('div');
    row.className = 'server-pick';
    row.innerHTML = `<span>${escapeHtml(s.name)}</span>`;
    const btn = document.createElement('button');
    btn.textContent = 'Войти';
    btn.onclick = () => { $('modal').hidden = true; wsSend({ type: 'join-existing-server', serverId: s.id }); };
    row.appendChild(btn);
    listEl.appendChild(row);
  }

  $('mCreate').onclick = () => {
    const name = $('mNewName').value.trim();
    if (!name) return alert('Введите название');
    $('modal').hidden = true;
    wsSend({ type: 'create-server', name });
  };
}

function openCreateChannelDialog(type) {
  const typeName = { text: 'текстовый', voice: 'голосовой', cinema: 'кинотеатр' }[type];
  const count = activeServer ? activeServer.channels.length : 0;
  const box = $('modalBox');
  box.innerHTML = `
    <button class="modal-close" id="modalClose">×</button>
    <h2>Новый ${typeName} канал</h2>
    <p class="hint">Каналов на сервере: ${count} / ${MAX_CHANNELS}</p>
    <input id="mChName" placeholder="Название канала">
    <button id="mChCreate">Создать</button>
  `;
  $('modal').hidden = false;
  $('modalClose').onclick = () => $('modal').hidden = true;
  $('mChCreate').onclick = () => {
    const name = $('mChName').value.trim();
    if (!name) return alert('Введите название');
    $('modal').hidden = true;
    wsSend({ type: 'create-channel', name, channelType: type });
  };
}

// ---------- Cinema player adapters ----------
function destroyPlayer() {
  if (player && player.destroy) { try { player.destroy(); } catch {} }
  player = null;
  playerKind = 'none';
  const k = $('cinemaKind'); if (k) k.textContent = '';
}

function detectSource(url) {
  const u = url.trim();
  if (/youtu\.be\//i.test(u) || /youtube\.com\/(watch|embed)/i.test(u)) return { kind: 'youtube', id: extractYouTubeId(u) };
  if (/rutube\.ru\//i.test(u)) return { kind: 'rutube', id: extractRuTubeId(u) };
  return { kind: 'html5', url: u };
}
function extractYouTubeId(url) {
  try {
    const u = new URL(url);
    if (u.hostname.includes('youtu.be')) return u.pathname.slice(1).split(/[?#]/)[0];
    if (u.searchParams.get('v')) return u.searchParams.get('v');
    const m = u.pathname.match(/\/embed\/([^/?#]+)/); if (m) return m[1];
  } catch {}
  return '';
}
function extractRuTubeId(url) {
  try {
    const u = new URL(url);
    const m = u.pathname.match(/\/(?:video|play\/embed)\/([a-f0-9]+)/i); if (m) return m[1];
  } catch {}
  return '';
}

function createHtml5Player(url) {
  const c = $('playerContainer'); if (!c) return null;
  c.innerHTML = '';
  const v = document.createElement('video'); v.controls = true; v.playsInline = true; v.src = url;
  c.appendChild(v);
  return {
    play: () => v.play().catch(() => {}),
    pause: () => v.pause(),
    seek: s => { v.currentTime = s; },
    getTime: () => v.currentTime || 0,
    isPaused: () => v.paused,
    destroy: () => { v.pause(); v.src = ''; c.innerHTML = ''; }
  };
}
function createYouTubePlayer(videoId) {
  return new Promise(resolve => {
    const c = $('playerContainer'); if (!c) return resolve(null);
    c.innerHTML = '<div id="yt-player"></div>';
    const onReady = e => {
      const yt = e.target;
      resolve({
        play: () => yt.playVideo(), pause: () => yt.pauseVideo(),
        seek: s => yt.seekTo(s, true),
        getTime: () => yt.getCurrentTime() || 0,
        isPaused: () => yt.getPlayerState() !== YT.PlayerState.PLAYING,
        destroy: () => { try { yt.destroy(); } catch {} c.innerHTML = ''; }
      });
    };
    const check = () => {
      if (window.YT && window.YT.Player) {
        new YT.Player('yt-player', {
          videoId, playerVars: { playsinline: 1, rel: 0, modestbranding: 1 },
          events: { onReady }
        });
      } else setTimeout(check, 200);
    };
    check();
  });
}
function createRuTubePlayer(videoId) {
  return new Promise(resolve => {
    const c = $('playerContainer'); if (!c) return resolve(null);
    c.innerHTML = `<iframe id="rt-iframe" src="https://rutube.ru/play/embed/${videoId}/" allow="clipboard-write; autoplay" allowfullscreen frameborder="0"></iframe>`;
    const iframe = c.querySelector('#rt-iframe');
    const sendMsg = (type, payload = {}) => {
      if (iframe.contentWindow) iframe.contentWindow.postMessage(JSON.stringify({ type, ...payload }), '*');
    };
    let currentTime = 0, paused = true, lastTick = Date.now(), ready = false;
    const tick = () => {
      const now = Date.now();
      if (!paused && ready) currentTime += (now - lastTick) / 1000;
      lastTick = now; requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
    const onMsg = e => {
      let d = e.data;
      if (typeof d === 'string') { try { d = JSON.parse(d); } catch { return; } }
      if (!d || typeof d !== 'object') return;
      if (d.type === 'player:ready' || d.event === 'ready') ready = true;
      if (d.type === 'player:play' || d.event === 'play') { paused = false; lastTick = Date.now(); }
      if (d.type === 'player:pause' || d.event === 'pause') paused = true;
    };
    window.addEventListener('message', onMsg);
    setTimeout(() => resolve({
      play: () => { sendMsg('player:play'); paused = false; lastTick = Date.now(); },
      pause: () => { sendMsg('player:pause'); paused = true; },
      seek: s => { sendMsg('player:seek', { time: s }); currentTime = s; lastTick = Date.now(); },
      getTime: () => currentTime,
      isPaused: () => paused,
      destroy: () => { window.removeEventListener('message', onMsg); iframe.src = 'about:blank'; c.innerHTML = ''; }
    }), 800);
  });
}

async function loadCinemaSource(url, byRemote) {
  const d = detectSource(url);
  destroyPlayer();
  currentSource = url;
  const k = $('cinemaKind');
  if (d.kind === 'youtube') {
    if (k) k.textContent = 'YouTube';
    player = await createYouTubePlayer(d.id);
  } else if (d.kind === 'rutube') {
    if (k) k.textContent = 'RuTube';
    player = await createRuTubePlayer(d.id);
  } else {
    if (k) k.textContent = 'HTML5';
    player = createHtml5Player(d.url);
  }
  if (!byRemote && player) {
    // не отправляем: source уже отправлен вызывающей стороной
  }
}

function applyCinemaState(state, force) {
  if (!state || !state.source) return;
  if (state.source !== currentSource || !player) {
    loadCinemaSource(state.source, true).then(() => {
      setTimeout(() => {
        if (!player) return;
        applyingRemote = true;
        if (Number.isFinite(state.time)) player.seek(state.time);
        if (state.paused) player.pause(); else player.play();
        setTimeout(() => { applyingRemote = false; }, 600);
      }, 600);
    });
    return;
  }
  applyingRemote = true;
  const doApply = () => {
    if (Number.isFinite(state.time)) {
      const drift = Math.abs(player.getTime() - state.time);
      if (force || drift > 0.5) player.seek(state.time);
    }
    if (state.paused) player.pause(); else player.play();
    setTimeout(() => { applyingRemote = false; }, 600);
  };
  doApply();
}

// Авто-обновление времени в cinema-канале
setInterval(() => {
  if (viewMode === 'server' && activeChannel?.type === 'cinema' && player && !applyingRemote) {
    wsSend({ type: 'cinema-time', time: player.getTime(), paused: player.isPaused() });
  }
}, 1000);

// ---------- Voice ----------
async function ensureMic() {
  if (localStream) return true;
  try {
    localStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    getAudioCtx();
    setupLocalAnalyser();
    return true;
  } catch (err) {
    alert('Не удалось получить микрофон: ' + err.message);
    return false;
  }
}

async function joinVoice(channelId) {
  if (!(await ensureMic())) return;
  myVoiceChannelId = channelId;
  wsSend({ type: 'voice-join', channelId });
}

function leaveVoice() {
  if (!myVoiceChannelId) return;
  wsSend({ type: 'voice-leave' });
  myVoiceChannelId = null;
  for (const pc of pcs.values()) try { pc.close(); } catch {}
  pcs.clear();
  analysers.clear();
  for (const a of document.querySelectorAll('#audios')) a.innerHTML = '';
  renderMain();
}

async function toggleMute() {
  if (!localStream) return;
  localMuted = !localMuted;
  for (const t of localStream.getAudioTracks()) t.enabled = !localMuted;
  wsSend({ type: 'voice-mute', muted: localMuted });
  renderMain();
}

function syncVoicePeers(members) {
  if (!myVoiceChannelId) return;
  const ids = new Set(members.map(m => m.id));
  for (const [pid, pc] of [...pcs]) {
    if (!ids.has(pid)) {
      try { pc.close(); } catch {}
      pcs.delete(pid); analysers.delete(pid); speakingPeers.delete(pid);
      const a = document.getElementById('audio-' + pid); if (a) a.remove();
    }
  }
  if (!localStream) return;
  for (const m of members) {
    if (m.id === me.id) continue;
    if (pcs.has(m.id)) continue;
    const pc = createVoicePeer(m.id);
    if (me.id < m.id) {
      (async () => {
        try {
          const offer = await pc.createOffer();
          await pc.setLocalDescription(offer);
          wsSend({ type: 'voice-signal', targetId: m.id, data: { kind: 'offer', sdp: pc.localDescription } });
        } catch (err) { console.error(err); }
      })();
    }
  }
}

function createVoicePeer(peerId) {
  const pc = new RTCPeerConnection({ iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] });
  pcs.set(peerId, pc);
  if (localStream) localStream.getTracks().forEach(t => pc.addTrack(t, localStream));
  pc.onicecandidate = e => {
    if (e.candidate) wsSend({ type: 'voice-signal', targetId: peerId, data: { kind: 'ice', candidate: e.candidate } });
  };
  pc.ontrack = e => {
    const [stream] = e.streams;
    let audio = document.getElementById('audio-' + peerId);
    if (!audio) {
      audio = document.createElement('audio');
      audio.id = 'audio-' + peerId;
      audio.autoplay = true;
      let box = document.getElementById('audios');
      if (!box) { box = document.createElement('div'); box.id = 'audios'; document.body.appendChild(box); }
      box.appendChild(audio);
    }
    audio.srcObject = stream;
    setupAnalyser(stream, peerId);
  };
  return pc;
}

async function handleVoiceSignal(from, data) {
  try {
    let pc = pcs.get(from);
    if (data.kind === 'offer') {
      if (!pc) pc = createVoicePeer(from);
      await pc.setRemoteDescription(data.sdp);
      const ans = await pc.createAnswer();
      await pc.setLocalDescription(ans);
      wsSend({ type: 'voice-signal', targetId: from, data: { kind: 'answer', sdp: pc.localDescription } });
    } else if (data.kind === 'answer') {
      if (pc) await pc.setRemoteDescription(data.sdp);
    } else if (data.kind === 'ice') {
      if (pc) await pc.addIceCandidate(data.candidate);
    }
  } catch (err) { console.error(err); }
}

// ---------- Speaking detection ----------
let audioCtx = null;
function getAudioCtx() {
  if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  if (audioCtx.state === 'suspended') audioCtx.resume();
  return audioCtx;
}
function setupLocalAnalyser() {
  try {
    const ctx = getAudioCtx();
    const src = ctx.createMediaStreamSource(localStream);
    const an = ctx.createAnalyser();
    an.fftSize = 512;
    src.connect(an);
    analysers.set(me.id, { analyser: an, data: new Uint8Array(an.fftSize) });
  } catch (err) { console.warn(err); }
}
function setupAnalyser(stream, peerId) {
  try {
    const ctx = getAudioCtx();
    const src = ctx.createMediaStreamSource(stream);
    const an = ctx.createAnalyser();
    an.fftSize = 512;
    src.connect(an);
    analysers.set(peerId, { analyser: an, data: new Uint8Array(an.fftSize) });
  } catch (err) { console.warn(err); }
}

let speakingLoop = false;
function startSpeakingLoop() {
  if (speakingLoop) return;
  speakingLoop = true;
  const tick = () => {
    let changed = false;
    for (const [id, { analyser, data }] of analysers) {
      analyser.getByteTimeDomainData(data);
      let sum = 0;
      for (let i = 0; i < data.length; i++) { const v = (data[i] - 128) / 128; sum += v * v; }
      const rms = Math.sqrt(sum / data.length);
      const sp = rms > 0.02;
      if (id === me.id) {
        const next = sp && !localMuted;
        if (next !== localSpeaking) { localSpeaking = next; changed = true; }
      } else {
        const was = speakingPeers.has(id);
        if (sp && !was) { speakingPeers.add(id); changed = true; }
        else if (!sp && was) { speakingPeers.delete(id); changed = true; }
      }
    }
    if (changed) {
      for (const el of document.querySelectorAll('.speak-indicator[data-uid]')) {
        const uid = el.dataset.uid;
        const on = uid === me.id ? (localSpeaking && !localMuted) : speakingPeers.has(uid);
        el.classList.toggle('on', on);
      }
      const tiles = document.querySelectorAll('.voice-tile');
      if (tiles.length) {
        // перерендерим главный вид, если это голосовой канал
        if (activeChannel?.type === 'voice') renderMain();
      }
    }
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}

const MAX_CHANNELS = 20;

function showChannelContextMenu(x, y, channel) {
  closeContextMenu();
  const menu = document.createElement('div');
  menu.className = 'context-menu';
  menu.id = 'contextMenu';
  menu.style.left = x + 'px';
  menu.style.top = y + 'px';
  menu.innerHTML = `
    <button data-act="rename">✏️ Переименовать</button>
    <button data-act="delete" class="danger">🗑 Удалить канал</button>
  `;
  menu.addEventListener('click', (e) => {
    const act = e.target.closest('button')?.dataset.act;
    if (!act) return;
    closeContextMenu();
    if (act === 'rename') openRenameChannelDialog(channel);
    else if (act === 'delete') {
      if (confirm(`Удалить канал "${channel.name}"? Это действие нельзя отменить.`)) {
        wsSend({ type: 'delete-channel', channelId: channel.id });
      }
    }
  });
  document.body.appendChild(menu);

  // если меню вылезает за экран — подвинем
  const rect = menu.getBoundingClientRect();
  if (rect.right > window.innerWidth) menu.style.left = (x - rect.width) + 'px';
  if (rect.bottom > window.innerHeight) menu.style.top = (y - rect.height) + 'px';
}

function closeContextMenu() {
  const m = document.getElementById('contextMenu');
  if (m) m.remove();
}

document.addEventListener('click', closeContextMenu);
document.addEventListener('contextmenu', (e) => {
  if (!e.target.closest('.context-menu')) closeContextMenu();
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') closeContextMenu();
});

function openRenameChannelDialog(channel) {
  const box = $('modalBox');
  box.innerHTML = `
    <button class="modal-close" id="modalClose">×</button>
    <h2>Переименовать канал</h2>
    <input id="mRenameName" placeholder="Название" value="${escapeHtml(channel.name)}">
    <button id="mRenameSave">Сохранить</button>
  `;
  $('modal').hidden = false;
  $('modalClose').onclick = () => $('modal').hidden = true;
  const input = $('mRenameName');
  input.focus();
  input.select();
  const save = () => {
    const name = input.value.trim();
    if (!name) return alert('Введите название');
    if (name === channel.name) { $('modal').hidden = true; return; }
    $('modal').hidden = true;
    wsSend({ type: 'rename-channel', channelId: channel.id, name });
  };
  $('mRenameSave').onclick = save;
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') save(); });
}

// ---------- Roles UI ----------
function openRolesManagerModal() {
  if (!activeServer) return;
  const roles = activeServer.roles || [];
  const box = $('modalBox');
  box.innerHTML = `
    <button class="modal-close" id="modalClose">×</button>
    <h2>Роли сервера</h2>
    <p class="hint">Ролей: ${roles.length} / 30</p>
    <div id="rolesList"></div>
    <button id="mRoleAdd" style="margin-top:12px">+ Создать роль</button>
  `;
  $('modal').hidden = false;
  $('modalClose').onclick = () => $('modal').hidden = true;

  const list = $('rolesList');
  if (!roles.length) list.innerHTML = `<p class="hint">Ролей пока нет</p>`;
  for (const r of roles) {
    const row = document.createElement('div');
    row.className = 'server-pick';
    row.innerHTML = `
      <span>
        <span class="role-dot" style="background:${escapeHtml(r.color)}"></span>
        ${escapeHtml(r.name)}
        ${r.permissions?.admin ? '<span class="hint">· админ</span>' : ''}
      </span>
    `;
    const actions = document.createElement('div');
    actions.style.display = 'flex';
    actions.style.gap = '6px';
    const editBtn = document.createElement('button');
    editBtn.textContent = '✏️';
    editBtn.title = 'Редактировать';
    editBtn.onclick = () => openRoleEditorModal(r);
    const delBtn = document.createElement('button');
    delBtn.textContent = '🗑';
    delBtn.className = 'danger';
    delBtn.title = 'Удалить';
    delBtn.onclick = () => {
      if (confirm(`Удалить роль "${r.name}"?`)) {
        wsSend({ type: 'delete-role', roleId: r.id });
        $('modal').hidden = true;
      }
    };
    actions.appendChild(editBtn);
    actions.appendChild(delBtn);
    row.appendChild(actions);
    list.appendChild(row);
  }

  $('mRoleAdd').onclick = () => openRoleEditorModal(null);
}

function openRoleEditorModal(role) {
  const isNew = !role;
  const r = role || { name: '', color: '#99aab5', permissions: {} };
  const box = $('modalBox');
  box.innerHTML = `
    <button class="modal-close" id="modalClose">×</button>
    <h2>${isNew ? 'Новая роль' : 'Редактировать роль'}</h2>
    <label class="hint">Название</label>
    <input id="rName" value="${escapeHtml(r.name)}" maxlength="30" placeholder="Модератор">
    <label class="hint">Цвет ника</label>
    <div style="display:flex;gap:8px;align-items:center;margin-bottom:12px">
      <input id="rColor" type="color" value="${escapeHtml(r.color)}" style="width:60px;padding:2px;height:38px">
      <span id="rColorPreview" style="color:${escapeHtml(r.color)};font-weight:600">${escapeHtml(r.name || 'Ник')}</span>
    </div>
    <label class="hint">Права</label>
    <div class="perm-row"><input type="checkbox" id="pAdmin" ${r.permissions?.admin ? 'checked' : ''}> <label for="pAdmin">Администратор (все права)</label></div>
    <div class="perm-row"><input type="checkbox" id="pManageChannels" ${r.permissions?.manageChannels ? 'checked' : ''}> <label for="pManageChannels">Управление каналами</label></div>
    <div class="perm-row"><input type="checkbox" id="pManageRoles" ${r.permissions?.manageRoles ? 'checked' : ''}> <label for="pManageRoles">Управление ролями</label></div>
    <div class="perm-row"><input type="checkbox" id="pManageCinema" ${r.permissions?.manageCinema ? 'checked' : ''}> <label for="pManageCinema">Управление кинотеатром</label></div>
    <button id="rSave" style="margin-top:16px">${isNew ? 'Создать' : 'Сохранить'}</button>
  `;
  $('modal').hidden = false;
  $('modalClose').onclick = () => $('modal').hidden = true;

  const nameIn = $('rName');
  const colorIn = $('rColor');
  const preview = $('rColorPreview');

  nameIn.addEventListener('input', () => { preview.textContent = nameIn.value || 'Ник'; });
  colorIn.addEventListener('input', () => { preview.style.color = colorIn.value; });

  $('rSave').onclick = () => {
    const name = nameIn.value.trim();
    if (!name) return alert('Введите название роли');
    const payload = {
      name,
      color: colorIn.value,
      permissions: {
        admin: $('pAdmin').checked,
        manageChannels: $('pManageChannels').checked,
        manageRoles: $('pManageRoles').checked,
        manageCinema: $('pManageCinema').checked
      }
    };
    if (isNew) wsSend({ type: 'create-role', ...payload });
    else wsSend({ type: 'update-role', roleId: role.id, ...payload });
    $('modal').hidden = true;
  };
}

function openAssignRolesModal(userId) {
  if (!activeServer) return;
  const u = users.find(x => x.id === userId);
  const roles = activeServer.roles || [];
  const userRoleIds = (activeServer.userRoles || {})[userId] || [];

  const box = $('modalBox');
  box.innerHTML = `
    <button class="modal-close" id="modalClose">×</button>
    <h2>Роли: ${escapeHtml(u?.username || '?')}</h2>
    <div id="assignList"></div>
  `;
  $('modal').hidden = false;
  $('modalClose').onclick = () => $('modal').hidden = true;

  const list = $('assignList');
  if (!roles.length) {
    list.innerHTML = `<p class="hint">Сначала создайте роли (⚙️ Управление ролями)</p>`;
    return;
  }
  for (const r of roles) {
    const has = userRoleIds.includes(r.id);
    const row = document.createElement('label');
    row.style.display = 'flex';
    row.style.alignItems = 'center';
    row.style.gap = '8px';
    row.style.padding = '6px 8px';
    row.style.cursor = 'pointer';
    row.innerHTML = `
      <input type="checkbox" ${has ? 'checked' : ''}>
      <span class="role-dot" style="background:${escapeHtml(r.color)}"></span>
      <span style="color:${escapeHtml(r.color)}">${escapeHtml(r.name)}</span>
    `;
    const cb = row.querySelector('input');
    cb.onchange = () => {
      if (cb.checked) wsSend({ type: 'assign-role', userId, roleId: r.id });
      else wsSend({ type: 'unassign-role', userId, roleId: r.id });
    };
    list.appendChild(row);
  }
}

// ---------- Profile ----------
function openProfileModal(userId) {
  const u = getUser(userId) || (userId === me?.id ? me : null);
  if (!u) return;

  let rolesHtml = '';
  if (viewMode === 'server' && activeServer) {
    const isMember = activeServer.members.some(x => x.id === userId);
    if (isMember) {
      const roleIds = (activeServer.userRoles || {})[userId] || [];
      const roleObjs = roleIds.map(rid => (activeServer.roles || []).find(r => r.id === rid)).filter(Boolean);
      const isOwner = activeServer.ownerId === userId;
      rolesHtml = `<h3>Роли на сервере</h3>`;
      if (isOwner) {
        rolesHtml += `<div class="profile-role" style="color:#f0b232">👑 Владелец</div>`;
      }
      if (roleObjs.length) {
        for (const r of roleObjs) {
          rolesHtml += `<div class="profile-role"><span class="role-dot" style="background:${escapeHtml(r.color)}"></span><span style="color:${escapeHtml(r.color)}">${escapeHtml(r.name)}</span></div>`;
        }
      } else if (!isOwner) {
        rolesHtml += `<p class="hint">Ролей нет</p>`;
      }
    }
  }

  const canManageRoles = viewMode === 'server' && activeServer && hasPerm(activeServer, me.id, 'manageRoles') && userId !== activeServer.ownerId;
  const isMe = userId === me.id;

  const box = $('modalBox');
  box.innerHTML = `
    <button class="modal-close" id="modalClose">×</button>
    <div class="profile-header">
      <div class="profile-avatar">${avatarHtml(u, 80)}</div>
      <div>
        <div class="profile-name">${escapeHtml(u.username)}</div>
        ${isMe ? '<div class="hint">Это вы</div>' : ''}
      </div>
    </div>
    <h3>О себе</h3>
    <p class="profile-desc">${u.description ? escapeHtml(u.description) : '<span class="hint">Пусто</span>'}</p>
    ${rolesHtml}
    ${isMe ? `<button id="profileEdit" style="margin-top:12px">✎ Редактировать профиль</button>` : ''}
    ${canManageRoles ? `<button id="profileRoles" class="ghost" style="margin-top:6px">⚙ Управление ролями</button>` : ''}
  `;
  $('modal').hidden = false;
  $('modalClose').onclick = () => $('modal').hidden = true;

  if (isMe) {
    $('profileEdit').onclick = () => openEditProfileModal();
  }
  if (canManageRoles) {
    $('profileRoles').onclick = () => {
      $('modal').hidden = true;
      openAssignRolesModal(userId);
    };
  }
}

function openEditProfileModal() {
  const u = getUser(me.id) || me;
  const box = $('modalBox');
  box.innerHTML = `
    <button class="modal-close" id="modalClose">×</button>
    <h2>Редактировать профиль</h2>
    <label class="hint">Никнейм</label>
    <input id="pName" value="${escapeHtml(u.username)}" maxlength="20">
    <label class="hint">Аватар (URL картинки)</label>
    <input id="pAvatar" value="${escapeHtml(u.avatar || '')}" placeholder="https://...">
    <label class="hint">О себе</label>
    <textarea id="pDesc" maxlength="500" rows="4" placeholder="Пара слов о себе" class="modal-textarea">${escapeHtml(u.description || '')}</textarea>
    <button id="pSave" style="margin-top:12px">Сохранить</button>
  `;
  $('modal').hidden = false;
  $('modalClose').onclick = () => $('modal').hidden = true;
  $('pSave').onclick = () => {
    const username = $('pName').value.trim();
    const avatar = $('pAvatar').value.trim();
    const description = $('pDesc').value;
    if (username.length < 3) return alert('Ник: минимум 3 символа');
    wsSend({ type: 'update-profile', username, avatar, description });
    $('modal').hidden = true;
  };
}

$('profileBtn').addEventListener('click', () => {
  if (!me) return;
  openProfileModal(me.id);
});

// ---------- Logout ----------
$('logoutBtn').addEventListener('click', () => {
  if (!confirm('Выйти из аккаунта?')) return;
  // 1) Чистим токен ДО закрытия WS, чтобы onclose не попытался реконнектиться
  localStorage.removeItem('token');
  token = null;

  // 2) Рвём соединение
  try { if (ws) ws.close(); } catch {}
  ws = null;

  // 3) Сбрасываем всё клиентское состояние
  me = null;
  servers = []; users = []; onlineSet = new Set();
  activeServer = null; activeChannel = null; activeDM = null;
  viewMode = 'home';
  channelMessages.clear();
  dmThreads.clear();
  cinemaTimes.clear();
  unreadChannels.clear();
  unreadDMs.clear();
  document.getElementById('app').classList.remove('home');

  // 4) Голос/микрофон
  if (localStream) { localStream.getTracks().forEach(t => t.stop()); localStream = null; }
  localMuted = false; localSpeaking = false;
  myVoiceChannelId = null;
  for (const pc of pcs.values()) try { pc.close(); } catch {}
  pcs.clear(); analysers.clear(); speakingPeers.clear();

  // 5) Кино
  destroyPlayer();
  currentSource = '';

  // 6) Показываем экран входа
  $('app').hidden = true;
  $('auth').hidden = false;
  $('authPass').value = '';
  $('authError').textContent = '';
  $('authName').focus();
});

// ---------- Boot ----------
startSpeakingLoop();
if (token) connectWS(); else { /* показываем экран входа */ }