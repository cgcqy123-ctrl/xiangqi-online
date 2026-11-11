// 中国象棋规则引擎：棋盘表示 / 走子生成 / 将军判定 / 将死困毙 / 中文记谱
// 纯函数、零依赖，浏览器和 Node 都能直接跑（不碰 DOM、不碰网络）。
//
// 棋盘：10 行 × 9 列，行 0 = 黑方底线（上方），行 9 = 红方底线（下方）。
// 一维数组 board[row * 9 + col]，元素是棋子编码字符串或 null。
// 棋子编码：side + type，例如 'rK' = 红帅、'bP' = 黑卒。

export const ROWS = 10;
export const COLS = 9;
export const RED = 'r';
export const BLACK = 'b';

/** 开局摆子 */
export const START = [
  'bR', 'bN', 'bB', 'bA', 'bK', 'bA', 'bB', 'bN', 'bR',
  null, null, null, null, null, null, null, null, null,
  null, 'bC', null, null, null, null, null, 'bC', null,
  'bP', null, 'bP', null, 'bP', null, 'bP', null, 'bP',
  null, null, null, null, null, null, null, null, null,
  null, null, null, null, null, null, null, null, null,
  'rP', null, 'rP', null, 'rP', null, 'rP', null, 'rP',
  null, 'rC', null, null, null, null, null, 'rC', null,
  null, null, null, null, null, null, null, null, null,
  'rR', 'rN', 'rB', 'rA', 'rK', 'rA', 'rB', 'rN', 'rR',
];

/** 棋子中文名 */
export const NAME = {
  r: { K: '帅', A: '仕', B: '相', N: '马', R: '车', C: '炮', P: '兵' },
  b: { K: '将', A: '士', B: '象', N: '马', R: '车', C: '炮', P: '卒' },
};

export const SIDE_NAME = { r: '红', b: '黑' };
export const CN = ['一', '二', '三', '四', '五', '六', '七', '八', '九'];
const ORTH = [[0, 1], [0, -1], [1, 0], [-1, 0]];

/* ---------------- 基础工具 ---------------- */

export const idx = (r, c) => r * COLS + c;
export const rowOf = (i) => Math.floor(i / COLS);
export const colOf = (i) => i % COLS;
export const inBoard = (r, c) => r >= 0 && r < ROWS && c >= 0 && c < COLS;
export const sideOf = (pc) => (pc ? pc[0] : '');
export const typeOf = (pc) => (pc ? pc[1] : '');
export const other = (side) => (side === RED ? BLACK : RED);

/** 是否在自己这半边（红：行 5-9，黑：行 0-4） */
export const ownHalf = (side, row) => (side === RED ? row >= 5 : row <= 4);
/** 是否在九宫内 */
export const inPalace = (side, row, col) =>
  col >= 3 && col <= 5 && (side === RED ? row >= 7 && row <= 9 : row >= 0 && row <= 2);

export function initialBoard() {
  return START.slice();
}

export function cloneBoard(board) {
  return board.slice();
}

/** 文本坐标，例如 'h3'（a..i 自左向右，1..10 自上向下），用于兜底展示 */
export function toCoord(i) {
  return String.fromCharCode(97 + colOf(i)) + (ROWS - rowOf(i));
}

/* ---------------- 走子生成（伪合法） ---------------- */

/**
 * 生成某格棋子的伪合法走法（不检查走完之后自己是否被将）。
 * @returns {number[]} 目标格下标
 */
export function genMoves(board, from) {
  const pc = board[from];
  if (!pc) return [];
  const side = sideOf(pc);
  const type = typeOf(pc);
  const r = rowOf(from);
  const c = colOf(from);
  const out = [];

  // 加入目标格；返回 true 表示该方向还能继续走（射线用）
  const add = (rr, cc) => {
    if (!inBoard(rr, cc)) return false;
    const to = idx(rr, cc);
    const q = board[to];
    if (q && sideOf(q) === side) return false;
    out.push(to);
    return !q;
  };

  switch (type) {
    case 'K': // 帅/将：宫内一步直行
      for (const [dr, dc] of ORTH) {
        const rr = r + dr;
        const cc = c + dc;
        if (inPalace(side, rr, cc)) add(rr, cc);
      }
      break;

    case 'A': // 仕/士：宫内一步斜行
      for (const [dr, dc] of [[1, 1], [1, -1], [-1, 1], [-1, -1]]) {
        const rr = r + dr;
        const cc = c + dc;
        if (inPalace(side, rr, cc)) add(rr, cc);
      }
      break;

    case 'B': // 相/象：田字，塞象眼，不过河
      for (const [dr, dc] of [[2, 2], [2, -2], [-2, 2], [-2, -2]]) {
        const rr = r + dr;
        const cc = c + dc;
        if (!inBoard(rr, cc)) continue;
        if (!ownHalf(side, rr)) continue;
        if (board[idx(r + dr / 2, c + dc / 2)]) continue;
        add(rr, cc);
      }
      break;

    case 'N': // 马：日字，蹩马腿
      for (const [dr, dc] of [[2, 1], [2, -1], [-2, 1], [-2, -1], [1, 2], [1, -2], [-1, 2], [-1, -2]]) {
        const rr = r + dr;
        const cc = c + dc;
        if (!inBoard(rr, cc)) continue;
        const lr = r + (Math.abs(dr) === 2 ? dr / 2 : 0);
        const lc = c + (Math.abs(dc) === 2 ? dc / 2 : 0);
        if (board[idx(lr, lc)]) continue;
        add(rr, cc);
      }
      break;

    case 'R': // 车：直线到底
      for (const [dr, dc] of ORTH) {
        let rr = r + dr;
        let cc = c + dc;
        while (inBoard(rr, cc) && add(rr, cc)) {
          rr += dr;
          cc += dc;
        }
      }
      break;

    case 'C': // 炮：走同车，吃子必须隔一个炮架
      for (const [dr, dc] of ORTH) {
        let rr = r + dr;
        let cc = c + dc;
        let screen = false;
        while (inBoard(rr, cc)) {
          const q = board[idx(rr, cc)];
          if (!screen) {
            if (!q) out.push(idx(rr, cc));
            else screen = true;
          } else if (q) {
            if (sideOf(q) !== side) out.push(idx(rr, cc));
            break;
          }
          rr += dr;
          cc += dc;
        }
      }
      break;

    case 'P': { // 兵/卒：向前一步，过河后可横走
      const dr = side === RED ? -1 : 1;
      add(r + dr, c);
      if (!ownHalf(side, r)) {
        add(r, c - 1);
        add(r, c + 1);
      }
      break;
    }

    default:
      break;
  }
  return out;
}

/* ---------------- 将军 / 合法性 ---------------- */

export function findKing(board, side) {
  const code = side + 'K';
  for (let i = 0; i < ROWS * COLS; i++) if (board[i] === code) return i;
  return -1;
}

/** 双王照面（白脸将）：两帅/将同列且中间无棋子 */
export function kingsFacing(board) {
  const a = findKing(board, RED);
  const b = findKing(board, BLACK);
  if (a < 0 || b < 0) return false;
  if (colOf(a) !== colOf(b)) return false;
  const col = colOf(a);
  const lo = Math.min(rowOf(a), rowOf(b));
  const hi = Math.max(rowOf(a), rowOf(b));
  for (let r = lo + 1; r < hi; r++) if (board[idx(r, col)]) return false;
  return true;
}

/** sq 是否被 bySide 任意棋子攻击 */
export function attacked(board, sq, bySide) {
  for (let i = 0; i < ROWS * COLS; i++) {
    const pc = board[i];
    if (!pc || sideOf(pc) !== bySide) continue;
    if (genMoves(board, i).includes(sq)) return true;
  }
  return false;
}

/** side 是否被将军（含白脸将） */
export function inCheck(board, side) {
  const k = findKing(board, side);
  if (k < 0) return true;
  if (kingsFacing(board)) return true;
  return attacked(board, k, other(side));
}

/** 落子后的新棋盘（不修改原棋盘） */
export function applyMove(board, from, to) {
  const piece = board[from];
  const captured = board[to] || null;
  const next = board.slice();
  next[to] = piece;
  next[from] = null;
  return { board: next, piece, captured };
}

/** 合法走法：过滤掉会让自己被将军（含照面）的走法 */
export function legalMoves(board, from) {
  const pc = board[from];
  if (!pc) return [];
  const side = sideOf(pc);
  const enemyKing = other(side) + 'K';
  return genMoves(board, from).filter((to) => {
    if (board[to] === enemyKing) return false; // 不会真去吃老将
    const { board: next } = applyMove(board, from, to);
    return !inCheck(next, side);
  });
}

/** 某一方的全部合法走法：{ from, to }[] */
export function allLegalMoves(board, side) {
  const out = [];
  for (let i = 0; i < ROWS * COLS; i++) {
    const pc = board[i];
    if (!pc || sideOf(pc) !== side) continue;
    for (const to of legalMoves(board, i)) out.push({ from: i, to });
  }
  return out;
}

/**
 * 这个子为什么走不动，用于界面上给人解释：
 *   'free'   —— 有棋可走
 *   'static' —— 本身没有可走的点（被自己人堵住 / 兵到底线等）
 *   'pinned' —— 有走法但全都不能走：动了会让自己的将帅被将军或两将照面（牵制）
 */
export function blockedReason(board, from) {
  const pc = board[from];
  if (!pc) return 'free';
  if (!genMoves(board, from).length) return 'static';
  if (legalMoves(board, from).length) return 'free';
  return 'pinned';
}

/**
 * 轮到 side 走棋时的局面状态。
 * @returns {'playing'|'check'|'checkmate'|'stalemate'}
 *   checkmate = 被将死，stalemate = 困毙（无棋可走）——中国象棋两者都判负
 */
export function status(board, side) {
  if (allLegalMoves(board, side).length === 0) {
    return inCheck(board, side) ? 'checkmate' : 'stalemate';
  }
  return inCheck(board, side) ? 'check' : 'playing';
}

/* ---------------- 中文记谱 ---------------- */

const fileNo = (side, col) => (side === RED ? CN[8 - col] : String(col + 1));
const stepNo = (side, n) => (side === RED ? CN[n - 1] || String(n) : String(n));

/**
 * 中文记谱，例如「炮二平五」「马8进7」「前兵进一」。
 * 同一纵线上有多个同种棋子时用 前/中/后 区分；超过 3 个退回坐标记法。
 * @param {Array} board 走子前的棋盘
 */
export function moveNotation(board, from, to) {
  const pc = board[from];
  if (!pc) return toCoord(from) + toCoord(to);
  const side = sideOf(pc);
  const type = typeOf(pc);
  const name = NAME[side][type];
  const fr = rowOf(from);
  const fc = colOf(from);
  const tr = rowOf(to);
  const tc = colOf(to);

  // 同一纵线上的同种棋子 → 前/中/后
  const sameFile = [];
  for (let r = 0; r < ROWS; r++) if (board[idx(r, fc)] === pc) sameFile.push(r);
  let head;
  if (sameFile.length > 1) {
    const order = side === RED ? sameFile.slice().sort((a, b) => a - b) : sameFile.slice().sort((a, b) => b - a);
    const tags = sameFile.length === 2 ? ['前', '后'] : sameFile.length === 3 ? ['前', '中', '后'] : null;
    if (!tags) return toCoord(from) + toCoord(to);
    head = tags[order.indexOf(fr)] + name;
  } else {
    head = name + fileNo(side, fc);
  }

  if (tr === fr) return head + '平' + fileNo(side, tc);
  const forward = side === RED ? tr < fr : tr > fr;
  const act = forward ? '进' : '退';
  // 斜行棋子（马/仕/相）报目标纵线，直行棋子报步数
  const dest = type === 'N' || type === 'A' || type === 'B' ? fileNo(side, tc) : stepNo(side, Math.abs(tr - fr));
  return head + act + dest;
}

/** 棋子中文描述，例如 '红车' */
export function pieceLabel(pc) {
  if (!pc) return '';
  return SIDE_NAME[sideOf(pc)] + NAME[sideOf(pc)][typeOf(pc)];
}
