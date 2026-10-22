// 极简 WebSocket 服务端（RFC 6455），只为接浏览器连接，零依赖
// 上游豆包用 Node 自带的 WebSocket 客户端，这里只需要服务端握手和收发帧
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const MAX_MESSAGE = 4 * 1024 * 1024;

// 编码一帧（服务端发出的帧不加掩码）
export function encodeFrame(opcode, payload) {
  const len = payload.length;
  let head;
  if (len < 126) {
    head = Buffer.from([0x80 | opcode, len]);
  } else if (len < 65536) {
    head = Buffer.alloc(4);
    head[0] = 0x80 | opcode; head[1] = 126; head.writeUInt16BE(len, 2);
  } else {
    head = Buffer.alloc(10);
    head[0] = 0x80 | opcode; head[1] = 127; head.writeBigUInt64BE(BigInt(len), 2);
  }
  return Buffer.concat([head, payload]);
}

// 从缓冲区解出一帧，数据不够时返回 null
export function decodeFrame(buf) {
  if (buf.length < 2) return null;
  const fin = (buf[0] & 0x80) !== 0;
  const opcode = buf[0] & 0x0f;
  const masked = (buf[1] & 0x80) !== 0;
  let len = buf[1] & 0x7f;
  let off = 2;
  if (len === 126) {
    if (buf.length < 4) return null;
    len = buf.readUInt16BE(2); off = 4;
  } else if (len === 127) {
    if (buf.length < 10) return null;
    len = Number(buf.readBigUInt64BE(2)); off = 10;
  }
  if (len > MAX_MESSAGE) throw new Error('frame too large');
  const maskLen = masked ? 4 : 0;
  if (buf.length < off + maskLen + len) return null;
  const payload = Buffer.from(buf.subarray(off + maskLen, off + maskLen + len));
  if (masked) {
    const mask = buf.subarray(off, off + 4);
    for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3];
  }
  return { fin, opcode, payload, size: off + maskLen + len };
}

export class WsConnection extends EventEmitter {
  constructor(socket, head) {
    super();
    this.socket = socket;
    this.buf = head?.length ? Buffer.from(head) : Buffer.alloc(0);
    this.parts = [];
    this.partOpcode = 0;
    this.open = true;
    socket.setNoDelay(true);
    socket.on('data', (d) => this.#onData(d));
    socket.on('close', () => this.#closed());
    socket.on('error', () => this.#closed());
    if (this.buf.length) queueMicrotask(() => this.#onData(Buffer.alloc(0)));
  }

  #onData(chunk) {
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
    try {
      let frame;
      while ((frame = decodeFrame(this.buf))) {
        this.buf = this.buf.subarray(frame.size);
        this.#onFrame(frame);
      }
    } catch {
      this.close(1009);
    }
  }

  #onFrame({ fin, opcode, payload }) {
    if (opcode === 0x8) return this.close();
    if (opcode === 0x9) return this.#write(0xa, payload);
    if (opcode === 0xa) return;
    if (opcode !== 0) { this.partOpcode = opcode; this.parts = []; }
    this.parts.push(payload);
    if (!fin) return;
    const data = Buffer.concat(this.parts);
    this.parts = [];
    if (this.partOpcode === 0x1) this.emit('text', data.toString('utf8'));
    else if (this.partOpcode === 0x2) this.emit('binary', data);
  }

  #write(opcode, payload) {
    if (this.open && !this.socket.destroyed) this.socket.write(encodeFrame(opcode, payload));
  }

  sendJson(obj) { this.#write(0x1, Buffer.from(JSON.stringify(obj))); }
  sendBinary(buf) { this.#write(0x2, buf); }

  close(code = 1000) {
    if (!this.open) return;
    const p = Buffer.alloc(2); p.writeUInt16BE(code);
    this.#write(0x8, p);
    this.socket.end();
    this.#closed();
  }

  #closed() {
    if (!this.open) return;
    this.open = false;
    this.emit('close');
  }
}

// 完成握手并返回连接；不是合法的 WebSocket 升级请求时返回 null
export function acceptUpgrade(req, socket, head) {
  const key = req.headers['sec-websocket-key'];
  if (!key || req.headers.upgrade?.toLowerCase() !== 'websocket') return null;
  const accept = createHash('sha1').update(key + GUID).digest('base64');
  socket.write([
    'HTTP/1.1 101 Switching Protocols',
    'Upgrade: websocket',
    'Connection: Upgrade',
    `Sec-WebSocket-Accept: ${accept}`,
    '', '',
  ].join('\r\n'));
  return new WsConnection(socket, head);
}
