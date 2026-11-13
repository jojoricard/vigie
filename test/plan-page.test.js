// The plan on the page: which module draws a device, where anchors land, how walls are
// cut around openings, the limits of the camera and the flat view.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');

const page = (file) => import(pathToFileURL(path.join(__dirname, '..', 'public', 'js', file)));
const demo = () => JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'house', 'demo', 'plan.json'), 'utf8'));
const device = (id, type, extra = {}) => ({ id, type, name: id, capabilities: {}, state: { reachable: true }, ...extra });

test('a device is drawn by the module of its type', async () => {
  const { moduleFor, MODULES } = await page('plan.js');
  for (const type of MODULES) assert.equal(moduleFor(device('d', type)), type);
});

test('an unknown type falls back on what the capabilities say', async () => {
  const { moduleFor } = await page('plan.js');
  const of = (capabilities, state = {}) => moduleFor({ id: 'd', type: 'somfy-thing', capabilities, state });
  assert.equal(of({ position: { min: 0, max: 100 } }), 'cover');
  assert.equal(of({ on: true, brightness: { min: 1, max: 100 } }), 'light');
  assert.equal(of({ setpoint: { min: 16, max: 30 }, fan: { options: ['auto'] } }), 'climate');
  assert.equal(of({ setpoint: { min: 16, max: 30 }, mode: { options: ['heat', 'cool'] } }), 'climate');
  assert.equal(of({ setpoint: { min: 7, max: 28 }, mode: { options: ['manual', 'off'] } }), 'heater');
  assert.equal(of({}, { temperature: 20.4 }), 'sensor');
  assert.equal(of({}), null, 'nothing to go by: not drawn');
  assert.equal(moduleFor(null), null);
});

test('the 3D view has one module per name the plan can choose', async () => {
  const { MODULES } = await page('plan.js');
  const { MODULE_NAMES } = await page('plan3d.js');
  assert.deepEqual([...MODULE_NAMES].sort(), [...MODULES].sort());
});

test('only anchored devices the service knows are placed', async () => {
  const { placedDevices } = await page('plan.js');
  const plan = demo();
  const rooms = [{ id: 'living', devices: [device('living-lamp', 'light'), device('living-shutter', 'cover'), device('not-anchored', 'light')] }];
  const placed = placedDevices(plan, rooms);
  assert.deepEqual(placed.map((p) => [p.device.id, p.module]), [['living-lamp', 'light'], ['living-shutter', 'cover']]);
  const lamp = plan.anchors.find((a) => a.deviceId === 'living-lamp');
  assert.deepEqual([placed[0].point.x, placed[0].point.y, placed[0].point.z], lamp.position);
});

test('an anchor on an opening stands in the middle of it, at its head', async () => {
  const { placedDevices, openingFrame } = await page('plan.js');
  const plan = demo();
  const [shutter] = placedDevices(plan, [{ id: 'living', devices: [device('living-shutter', 'cover')] }]);
  const opening = plan.openings.find((o) => o.id === 'o-living-window');
  const frame = openingFrame(plan, opening);
  assert.equal(shutter.point.opening, opening);
  assert.deepEqual([shutter.point.x, shutter.point.y], [frame.x, frame.y]);
  assert.equal(shutter.point.z, (opening.sill || 0) + opening.height);
});

test('a shutter anchored on a bare position has no window to hang on: not placed', async () => {
  const { placedDevices } = await page('plan.js');
  const plan = { ...demo(), anchors: [{ deviceId: 'loose', position: [1, 1, 2] }] };
  assert.deepEqual(placedDevices(plan, [{ id: 'living', devices: [device('loose', 'cover')] }]), []);
});

test('a wall is cut around its openings: a door leaves a gap, a window a sill', async () => {
  const { wallPieces, wallFrame, CUT_HEIGHT } = await page('plan.js');
  const plan = {
    walls: [{ id: 'w', a: [0, 0], b: [4, 0], thickness: 0.2 }],
    openings: [
      { id: 'door', type: 'door', wall: 'w', offset: 0.5, width: 1, height: 2.05, sill: 0 },
      { id: 'win', type: 'window', wall: 'w', offset: 2.5, width: 1, height: 1.2, sill: 0.9 },
    ],
  };
  const pieces = wallPieces(plan, plan.walls[0]);
  assert.equal(wallFrame(plan.walls[0]).length, 4);
  // nothing stands in the doorway, something low stands under the window
  const at = (s) => pieces.filter((p) => p.from <= s && s <= p.to);
  assert.deepEqual(at(1), []);
  assert.ok(at(3).length === 1 && Math.abs(at(3)[0].top - 0.9) < 1e-9, 'the sill of the window');
  assert.ok(at(2).every((p) => p.top === CUT_HEIGHT) && at(2).length === 1, 'full wall between the two');
  const solid = pieces.filter((p) => p.top === CUT_HEIGHT).reduce((sum, p) => sum + p.to - p.from, 0);
  assert.ok(Math.abs(solid - 2) < 1e-9, `4 m minus two openings of 1 m, got ${solid}`);
});

test('the camera cannot go under the floor, flip over or back away from the plan', async () => {
  const { clampView, presets, LIMITS } = await page('plan.js');
  const iso = presets(demo()).iso;
  assert.equal(clampView({ ...iso, elevation: 0 }).elevation, LIMITS.minElevation);
  assert.equal(clampView({ ...iso, elevation: 3 }).elevation, LIMITS.maxElevation);
  assert.equal(clampView({ ...iso, zoom: 0.01 }).zoom, LIMITS.minZoom);
  assert.equal(clampView({ ...iso, zoom: 1e6 }).zoom, LIMITS.maxZoom);
  assert.equal(clampView({ ...iso, zoom: undefined }).zoom, 1);
});

test('there is a view for the model, one from above and one per room', async () => {
  const { presets, frameView } = await page('plan.js');
  const plan = demo(), views = presets(plan);
  for (const name of ['iso', 'top']) assert.equal(views[name].subject, 'plan', name);
  for (const r of plan.rooms) assert.equal(views.rooms[r.id].subject, r.id);
  assert.ok(frameView(plan, views.rooms.living, 1.2).height < frameView(plan, views.iso, 1.2).height, 'a room is seen closer than the whole plan');
});

// The share of the picture the subject takes, across and up, for a frame.
async function fillOf(plan, view, aspect) {
  const { frameView, viewAxes, subjectPoints } = await page('plan.js');
  const f = frameView(plan, view, aspect), { right, up } = viewAxes(f.azimuth, f.elevation);
  const dot = (p, a) => p[0] * a[0] + p[1] * a[1] + p[2] * a[2];
  const points = subjectPoints(plan, view.subject).map((p) => [dot(p, right) - dot(f.center, right), dot(p, up) - dot(f.center, up)]);
  const half = (i) => Math.max(...points.map((q) => Math.abs(q[i])));
  return { across: 2 * half(0) / (f.height * aspect), up: 2 * half(1) / f.height, centered: Math.abs(Math.max(...points.map((q) => q[0])) + Math.min(...points.map((q) => q[0]))) < 1e-9 };
}

test('the home fills 90 % of the picture, at any angle and any shape of screen', async () => {
  const { presets, FILL } = await page('plan.js');
  const plan = demo(), views = presets(plan);
  for (const aspect of [0.6, 0.76, 1, 1.25, 2.2]) {
    for (const view of [views.iso, views.top, { subject: 'plan', zoom: 1, azimuth: 2.1, elevation: 0.7 }]) {
      const fill = await fillOf(plan, view, aspect);
      assert.ok(Math.abs(Math.max(fill.across, fill.up) - FILL) < 1e-9, `aspect ${aspect}: the tighter side is at ${FILL}, got ${JSON.stringify(fill)}`);
      assert.ok(fill.across <= FILL + 1e-9 && fill.up <= FILL + 1e-9 && fill.centered, 'nothing is cut, the home is centered');
    }
  }
  const closer = await fillOf(plan, { ...views.top, zoom: 2 }, 1);
  assert.ok(closer.across > 1 || closer.up > 1, 'zooming in goes past the frame');
});

test('a tall screen sees the model from higher, a wide one keeps the usual angle', async () => {
  const { modelAngle, presets, frameView } = await page('plan.js');
  const plan = demo(), usual = modelAngle(plan, 1.6), tall = modelAngle(plan, 0.7);
  assert.ok(tall.elevation > usual.elevation, 'higher on a tall card');
  assert.ok(Math.abs(usual.azimuth + 35 * Math.PI / 180) < 1e-9 && Math.abs(usual.elevation - 50 * Math.PI / 180) < 1e-9);
  const auto = presets(plan).iso;
  const tallFrame = frameView(plan, auto, 0.7);
  assert.equal(tallFrame.elevation, tall.elevation, 'the model view follows that angle');
  assert.equal(frameView(plan, { ...auto, auto: false }, 0.7).elevation, auto.elevation, 'an angle set by hand is kept');
  assert.ok((await fillOf(plan, auto, 0.7)).up > (await fillOf(plan, { ...auto, auto: false }, 0.7)).up, 'and the home takes more of the tall card');
});

test('a view glides to another the short way round', async () => {
  const { mixFrame } = await page('plan.js');
  const a = { center: [0, 0, 0], height: 10, azimuth: -3, elevation: 1 }, b = { center: [2, 4, 0], height: 6, azimuth: 3, elevation: 0.5 };
  const mid = mixFrame(a, b, 0.5);
  assert.deepEqual(mid.center, [1, 2, 0]);
  assert.equal(mid.height, 8);
  assert.ok(Math.abs(mid.azimuth) > 3, 'through the back, not all the way round the front');
  assert.equal(mixFrame(a, b, 0).azimuth, a.azimuth);
});

test('the name of a room sits inside it, even when its centroid does not', async () => {
  const { labelPoint, pointInPolygon, polygonCentroid } = await page('plan.js');
  const hall = [[0, 0], [6, 0], [6, 1], [1, 1], [1, 5], [0, 5]];   // an L
  assert.ok(!pointInPolygon(hall, ...polygonCentroid(hall)), 'the centroid of this hall is outside it');
  const [x, y] = labelPoint(hall);
  assert.ok(pointInPolygon(hall, x, y));
  const [cx, cy] = labelPoint([[0, 0], [4, 0], [4, 3], [0, 3]]);
  assert.ok(Math.abs(cx - 2) < 0.2 && Math.abs(cy - 1.5) < 0.2, 'the middle of a plain room');
});

test('a balcony gets a rail on the sides no wall closes', async () => {
  const { openEdges } = await page('plan.js');
  const plan = demo(), balcony = plan.rooms.find((r) => r.kind === 'outdoor');
  const edges = openEdges(plan, balcony);
  assert.equal(edges.length, 3, 'three open sides, the fourth is the wall of the flat');
  const wall = plan.walls.find((w) => w.id === 'w-south');
  for (const [a, b] of edges) assert.ok(Math.abs((a[1] + b[1]) / 2 - wall.a[1]) > 0.3, 'none of them runs along that wall');
  assert.deepEqual(openEdges({ walls: [] }, { polygon: [[0, 0], [2, 0], [2, 1], [0, 1]] }).length, 4);
});

test('the light of the sun comes from where the sun is, seen from the plan', async () => {
  const { sunlight } = await page('plan.js');
  const close = (v, w) => v.every((x, i) => Math.abs(x - w[i]) < 1e-9);
  // north at the top of the plan: the morning sun in the east is on the right
  assert.ok(close(sunlight([0, -1], { azimuth: 90, elevation: 0 }).toward, [1, 0, 0]));
  assert.ok(close(sunlight([0, -1], { azimuth: 180, elevation: 0 }).toward, [0, 1, 0]), 'south is down');
  // north to the right: east is down the plan, west up
  assert.ok(close(sunlight([1, 0], { azimuth: 90, elevation: 0 }).toward, [0, 1, 0]));
  assert.ok(close(sunlight([5, 0], { azimuth: 270, elevation: 0 }).toward, [0, -1, 0]), 'the length of north does not matter');
  assert.ok(Math.abs(sunlight([0, -1], { azimuth: 180, elevation: 30 }).toward[2] - 0.5) < 1e-9);
  assert.equal(sunlight([0, -1], { azimuth: 0, elevation: -20 }).day, 0, 'night');
  assert.equal(sunlight([0, -1], { azimuth: 0, elevation: 30 }).day, 1, 'day');
  const dusk = sunlight([0, -1], { azimuth: 0, elevation: -2 }).day;
  assert.ok(dusk > 0 && dusk < 1, 'twilight in between');
});

test('a room is tinted by its own temperature only outside the comfortable range', async () => {
  const { temperatureTint } = await page('plan.js');
  assert.equal(temperatureTint(20).strength, 0);
  assert.equal(temperatureTint(undefined).strength, 0);
  assert.equal(temperatureTint(16).tone, 'cool');
  assert.equal(temperatureTint(26).tone, 'warm');
  assert.ok(temperatureTint(28).strength > temperatureTint(22).strength);
  assert.ok(temperatureTint(40).strength <= 1);
});

test('a shutter at 0 % is closed, at 100 % open', async () => {
  const { coverClosed } = await page('plan.js');
  assert.equal(coverClosed({ position: 0 }), 1);
  assert.equal(coverClosed({ position: 100 }), 0);
  assert.equal(coverClosed({ position: 70 }).toFixed(2), '0.30');
  assert.equal(coverClosed({}), 1, 'no position reported: drawn closed rather than open');
});

test('the flat view draws rooms and devices one can press, and escapes what it prints', async () => {
  const { planSvg, placedDevices } = await page('plan.js');
  const plan = demo();
  plan.rooms[0].name = '<b>Lounge & co</b>';
  const rooms = [{ id: 'living', devices: [device('living-lamp', 'light', { name: 'Lamp "1"', state: { reachable: true, on: true } })] }];
  const svg = planSvg(plan, placedDevices(plan, rooms), { label: () => '<i>', color: () => 'rgb(1, 2, 3)' });
  assert.match(svg, /^<svg[^>]+viewBox=/);
  assert.equal((svg.match(/class="pRoom/g) || []).length, plan.rooms.length);
  assert.match(svg, /data-device="living-lamp"/);
  assert.match(svg, /&lt;b&gt;Lounge &amp; co&lt;\/b&gt;/);
  assert.ok(!svg.includes('<b>') && !svg.includes('<i>') && !svg.includes('Lamp "1"'), 'nothing from the plan or the service reaches the markup raw');
  assert.match(svg, /class="pRoom room lit"[^>]*--lamp:rgb\(1, 2, 3\)/, 'the room of a lit lamp takes its color');
  assert.equal((svg.match(/class="pName/g) || []).length, plan.rooms.length, 'every room is named');
  const simple = planSvg(plan, [], { simple: true });
  assert.ok(!simple.includes('pFurniture') && !simple.includes('pName'), 'the narrow view drops furniture and names');
});

test('three.js is vendored at one pinned version, with its licence, and nowhere else', async () => {
  const vendor = path.join(__dirname, '..', 'public', 'vendor', 'three');
  assert.deepEqual(fs.readdirSync(vendor).sort(), ['LICENSE', 'README.md', 'three.module.min.js']);
  const readme = fs.readFileSync(path.join(vendor, 'README.md'), 'utf8');
  const sha = require('crypto').createHash('sha256').update(fs.readFileSync(path.join(vendor, 'three.module.min.js'))).digest('hex');
  assert.ok(readme.includes(sha), 'the README states the checksum of the file that is served');
  assert.match(fs.readFileSync(path.join(vendor, 'LICENSE'), 'utf8'), /MIT License/);
});

/* ---------- Furniture ---------- */
const item = (type, extra = {}) => ({ id: 'x', type, position: [0, 0], size: [1.2, 0.5, 0.9], ...extra });

test('every type of furniture gives sound parts that stay within reach of its size', async () => {
  const { furnitureParts, FURNITURE_TYPES } = await page('furniture.js');
  assert.ok(FURNITURE_TYPES.length >= 15);
  for (const type of FURNITURE_TYPES) {
    const parts = furnitureParts(item(type));
    assert.ok(parts.length >= 1, type);
    for (const p of parts) {
      assert.ok(['box', 'cyl'].includes(p.shape) && ['solid', 'glass', 'sheer', 'glow'].includes(p.look), `${type}: a shape and a look the model knows`);
      assert.ok(p.size.every((v) => v > 0) && p.at.every(Number.isFinite), `${type}: ${JSON.stringify(p)}`);
      // nothing strays far from the footprint the plan gives (an arc lamp reaches out on purpose)
      if (type !== 'lamp') assert.ok(Math.abs(p.at[0]) <= 0.6 + 0.2 && Math.abs(p.at[1]) <= 0.25 + 0.9, `${type}: a part at ${p.at}`);
    }
  }
});

test('an unknown type, or none, is drawn as a plain volume', async () => {
  const { furnitureParts } = await page('furniture.js');
  for (const it of [item('hammock'), item(undefined)]) {
    const parts = furnitureParts(it);
    assert.equal(parts.length, 1);
    assert.deepEqual(parts[0].size, [1.2, 0.5, 0.9]);
  }
  assert.equal(furnitureParts(item(undefined, { params: { color: 'oak' } }))[0].color, '#c59a63');
});

test('furniture is cut with the walls, except what is meant to be seen above them', async () => {
  const { furnitureParts } = await page('furniture.js');
  const { CUT_HEIGHT } = await page('plan.js');
  const top = (parts) => Math.max(...parts.map((p) => p.at[2] + p.size[2] / 2));
  assert.ok(top(furnitureParts(item('cabinet', { size: [1, 0.6, 2.2] }))) <= CUT_HEIGHT, 'a wardrobe stops at the cut');
  assert.ok(top(furnitureParts(item('shelving', { size: [1, 0.3, 2] }))) <= CUT_HEIGHT);
  const lamp = top(furnitureParts(item('lamp', { size: [0.3, 0.3, 1.6] })));
  assert.ok(lamp > CUT_HEIGHT && lamp <= CUT_HEIGHT + 0.5, 'a floor lamp shows its shade above it');
  assert.deepEqual(furnitureParts(item('art', { size: [0.5, 0.03, 0.4], elevation: 2.1 })), [], 'what hangs too high is not drawn');
  assert.ok(top(furnitureParts(item('cabinet', { size: [1, 0.4, 0.5], elevation: 0.9 }))) <= CUT_HEIGHT - 0.9, 'the cut counts from the floor, not from the item');
});

test('the parameters of a type change what is drawn', async () => {
  const { furnitureParts } = await page('furniture.js');
  const count = (type, params, size) => furnitureParts(item(type, { params, ...(size ? { size } : {}) })).length;
  const colors = (type, params) => new Set(furnitureParts(item(type, { params })).map((p) => p.color));
  assert.ok(count('cabinet', { niches: [[0.3, 0.7]], baskets: 2 }) > count('cabinet', {}), 'a niche and its baskets');
  assert.ok(colors('cabinet', { body: 'white', top: 'oak' }).has('#c59a63'), 'an oak top');
  assert.ok(count('shelving', { columns: 4, rows: 4, fill: 0 }) > count('shelving', { columns: 2, rows: 2, fill: 0 }), 'more cells');
  assert.ok(count('desk', { shape: 'L' }) > count('desk', {}), 'the return of a corner desk');
  assert.ok(count('sofa', { chaise: 'left' }) > count('sofa', {}));
  assert.equal(furnitureParts(item('screen', { params: { lit: '#7c3aed' } })).filter((p) => p.look === 'glow').length, 1, 'a lit screen glows');
  assert.equal(furnitureParts(item('screen', {})).filter((p) => p.look === 'glow').length, 0);
  assert.ok(furnitureParts(item('pc', { params: { glow: '#8b5cf6' } })).some((p) => p.look === 'glow') && furnitureParts(item('pc', {})).some((p) => p.look === 'glass'));
  assert.ok(furnitureParts(item('curtain', {})).every((p) => p.look === 'sheer'));
  // an arc lamp carries its shade away from its foot, on the side asked
  const shade = (side) => furnitureParts(item('lamp', { size: [0.25, 0.25, 0.9], params: { style: 'arc', reach: 0.5, side } })).filter((p) => p.shape === 'cyl').pop().at[0];
  assert.ok(shade('left') < -0.4 && shade('right') > 0.4);
});

test('a part follows the place and the rotation of its item', async () => {
  const { placePart } = await page('furniture.js');
  const { footprint } = await page('plan.js');
  const near = (a, b) => a.every((v, i) => Math.abs(v - b[i]) < 1e-9);
  const part = { at: [0.5, 0.2, 0.4] };
  assert.ok(near(placePart({ position: [3, 4] }, part).at, [3.5, 4.2, 0.4]));
  // a quarter turn clockwise on the plan: the front, down the plan at 0, now faces left
  assert.ok(near(placePart({ position: [3, 4], rotation: 90, elevation: 1 }, part).at, [2.8, 4.5, 1.4]));
  assert.equal(placePart({ position: [0, 0], rotation: 90 }, { at: [0, 0, 0], turn: 30 }).angle, 120);
  const corners = footprint({ position: [0, 0], size: [2, 1], rotation: 90 });
  assert.ok(near([Math.max(...corners.map((c) => Math.abs(c[0]))), Math.max(...corners.map((c) => Math.abs(c[1])))], [0.5, 1]), 'turned, a 2 by 1 item is 1 wide and 2 deep');
});

test('the furniture of the demo flat stays cheap to draw', async () => {
  const { furnitureParts } = await page('furniture.js');
  const plan = demo();
  let parts = 0, triangles = 0;
  const batches = new Set();
  for (const it of plan.furniture) for (const p of furnitureParts(it)) { parts++; triangles += p.shape === 'box' ? 12 : 72; batches.add(`${p.shape}|${p.look}`); }
  assert.ok(plan.furniture.every((it) => typeof it.type === 'string'), 'the demo shows the library');
  assert.ok(batches.size <= 8, `${batches.size} draw calls for all the furniture: one per shape and look, not one per piece`);
  assert.ok(triangles < 25000, `${triangles} triangles for ${parts} parts`);
});

test('on a tall screen a long home stands upright', async () => {
  const { modelAngle } = await page('plan.js');
  const long = { rooms: [{ id: 'a', polygon: [[0, 0], [12, 0], [12, 6], [0, 6]] }], walls: [] };   // twice as wide as deep
  const tall = modelAngle(long, 0.6);
  assert.ok(Math.abs(Math.abs(tall.azimuth) - Math.PI / 2) < 0.5, `seen from the side, got ${(tall.azimuth * 180 / Math.PI).toFixed(0)} degrees`);
  assert.ok(Math.abs(modelAngle(long, 1.8).azimuth) < 0.7, 'a wide screen keeps it as drawn');
  const deep = { rooms: [{ id: 'a', polygon: [[0, 0], [6, 0], [6, 12], [0, 12]] }], walls: [] };
  assert.ok(Math.abs(modelAngle(deep, 0.6).azimuth) < 0.2, 'already upright: seen from the front, no turn');
});

test('a wall in the way of its rooms comes down, the others stand', async () => {
  const { wallInside, wallDrop, LIMITS } = await page('plan.js');
  const DEG = Math.PI / 180;
  // two rooms side by side, a balcony under the left one
  const plan = {
    rooms: [
      { id: 'a', polygon: [[0, 0], [4, 0], [4, 3], [0, 3]] }, { id: 'b', polygon: [[4, 0], [8, 0], [8, 3], [4, 3]] },
      { id: 'out', kind: 'outdoor', polygon: [[0, 3.2], [4, 3.2], [4, 4.4], [0, 4.4]] },
    ],
    walls: [
      { id: 'front', a: [0, 3.1], b: [8, 3.1], thickness: 0.2 }, { id: 'back', a: [0, -0.1], b: [8, -0.1], thickness: 0.2 },
      { id: 'left', a: [-0.1, 0], b: [-0.1, 3], thickness: 0.2 }, { id: 'between', a: [4, 0], b: [4, 3], thickness: 0.1 },
      { id: 'rail', a: [0, 4.5], b: [4, 4.5], thickness: 0.1 },
    ],
  };
  const inside = (id) => wallInside(plan, plan.walls.find((w) => w.id === id));
  const toward = (id) => inside(id).map((v) => Math.round(v) + 0);   // + 0: no negative zero
  assert.deepEqual(toward('front'), [0, -1], 'the balcony behind it does not make it a wall between two rooms');
  assert.deepEqual(toward('back'), [0, 1]);
  assert.deepEqual(toward('left'), [1, 0]);
  assert.equal(inside('between'), null, 'a wall between two rooms hides one of them whatever is done');
  assert.deepEqual(toward('rail'), [0, -1], 'nothing indoors on either side: the balcony counts');
  // seen from the front, the front wall is in the way, not the back one nor the side ones
  assert.equal(wallDrop(inside('front'), 0, 68 * DEG), 1);
  assert.equal(wallDrop(inside('back'), 0, 68 * DEG), 0);
  assert.equal(wallDrop(inside('left'), 0, 68 * DEG), 0);
  assert.equal(wallDrop(null, 0, 68 * DEG), 0);
  // the three-quarter view comes from the front left: both near walls
  assert.equal(wallDrop(inside('front'), -35 * DEG, 50 * DEG), 1);
  assert.equal(wallDrop(inside('left'), -35 * DEG, 50 * DEG), 1);
  // from above no wall hides anything, and in between it sinks little by little
  assert.equal(wallDrop(inside('front'), 0, LIMITS.maxElevation), 0);
  const steps = [50, 70, 76, 80, 84, 89].map((e) => wallDrop(inside('front'), 0, e * DEG));
  assert.ok(steps.every((v, i) => !i || v <= steps[i - 1]) && steps.some((v) => v > 0 && v < 1), `no jump as the eye rises: ${steps.map((v) => v.toFixed(2))}`);
});

test('a niche may take only the top of a cabinet, a lamp may stand on an arch', async () => {
  const { furnitureParts } = await page('furniture.js');
  const cabinet = (params) => furnitureParts(item('cabinet', { size: [2, 0.4, 0.9], params: { niches: [[0.3, 0.7]], doors: 1, handles: false, ...params } }));
  const fronts = (parts) => parts.filter((p) => p.size[1] === 0.012).length;
  assert.equal(fronts(cabinet({})), 2, 'a full niche: one door on each side');
  assert.equal(fronts(cabinet({ nicheHeight: 0.4 })), 4, 'under a low niche, the doors of the middle');
  const basket = (parts) => parts.find((p) => p.color === '#b99766');
  assert.ok(basket(cabinet({ baskets: 2, nicheHeight: 0.4 })).at[2] > basket(cabinet({ baskets: 2 })).at[2] + 0.3, 'the baskets stand on the floor of the niche');
  // the shade of an arch lamp is as wide as the item and sits above its base
  const lamp = furnitureParts(item('lamp', { size: [0.3, 0.3, 0.5], params: { style: 'arch' } }));
  const shade = lamp[lamp.length - 1];
  assert.ok(shade.shape === 'cyl' && Math.abs(shade.size[0] - 0.3) < 1e-9 && lamp.every((p) => p === shade || p.at[2] < shade.at[2]));
  // a corner desk on panels closes the end of its return with one too
  const desk = (legs) => furnitureParts(item('desk', { size: [2, 0.7, 0.75], params: { shape: 'L', legs } })).length;
  assert.equal(desk('panel'), 5, 'two tops and three panels');
});
