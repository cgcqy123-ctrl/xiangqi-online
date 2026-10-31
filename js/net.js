// 联机层：PeerJS（WebRTC 数据通道 + 公共信令服务器）
// 房主建房后拿到 4 位房号，其他人凭房号直连房主；对局状态只由房主计算与广播。
//
// 两方（玩家）与多观众都只是"座位号"：0 / 1 是对局座位，2 以后是观战位。
// 这一层只管连接、分配座位键、收发消息，规则和界面都不在这里。

export const ROOM_PREFIX = 'xqcard-';

const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // 去掉容易混淆的 I O 0 1

export function randomCode(len = 4) {
  let s = '';
  for (let i = 0; i < len; i++) s += CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)];
  return s;
}

/** 需要自建信令服务器时，在 index.html 里设置 window.PEER_OPTIONS = {host, port, path, key, secure} */
function peerOptions() {
  const o = (typeof window !== 'undefined' && window.PEER_OPTIONS) || null;
  return o && typeof o === 'object' ? o : {};
}

export function normalizeCode(input) {
  return String(input || '').trim().toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 4);
}

function errText(err) {
  const t = (err && err.type) || '';
  switch (t) {
    case 'browser-incompatible':
      return '当前浏览器不支持 WebRTC，请换 Chrome / Edge / Safari';
    case 'network':
      return '网络异常，连不上信令服务器，请稍后重试';
    case 'server-error':
    case 'socket-error':
    case 'socket-closed':
      return '信令服务器连接中断，请刷新页面重试';
    case 'unavailable-id':
      return '房号被占用，正在换一个…';
    case 'peer-unavailable':
      return '房号不存在或房主已离线';
    case 'ssl-unavailable':
      return '当前页面不是 HTTPS，无法建立加密连接';
    case 'webrtc':
      return '点对点连接失败（可能是网络环境限制），换个网络再试';
    default:
      return (err && err.message) || '连接出错';
  }
}

/** 房主侧：管理所有加入者的连接 */
export class HostRoom {
  constructor(handlers = {}) {
    this.h = handlers;
    this.peer = null;
    this.code = '';
    this.links = new Map(); // seat -> conn（座位号由上层分配：0/1 玩家，2+ 观战）
    this.pending = new Set();
    this.destroyed = false;
  }

  async open() {
    let last = null;
    for (let i = 0; i < 6; i++) {
      const code = randomCode();
      try {
        await this._openWithCode(code);
        this.code = code;
        return code;
      } catch (e) {
        last = e;
        if (!e.retry) throw e;
      }
    }
    throw last || new Error('创建房间失败，请重试');
  }

  _openWithCode(code) {
    return new Promise((resolve, reject) => {
      const peer = new Peer(ROOM_PREFIX + code.toLowerCase(), peerOptions());
      let settled = false;
      const fail = (err) => {
        if (settled) return;
        settled = true;
        try { peer.destroy(); } catch (_) { /* ignore */ }
        reject(err);
      };
      peer.on('open', () => {
        if (settled) return;
        settled = true;
        this.peer = peer;
        peer.on('connection', (conn) => this._accept(conn));
        peer.on('error', (err) => this.h.onError && this.h.onError(errText(err)));
        peer.on('disconnected', () => {
          if (!this.destroyed) {
            try { peer.reconnect(); } catch (_) { /* ignore */ }
          }
        });
        resolve();
      });
      peer.on('error', (err) => {
        if (settled) return;
        const e = new Error(errText(err));
        e.retry = err && err.type === 'unavailable-id';
        fail(e);
      });
    });
  }

  _accept(conn) {
    this.pending.add(conn);
    conn.on('data', (msg) => this._onData(conn, msg));
    conn.on('close', () => this._drop(conn));
    conn.on('error', () => this._drop(conn));
    // 15 秒内没握手就关掉，防止挂着一堆废连接
    setTimeout(() => {
      if (conn._xqSeat === undefined && this.pending.has(conn)) {
        this.pending.delete(conn);
        try { conn.close(); } catch (_) { /* ignore */ }
      }
    }, 15000);
  }

  _onData(conn, msg) {
    if (!msg || typeof msg !== 'object') return;
    if (conn._xqSeat === undefined) {
      // 还没分配座位，只接受握手
      if (msg.t === 'hello') {
        this.pending.delete(conn);
        if (this.h.onHello) this.h.onHello(conn, String(msg.name || '').slice(0, 12));
      }
      return;
    }
    if (this.h.onMessage) this.h.onMessage(conn._xqSeat, msg);
  }

  /** 把连接绑到某个座位 */
  bind(conn, seat) {
    const old = this.links.get(seat);
    if (old && old !== conn) {
      try { old.close(); } catch (_) { /* ignore */ }
    }
    conn._xqSeat = seat;
    this.links.set(seat, conn);
  }

  send(seat, msg) {
    const conn = this.links.get(seat);
    if (!conn) return false;
    return this.sendRaw(conn, msg);
  }

  /** 给还没分配座位的连接发消息（例如房间已满） */
  sendRaw(conn, msg) {
    try {
      if (!conn || !conn.open) return false;
      conn.send(msg);
      return true;
    } catch (_) {
      return false;
    }
  }

  broadcastTo(seats, msg) {
    for (const s of seats) this.send(s, msg);
  }

  _drop(conn) {
    const seat = conn._xqSeat;
    this.pending.delete(conn);
    if (seat === undefined) return;
    if (this.links.get(seat) === conn) {
      this.links.delete(seat);
      if (this.h.onSeatGone) this.h.onSeatGone(seat);
    }
  }

  closeAll() {
    this.destroyed = true;
    for (const conn of this.links.values()) {
      try { conn.close(); } catch (_) { /* ignore */ }
    }
    this.links.clear();
    try { this.peer && this.peer.destroy(); } catch (_) { /* ignore */ }
  }
}

/** 加入者侧 */
export class GuestRoom {
  constructor(handlers = {}) {
    this.h = handlers;
    this.peer = null;
    this.conn = null;
    this.closed = false;
  }

  async join(code, name) {
    const peer = await this._newPeer();
    this.peer = peer;
    peer.on('error', (err) => {
      if (err && err.type === 'peer-unavailable') this.h.onFail && this.h.onFail('房号不存在，或者房主已经离线');
      else this.h.onError && this.h.onError(errText(err));
    });
    const conn = peer.connect(ROOM_PREFIX + code.toLowerCase(), { reliable: true });
    this.conn = conn;
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('连接超时：请确认房号正确、房主还开着房间')), 15000);
      conn.on('open', () => {
        clearTimeout(timer);
        resolve();
      });
      conn.on('error', (e) => {
        clearTimeout(timer);
        reject(new Error(errText(e) === '连接出错' ? '连接失败，请重试' : errText(e)));
      });
      peer.on('error', (err) => {
        if (err && err.type === 'peer-unavailable') {
          clearTimeout(timer);
          reject(new Error('房号不存在，或者房主已经离线'));
        }
      });
    });
    conn.on('data', (msg) => this.h.onMessage && this.h.onMessage(msg));
    conn.on('close', () => {
      if (!this.closed) this.h.onClose && this.h.onClose();
    });
    conn.send({ t: 'hello', name });
  }

  _newPeer() {
    return new Promise((resolve, reject) => {
      let peer;
      try {
        peer = new Peer(peerOptions());
      } catch (e) {
        reject(new Error(errText(e)));
        return;
      }
      const timer = setTimeout(() => reject(new Error('连不上信令服务器，请检查网络后重试')), 15000);
      peer.on('open', () => {
        clearTimeout(timer);
        resolve(peer);
      });
      peer.on('error', (err) => {
        clearTimeout(timer);
        reject(new Error(errText(err)));
      });
    });
  }

  send(msg) {
    try {
      if (this.conn && this.conn.open) {
        this.conn.send(msg);
        return true;
      }
    } catch (_) { /* ignore */ }
    return false;
  }

  close() {
    this.closed = true;
    try { this.conn && this.conn.close(); } catch (_) { /* ignore */ }
    try { this.peer && this.peer.destroy(); } catch (_) { /* ignore */ }
  }
}
