/* LG appliances through the official ThinQ Connect API, after LG's own open-source
 * client (pythinqconnect). Cloud only: the account's personal access token, made on
 * https://connect-pat.lgthinq.com, is the one credential. Only created when
 * house.lgThinq is configured: { token, country: "FR", region: "eic" }.
 * Written for a washer-dryer: its state, the time left and the end of the cycle. The
 * API does not say which program runs. A cycle is started from here only when the
 * machine was left waiting for it (Remote Start pressed on its panel).
 * Config of a device: { driver: "lg-thinq", deviceId: "…" }. */
const crypto = require('crypto');
const { DeviceError, request, parseJson } = require('../util');

// Public key of LG's client, as published in pythinqconnect (const.py).
const API_KEY = 'v6GFvkweNo7DK7yD3ylIZ9w52aKBU0eJ7wLXkSR3';
const STATE_TTL_MS = 60000;

// What the machine calls its state -> the service's. Anything else is a step of a cycle.
const RUN = { POWER_OFF: 'off', SLEEP: 'off', INITIAL: 'idle', PAUSE: 'paused', RESERVED: 'scheduled', END: 'done', ERROR: 'error' };
const minutes = (h, m) => h == null && m == null ? null : (h || 0) * 60 + (m || 0);

// A washer answers with one block per drum: the one asked for, or the main one.
const drum = (body, location = 'MAIN') => Array.isArray(body)
  ? body.find((b) => b.location && b.location.locationName === location) || body[0] || {}
  : body || {};

function normalize(body, { location, at = Date.now() } = {}) {
  const s = drum(body, location), raw = (s.runState || {}).currentState || null, timer = s.timer || {};
  const run = raw == null ? null : RUN[raw] || 'running';
  const left = minutes(timer.remainHour, timer.remainMinute), total = minutes(timer.totalHour, timer.totalMinute);
  const out = {
    reachable: true, on: run !== 'off' && run !== null, run,
    // the step of a cycle, in the machine's own word: detecting, rinsing, spinning, drying…
    phase: run === 'running' ? raw.toLowerCase() : null,
    remoteStart: !!(s.remoteControlEnable || {}).remoteControlEnabled,
  };
  if (run === 'running' || run === 'paused') {
    out.remainingMin = left;
    out.totalMin = total;
    if (left != null && run === 'running') out.endsAt = new Date(at + left * 60000).toISOString();
  }
  return out;
}

function create({ token, country = 'FR', region = 'eic', clientId, fetch: fetchImpl = fetch, now = Date.now }) {
  const base = `https://api-${region}.lgthinq.com/`;
  // the API wants one stable id per client: derived from the token, so nothing is stored
  const client = clientId || `vigie-${crypto.createHash('sha256').update(String(token)).digest('hex').slice(0, 32)}`;
  const cache = new Map();   // deviceId -> { at, body }

  async function api(method, path, body) {
    const r = await request('LG ThinQ', base + path, {
      method, body: body ? JSON.stringify(body) : undefined,
      headers: {
        authorization: `Bearer ${token}`, 'x-country': country, 'x-client-id': client, 'x-api-key': API_KEY, 'x-service-phase': 'OP',
        'x-message-id': crypto.randomBytes(16).toString('base64url'),
        ...(body ? { 'content-type': 'application/json', 'x-conditional-control': 'true' } : {}),
      },
    }, fetchImpl);
    const payload = parseJson('LG ThinQ', r.text || '{}');
    if (!r.ok) {
      const error = payload.error || {};
      throw new DeviceError(`LG ThinQ: ${error.message || `HTTP ${r.status}`}${error.code ? ` (${error.code})` : ''}`);
    }
    return payload.response;
  }

  async function read(device) {
    const cached = cache.get(device.deviceId);
    if (cached && now() - cached.at < STATE_TTL_MS) return cached.body;
    const body = await api('GET', `devices/${encodeURIComponent(device.deviceId)}/state`);
    cache.set(device.deviceId, { at: now(), body });
    return body;
  }

  const state = async (device) => normalize(await read(device), { location: device.location, at: now() });

  // Starting is only offered while the machine waits for it.
  async function capabilities(device) {
    const s = await state(device);
    return s.remoteStart && (s.run === 'idle' || s.run === 'paused' || s.run === 'scheduled') ? { start: { type: 'action' } } : {};
  }

  async function set(device, changes) {
    if (changes.start !== true) return;
    await api('POST', `devices/${encodeURIComponent(device.deviceId)}/control`, { location: { locationName: device.location || 'MAIN' }, operation: { washerOperationMode: 'START' } });
    cache.delete(device.deviceId);
  }

  // Every appliance of the account, to fill the config.
  const list = async () => ((await api('GET', 'devices')) || []).map((d) => ({
    driver: 'lg-thinq', deviceId: d.deviceId, name: (d.deviceInfo || {}).alias, model: (d.deviceInfo || {}).modelName, kind: (d.deviceInfo || {}).deviceType,
  }));

  return { capabilities, state, set, list };
}

module.exports = { create, normalize };
