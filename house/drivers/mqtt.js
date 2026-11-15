/* Devices heard over MQTT, as a Zigbee2MQTT bridge publishes them: one topic per device,
 * a JSON message at each change, and `<topic>/set` to command it. No cloud: the broker
 * is on the local network. Off until house.mqtt.url is set.
 * Config of the module: house.mqtt = { url: "mqtt://192.0.2.9:1883", username, password, base: "zigbee2mqtt" }
 * Config of a device: { driver: "mqtt", type, topic } (or `name`, its friendly name under `base`).
 *   sensor   temperature, humidity: the reference temperature of its room
 *   contact  a door or a window, open or closed
 *   leak     water on the floor
 *   plug     a switch that measures power, which tells when a cycle has ended
 *   heater   a pilot wire module: comfort, eco, frost protection, off
 *   meter    a Linky read on its TIC output: power now, index, tariff period
 * `fields` renames what the device calls its values, for one that is not in the tables below. */
const mqtt = require('../mqtt');
const { DeviceError } = require('../util');

const RETRY_MS = 30000;
// our vocabulary -> the names Zigbee2MQTT gives, the first one found wins
const FIELDS = {
  temperature: ['temperature'], humidity: ['humidity'], battery: ['battery'],
  contact: ['contact'], leak: ['water_leak'],
  power: ['power', 'apparent_power', 'active_power'], on: ['state'], energy: ['energy'],
  pilot: ['pilot_wire_mode'],
  index: ['current_summ_delivered', 'energy'], tariff: ['current_tarif', 'active_register_tier_delivered'],
};
const PILOT_OUT = { comfort: 'comfort', eco: 'eco', frost: 'frost_protection', off: 'off' };
const PILOT_IN = { comfort: 'comfort', 'comfort_-1': 'comfort', 'comfort_-2': 'comfort', eco: 'eco', frost_protection: 'frost', off: 'off' };
const CAPS = {
  plug: { on: { type: 'boolean' } },
  heater: { on: { type: 'boolean' }, mode: { options: Object.keys(PILOT_OUT) } },
};

/* The cycle of an appliance behind a measuring plug, from its power alone: running once
 * it draws `runWatts`, done when it has stayed under `idleWatts` for `doneAfterMin`, and
 * back to idle when someone has emptied it (the plug says nothing of that: after
 * `forgetAfterMin`). prev is { run, since, quietSince }. Pure. */
function cycleStep(prev, watts, now, { runWatts = 10, idleWatts = 3, doneAfterMin = 3, forgetAfterMin = 120 } = {}) {
  const p = prev || { run: 'idle', since: now, quietSince: null };
  if (watts == null) return p;
  if (watts >= runWatts) return p.run === 'running' ? { ...p, quietSince: null } : { run: 'running', since: now, quietSince: null };
  if (p.run === 'running') {
    if (watts > idleWatts) return { ...p, quietSince: null };
    const quietSince = p.quietSince ?? now;
    return now - quietSince >= doneAfterMin * 60000 ? { run: 'done', since: now, quietSince: null } : { ...p, quietSince };
  }
  if (p.run === 'done' && now - p.since >= forgetAfterMin * 60000) return { run: 'idle', since: now, quietSince: null };
  return p;
}

function create({ url, username, password, base = 'zigbee2mqtt', open = mqtt.open, now = Date.now } = {}) {
  let link = null, linking = null, lastTry = -Infinity, lastError = 'not connected yet';
  const last = new Map();      // topic -> { at, data }
  const online = new Map();    // topic -> false when the bridge says the device is gone
  const cycles = new Map();    // device id -> cycle of its appliance
  const topics = new Set();
  const topicOf = (device) => device.topic || `${base}/${device.name}`;

  function onMessage(topic, payload) {
    if (topic.endsWith('/availability')) {
      const t = topic.slice(0, -'/availability'.length);
      let state = payload;
      try { state = JSON.parse(payload).state ?? payload; } catch { /* a plain "online" or "offline" */ }
      online.set(t, state !== 'offline');
      return;
    }
    let data;
    try { data = JSON.parse(payload); } catch { return; }       // not a state message
    if (data && typeof data === 'object') last.set(topic, { at: now(), data: { ...(last.get(topic) || {}).data, ...data } });
  }

  // One connection for every device, made when first needed and retried at most twice a minute.
  function connect() {
    if (link) return Promise.resolve(link);
    if (linking) return linking;
    if (now() - lastTry < RETRY_MS) return Promise.reject(new DeviceError(`mqtt: ${lastError}`));
    lastTry = now();
    linking = open(url, { username, password, onMessage, onClose: (why) => { link = null; lastError = why; } }).then(async (l) => {
      link = l;
      if (topics.size) await l.subscribe([...topics].flatMap((t) => [t, `${t}/availability`]));
      return l;
    }, (e) => { lastError = e.message.replace(/^mqtt: /, ''); throw e; }).finally(() => { linking = null; });
    return linking;
  }
  async function listen(device) {
    const topic = topicOf(device);
    const l = await connect();
    if (!topics.has(topic)) { topics.add(topic); await l.subscribe([topic, `${topic}/availability`]); }
    return topic;
  }

  const read = (device, data, key) => {
    for (const name of [...(device.fields && device.fields[key] ? [device.fields[key]] : []), ...FIELDS[key]]) if (data[name] != null) return data[name];
    return null;
  };

  async function state(device) {
    const topic = await listen(device), seen = last.get(topic);
    if (online.get(topic) === false) return { reachable: false, error: 'offline' };
    if (!seen) return { reachable: false, error: 'no message yet' };
    const d = seen.data, out = { reachable: true };
    const battery = read(device, d, 'battery');
    if (battery != null) out.battery = Number(battery);
    if (device.type === 'sensor') Object.assign(out, { temperature: read(device, d, 'temperature'), humidity: read(device, d, 'humidity') });
    else if (device.type === 'contact') out.open = read(device, d, 'contact') === false;
    else if (device.type === 'leak') out.leak = read(device, d, 'leak') === true;
    else if (device.type === 'plug') {
      const power = read(device, d, 'power'), sw = read(device, d, 'on');
      const cycle = cycleStep(cycles.get(device.id), power == null ? null : Number(power), now(), device.cycle || {});
      cycles.set(device.id, cycle);
      Object.assign(out, { on: sw === 'ON' || sw === true, power: power == null ? null : Number(power), energyKwh: read(device, d, 'energy'), run: cycle.run });
    } else if (device.type === 'heater') {
      const mode = PILOT_IN[read(device, d, 'pilot')] || null;
      Object.assign(out, { mode, on: mode != null && mode !== 'off' });
    } else if (device.type === 'meter') {
      const power = read(device, d, 'power'), index = read(device, d, 'index'), tariff = read(device, d, 'tariff');
      Object.assign(out, { power: power == null ? null : Number(power), index: index == null ? null : Number(index), tariff: tariff == null ? null : String(tariff).trim() });
    }
    return out;
  }

  async function set(device, changes) {
    const topic = await listen(device), l = await connect(), message = {};
    if (device.type === 'plug' && changes.on != null) message.state = changes.on ? 'ON' : 'OFF';
    if (device.type === 'heater') {
      const mode = changes.mode ?? (changes.on === true ? 'comfort' : changes.on === false ? 'off' : null);
      if (mode) message.pilot_wire_mode = PILOT_OUT[mode];
    }
    if (!Object.keys(message).length) throw new DeviceError(`${device.name}: nothing this device can be told`);
    l.publish(`${topic}/set`, JSON.stringify(message));
    // shown at once: the bridge confirms with a state message a moment later
    const seen = last.get(topic);
    if (seen) Object.assign(seen.data, message);
  }

  return {
    capabilities: async (device) => CAPS[device.type] || {},
    state, set,
    list: async () => [...last.keys()],
    close: () => { if (link) link.close(); },
  };
}

module.exports = { create, cycleStep, FIELDS };
