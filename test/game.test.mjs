// 对局状态机测试（零依赖）：node test/game.test.mjs
import assert from 'node:assert/strict';
import * as R from '../js/rules.js';
import { Game, PHASE, sideOfSeat, seatOfSide } from '../js/game.js';

let passed = 0;
const t = (name, fn) => {
  try {
    fn();
    passed++;
  } catch (e) {
    console.error('❌ ' + name);
    throw e;
  }
};
const sq = (r, c) => R.idx(r, c);

function boardFrom(spec) {
  const b = new Array(90).fill(null);
  for (const [k, v] of Object.entries(spec)) {
    const [r, c] = k.split(',').map(Number);
    b[R.idx(r, c)] = v;
  }
  return b;
}

/** 直接摆一个局面（测试专用，绕开发牌） */
function setup(spec, turn = 'r') {
  const g = new Game([{ name: '甲' }, { name: '乙' }]);
  g.start();
  g.board = boardFrom(spec);
  g.turn = turn;
  g.history = [];
  g.lastMove = null;
  g.inCheck = R.inCheck(g.board, turn) ? turn : null;
  return g;
}

/** 固定种子的伪随机 */
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let x = Math.imul(a ^ (a >>> 15), 1 | a);
    x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x;
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
}

/* ---------------- 开局 ---------------- */

t('开局：红方先行，两方视角正确', () => {
  const g = new Game([{ name: '甲' }, { name: '乙' }]);
  assert.equal(g.phase, PHASE.LOBBY);
  g.start();
  assert.equal(g.phase, PHASE.PLAY);
  assert.equal(g.turn, 'r');
  assert.equal(sideOfSeat(0), 'r');
  assert.equal(seatOfSide('b'), 1);
  const v0 = g.view(0);
  const v1 = g.view(1);
  const vs = g.view(-1);
  assert.equal(v0.mySide, 'r');
  assert.equal(v1.mySide, 'b');
  assert.equal(v0.spectator, false);
  assert.equal(vs.spectator, true);
  assert.equal(vs.mySide, null);
  assert.equal(v0.board.length, 90);
  assert.deepEqual(v0.moves, []);
  assert.equal(v0.players.length, 2);
  assert.equal(v0.round, 1);
});

/* ---------------- 走棋 ---------------- */

t('走棋：轮到谁、记谱、轮转', () => {
  const g = new Game([{ name: '甲' }, { name: '乙' }]).start();
  const r = g.move(0, sq(7, 7), sq(7, 4));
  assert.equal(r.notation, '炮二平五');
  assert.equal(g.turn, 'b');
  assert.equal(g.history.length, 1);
  assert.deepEqual(g.lastMove, { from: sq(7, 7), to: sq(7, 4) });
  assert.equal(g.board[sq(7, 4)], 'rC');
  assert.equal(g.board[sq(7, 7)], null);
  const r2 = g.move(1, sq(0, 1), sq(2, 2));
  assert.equal(r2.notation, '马2进3');
  assert.equal(g.turn, 'r');
  assert.equal(g.view(0).moves.length, 2);
  assert.equal(g.view(0).moves[0].notation, '炮二平五');
});

t('非法操作一律报错', () => {
  const g = new Game([{ name: '甲' }, { name: '乙' }]).start();
  assert.throws(() => g.move(1, sq(0, 1), sq(2, 2)), /还没轮到你/);
  assert.throws(() => g.move(0, sq(0, 1), sq(2, 2)), /不是你的棋子/);
  assert.throws(() => g.move(0, sq(9, 0), sq(5, 0)), /不能这么走/);
  assert.throws(() => g.move(0, sq(5, 5), sq(5, 4)), /没有棋子/);
  assert.throws(() => g.move(-1, sq(9, 0), sq(8, 0)), /观战不能走棋/);
  assert.throws(() => g.move(0, NaN, 3), /走法无效/);
});

t('吃子会记在棋谱与吃子列表里', () => {
  const g = setup({
    '9,4': 'rK',
    '0,3': 'bK',
    '5,0': 'rR',
    '5,6': 'bP',
  });
  g.move(0, sq(5, 0), sq(5, 6));
  const v = g.view(0);
  assert.equal(v.moves[0].captured, 'bP');
  assert.deepEqual(v.captured.r, ['bP']);
  assert.equal(v.board[sq(5, 6)], 'rR');
});

t('将军会被标出来', () => {
  const g = setup({ '9,4': 'rK', '0,3': 'bK', '5,0': 'rR', '5,3': 'rR' });
  // 车平到 3 列并不将军，先把黑将暴露在 0 列车的纵线上
  const g2 = setup({ '9,4': 'rK', '0,3': 'bK', '2,0': 'rR', '1,1': 'bP' });
  const r = g2.move(0, sq(2, 0), sq(0, 0));
  assert.equal(r.check, true);
  assert.equal(g2.view(0).inCheck, 'b');
  void g;
});

/* ---------------- 将死 / 认输 / 和棋 ---------------- */

t('将死结束对局', () => {
  // 黑将已被 (2,4) 的车将军、退路也被控住，红方随便走一步「闲着」，黑方就被将死
  const g = setup({
    '0,4': 'bK',
    '2,4': 'rR',
    '2,3': 'rR',
    '2,5': 'rR',
    '1,0': 'rR',
    '9,3': 'rK',
    '6,8': 'rP',
  });
  const r = g.move(0, sq(6, 8), sq(5, 8));
  assert.equal(r.over, true);
  assert.equal(g.phase, PHASE.OVER);
  assert.equal(g.result.winner, 'r');
  assert.equal(g.result.reason, 'checkmate');
  assert.match(g.result.text, /红方胜/);
  // 结束后不能再走
  assert.throws(() => g.move(1, sq(0, 4), sq(0, 3)), /已经结束/);
});

t('困毙也算输', () => {
  const g = setup(
    {
      '0,4': 'bK',
      '2,3': 'rR',
      '2,5': 'rR',
      '2,4': 'rP',
      '9,3': 'rK',
      '6,8': 'rP',
    },
    'r'
  );
  const r = g.move(0, sq(6, 8), sq(5, 8));
  assert.equal(r.over, true);
  assert.equal(g.result.reason, 'stalemate');
  assert.equal(g.result.winner, 'r');
});

t('认输与和棋', () => {
  const g = new Game([{ name: '甲' }, { name: '乙' }]).start();
  g.resign(1);
  assert.equal(g.phase, PHASE.OVER);
  assert.equal(g.result.winner, 'r');
  assert.equal(g.result.reason, 'resign');
  assert.throws(() => g.resign(0), /已经结束/);

  const g2 = new Game([{ name: '甲' }, { name: '乙' }]).start();
  g2.offerDraw(0);
  assert.equal(g2.view(1).offers.draw, 0);
  assert.throws(() => g2.replyDraw(0, true), /不能自己答应自己/);
  const r = g2.replyDraw(1, true);
  assert.equal(r.accepted, true);
  assert.equal(g2.phase, PHASE.OVER);
  assert.equal(g2.result.winner, null);
  assert.equal(g2.result.reason, 'draw');

  const g3 = new Game([{ name: '甲' }, { name: '乙' }]).start();
  g3.offerDraw(1);
  const r3 = g3.replyDraw(0, false);
  assert.equal(r3.accepted, false);
  assert.equal(g3.phase, PHASE.PLAY);
  assert.equal(g3.view(0).offers.draw, null);
});

t('有未答复的请求时不能继续走棋', () => {
  const g = new Game([{ name: '甲' }, { name: '乙' }]).start();
  g.move(0, sq(7, 7), sq(7, 4));
  g.offerDraw(1);
  assert.throws(() => g.move(1, sq(0, 1), sq(2, 2)), /悔棋 \/ 求和/);
  g.replyDraw(0, false);
  g.move(1, sq(0, 1), sq(2, 2));
  assert.equal(g.history.length, 2);
});

/* ---------------- 悔棋 ---------------- */

t('悔棋需要对方同意，撤销到自己上一步之前', () => {
  const g = new Game([{ name: '甲' }, { name: '乙' }]).start();
  g.move(0, sq(7, 7), sq(7, 4)); // 炮二平五
  g.move(1, sq(0, 1), sq(2, 2)); // 马2进3
  assert.equal(g.turn, 'r');
  assert.equal(g.view(0).canUndo, true);
  g.requestUndo(0);
  assert.equal(g.view(0).offers.undo, 0);
  assert.throws(() => g.move(0, sq(9, 1), sq(7, 2)), /悔棋/);
  const r = g.replyUndo(1, true);
  assert.equal(r.accepted, true);
  assert.equal(r.popped, 2);
  assert.equal(g.history.length, 0);
  assert.equal(g.turn, 'r');
  assert.equal(g.board[sq(7, 7)], 'rC');
  assert.equal(g.board[sq(0, 1)], 'bN');
  assert.equal(g.view(0).offers.undo, null);
});

t('拒绝悔棋则局面不变', () => {
  const g = new Game([{ name: '甲' }, { name: '乙' }]).start();
  g.move(0, sq(7, 7), sq(7, 4));
  g.move(1, sq(0, 1), sq(2, 2));
  g.requestUndo(0);
  const before = g.board.join(',');
  g.replyUndo(1, false);
  assert.equal(g.board.join(','), before);
  assert.equal(g.history.length, 2);
});

t('刚走完就能悔棋，只回退自己那一手', () => {
  const g = new Game([{ name: '甲' }, { name: '乙' }]).start();
  g.move(0, sq(7, 7), sq(7, 4)); // 红走完，轮到黑
  assert.equal(g.view(0).canUndo, true, '刚走完（轮到对方）也能申请悔棋');
  g.requestUndo(0);
  const r = g.replyUndo(1, true);
  assert.equal(r.popped, 1, '对方还没应招，只回退 1 手');
  assert.equal(g.history.length, 0);
  assert.equal(g.turn, 'r');
  assert.equal(g.board.join(','), R.initialBoard().join(','));
});

t('对方已应招时悔棋回退两手，回到自己走棋之前', () => {
  const g = new Game([{ name: '甲' }, { name: '乙' }]).start();
  g.move(0, sq(7, 7), sq(7, 4)); // 红
  g.move(1, sq(0, 1), sq(2, 2)); // 黑
  g.requestUndo(0);
  const r = g.replyUndo(1, true);
  assert.equal(r.popped, 2);
  assert.equal(g.history.length, 0);
  assert.equal(g.turn, 'r');
});

t('黑方刚走完也能悔棋，回退的是黑方自己那一手', () => {
  const g = new Game([{ name: '甲' }, { name: '乙' }]).start();
  g.move(0, sq(7, 7), sq(7, 4));
  g.move(1, sq(0, 1), sq(2, 2)); // 黑走完，轮到红
  g.requestUndo(1);
  const r = g.replyUndo(0, true);
  assert.equal(r.popped, 1);
  assert.equal(g.history.length, 1, '红方那一手保留');
  assert.equal(g.turn, 'b');
  assert.equal(g.board[sq(0, 1)], 'bN', '黑马回到原位');
  assert.equal(g.board[sq(7, 4)], 'rC', '红炮仍在');
});

t('没走过棋的一方不能请求悔棋', () => {
  const g = new Game([{ name: '甲' }, { name: '乙' }]).start();
  assert.equal(g.view(1).canUndo, false, '开局谁都没走过，不能悔棋');
  assert.throws(() => g.requestUndo(1), /没有可悔的/);
  g.move(0, sq(7, 7), sq(7, 4));
  assert.throws(() => g.requestUndo(1), /没有可悔的/, '黑方还没走过棋');
  assert.equal(g.view(0).canUndo, true);
});

t('观战不能请求悔棋 / 认输 / 和棋', () => {
  const g = new Game([{ name: '甲' }, { name: '乙' }]).start();
  g.move(0, sq(7, 7), sq(7, 4));
  assert.throws(() => g.requestUndo(-1), /观战不能悔棋/);
  assert.throws(() => g.offerDraw(-1), /观战不能求和/);
  assert.throws(() => g.resign(-1), /观战不能认输/);
});

/* ---------------- 再来一局 ---------------- */

t('再开一局会清空棋谱和结果', () => {
  const g = new Game([{ name: '甲' }, { name: '乙' }]).start();
  g.move(0, sq(7, 7), sq(7, 4));
  g.resign(1);
  assert.equal(g.phase, PHASE.OVER);
  g.start();
  assert.equal(g.phase, PHASE.PLAY);
  assert.equal(g.turn, 'r');
  assert.equal(g.history.length, 0);
  assert.equal(g.result, null);
  assert.equal(g.round, 2);
  assert.equal(g.board.join(','), R.initialBoard().join(','));
});

/* ---------------- 随机对局不变量 ---------------- */

t('随机走 5 局 × 200 手，状态始终自洽', () => {
  const rand = rng(20261031);
  for (let gi = 0; gi < 5; gi++) {
    const g = new Game([{ name: '甲' }, { name: '乙' }]).start();
    for (let ply = 0; ply < 200 && g.phase === PHASE.PLAY; ply++) {
      const moves = R.allLegalMoves(g.board, g.turn);
      assert.ok(moves.length > 0, '还能走的时候不该没有合法走法');
      for (const m of moves) {
        assert.ok(Number.isInteger(m.from) && Number.isInteger(m.to), '走法下标合法');
        assert.ok(R.sideOf(g.board[m.from]) === g.turn, '只能动自己那一方');
      }
      const pick = moves[Math.floor(rand() * moves.length)];
      const seat = seatOfSide(g.turn);
      const before = g.turn;
      g.action(seat, { type: 'move', from: pick.from, to: pick.to });
      assert.equal(g.board.length, 90, '棋盘大小不变');
      assert.ok(g.board.includes('rK'), '红帅还在');
      assert.ok(g.board.includes('bK'), '黑将还在');
      assert.equal(g.history.length, ply + 1, '棋谱条数 = 手数');
      if (g.phase === PHASE.PLAY) assert.notEqual(g.turn, before, '走完轮换先手');
      assert.equal(g.view(0).moves.length, g.history.length);
    }
    for (const mv of g.view(-1).moves) {
      assert.equal(typeof mv.notation, 'string');
      assert.ok(mv.notation.length >= 3, '每手都有中文记谱：' + mv.notation);
    }
  }
});

t('视图不含任何隐藏信息（象棋本来就是明棋）', () => {
  const g = new Game([{ name: '甲' }, { name: '乙' }]).start();
  g.move(0, sq(7, 7), sq(7, 4));
  const a = g.view(0);
  const b = g.view(1);
  const c = g.view(-1);
  assert.equal(a.board.join(','), b.board.join(','));
  assert.equal(a.board.join(','), c.board.join(','));
  assert.equal(a.seat, 0);
  assert.equal(b.seat, 1);
  assert.equal(c.seat, -1);
  assert.equal(JSON.stringify(a).includes('"hidden"'), false);
});

console.log(`✅ 对局状态机通过 ${passed} 项`);
