/* Govee lights over the local network (Govee "LAN API", UDP): no key, no cloud.
 * A scan goes to the multicast group on port 4001, lamps answer on 4002 with their IP,
 * commands go to the lamp on 4003. Each lamp needs "LAN Control" switched on once in
 * the Govee Home app, otherwise it stays silent.
 * Config of a device: { driver: "govee-lan", device: "<id given by the scan>" } or { ip }. */
const dgram = require('dgram');
const os = require('os');
const { DeviceError, clamp } = require('../util');

const GROUP = '239.255.255.250', SCAN_PORT = 4001, LISTEN_PORT = 4002, COMMAND_PORT = 4003;
const SCAN = { msg: { cmd: 'scan', data: { account_topic: 'reserve' } } };
const KELVIN = { min: 2000, max: 9000 };
const SCAN_EVERY_MS = 30000;

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const lanAddresses = () => Object.values(os.networkInterfaces()).flat().filter((a) => a.family === 'IPv4' && !a.internal).map((a) => a.address);

// devStatus of a lamp -> the service's vocabulary. A color temperature of 0 means the lamp shows a color.
function normalize(d) {
  const c = d.color || {};
  const kelvin = d.colorTemInKelvin || 0;
  return {
    reachable: true, on: d.onOff === 1, brightness: d.brightness,
    colorRgb: kelvin ? null : ((c.r || 0) << 16) | ((c.g || 0) << 8) | (c.b || 0),
    colorTempK: kelvin || null,
  };
}

// One change -> the commands to send, in the order the lamp expects.
function commands(changes) {
  const out = [];
  if (changes.on != null) out.push({ cmd: 'turn', data: { value: changes.on ? 1 : 0 } });
  if (changes.colorRgb != null) {
    const v = clamp(Number(changes.colorRgb) || 0, 0, 0xffffff);
    out.push({ cmd: 'colorwc', data: { color: { r: (v >> 16) & 255, g: (v >> 8) & 255, b: v & 255 }, colorTemInKelvin: 0 } });
  }
  if (changes.colorTempK != null) {
    out.push({ cmd: 'colorwc', data: { color: { r: 0, g: 0, b: 0 }, colorTemInKelvin: clamp(Math.round(Number(changes.colorTempK)), KELVIN.min, KELVIN.max) } });
  }
  if (changes.brightness != null) out.push({ cmd: 'brightness', data: { value: clamp(Math.round(Number(changes.brightness)), 1, 100) } });
  return out;
}

function create({ socket = () => dgram.createSocket({ type: 'udp4', reuseAddr: true }), addresses = lanAddresses, now = Date.now, timeoutMs = 1500 } = {}) {
  let sock = null, ready = null, lastScan = -Infinity;
  const known = new Map();     // device id -> { ip, sku }
  const waiting = new Map();   // ip -> resolvers waiting for a devStatus

  function onMessage(buf, from) {
    let j;
    try { j = JSON.parse(buf.toString()); } catch { return; }         // not a Govee answer
    const msg = j && j.msg;
    if (!msg || !msg.data) return;
    if (msg.cmd === 'scan' && msg.data.device) known.set(msg.data.device, { ip: msg.data.ip || from.address, sku: msg.data.sku || null });
    if (msg.cmd === 'devStatus') {
      for (const resolve of waiting.get(from.address) || []) resolve(msg.data);
      waiting.delete(from.address);
    }
  }

  // One socket for everything: lamps answer on 4002 whatever port the question left from.
  function open() {
    if (ready) return ready;
    ready = new Promise((resolve, reject) => {
      sock = socket();
      sock.on('message', onMessage);
      // Port 4002 already taken (Home Assistant, another instance): nothing can be heard.
      sock.once('error', (e) => { ready = null; reject(new DeviceError(`Govee LAN: ${e.message}`)); });
      sock.bind(LISTEN_PORT, () => {
        for (const a of addresses()) sock.addMembership(GROUP, a);
        resolve();
      });
    });
    return ready;
  }

  const send = (payload, port, address) => new Promise((resolve, reject) => {
    sock.send(Buffer.from(JSON.stringify(payload)), port, address, (e) => e ? reject(new DeviceError(`Govee LAN: ${e.message}`)) : resolve());
  });

  /* The scan leaves on every network card: on a PC with virtual adapters (Hyper-V,
   * Docker) the default one is often not the one the lamps are on. Lamps declared by IP
   * are asked directly too. */
  async function scan(devices = []) {
    await open();
    lastScan = now();
    for (const a of addresses()) {
      sock.setMulticastInterface(a);
      await send(SCAN, SCAN_PORT, GROUP);
    }
    for (const d of devices) if (d.ip) await send(SCAN, SCAN_PORT, d.ip);
  }

  async function ipOf(device) {
    const ip = () => device.ip || (known.get(device.device) || {}).ip;
    if (!ip() && now() - lastScan > SCAN_EVERY_MS) {
      await scan([device]);
      await wait(timeoutMs);
    }
    return ip() || null;
  }

  async function status(ip) {
    await open();
    const answer = new Promise((resolve) => {
      waiting.set(ip, [...(waiting.get(ip) || []), resolve]);
      setTimeout(() => resolve(null), timeoutMs);
    });
    await send({ msg: { cmd: 'devStatus', data: {} } }, COMMAND_PORT, ip);
    return answer;
  }

  // `lanSilent`: the page explains that LAN Control must be on. A lamp that is unplugged looks the same.
  const SILENT = { reachable: false, error: 'lanSilent' };

  async function state(device) {
    const ip = await ipOf(device);
    if (!ip) return SILENT;
    const d = await status(ip);
    if (!d) {
      known.delete(device.device);          // its IP may have changed: found again at the next scan
      return SILENT;
    }
    return normalize(d);
  }

  async function set(device, changes) {
    const ip = await ipOf(device);
    if (!ip) throw new DeviceError(`${device.name}: no answer on the LAN`);
    for (const c of commands(changes)) await send({ msg: c }, COMMAND_PORT, ip);
    await wait(Math.min(150, timeoutMs));    // the lamp reports its old state for an instant
  }

  const capabilities = async () => ({
    on: { type: 'boolean' }, brightness: { min: 1, max: 100, step: 1 },
    colorRgb: { type: 'color' }, colorTempK: { ...KELVIN, step: 100 },
  });

  // Lamps seen on the network, to fill the config.
  async function list() {
    await scan();
    await wait(timeoutMs);
    return [...known].map(([device, d]) => ({ driver: 'govee-lan', device, ip: d.ip, sku: d.sku }));
  }

  const close = () => { if (sock) sock.close(); sock = null; ready = null; };

  return { capabilities, state, set, list, close };
}

module.exports = { create, normalize, commands };
