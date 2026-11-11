// 规则引擎单元测试（零依赖）：node test/rules.test.mjs
import assert from 'node:assert/strict';
import * as R from '../js/rules.js';

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

/** 用 { '行,列': 'rK' } 快速摆棋盘 */
function boardFrom(spec) {
  const b = new Array(90).fill(null);
  for (const [k, v] of Object.entries(spec)) {
    const [r, c] = k.split(',').map(Number);
    b[R.idx(r, c)] = v;
  }
  return b;
}
const sq = (r, c) => R.idx(r, c);

/* ---------------- 棋盘 ---------------- */

t('开局摆子正确', () => {
  const b = R.initialBoard();
  assert.equal(b.length, 90);
  const red = b.filter((p) => p && R.sideOf(p) === 'r').length;
  const black = b.filter((p) => p && R.sideOf(p) === 'b').length;
  assert.equal(red, 16);
  assert.equal(black, 16);
  assert.equal(b[sq(9, 4)], 'rK');
  assert.equal(b[sq(0, 4)], 'bK');
  assert.equal(b[sq(7, 1)], 'rC');
  assert.equal(b[sq(3, 0)], 'bP');
  assert.equal(b[sq(5, 0)], null);
});

t('开局双方各 44 步合法走法', () => {
  const b = R.initialBoard();
  assert.equal(R.allLegalMoves(b, 'r').length, 44);
  assert.equal(R.allLegalMoves(b, 'b').length, 44);
});

/* ---------------- 各兵种走法 ---------------- */

t('车走直线，遇到自己人停下', () => {
  const b = R.initialBoard();
  const from = sq(9, 0); // 红车
  // 纵线上 (7,0) 之后是自家兵 (6,0)，所以只到行 7；横线上右邻是自家的马
  assert.deepEqual(R.legalMoves(b, from).sort((x, y) => x - y), [sq(7, 0), sq(8, 0)].sort((x, y) => x - y));
});

t('马走日，蹩马腿', () => {
  const open = R.initialBoard();
  assert.deepEqual(R.genMoves(open, sq(9, 1)).sort(), [sq(7, 0), sq(7, 2)].sort());
  const blocked = R.initialBoard();
  blocked[sq(8, 1)] = 'bP'; // 别住马腿
  assert.deepEqual(R.genMoves(blocked, sq(9, 1)), []);
});

t('相走田，塞象眼，不过河', () => {
  const b = boardFrom({ '9,4': 'rK', '0,4': 'bK', '9,2': 'rB' });
  assert.deepEqual(R.genMoves(b, sq(9, 2)).sort(), [sq(7, 0), sq(7, 4)].sort());
  const eye = boardFrom({ '9,4': 'rK', '0,4': 'bK', '9,2': 'rB', '8,1': 'rP' });
  assert.deepEqual(R.genMoves(eye, sq(9, 2)), [sq(7, 4)]);
  // 相不能过河：放在行 5 时只能往行 7 走
  const river = boardFrom({ '9,4': 'rK', '0,4': 'bK', '5,2': 'rB' });
  assert.deepEqual(R.genMoves(river, sq(5, 2)).sort(), [sq(7, 0), sq(7, 4)].sort());
});

t('仕走斜线且不出九宫', () => {
  const b = boardFrom({ '9,4': 'rK', '0,3': 'bK', '8,4': 'rA' });
  assert.deepEqual(R.genMoves(b, sq(8, 4)).sort((x, y) => x - y), [sq(7, 3), sq(7, 5), sq(9, 3), sq(9, 5)].sort((x, y) => x - y));
  // 贴着九宫边角时可选点会变少
  const corner = boardFrom({ '9,4': 'rK', '0,3': 'bK', '9,3': 'rA' });
  assert.deepEqual(R.genMoves(corner, sq(9, 3)), [sq(8, 4)]);
});

t('炮走直线、隔山打子', () => {
  const b = R.initialBoard();
  const moves = R.genMoves(b, sq(7, 1));
  // 平走：0 列 + 2..6 列（再往右是自家炮）；向上 6..3 行；隔一个炮架吃 (0,1) 的马；向下到 (8,1)
  assert.ok(moves.includes(sq(7, 0)));
  assert.ok(moves.includes(sq(7, 6)));
  assert.ok(!moves.includes(sq(7, 8)), '越过自家炮不合法');
  assert.ok(moves.includes(sq(6, 1)));
  assert.ok(moves.includes(sq(0, 1)), '隔山吃马');
  assert.ok(!moves.includes(sq(0, 0)), '炮不能平移吃子');
  assert.ok(!moves.includes(sq(9, 1)), '不能吃自己的马');
  assert.equal(moves.length, 12);
});

t('兵/卒：过河前只能直走，过河后可横走', () => {
  const b = boardFrom({ '9,4': 'rK', '0,3': 'bK', '6,2': 'rP', '5,2': 'bP' });
  assert.deepEqual(R.genMoves(b, sq(6, 2)), [sq(5, 2)]);
  // 黑卒在行 5 已经过河，可以横走
  assert.deepEqual(R.genMoves(b, sq(5, 2)).sort((x, y) => x - y), [sq(6, 2), sq(5, 1), sq(5, 3)].sort((x, y) => x - y));
});

/* ---------------- 将军 / 将死 / 困毙 ---------------- */

t('白脸将（双王照面）算被将军', () => {
  const b = boardFrom({ '9,4': 'rK', '0,4': 'bK' });
  assert.equal(R.kingsFacing(b), true);
  assert.equal(R.inCheck(b, 'r'), true);
  assert.equal(R.inCheck(b, 'b'), true);
});

t('不能走成双王照面', () => {
  const b = boardFrom({ '9,4': 'rK', '0,4': 'bK', '5,4': 'rR' });
  const tos = R.legalMoves(b, sq(5, 4));
  assert.ok(!tos.includes(sq(5, 3)), '横向挪开会让两王照面');
  assert.ok(tos.includes(sq(4, 4)), '沿同列走仍然挡着');
});

t('将死判定', () => {
  // 黑将 (0,4) 被 (2,4) 的车将军，(0,3)/(0,5) 被 (2,3)/(2,5) 的车控住，(1,4) 被 (1,0) 的车控住
  const b = boardFrom({
    '0,4': 'bK',
    '2,4': 'rR',
    '2,3': 'rR',
    '2,5': 'rR',
    '1,0': 'rR',
    '9,3': 'rK',
  });
  assert.equal(R.status(b, 'b'), 'checkmate');
});

t('困毙判定（无棋可走但没被将军）', () => {
  const b = boardFrom({
    '0,4': 'bK',
    '2,3': 'rR',
    '2,5': 'rR',
    '2,4': 'rP', // 红兵控住 (1,4)，但没威胁 (0,4)
    '9,3': 'rK',
  });
  assert.equal(R.inCheck(b, 'b'), false);
  assert.equal(R.status(b, 'b'), 'stalemate');
});

t('走子后让自己的将暴露在炮口上是不合法的', () => {
  // 黑炮 (2,4) 隔着红车 (5,4) 打红兵 (7,4)；红车一挪开，炮架就变成红兵、炮口直接对着红帅
  const b = boardFrom({ '9,4': 'rK', '0,0': 'bK', '5,4': 'rR', '7,4': 'rP', '2,4': 'bC' });
  assert.equal(R.inCheck(b, 'r'), false);
  const tos = R.legalMoves(b, sq(5, 4));
  assert.ok(!tos.includes(sq(5, 3)), '横着让开会被炮打将');
  assert.ok(tos.includes(sq(4, 4)), '沿同列移动仍然挡着炮');
  assert.ok(tos.includes(sq(6, 4)), '往前一步也仍然挡着炮');
  assert.ok(!tos.includes(sq(6, 3)), '任何横向移动都会让红帅暴露');
});

/* ---------------- 记谱 ---------------- */

t('中文记谱：炮二平五', () => {
  const b = R.initialBoard();
  assert.equal(R.moveNotation(b, sq(7, 7), sq(7, 4)), '炮二平五');
});

t('中文记谱：马八进七 / 马2进3', () => {
  const b = R.initialBoard();
  assert.equal(R.moveNotation(b, sq(9, 1), sq(7, 2)), '马八进七');
  assert.equal(R.moveNotation(b, sq(0, 1), sq(2, 2)), '马2进3');
});

t('中文记谱：兵七进一 / 卒7进1', () => {
  const b = R.initialBoard();
  assert.equal(R.moveNotation(b, sq(6, 2), sq(5, 2)), '兵七进一');
  assert.equal(R.moveNotation(b, sq(3, 6), sq(4, 6)), '卒7进1');
});

t('中文记谱：车九平八 / 退', () => {
  const b = R.initialBoard();
  assert.equal(R.moveNotation(b, sq(9, 0), sq(9, 1)), '车九平八');
  assert.equal(R.moveNotation(b, sq(9, 0), sq(8, 0)), '车九进一');
  assert.equal(R.moveNotation(b, sq(0, 0), sq(0, 1)), '车1平2');
});

t('中文记谱：同一纵线两个同兵种用前/后', () => {
  const b = boardFrom({ '9,4': 'rK', '0,4': 'bK', '7,0': 'rR', '9,0': 'rR' });
  assert.equal(R.moveNotation(b, sq(7, 0), sq(6, 0)), '前车进一');
  assert.equal(R.moveNotation(b, sq(9, 0), sq(8, 0)), '后车进一');
  const c = boardFrom({ '9,4': 'rK', '0,3': 'bK', '3,0': 'bP', '5,0': 'bP' });
  // 黑方的「前」是更靠近红方（行号更大）的那个
  assert.equal(R.moveNotation(c, sq(5, 0), sq(6, 0)), '前卒进1');
  assert.equal(R.moveNotation(c, sq(3, 0), sq(4, 0)), '后卒进1');
});

t('过河黑卒可以横走（各排都一样）', () => {
  for (const row of [5, 6, 7]) {
    const b = boardFrom({ '0,3': 'bK', '9,4': 'rK', [`${row},4`]: 'bP' });
    const tos = R.legalMoves(b, sq(row, 4)).sort((x, y) => x - y);
    assert.deepEqual(tos, [sq(row + 1, 4), sq(row, 3), sq(row, 5)].sort((x, y) => x - y), `第 ${row} 行横走`);
  }
  const bottom = boardFrom({ '0,3': 'bK', '9,4': 'rK', '8,4': 'bP' });
  assert.deepEqual(R.legalMoves(bottom, sq(8, 4)).sort((x, y) => x - y), [sq(8, 3), sq(8, 5)].sort((x, y) => x - y));
});

t('被「白脸将」牵住的卒横走不了（这是规则，不是 bug）', () => {
  // 两将同在第 4 路，黑卒是唯一挡子：一横走就两将照面
  for (const row of [5, 6, 7]) {
    const b = boardFrom({ '0,4': 'bK', '9,4': 'rK', [`${row},4`]: 'bP' });
    assert.deepEqual(R.legalMoves(b, sq(row, 4)), [sq(row + 1, 4)], `第 ${row} 行只能直进`);
  }
  // 到底线时连直进都不行（直前是红帅，吃将不合法 + 横走会照面）→ 一步都走不了
  const b = boardFrom({ '0,4': 'bK', '9,4': 'rK', '8,4': 'bP' });
  assert.deepEqual(R.legalMoves(b, sq(8, 4)), []);
});

t('blockedReason：区分「没得走」和「被牵制」', () => {
  const stuck = boardFrom({ '0,4': 'bK', '9,3': 'rK', '9,0': 'bP', '9,1': 'bP' });
  assert.deepEqual(R.genMoves(stuck, sq(9, 0)), [], '底线黑卒被自家卒堵住');
  assert.equal(R.blockedReason(stuck, sq(9, 0)), 'static');

  const pinned = boardFrom({ '0,4': 'bK', '9,4': 'rK', '8,4': 'bP' });
  assert.ok(R.genMoves(pinned, sq(8, 4)).length > 0, '有伪合法走法');
  assert.equal(R.legalMoves(pinned, sq(8, 4)).length, 0);
  assert.equal(R.blockedReason(pinned, sq(8, 4)), 'pinned');

  const free = boardFrom({ '0,3': 'bK', '9,4': 'rK', '6,4': 'bP' });
  assert.equal(R.blockedReason(free, sq(6, 4)), 'free');
});

t('applyMove 不修改原棋盘', () => {
  const b = R.initialBoard();
  const snapshot = b.join(',');
  const { board, captured } = R.applyMove(b, sq(6, 0), sq(5, 0));
  assert.equal(b.join(','), snapshot);
  assert.equal(board[sq(5, 0)], 'rP');
  assert.equal(board[sq(6, 0)], null);
  assert.equal(captured, null);
});

console.log(`✅ 规则引擎通过 ${passed} 项`);
