// The floor plan: its schema, its anchors, and the one route that serves it.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { validate, load, PlanError } = require('../house/plan');
const { createService } = require('../house/service');
const { handler, buildDrivers } = require('../house/server');

const DEMO_DIR = path.join(__dirname, '..', 'house', 'demo');
const DEMO_PLAN = path.join(DEMO_DIR, 'plan.json');
const demoConfig = JSON.parse(fs.readFileSync(path.join(DEMO_DIR, 'config.json'), 'utf8')).house;
const demoDevices = demoConfig.rooms.flatMap((r) => r.devices.map((d) => d.id));
const demoPlan = () => JSON.parse(fs.readFileSync(DEMO_PLAN, 'utf8'));

// A small valid plan to break one thing at a time.
const base = () => ({
  version: 1,
  rooms: [{ id: 'room', name: 'Room', polygon: [[0, 0], [4, 0], [4, 3], [0, 3]], height: 2.5, floor: 'wood' }],
  walls: [{ id: 'w1', a: [0, 0], b: [4, 0], thickness: 0.2 }],
  openings: [{ id: 'o1', type: 'window', wall: 'w1', offset: 1, width: 1.2, height: 1.3, sill: 0.9 }],
  furniture: [{ id: 'f1', room: 'room', position: [1, 1], size: [1, 1, 0.5] }],
  anchors: [{ deviceId: 'lamp', position: [2, 1.5, 2.3] }, { deviceId: 'shutter', openingId: 'o1' }],
});
const errorsOf = (change) => { const p = base(); change(p); return validate(p).errors; };

/* ---------- Schema ---------- */
test('the demo plan follows the schema and every anchor finds its device', () => {
  const { errors, warnings, plan } = validate(demoPlan(), demoDevices);
  assert.deepEqual(errors, []);
  assert.deepEqual(warnings, []);
  assert.equal(plan.anchors.length, 12);
  // every room of the demo config is drawn
  for (const room of demoConfig.rooms) assert.ok(plan.rooms.some((r) => r.id === room.id), `room ${room.id} is in the plan`);
});

test('a plan of another version, or that is not an object, is refused', () => {
  assert.match(errorsOf((p) => { p.version = 2; })[0], /"version" must be 1/);
  assert.deepEqual(validate([]).errors, ['the plan must be a JSON object']);
  assert.equal(validate(null).plan, null);
  assert.match(errorsOf((p) => { p.units = 'ft'; })[0], /"units" must be "m"/);
  assert.match(errorsOf((p) => { p.north = [0, 0]; })[0], /"north" must be an \[x, y\] direction/);
  assert.match(errorsOf((p) => { p.north = 'up'; })[0], /"north"/);
  assert.deepEqual(errorsOf((p) => { p.north = [1, 0]; }), []);
});

test('rooms need an id, a polygon of three points and a known floor', () => {
  assert.match(errorsOf((p) => { p.rooms = []; })[0], /"rooms" must be a non-empty array/);
  assert.match(errorsOf((p) => { p.rooms[0].polygon = [[0, 0], [1, 1]]; })[0], /at least 3/);
  assert.match(errorsOf((p) => { p.rooms[0].polygon[1] = [4, 'x']; })[0], /at least 3/);
  assert.match(errorsOf((p) => { p.rooms[0].floor = 'lava'; })[0], /"floor" must be one of/);
  assert.match(errorsOf((p) => { p.rooms.push({ ...p.rooms[0] }); })[0], /duplicate id/);
  assert.match(errorsOf((p) => { delete p.rooms[0].id; })[0], /an "id" is required/);
});

test('an opening sits on a wall that exists, inside its length, without overlapping another', () => {
  assert.match(errorsOf((p) => { p.openings[0].wall = 'nowhere'; })[0], /unknown wall "nowhere"/);
  assert.match(errorsOf((p) => { p.openings[0].offset = 3.5; })[0], /goes past the end of wall "w1"/);
  assert.match(errorsOf((p) => { p.openings[0].type = 'hatch'; })[0], /"type" must be one of/);
  assert.match(errorsOf((p) => { p.openings.push({ id: 'o2', type: 'door', wall: 'w1', offset: 2, width: 0.9, height: 2 }); })[0], /"o1" and "o2" overlap/);
  assert.match(errorsOf((p) => { p.walls[0].b = [0, 0]; })[0], /the same point/);
  assert.match(errorsOf((p) => { p.walls[0].thickness = 0; })[0], /"thickness" must be a positive number/);
});

test('furniture is a box in a room that exists', () => {
  assert.match(errorsOf((p) => { p.furniture[0].size = [1, 1]; })[0], /"size" must be \[width, depth, height\]/);
  assert.match(errorsOf((p) => { p.furniture[0].room = 'attic'; })[0], /unknown room "attic"/);
  assert.deepEqual(errorsOf((p) => { delete p.furniture; delete p.anchors; }), [], 'furniture and anchors are optional');
});

/* ---------- Anchors ---------- */
test('an anchor ties a device to a position or to an opening, never both', () => {
  assert.match(errorsOf((p) => { p.anchors[0].openingId = 'o1'; })[0], /either "position" or "openingId"/);
  assert.match(errorsOf((p) => { delete p.anchors[0].position; })[0], /either "position" or "openingId"/);
  assert.match(errorsOf((p) => { p.anchors[0].position = [1, 2]; })[0], /"position" must be \[x, y, z\]/);
  assert.match(errorsOf((p) => { delete p.anchors[0].deviceId; })[0], /a "deviceId" is required/);
});

test('an anchor to an unknown device or opening is left out with a warning, the plan is still served', () => {
  const p = base();
  p.anchors.push({ deviceId: 'ghost', position: [0, 0, 1] }, { deviceId: 'blind', openingId: 'o9' }, { deviceId: 'lamp', position: [1, 1, 1] });
  const { errors, warnings, plan } = validate(p, ['lamp', 'shutter', 'blind']);
  assert.deepEqual(errors, []);
  assert.deepEqual(plan.anchors.map((a) => a.deviceId), ['lamp', 'shutter']);
  assert.equal(warnings.length, 3);
  assert.match(warnings.join('\n'), /"ghost": no such device/);
  assert.match(warnings.join('\n'), /"blind": unknown opening "o9"/);
  assert.match(warnings.join('\n'), /"lamp": a second anchor/);
  // without the list of devices, only the plan itself is checked
  assert.equal(validate(base()).warnings.length, 0);
});

/* ---------- The file ---------- */
function tempPlan(content) {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'vigie-plan-')), 'plan.json');
  fs.writeFileSync(file, typeof content === 'string' ? content : JSON.stringify(content));
  return file;
}

test('the file is read again when it changes, and its faults never name its path', () => {
  const file = tempPlan(base());
  assert.equal(load(file).plan.rooms[0].name, 'Room');
  const edited = base();
  edited.rooms[0].name = 'Renamed';
  fs.writeFileSync(file, '﻿' + JSON.stringify(edited));
  fs.utimesSync(file, new Date(), new Date(Date.now() + 5000));
  assert.equal(load(file).plan.rooms[0].name, 'Renamed', 'a newer file replaces the cached plan, a BOM is accepted');

  const missing = path.join(path.dirname(file), 'secret-place.json');
  assert.throws(() => load(missing), (e) => e instanceof PlanError && !e.message.includes('secret-place'));
  assert.throws(() => load(tempPlan('{nope')), /not valid JSON/);
  assert.throws(() => load(tempPlan({ version: 1, rooms: [] })), (e) => e instanceof PlanError && e.details.length === 1);
});

/* ---------- The route ---------- */
test('GET /plan answers 404 when no plan is configured, 200 with the plan and its warnings otherwise', async () => {
  const none = createService(demoConfig, buildDrivers(demoConfig));
  assert.deepEqual(await none.handle('GET', '/plan'), [404, { error: 'no plan configured' }]);

  const withPlan = createService(demoConfig, buildDrivers(demoConfig), { readPlan: (ids) => load(DEMO_PLAN, ids) });
  const [status, plan] = await withPlan.handle('GET', '/plan');
  assert.equal(status, 200);
  assert.equal(plan.version, 1);
  assert.deepEqual(plan.warnings, []);
  assert.ok(plan.anchors.every((a) => demoDevices.includes(a.deviceId)));

  const broken = createService(demoConfig, buildDrivers(demoConfig), { readPlan: () => { throw new PlanError('the plan does not follow the schema', ['x']); } });
  assert.deepEqual(await broken.handle('GET', '/plan'), [500, { error: 'the plan does not follow the schema', details: ['x'] }]);
});

async function withServer(cfg, opts, fn) {
  const server = http.createServer(handler(cfg, opts));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  try { await fn(`http://127.0.0.1:${server.address().port}/api/v1`); } finally { server.close(); }
}

test('over HTTP: the plan asks for the token like the rest of the service, and is never cached', async () => {
  const cfg = { ...demoConfig, token: 'test-token' };
  // exposed to the network: the token or nothing
  await withServer(cfg, { open: false, baseDir: DEMO_DIR }, async (url) => {
    assert.equal((await fetch(`${url}/plan`)).status, 401);
    assert.equal((await fetch(`${url}/plan`, { headers: { authorization: 'Bearer wrong' } })).status, 401);
    const r = await fetch(`${url}/plan`, { headers: { authorization: 'Bearer test-token' } });
    assert.equal(r.status, 200);
    assert.equal(r.headers.get('cache-control'), 'no-store');
    assert.equal((await r.json()).rooms.length, 7);
  });
  // on the machine only: the page reads it, a page of another site does not
  await withServer(cfg, { open: true, baseDir: DEMO_DIR }, async (url) => {
    assert.equal((await fetch(`${url}/plan`)).status, 200);
    assert.equal((await fetch(`${url}/plan`, { headers: { origin: 'https://evil.example' } })).status, 403);
  });
  await withServer({ ...cfg, planPath: '' }, { open: true, baseDir: DEMO_DIR }, async (url) => {
    assert.equal((await fetch(`${url}/plan`)).status, 404);
  });
  await withServer({ ...cfg, planPath: 'missing.json' }, { open: true, baseDir: DEMO_DIR }, async (url) => {
    const r = await fetch(`${url}/plan`);
    assert.equal(r.status, 500);
    assert.doesNotMatch(JSON.stringify(await r.json()), /missing\.json/);
  });
});

test('the demo driver keeps what it is set to, in the vocabulary of the service', async () => {
  const service = createService(demoConfig, buildDrivers(demoConfig));
  const [, shutter] = await service.handle('POST', '/devices/living-shutter', { position: 130 });
  assert.equal(shutter.state.position, 100, 'brought back into the range');
  const [, lamp] = await service.handle('POST', '/devices/office-lamp', { colorTempK: 3000 });
  assert.deepEqual([lamp.state.colorTempK, lamp.state.colorRgb], [3000, null]);
  const [, rooms] = await service.handle('GET', '/rooms');
  assert.equal(rooms.find((r) => r.id === 'living').temperature, 20.4, 'the room takes its temperature from its own sensor');
});

test('nothing private is served as a static file: no plan lives under public/', () => {
  const found = fs.readdirSync(path.join(__dirname, '..', 'public'), { recursive: true }).filter((f) => /plan.*\.json$/i.test(String(f)));
  assert.deepEqual(found, []);
});
