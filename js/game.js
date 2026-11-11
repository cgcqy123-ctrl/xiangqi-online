// 中国象棋对局状态机（纯逻辑，不依赖 DOM / 网络）
// 由房主（host）单方面运行：校验走法、判将军/将死、维护悔棋求和，其他人只提交动作、收视图。

const V = new URL(import.meta.url).search; // 跟随 index.html 的 ?v= 做缓存穿透
const R = await import('./rules.js' + V);

export const PHASE = { LOBBY: 'lobby', PLAY: 'play', OVER: 'over' };

/** 座位 → 阵营：0 号位执红先行，1 号位执黑；席位 < 0 为观战 */
export const sideOfSeat = (seat) => (seat === 0 ? R.RED : seat === 1 ? R.BLACK : null);
export const seatOfSide = (side) => (side === R.RED ? 0 : 1);

export class Game {
  /** players: [{ name, connected }]，固定两个对局座位 */
  constructor(players = []) {
    this.players = [0, 1].map((seat) => ({
      seat,
      side: sideOfSeat(seat),
      name: (players[seat] && players[seat].name) || '玩家' + (seat + 1),
      connected: !!(players[seat] && players[seat].connected !== false),
    }));
    this.phase = PHASE.LOBBY;
    this.round = 0;
    this.resetPublic();
  }

  resetPublic() {
    this.board = R.initialBoard();
    this.turn = R.RED;
    this.history = []; // [{ from, to, piece, captured, side, notation, check }]
    this.lastMove = null;
    this.inCheck = null; // 正在被将军的一方
    this.result = null;
    this.offers = { undo: null, draw: null }; // 待回应的请求：对方座位号
    this.startedAt = 0;
  }

  /** 开新一局（红先） */
  start() {
    this.resetPublic();
    this.phase = PHASE.PLAY;
    this.round++;
    this.startedAt = Date.now();
    return this;
  }

  get plyCount() {
    return this.history.length;
  }

  player(seat) {
    return this.players.find((p) => p.seat === seat) || null;
  }

  /** 统一动作入口 */
  action(seat, act) {
    if (!act || typeof act !== 'object') throw new Error('无效操作');
    switch (act.type) {
      case 'move':
        return this.move(seat, Number(act.from), Number(act.to));
      case 'resign':
        return this.resign(seat);
      case 'undo':
        return this.requestUndo(seat);
      case 'undoReply':
        return this.replyUndo(seat, !!act.accept);
      case 'draw':
        return this.offerDraw(seat);
      case 'drawReply':
        return this.replyDraw(seat, !!act.accept);
      default:
        throw new Error('无效操作');
    }
  }

  /* ---------------- 走棋 ---------------- */

  move(seat, from, to) {
    if (this.phase !== PHASE.PLAY) throw new Error('对局还没开始或已经结束');
    const side = sideOfSeat(seat);
    if (!side) throw new Error('观战不能走棋');
    if (!Number.isInteger(from) || !Number.isInteger(to) || from < 0 || to < 0 || from > 89 || to > 89) {
      throw new Error('走法无效');
    }
    if (this.offers.undo !== null || this.offers.draw !== null) throw new Error('先处理还没答复的悔棋 / 求和请求');
    if (side !== this.turn) throw new Error('还没轮到你走棋');
    const pc = this.board[from];
    if (!pc) throw new Error('这里没有棋子');
    if (R.sideOf(pc) !== side) throw new Error('那不是你的棋子');
    if (!R.legalMoves(this.board, from).includes(to)) {
      if (R.genMoves(this.board, from).includes(to)) {
        throw new Error('这样走会让自己的将帅被将军（或将帅照面）');
      }
      throw new Error('这步棋不能这么走');
    }

    const notation = R.moveNotation(this.board, from, to);
    const { board, captured } = R.applyMove(this.board, from, to);
    this.board = board;
    const nextSide = R.other(side);
    const st = R.status(this.board, nextSide);
    this.history.push({
      ply: this.history.length + 1,
      side,
      from,
      to,
      piece: pc,
      captured,
      notation,
      check: st === 'check' || st === 'checkmate',
    });
    this.lastMove = { from, to };
    this.offers = { undo: null, draw: null };
    this.turn = nextSide;
    this.inCheck = st === 'check' || st === 'checkmate' ? nextSide : null;

    if (st === 'checkmate' || st === 'stalemate') {
      this.finish(side, st);
      return { ok: true, over: true, notation };
    }
    return { ok: true, over: false, notation, check: st === 'check' };
  }

  /* ---------------- 认输 / 和棋 ---------------- */

  resign(seat) {
    if (this.phase !== PHASE.PLAY) throw new Error('对局已经结束');
    const side = sideOfSeat(seat);
    if (!side) throw new Error('观战不能认输');
    this.finish(R.other(side), 'resign');
    return { ok: true, over: true };
  }

  offerDraw(seat) {
    if (this.phase !== PHASE.PLAY) throw new Error('对局已经结束');
    if (!sideOfSeat(seat)) throw new Error('观战不能求和');
    if (this.offers.draw !== null) throw new Error('已经有一个求和请求在等回应');
    this.offers.draw = seat;
    return { ok: true };
  }

  replyDraw(seat, accept) {
    const by = this.offers.draw;
    if (by === null) throw new Error('没有待回应的求和请求');
    if (seat === by) throw new Error('不能自己答应自己');
    if (!sideOfSeat(seat)) throw new Error('观战不能回应求和');
    this.offers.draw = null;
    if (accept) {
      this.finish(null, 'draw');
      return { ok: true, over: true, accepted: true };
    }
    return { ok: true, over: false, accepted: false };
  }

  /* ---------------- 悔棋（需要对方同意） ---------------- */

  /** 这个座位现在能不能请求悔棋：自己走过棋、没人抢着申请 */
  canRequestUndo(seat) {
    const side = sideOfSeat(seat);
    if (!side || this.phase !== PHASE.PLAY) return false;
    if (this.offers.undo !== null || this.offers.draw !== null) return false;
    return this.history.some((h) => h.side === side);
  }

  requestUndo(seat) {
    if (this.phase !== PHASE.PLAY) throw new Error('对局已经结束');
    const side = sideOfSeat(seat);
    if (!side) throw new Error('观战不能悔棋');
    if (this.offers.undo !== null) throw new Error('已经有一个悔棋请求在等回应');
    if (this.offers.draw !== null) throw new Error('先处理求和请求');
    if (!this.history.some((h) => h.side === side)) throw new Error('你还没走过棋，没有可悔的');
    this.offers.undo = seat;
    return { ok: true };
  }

  replyUndo(seat, accept) {
    const by = this.offers.undo;
    if (by === null) throw new Error('没有待回应的悔棋请求');
    if (seat === by) throw new Error('不能自己答应自己');
    if (!sideOfSeat(seat)) throw new Error('观战不能回应悔棋');
    this.offers.undo = null;
    if (!accept) return { ok: true, over: false, accepted: false };

    // 撤回到「自己上一步之前」：正好刚走完（对方还没应）只退 1 手，对方已应则退 2 手
    const want = sideOfSeat(by);
    let popped = 0;
    while (this.history.length && popped < 2) {
      const last = this.history[this.history.length - 1];
      this.popPly();
      popped++;
      if (last.side === want && this.turn === want) break;
    }
    return { ok: true, over: false, accepted: true, popped };
  }

  popPly() {
    const last = this.history.pop();
    if (!last) return null;
    this.board[last.from] = last.piece;
    this.board[last.to] = last.captured || null;
    this.turn = last.side;
    this.lastMove = this.history.length ? { from: this.history[this.history.length - 1].from, to: this.history[this.history.length - 1].to } : null;
    this.inCheck = R.inCheck(this.board, this.turn) ? this.turn : null;
    return last;
  }

  /* ---------------- 结束 ---------------- */

  finish(winnerSide, reason) {
    this.phase = PHASE.OVER;
    this.offers = { undo: null, draw: null };
    this.inCheck = null;
    const texts = {
      checkmate: '将死',
      stalemate: '困毙',
      resign: '认输',
      draw: '和棋',
    };
    this.result = {
      winner: winnerSide || null,
      reason,
      text: winnerSide ? `${R.SIDE_NAME[winnerSide]}方胜（${texts[reason] || reason}）` : `和棋（${texts[reason] || reason}）`,
      plies: this.history.length,
    };
  }

  /* ---------------- 视图 ---------------- */

  /**
   * 某人的可见视图。seat = -1 表示观战（信息完全公开，没人和棋类没有暗牌）。
   */
  view(seat = -1) {
    const spectator = !sideOfSeat(seat);
    const capturedBy = { r: [], b: [] };
    for (const h of this.history) if (h.captured) capturedBy[h.side].push(h.captured);
    return {
      phase: this.phase,
      round: this.round,
      seat: spectator ? -1 : seat,
      spectator,
      mySide: spectator ? null : sideOfSeat(seat),
      turn: this.turn,
      board: this.board.slice(),
      players: this.players.map((p) => ({ ...p })),
      moves: this.history.map((h) => ({
        ply: h.ply,
        side: h.side,
        from: h.from,
        to: h.to,
        notation: h.notation,
        piece: h.piece,
        captured: h.captured,
        check: h.check,
      })),
      lastMove: this.lastMove,
      inCheck: this.inCheck,
      captured: capturedBy,
      offers: { ...this.offers },
      canUndo: this.canRequestUndo(seat),
      result: this.result,
      startedAt: this.startedAt,
    };
  }
}
