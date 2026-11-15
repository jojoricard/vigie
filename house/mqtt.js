/* A minimal MQTT 3.1.1 client over TCP or TLS: connect, subscribe, publish at QoS 0,
 * keep alive. Enough to listen to a Zigbee2MQTT bridge and to talk back to it, in two
 * hundred lines instead of a dependency (as ws.js is for the televisions).
 * open(url, { clientId, username, password, onMessage(topic, text), onClose })
 * resolves with { subscribe(topics), publish(topic, text), close() }. */
const net = require('net');
const tls = require('tls');
const { DeviceError } = require('./util');

const TYPE = { connect: 1, connack: 2, publish: 3, subscribe: 8, suback: 9, pingreq: 12, pingresp: 13, disconnect: 14 };

// The "remaining length" of a packet: seven bits a byte, the eighth says another follows.
function lengthBytes(n) {
  const out = [];
  do { let b = n % 128; n = Math.floor(n / 128); if (n > 0) b |= 0x80; out.push(b); } while (n > 0);
  return Buffer.from(out);
}
const text = (s) => { const b = Buffer.from(String(s)); return Buffer.concat([Buffer.from([b.length >> 8, b.length & 255]), b]); };
const packet = (type, flags, body = Buffer.alloc(0)) => Buffer.concat([Buffer.from([(type << 4) | flags]), lengthBytes(body.length), body]);

function connectPacket({ clientId, username, password, keepAlive = 60 }) {
  const flags = 0x02 | (username != null ? 0x80 : 0) | (password != null ? 0x40 : 0);   // clean session
  return packet(TYPE.connect, 0, Buffer.concat([text('MQTT'), Buffer.from([4, flags, keepAlive >> 8, keepAlive & 255]), text(clientId),
    ...(username != null ? [text(username)] : []), ...(password != null ? [text(password)] : [])]));
}
const subscribePacket = (id, topics) => packet(TYPE.subscribe, 2, Buffer.concat([Buffer.from([id >> 8, id & 255]), ...topics.flatMap((t) => [text(t), Buffer.from([0])])]));
const publishPacket = (topic, payload, retain = false) => packet(TYPE.publish, retain ? 1 : 0, Buffer.concat([text(topic), Buffer.from(String(payload))]));

// The first whole packet of a buffer, or null when more bytes are needed.
function decode(buffer) {
  if (buffer.length < 2) return null;
  let length = 0, at = 1, factor = 1;
  for (;;) {
    if (at >= buffer.length) return null;
    const b = buffer[at++];
    length += (b & 127) * factor;
    if (!(b & 0x80)) break;
    factor *= 128;
    if (factor > 128 ** 3) throw new DeviceError('mqtt: malformed packet');
  }
  if (buffer.length < at + length) return null;
  return { type: buffer[0] >> 4, flags: buffer[0] & 15, body: buffer.subarray(at, at + length), size: at + length };
}

// A message from the broker: its topic and its text. At QoS 1 or 2 a packet id sits between the two.
function parsePublish(flags, body) {
  const n = body.readUInt16BE(0), qos = (flags >> 1) & 3;
  return { topic: body.subarray(2, 2 + n).toString(), payload: body.subarray(2 + n + (qos ? 2 : 0)).toString() };
}

function open(url, { clientId = `house-${process.pid}`, username, password, keepAlive = 60, timeout = 5000, onMessage = () => {}, onClose = () => {}, connect = null } = {}) {
  return new Promise((resolve, reject) => {
    if (!URL.canParse(url)) return reject(new DeviceError(`mqtt: "${url}" is not a URL`));
    const u = new URL(url), secure = u.protocol === 'mqtts:';
    const socket = (connect || (secure ? tls.connect : net.connect))({ host: u.hostname, port: Number(u.port) || (secure ? 8883 : 1883), ...(secure ? { servername: u.hostname } : {}) });
    let buffer = Buffer.alloc(0), ready = false, done = false, ping = null, nextId = 1;
    const waiting = new Map();   // packet id -> resolve of a subscription
    const fail = (reason) => {
      if (done) return;
      done = true;
      clearInterval(ping); clearTimeout(timer);
      socket.destroy();
      if (ready) onClose(reason); else reject(new DeviceError(`mqtt: ${reason}`));
    };
    const timer = setTimeout(() => fail('timeout'), timeout);
    const api = {
      subscribe: (topics) => new Promise((ok) => { const id = nextId++ & 0xffff || nextId++; waiting.set(id, ok); socket.write(subscribePacket(id, topics)); }),
      publish: (topic, payload, retain) => { socket.write(publishPacket(topic, payload, retain)); },
      close: () => { if (!done) { socket.write(packet(TYPE.disconnect, 0)); fail('closed'); } },
    };
    socket.on(secure ? 'secureConnect' : 'connect', () => socket.write(connectPacket({ clientId, username: username ?? (u.username ? decodeURIComponent(u.username) : undefined), password: password ?? (u.password ? decodeURIComponent(u.password) : undefined), keepAlive })));
    socket.on('error', (e) => fail(e.message));
    socket.on('close', () => fail('connection closed'));
    socket.on('data', (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      for (;;) {
        let p;
        try { p = decode(buffer); } catch (e) { return fail(e.message); }
        if (!p) return;
        buffer = buffer.subarray(p.size);
        if (p.type === TYPE.connack) {
          if (p.body[1] !== 0) return fail(`refused by the broker (code ${p.body[1]})`);
          ready = true;
          clearTimeout(timer);
          ping = setInterval(() => socket.write(packet(TYPE.pingreq, 0)), (keepAlive * 1000) / 2);
          ping.unref();
          resolve(api);
        } else if (p.type === TYPE.publish) {
          const m = parsePublish(p.flags, p.body);
          onMessage(m.topic, m.payload);
        } else if (p.type === TYPE.suback) {
          const id = p.body.readUInt16BE(0), ok = waiting.get(id);
          waiting.delete(id);
          if (ok) ok();
        }
      }
    });
  });
}

module.exports = { open, decode, parsePublish, connectPacket, subscribePacket, publishPacket, lengthBytes, TYPE };
