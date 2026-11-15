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
  // a curtain placed by hand: sheer folds under a rod, all of it fixed to the wall behind
  const curtain = furnitureParts(item('curtain', { size: [1.6, 0.1, 2.2] }));
  assert.ok(curtain.filter((p) => p.look === 'sheer').length >= 3 && curtain.every((p) => p.bound));
  assert.equal(curtain.filter((p) => p.look === 'solid').length, 1, 'its rod');
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

test('a wall behind its rooms rises to show its windows whole, one in the way is cut under them', async () => {
  const { wallHeight, wallTall, wallPieces, subjectPoints, CUT_HEIGHT, LOW_WALL, LIMITS } = await page('plan.js');
  const DEG = Math.PI / 180;
  const plan = {
    rooms: [{ id: 'a', polygon: [[0, 0], [4, 0], [4, 3], [0, 3]] }, { id: 'b', polygon: [[4, 0], [8, 0], [8, 3], [4, 3]] }],
    walls: [
      { id: 'front', a: [0, 3.1], b: [8, 3.1], thickness: 0.2 }, { id: 'back', a: [0, -0.1], b: [8, -0.1], thickness: 0.2 },
      { id: 'blank', a: [-0.1, 0], b: [-0.1, 3], thickness: 0.2 }, { id: 'between', a: [4, 0], b: [4, 3], thickness: 0.1 },
    ],
    openings: [
      { id: 'w1', type: 'window', wall: 'back', offset: 1, width: 1.2, height: 1.2, sill: 1 },
      { id: 'w2', type: 'window', wall: 'front', offset: 5, width: 1.2, height: 1.2, sill: 1 },
      { id: 'd', type: 'door', wall: 'between', offset: 1, width: 0.8, height: 2 },
    ],
  };
  const wall = (id) => plan.walls.find((w) => w.id === id);
  const high = (id, azimuth, elevation) => +wallHeight(plan, wall(id), azimuth * DEG, elevation * DEG).toFixed(3);
  assert.equal(+wallTall(plan, wall('back')).toFixed(3), 2.3, 'the head of its window and a little wall above');
  assert.equal(wallTall(plan, wall('blank')), CUT_HEIGHT, 'a wall without a window has nothing to show higher');
  // from the front: the back wall whole, the front one low, the others at the cut
  assert.deepEqual(['back', 'front', 'blank', 'between'].map((id) => high(id, 0, 68)), [2.3, LOW_WALL, CUT_HEIGHT, CUT_HEIGHT]);
  // turned half round, they trade places
  assert.deepEqual(['back', 'front'].map((id) => high(id, 180, 68)), [LOW_WALL, 2.3]);
  // from above every wall is at the cut: a window is the strip of glass of a drawn plan
  assert.deepEqual(['back', 'front', 'blank'].map((id) => +wallHeight(plan, wall(id), 0, LIMITS.maxElevation).toFixed(2)), [CUT_HEIGHT, CUT_HEIGHT, CUT_HEIGHT]);
  // the pieces of a wall follow the height asked: glass from the sill to the head, wall above
  const pieces = wallPieces(plan, wall('back'), 2.3).filter((p) => p.from === 1);
  assert.deepEqual(pieces.map((p) => [p.bottom, p.top]), [[0, 1], [2.2, 2.3]]);
  // the frame of a view holds the walls as that view cuts them
  const top = (azimuth) => Math.max(...subjectPoints(plan, 'plan', azimuth * DEG, 68 * DEG).filter((p) => p[1] < 0).map((p) => p[2]));
  assert.deepEqual([top(0), top(180)].map((v) => +v.toFixed(2)), [2.3, LOW_WALL]);
});

test('sliding and zooming by hand: the point under the pointer stays, the home is never lost', async () => {
  const { groundShift, panBy, zoomAt, holdView, frameView, viewAxes, LIMITS } = await page('plan.js');
  const DEG = Math.PI / 180;
  const plan = { rooms: [{ id: 'a', polygon: [[0, 0], [6, 0], [6, 4], [0, 4]] }], walls: [] };
  const view = { subject: 'plan', azimuth: -35 * DEG, elevation: 50 * DEG, zoom: 1 };
  // where a point of the floor lands in the picture, in meters from its middle
  const seen = (v, [x, y]) => {
    const f = frameView(plan, v, 1.5), a = viewAxes(f.azimuth, f.elevation), d = [x - f.center[0], y - f.center[1], -f.center[2]];
    return [0, 1].map((i) => d[0] * a[i ? 'up' : 'right'][0] + d[1] * a[i ? 'up' : 'right'][1] + d[2] * a[i ? 'up' : 'right'][2]);
  };
  const close = (a, b, why) => assert.ok(a.every((v, i) => Math.abs(v - b[i]) < 1e-9), `${why}: ${a} vs ${b}`);
  // a move over the ground that slides the picture by one meter right, then one up
  for (const [right, up] of [[1, 0], [0, 1], [0.4, -0.7]]) {
    const [dx, dy] = groundShift(view.azimuth, view.elevation, right, up), a = viewAxes(view.azimuth, view.elevation);
    close([dx * a.right[0] + dy * a.right[1], dx * a.up[0] + dy * a.up[1]], [right, up], 'ground shift');
  }
  // the floor follows the hand
  const before = seen(view, [2, 1]), slid = panBy(plan, view, 0.5, -0.3);
  close(seen(slid, [2, 1]), [before[0] + 0.5, before[1] - 0.3], 'slide');
  // zooming on a point of the picture leaves what is there where it is
  const at = seen(view, [5, 3]), zoomed = zoomAt(plan, view, 2, at[0], at[1]);
  assert.equal(zoomed.zoom, 2);
  // the picture shows half the meters: the same place on screen is half as far from the middle
  close(seen(zoomed, [5, 3]).map((v) => v * 2), at, 'zoom on the pointer');
  assert.equal(frameView(plan, zoomed, 1.5).height, frameView(plan, view, 1.5).height / 2);
  // limits: the zoom, the floor, and a slide that stops at the edge of the home
  assert.equal(zoomAt(plan, view, 100, 0, 0).zoom, LIMITS.maxZoom);
  assert.equal(holdView(plan, { ...view, elevation: -1 }).elevation, LIMITS.minElevation);
  assert.deepEqual(holdView(plan, { ...view, pan: [50, -50] }).pan, [3, -2]);
  assert.deepEqual(panBy(plan, panBy(plan, view, 1000, 1000), -1000, -1000).pan.map((v) => Math.abs(v)), [3, 2], 'held at the edge both ways');
});

/* ---------- One rule for the walls ---------- */
test('seen from eight angles, a wall behind its rooms is high, one in front is low, and a façade is one piece', async () => {
  const { wallHeight, wallInside, facadeOf, highOf, CUT_HEIGHT, LOW_WALL } = await page('plan.js');
  const DEG = Math.PI / 180, plan = demo();
  const high = highOf(plan);
  assert.ok(high > CUT_HEIGHT + 0.8, 'the head of the highest window of the home');
  for (const azimuth of [0, 45, 90, 135, 180, 225, 270, 315]) {
    // toward the eye, on the ground: where the camera stands
    const eye = [Math.sin(azimuth * DEG), Math.cos(azimuth * DEG)];
    const byFacade = new Map();
    for (const wall of plan.walls) {
      const inside = wallInside(plan, wall), h = +wallHeight(plan, wall, azimuth * DEG, 50 * DEG).toFixed(3);
      if (!inside) { assert.equal(h, CUT_HEIGHT, `${wall.id} at ${azimuth}°: a wall between two rooms keeps the cut`); continue; }
      const toward = inside[0] * eye[0] + inside[1] * eye[1];
      // its rooms are between the wall and the eye: it stands behind them
      const expected = toward > 0.01 ? +high.toFixed(3) : toward < -0.01 ? LOW_WALL : CUT_HEIGHT;
      assert.equal(h, expected, `${wall.id} at ${azimuth}°`);
      const key = facadeOf(plan, wall);
      if (byFacade.has(key)) assert.equal(h, byFacade.get(key), `${wall.id} at ${azimuth}°: same height as the rest of its façade`);
      byFacade.set(key, h);
    }
  }
  // every outside wall of the demo flat is one of four façades, and they are never all high nor all low
  assert.equal(new Set(plan.walls.map((w) => facadeOf(plan, w)).filter(Boolean)).size, 4);
  const heights = ['w-north', 'w-east', 'w-south', 'w-west'].map((id) => +wallHeight(plan, plan.walls.find((w) => w.id === id), -35 * DEG, 50 * DEG).toFixed(2));
  assert.deepEqual(heights, [+high.toFixed(2), +high.toFixed(2), LOW_WALL, LOW_WALL], 'the usual three-quarter view: the two walls at the back stand, the two in front come down');
});

test('a wall without a window stands as high as the others at the back, and a stretch of façade past the last room follows its façade', async () => {
  const { wallHeight, wallInside, facadeOf, highOf, CUT_HEIGHT, LOW_WALL } = await page('plan.js');
  const DEG = Math.PI / 180;
  const plan = {
    rooms: [{ id: 'a', polygon: [[0, 0], [4, 0], [4, 3], [0, 3]] }],
    walls: [
      { id: 'back', a: [0, -0.1], b: [4, -0.1], thickness: 0.2 },
      { id: 'back-end', a: [4, -0.1], b: [6, -0.1], thickness: 0.2 },     // the façade goes on past the room: no room beside it
      { id: 'blank', a: [-0.1, 0], b: [-0.1, 3], thickness: 0.2 },
      { id: 'front', a: [4, 3.1], b: [0, 3.1], thickness: 0.2 },          // drawn the other way round
      { id: 'lost', a: [9, 9], b: [9, 12], thickness: 0.2 },              // a wall on its own, away from everything
    ],
    openings: [{ id: 'w', type: 'window', wall: 'back', offset: 1, width: 1.2, height: 1.2, sill: 1 }],
  };
  const wall = (id) => plan.walls.find((w) => w.id === id), at = (id, azimuth) => +wallHeight(plan, wall(id), azimuth * DEG, 50 * DEG).toFixed(2);
  assert.equal(+highOf(plan).toFixed(2), 2.3);
  assert.equal(at('blank', 90), 2.3, 'no window of its own, and still as high as the wall with one');
  assert.equal(at('blank', 270), LOW_WALL);
  assert.deepEqual(wallInside(plan, wall('back-end')).map((v) => Math.round(v) + 0), [0, 1], 'it takes the side of the façade it continues');
  assert.equal(facadeOf(plan, wall('back-end')), facadeOf(plan, wall('back')));
  for (const azimuth of [0, 45, 135, 180, 315]) assert.equal(at('back-end', azimuth), at('back', azimuth), `one façade at ${azimuth}°`);
  assert.deepEqual([at('front', 0), at('front', 180)], [LOW_WALL, 2.3], 'the way a wall was drawn changes nothing');
  assert.equal(wallInside(plan, wall('lost')), null);
  assert.equal(at('lost', 0), CUT_HEIGHT);
  // a home without any window: its walls at the back still stand
  const blind = { rooms: plan.rooms, walls: plan.walls.slice(0, 3), openings: [] };
  assert.equal(+highOf(blind).toFixed(2), 2.1);
  assert.equal(+wallHeight(blind, blind.walls[0], 0, 50 * DEG).toFixed(2), 2.1);
});

test('a curtain hangs at its window: against the wall, its rod just above the head, down to the floor, a little wider', async () => {
  const { curtainOf } = await page('plan.js');
  const plan = {
    rooms: [{ id: 'a', polygon: [[0, 0], [4, 0], [4, 3], [0, 3]] }, { id: 'b', polygon: [[0, 3.2], [4, 3.2], [4, 6], [0, 6]] }],
    walls: [{ id: 'back', a: [0, -0.1], b: [4, -0.1], thickness: 0.2 }, { id: 'between', a: [0, 3.1], b: [4, 3.1], thickness: 0.2 }],
    openings: [
      { id: 'w', type: 'window', wall: 'back', offset: 1, width: 1.4, height: 1.2, sill: 1, curtain: 'white' },
      { id: 'bare', type: 'window', wall: 'back', offset: 2.6, width: 0.6, height: 1.2, sill: 1 },
      { id: 'inner', type: 'window', wall: 'between', offset: 1, width: 1, height: 1, sill: 1, curtain: { color: 'linen', room: 'b' } },
    ],
  };
  const c = curtainOf(plan, plan.openings[0]);
  assert.equal(+c.length.toFixed(2), 1.7, '15 cm past the window on each side');
  assert.equal(+c.top.toFixed(2), 2.28, 'the head of the window is at 2.20 m: the rod sits just above');
  assert.ok(c.rodTop > c.top && c.rodTop - c.top < 0.05);
  assert.deepEqual([+c.x.toFixed(2), c.color], [1.7, 'white'], 'centered on its window');
  assert.ok(c.y > 0 && c.y < 0.06, `inside the room, against the wall (y = ${c.y.toFixed(3)})`);
  assert.deepEqual(c.inside.map((v) => Math.round(v) + 0), [0, 1]);
  assert.equal(curtainOf(plan, plan.openings[1]), null, 'a window without a curtain has none');
  // between two rooms the plan says which one it dresses
  const inner = curtainOf(plan, plan.openings[2]);
  assert.ok(inner.y > 3.2 && inner.color === 'linen');
});

test('kitchen units stand at the standard height whatever the plan says, their wall units fixed to the wall', async () => {
  const { furnitureParts } = await page('furniture.js');
  const top = (parts) => Math.max(...parts.map((p) => p.at[2] + p.size[2] / 2));
  for (const height of [0.7, 0.9, 1.4]) {
    const parts = furnitureParts(item('kitchen', { size: [2.4, 0.6, height], params: { doors: 4 } }));
    assert.ok(parts.every((p) => !p.bound) && Math.abs(top(parts.filter((p) => p.shape === 'box')) - 0.9) < 1e-9, `worktop at 0.90 m for a plan that says ${height}`);
  }
  const run = furnitureParts(item('kitchen', { size: [2.4, 0.6, 0.9], params: { doors: 4, uppers: true, hob: [0.1, 0.4], sink: [0.6, 0.85] } }));
  const uppers = run.filter((p) => p.bound);
  assert.equal(uppers.length, 6, 'a carcass, four fronts and the splashback behind them');
  const splash = uppers[5];
  assert.deepEqual([+(splash.at[2] - splash.size[2] / 2).toFixed(2), +(splash.at[2] + splash.size[2] / 2).toFixed(2)], [0.9, 2.1], 'from the worktop to the top of the wall units');
  const carcass = uppers[0];
  assert.deepEqual([+(carcass.at[2] - carcass.size[2] / 2).toFixed(2), +(carcass.at[2] + carcass.size[2] / 2).toFixed(2)], [1.4, 2.1], 'above the worktop, not cut at the cut of the furniture');
  assert.ok(Math.abs(carcass.at[1] - carcass.size[1] / 2 - -0.3) < 1e-9, 'its back is the back of the run: against the wall');
  assert.ok(carcass.size[1] < 0.6, 'shallower than the units under it');
  assert.ok(run.length > furnitureParts(item('kitchen', { size: [2.4, 0.6, 0.9], params: { doors: 4, uppers: true } })).length, 'a hob and a sink are drawn on the worktop');
});

test('a plant is a round pot, pebbles, and stems that each carry a leaf', async () => {
  const { furnitureParts } = await page('furniture.js');
  const plant = (params) => furnitureParts(item('plant', { size: [0.55, 0.55, 1.7], params }));
  const parts = plant({ pot: 'cream', stems: 7 });
  const stems = parts.filter((p) => p.shape === 'cyl' && p.tilt != null), leaves = parts.filter((p) => p.shape === 'box' && p.tilt != null);
  assert.deepEqual([stems.length, leaves.length], [7, 7]);
  assert.ok(leaves.every((l, i) => l.tilt > stems[i].tilt && l.size[0] > 5 * l.size[1]), 'a leaf leans further out than its stem, and is a blade');
  assert.ok(new Set(stems.map((s) => Math.round(s.turn))).size >= 6, 'each stem goes its own way');
  assert.equal(parts.filter((p) => p.shape === 'cyl' && p.size[2] === 0.03 && p.size[0] < 0.2).length, 11, 'pebbles on the soil');
  assert.equal(plant({ pebbles: false }).filter((p) => p.shape === 'cyl' && p.size[2] === 0.03 && p.size[0] < 0.2).length, 0);
  assert.ok(Math.max(...parts.map((p) => p.at[2])) < 1.75, 'nothing above the height the plan gives');
  assert.equal(plant({ stems: 40 }).filter((p) => p.shape === 'box').length, 12, 'no forest in a pot');
  assert.deepEqual(plant({ pot: 'cream' }), plant({ pot: 'cream' }), 'the same plant at every drawing');
});

test('what hangs on a wall between two rooms stands or goes with the side of its own room', async () => {
  const { standHeight, highOf, CUT_HEIGHT, LOW_WALL } = await page('plan.js');
  const DEG = Math.PI / 180, plan = demo(), high = +highOf(plan).toFixed(2);
  // wall units in a room that lies north of their wall: `inside` points north (toward -y)
  const at = (azimuth) => +standHeight(plan, [0, -1], azimuth * DEG, 50 * DEG).toFixed(2);
  const eyes = [0, 90, 180, 270].map(at);
  assert.equal(eyes.filter((h) => h === high).length, 1, 'they stand from one side only');
  assert.equal(eyes.filter((h) => h === LOW_WALL).length, 1, 'and go when the eye is behind their wall');
  assert.equal(eyes.filter((h) => h === CUT_HEIGHT).length, 2, 'edge-on they keep the cut');
  assert.equal(+standHeight(plan, null, 0, 50 * DEG).toFixed(2), CUT_HEIGHT);
});
