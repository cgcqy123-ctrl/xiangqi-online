// 端到端冒烟测试（需要 jsdom）：在 jsdom 里真跑 main.js，用假 Peer 模拟好友 + 观众
// 覆盖：建房 → 入座 → 开局 → 你来我往走十几手 → 悔棋 → 求和 → 认输 → 再来一局
//       → 聊天 → 观众观战 → 掉线重连 → 满员拒绝
// 运行：npm install && npm run test:e2e
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { JSDOM } from 'jsdom';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const url = (rel) => pathToFileURL(path.join(ROOT, rel)).href;

const dom = new JSDOM(fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8'), {
  url: 'https://example.com/',
  pretendToBeVisual: true,
});
global.window = dom.window;
global.document = dom.window.document;
global.HTMLElement = dom.window.HTMLElement;
global.localStorage = dom.window.localStorage;

/* ---------------- 假 PeerJS ---------------- */
const registry = new Map();
let connSeq = 0;

class FakeConn {
  constructor(remoteId) {
    this.id = 'c' + ++connSeq;
    this.peer = remoteId;
    this.open = false;
    this.h = {};
    this.remote = null;
    this.closed = false;
  }
  on(ev, cb) { (this.h[ev] = this.h[ev] || []).push(cb); return this; }
  emit(ev, arg) { for (const cb of this.h[ev] || []) cb(arg); }
  send(msg) {
    if (!this.open) throw new Error('conn is not open');
    const copy = JSON.parse(JSON.stringify(msg));
    const other = this.remote;
    if (other) setTimeout(() => other.emit('data', copy), 0);
  }
  close() {
    if (this.closed) return;
    this.closed = true;
    this.open = false;
    this.emit('close');
    const other = this.remote;
    if (other && !other.closed) setTimeout(() => other.emit('close'), 0);
  }
  _open() { this.open = true; this.emit('open'); }
}

class FakePeer {
  constructor(id) {
    this.id = id || 'auto-' + Math.random().toString(36).slice(2, 8);
    this.h = {};
    if (registry.has(this.id)) {
      setTimeout(() => this.emit('error', { type: 'unavailable-id' }), 0);
      return;
    }
    registry.set(this.id, this);
    setTimeout(() => this.emit('open', this.id), 0);
  }
  on(ev, cb) { (this.h[ev] = this.h[ev] || []).push(cb); return this; }
  emit(ev, arg) { for (const cb of this.h[ev] || []) cb(arg); }
  connect(remoteId) {
    const a = new FakeConn(remoteId);
    const target = registry.get(remoteId);
    if (!target) {
      setTimeout(() => this.emit('error', { type: 'peer-unavailable' }), 0);
      return a;
    }
    const b = new FakeConn(this.id);
    a.remote = b;
    b.remote = a;
    setTimeout(() => {
      target.emit('connection', b);
      b._open();
      a._open();
    }, 0);
    return a;
  }
  destroy() { registry.delete(this.id); }
}

global.Peer = FakePeer;
dom.window.Peer = FakePeer;

const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));
const PROBLEMS = [];
const ok = (c, m) => { if (!c) PROBLEMS.push(m); };
const $ = (id) => document.getElementById(id);
const findBtn = (root, text) =>
  [...root.querySelectorAll('button')].find((x) => x.textContent.includes(text)) || null;

/* ---------------- 载入 main.js ---------------- */
await import(url('js/main.js'));
const rules = await import(url('js/rules.js'));
await tick(10);
ok(!$('scr-home').classList.contains('hidden'), '启动后停在首页');

/* ---------------- 房主建房 ---------------- */
$('in-name').value = '甲';
$('btn-create').click();
await tick(20);
ok(!$('scr-lobby').classList.contains('hidden'), '建房后进入房间页');
const code = $('lobby-code').textContent.trim();
ok(/^[A-Z0-9]{4}$/.test(code), '房号是 4 位，实际：' + code);
const hostId = 'xqcard-' + code.toLowerCase();
ok(registry.has(hostId), '房主已注册信令 id');
ok($('btn-start').disabled, '只有 1 人时不能开始');

/* ---------------- 好友加入 ---------------- */
function joinAs(name) {
  const peer = new FakePeer();
  const conn = peer.connect(hostId);
  const box = { name, peer, conn, seat: null, spectator: false, states: 0, view: null, toasts: [], chats: [], lobby: null };
  conn.on('data', (msg) => {
    if (msg.t === 'joined') {
      box.seat = msg.seat;
      box.spectator = !!msg.spectator;
    } else if (msg.t === 'state') {
      box.states++;
      box.view = msg.view;
    } else if (msg.t === 'lobby') {
      box.lobby = msg;
    } else if (msg.t === 'toast') {
      box.toasts.push(msg.msg);
    } else if (msg.t === 'chat') {
      box.chats.push(msg.msg);
    } else if (msg.t === 'full') {
      box.full = true;
    }
  });
  conn.on('open', () => conn.send({ t: 'hello', name }));
  return box;
}

const foe = joinAs('乙');
await tick(40);
ok(foe.seat === 1, '乙 应该坐 1 号位（黑），实际 ' + foe.seat);
ok(foe.spectator === false, '乙 是玩家不是观众');
ok($('btn-start').disabled === false, '两人齐了可以开始');
ok(document.querySelectorAll('#seat-list .seat-item.filled').length === 2, '大厅显示两个座位');

/* ---------------- 开局 ---------------- */
$('btn-start').click();
await tick(40);
ok(!$('scr-table').classList.contains('hidden'), '开局后进入棋桌');
ok(document.querySelectorAll('#board-grid .piece').length === 32, '棋盘 32 个棋子');
ok(foe.view && foe.view.phase === 'play', '好友收到了开局状态');
ok(foe.view && foe.view.mySide === 'b', '好友执黑');

/* ---------------- 从 DOM 还原棋盘，帮房主落子 ---------------- */
const CHAR2TYPE = { 帅: 'K', 仕: 'A', 相: 'B', 马: 'N', 车: 'R', 炮: 'C', 兵: 'P', 将: 'K', 士: 'A', 象: 'B', 卒: 'P' };

function hostBoard() {
  const b = new Array(90).fill(null);
  for (const el of document.querySelectorAll('#board-grid .piece')) {
    const sq = Number(el.dataset.sq);
    const side = el.classList.contains('r') ? 'r' : 'b';
    b[sq] = side + CHAR2TYPE[el.textContent.trim()];
  }
  return b;
}

function hostTurnSide() {
  const chip = document.querySelector('#t-players .player-chip.active .dot-side');
  if (!chip) return null;
  return chip.classList.contains('r') ? 'r' : 'b';
}

function hostPlayRandom() {
  const side = hostTurnSide();
  if (!side) return false;
  const moves = rules.allLegalMoves(hostBoard(), side);
  if (!moves.length) return false;
  const pick = moves[Math.floor(Math.random() * moves.length)];
  const piece = document.querySelector(`#board-grid .piece[data-sq="${pick.from}"]`);
  if (!piece) return false;
  piece.click();
  const spot = document.querySelector(`#board-grid .hit[data-sq="${pick.to}"], #board-grid .piece[data-sq="${pick.to}"]`);
  if (!spot) return false;
  spot.click();
  return true;
}

function guestPlayRandom(box) {
  const v = box.view;
  if (!v || v.phase !== 'play' || v.turn !== v.mySide) return false;
  const moves = rules.allLegalMoves(v.board, v.mySide);
  if (!moves.length) return false;
  const pick = moves[Math.floor(Math.random() * moves.length)];
  box.conn.send({ t: 'action', a: { type: 'move', from: pick.from, to: pick.to } });
  return true;
}

let plies = 0;
for (let i = 0; i < 14; i++) {
  const side = hostTurnSide();
  if (!side) break;
  if (side === 'r') {
    ok(hostPlayRandom(), '房主能通过点棋子走棋');
  } else {
    ok(guestPlayRandom(foe), '好友能通过协议走棋');
  }
  await tick(8);
  plies++;
}
await tick(20);
ok(plies >= 10, '至少自动走了 10 手，实际 ' + plies);
ok(foe.states >= 10, '好友持续收到状态，实际 ' + foe.states);
ok(document.querySelectorAll('#move-list li').length >= 5, '棋谱里有多手记录');
ok(/炮|马|车|兵|卒|相|象|士|仕|将|帅/.test($('move-list').textContent), '棋谱是中文记谱');

/* ---------------- 悔棋（房主请求，好友同意） ---------------- */
let guard = 0;
while (hostTurnSide() !== 'r' && guard++ < 20) {
  guestPlayRandom(foe);
  await tick(8);
}
const pliesBeforeUndo = foe.view.moves.length;
const undoBtn = findBtn($('actions'), '悔棋');
ok(undoBtn && !undoBtn.disabled, '轮到自己时可以点悔棋');
undoBtn.click();
await tick(30);
ok(foe.view.offers.undo === 0, '好友收到悔棋请求');
ok(/等待对方同意/.test($('offer-bar').textContent), '房主端显示「等待对方同意」');
const agree = findBtn($('offer-bar'), '同意');
if (agree) agree.click();
else foe.conn.send({ t: 'action', a: { type: 'undoReply', accept: true } });
await tick(30);
ok(foe.view.moves.length === pliesBeforeUndo - 2, `悔棋后回退两手：${pliesBeforeUndo} → ${foe.view.moves.length}`);

/* ---------------- 求和（好友发起，房主拒绝） ---------------- */
foe.conn.send({ t: 'action', a: { type: 'draw' } });
await tick(30);
ok(foe.view.offers.draw === 1, '房主端收到求和请求');
ok(/请求和棋/.test($('offer-bar').textContent), '房主界面弹出求和请求条');
const reject = findBtn($('offer-bar'), '拒绝');
ok(!!reject, '有「拒绝」按钮');
reject.click();
await tick(30);
ok(foe.view.offers.draw === null, '拒绝后请求消失');
ok(foe.view.phase === 'play', '拒绝和棋后对局继续');

/* ---------------- 聊天 ---------------- */
foe.conn.send({ t: 'chat', text: '这步走得不错' });
await tick(30);
ok(/这步走得不错/.test($('chat-log').textContent), '房主能看到好友的聊天');
ok(foe.chats.some((m) => m.text === '这步走得不错'), '好友能看到自己发出的消息（房主回显）');

/* ---------------- 观众 ---------------- */
const spec = joinAs('观众丙');
await tick(40);
ok(spec.spectator === true, '第三位自动成为观众');
ok(typeof spec.seat === 'number' && spec.seat >= 2, '观众拿到观战座位号，实际 ' + spec.seat);
ok(spec.view && spec.view.spectator === true, '观众收到观战视角');
ok(spec.view && spec.view.mySide === null, '观众没有执方');
ok(spec.states > 0, '观众也能收到状态');

/* ---------------- 认输 → 结算 → 再来一局 ---------------- */
let resignBtn = findBtn($('actions'), '认输');
ok(!!resignBtn, '有认输按钮');
resignBtn.click();
await tick(5);
resignBtn = findBtn($('actions'), '确定认输');
ok(!!resignBtn, '认输需要二次确认');
resignBtn.click();
await tick(40);
ok(!$('overlay').classList.contains('hidden'), '结束后弹出结算浮层');
ok(/你输了/.test($('overlay-panel').textContent), '房主认输后显示「你输了」（红方认输）');
ok(foe.view.phase === 'over' && foe.view.result.winner === 'b', '好友收到结果：黑方胜');
ok(spec.view.phase === 'over', '观众也收到结果');
const again = findBtn($('overlay-panel'), '再来一局');
ok(!!again, '房主有「再来一局」');
again.click();
await tick(40);
ok(foe.view.phase === 'play', '再来一局后好友回到对局');
ok(foe.view.moves.length === 0, '新一局棋谱清空');
ok(document.querySelectorAll('#board-grid .piece').length === 32, '新一局摆好 32 个棋子');

/* ---------------- 掉线重连 ---------------- */
foe.conn.close();
await tick(30);
const foeBack = joinAs('乙');
await tick(60);
ok(foeBack.seat === 1, '同名重连应该回到 1 号位，实际 ' + foeBack.seat);
ok(foeBack.view && foeBack.view.phase === 'play', '重连后立刻收到当前局面');

/* ---------------- 满员拒绝（2 玩家 + 6 观众） ---------------- */
for (let i = 0; i < 6; i++) joinAs('围观' + i);
await tick(80);
const extra = joinAs('多出来的');
await tick(60);
ok(extra.full === true, '第 9 个人应该被拒绝（房间已满）');

if (PROBLEMS.length) {
  console.error('❌ 端到端测试失败：\n - ' + PROBLEMS.join('\n - '));
  process.exit(1);
}
console.log(
  `✅ 端到端通过：房号 ${code}｜好友入座｜走棋 ${plies} 手｜悔棋｜求和｜聊天｜观战｜认输重开｜掉线重连｜满员拒绝`
);
process.exit(0);
