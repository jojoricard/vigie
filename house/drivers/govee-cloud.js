/* Govee lights through the cloud API. Off by default (house.govee.cloudFallback): only
 * for a lamp that has no LAN API, or until LAN Control is switched on. Needs an API key
 * and the internet, and answers slower than the LAN.
 * Config of a device: { sku, device } next to its govee-lan settings. */
const crypto = require('crypto');
const { DeviceError, request, parseJson, clamp } = require('../util');

const API = 'https://openapi.api.govee.com/router/api/v1';
const CAP_TYPE = {
  powerSwitch: 'devices.capabilities.on_off', brightness: 'devices.capabilities.range',
  colorRgb: 'devices.capabilities.color_setting', colorTemperatureK: 'devices.capabilities.color_setting',
};

/* What goes to Govee, and nothing else: the key, the model and the id of the lamp, and the
 * command. To keep it small the state of a lamp is asked once a minute at most, and the
 * lists of its scenes twice a day. */
const STATE_TTL_MS = 60000, CATALOG_TTL_MS = 12 * 3600 * 1000;
const EFFECTS = ['scene', 'diy', 'music'];

function create({ apiKey, fetch: fetchImpl = fetch, now = Date.now }) {
  const states = new Map();     // lamp id -> { at, state }
  const catalogs = new Map();   // lamp id -> { at, scene, diy, music }: each [{ name, type, instance, value }]
  const effects = new Map();    // lamp id -> { kind, name }: the last effect asked for, until a plain color replaces it
  let account = null;           // { at, list }: the devices of the account, with what each can do
  const headers = { 'Govee-API-Key': apiKey, 'content-type': 'application/json' };
  async function post(endpoint, payload) {
    const r = await request('Govee', API + endpoint, { method: 'POST', headers, body: JSON.stringify({ requestId: crypto.randomUUID(), payload }) }, fetchImpl);
    const j = parseJson('Govee', r.text);
    // Govee explains its refusals in `msg`
    if (!r.ok || (j.code != null && j.code !== 200)) throw new DeviceError('Govee: ' + (j.msg || j.message || r.status));
    return j;
  }

  async function devices() {
    if (account && now() - account.at < CATALOG_TTL_MS) return account.list;
    const r = await request('Govee', API + '/user/devices', { headers }, fetchImpl);
    const j = parseJson('Govee', r.text);
    if (!r.ok) throw new DeviceError('Govee: ' + (j.msg || j.message || r.status));
    account = { at: now(), list: j.data || [] };
    return account.list;
  }

  /* The scenes of Govee, the scenes made in the app (DIY) and the music modes of a lamp,
   * as the cloud lists them: each is applied by sending back what the list gave. A list
   * that fails is an empty list: the lamp keeps its plain controls. */
  async function catalog(device) {
    const hit = catalogs.get(device.device);
    if (hit && now() - hit.at < CATALOG_TTL_MS) return hit;
    const quiet = (p) => p.catch((e) => { if (e instanceof DeviceError) return null; throw e; });
    const out = { at: now(), scene: [], diy: [], music: [] };
    const add = (kind, name, type, instance, value) => {
      if (name == null || value == null || out[kind].some((o) => o.name === String(name))) return;
      out[kind].push({ name: String(name), type, instance, value });
    };
    for (const endpoint of ['/device/scenes', '/device/diy-scenes']) {
      const j = await quiet(post(endpoint, { sku: device.sku, device: device.device }));
      for (const c of (j && j.payload && j.payload.capabilities) || []) {
        const kind = c.instance === 'lightScene' ? 'scene' : c.instance === 'diyScene' ? 'diy' : null;
        if (kind) for (const o of (c.parameters && c.parameters.options) || []) add(kind, o.name, c.type, c.instance, o.value);
      }
    }
    const mine = ((await quiet(devices())) || []).find((d) => d.device === device.device);
    const music = mine && (mine.capabilities || []).find((c) => c.instance === 'musicMode');
    const modes = music && ((music.parameters && music.parameters.fields) || []).find((f) => f.fieldName === 'musicMode');
    for (const o of (modes && modes.options) || []) add('music', o.name, music.type, music.instance, o.value);
    catalogs.set(device.device, out);
    return out;
  }

  async function state(device) {
    const hit = states.get(device.device);
    if (hit && now() - hit.at < STATE_TTL_MS) return { ...hit.state };
    const fresh = await readState(device);
    states.set(device.device, { at: now(), state: fresh });
    return { ...fresh };
  }
  async function readState(device) {
    const j = await post('/device/state', { sku: device.sku, device: device.device });
    const caps = (j.payload && j.payload.capabilities) || [];
    const val = (instance) => { const c = caps.find((x) => x.instance === instance); return c && c.state ? c.state.value : null; };
    // offline (no power, no Wi-Fi): Govee then answers with the last values it knew, which say nothing of now
    if (val('online') === false) return { reachable: false, error: 'cloudOffline' };
    const kelvin = val('colorTemperatureK') || null;
    const out = { reachable: true, on: !!val('powerSwitch'), brightness: val('brightness'), colorRgb: kelvin ? null : val('colorRgb'), colorTempK: kelvin };
    // Govee does not say which effect plays: the last one asked for here is remembered
    const effect = effects.get(device.device);
    if (effect) out[effect.kind] = effect.name;
    return out;
  }

  async function set(device, changes) {
    const steps = [];
    if (changes.on != null) steps.push(['powerSwitch', changes.on ? 1 : 0]);
    if (changes.colorRgb != null) steps.push(['colorRgb', clamp(Number(changes.colorRgb) || 0, 0, 0xffffff)]);
    if (changes.colorTempK != null) steps.push(['colorTemperatureK', clamp(Math.round(Number(changes.colorTempK)), 2000, 9000)]);
    if (changes.brightness != null) steps.push(['brightness', clamp(Math.round(Number(changes.brightness)), 1, 100)]);
    states.delete(device.device);
    for (const [instance, value] of steps) {
      await post('/device/control', { sku: device.sku, device: device.device, capability: { type: CAP_TYPE[instance], instance, value } });
    }
    if (changes.colorRgb != null || changes.colorTempK != null) effects.delete(device.device);
    for (const kind of EFFECTS) {
      if (changes[kind] == null) continue;
      const option = (await catalog(device))[kind].find((o) => o.name === String(changes[kind]));
      if (!option) throw new DeviceError(`${device.name}: no such ${kind} "${changes[kind]}"`);
      // a music mode is a structure: the mode, how sensitive the microphone is, colors chosen by the lamp
      const value = kind === 'music' ? { musicMode: option.value, sensitivity: 50, autoColor: 1 } : option.value;
      await post('/device/control', { sku: device.sku, device: device.device, capability: { type: option.type, instance: option.instance, value } });
      effects.set(device.device, { kind, name: option.name });
    }
  }

  async function capabilities(device) {
    const caps = {
      on: { type: 'boolean' }, brightness: { min: 1, max: 100, step: 1 },
      colorRgb: { type: 'color' }, colorTempK: { min: 2000, max: 9000, step: 100 },
    };
    const lists = await catalog(device);
    for (const kind of EFFECTS) if (lists[kind].length) caps[kind] = { options: lists[kind].map((o) => o.name) };
    return caps;
  }

  const list = async () => (await devices()).map((d) => ({ driver: 'govee-cloud', device: d.device, sku: d.sku, name: d.deviceName }));

  return { capabilities, state, set, list };
}

module.exports = { create };
