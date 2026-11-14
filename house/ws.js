/* A WebSocket client over a plain or a TLS socket (RFC 6455), text messages only.
 * Node has one built in, but it refuses the self-signed certificate a television
 * presents on its own network, and no option lets a caller accept it.
 * open(url, { onMessage, onClose, timeout }) resolves with { send(text), close() }. */
const crypto = require('crypto');
const net = require('net');
const tls = require('tls');
const { DeviceError } = require('./util');

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const OP = { more: 0, text: 1, close: 8, ping: 9, pong: 10 };

// One frame from the client: always masked, as the protocol asks of a client.
function encode(opcode, payload) {
  const length = payload.length, mask = crypto.randomBytes(4);
  const head = length < 126 ? Buffer.from([0x80 | opcode, 0x80 | length])
    : length < 65536 ? Buffer.from([0x80 | opcode, 0x80 | 126, length >> 8, length & 255])
      : Buffer.concat([Buffer.from([0x80 | opcode, 0x80 | 127]), (() => { const b = Buffer.alloc(8); b.writeBigUInt64BE(BigInt(length)); return b; })()]);
  const body = Buffer.from(payload);
  for (let i = 0; i < length; i++) body[i] ^= mask[i % 4];
  return Buffer.concat([head, mask, body]);
}

// The first whole frame of a buffer, or null when more bytes are needed.
function decode(buffer) {
  if (buffer.length < 2) return null;
  let length = buffer[1] & 127, at = 2;
  if (length === 126) { if (buffer.length < 4) return null; length = buffer.readUInt16BE(2); at = 4; }
  else if (length === 127) { if (buffer.length < 10) return null; length = Number(buffer.readBigUInt64BE(2)); at = 10; }
  const masked = (buffer[1] & 0x80) !== 0, start = at + (masked ? 4 : 0);
  if (buffer.length < start + length) return null;
  const payload = Buffer.from(buffer.subarray(start, start + length));
  if (masked) for (let i = 0; i < length; i++) payload[i] ^= buffer[at + (i % 4)];
  return { fin: (buffer[0] & 0x80) !== 0, opcode: buffer[0] & 15, payload, size: start + length };
}

function open(url, { onMessage = () => {}, onClose = () => {}, timeout = 3000 } = {}) {
  const { protocol, hostname, port, pathname } = new URL(url);
  const secure = protocol === 'wss:';
  return new Promise((resolve, reject) => {
    // a television signs its own certificate: on the home network, the address is the identity
    const socket = secure ? tls.connect({ host: hostname, port: Number(port) || 443, rejectUnauthorized: false })
      : net.connect({ host: hostname, port: Number(port) || 80 });
    const key = crypto.randomBytes(16).toString('base64');
    let buffer = Buffer.alloc(0), opened = false, closed = false, parts = [];
    const end = (why) => {
      if (closed) return;
      closed = true;
      socket.destroy();
      if (opened) onClose(why); else reject(new DeviceError(why));
    };
    socket.setTimeout(timeout, () => end('timeout'));
    socket.on('error', (e) => end(e.code || e.message));
    socket.on('close', () => end('closed'));
    socket.on(secure ? 'secureConnect' : 'connect', () => {
      socket.write(`GET ${pathname || '/'} HTTP/1.1\r\nHost: ${hostname}:${port}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`);
    });
    const send = (opcode, payload) => { if (!closed) socket.write(encode(opcode, payload)); };
    socket.on('data', (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      if (!opened) {
        const stop = buffer.indexOf('\r\n\r\n');
        if (stop < 0) return;
        const head = buffer.subarray(0, stop).toString('latin1');
        const accept = crypto.createHash('sha1').update(key + GUID).digest('base64');
        if (!/^HTTP\/1\.1 101/.test(head) || !head.toLowerCase().includes(`sec-websocket-accept: ${accept.toLowerCase()}`)) return end('not a WebSocket');
        buffer = buffer.subarray(stop + 4);
        opened = true;
        socket.setTimeout(0);
        resolve({ send: (text) => send(OP.text, Buffer.from(text)), close: () => { send(OP.close, Buffer.alloc(0)); end('closed'); } });
      }
      for (let frame = decode(buffer); frame; frame = decode(buffer)) {
        buffer = buffer.subarray(frame.size);
        if (frame.opcode === OP.ping) send(OP.pong, frame.payload);
        else if (frame.opcode === OP.close) return end('closed');
        else if (frame.opcode === OP.text || frame.opcode === OP.more) {
          parts.push(frame.payload);
          if (frame.fin) { const text = Buffer.concat(parts).toString(); parts = []; onMessage(text); }
        }
      }
    });
  });
}

module.exports = { open, encode, decode };
