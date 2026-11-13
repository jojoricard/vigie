// The house service with fake drivers: model per room, validation, ambiances, scenes, access.
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const { createService, authorize } = require('../house/service');
const { handler, start, withEnv, buildDrivers } = require('../house/server');
const { DeviceError } = require('../house/util');

// A driver that keeps its devices in memory and records what it is asked.
function fakeDriver(initial, caps) {
  const states = structuredClone(initial);
  const calls = [];
  return {
    calls, states,
    capabilities: async () => caps,
    state: async (d) => { if (states[d.id] instanceof Error) throw states[d.id]; return states[d.id]; },
    set: async (d, changes) => { calls.push([d.id, changes]); Object.assign(states[d.id], changes); },
    list: async () => [],
  };
}

const LIGHT_CAPS = { on: { type: 'boolean' }, brightness: { min: 1, max: 100, step: 1 }, colorRgb: { type: 'color' }, colorTempK: { min: 2000, max: 9000, step: 100 } };
const CLIMATE_CAPS = { on: { type: 'boolean' }, mode: { options: ['auto', 'heat', 'cool'] }, setpoint: { min: 10, max: 32, step: 0.5 } };

const CONFIG = {
  token: 'test-token',
  rooms: [
    { id: 'living', name: 'Living room', devices: [
      { id: 'living-lamp', name: 'Lamp', type: 'light', driver: 'lights' },
      { id: 'living-ac', name: 'Air conditioner', type: 'climate', driver: 'climate' },
    ] },
    { id: 'office', name: 'Office', devices: [
      { id: 'office-lamp', name: 'Desk lamp', type: 'light', driver: 'lights' },
      { id: 'office-thermo', name: 'Thermometer', type: 'sensor', driver: 'sensors' },
    ] },
  ],
  ambiances: [{ id: 'warm', name: 'Warm', brightness: 40, colorTempK: 2700 }, { id: 'red', name: 'Red', colorRgb: 0xff0000 }],
  scenes: [
    { id: 'leave', name: 'Leaving', actions: [{ type: 'light', set: { on: false } }, { type: 'climate', set: { on: false } }] },
    { id: 'evening', name: 'Evening', actions: [{ device: 'living-lamp', set: { ambiance: 'warm' } }] },
  ],
};

function setup() {
  const lights = fakeDriver({
    'living-lamp': { reachable: true, on: true, brightness: 80, colorRgb: null, colorTempK: 4000 },
    'office-lamp': { reachable: true, on: true, brightness: 50, colorRgb: 0x00ff00, colorTempK: null },
  }, LIGHT_CAPS);
  const climate = fakeDriver({ 'living-ac': { reachable: true, on: true, mode: 'heat', setpoint: 20, probeTemp: 23 } }, CLIMATE_CAPS);
  const sensors = fakeDriver({ 'office-thermo': { reachable: true, temperature: 19.5 } }, {});
  return { lights, climate, sensors, service: createService(CONFIG, { lights, climate, sensors }) };
}

/* ---------- Model ---------- */
test('rooms come with their devices, each with its type, capabilities and state', async () => {
  const { service } = setup();
  const [status, rooms] = await service.handle('GET', '/rooms');
  assert.equal(status, 200);
  assert.deepEqual(rooms.map((r) => [r.id, r.devices.map((d) => d.id)]), [['living', ['living-lamp', 'living-ac']], ['office', ['office-lamp', 'office-thermo']]]);
  const lamp = rooms[0].devices[0];
  assert.deepEqual({ type: lamp.type, driver: lamp.driver, room: lamp.room }, { type: 'light', driver: 'lights', room: 'living' });
  assert.deepEqual(Object.keys(lamp.capabilities), ['on', 'brightness', 'colorRgb', 'colorTempK']);
  assert.equal(lamp.state.brightness, 80);
});

test('the temperature of a room comes from its own sensor, never from the probe of the air conditioner', async () => {
  const { service } = setup();
  const [, rooms] = await service.handle('GET', '/rooms');
  assert.equal(rooms[0].temperature, null, 'the living room only has the probe of its air conditioner');
  assert.equal(rooms[0].devices[1].state.probeTemp, 23);
  assert.equal(rooms[1].temperature, 19.5);
});

test('a device that fails, or whose driver is not there, is unreachable and the others still answer', async () => {
  const { service, lights } = setup();
  lights.states['living-lamp'] = new DeviceError('Lamp: timeout');
  const alone = createService({ rooms: [{ id: 'bath', name: 'Bathroom', devices: [{ id: 'rail', name: 'Towel rail', type: 'heater', driver: 'cozytouch' }] }] }, {});
  const [, rooms] = await service.handle('GET', '/rooms');
  assert.deepEqual(rooms[0].devices[0].state, { reachable: false, error: 'Lamp: timeout' });
  assert.equal(rooms[0].devices[1].state.reachable, true);
  const [, bath] = await alone.handle('GET', '/rooms');
  assert.deepEqual(bath[0].devices[0].state, { reachable: false, error: 'no driver "cozytouch"' });
});

/* ---------- Changes ---------- */
test('a change is checked against the capabilities, then handed to the driver', async () => {
  const { service, lights } = setup();
  const [status, device] = await service.handle('POST', '/devices/living-lamp', { on: false, brightness: 30 });
  assert.equal(status, 200);
  assert.deepEqual(lights.calls, [['living-lamp', { on: false, brightness: 30 }]]);
  assert.equal(device.state.brightness, 30);
});

test('numbers are brought back into their range, like a slider', async () => {
  const { service, lights, climate } = setup();
  await service.handle('POST', '/devices/living-lamp', { brightness: 250, colorTempK: 500 });
  await service.handle('POST', '/devices/living-ac', { setpoint: 45 });
  assert.deepEqual(lights.calls[0][1], { brightness: 100, colorTempK: 2000 });
  assert.deepEqual(climate.calls[0][1], { setpoint: 32 });
});

test('what the device cannot do, or a value of the wrong kind, is a 400 and nothing is sent', async () => {
  const { service, lights, climate } = setup();
  const bad = [
    ['/devices/living-lamp', { setpoint: 21 }], ['/devices/living-lamp', { on: 'yes' }], ['/devices/living-lamp', { brightness: 'high' }],
    ['/devices/living-lamp', { colorRgb: -1 }], ['/devices/living-ac', { mode: 'turbo' }], ['/devices/living-lamp', { ambiance: 'nope' }],
    ['/devices/living-lamp', [1, 2]],
  ];
  for (const [path, body] of bad) assert.equal((await service.handle('POST', path, body))[0], 400, JSON.stringify(body));
  assert.equal((await service.handle('POST', '/devices/ghost', { on: true }))[0], 404);
  assert.deepEqual([lights.calls, climate.calls], [[], []]);
});

test('a driver that refuses a command is a 502 with its reason', async () => {
  const { service, climate } = setup();
  climate.set = async () => { throw new DeviceError('Air conditioner: PARAM NG'); };
  assert.deepEqual(await service.handle('POST', '/devices/living-ac', { setpoint: 21 }), [502, { error: 'Air conditioner: PARAM NG' }]);
});

/* ---------- Ambiances and scenes ---------- */
test('an ambiance turns the light on with its preset, explicit values winning', async () => {
  const { service, lights } = setup();
  await service.handle('POST', '/devices/living-lamp', { ambiance: 'warm' });
  await service.handle('POST', '/devices/office-lamp', { ambiance: 'red', brightness: 10 });
  assert.deepEqual(lights.calls, [
    ['living-lamp', { on: true, brightness: 40, colorTempK: 2700 }],
    ['office-lamp', { on: true, colorRgb: 0xff0000, brightness: 10 }],
  ]);
  assert.deepEqual((await service.handle('GET', '/ambiances'))[1].map((a) => a.id), ['warm', 'red']);
});

test('a scene acts on one device or on every device of a type', async () => {
  const { service, lights, climate } = setup();
  assert.deepEqual((await service.handle('GET', '/scenes'))[1], [{ id: 'leave', name: 'Leaving' }, { id: 'evening', name: 'Evening' }]);
  const [status, out] = await service.handle('POST', '/scenes/leave');
  assert.equal(status, 200);
  assert.equal(out.ok, true);
  assert.deepEqual(lights.calls, [['living-lamp', { on: false }], ['office-lamp', { on: false }]]);
  assert.deepEqual(climate.calls, [['living-ac', { on: false }]]);
  await service.handle('POST', '/scenes/evening');
  assert.deepEqual(lights.calls[2], ['living-lamp', { on: true, brightness: 40, colorTempK: 2700 }]);
  assert.equal((await service.handle('POST', '/scenes/nope'))[0], 404);
});

test('a device that fails does not stop the rest of a scene', async () => {
  const { service, lights, climate } = setup();
  lights.states['living-lamp'] = new DeviceError('Lamp: timeout');
  const [, out] = await service.handle('POST', '/scenes/leave');
  assert.equal(out.ok, false);
  assert.deepEqual(out.results.map((r) => [r.device, r.ok]), [['living-lamp', false], ['office-lamp', true], ['living-ac', true]]);
  assert.equal(climate.calls.length, 1);
});

test('a scene can be run by a plain GET, for a button, only with the token', async () => {
  const { service, lights } = setup();
  assert.equal((await service.handle('GET', '/scenes/leave/run', null, {}))[0], 401);
  assert.equal((await service.handle('GET', '/scenes/leave/run', null, { token: 'wrong' }))[0], 401);
  assert.equal(lights.calls.length, 0);
  assert.equal((await service.handle('GET', '/scenes/leave/run', null, { token: 'test-token' }))[0], 200);
  assert.equal(lights.calls.length, 2);
  const noToken = createService({ ...CONFIG, token: '' }, { lights });
  assert.equal((await noToken.handle('GET', '/scenes/leave/run', null, { token: '' }))[0], 401, 'no token configured: the GET stays closed');
});

/* ---------- Access ---------- */
const BEARER = { authorization: 'Bearer test-token' };

test('listening on the machine only, local callers need no token but other sites are refused', () => {
  const local = { token: 'test-token', open: true };
  assert.equal(authorize(local, {}), 0);
  assert.equal(authorize(local, { origin: 'http://localhost:5252' }), 0);
  assert.equal(authorize(local, { origin: 'http://127.0.0.1:5252' }), 0);
  assert.equal(authorize(local, { origin: 'https://evil.example' }), 403);
  assert.equal(authorize(local, { origin: 'null' }), 403);
  assert.equal(authorize(local, { origin: 'https://app.example', ...BEARER }), 0, 'a caller holding the token is trusted');
});

test('listening on the network, every request needs the right token', () => {
  const exposed = { token: 'test-token', open: false };
  assert.equal(authorize(exposed, {}), 401);
  assert.equal(authorize(exposed, { authorization: 'Bearer wrong-token' }), 401);
  assert.equal(authorize(exposed, { authorization: 'Bearer test-toke' }), 401);
  assert.equal(authorize(exposed, { authorization: 'Basic test-token' }), 401);
  assert.equal(authorize(exposed, BEARER), 0);
  assert.equal(authorize({ token: '', open: false }, { authorization: 'Bearer ' }), 401, 'an empty token never matches');
});

test('the service refuses to listen on the network without a token', () => {
  assert.throws(() => start({ host: '0.0.0.0', port: 0, rooms: [] }, () => {}), /token is required/);
});

test('secrets can come from the environment instead of the config file', () => {
  const cfg = withEnv({ token: 'from-file', rooms: [] }, { HOUSE_TOKEN: 'from-env', COZYTOUCH_USERNAME: 'user@example.com', COZYTOUCH_PASSWORD: 'secret', GOVEE_API_KEY: 'key' });
  assert.equal(cfg.token, 'from-env');
  assert.deepEqual(cfg.cozytouch, { username: 'user@example.com', password: 'secret' });
  assert.equal(cfg.govee.apiKey, 'key');
  assert.equal(withEnv({ token: 'from-file' }, {}).token, 'from-file');
});

test('only the drivers the config asks for are created: no cloud without its settings', () => {
  const rooms = [{ id: 'a', devices: [{ id: 'ac', driver: 'daikin', ip: '192.0.2.20' }, { id: 'rail', driver: 'cozytouch', label: 'Towel rail' }] }];
  assert.deepEqual(Object.keys(buildDrivers({ rooms })), ['daikin'], 'cozytouch stays off until house.cozytouch is filled');
  assert.deepEqual(Object.keys(buildDrivers({ rooms, cozytouch: { username: 'user@example.com', password: 'secret' } })), ['daikin', 'cozytouch']);
  assert.deepEqual(Object.keys(buildDrivers({ rooms: [], govee: { apiKey: 'key' } })), [], 'the Govee cloud needs cloudFallback');
  assert.deepEqual(Object.keys(buildDrivers({ rooms: [], govee: { apiKey: 'key', cloudFallback: true } })), ['govee-cloud']);
});

/* ---------- Over HTTP ---------- */
async function withServer(opts, fn) {
  const { lights } = setup();
  const handle = handler(CONFIG, { ...opts, drivers: { lights } });
  const server = http.createServer(handle);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}/api/v1`;
  try { await fn(base, lights); } finally { server.close(); }
}

test('over HTTP: the API answers under /api/v1, in JSON', async () => {
  await withServer({ open: true }, async (base, lights) => {
    assert.deepEqual(await (await fetch(base)).json(), { name: 'house', version: 1 });
    const r = await fetch(`${base}/devices/living-lamp`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ brightness: 20 }) });
    assert.equal(r.status, 200);
    assert.equal((await r.json()).state.brightness, 20);
    assert.equal(lights.calls.length, 1);
    assert.equal((await fetch(`${base}/devices/living-lamp`, { method: 'POST', body: '{not json' })).status, 400);
    assert.equal((await fetch(`${base}/nothing`)).status, 404);
  });
});

test('over HTTP: another site is refused before anything runs, the token opens an exposed service', async () => {
  await withServer({ open: true }, async (base, lights) => {
    const r = await fetch(`${base}/scenes/leave`, { method: 'POST', headers: { origin: 'https://evil.example' } });
    assert.equal(r.status, 403);
    assert.equal(lights.calls.length, 0);
  });
  await withServer({ open: false }, async (base) => {
    assert.equal((await fetch(`${base}/rooms`)).status, 401);
    assert.equal((await fetch(`${base}/rooms`, { headers: BEARER })).status, 200);
  });
});
