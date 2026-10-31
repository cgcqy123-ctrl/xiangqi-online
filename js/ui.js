// 界面渲染与交互（只负责 DOM，不含规则判定与网络）

const V = new URL(import.meta.url).search; // 跟随 index.html 的 ?v= 做缓存穿透
const R = await import('./rules.js' + V);

const $ = (id) => document.getElementById(id);
const SVGNS = 'http://www.w3.org/2000/svg';
const QUICK = ['你好 👋', '开局吧', '这步厉害', '吃！', '将军！', '手下留情', '再来一局？'];

let lastView = null;
let actionCb = null;
let chatCb = null;
let selSq = null;
let targets = [];
let boardSig = '';
let linesEl = null;
let toastTimer = 0;
let resignArmTimer = 0;
let resignArmed = false;

/* ---------------- 基础 ---------------- */

export function showScreen(name) {
  for (const id of ['home', 'lobby', 'table']) {
    $('scr-' + id).classList.toggle('hidden', id !== name);
  }
  if (name === 'table') layoutBoard();
}

export function toast(msg, ms = 2400) {
  const el = $('toast');
  if (!el) return;
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), ms);
}

export function setChatSender(fn) {
  chatCb = fn;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function btn(text, kind, fn) {
  const b = document.createElement('button');
  b.className = 'btn ' + kind;
  b.textContent = text;
  b.addEventListener('click', fn);
  return b;
}

/* ---------------- 房间大厅 ---------------- */

export function renderLobby({ code, players = [], spectators = [], isHost, canStart, tip, youSeat = -1 }) {
  showScreen('lobby');
  $('lobby-code').textContent = code || '----';
  const ul = $('seat-list');
  ul.innerHTML = '';
  for (const seat of [0, 1]) {
    const p = players[seat] || { name: '', connected: false };
    const li = document.createElement('li');
    const side = seat === 0 ? '红方' : '黑方';
    li.className = 'seat-item' + (p.name ? ' filled' : '') + (seat === 0 ? ' red' : ' black');
    li.innerHTML = `
      <span class="idx">${seat === 0 ? '红' : '黑'}</span>
      <span class="nm">${p.name ? escapeHtml(p.name) : '空位'}${
        p.name && seat === youSeat ? '（你）' : ''
      }${p.name && p.connected === false ? ' <i>离线</i>' : ''}</span>
      <span class="tag">${side}${seat === 0 ? ' · 先行' : ''}</span>`;
    ul.appendChild(li);
  }
  const specNames = spectators.filter(Boolean);
  $('lobby-spec').textContent = specNames.length ? `观战：${specNames.join('、')}` : '第 3 位起自动成为观战';
  const b = $('btn-start');
  b.classList.toggle('hidden', !isHost);
  const filled = players.filter((p) => p && p.name).length;
  b.disabled = !canStart;
  b.textContent = canStart ? '开始对局' : `等待对手入座（${filled}/2）`;
  $('lobby-tip').textContent =
    tip || (isHost ? '把房号发给朋友，两人到齐后点「开始对局」' : '等待房主开始对局…');
}

/* ---------------- 棋盘线（只画一次） ---------------- */

function line(svg, x1, y1, x2, y2, cls = 'gl') {
  const l = document.createElementNS(SVGNS, 'line');
  l.setAttribute('x1', x1);
  l.setAttribute('y1', y1);
  l.setAttribute('x2', x2);
  l.setAttribute('y2', y2);
  l.setAttribute('class', cls);
  svg.appendChild(l);
}

function riverText(svg, x, y, txt) {
  const t = document.createElementNS(SVGNS, 'text');
  t.setAttribute('x', x);
  t.setAttribute('y', y);
  t.setAttribute('text-anchor', 'middle');
  t.setAttribute('class', 'river-text');
  t.textContent = txt;
  svg.appendChild(t);
}

/** 兵/炮位的小十字标记（纯装饰） */
function positionMark(svg, x, y) {
  const xs = x === 0 ? [1] : x === 8 ? [-1] : [1, -1];
  for (const sx of xs) {
    for (const sy of [1, -1]) {
      line(svg, x + sx * 0.1, y, x + sx * 0.22, y);
      line(svg, x + sx * 0.1, y, x + sx * 0.1, y + sy * 0.14);
    }
  }
}

function buildLines() {
  const svg = document.createElementNS(SVGNS, 'svg');
  svg.setAttribute('viewBox', '0 0 8 9');
  svg.setAttribute('preserveAspectRatio', 'none');
  svg.setAttribute('class', 'lines');

  for (let y = 0; y < 10; y++) line(svg, 0, y, 8, y, y === 0 || y === 9 ? 'gl border' : 'gl');
  for (let x = 0; x < 9; x++) {
    if (x === 0 || x === 8) {
      line(svg, x, 0, x, 9, 'gl border');
    } else {
      line(svg, x, 0, x, 4);
      line(svg, x, 5, x, 9);
    }
  }
  // 九宫斜线
  line(svg, 3, 0, 5, 2);
  line(svg, 5, 0, 3, 2);
  line(svg, 3, 7, 5, 9);
  line(svg, 5, 7, 3, 9);
  // 楚河汉界
  riverText(svg, 1.85, 4.75, '楚 河');
  riverText(svg, 6.15, 4.75, '汉 界');
  // 兵位 / 炮位标记
  for (const c of [0, 2, 4, 6, 8]) {
    positionMark(svg, c, 3);
    positionMark(svg, c, 6);
  }
  for (const c of [1, 7]) {
    positionMark(svg, c, 2);
    positionMark(svg, c, 7);
  }
  return svg;
}

/** 按容器大小算出每格像素，写进 --cell，供棋子字号使用 */
function layoutGrid() {
  const board = $('board');
  const grid = $('board-grid');
  if (!board || !grid) return;
  const gw = grid.clientWidth || 0;
  if (gw > 20) board.style.setProperty('--cell', gw / 8 + 'px');
}

function layoutBoard() {
  const box = $('board-box');
  const board = $('board');
  if (!box || !board) return;
  const bw = box.clientWidth || 0;
  const bh = box.clientHeight || 0;
  if (bw > 40 && bh > 40) {
    const w = Math.min(bw, (bh * 8) / 9);
    board.style.width = Math.round(w) + 'px';
    board.style.height = Math.round((w * 9) / 8) + 'px';
  }
  layoutGrid();
}

if (typeof window !== 'undefined') {
  window.addEventListener('resize', () => layoutBoard());
  if (typeof window.ResizeObserver === 'function') {
    try {
      const ro = new window.ResizeObserver(() => layoutBoard());
      const box = document.getElementById('board-box');
      if (box) ro.observe(box);
    } catch (_) { /* ignore */ }
  }
}

/* ---------------- 棋桌 ---------------- */

export function resetSelection() {
  selSq = null;
  targets = [];
  boardSig = '';
}

/**
 * 渲染棋桌。view 由 game.view(seat) 得出，另外可带 _code / _isHost / _spectators。
 * actionCb 负责把动作发给房主（本地直接调用 / 远端走网络）。
 */
export function renderTable(view, cb) {
  actionCb = cb;
  const sig = view.board.join('|') + '#' + view.turn + '#' + view.phase;
  if (sig !== boardSig) {
    boardSig = sig;
    selSq = null;
    targets = [];
  }
  lastView = view;
  showScreen('table');

  $('t-code').textContent = view._code || $('t-code').textContent;
  const me = view.players.find((p) => p.side === view.mySide);
  const foe = view.players.find((p) => p.side !== view.mySide);
  $('t-room').textContent = `${me ? me.name : '红方'} vs ${foe ? foe.name : '黑方'}`;
  $('side-spec').textContent = (view._spectators && view._spectators.length) ? `观战 ${view._spectators.length}` : '';

  renderPlayers(view);
  renderBoard(view);
  renderMoves(view);
  renderOffers(view);
  renderActions(view);
  renderQuick();

  if (view.phase === 'over' && view.result) renderResult(view);
  else if ($('overlay').dataset.mode !== 'menu') clearOverlay();
  layoutBoard();
}

function renderPlayers(view) {
  const root = $('t-players');
  root.innerHTML = '';
  for (const p of view.players) {
    const chip = document.createElement('div');
    const active = view.phase === 'play' && view.turn === p.side;
    chip.className = 'player-chip' + (active ? ' active' : '') + (p.side === view.mySide ? ' me' : '');
    const caps = (view.captured[p.side] || []).map((pc) => R.NAME[R.sideOf(pc)][R.typeOf(pc)]).join(' ');
    chip.innerHTML = `
      <span class="dot-side ${p.side}"></span>
      <span class="nm">${escapeHtml(p.name)}${p.side === view.mySide ? '（你）' : ''}</span>
      <span class="cap">${p.connected ? '' : '<i class="off">离线</i> '}${caps ? '吃 ' + caps : ''}</span>`;
    root.appendChild(chip);
  }
}

function renderBoard(view) {
  const grid = $('board-grid');
  if (!grid) return;
  if (!linesEl) {
    linesEl = buildLines();
    grid.appendChild(linesEl);
  }
  // 清掉上一次的棋子与标记（保留线）
  for (const el of [...grid.children]) if (el !== linesEl) el.remove();

  // 上一步的两端
  if (view.lastMove) {
    for (const sq of [view.lastMove.from, view.lastMove.to]) {
      const mk = document.createElement('div');
      mk.className = 'marker last';
      mk.style.setProperty('--r', R.rowOf(sq));
      mk.style.setProperty('--c', R.colOf(sq));
      grid.appendChild(mk);
    }
  }

  // 可落点提示（只是视觉，不吃点击；真正的点击交给下面的「交叉点热区」）
  for (const sq of targets) {
    const mk = document.createElement('div');
    mk.className = 'marker ' + (view.board[sq] ? 'cap' : 'dot');
    mk.style.setProperty('--r', R.rowOf(sq));
    mk.style.setProperty('--c', R.colOf(sq));
    mk.dataset.sq = String(sq);
    grid.appendChild(mk);
  }

  // 交叉点热区：空格也能点（有子的格子由棋子自己收点击）
  for (let sq = 0; sq < 90; sq++) {
    if (view.board[sq]) continue;
    const hit = document.createElement('div');
    hit.className = 'hit' + (targets.includes(sq) ? ' target' : '');
    hit.style.setProperty('--r', R.rowOf(sq));
    hit.style.setProperty('--c', R.colOf(sq));
    hit.dataset.sq = String(sq);
    hit.addEventListener('click', () => onSquareClick(view, sq));
    grid.appendChild(hit);
  }

  // 棋子
  const myTurn = view.phase === 'play' && view.mySide && view.turn === view.mySide;
  for (let sq = 0; sq < view.board.length; sq++) {
    const pc = view.board[sq];
    if (!pc) continue;
    const side = R.sideOf(pc);
    const el = document.createElement('div');
    const mine = view.mySide === side;
    el.className = 'piece ' + side + (mine && myTurn ? ' mine' : '');
    if (selSq === sq) el.classList.add('selected');
    if (targets.includes(sq)) el.classList.add('can-take');
    if (view.inCheck === side && R.typeOf(pc) === 'K') el.classList.add('in-check');
    el.style.setProperty('--r', R.rowOf(sq));
    el.style.setProperty('--c', R.colOf(sq));
    el.dataset.sq = String(sq);
    el.textContent = R.NAME[side][R.typeOf(pc)];
    el.addEventListener('click', () => onSquareClick(view, sq));
    grid.appendChild(el);
  }

  const banner = $('check-banner');
  if (banner) {
    const showCheck = view.phase === 'play' && view.inCheck;
    banner.classList.toggle('hidden', !showCheck);
    if (showCheck) banner.textContent = view.inCheck === 'r' ? '红方被将军！' : '黑方被将军！';
  }
  layoutGrid();
}

function onSquareClick(view, sq) {
  const pc = view.board[sq];
  if (!view.mySide) {
    toast('观战中，只能看棋');
    return;
  }
  if (view.phase !== 'play') {
    toast('对局还没开始或已经结束');
    return;
  }
  if (R.sideOf(pc) === view.mySide) {
    if (view.turn !== view.mySide) {
      toast('还没轮到你走棋');
      return;
    }
    if (selSq === sq) {
      selSq = null;
      targets = [];
    } else {
      selSq = sq;
      targets = R.legalMoves(view.board, sq);
      if (!targets.length) {
        selSq = null;
        toast('这个子没有可走的棋');
      }
    }
    renderBoard(view);
    return;
  }
  if (selSq !== null && targets.includes(sq)) {
    tryMove(view, sq);
    return;
  }
  selSq = null;
  targets = [];
  renderBoard(view);
}

function tryMove(view, to) {
  if (selSq === null) return;
  if (view.phase !== 'play' || view.turn !== view.mySide) {
    toast('还没轮到你走棋');
    return;
  }
  const from = selSq;
  selSq = null;
  targets = [];
  if (actionCb) actionCb({ type: 'move', from, to });
}

function renderMoves(view) {
  const ol = $('move-list');
  if (!ol) return;
  ol.innerHTML = '';
  if (!view.moves.length) {
    const li = document.createElement('li');
    li.className = 'empty';
    li.textContent = view.phase === 'play' ? '红方先行，还没有走子' : '还没有棋谱';
    ol.appendChild(li);
    return;
  }
  for (let i = 0; i < view.moves.length; i += 2) {
    const li = document.createElement('li');
    const no = Math.floor(i / 2) + 1;
    const red = view.moves[i];
    const black = view.moves[i + 1];
    if (i + (black ? 1 : 0) === view.moves.length - 1) li.className = 'newest';
    li.innerHTML = `<span class="no">${no}.</span>
      <span class="r">${red ? escapeHtml(red.notation) : ''}</span>
      <span class="b">${black ? escapeHtml(black.notation) : ''}</span>`;
    ol.appendChild(li);
  }
  ol.scrollTop = ol.scrollHeight;
}

function renderOffers(view) {
  const bar = $('offer-bar');
  if (!bar) return;
  bar.innerHTML = '';
  const { undo, draw } = view.offers || {};  const mine = (b) => b !== null && b !== undefined && b === view.seat;
  let text = '';
  let kind = null;
  if (undo !== null && undo !== undefined) {
    text = mine(undo) ? '已发出悔棋请求，等待对方同意…' : `${view.players[undo].name} 请求悔棋`;
    kind = mine(undo) ? null : 'undo';
  } else if (draw !== null && draw !== undefined) {
    text = mine(draw) ? '已发出和棋请求，等待对方同意…' : `${view.players[draw].name} 请求和棋`;
    kind = mine(draw) ? null : 'draw';
  }
  if (!text) {
    bar.classList.add('hidden');
    return;
  }
  bar.classList.remove('hidden');
  const span = document.createElement('span');
  span.className = 'txt';
  span.textContent = text;
  bar.appendChild(span);
  if (kind && view.mySide) {
    bar.appendChild(btn('同意', 'primary tiny', () => actionCb && actionCb({ type: kind + 'Reply', accept: true })));
    bar.appendChild(btn('拒绝', 'ghost tiny', () => actionCb && actionCb({ type: kind + 'Reply', accept: false })));
  }
}

function renderActions(view) {
  const bar = $('actions');
  if (!bar) return;
  bar.innerHTML = '';
  if (view.phase === 'lobby') {
    bar.innerHTML = '<span class="wait">等待房主开始对局…</span>';
    return;
  }

  const status = document.createElement('span');
  if (!view.mySide) {
    status.className = 'wait';
    status.textContent = '观战中';
  } else if (view.phase === 'over') {
    status.className = 'wait';
    status.textContent = '本局结束';
  } else if (view.turn === view.mySide) {
    status.className = 'status';
    status.textContent = `轮到你走棋（${R.SIDE_NAME[view.mySide]}方）`;
  } else {
    status.className = 'wait';
    const foe = view.players.find((p) => p.side === view.turn);
    status.textContent = `等待 ${foe ? foe.name : '对手'} 走棋…`;
  }
  bar.appendChild(status);

  if (!view.mySide || view.phase !== 'play') return;
  const spacer = document.createElement('span');
  spacer.className = 'spacer';
  bar.appendChild(spacer);

  const canUndo =
    view.turn === view.mySide &&
    view.moves.length > 0 &&
    (view.offers || {}).undo == null &&
    (view.offers || {}).draw == null;
  const undoBtn = btn('悔棋', 'ghost tiny', () => actionCb && actionCb({ type: 'undo' }));
  undoBtn.disabled = !canUndo;
  bar.appendChild(undoBtn);

  const drawBtn = btn('求和', 'ghost tiny', () => actionCb && actionCb({ type: 'draw' }));
  drawBtn.disabled = (view.offers || {}).draw != null || (view.offers || {}).undo != null;
  bar.appendChild(drawBtn);

  const resignBtn = btn(resignArmed ? '确定认输' : '认输', 'ghost tiny danger', () => {
    if (!resignArmed) {
      resignArmed = true;
      resignBtn.textContent = '确定认输';
      clearTimeout(resignArmTimer);
      resignArmTimer = setTimeout(() => {
        resignArmed = false;
      }, 4000);
      return;
    }
    resignArmed = false;
    if (actionCb) actionCb({ type: 'resign' });
  });
  bar.appendChild(resignBtn);
}

function renderQuick() {
  const box = $('quick');
  if (!box || box.dataset.done) return;
  box.dataset.done = '1';
  for (const q of QUICK) {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = q;
    b.addEventListener('click', () => chatCb && chatCb(q));
    box.appendChild(b);
  }
}

/* ---------------- 聊天 ---------------- */

export function renderChat(list = [], me = '') {
  const log = $('chat-log');
  if (!log) return;
  log.innerHTML = '';
  for (const m of list) {
    const div = document.createElement('div');
    if (m.kind === 'sys') {
      div.className = 'msg sys';
      div.textContent = m.text;
    } else {
      div.className = 'msg' + (m.name && m.name === me ? ' me' : '');
      div.innerHTML = `<span class="who">${escapeHtml(m.name || '')}</span>${escapeHtml(m.text || '')}`;
    }
    log.appendChild(div);
  }
  log.scrollTop = log.scrollHeight;
}

/* ---------------- 结算 / 菜单浮层 ---------------- */

function renderResult(view) {
  const ov = $('overlay');
  const p = $('overlay-panel');
  const r = view.result;
  let title;
  let cls;
  if (!r.winner) {
    title = '和棋';
    cls = 'wd';
  } else if (view.mySide) {
    const win = r.winner === view.mySide;
    title = win ? '你赢了！' : '你输了';
    cls = win ? 'wr' : 'wb';
  } else {
    title = `${R.SIDE_NAME[r.winner]}方胜`;
    cls = r.winner === 'r' ? 'wr' : 'wb';
  }
  p.innerHTML = `
    <h2 class="${cls}">${title}</h2>
    <p class="calc">${escapeHtml(r.text)} · 共 ${r.plies} 手</p>
    <div class="ov-actions"></div>`;
  const acts = p.querySelector('.ov-actions');
  if (!view.mySide) {
    const s = document.createElement('span');
    s.className = 'wait';
    s.textContent = '观战结束';
    acts.appendChild(s);
  } else if (view._isHost) {
    acts.appendChild(btn('再来一局', 'primary', () => actionCb && actionCb({ type: 'restart' })));
  } else {
    const s = document.createElement('span');
    s.className = 'wait';
    s.textContent = '等待房主开新局…';
    acts.appendChild(s);
  }
  ov.classList.remove('hidden');
  ov.dataset.mode = 'result';
}

/** 菜单浮层（房号 / 离开） */
export function showMenu({ code, role, onQuit }) {
  const ov = $('overlay');
  const p = $('overlay-panel');
  p.innerHTML = `
    <h2 class="wd">房间 ${escapeHtml(code || '----')}</h2>
    <p class="calc">${role === 'host' ? '你是房主（红方），房主离开房间就散局了' : '离开房间可以再输入房号回来'}</p>
    <div class="ov-actions"></div>`;
  const acts = p.querySelector('.ov-actions');
  acts.appendChild(btn('关闭', 'ghost', () => {
    delete ov.dataset.mode;
    clearOverlay();
  }));
  acts.appendChild(btn('离开房间', 'primary', () => {
    delete ov.dataset.mode;
    clearOverlay();
    if (onQuit) onQuit();
  }));
  ov.classList.remove('hidden');
  ov.dataset.mode = 'menu';
}

export function clearOverlay() {
  const ov = $('overlay');
  if (!ov) return;
  delete ov.dataset.mode;
  ov.classList.add('hidden');
}

/* ---------------- 侧栏切换 ---------------- */

export function bindUI() {
  const moved = $('tab-moves');
  const chat = $('tab-chat');
  const showTab = (name) => {
    moved.classList.toggle('active', name === 'moves');
    chat.classList.toggle('active', name === 'chat');
    $('move-list').classList.toggle('hidden', name !== 'moves');
    $('chat-pane').classList.toggle('hidden', name !== 'chat');
  };
  moved.addEventListener('click', () => showTab('moves'));
  chat.addEventListener('click', () => showTab('chat'));

  $('chat-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const input = $('chat-input');
    const text = input.value.trim();
    if (!text) return;
    input.value = '';
    if (chatCb) chatCb(text);
  });
  renderQuick();
}
