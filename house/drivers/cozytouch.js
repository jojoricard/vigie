/* Atlantic, Thermor and Sauter heaters through the Cozytouch cloud (Overkiz platform),
 * after the open-source pyoverkiz library and Home Assistant's overkiz integration.
 * Written for an electric towel dryer. Only created when house.cozytouch is configured.
 * Config of a device: { driver: "cozytouch", deviceURL: "io://…#1" } or { label }.
 *
 * Appliances with their own Wi-Fi, without a bridge, are not on Overkiz: the same
 * account reads them on Atlantic's newer API, after the open-source gduteil/cozytouch
 * integration. A device there has a number, and its state is a list of numbered
 * capabilities. Written for a water heater: { driver: "cozytouch", deviceId: 123456 }. */
const { DeviceError, request, parseJson, clamp } = require('../util');

const ATLANTIC_API = 'https://apis.groupe-atlantic.com';
// The three brands share one server.
const ENDPOINT = 'https://ha110-1.overkiz.com/enduser-mobile-web/enduserAPI/';
// Public client id of the Cozytouch mobile app, as published in pyoverkiz (const.py).
const CLIENT_ID = 'Q3RfMUpWeVRtSUxYOEllZkE3YVVOQmpGblpVYToyRWNORHpfZHkzNDJVSnFvMlo3cFNKTnZVdjBh';

const STATE = {
  mode: 'core:OperatingModeState', target: 'core:TargetTemperatureState', effective: 'io:EffectiveTemperatureSetpointState',
  temporary: 'io:TowelDryerTemporaryStateState', temperature: 'core:TemperatureState',
  window: 'core:OpenWindowDetectionActivationState', program: 'core:TimeProgramState',
};
const COMMAND = {
  mode: 'setTowelDryerOperatingMode', target: 'setTargetTemperature', derogated: 'setDerogatedTargetTemperature',
  temporary: 'setTowelDryerTemporaryState', window: 'setOpenWindowDetectionActivation', program: 'setTowelDryerTimeProgram',
};
// Overkiz operating mode <-> the service's: "external" is the manual mode, "internal" the
// weekly program stored in the heater, "auto" the program with presence detection.
const MODE = { standby: 'off', external: 'manual', internal: 'schedule', auto: 'auto' };
const MODE_PARAM = { off: 'standby', manual: 'external', schedule: 'internal', auto: 'auto' };
// The temperature probe is a sub-device of the heater, at index 7.
const SENSOR_INDEX = '7';
const STATES_TTL_MS = 60000;

const valuesOf = (states) => Object.fromEntries((states || []).map((s) => [s.name, s.value]));
const commandsOf = (dev) => new Set(((dev.definition && dev.definition.commands) || []).map((c) => c.commandName));

// A heater's states -> the service's vocabulary. `sensor` holds the states of its probe.
function normalize(states, sensor = {}) {
  const mode = MODE[states[STATE.mode]] || null;
  const temporary = states[STATE.temporary];
  const out = {
    reachable: true, on: mode !== 'off', mode,
    // in auto the heater follows its program: the setpoint in force is the "effective" one
    setpoint: mode === 'auto' && states[STATE.effective] != null ? states[STATE.effective] : states[STATE.target] ?? null,
    temperature: sensor[STATE.temperature] ?? states[STATE.temperature] ?? null,
  };
  if (temporary != null) { out.boost = temporary === 'boost'; out.drying = temporary === 'drying'; }
  if (states[STATE.window] != null) out.windowDetection = ['on', 'active', true].includes(states[STATE.window]);
  return out;
}

// Only what the heater declares it understands.
function capabilitiesOf(dev) {
  const has = commandsOf(dev), states = valuesOf(dev.states);
  const caps = {};
  if (has.has(COMMAND.mode)) { caps.on = { type: 'boolean' }; caps.mode = { options: ['off', 'manual', 'schedule', 'auto'] }; }
  if (has.has(COMMAND.target)) caps.setpoint = { min: 7, max: 28, step: 0.5 };
  if (has.has(COMMAND.temporary)) { caps.boost = { type: 'boolean' }; caps.drying = { type: 'boolean' }; }
  if (has.has(COMMAND.window) && states[STATE.window] != null) caps.windowDetection = { type: 'boolean' };
  if (has.has(COMMAND.program)) caps.schedule = { type: 'native' };
  return caps;
}

// Changes -> Overkiz commands. `states` is the current state of the heater.
function commandsFor(changes, states) {
  const out = [];
  const mode = changes.mode || (changes.on === false ? 'off' : changes.on === true && MODE[states[STATE.mode]] === 'off' ? 'manual' : null);
  if (mode) out.push({ name: COMMAND.mode, parameters: [MODE_PARAM[mode]] });
  if (changes.setpoint != null) {
    const auto = (mode || MODE[states[STATE.mode]]) === 'auto';
    out.push({ name: auto ? COMMAND.derogated : COMMAND.target, parameters: [clamp(Number(changes.setpoint), 7, 28)] });
  }
  // boost and drying are one "temporary state": leaving either goes back to plain heating
  if (changes.boost != null) out.push({ name: COMMAND.temporary, parameters: [changes.boost ? 'boost' : 'permanentHeating'] });
  if (changes.drying != null) out.push({ name: COMMAND.temporary, parameters: [changes.drying ? 'drying' : 'permanentHeating'] });
  if (changes.windowDetection != null) {
    // answered with the words the heater itself uses for this state
    const words = ['active', 'inactive'].includes(states[STATE.window]) ? ['active', 'inactive'] : ['on', 'off'];
    out.push({ name: COMMAND.window, parameters: [words[changes.windowDetection ? 0 : 1]] });
  }
  if (changes.schedule != null) out.push({ name: COMMAND.program, parameters: [changes.schedule] });
  return out;
}

/* ---- The newer cloud: a water heater ----
 * Capability numbers as the reference integration names them: 87 the mode, 165 the
 * boost, 227 or 152 the absence with its window in 226 or 222 as "[start,end]" in
 * seconds, 292 the showers asked for and 293 those left, 271 the share of hot water,
 * 265 the temperature at mid-height, 231 the setpoint, 59 the energy counter in Wh. */
const WATER = { mode: 87, boost: 165, away: [227, 152], window: [226, 222], showers: 292, showersLeft: 293, hotWater: 271, temperature: 265, setpoint: 231, energy: 59 };
const WATER_MODE = { 0: 'manual', 3: 'eco', 4: 'schedule' };
const WATER_MODE_VALUE = { manual: '0', eco: '3', schedule: '4' };
// What goes back with the absence when it is written on the account, and nothing else.
const SETUP_FIELDS = ['address', 'area', 'currency', 'mainHeatingEnergy', 'mainDHWEnergy', 'name', 'numberOfPersons', 'numberOfRooms', 'setupBuildingDate', 'type'];
const SHOWERS = { min: 1, max: 6, step: 1 };
const EXECUTION_DONE = 3, EXECUTION_POLLS = 6;

const capabilityValues = (dev) => Object.fromEntries((dev.capabilities || []).map((c) => [c.capabilityId, c.value]));
const present = (values, ids) => ids.find((id) => values[id] != null);

function normalizeWater(values) {
  const num = (id) => values[id] == null || values[id] === '' || !Number.isFinite(Number(values[id])) ? null : Number(values[id]);
  const away = present(values, WATER.away), window = present(values, WATER.window);
  const out = {
    reachable: true, on: true, mode: WATER_MODE[values[WATER.mode]] || null,
    showers: num(WATER.showers), showersLeft: num(WATER.showersLeft), hotWater: num(WATER.hotWater),
    temperature: num(WATER.temperature), setpoint: num(WATER.setpoint),
  };
  if (values[WATER.boost] != null) out.boost = ['1', 'true'].includes(String(values[WATER.boost]));
  if (away != null) {
    const [from, to] = String(values[window] ?? '').replace(/[[\]\s]/g, '').split(',').map(Number);
    // "2" is an absence set for later: it counts, and says so
    out.away = String(values[away]) !== '0' && from > 0 && to > 0
      ? { from: new Date(from * 1000).toISOString(), to: new Date(to * 1000).toISOString(), pending: String(values[away]) === '2' } : null;
  }
  if (num(WATER.energy) != null) out.energyKwh = Math.round(num(WATER.energy) / 100) / 10;
  return out;
}

function waterCapabilities(values) {
  const caps = {};
  if (values[WATER.mode] != null) caps.mode = { options: ['manual', 'eco', ...(String(values[WATER.mode]) === '4' ? ['schedule'] : [])] };
  if (values[WATER.showers] != null) caps.showers = { ...SHOWERS };
  if (values[WATER.boost] != null) caps.boost = { type: 'boolean' };
  if (present(values, WATER.away) != null) caps.away = { type: 'period' };
  return caps;
}

// Changes -> capability writes, in order. `away` is { from, to } as dates, or null to end it.
function waterWrites(changes, values, at = Date.now()) {
  const out = [];
  if (changes.mode != null) out.push([WATER.mode, WATER_MODE_VALUE[changes.mode]]);
  if (changes.showers != null) out.push([WATER.showers, String(Math.round(changes.showers))]);
  if (changes.boost != null) out.push([WATER.boost, changes.boost ? '1' : '0']);
  if (changes.away !== undefined) {
    const period = awayPeriod(changes.away);
    out.push([present(values, WATER.window), period ? `[${period[0]},${period[1]}]` : '[0,0]']);
    out.push([present(values, WATER.away), !period ? '0' : period[0] * 1000 > at ? '2' : '1']);
  }
  return out.filter(([id]) => id != null);
}

// { from, to } -> [start, end] in seconds, null for no absence. A window that ends before it starts is refused.
function awayPeriod(away) {
  if (away == null) return null;
  const from = Math.floor(Date.parse(away.from) / 1000), to = Math.floor(Date.parse(away.to) / 1000);
  if (!Number.isFinite(from) || !Number.isFinite(to) || to <= from) throw new RangeError('"away" needs a "from" and a later "to"');
  return [from, to];
}

function create({ username, password, fetch: fetchImpl = fetch, now = Date.now, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) }) {
  let cookie = null;
  let setup = { at: -Infinity, devices: [] };
  const statesCache = new Map();   // deviceURL -> { at, values }

  const form = (o) => new URLSearchParams(o).toString();
  const FORM = { 'content-type': 'application/x-www-form-urlencoded' };

  // Three steps: an Atlantic token, a JWT for it, then the Overkiz session cookie.
  async function login() {
    const t = await request('Cozytouch', `${ATLANTIC_API}/token`, {
      method: 'POST', headers: { ...FORM, authorization: `Basic ${CLIENT_ID}` },
      body: form({ grant_type: 'password', username: `GA-PRIVATEPERSON/${username}`, password }),
    }, fetchImpl);
    const token = parseJson('Cozytouch', t.text);
    if (token.error === 'invalid_grant') throw new DeviceError('Cozytouch: wrong email or password');
    if (!token.access_token) throw new DeviceError(`Cozytouch: no token (HTTP ${t.status})`);
    const j = await request('Cozytouch', `${ATLANTIC_API}/magellan/accounts/jwt`, { headers: { authorization: `Bearer ${token.access_token}` } }, fetchImpl);
    const jwt = j.text.trim().replace(/^"|"$/g, '');
    if (!j.ok || !jwt) throw new DeviceError(`Cozytouch: no JWT (HTTP ${j.status})`);
    const l = await request('Cozytouch', `${ENDPOINT}login`, { method: 'POST', headers: FORM, body: form({ jwt }) }, fetchImpl);
    const session = (l.headers.getSetCookie ? l.headers.getSetCookie() : []).map((c) => c.split(';')[0]).join('; ');
    if (!l.ok || !session) throw new DeviceError(`Cozytouch: login refused (HTTP ${l.status})`);
    cookie = session;
  }

  // An expired session answers 401: one new login, then the same call again.
  async function api(method, path, body) {
    if (!cookie) await login();
    const once = () => request('Cozytouch', ENDPOINT + path, {
      method, headers: { cookie, ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined,
    }, fetchImpl);
    let r = await once();
    if (r.status === 401) { await login(); r = await once(); }
    if (!r.ok) throw new DeviceError(`Cozytouch: HTTP ${r.status} on ${path.split('/')[0]}`);
    return r.text ? parseJson('Cozytouch', r.text) : null;
  }

  /* The newer cloud: one token, one call that returns every device with its values. */
  let bearer = { token: null, until: 0 }, home = { at: -Infinity, setup: null };
  async function newer(method, path, body) {
    if (!bearer.token || now() >= bearer.until) {
      const t = await request('Cozytouch', `${ATLANTIC_API}/users/token`, {
        method: 'POST', headers: { ...FORM, authorization: `Basic ${CLIENT_ID}` },
        body: form({ grant_type: 'password', scope: 'openid', username: `GA-PRIVATEPERSON/${username}`, password }),
      }, fetchImpl);
      const token = parseJson('Cozytouch', t.text);
      if (token.error === 'invalid_grant') throw new DeviceError('Cozytouch: wrong email or password');
      if (!token.access_token) throw new DeviceError(`Cozytouch: no token (HTTP ${t.status})`);
      bearer = { token: token.access_token, until: now() + ((token.expires_in || 3600) - 60) * 1000 };
    }
    const r = await request('Cozytouch', `${ATLANTIC_API}/magellan/${path}`, {
      method, headers: { authorization: `Bearer ${bearer.token}`, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined,
    }, fetchImpl);
    if (r.status === 401) bearer.token = null;
    if (!r.ok) throw new DeviceError(`Cozytouch: HTTP ${r.status} on ${path.split('/')[0]}`);
    return r.text ? parseJson('Cozytouch', r.text) : null;
  }
  async function homeSetup() {
    if (now() - home.at > STATES_TTL_MS) {
      const list = await newer('GET', 'cozytouch/setupviewv2');
      if (!Array.isArray(list) || !list.length) throw new DeviceError('Cozytouch: no home on the account');
      home = { at: now(), setup: list[0] };
    }
    return home.setup;
  }
  async function findNewer(device) {
    const dev = ((await homeSetup()).devices || []).find((d) => String(d.deviceId) === String(device.deviceId));
    if (!dev) throw new DeviceError(`${device.name}: not found in the Cozytouch account`);
    return dev;
  }
  // A write is an execution on Atlantic's side: it is done once it says so.
  async function write(deviceId, capabilityId, value) {
    const id = await newer('POST', 'executions/writecapability', { capabilityId, deviceId, value });
    for (let i = 0; i < EXECUTION_POLLS; i++) {
      const execution = await newer('GET', `executions/${encodeURIComponent(id)}`);
      if (execution && execution.state === EXECUTION_DONE) return;
      if (execution && execution.state > EXECUTION_DONE) throw new DeviceError(`Cozytouch: the command was refused (state ${execution.state})`);
      await sleep(1000);
    }
    throw new DeviceError('Cozytouch: the command did not complete');
  }
  async function setNewer(device, changes) {
    const dev = await findNewer(device), setup = await homeSetup();
    if (changes.away !== undefined) {
      // the absence belongs to the home: the account takes it first, then the heater mirrors it
      const period = awayPeriod(changes.away);
      await newer('PUT', `v2/setups/${encodeURIComponent(setup.id)}`, {
        ...Object.fromEntries(SETUP_FIELDS.filter((k) => k in setup).map((k) => [k, setup[k]])),
        absence: period ? { startDate: period[0], endDate: period[1] } : {},
      });
    }
    for (const [capabilityId, value] of waterWrites(changes, capabilityValues(dev), now())) await write(dev.deviceId, capabilityId, value);
    home.at = -Infinity;
  }

  async function devices() {
    if (now() - setup.at > 5 * 60 * 1000) setup = { at: now(), devices: (await api('GET', 'setup')).devices || [] };
    return setup.devices;
  }
  async function find(device) {
    const dev = (await devices()).find((d) => device.deviceURL ? d.deviceURL === device.deviceURL : d.label === device.label);
    if (!dev) throw new DeviceError(`${device.name}: not found in the Cozytouch account`);
    return dev;
  }

  async function states(deviceURL) {
    const cached = statesCache.get(deviceURL);
    if (cached && now() - cached.at < STATES_TTL_MS) return cached.values;
    const values = valuesOf(await api('GET', `setup/devices/${encodeURIComponent(deviceURL)}/states`));
    statesCache.set(deviceURL, { at: now(), values });
    return values;
  }

  async function state(device) {
    if (device.deviceId != null) return normalizeWater(capabilityValues(await findNewer(device)));
    const dev = await find(device);
    const sensorURL = dev.deviceURL.replace(/#\d+$/, '#' + SENSOR_INDEX);
    const hasSensor = sensorURL !== dev.deviceURL && (await devices()).some((d) => d.deviceURL === sensorURL);
    const [own, sensor] = await Promise.all([states(dev.deviceURL), hasSensor ? states(sensorURL) : {}]);
    const out = normalize(own, sensor);
    // The weekly program lives in the heater: handed over as the heater gives it.
    if (own[STATE.program] != null) out.schedule = own[STATE.program];
    return out;
  }

  async function set(device, changes) {
    if (device.deviceId != null) return setNewer(device, changes);
    const dev = await find(device);
    const commands = commandsFor(changes, await states(dev.deviceURL));
    if (!commands.length) return;
    await api('POST', 'exec/apply', { label: 'house', actions: [{ deviceURL: dev.deviceURL, commands }] });
    statesCache.delete(dev.deviceURL);
  }

  const capabilities = async (device) => device.deviceId != null ? waterCapabilities(capabilityValues(await findNewer(device))) : capabilitiesOf(await find(device));

  // Every device of the account, on both clouds, to fill the config. An account may
  // have nothing on one of them: that one is then left out, not an error.
  const quiet = (p) => p.catch((e) => { if (!(e instanceof DeviceError)) throw e; return null; });
  async function list() {
    const [old, recent] = await Promise.all([quiet(devices()), quiet(homeSetup())]);
    if (!old && !recent) await devices();     // both failed: say why
    return [
      ...(old || []).map((d) => ({ driver: 'cozytouch', deviceURL: d.deviceURL, label: d.label, widget: d.widget || d.controllableName })),
      ...((recent && recent.devices) || []).map((d) => ({ driver: 'cozytouch', deviceId: d.deviceId, label: d.name, model: d.modelId, capabilities: (d.capabilities || []).map((c) => c.capabilityId) })),
    ];
  }

  return { capabilities, state, set, list };
}

module.exports = { create, normalize, capabilitiesOf, commandsFor, normalizeWater, waterCapabilities, waterWrites, awayPeriod };
