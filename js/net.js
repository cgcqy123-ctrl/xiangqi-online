// 联机层：PeerJS（WebRTC 数据通道 + 公共信令服务器）
// 房主建房后拿到 4 位房号，其他人凭房号直连房主；对局状态只由房主计算与广播。
//
// 两方（玩家）与多观众都只是"座位号"：0 / 1 是对局座位，2 以后是观战位。
// 这一层只管连接、分配座位键、收发消息，规则和界面都不在这里。
//
// 针对中国大陆网络做的改动（接口与原版完全兼容）：
// 1. STUN 改为国内服务器优先（小米 / 腾讯 / Bilibili），Google STUN 只留作海外兜底。
// 原版把 Google 排在第一位，在大陆不可达，会拖慢 ICE 收集、增加连接超时概率。
// 2. 默认带上公共 TURN 中继（Open Relay / PeerJS 云 TURN）作为打洞失败时的兜底。
// 原版用自定义 config 覆盖了 PeerJS 自带配置，实际只有 STUN、没有任何 TURN：
// 双方只要有一方是对称 NAT（校园网、公司网、部分 4G/5G 和酒店 Wi-Fi 很常见），
// 就必然打洞失败、连接超时，这是大陆用户「连不上」最主要的原因。
// TURN 只是兜底：能直连时不会走中继；如需更稳，可自建 coturn 后通过
// window.EXTRA_ICE_SERVERS 注入（见下方 peerOptions 说明），或设
// window.DISABLE_PUBLIC_TURN = true 关掉公共 TURN 只用自建的。
// 3. 信令连接失败 / 连接超时 / 握手超时 / ICE failed 时自动重试（带退避），
// 原版只有房号被占用才重试，信令服务器抖一下就直接报错。
// 4. 房主建房、加入者连信令都加了 12 秒超时，原版无超时，信令不通时会无限转圈。

export const ROOM_PREFIX = 'xqcard-';

const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // 去掉容易混淆的 I O 0 1

export function randomCode(len = 4) {
let s = '';
for (let i = 0; i < len; i++) s += CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)];
return s;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
* 默认 STUN：国内可访问的排前面。
* iPhone/Safari 在蜂窝网络、热点或跨运营商网络下，只靠单个 STUN 经常打洞失败，这里多备几个。
*/
export const DEFAULT_ICE_SERVERS = [
{ urls: 'stun:stun.miwifi.com:3478'},
{ urls: 'stun:stun.qq.com:3478'},
{ urls: 'stun:stun.chat.bilibili.com:3478'},
{ urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302']}, // 海外兜底，大陆不可达也不影响国内服务器
];

/**
* 默认 TURN 中继（兜底用）：双方有一方是对称 NAT 时，只有 TURN 能连上。
* 这是公共免费中继，速度和可用性不保证；正式使用强烈建议自建 coturn（国内云服务器即可），
* 然后在 index.html 里加：window.EXTRA_ICE_SERVERS = [{ urls:'turn:你的域名:3478', username:'…', credential:'…'}]
*/
export const DEFAULT_TURN_SERVERS = [
{ urls: 'turn:openrelay.metered.ca:80', username: 'openrelayproject', credential: 'openrelayproject'},
{ urls: 'turn:openrelay.metered.ca:443', username: 'openrelayproject', credential: 'openrelayproject'},
{ urls: 'turns:openrelay.metered.ca:443?transport=tcp', username: 'openrelayproject', credential: 'openrelayproject'},
{ urls: 'turn:eu-0.turn.peerjs.com:3478', username: 'peerjs', credential: 'peerjs'},
{ urls: 'turn:us-0.turn.peerjs.com:3478', username: 'peerjs', credential: 'peerjs'},
];

function buildIceServers() {
const w = typeof window!== 'undefined'? window: {};
const extra = Array.isArray(w.EXTRA_ICE_SERVERS)? w.EXTRA_ICE_SERVERS: [];
const turn = w.DISABLE_PUBLIC_TURN? []: DEFAULT_TURN_SERVERS;
// 自建 TURN 放最前面优先用，公共 TURN 只兜底
return [...DEFAULT_ICE_SERVERS,...extra,...turn];
}

/** 需要自建信令服务器 / TURN 时，在 index.html 里设置 window.PEER_OPTIONS = {host, port, path, key, secure, config} */
function peerOptions() {
const o = (typeof window!== 'undefined' && window.PEER_OPTIONS) || null;
const opt = o && typeof o === 'object'? {...o}: {};
if (!opt.config) opt.config = { iceServers: buildIceServers()};
else if (!opt.config.iceServers) opt.config = {...opt.config, iceServers: buildIceServers()};
return opt;
}

export function normalizeCode(input) {
return String(input || '').trim().toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 4);
}

// 这些信令错误多半是临时抖动，值得自动重试；其余（如房号不存在）重试也没用
const TRANSIENT_TYPES = ['network', 'server-error', 'socket-error', 'socket-closed', 'disconnected'];

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
case 'ice-failed':
return '点对点连接失败：双方网络打洞不通（校园网/公司网/部分移动网络常见），换个网络或稍后再试';
default:
return (err && err.message) || '连接出错';
}
}

/** 监听 ICE 状态：failed 说明打洞和中继都没走通，交给上层走重连/报错。FakeConn 等无 peerConnection 时自动跳过 */
function watchIce(conn, onFailed) {
try {
if (conn && typeof conn.on === 'function') {
conn.on('iceStateChanged', (state) => {
if (state === 'failed') onFailed();
});
}
const pc = conn && conn.peerConnection;
if (pc) {
const handler = () => {
if (pc.iceConnectionState === 'failed') onFailed();
};
if (typeof pc.addEventListener === 'function') pc.addEventListener('iceconnectionstatechange', handler);
}
} catch (_) { /* ignore */}
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
// 房号被占用立刻换号重试；信令抖动则退避一下再试
if (i < 5) await sleep(e.transient? Math.min(600 * 2 ** i, 4000): 200);
}
}
throw last || new Error('创建房间失败，请重试');
}

_openWithCode(code) {
return new Promise((resolve, reject) => {
const peer = new Peer(ROOM_PREFIX + code.toLowerCase(), peerOptions());
let settled = false;
const timer = setTimeout(() => {
const e = new Error('连不上信令服务器，请检查网络后重试');
e.retry = true;
e.transient = true;
fail(e);
}, 12000);
const fail = (err) => {
if (settled) return;
settled = true;
clearTimeout(timer);
try { peer.destroy();} catch (_) { /* ignore */}
reject(err);
};
peer.on('open', () => {
if (settled) return;
settled = true;
clearTimeout(timer);
this.peer = peer;
peer.on('connection', (conn) => this._accept(conn));
peer.on('error', (err) => this.h.onError && this.h.onError(errText(err)));
peer.on('disconnected', () => {
if (!this.destroyed) {
try { peer.reconnect();} catch (_) { /* ignore */}
}
});
resolve();
});
peer.on('error', (err) => {
if (settled) return;
const e = new Error(errText(err));
e.retry =!!err && (err.type === 'unavailable-id' || TRANSIENT_TYPES.includes(err.type));
e.transient =!!err && TRANSIENT_TYPES.includes(err.type);
fail(e);
});
});
}

_accept(conn) {
this.pending.add(conn);
conn.on('data', (msg) => this._onData(conn, msg));
conn.on('close', () => this._drop(conn));
conn.on('error', () => this._drop(conn));
// ICE failed 时主动关掉，让加入者尽快重连入座，而不是挂着一条死连接
watchIce(conn, () => {
try { conn.close();} catch (_) { /* ignore */}
});
// 15 秒内没握手就关掉，防止挂着一堆废连接
setTimeout(() => {
if (conn._xqSeat === undefined && this.pending.has(conn)) {
this.pending.delete(conn);
try { conn.close();} catch (_) { /* ignore */}
}
}, 15000);
}

_onData(conn, msg) {
if (!msg || typeof msg!== 'object') return;
const seat = conn._xqSeat;
if (msg.t === 'hello') {
// iPhone/Safari 有时会丢掉数据通道刚建立时的第一条消息，加入方会重发 hello。
// 所以这里既要接「首次握手」（seat 为 undefined），也要接「已绑定座位的幂等重握手」。
this.pending.delete(conn);
if (this.h.onHello) this.h.onHello(conn, String(msg.name || '').slice(0, 12), seat);
return;
}
if (seat === undefined) return;
if (this.h.onMessage) this.h.onMessage(seat, msg);
}

/** 把连接绑到某个座位 */
bind(conn, seat) {
const old = this.links.get(seat);
if (old && old!== conn) {
try { old.close();} catch (_) { /* ignore */}
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
if (!conn ||!conn.open) return false;
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
try { conn.close();} catch (_) { /* ignore */}
}
this.links.clear();
try { this.peer && this.peer.destroy();} catch (_) { /* ignore */}
}
}

/** 加入者侧 */
export class GuestRoom {
constructor(handlers = {}) {
this.h = handlers;
this.peer = null;
this.conn = null;
this.closed = false;
this.helloName = '';
this.handshakeDone = false;
this.helloRetry = null;
this._joinCode = '';
this._reconnects = 0; // 握手/ICE 失败后的整体重连次数（上限 2 次）
this._reconnecting = false;
}

async join(code, name) {
this._joinCode = code;
this.helloName = name;
this.closed = false;
let last = null;
for (let attempt = 0; attempt < 3; attempt++) {
try {
await this._connectOnce(code, name);
return;
} catch (e) {
last = e;
this._teardown();
if (!e || e.noRetry || this.closed) throw e;
if (attempt < 2) await sleep(1200 * (attempt + 1));
}
}
throw last || new Error('连接失败，请重试');
}

async _connectOnce(code, name) {
const peer = await this._newPeer();
this.peer = peer;
peer.on('error', (err) => {
if (err && err.type === 'peer-unavailable') this.h.onFail && this.h.onFail('房号不存在，或者房主已经离线');
else this.h.onError && this.h.onError(errText(err));
});
peer.on('disconnected', () => {
if (!this.closed &&!this._reconnecting) {
try { peer.reconnect();} catch (_) { /* ignore */}
}
});
const conn = peer.connect(ROOM_PREFIX + code.toLowerCase(), { reliable: true});
this.conn = conn;
await new Promise((resolve, reject) => {
const timer = setTimeout(() => reject(new Error('连接超时：请确认房号正确、房主还开着房间')), 15000);
conn.on('open', () => {
clearTimeout(timer);
resolve();
});
conn.on('error', (e) => {
clearTimeout(timer);
reject(new Error(errText(e) === '连接出错'? '连接失败，请重试': errText(e)));
});
peer.on('error', (err) => {
if (err && err.type === 'peer-unavailable') {
clearTimeout(timer);
const e = new Error('房号不存在，或者房主已经离线');
e.noRetry = true; // 房号错了/房主不在，重试多少次都一样
reject(e);
}
});
});
this.helloName = name;
this.handshakeDone = false;
conn.on('data', (msg) => {
// 收到房主的任何消息就说明握手成功，停掉 hello 重发
this.handshakeDone = true;
this._stopHelloRetry();
if (this.h.onMessage) this.h.onMessage(msg);
});
conn.on('close', () => {
if (this.conn !== conn) return; // stale conn from a reconnect teardown: its close is not a disconnect
this._stopHelloRetry();
if (!this.closed &&!this._reconnecting) this.h.onClose && this.h.onClose();
});
watchIce(conn, () => this._onIceFailed());
this._sendHello();
this._startHelloRetry();
}

/** ICE failed：整条连接已经没救，自动整体重连（同名重连会回到原座位），两次不行再报错 */
_onIceFailed() {
if (this.closed || this._reconnecting) return;
const e = new Error(errText({ type: 'ice-failed'}));
this._reconnectOrFail(e.message);
}

async _reconnectOrFail(failMessage) {
if (this.closed || this._reconnecting) return;
if (this._reconnects >= 2) {
this.h.onFail && this.h.onFail(failMessage);
return;
}
this._reconnects += 1;
this._reconnecting = true;
this._teardown();
await sleep(1200 * this._reconnects);
if (this.closed) { this._reconnecting = false; return;}
try {
await this._connectOnce(this._joinCode, this.helloName);
this._reconnecting = false;
} catch (e) {
this._reconnecting = false;
this.h.onFail && this.h.onFail((e && e.message) || failMessage);
}
}

/** 拆掉当前 peer/conn（重连时用；不触发 onClose） */
_teardown() {
this._stopHelloRetry();
const conn = this.conn;
const peer = this.peer;
this.conn = null;
this.peer = null;
this.handshakeDone = false;
try { conn && conn.close();} catch (_) { /* ignore */}
try { peer && peer.destroy();} catch (_) { /* ignore */}
}

/** 发送 hello；iPhone/Safari 第一条消息可能丢，外面会定时重发 */
_sendHello() {
try {
if (this.conn && this.conn.open) {
this.conn.send({ t: 'hello', name: this.helloName});
return true;
}
} catch (_) { /* ignore */}
return false;
}

/** 握手重试：Safari 偶尔吞掉连接刚建立时的第一条消息，这里每 1.2 秒补发一次 hello */
_startHelloRetry() {
this._stopHelloRetry();
let tries = 0;
this.helloRetry = setInterval(() => {
if (this.handshakeDone) {
this._stopHelloRetry();
return;
}
if (!this.conn ||!this.conn.open) return;
tries += 1;
if (tries > 8) {
this._stopHelloRetry();
// 原版到这里就直接放弃；现在先自动整体重连，两次都失败再提示
this._reconnectOrFail('连接超时：房主没有收到你的入座请求，请刷新页面重试');
return;
}
this._sendHello();
}, 1200);
}

_stopHelloRetry() {
if (this.helloRetry) {
clearInterval(this.helloRetry);
this.helloRetry = null;
}
}

_newPeer() {
return new Promise((resolve, reject) => {
let peer;
try {
peer = new Peer(peerOptions());
} catch (e) {
const err = new Error(errText(e));
err.noRetry = true;
reject(err);
return;
}
const timer = setTimeout(() => {
try { peer.destroy();} catch (_) { /* ignore */}
reject(new Error('连不上信令服务器，请检查网络后重试'));
}, 12000);
peer.on('open', () => {
clearTimeout(timer);
resolve(peer);
});
peer.on('error', (err) => {
clearTimeout(timer);
const e = new Error(errText(err));
e.type = err && err.type;
if (err && (err.type === 'browser-incompatible' || err.type === 'ssl-unavailable')) e.noRetry = true;
reject(e);
});
});
}

send(msg) {
try {
if (this.conn && this.conn.open) {
this.conn.send(msg);
return true;
}
} catch (_) { /* ignore */}
return false;
}

close() {
this.closed = true;
this._stopHelloRetry();
try { this.conn && this.conn.close();} catch (_) { /* ignore */}
try { this.peer && this.peer.destroy();} catch (_) { /* ignore */}
}
}
