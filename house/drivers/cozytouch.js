/* Atlantic, Thermor and Sauter heaters through the Cozytouch cloud (Overkiz platform),
 * after the open-source pyoverkiz library and Home Assistant's overkiz integration.
 * Written for an electric towel dryer. Only created when house.cozytouch is configured.
 * Config of a device: { driver: "cozytouch", deviceURL: "io://…#1" } or { label }. */
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

function create({ username, password, fetch: fetchImpl = fetch, now = Date.now }) {
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
    const dev = await find(device);
    const commands = commandsFor(changes, await states(dev.deviceURL));
    if (!commands.length) return;
    await api('POST', 'exec/apply', { label: 'house', actions: [{ deviceURL: dev.deviceURL, commands }] });
    statesCache.delete(dev.deviceURL);
  }

  const capabilities = async (device) => capabilitiesOf(await find(device));

  // Every device of the account, to fill the config.
  const list = async () => (await devices()).map((d) => ({ driver: 'cozytouch', deviceURL: d.deviceURL, label: d.label, widget: d.widget || d.controllableName }));

  return { capabilities, state, set, list };
}

module.exports = { create, normalize, capabilitiesOf, commandsFor };
