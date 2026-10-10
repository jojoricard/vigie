/* House: Govee lights (cloud API) and Daikin air conditioners (local API).
 * The only part that acts on real hardware. Every device sent by the page is
 * checked against the list known on the server, and a control error goes back to
 * the page as is. */
const http = require('http');
const crypto = require('crypto');                // global only from Node 19
const ctx = require('./context');
const { SourceError, request, fetchJson, parseJson, orNull } = require('./errors');

/* ---------- Govee ---------- */
const GOVEE_API = 'https://openapi.api.govee.com/router/api/v1';
const GOVEE_CAP_TYPE = {
  powerSwitch: 'devices.capabilities.on_off',
  brightness: 'devices.capabilities.range',
  colorRgb: 'devices.capabilities.color_setting',
  colorTemperatureK: 'devices.capabilities.color_setting',
  lightScene: 'devices.capabilities.dynamic_scene',
  diyScene: 'devices.capabilities.dynamic_scene',
};
const goveeHeaders = () => ({ 'Govee-API-Key': ctx.cfg.goveeApiKey, 'content-type': 'application/json' });
const goveePost = (endpoint, payload) => fetchJson(`${GOVEE_API}${endpoint}`, {
  method: 'POST', headers: goveeHeaders(), body: JSON.stringify({ requestId: crypto.randomUUID(), payload }), timeout: 8000,
});

let goveeCache = { at: 0, data: [] };
async function goveeDevices() {
  if (!ctx.cfg.goveeApiKey) return [];
  if (goveeCache.data.length && Date.now() - goveeCache.at < 5 * 60 * 1000) return goveeCache.data;
  const j = await orNull('Govee', () => fetchJson(`${GOVEE_API}/user/devices`, { headers: goveeHeaders(), timeout: 8000 }));
  if (j && j.data && j.data.length) goveeCache = { at: Date.now(), data: j.data };
  return goveeCache.data;
}

async function goveeState(sku, device) {
  const j = await orNull('Govee', () => goveePost('/device/state', { sku, device }));
  const caps = (j && j.payload && j.payload.capabilities) || [];
  const val = (instance) => { const c = caps.find((x) => x.instance === instance); return c && c.state ? c.state.value : null; };
  return { on: j ? !!val('powerSwitch') : null, brightness: val('brightness'), colorRgb: val('colorRgb'), colorTemperatureK: val('colorTemperatureK') };
}

// /user/devices doesn't list scenes: separate call, cached 1 h since they rarely
// change. Presets and custom scenes (Govee app) are two endpoints, merged.
async function goveeSceneList(endpoint, sku, device) {
  const j = await orNull('Govee', () => goveePost(endpoint, { sku, device }));
  const cap = j && j.payload && j.payload.capabilities && j.payload.capabilities[0];
  return ((cap && cap.parameters && cap.parameters.options) || []).map((o) => ({ name: o.name, id: o.value.id, paramId: o.value.paramId }));
}
const goveeSceneCache = new Map();
async function goveeScenes(sku, device) {
  const key = sku + '|' + device;
  const cached = goveeSceneCache.get(key);
  if (cached && Date.now() - cached.at < 60 * 60 * 1000) return cached.data;
  const [preset, diy] = await Promise.all([goveeSceneList('/device/scenes', sku, device), goveeSceneList('/device/diy-scenes', sku, device)]);
  const list = [...preset, ...diy.map((s) => ({ ...s, diy: true }))];
  if (list.length) goveeSceneCache.set(key, { at: Date.now(), data: list });
  return list.length ? list : (cached && cached.data) || [];
}

const isKnownGovee = async (device, sku) => (await goveeDevices()).some((d) => d.device === device && d.sku === sku);

// Govee answers errors with a JSON body whose `msg` explains them: keep it.
async function goveeControl(device, sku, instance, value) {
  const url = `${GOVEE_API}/device/control`;
  const r = await request(url, {
    method: 'POST', headers: goveeHeaders(), timeout: 8000,
    body: JSON.stringify({ requestId: crypto.randomUUID(), payload: { sku, device, capability: { type: GOVEE_CAP_TYPE[instance], instance, value } } }),
  });
  const j = parseJson(r.text, url);
  if (!r.ok || j.code !== 200) throw new SourceError('Govee: ' + (j.msg || r.status));
}

/* ---------- Daikin ----------
 * The local API (BRP069/BRP072) answers "key=value,key=value", never JSON. */
function daikinParse(text) {
  const out = {};
  for (const kv of (text || '').split(',')) {
    const i = kv.indexOf('=');
    if (i > 0) out[kv.slice(0, i)] = kv.slice(i + 1);
  }
  return out;
}
// fetch() (undici) gets a 403 from these units: their embedded server rejects the
// "Host: ip:80" sent by default. The native http module works.
function daikinCall(ip, urlPath) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: ip, port: 80, path: urlPath, method: 'GET', headers: { Host: ip }, timeout: 4000 }, (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => {
        const j = daikinParse(body);
        if (j.ret !== 'OK') return reject(new SourceError(`Daikin ${ip}: ret=${j.ret}`));
        resolve(j);
      });
    });
    req.on('timeout', () => req.destroy(new SourceError(`Daikin ${ip}: timeout`)));
    req.on('error', (e) => reject(e instanceof SourceError ? e : new SourceError(`Daikin ${ip}: ${e.message}`)));
    req.end();
  });
}

// Values accepted by set_control_info (documented by pydaikin / Home Assistant).
const DAIKIN_VALUES = {
  mode: new Set(['0', '2', '3', '4', '6']),               // auto, dry, cool, heat, fan
  f_rate: new Set(['A', 'B', '3', '4', '5', '6', '7']),   // auto, quiet, levels 1-5
  f_dir: new Set(['0', '1', '2', '3']),                   // fixed, vertical, horizontal, 3D
};
const isKnownDaikin = (name) => (ctx.cfg.daikin || []).some((u) => u.name === name);

// set_control_info expects the full set of fields: leaving one out resets it. We
// read the current state and only change the requested, valid fields.
async function daikinControl(name, changes) {
  const unit = ctx.cfg.daikin.find((u) => u.name === name);
  const cur = await daikinCall(unit.ip, '/aircon/get_control_info');
  const pick = (field) => changes[field] != null && DAIKIN_VALUES[field].has(String(changes[field])) ? String(changes[field]) : cur[field];
  const merged = {
    pow: changes.pow != null ? String(changes.pow) : cur.pow,
    mode: pick('mode'),
    stemp: changes.stemp != null ? Math.min(30, Math.max(18, Number(changes.stemp))) : cur.stemp,
    shum: cur.shum, f_rate: pick('f_rate'), f_dir: pick('f_dir'),
  };
  await daikinCall(unit.ip, '/aircon/set_control_info?' + new URLSearchParams(merged).toString());
}

async function daikinUnit(u) {
  try {
    const [info, sensor] = await Promise.all([
      daikinCall(u.ip, '/aircon/get_control_info'),
      // the room temperature is a bonus: the unit still shows without it
      daikinCall(u.ip, '/aircon/get_sensor_info').catch((e) => { if (!(e instanceof SourceError)) throw e; return null; }),
    ]);
    return {
      name: u.name, reachable: true, on: info.pow === '1', targetTemp: Number(info.stemp),
      mode: info.mode, f_rate: info.f_rate, f_dir: info.f_dir,
      ambientTemp: sensor && sensor.htemp ? Number(sensor.htemp) : null,
    };
  } catch (e) {
    if (!(e instanceof SourceError)) throw e;
    return { name: u.name, reachable: false };
  }
}

let houseCache = { at: 0, data: null };
async function house() {
  if (houseCache.data && Date.now() - houseCache.at < 20000) return houseCache.data;
  const govee = await goveeDevices();
  const [lights, daikin] = await Promise.all([
    Promise.all(govee.map(async (d) => ({ device: d.device, sku: d.sku, name: d.deviceName, ...(await goveeState(d.sku, d.device)) }))),
    Promise.all((ctx.cfg.daikin || []).map(daikinUnit)),
  ]);
  houseCache = { at: Date.now(), data: { govee: lights, daikin } };
  return houseCache.data;
}
const invalidateHouse = () => { houseCache.at = 0; };

module.exports = { GOVEE_CAP_TYPE, goveeScenes, goveeControl, isKnownGovee, daikinControl, isKnownDaikin, house, invalidateHouse };
