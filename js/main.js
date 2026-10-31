// 入口：串起大厅、房间、对局和网络
//
// 缓存穿透：所有子模块都带上 index.html 里 script 标签的 ?v=xxx，
// 以后改版只要把 index.html 里的版本号 +1，浏览器就不会继续用旧缓存。
//
// 角色分工：房主（host）是唯一权威，跑对局状态机、校验走法、广播视图；
// 另一位玩家和所有观众只提交动作 / 收视图。

const V = new URL(import.meta.url).search;
const { Game, PHASE } = await import('./game.js' + V);
const { HostRoom, GuestRoom, normalizeCode } = await import('./net.js' + V);
const UI = await import('./ui.js' + V);

const $ = (id) => document.getElementById(id);

/** 座位安排：0 = 房主（红方，先行），1 = 对手（黑方），2 起为观战 */
const MAX_SEATS = 8;
const CHAT_KEEP = 60;

const S = {
  name: '',
  role: null, // 'host' | 'guest'
  seat: 0,
  code: '',
  host: null,
  guest: null,
  game: null,
  lobbyPlayers: null, // 房主侧：[{name, connected}, {name, connected}]
  spec: [], // 房主侧：S.spec[i] = 座号 2+i 的观众昵称，null = 空位
  remoteSpecs: [], // 加入者侧：房主同步过来的观众昵称
  chat: [],
  busy: false,
};

/* ---------------- 通用 ---------------- */

function getName() {
  const v = $('in-name').value.trim().slice(0, 8);
  if (!v) {
    UI.toast('先填个昵称');
    $('in-name').focus();
    return '';
  }
  localStorage.setItem('xq-name', v);
  return v;
}

function lock(on) {
  S.busy = on;
  for (const id of ['btn-create', 'btn-join']) {
    const el = $(id);
    if (el) el.disabled = on;
  }
}

function resetAll() {
  try { S.host && S.host.closeAll(); } catch (_) { /* ignore */ }
  try { S.guest && S.guest.close(); } catch (_) { /* ignore */ }
  S.host = null;
  S.guest = null;
  S.game = null;
  S.role = null;
  S.seat = 0;
  S.code = '';
  S.lobbyPlayers = null;
  S.spec = [];
  S.remoteSpecs = [];
  S.chat = [];
  UI.clearOverlay();
  UI.resetSelection();
  UI.renderChat([], S.name);
  UI.showScreen('home');
}

function decorate(view, isHost) {
  view._code = S.code;
  view._isHost = !!isHost;
  view._spectators = S.role === 'host' ? S.spec.filter(Boolean) : S.remoteSpecs || [];
  return view;
}

function pushChat(entry) {
  S.chat.push(entry);
  if (S.chat.length > CHAT_KEEP) S.chat.shift();
  UI.renderChat(S.chat, S.name);
}

function makeSys(text) {
  return { kind: 'sys', text, ts: Date.now() };
}

function sysMsg(text) {
  const entry = makeSys(text);
  pushChat(entry);
  return entry;
}

/* ---------------- 房主 ---------------- */

async function createRoom() {
  const name = getName();
  if (!name || S.busy) return;
  lock(true);
  S.role = 'host';
  S.seat = 0;
  S.name = name;
  S.lobbyPlayers = [
    { name, connected: true },
    { name: null, connected: false },
  ];
  S.spec = [];
  S.chat = [];
  try {
    const room = new HostRoom({
      onHello: hostOnHello,
      onMessage: hostOnMessage,
      onSeatGone: hostOnSeatGone,
      onError: (m) => UI.toast(m),
    });
    S.host = room;
    S.code = await room.open();
    hostRenderLobby();
    sysMsg(`房间 ${S.code} 已创建，把房号发给朋友吧`);
  } catch (e) {
    UI.toast(e && e.message ? e.message : '创建房间失败');
    resetAll();
  } finally {
    lock(false);
  }
}

function remoteSeats() {
  const out = [];
  if (S.lobbyPlayers && S.lobbyPlayers[1].name && S.lobbyPlayers[1].connected) out.push(1);
  S.spec.forEach((n, i) => {
    if (n) out.push(2 + i);
  });
  return out;
}

function specNames() {
  return S.spec.filter(Boolean);
}

function seatName(seat) {
  if (seat >= 2) return S.spec[seat - 2] || '观众';
  return (S.lobbyPlayers[seat] && S.lobbyPlayers[seat].name) || '玩家';
}

function hostOnHello(conn, name) {
  if (!S.lobbyPlayers) {
    S.host.sendRaw(conn, { t: 'full' });
    return;
  }
  const clean = (name || '').trim().slice(0, 8) || '玩家';
  let seat = -1;

  // 1) 同名重连：坐回 1 号位（对局中掉线也能回来）
  if (S.lobbyPlayers[1].name === clean) seat = 1;
  // 2) 1 号位空着
  else if (!S.lobbyPlayers[1].name) seat = 1;
  // 3) 观战位
  else {
    const free = S.spec.findIndex((n) => !n);
    if (free >= 0) {
      seat = 2 + free;
      S.spec[free] = clean;
    } else if (S.spec.length + 2 < MAX_SEATS) {
      seat = 2 + S.spec.length;
      S.spec.push(clean);
    }
  }

  if (seat < 0) {
    S.host.sendRaw(conn, { t: 'full' });
    setTimeout(() => { try { conn.close(); } catch (_) { /* ignore */ } }, 600);
    return;
  }

  S.host.bind(conn, seat);
  const isSpec = seat >= 2;
  if (!isSpec) S.lobbyPlayers[seat] = { name: clean, connected: true };
  if (S.game && !isSpec) {
    const p = S.game.players.find((x) => x.seat === seat);
    if (p) {
      p.name = clean;
      p.connected = true;
    }
  }

  const entry = sysMsg(`${clean} ${isSpec ? '进入观战' : '加入了房间'}`);
  S.host.send(seat, {
    t: 'joined',
    seat,
    code: S.code,
    side: isSpec ? null : seat === 0 ? 'r' : 'b',
    spectator: isSpec,
  });
  S.host.send(seat, { t: 'chatLog', list: S.chat });
  S.host.send(seat, {
    t: 'lobby',
    code: S.code,
    players: S.lobbyPlayers,
    spectators: specNames(),
    youSeat: seat,
  });
  hostBroadcastChat(entry, seat);
  if (!isSpec) UI.toast(`${clean} 加入了房间`);

  if (S.game && S.game.phase !== PHASE.LOBBY) pushStates();
  else hostRenderLobby();
}

function hostOnMessage(seat, msg) {
  if (!msg || typeof msg !== 'object') return;
  if (msg.t === 'action') hostAction(seat, msg.a);
  else if (msg.t === 'chat') {
    const text = String(msg.text || '').replace(/\s+/g, ' ').trim().slice(0, 60);
    if (!text) return;
    const entry = { kind: 'say', name: seatName(seat), text, ts: Date.now(), seat };
    pushChat(entry);
    hostBroadcastChat(entry);
  }
}

function hostBroadcastChat(entry, exceptSeat = -1) {
  if (!S.host) return;
  for (const seat of remoteSeats()) {
    if (seat === exceptSeat) continue;
    S.host.send(seat, { t: 'chat', msg: entry });
  }
}

function hostOnSeatGone(seat) {
  if (seat >= 2) {
    const idx = seat - 2;
    if (S.spec[idx]) {
      const who = S.spec[idx];
      S.spec[idx] = null;
      while (S.spec.length && !S.spec[S.spec.length - 1]) S.spec.pop();
      const entry = sysMsg(`${who} 退出观战`);
      hostBroadcastChat(entry);
    }
  } else if (seat === 1) {
    const who = S.lobbyPlayers[1].name;
    S.lobbyPlayers[1] = { name: who, connected: false };
    if (S.game) {
      const p = S.game.players.find((x) => x.seat === 1);
      if (p) p.connected = false;
    }
    if (who) {
      const entry = sysMsg(`${who} 掉线了，等待重连…`);
      hostBroadcastChat(entry);
      UI.toast(`${who} 掉线了，等待重连`);
    }
  }
  if (S.game && S.game.phase !== PHASE.LOBBY) pushStates();
  else hostRenderLobby();
}

function hostAction(seat, act) {
  if (S.role !== 'host' || !act || typeof act !== 'object') return;
  if (seat >= 2) {
    UI.toast('观战不能操作');
    return;
  }
  if (act.type === 'restart') {
    if (seat !== 0) {
      if (S.host) S.host.send(seat, { t: 'toast', msg: '只有房主能开新局' });
      return;
    }
    startRound();
    return;
  }
  if (!S.game) return;

  let notation = '';
  try {
    const r = S.game.action(seat, act);
    if (r && r.notation) notation = r.notation;
  } catch (e) {
    const msg = e && e.message ? e.message : '操作无效';
    if (seat === 0) UI.toast(msg);
    else if (S.host) S.host.send(seat, { t: 'toast', msg });
    return;
  }

  if (notation) {
    const last = S.game.history[S.game.history.length - 1];
    const entry = makeSys(`${seatName(last.side === 'r' ? 0 : 1)}：${notation}`);
    pushChat(entry);
    hostBroadcastChat(entry);
  }
  if (S.game.phase === PHASE.OVER && S.game.result) {
    const entry = makeSys(`对局结束 · ${S.game.result.text}`);
    pushChat(entry);
    hostBroadcastChat(entry);
  }
  pushStates();
}

function bothPlayersReady() {
  return !!(S.lobbyPlayers && S.lobbyPlayers[0].name && S.lobbyPlayers[1].name && S.lobbyPlayers[1].connected);
}

function startRound() {
  if (!S.game) return;
  if (!bothPlayersReady()) {
    UI.toast('有玩家掉线，等他回来再开新局');
    return;
  }
  UI.clearOverlay();
  UI.resetSelection();
  S.game.start();
  const entry = sysMsg('新的一局开始，红方先行');
  hostBroadcastChat(entry);
  pushStates();
}

function startGame() {
  if (S.role !== 'host') return;
  if (!bothPlayersReady()) {
    UI.toast('要两个人都在座位上才能开始');
    return;
  }
  S.game = new Game(S.lobbyPlayers.map((p) => ({ name: p.name, connected: true })));
  startRound();
}

function hostRenderLobby() {
  if (S.role !== 'host') return;
  const filled = S.lobbyPlayers.filter((p) => p.name).length;
  UI.renderLobby({
    code: S.code,
    players: S.lobbyPlayers,
    spectators: specNames(),
    youSeat: 0,
    isHost: true,
    canStart: bothPlayersReady(),
    tip:
      filled < 2
        ? `把房号 ${S.code} 发给朋友，他输入房号即可入座`
        : S.lobbyPlayers[1].connected
          ? '人齐了，点「开始对局」'
          : '黑方掉线了，等他重新进来',
  });
  broadcastLobby();
}

function broadcastLobby() {
  if (!S.host) return;
  for (const seat of remoteSeats()) {
    S.host.send(seat, {
      t: 'lobby',
      code: S.code,
      players: S.lobbyPlayers,
      spectators: specNames(),
      youSeat: seat,
    });
  }
}

function pushStates() {
  if (S.role !== 'host' || !S.host || !S.game) return;
  for (const seat of remoteSeats()) {
    const view = S.game.view(seat >= 2 ? -1 : seat);
    S.host.send(seat, { t: 'state', view: decorate(view, false) });
  }
  renderMyTable();
}

function renderMyTable() {
  if (!S.game) return;
  UI.renderTable(decorate(S.game.view(0), true), hostActionLocal);
}

function hostActionLocal(act) {
  hostAction(0, act);
}

/* ---------------- 加入者 ---------------- */

async function joinRoom() {
  const name = getName();
  if (!name || S.busy) return;
  const code = normalizeCode($('in-code').value);
  if (code.length !== 4) {
    UI.toast('房号是 4 位字母数字');
    return;
  }
  lock(true);
  S.role = 'guest';
  S.name = name;
  S.code = code;
  S.chat = [];
  S.remoteSpecs = [];
  try {
    const g = new GuestRoom({
      onMessage: guestOnMessage,
      onClose: () => {
        UI.toast('和房主的连接断开了');
        setTimeout(resetAll, 1200);
      },
      onFail: (m) => UI.toast(m),
      onError: (m) => UI.toast(m),
    });
    S.guest = g;
    await g.join(code, name);
    UI.renderLobby({
      code,
      players: [{ name: '房主', connected: true }, { name: '', connected: false }],
      spectators: [],
      youSeat: 1,
      isHost: false,
      canStart: false,
      tip: '正在进入房间…',
    });
  } catch (e) {
    UI.toast(e && e.message ? e.message : '加入失败');
    resetAll();
  } finally {
    lock(false);
  }
}

function guestOnMessage(msg) {
  if (!msg || typeof msg !== 'object') return;
  switch (msg.t) {
    case 'joined':
      S.seat = typeof msg.seat === 'number' ? msg.seat : 1;
      S.code = msg.code || S.code;
      break;
    case 'lobby':
      S.code = msg.code || S.code;
      S.remoteSpecs = msg.spectators || [];
      UI.renderLobby({
        code: S.code,
        players: msg.players || [],
        spectators: msg.spectators || [],
        youSeat: typeof msg.youSeat === 'number' ? msg.youSeat : S.seat,
        isHost: false,
        canStart: false,
        tip: '等待房主开始对局…',
      });
      break;
    case 'chatLog':
      S.chat = Array.isArray(msg.list) ? msg.list.slice(-CHAT_KEEP) : [];
      UI.renderChat(S.chat, S.name);
      break;
    case 'chat':
      if (msg.msg) pushChat(msg.msg);
      break;
    case 'state': {
      const view = msg.view;
      if (!view) return;
      UI.renderTable(decorate(view, false), guestActionLocal);
      break;
    }
    case 'toast':
      UI.toast(msg.msg || '');
      break;
    case 'full':
      UI.toast('房间已满（2 位玩家 + 6 位观众）');
      setTimeout(resetAll, 1500);
      break;
    default:
      break;
  }
}

function guestActionLocal(act) {
  if (!S.guest) return;
  if (!S.guest.send({ t: 'action', a: act })) UI.toast('发送失败，连接可能已断开');
}

/* ---------------- 聊天入口 ---------------- */

function sendChat(text) {
  const clean = String(text || '').replace(/\s+/g, ' ').trim().slice(0, 60);
  if (!clean) return;
  if (S.role === 'host') {
    const entry = { kind: 'say', name: S.name, text: clean, ts: Date.now(), seat: 0 };
    pushChat(entry);
    hostBroadcastChat(entry);
  } else if (S.role === 'guest') {
    // 不做本地回显：房主会把同一条消息广播回来，避免重复
    if (S.guest && !S.guest.send({ t: 'chat', text: clean })) UI.toast('发送失败，连接可能已断开');
  }
}

/* ---------------- 绑定事件 ---------------- */

function boot() {
  $('in-name').value = localStorage.getItem('xq-name') || '';
  $('btn-create').addEventListener('click', createRoom);
  $('btn-join').addEventListener('click', joinRoom);
  $('btn-start').addEventListener('click', startGame);
  $('btn-leave').addEventListener('click', () => resetAll());
  $('btn-menu').addEventListener('click', () => {
    UI.showMenu({ code: S.code, role: S.role, onQuit: () => resetAll() });
  });
  $('in-code').addEventListener('input', (e) => {
    e.target.value = normalizeCode(e.target.value);
  });
  $('in-code').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') joinRoom();
  });
  $('in-name').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') createRoom();
  });
  window.addEventListener('beforeunload', () => {
    try { S.host && S.host.closeAll(); } catch (_) { /* ignore */ }
    try { S.guest && S.guest.close(); } catch (_) { /* ignore */ }
  });
  UI.bindUI();
  UI.setChatSender(sendChat);
  UI.renderChat([], S.name);
  UI.showScreen('home');
}

boot();
