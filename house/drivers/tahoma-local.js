/* Somfy shutters through the local API of a TaHoma box in developer mode: HTTPS on port
 * 8443 of the box, a bearer token made in the TaHoma app, no cloud. The box signs its
 * certificate with Overkiz's own authority, shipped here (overkiz-root-ca.pem): it is
 * checked at every request, TLS is never switched off.
 * Config of the module: house.tahoma = { host: "gateway-1234-5678-9012.local", token, pin: "1234-5678-9012" }
 *   `pin` is only needed when `host` is an IP address: the certificate names the box by its pin.
 * Config of a device: { driver: "tahoma-local", type: "cover", deviceURL: "io://1234-5678-9012/1234567" }
 * Shutters also move from their wall switches: the driver follows the events of the box
 * instead of trusting what it last asked for.
 * Position: the service counts how open a shutter is (0 closed, 100 open). The box
 * counts the closure the other way (core:ClosureState, 0 open, 100 closed): turned here. */
const fs = require('fs');
const https = require('https');
const path = require('path');
const { DeviceError, clamp } = require('../util');

const CA = fs.readFileSync(path.join(__dirname, 'overkiz-root-ca.pem'));
const API = '/enduser-mobile-web/1/enduserAPI';
const FETCH_MIN_MS = 1000;        // the box asks for one fetch of its events a second at most
const MOVES = ['open', 'close', 'stop', 'my'];

// One HTTPS request to the box, its certificate checked against Overkiz's authority.
function boxRequest({ host, pin, token }, method, route, body) {
  return new Promise((resolve, reject) => {
    const data = body == null ? null : JSON.stringify(body);
    const req = https.request({
      host, port: 8443, path: API + route, method, ca: CA, servername: pin ? `gateway-${pin}.local` : host, timeout: 8000,
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json', ...(data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {}) },
    }, (res) => {
      let text = '';
      res.on('data', (c) => (text += c));
      res.on('end', () => resolve({ status: res.statusCode, text }));
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', (e) => reject(new DeviceError(`tahoma: ${e.message}`)));
    req.end(data);
  });
}

const stateOf = (states, name) => { const s = (states || []).find((x) => x.name === name); return s ? s.value : null; };

// What the box says of a shutter -> the service's vocabulary.
function normalize(entry) {
  const closure = stateOf(entry.states, 'core:ClosureState'), status = stateOf(entry.states, 'core:StatusState');
  if (status === 'unavailable' || entry.available === false) return { reachable: false, error: 'unavailable on the box' };
  const out = { reachable: true, position: closure == null ? null : clamp(100 - Number(closure), 0, 100) };
  const moving = stateOf(entry.states, 'core:MovingState');
  if (moving != null) out.moving = !!moving;
  return out;
}

function create({ host, pin, token, request = boxRequest, now = Date.now } = {}) {
  const box = { host, pin, token };
  let devices = null;          // deviceURL -> { label, commands, states }
  let listener = null, lastFetch = -Infinity, loading = null;

  async function call(method, route, body) {
    const r = await request(box, method, route, body);
    if (r.status === 401) throw new DeviceError('tahoma: token refused (make a new one in the developer mode of the TaHoma app)');
    if (r.status >= 400) throw Object.assign(new DeviceError(`tahoma: HTTP ${r.status}`), { status: r.status });
    if (!r.text) return null;
    try { return JSON.parse(r.text); } catch { throw new DeviceError('tahoma: invalid JSON'); }
  }

  // Everything the box knows, then a listener for what changes afterwards.
  function load() {
    if (loading) return loading;
    loading = (async () => {
      const list = await call('GET', '/setup/devices');
      devices = new Map((list || []).map((d) => [d.deviceURL, { label: d.label, controllable: d.controllableName, available: d.available, commands: ((d.definition && d.definition.commands) || []).map((c) => c.commandName), states: d.states || [] }]));
      listener = (await call('POST', '/events/register')).id;
      lastFetch = now();
    })().finally(() => { loading = null; });
    return loading;
  }

  // The events since the last fetch: a shutter moved from its wall switch shows up here.
  async function follow() {
    if (!devices || !listener) return load();
    if (now() - lastFetch < FETCH_MIN_MS) return;
    lastFetch = now();
    let events;
    try {
      events = await call('POST', `/events/${listener}/fetch`);
    } catch (e) {
      // a listener nobody fetched for ten minutes is dropped by the box: start over
      if (!(e instanceof DeviceError) || !e.status) throw e;
      devices = null; listener = null;
      return load();
    }
    for (const ev of events || []) {
      const entry = devices.get(ev.deviceURL);
      if (!entry || !Array.isArray(ev.deviceStates)) continue;
      for (const s of ev.deviceStates) {
        const known = entry.states.find((x) => x.name === s.name);
        if (known) known.value = s.value; else entry.states.push({ name: s.name, value: s.value });
      }
    }
  }

  const entryOf = (device) => {
    const entry = devices.get(device.deviceURL);
    if (!entry) throw new DeviceError(`${device.name}: "${device.deviceURL}" is not a device of the box`);
    return entry;
  };

  return {
    async state(device) {
      await follow();
      return normalize(entryOf(device));
    },
    async capabilities(device) {
      if (!devices) await load();
      const entry = entryOf(device), caps = {};
      if (entry.commands.includes('setClosure') && stateOf(entry.states, 'core:ClosureState') != null) caps.position = { min: 0, max: 100, step: 1 };
      for (const move of MOVES) if (entry.commands.includes(move)) caps[move] = { type: 'action' };
      return caps;
    },
    async set(device, changes) {
      if (!devices) await load();
      entryOf(device);
      const commands = [];
      if (changes.position != null) commands.push({ name: 'setClosure', parameters: [100 - clamp(Math.round(changes.position), 0, 100)] });
      for (const move of MOVES) if (changes[move] === true) commands.push({ name: move, parameters: [] });
      if (!commands.length) return;
      await call('POST', '/exec/apply', { label: 'house', actions: [{ deviceURL: device.deviceURL, commands }] });
    },
    async list() {
      await load();
      return [...devices.entries()].map(([deviceURL, d]) => ({ deviceURL, label: d.label, controllable: d.controllable }));
    },
  };
}

module.exports = { create, normalize, CA };
