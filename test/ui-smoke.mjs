// UI 冒烟测试（需要 jsdom）：把一局棋完全通过「点棋子、点按钮」跑起来
// 运行：npm install && npm run test:ui
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

const R = await import(url('js/rules.js'));
const { Game } = await import(url('js/game.js'));
const UI = await import(url('js/ui.js'));

const problems = [];
const ok = (cond, msg) => { if (!cond) problems.push(msg); };
const $ = (id) => document.getElementById(id);
const sq = (r, c) => R.idx(r, c);

UI.bindUI();

/* ---------------- 首页 / 大厅 ---------------- */

UI.showScreen('home');
ok(!$('scr-home').classList.contains('hidden'), '首页应可见');
ok($('scr-table').classList.contains('hidden'), '棋桌应隐藏');

UI.renderLobby({
  code: 'AB12',
  players: [{ name: '甲', connected: true }, { name: null, connected: false }],
  spectators: [],
  isHost: true,
  canStart: false,
  tip: '测试',
});
ok($('lobby-code').textContent === 'AB12', '房号显示正确');
ok(document.querySelectorAll('#seat-list li').length === 2, '座位列表 2 项（红/黑）');
ok($('btn-start').disabled === true, '人不齐时开始按钮禁用');
ok(/等待对手入座（1\/2）/.test($('btn-start').textContent), '开始按钮显示人数进度');

UI.renderLobby({
  code: 'AB12',
  players: [{ name: '甲', connected: true }, { name: '乙', connected: true }],
  spectators: ['旁观者'],
  isHost: true,
  canStart: true,
  tip: '',
});
ok($('btn-start').disabled === false, '两人齐了可以开始');
ok(/旁观者/.test($('lobby-spec').textContent), '观战名单显示');

/* ---------------- 棋桌：开局与选择 ---------------- */

let pending = null;
const g = new Game([{ name: '甲' }, { name: '乙' }]).start();
function render(seat = 0, game = g) {
  const v = game.view(seat);
  v._code = 'AB12';
  v._isHost = seat === 0;
  v._spectators = [];
  pending = null;
  UI.renderTable(v, (act) => { pending = act; });
  return v;
}

render(0);
ok(!$('scr-table').classList.contains('hidden'), '渲染后进入棋桌');
ok(document.querySelectorAll('#board-grid .piece').length === 32, '开局 32 个棋子');
ok(document.querySelectorAll('#board-grid svg.lines line').length > 40, '棋盘线已绘制');
ok(/轮到你走棋/.test($('actions').textContent), '红方先走，提示轮到走棋');
ok(document.querySelectorAll('#board-grid .marker').length === 0, '还没选子时没有落点提示');
ok(/红方先行/.test($('move-list').textContent), '开始时棋谱有提示');

// 点红炮，出现落点提示
const cannon = document.querySelector(`#board-grid .piece[data-sq="${sq(7, 7)}"]`);
ok(!!cannon, '找到红方炮');
ok(cannon && cannon.classList.contains('mine'), '轮到自己时自己的子可点');
cannon.click();
const dots = document.querySelectorAll('#board-grid .marker.dot');
ok(dots.length > 5, '点炮后出现若干可落点，实际 ' + dots.length);
ok(!!document.querySelector(`#board-grid .piece[data-sq="${sq(7, 7)}"].selected`), '选中的子有高亮');

// 点落点 → 触发出棋动作
const target = document.querySelector(`#board-grid .marker[data-sq="${sq(7, 4)}"]`);
ok(!!target, '炮二平五的落点存在');
target.click();
ok(pending && pending.type === 'move', '点落点会发出 move 动作');
ok(pending && pending.from === sq(7, 7) && pending.to === sq(7, 4), '动作坐标正确');

// 走完这一步再渲染
g.action(0, pending);
render(0);
ok(/炮二平五/.test($('move-list').textContent), '棋谱出现「炮二平五」');
ok(document.querySelectorAll('#board-grid .marker.last').length === 2, '上一步两端有标记');
ok(/等待 乙 走棋/.test($('actions').textContent), '轮到对手时提示等待');

// 对手视角：不能选自己的子以外的子
render(1);
ok(/轮到你走棋（黑方）/.test($('actions').textContent), '黑方视角轮到走棋');
const redPiece = document.querySelector(`#board-grid .piece[data-sq="${sq(7, 4)}"]`);
ok(redPiece && !redPiece.classList.contains('mine'), '对手的子不可点');
redPiece.click();
ok(document.querySelectorAll('#board-grid .marker.dot').length === 0, '点对手的子不会出现落点');

// 观众视角
const vs = render(-1);
ok(vs.spectator === true, 'view 标记为观战');
ok(/观战中/.test($('actions').textContent), '观战提示');
const anyPiece = document.querySelector(`#board-grid .piece[data-sq="${sq(9, 4)}"]`);
anyPiece.click();
ok(/观战中/.test($('toast').textContent), '观战点棋会提示只能看棋');
ok(document.querySelectorAll('#board-grid .marker.dot').length === 0, '观战不会出现落点');

/* ---------------- 将军横幅 ---------------- */

const g2 = new Game([{ name: 'A' }, { name: 'B' }]).start();
g2.board = new Array(90).fill(null);
g2.board[sq(9, 4)] = 'rK';
g2.board[sq(0, 3)] = 'bK';
g2.board[sq(2, 0)] = 'rR';
g2.board[sq(1, 1)] = 'bP';
g2.move(0, sq(2, 0), sq(0, 0));
const v2 = g2.view(1);
v2._code = 'C1';
v2._isHost = false;
UI.renderTable(v2, () => {});
ok(!$('check-banner').classList.contains('hidden'), '被将军时显示横幅');
ok(/将军/.test($('check-banner').textContent), '横幅文案含「将军」');
ok(!!document.querySelector('#board-grid .piece.in-check'), '被将军的老将有高亮');

/* ---------------- 请求条（悔棋 / 求和） ---------------- */

const g3 = new Game([{ name: 'A' }, { name: 'B' }]).start();
g3.move(0, sq(7, 7), sq(7, 4));
g3.move(1, sq(0, 1), sq(2, 2));
g3.requestUndo(0);
const v3 = g3.view(1);
v3._code = 'D1';
v3._isHost = false;
pending = null;
UI.renderTable(v3, (act) => { pending = act; });
ok(!$('offer-bar').classList.contains('hidden'), '对方请求悔棋时出现请求条');
ok(/请求悔棋/.test($('offer-bar').textContent), '请求条文案正确');
const agree = [...$('offer-bar').querySelectorAll('button')].find((b) => b.textContent === '同意');
ok(!!agree, '有「同意」按钮');
agree.click();
ok(pending && pending.type === 'undoReply' && pending.accept === true, '同意按钮发出 undoReply');

const v3b = g3.view(0);
v3b._code = 'D1';
UI.renderTable(v3b, () => {});
ok(/等待对方同意/.test($('offer-bar').textContent), '请求方看到等待提示');

/* ---------------- 聊天 ---------------- */

const sent = [];
UI.setChatSender((text) => sent.push(text));
UI.renderChat(
  [
    { kind: 'sys', text: '甲 加入了房间' },
    { kind: 'say', name: '甲', text: '你好' },
    { kind: 'say', name: '我', text: '吃！' },
  ],
  '我'
);
ok(document.querySelectorAll('#chat-log .msg').length === 3, '聊天显示 3 条');
ok(document.querySelector('#chat-log .msg.sys') !== null, '系统消息样式独立');
ok(document.querySelector('#chat-log .msg.me') !== null, '自己的消息靠右');
$('chat-input').value = '将军！';
$('chat-form').dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true }));
ok(sent[0] === '将军！', '表单提交触发发送回调');
const quickBtn = document.querySelector('#quick button');
ok(!!quickBtn, '有快捷语按钮');
quickBtn.click();
ok(sent.length === 2, '快捷语也能发送');

/* ---------------- 结算浮层 ---------------- */

g3.resign(1);
const v4 = g3.view(0);
v4._code = 'D1';
v4._isHost = true;
UI.renderTable(v4, (act) => { pending = act; });
ok(!$('overlay').classList.contains('hidden'), '结束后出现结算浮层');
ok(/你赢了/.test($('overlay-panel').textContent), '房主视角显示「你赢了」');
const again = [...$('overlay-panel').querySelectorAll('button')].find((b) => b.textContent.includes('再来一局'));
ok(!!again, '房主有「再来一局」');
again.click();
ok(pending && pending.type === 'restart', '再来一局发出 restart');

const v5 = g3.view(1);
v5._code = 'D1';
v5._isHost = false;
UI.renderTable(v5, () => {});
ok(/你输了/.test($('overlay-panel').textContent), '对手视角显示「你输了」');
ok(/等待房主/.test($('overlay-panel').textContent), '对手只能等房主开新局');

/* ---------------- 整局模拟：随机走到底 ---------------- */

const g6 = new Game([{ name: 'A' }, { name: 'B' }]).start();
let guard = 0;
while (g6.phase === 'play' && guard++ < 400) {  const v = render(g6.turn === 'r' ? 0 : 1, g6);
  const moves = R.allLegalMoves(v.board, v.mySide);
  const pick = moves[Math.floor(Math.random() * moves.length)];
  const piece = document.querySelector(`#board-grid .piece[data-sq="${pick.from}"]`);
  ok(!!piece, '找到要走的棋子');
  piece.click();
  const spot = document.querySelector(`#board-grid .marker[data-sq="${pick.to}"]`);
  ok(!!spot, '找到落点提示');
  spot.click();
  ok(pending && pending.type === 'move', '点落点发出 move');
  g6.action(v.seat, pending);
}
ok(g6.history.length > 20, '随机点棋子点了 20 手以上，实际 ' + g6.history.length);
ok(document.querySelectorAll('#move-list li').length > 1, '棋谱有多手记录');
if (g6.phase === 'over') {
  const vv = g6.view(0);
  vv._code = 'E1';
  vv._isHost = true;
  UI.renderTable(vv, () => {});
  ok(!$('overlay').classList.contains('hidden'), '对局结束后显示结算');
}

if (problems.length) {
  console.error('❌ UI 冒烟测试失败：\n - ' + problems.join('\n - '));
  process.exit(1);
}
console.log(`✅ UI 冒烟测试通过（模拟 ${guard} 步对局、聊天 ${sent.length} 条）`);
