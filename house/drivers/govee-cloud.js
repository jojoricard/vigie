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

function create({ apiKey, fetch: fetchImpl = fetch }) {
  const headers = { 'Govee-API-Key': apiKey, 'content-type': 'application/json' };
  async function post(endpoint, payload) {
    const r = await request('Govee', API + endpoint, { method: 'POST', headers, body: JSON.stringify({ requestId: crypto.randomUUID(), payload }) }, fetchImpl);
    const j = parseJson('Govee', r.text);
    // Govee explains its refusals in `msg`
    if (!r.ok || (j.code != null && j.code !== 200)) throw new DeviceError('Govee: ' + (j.msg || j.message || r.status));
    return j;
  }

  async function state(device) {
    const j = await post('/device/state', { sku: device.sku, device: device.device });
    const caps = (j.payload && j.payload.capabilities) || [];
    const val = (instance) => { const c = caps.find((x) => x.instance === instance); return c && c.state ? c.state.value : null; };
    const kelvin = val('colorTemperatureK') || null;
    return { reachable: true, on: !!val('powerSwitch'), brightness: val('brightness'), colorRgb: kelvin ? null : val('colorRgb'), colorTempK: kelvin };
  }

  async function set(device, changes) {
    const steps = [];
    if (changes.on != null) steps.push(['powerSwitch', changes.on ? 1 : 0]);
    if (changes.colorRgb != null) steps.push(['colorRgb', clamp(Number(changes.colorRgb) || 0, 0, 0xffffff)]);
    if (changes.colorTempK != null) steps.push(['colorTemperatureK', clamp(Math.round(Number(changes.colorTempK)), 2000, 9000)]);
    if (changes.brightness != null) steps.push(['brightness', clamp(Math.round(Number(changes.brightness)), 1, 100)]);
    for (const [instance, value] of steps) {
      await post('/device/control', { sku: device.sku, device: device.device, capability: { type: CAP_TYPE[instance], instance, value } });
    }
  }

  const capabilities = async () => ({
    on: { type: 'boolean' }, brightness: { min: 1, max: 100, step: 1 },
    colorRgb: { type: 'color' }, colorTempK: { min: 2000, max: 9000, step: 100 },
  });

  async function list() {
    const r = await request('Govee', API + '/user/devices', { headers }, fetchImpl);
    const j = parseJson('Govee', r.text);
    if (!r.ok) throw new DeviceError('Govee: ' + (j.msg || j.message || r.status));
    return (j.data || []).map((d) => ({ driver: 'govee-cloud', device: d.device, sku: d.sku, name: d.deviceName }));
  }

  return { capabilities, state, set, list };
}

module.exports = { create };
