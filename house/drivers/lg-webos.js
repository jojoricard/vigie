/* LG televisions (webOS) on the local network, over the SSAP WebSocket the LG remote
 * apps use, after the open-source aiowebostv library. No cloud.
 * A television asks once, on its screen, whether this client may control it, and
 * answers with a key that is then sent at every connection: `node house/pair-tv.js
 * <address>` does that and prints the key to copy into the config.
 * Config of a device: { driver: "lg-webos", host, key, mac } and, to choose the
 * applications offered, apps: ["netflix", …]. `mac` is only needed to turn it on. */
const dgram = require('dgram');
const ws = require('../ws');
const manifest = require('./lg-webos-manifest.json');
const { DeviceError, clamp } = require('../util');

// Recent sets only answer on the secure port, older ones only on the plain one.
const PORTS = [['wss', 3001], ['ws', 3000]];
const URI = {
  off: 'system/turnOff', power: 'com.webos.service.tvpower/power/getPowerState',
  volume: 'audio/getVolume', setVolume: 'audio/setVolume', setMute: 'audio/setMute',
  inputs: 'tv/getExternalInputList', setInput: 'tv/switchInput',
  app: 'com.webos.applicationManager/getForegroundAppInfo', apps: 'com.webos.applicationManager/listLaunchPoints', launch: 'system.launcher/launch',
};
const STATE_TTL_MS = 10000, OFF_TTL_MS = 20000, LISTS_TTL_MS = 10 * 60 * 1000, ANSWER_MS = 4000;

// The packet that wakes a network card: six FF bytes, then its address sixteen times.
function magicPacket(mac) {
  const bytes = String(mac || '').split(/[:-]/).map((b) => parseInt(b, 16));
  if (bytes.length !== 6 || bytes.some((b) => !(b >= 0 && b <= 255))) throw new DeviceError(`"${mac}" is not a MAC address`);
  return Buffer.concat([Buffer.alloc(6, 0xff), ...Array(16).fill(Buffer.from(bytes))]);
}

// What the set answers -> the service's vocabulary.
function normalize({ power, volume, app, inputs = [], apps = [] }) {
  // "Active Standby" and "Suspend" answer on the network with the screen dark
  const on = !power || !power.state || power.state === 'Active' || power.state === 'Screen Off';
  if (!on) return { reachable: true, on: false };
  const v = volume && (volume.volumeStatus || volume), appId = (app && app.appId) || null;
  const input = inputs.find((i) => i.appId === appId), named = apps.find((a) => a.id === appId);
  return {
    reachable: true, on: true,
    volume: v && v.volume != null ? v.volume : null,
    muted: v ? !!(v.muteStatus ?? v.muted ?? v.mute) : null,
    source: input ? input.id : null,
    app: appId, appName: input ? input.label : named ? named.title : null,
  };
}

function create({ openSocket = ws.open, udp = dgram, now = Date.now, answerMs: patience = ANSWER_MS } = {}) {
  const sets = new Map();   // device id -> { socket, waiting, next, scheme, state, lists }
  const entry = (device) => {
    if (!sets.has(device.id)) sets.set(device.id, { socket: null, waiting: new Map(), next: 1, scheme: 0, state: null, lists: null });
    return sets.get(device.id);
  };

  // An open and registered socket to the set. `key` missing means a first pairing.
  function connect(device, options) {
    const set = entry(device);
    if (set.socket) return Promise.resolve(set);
    // several questions asked together share the one connection being made
    if (!set.connecting) set.connecting = dial(device, options).finally(() => { set.connecting = null; });
    return set.connecting;
  }
  async function dial(device, { key = device.key, onPrompt = null, answerMs = patience } = {}) {
    const set = entry(device);
    let socket = null, why = 'no answer';
    const fail = (reason) => {
      for (const w of set.waiting.values()) { clearTimeout(w.timer); w.reject(new DeviceError(`${device.name}: ${reason}`)); }
      set.waiting.clear();
      set.socket = null;
    };
    const onMessage = (text) => {
      let msg;
      try { msg = JSON.parse(text); } catch { return; }      // not ours to understand
      // the set is asking on its screen: the answer to the registration comes after, or never
      if (msg.type === 'response' && msg.payload && msg.payload.pairingType === 'PROMPT') { if (onPrompt) onPrompt(); return; }
      const w = set.waiting.get(msg.id);
      if (!w) return;
      set.waiting.delete(msg.id);
      clearTimeout(w.timer);
      if (msg.type === 'error') w.reject(new DeviceError(`${device.name}: ${msg.error || 'refused'}`));
      else w.resolve(msg.payload || {});
    };
    // the scheme that answered last is tried first
    for (const i of [set.scheme, 1 - set.scheme]) {
      const [scheme, port] = PORTS[i];
      try {
        socket = await openSocket(`${scheme}://${device.host}:${port}/`, { onMessage, onClose: fail, timeout: 2500 });
        set.scheme = i;
        break;
      } catch (e) {
        if (!(e instanceof DeviceError)) throw e;
        why = e.message;
      }
    }
    // no socket at all is a set that is off or away, which callers tell from a refusal
    if (!socket) throw Object.assign(new DeviceError(`${device.name}: ${why}`), { silent: true });
    set.socket = socket;
    const registered = new Promise((resolve, reject) => {
      const timer = setTimeout(() => { set.waiting.delete('register_0'); reject(new DeviceError(`${device.name}: ${key ? 'no answer to the registration' : 'pairing not accepted on the screen'}`)); }, answerMs);
      set.waiting.set('register_0', { resolve, reject, timer });
    });
    socket.send(JSON.stringify({ type: 'register', id: 'register_0', payload: { ...manifest, ...(key ? { 'client-key': key } : {}) } }));
    try {
      set.key = (await registered)['client-key'] || key;
    } catch (e) {
      socket.close();
      set.socket = null;
      throw e;
    }
    return set;
  }

  // The connection every question goes through. A set never paired is told how to be.
  function link(device) {
    if (!device.key) throw new DeviceError(`${device.name}: not paired (node house/pair-tv.js ${device.host})`);
    return connect(device);
  }
  async function ask(device, uri, payload = {}) {
    const set = await link(device), id = `v${set.next++}`;
    const answer = new Promise((resolve, reject) => {
      const timer = setTimeout(() => { set.waiting.delete(id); reject(new DeviceError(`${device.name}: no answer`)); }, patience);
      set.waiting.set(id, { resolve, reject, timer });
    });
    set.socket.send(JSON.stringify({ id, type: 'request', uri: `ssap://${uri}`, payload }));
    return answer;
  }
  // a question the set may not know (older firmware): its refusal is an answer, its silence on the network is not
  const maybe = (device, uri) => ask(device, uri).catch((e) => { if (!(e instanceof DeviceError) || e.silent) throw e; return null; });

  async function lists(device) {
    const set = entry(device);
    if (set.lists && now() - set.lists.at < LISTS_TTL_MS) return set.lists;
    const [inputs, apps] = await Promise.all([maybe(device, URI.inputs), device.apps ? maybe(device, URI.apps) : null]);
    set.lists = { at: now(), inputs: (inputs && inputs.devices) || [], apps: ((apps && apps.launchPoints) || []).filter((a) => device.apps.includes(a.id)) };
    return set.lists;
  }

  async function state(device) {
    const set = entry(device);
    if (set.state && now() - set.state.at < (set.state.value.on ? STATE_TTL_MS : OFF_TTL_MS)) return set.state.value;
    let value;
    try {
      await link(device);
      const [power, volume, app, l] = await Promise.all([maybe(device, URI.power), maybe(device, URI.volume), maybe(device, URI.app), lists(device)]);
      value = normalize({ power, volume, app, inputs: l.inputs, apps: l.apps });
    } catch (e) {
      if (!(e instanceof DeviceError) || !e.silent) throw e;
      // a set that is off does not answer: that is its state, not a failure
      value = { reachable: true, on: false };
    }
    set.state = { at: now(), value };
    return value;
  }

  async function capabilities(device) {
    const s = await state(device), caps = { on: { type: 'boolean' } };
    if (!s.on) return caps;
    const l = await lists(device), named = (rows, id, label) => Object.fromEntries(rows.map((r) => [r[id], r[label]]));
    if (s.volume != null) { caps.volume = { min: 0, max: 100, step: 1 }; caps.muted = { type: 'boolean' }; }
    if (l.inputs.length) caps.source = { options: l.inputs.map((i) => i.id), labels: named(l.inputs, 'id', 'label') };
    if (l.apps.length) caps.app = { options: l.apps.map((a) => a.id), labels: named(l.apps, 'id', 'title') };
    return caps;
  }

  function wake(device) {
    const packet = magicPacket(device.mac);
    return new Promise((resolve, reject) => {
      const socket = udp.createSocket('udp4');
      socket.on('error', (e) => { socket.close(); reject(new DeviceError(`${device.name}: ${e.message}`)); });
      socket.bind(() => {
        socket.setBroadcast(true);
        socket.send(packet, 9, device.broadcast || '255.255.255.255', (e) => { socket.close(); if (e) reject(new DeviceError(`${device.name}: ${e.message}`)); else resolve(); });
      });
    });
  }

  async function set(device, changes) {
    if (changes.on === true) {
      if (!device.mac) throw new DeviceError(`${device.name}: its "mac" is needed to turn it on`);
      await wake(device);
    }
    if (changes.volume != null) await ask(device, URI.setVolume, { volume: clamp(Math.round(changes.volume), 0, 100) });
    if (changes.muted != null) await ask(device, URI.setMute, { mute: !!changes.muted });
    if (changes.source != null) await ask(device, URI.setInput, { inputId: changes.source });
    if (changes.app != null) await ask(device, URI.launch, { id: changes.app });
    if (changes.on === false) await ask(device, URI.off);
    entry(device).state = null;
  }

  /* First contact: the set shows its question, and its key comes back once accepted. */
  async function pair(host, { waitMs = 60000, onPrompt = () => {} } = {}) {
    const device = { id: `pair:${host}`, name: host, host };
    const set = await connect(device, { key: null, onPrompt, answerMs: waitMs });
    set.socket.close();
    sets.delete(device.id);
    return set.key;
  }

  return { capabilities, state, set, pair, list: async () => [] };
}

module.exports = { create, normalize, magicPacket, URI };
