/* The house service: rooms, their devices, ambiances and scenes behind one JSON API
 * (see API.md). It knows nothing of HTTP sockets (server.js) nor of the brands
 * (drivers/): a route is a function of the method, the path and the body.
 * A driver is { capabilities(device), state(device), set(device, changes), list() },
 * all in the service's vocabulary: adding a brand means adding a driver. */
const crypto = require('crypto');
const { DeviceError, clamp } = require('./util');
const { PlanError } = require('./plan');

const VERSION = 1;
const STATE_TTL_MS = 15000;      // several clients polling together cost one read per device
const LIGHT_PRESET = ['brightness', 'colorRgb', 'colorTempK'];

const isLoopback = (host) => host === '127.0.0.1' || host === 'localhost' || host === '::1' || host === '[::1]';

function sameToken(given, expected) {
  const a = Buffer.from(String(given || '')), b = Buffer.from(String(expected || ''));
  return a.length === b.length && b.length > 0 && crypto.timingSafeEqual(a, b);
}

/* Who may call. A service that only listens on the machine itself trusts it, as Vigie's
 * agent does. Anywhere else the bearer token is required on every request. A page of
 * another site is refused unless it holds the token: a browser sends a POST before
 * anything can stop it. */
function authorize({ token, open }, { authorization, origin }) {
  const bearer = /^Bearer (.+)$/.exec(authorization || '');
  const trusted = bearer && sameToken(bearer[1], token);
  if (!open && !trusted) return 401;
  if (origin && !trusted) {
    if (!URL.canParse(origin) || !isLoopback(new URL(origin).hostname)) return 403;
  }
  return 0;
}

/* `readPlan(deviceIds)` gives the floor plan, or is missing when none is configured.
 * `home()` gives what belongs to no room (who is in, the state of the line), when a
 * module reads it. `modules` describes every integration and where it stands; a device
 * whose module is known but not active is left out altogether: a module waiting for its
 * hardware or its account shows nothing and asks nothing. */
function createService(cfg = {}, drivers = {}, { readPlan = null, home = null, modules = [] } = {}) {
  const waiting = new Set(modules.filter((m) => m.state !== 'active').map((m) => m.id));
  const rooms = (cfg.rooms || []).map((room) => ({ ...room, devices: (room.devices || []).filter((d) => !waiting.has(d.driver)) }));
  const devices = new Map();
  for (const room of rooms) for (const d of room.devices) devices.set(d.id, { ...d, room: room.id });
  const ambiances = cfg.ambiances || [];
  const scenes = cfg.scenes || [];
  const cache = new Map();   // device id -> { at, view }

  /* The driver that answers for a device. A Govee lamp silent on the LAN goes through
   * the cloud when the fallback is on and the lamp has what the cloud needs. */
  const driverOf = (device) => drivers[device.driver] || null;
  const cloudFor = (device) => device.driver === 'govee-lan' && device.sku && drivers['govee-cloud'] ? drivers['govee-cloud'] : null;

  async function read(device) {
    const driver = driverOf(device);
    if (!driver) return { capabilities: {}, state: { reachable: false, error: `no driver "${device.driver}"` } };
    try {
      let via = driver;
      let state = await driver.state(device);
      if (!state.reachable && cloudFor(device)) {
        // the cloud only stands in for a lamp it reaches. One it has lost too has no power: what the
        // cloud remembers of it (on, at 60 %) is its past, and the lamp stays silent rather than lit
        const cloud = await cloudFor(device).state(device).catch((e) => { if (e instanceof DeviceError) return { reachable: false }; throw e; });
        if (cloud.reachable) { via = cloudFor(device); state = { ...cloud, via: 'cloud' }; }
        // the cloud says it has lost the lamp: a better word than silence on a LAN it never listens to
        else if (cloud.error === 'cloudOffline') state = { reachable: false, error: 'cloudOffline', via: 'cloud' };
      }
      return { capabilities: state.reachable ? await via.capabilities(device) : {}, state };
    } catch (e) {
      if (!(e instanceof DeviceError)) throw e;
      return { capabilities: {}, state: { reachable: false, error: e.message } };
    }
  }

  async function view(device, fresh = false) {
    const cached = cache.get(device.id);
    if (!fresh && cached && Date.now() - cached.at < STATE_TTL_MS) return cached.view;
    const { capabilities, state } = await read(device);
    const v = { id: device.id, name: device.name, type: device.type, driver: device.driver, room: device.room, capabilities, state };
    cache.set(device.id, { at: Date.now(), view: v });
    return v;
  }

  async function roomView(room) {
    const list = await Promise.all((room.devices || []).map((d) => view(devices.get(d.id))));
    // The temperature of a room comes from a sensor of its own, never from the probe of
    // an air conditioner, which reads several degrees high.
    const sensor = list.find((d) => d.type === 'sensor' && d.state.reachable && d.state.temperature != null);
    return { id: room.id, name: room.name, temperature: sensor ? sensor.state.temperature : null, humidity: sensor ? sensor.state.humidity ?? null : null, devices: list };
  }

  // An ambiance is a light preset: it is expanded before anything else is checked.
  function expand(changes) {
    if (changes.ambiance == null) return changes;
    const a = ambiances.find((x) => x.id === changes.ambiance);
    if (!a) throw new RangeError(`unknown ambiance "${changes.ambiance}"`);
    const { ambiance, ...rest } = changes;
    return { on: true, ...Object.fromEntries(LIGHT_PRESET.filter((k) => a[k] != null).map((k) => [k, a[k]])), ...rest };
  }

  // Only what the device can do, with values of the right kind. Numbers are brought back
  // into their range, as a slider would.
  function validate(changes, caps) {
    const out = {};
    for (const [key, value] of Object.entries(changes)) {
      const cap = caps[key];
      if (!cap) throw new RangeError(`"${key}" is not a capability of this device`);
      if (cap.type === 'boolean') {
        if (typeof value !== 'boolean') throw new RangeError(`"${key}" must be true or false`);
        out[key] = value;
      } else if (cap.options) {
        if (!cap.options.includes(String(value))) throw new RangeError(`"${key}" must be one of ${cap.options.join(', ')}`);
        out[key] = String(value);
      } else if (cap.min != null) {
        if (!Number.isFinite(Number(value))) throw new RangeError(`"${key}" must be a number`);
        out[key] = clamp(Number(value), cap.min, cap.max);
      } else if (cap.type === 'color') {
        if (!Number.isInteger(value) || value < 0 || value > 0xffffff) throw new RangeError(`"${key}" must be an RGB integer`);
        out[key] = value;
      } else out[key] = value;          // native values (a heater's program) are the driver's business
    }
    return out;
  }

  async function apply(device, changes) {
    const current = await view(device, true);
    if (!current.state.reachable) throw new DeviceError(current.state.error === 'lanSilent' ? `${device.name}: no answer on the LAN` : current.state.error === 'cloudOffline' ? `${device.name}: offline for Govee` : current.state.error);
    const valid = validate(expand(changes), current.capabilities);
    const driver = current.state.via === 'cloud' ? cloudFor(device) : driverOf(device);
    await driver.set(device, valid);
    return view(device, true);
  }

  /* A scene is a list of actions, each on one device or on every device of a type. One
   * device failing does not stop the others: leaving the house must still turn off
   * what can be. */
  async function runScene(scene) {
    const results = [];
    for (const action of scene.actions || []) {
      const targets = action.device ? [devices.get(action.device)].filter(Boolean) : [...devices.values()].filter((d) => d.type === action.type);
      for (const device of targets) {
        try {
          await apply(device, action.set);
          results.push({ device: device.id, ok: true });
        } catch (e) {
          if (!(e instanceof DeviceError) && !(e instanceof RangeError)) throw e;
          // a lamp cut at its wall switch is silent (or lost by the cloud), and off: asked to turn off, it has followed
          const offOnly = Object.keys(action.set || {}).length === 1 && action.set.on === false;
          const silent = offOnly && ['lanSilent', 'cloudOffline'].includes((await view(device)).state.error);
          results.push(silent ? { device: device.id, ok: true, skipped: 'no power' } : { device: device.id, ok: false, error: e.message });
        }
      }
    }
    return { id: scene.id, ok: results.every((r) => r.ok), results };
  }

  const sceneList = () => scenes.map(({ id, name }) => ({ id, name }));

  async function discovery() {
    const out = {};
    for (const [name, driver] of Object.entries(drivers)) {
      try { out[name] = await driver.list(); } catch (e) { if (!(e instanceof DeviceError)) throw e; out[name] = { error: e.message }; }
    }
    return out;
  }

  /* Routes under /api/v1. Returns [status, body]. */
  async function handle(method, path, body, query = {}) {
    const [, resource, id, sub] = path.split('/');
    try {
      if (method === 'GET') {
        if (path === '/' || path === '') return [200, { name: 'house', version: VERSION }];
        if (path === '/rooms') return [200, await Promise.all(rooms.map(roomView))];
        if (path === '/scenes') return [200, sceneList()];
        if (path === '/ambiances') return [200, ambiances];
        if (path === '/discovery') return [200, await discovery()];
        if (path === '/modules') return [200, modules];
        // Who is in and how the line is doing. A module that fails says so without failing the answer.
        if (path === '/home') {
          if (!home) return [200, { presence: [], network: null }];
          try {
            return [200, await home()];
          } catch (e) {
            if (!(e instanceof DeviceError)) throw e;
            return [200, { presence: [], network: null, error: e.message }];
          }
        }
        // The plan of the home is private: it exists nowhere else than behind this route.
        if (path === '/plan') {
          if (!readPlan) return [404, { error: 'no plan configured' }];
          const { plan, warnings } = readPlan([...devices.keys()]);
          return [200, { ...plan, warnings }];
        }
        if (resource === 'devices' && id && !sub) {
          return devices.has(id) ? [200, await view(devices.get(id))] : [404, { error: 'unknown device' }];
        }
        // A plain URL for a button (Stream Deck): a GET that acts, so the token is asked
        // for even from the machine itself, where any page could otherwise call it.
        if (resource === 'scenes' && id && sub === 'run') {
          if (!sameToken(query.token, cfg.token)) return [401, { error: 'token required' }];
          const scene = scenes.find((s) => s.id === id);
          return scene ? [200, await runScene(scene)] : [404, { error: 'unknown scene' }];
        }
      }
      if (method === 'POST') {
        if (resource === 'devices' && id && !sub) {
          if (!devices.has(id)) return [404, { error: 'unknown device' }];
          if (!body || typeof body !== 'object' || Array.isArray(body)) return [400, { error: 'a JSON object of changes is expected' }];
          return [200, await apply(devices.get(id), body)];
        }
        if (resource === 'scenes' && id && !sub) {
          const scene = scenes.find((s) => s.id === id);
          return scene ? [200, await runScene(scene)] : [404, { error: 'unknown scene' }];
        }
      }
      return [404, { error: 'not found' }];
    } catch (e) {
      if (e instanceof RangeError) return [400, { error: e.message }];
      if (e instanceof DeviceError) return [502, { error: e.message }];
      if (e instanceof PlanError) return [500, { error: e.message, details: e.details }];
      throw e;
    }
  }

  return { handle, sceneList };
}

module.exports = { createService, authorize, isLoopback, VERSION };
