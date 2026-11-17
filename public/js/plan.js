/* Floor plan of the House tab, the part that needs no screen: the geometry read from the
   plan of the service (house/API.md), which drawing module a device gets, what the
   camera may show, and the flat view drawn when WebGL is missing or the screen narrow.
   No DOM and no three.js here: all of it is tested as is.
   Plan coordinates: meters, x to the right, y down on a view from above, z up. */

export const CUT_HEIGHT = 1.25;   // walls are cut at mid-height, as on an architect's model
const DEG = Math.PI / 180;
const clamp = (v, min, max) => Math.min(max, Math.max(min, v));

/* ---------- Geometry ---------- */
export function polygonArea(poly) {
  let a = 0;
  for (let i = 0; i < poly.length; i++) { const [x0, y0] = poly[i], [x1, y1] = poly[(i + 1) % poly.length]; a += x0 * y1 - x1 * y0; }
  return Math.abs(a) / 2;
}

export function polygonCentroid(poly) {
  let a = 0, cx = 0, cy = 0;
  for (let i = 0; i < poly.length; i++) {
    const [x0, y0] = poly[i], [x1, y1] = poly[(i + 1) % poly.length], k = x0 * y1 - x1 * y0;
    a += k; cx += (x0 + x1) * k; cy += (y0 + y1) * k;
  }
  return [cx / (3 * a), cy / (3 * a)];
}

export function pointInPolygon(poly, x, y) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i], [xj, yj] = poly[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

const boxOf = (points) => {
  const xs = points.map((p) => p[0]), ys = points.map((p) => p[1]);
  return { minX: Math.min(...xs), minY: Math.min(...ys), maxX: Math.max(...xs), maxY: Math.max(...ys) };
};
export const roomBounds = (room) => boxOf(room.polygon);
// Everything drawn: the rooms and the walls around them.
export const bounds = (plan) => boxOf([...plan.rooms.flatMap((r) => r.polygon), ...(plan.walls || []).flatMap((w) => [w.a, w.b])]);

export const roomAt = (plan, x, y) => plan.rooms.find((r) => pointInPolygon(r.polygon, x, y)) || null;

/* Where the name of a room sits: the point of the room furthest from its edges. The
   centroid of a hall shaped like a T or an L falls in a neighbor, or in a wall. */
export function labelPoint(poly) {
  const b = boxOf(poly), steps = 14;
  let best = polygonCentroid(poly), far = -1;
  for (let i = 0; i <= steps; i++) for (let j = 0; j <= steps; j++) {
    const x = b.minX + (b.maxX - b.minX) * (i + 0.5) / (steps + 1), y = b.minY + (b.maxY - b.minY) * (j + 0.5) / (steps + 1);
    if (!pointInPolygon(poly, x, y)) continue;
    let d = Infinity;
    for (let k = 0; k < poly.length; k++) {
      const [x0, y0] = poly[k], [x1, y1] = poly[(k + 1) % poly.length], len2 = (x1 - x0) ** 2 + (y1 - y0) ** 2;
      const t = len2 ? clamp(((x - x0) * (x1 - x0) + (y - y0) * (y1 - y0)) / len2, 0, 1) : 0;
      d = Math.min(d, Math.hypot(x - x0 - t * (x1 - x0), y - y0 - t * (y1 - y0)));
    }
    // a point just as far from the edges but nearer the middle reads better
    const score = d - 0.02 * Math.hypot(x - (b.minX + b.maxX) / 2, y - (b.minY + b.maxY) / 2);
    if (score > far) { far = score; best = [x, y]; }
  }
  return best;
}

// A wall as a frame: unit vector along it, its left normal, its length.
export function wallFrame(wall) {
  const dx = wall.b[0] - wall.a[0], dy = wall.b[1] - wall.a[1], length = Math.hypot(dx, dy);
  return { ux: dx / length, uy: dy / length, nx: -dy / length, ny: dx / length, length };
}

const openingsOf = (plan, wall) => (plan.openings || []).filter((o) => o.wall === wall.id).sort((a, b) => a.offset - b.offset);

/* What is left of a wall once its openings are cut out, as boxes along it:
   { from, to } in meters from `a`, { bottom, top } in height. A window keeps the wall
   under its sill, a door keeps nothing. Outside walls run half a thickness past their
   ends so corners close. */
export function wallPieces(plan, wall, cut = CUT_HEIGHT) {
  const { length } = wallFrame(wall), extra = wall.exterior ? wall.thickness / 2 : 0;
  const pieces = [];
  let cursor = -extra;
  for (const o of openingsOf(plan, wall)) {
    if (o.offset > cursor) pieces.push({ from: cursor, to: o.offset, bottom: 0, top: cut });
    const sill = o.sill || 0, head = sill + o.height;
    if (sill > 0) pieces.push({ from: o.offset, to: o.offset + o.width, bottom: 0, top: Math.min(sill, cut) });
    if (head < cut) pieces.push({ from: o.offset, to: o.offset + o.width, bottom: head, top: cut });
    cursor = o.offset + o.width;
  }
  if (length + extra > cursor) pieces.push({ from: cursor, to: length + extra, bottom: 0, top: cut });
  return pieces;
}

// Where an opening stands: its two ends and its middle on the axis of its wall.
export function openingFrame(plan, opening) {
  const wall = (plan.walls || []).find((w) => w.id === opening.wall);
  if (!wall) return null;
  const f = wallFrame(wall), at = (s) => [wall.a[0] + f.ux * s, wall.a[1] + f.uy * s];
  const start = at(opening.offset), end = at(opening.offset + opening.width), mid = at(opening.offset + opening.width / 2);
  return { ...f, wall, start, end, x: mid[0], y: mid[1] };
}

/* ---------- Walls and the eye ----------
   One rule, for every wall and every angle:
   - a wall between two rooms keeps the cut (CUT_HEIGHT): lowering it would uncover the
     back of one room's furniture, raising it would hide the other;
   - a wall with rooms on one side only is either behind them for the eye, and it stands
     high, or in front of them, and it comes down to LOW_WALL. High is one height for
     the whole home (`highOf`): the head of its highest window, so that every wall at
     the back stands the same, with or without a window of its own;
   - seen edge-on it keeps the cut, and seen from above nothing rises nor sinks;
   - the walls of one façade (on one line, their rooms on the same side) are one piece:
     they always stand at the same height.
   Openings are cut where their wall is, never moved.
   `wallInside` is the unit vector from such a wall toward its rooms (null between two
   rooms; a balcony counts when the wall has nothing indoors on either side),
   `wallSide` where the wall stands for a view, from -1 (in front of its rooms) to 1
   (behind them), `wallHeight` where it is cut. */
export const LOW_WALL = 0.4;      // what is left of a wall in the way, in meters
const HEAD_ROOM = 0.1;            // wall kept above the highest window
const HIGH_WALL = 2.1;            // a home without any window still has walls at the back
function sideOf(plan, wall) {
  const f = wallFrame(wall), reach = wall.thickness / 2 + 0.2;
  const count = (side, indoors) => [0.1, 0.3, 0.5, 0.7, 0.9].filter((k) => {
    const room = roomAt(plan, wall.a[0] + f.ux * f.length * k + f.nx * reach * side, wall.a[1] + f.uy * f.length * k + f.ny * reach * side);
    return room && (room.kind === "outdoor") !== indoors;
  }).length;
  for (const indoors of [true, false]) {
    const plus = count(1, indoors), minus = count(-1, indoors);
    if (plus && minus) return null;
    if (plus || minus) return [f.nx * (plus ? 1 : -1), f.ny * (plus ? 1 : -1)];
  }
  return undefined;               // no room on either side: nothing to go by
}
// The line a wall stands on, whichever way it was drawn: its direction and its distance from the origin.
function lineOf(wall) {
  const f = wallFrame(wall), flip = f.nx < -1e-9 || (Math.abs(f.nx) <= 1e-9 && f.ny < 0) ? -1 : 1;
  const nx = f.nx * flip, ny = f.ny * flip;
  return `${Math.round(nx * 50)},${Math.round(ny * 50)},${Math.round((wall.a[0] * nx + wall.a[1] * ny) * 10)}`;
}
/* The side of every wall, worked out once per plan. A stretch of wall that has no room
   beside it (the end of a façade past the last room) takes the side of the façade it
   continues: one façade, one behaviour. */
const sides = new WeakMap();
function insideOf(plan, wall) {
  if (!sides.has(plan)) {
    const known = new Map((plan.walls || []).map((w) => [w, sideOf(plan, w)]));
    for (const w of plan.walls || []) {
      if (known.get(w) !== undefined) continue;
      const kin = (plan.walls || []).find((o) => o !== w && known.get(o) && lineOf(o) === lineOf(w));
      known.set(w, kin ? known.get(kin) : null);
    }
    sides.set(plan, known);
  }
  const known = sides.get(plan);
  return known.has(wall) ? known.get(wall) : sideOf(plan, wall) || null;
}
export const wallInside = (plan, wall) => insideOf(plan, wall);
// Walls that stand and fall together: same line, rooms on the same side. null for a wall between two rooms.
export function facadeOf(plan, wall) {
  const inside = insideOf(plan, wall);
  return inside ? `${lineOf(wall)}|${Math.round(inside[0])},${Math.round(inside[1])}` : null;
}
/* Where a wall stands for the eye: 1 behind its rooms, -1 in front of them, 0 seen
   edge-on or from above, and smoothly in between so a wall glides while the model turns. */
export function wallSide(inside, azimuth, elevation) {
  if (!inside) return 0;
  const { back } = viewAxes(azimuth, elevation);
  // `back` goes to the eye and flattens as the eye rises: nothing from above, all of it from the front
  const toward = inside[0] * back[0] + inside[1] * back[1];
  const k = clamp((Math.abs(toward) - 0.12) / 0.2, 0, 1);
  return Math.sign(toward) * k * k * (3 - 2 * k);
}
// How much of a wall comes down for a view, from 0 to 1.
export const wallDrop = (inside, azimuth, elevation) => Math.max(0, -wallSide(inside, azimuth, elevation));
// The height a wall needs to show its own windows whole, at least the cut.
export function wallTall(plan, wall) {
  const heads = (plan.openings || []).filter((o) => o.wall === wall.id && (o.type === "window" || o.type === "french-window")).map((o) => (o.sill || 0) + o.height + HEAD_ROOM);
  return Math.max(CUT_HEIGHT, ...heads);
}
// The height of every wall that stands behind its rooms: the head of the highest window of the home.
const highs = new WeakMap();
export function highOf(plan) {
  if (!highs.has(plan)) {
    const tall = Math.max(CUT_HEIGHT, ...(plan.walls || []).map((w) => wallTall(plan, w)));
    highs.set(plan, tall > CUT_HEIGHT ? tall : HIGH_WALL);
  }
  return highs.get(plan);
}
export function wallHeight(plan, wall, azimuth, elevation) {
  return standHeight(plan, insideOf(plan, wall), azimuth, elevation);
}
/* The same rule for what hangs on a wall between two rooms (kitchen wall units): that
   wall keeps the cut, but what it carries stands or goes as if the wall belonged to the
   room it hangs in. `inside` points from the wall into that room. */
export function standHeight(plan, inside, azimuth, elevation) {
  const side = wallSide(inside, azimuth, elevation);
  return CUT_HEIGHT + (side > 0 ? side * (highOf(plan) - CUT_HEIGHT) : side * (CUT_HEIGHT - LOW_WALL));
}

/* ---------- Curtains ----------
   A curtain belongs to its window: an opening with `curtain` gets one, hung on the side
   of the room. It lies against the wall, its rod sits just above the head of the
   window, it falls to the floor and reaches a little past the window on each side.
   Returns { x, y, angle (radians, of the wall), length, top, depth, rodTop } or null. */
const CURTAIN_PAST = 0.15, CURTAIN_ABOVE = 0.08, CURTAIN_DEPTH = 0.07;
export function curtainOf(plan, opening) {
  if (!opening.curtain) return null;
  const f = openingFrame(plan, opening);
  if (!f) return null;
  // the room side: where the wall has its rooms, else the room the plan names, else the side with a room
  let inside = insideOf(plan, f.wall);
  if (!inside) {
    const reach = f.wall.thickness / 2 + 0.2, named = opening.curtain.room || opening.opensInto;
    const at = (side) => roomAt(plan, f.x + f.nx * reach * side, f.y + f.ny * reach * side);
    const side = [1, -1].find((k) => { const r = at(k); return r && (named ? r.id === named : r.kind !== "outdoor"); }) || 1;
    inside = [f.nx * side, f.ny * side];
  }
  const off = f.wall.thickness / 2 + CURTAIN_DEPTH / 2 + 0.01, head = (opening.sill || 0) + opening.height;
  return {
    x: f.x + inside[0] * off, y: f.y + inside[1] * off, angle: Math.atan2(f.uy, f.ux), inside,
    length: opening.width + 2 * CURTAIN_PAST, depth: CURTAIN_DEPTH, top: head + CURTAIN_ABOVE, rodTop: head + CURTAIN_ABOVE + 0.03,
    color: typeof opening.curtain === "object" ? opening.curtain.color || null : typeof opening.curtain === "string" ? opening.curtain : null,
  };
}

// The wall closest to a point, to lay a wall unit along it.
export function nearestWall(plan, x, y) {
  let best = null;
  for (const wall of plan.walls || []) {
    const f = wallFrame(wall);
    const s = clamp((x - wall.a[0]) * f.ux + (y - wall.a[1]) * f.uy, 0, f.length);
    const d = Math.hypot(x - (wall.a[0] + f.ux * s), y - (wall.a[1] + f.uy * s));
    if (!best || d < best.distance) best = { ...f, wall, distance: d };
  }
  return best;
}

/* The open edges of a balcony or a loggia: the sides of its floor no wall runs along.
   They get a guard rail. */
export function openEdges(plan, room) {
  const out = [];
  for (let i = 0; i < room.polygon.length; i++) {
    const p = room.polygon[i], q = room.polygon[(i + 1) % room.polygon.length];
    const mid = [(p[0] + q[0]) / 2, (p[1] + q[1]) / 2], len = Math.hypot(q[0] - p[0], q[1] - p[1]);
    if (len < 0.2) continue;
    const walled = (plan.walls || []).some((wall) => {
      const f = wallFrame(wall), s = (mid[0] - wall.a[0]) * f.ux + (mid[1] - wall.a[1]) * f.uy;
      const off = Math.abs((mid[0] - wall.a[0]) * f.nx + (mid[1] - wall.a[1]) * f.ny);
      const parallel = Math.abs(((q[0] - p[0]) * f.ux + (q[1] - p[1]) * f.uy) / len) > 0.9;
      return parallel && s > -0.05 && s < f.length + 0.05 && off < wall.thickness / 2 + 0.2;
    });
    if (!walled) out.push([p, q]);
  }
  return out;
}

/* ---------- Devices ---------- */
export const MODULES = ["light", "climate", "heater", "cover", "sensor", "appliance"];
// what stands in a room and is neither light nor heat: a marker where it is, nothing drawn
const APPLIANCES = ["water", "tv", "washer"];

/* The drawing module of a device: its type when the plan knows it, otherwise what its
   capabilities say it is. A new type needs a new module, nothing else. */
export function moduleFor(device) {
  if (!device) return null;
  if (MODULES.includes(device.type)) return device.type;
  if (APPLIANCES.includes(device.type)) return "appliance";
  const caps = device.capabilities || {}, state = device.state || {};
  if (caps.position) return "cover";
  if (caps.brightness || caps.colorRgb || caps.colorTempK) return "light";
  if (caps.setpoint) return caps.fan || (caps.mode && caps.mode.options.includes("cool")) ? "climate" : "heater";
  if (state.temperature != null) return "sensor";
  return null;
}

/* Where an anchor stands. On an opening it takes the middle of the opening, at the
   height of its head. */
export function anchorPoint(plan, anchor) {
  if (anchor.position) return { x: anchor.position[0], y: anchor.position[1], z: anchor.position[2], opening: null };
  const opening = (plan.openings || []).find((o) => o.id === anchor.openingId);
  const frame = opening && openingFrame(plan, opening);
  return frame ? { x: frame.x, y: frame.y, z: (opening.sill || 0) + opening.height, opening } : null;
}

// The anchored devices the service knows, with their module and their place.
export function placedDevices(plan, rooms) {
  const devices = new Map((rooms || []).flatMap((r) => r.devices).map((d) => [d.id, d]));
  const out = [];
  for (const anchor of plan.anchors || []) {
    const device = devices.get(anchor.deviceId), module = moduleFor(device), point = anchorPoint(plan, anchor);
    // a shutter needs its window: without one there is nothing to draw it on
    if (!device || !module || !point || (module === "cover" && !point.opening)) continue;
    out.push({ device, anchor, point, module });
  }
  return out;
}

/* The tint of a room from the temperature of its own sensor: neutral between 19 and
   21 degrees, cooler below, warmer above, full strength 4 degrees away. */
export function temperatureTint(t) {
  if (t == null || !Number.isFinite(t)) return { tone: null, strength: 0 };
  if (t < 19) return { tone: "cool", strength: clamp((19 - t) / 4, 0, 1) };
  if (t > 21) return { tone: "warm", strength: clamp((t - 21) / 4, 0, 1) };
  return { tone: null, strength: 0 };
}

// How far a shutter is down: 0 open, 1 closed. `position` is 0 (closed) to 100 (open).
export const coverClosed = (state) => 1 - clamp(Number(state && state.position) || 0, 0, 100) / 100;

/* ---------- Camera ----------
   A view is what to look at and from where: { subject, azimuth, elevation, zoom }.
   `subject` is "plan" or a room id. The frame is worked out from it for the shape of
   the screen: the subject always fills the same share of the picture, whatever the
   angle and the size of the card. azimuth turns around the vertical, elevation is 90
   degrees from above, zoom 1 is the fitted frame. A view marked `auto` has no angle
   of its own: it takes the one that shows the home largest on that screen. */
// zoomed out to the most, the home still covers FILL x minZoom of the side that limits it: 86 %
export const LIMITS = { minElevation: 28 * DEG, maxElevation: 89.5 * DEG, minZoom: 0.92, maxZoom: 6 };
export const FILL = 0.94;         // share of the picture the home takes: the pad under it reaches the edge
const ROOM_FILL = 0.62;           // a framed room keeps its neighbors in sight
const ISO = { azimuth: -35 * DEG, elevation: 50 * DEG };
// the model may be seen more from the front and from higher, never from lower
const ISO_AZIMUTHS = [-35, -25, -15, -8, 0].map((d) => d * DEG), ISO_ELEVATIONS = [50, 56, 62, 68].map((d) => d * DEG);

// The views offered: the whole plan as a model or from above, and one per room.
export function presets(plan) {
  const rooms = {};
  for (const r of plan.rooms) rooms[r.id] = { subject: r.id, zoom: 1, auto: true, ...ISO };
  return { iso: { subject: "plan", zoom: 1, auto: true, ...ISO }, top: { subject: "plan", zoom: 1, auto: "top", azimuth: 0, elevation: LIMITS.maxElevation }, rooms };
}

// The extent of a set of points on screen, for a view angle.
function extent(points, azimuth, elevation) {
  const { right, up } = viewAxes(azimuth, elevation);
  let minR = Infinity, maxR = -Infinity, minU = Infinity, maxU = -Infinity;
  for (const p of points) {
    const r = p[0] * right[0] + p[1] * right[1] + p[2] * right[2], u = p[0] * up[0] + p[1] * up[1] + p[2] * up[2];
    minR = Math.min(minR, r); maxR = Math.max(maxR, r); minU = Math.min(minU, u); maxU = Math.max(maxU, u);
  }
  return { right, up, minR, maxR, minU, maxU, width: maxR - minR, height: maxU - minU };
}

/* The angle of the model for a screen of the given aspect: of the angles allowed, the
   one at which the home covers most of the picture. A wide card keeps the usual
   three-quarter view, which also wins when another angle is hardly better. A tall card
   looks from higher and more from the front, and if the home is longer one way than
   the other, from the side that stands its long axis upright: a quarter turn, taken
   only when it clearly shows the home larger. */
export function modelAngle(plan, aspect) {
  const cover = (azimuth, elevation) => { const e = extent(subjectPoints(plan, "plan", azimuth, elevation), azimuth, elevation), fit = Math.max(e.height, e.width / aspect); return (e.height / fit) * (e.width / aspect / fit); };
  let best = ISO, most = cover(ISO.azimuth, ISO.elevation) * 1.04;
  for (const quarter of aspect < 1 ? [0, Math.PI / 2, -Math.PI / 2] : [0]) for (const azimuth of ISO_AZIMUTHS) for (const elevation of ISO_ELEVATIONS) {
    const c = cover(azimuth + quarter, elevation) / (quarter ? 1.12 : 1);
    if (c > most) { most = c; best = { azimuth: azimuth + quarter, elevation }; }
  }
  return best;
}

/* From above, north up, unless a quarter turn stands a long home upright in a tall card
   (or lying in a wide one) and shows it clearly larger: a home twice as wide as deep, seen
   north up in a card twice as tall as wide, would fill a quarter of it. */
export function topAngle(plan, aspect) {
  const elevation = LIMITS.maxElevation;
  const cover = (azimuth) => { const e = extent(subjectPoints(plan, "plan", azimuth, elevation), azimuth, elevation), fit = Math.max(e.height, e.width / aspect); return (e.height / fit) * (e.width / aspect / fit); };
  const north = cover(0), turned = cover(Math.PI / 2);
  return { azimuth: turned > north * 1.12 ? Math.PI / 2 : 0, elevation };
}

// The camera never dives under the walls, flips over, nor backs away from the plan.
export function clampView(view) {
  return { ...view, elevation: clamp(view.elevation, LIMITS.minElevation, LIMITS.maxElevation), zoom: clamp(view.zoom ?? 1, LIMITS.minZoom, LIMITS.maxZoom) };
}

// Screen axes of a view, as plan vectors [x, y, z]: `right`, `up`, and `back` toward the eye.
export function viewAxes(azimuth, elevation) {
  const sa = Math.sin(azimuth), ca = Math.cos(azimuth), se = Math.sin(elevation), ce = Math.cos(elevation);
  return { right: [ca, -sa, 0], up: [-se * sa, -se * ca, ce], back: [sa * ce, ca * ce, se] };
}

// What a view has to hold: the corners of the home, or of one room, floor and walls as that view cuts them.
export function subjectPoints(plan, subject, azimuth, elevation) {
  const room = plan.rooms.find((r) => r.id === subject);
  if (room) return room.polygon.flatMap(([x, y]) => [[x, y, 0], [x, y, CUT_HEIGHT]]);
  const points = plan.rooms.flatMap((r) => r.polygon.map(([x, y]) => [x, y, 0]));
  for (const w of plan.walls || []) {
    const h = azimuth == null ? CUT_HEIGHT : wallHeight(plan, w, azimuth, elevation);
    for (const [x, y] of [w.a, w.b]) points.push([x, y, 0], [x, y, h]);
  }
  return points;
}

/* The frame of a view on a screen of the given aspect (width / height): `center` is the
   point looked at, `height` the meters the picture shows from bottom to top. `pan` moves
   that point over the ground, in meters of the plan. */
export function frameView(plan, view, aspect) {
  const { azimuth, elevation } = view.auto === "top" ? topAngle(plan, aspect) : view.auto ? modelAngle(plan, aspect) : view;
  const e = extent(subjectPoints(plan, view.subject, azimuth, elevation), azimuth, elevation);
  const cr = (e.minR + e.maxR) / 2, cu = (e.minU + e.maxU) / 2, pan = view.pan || [0, 0];
  const fill = plan.rooms.some((r) => r.id === view.subject) ? ROOM_FILL : FILL;
  return {
    center: [0, 1, 2].map((i) => cr * e.right[i] + cu * e.up[i] + (pan[i] || 0)),
    height: Math.max(e.height, e.width / aspect) / fill / (view.zoom || 1),
    azimuth, elevation,
  };
}

// The share of the picture the home takes in a view, across (w) and up (h).
export function homeShare(plan, view, aspect) {
  const f = frameView(plan, view, aspect), e = extent(subjectPoints(plan, view.subject, f.azimuth, f.elevation), f.azimuth, f.elevation);
  return { w: e.width / (f.height * aspect), h: e.height / f.height };
}

/* ---------- Moving by hand ----------
   `groundShift` is the move over the ground that slides the picture by (right, up)
   meters. `panBy` slides a view that way, `zoomAt` zooms it by k while the point at
   (right, up) meters from the middle of the picture stays under the pointer.
   `holdView` keeps a view within its limits: never under the floor, never so far
   that the home leaves the picture. */
export function groundShift(azimuth, elevation, right, up) {
  const a = viewAxes(azimuth, elevation), flat = a.up[0] ** 2 + a.up[1] ** 2 || 1e-9;
  return [a.right[0] * right + a.up[0] * up / flat, a.right[1] * right + a.up[1] * up / flat];
}
export function holdView(plan, view) {
  const b = bounds(plan), pan = view.pan || [0, 0];
  const reachX = (b.maxX - b.minX) / 2, reachY = (b.maxY - b.minY) / 2;
  return { ...clampView(view), pan: [clamp(pan[0], -reachX, reachX), clamp(pan[1], -reachY, reachY)] };
}
export function panBy(plan, view, right, up) {
  const [dx, dy] = groundShift(view.azimuth, view.elevation, right, up), pan = view.pan || [0, 0];
  return holdView(plan, { ...view, pan: [pan[0] - dx, pan[1] - dy] });
}
export function zoomAt(plan, view, k, right, up) {
  const zoom = clamp((view.zoom || 1) * k, LIMITS.minZoom, LIMITS.maxZoom), kept = 1 - (view.zoom || 1) / zoom;
  const [dx, dy] = groundShift(view.azimuth, view.elevation, right * kept, up * kept), pan = view.pan || [0, 0];
  return holdView(plan, { ...view, zoom, pan: [pan[0] + dx, pan[1] + dy] });
}

// Between two frames, turning the short way round. k goes from 0 to 1.
export function mixFrame(a, b, k) {
  const turn = ((b.azimuth - a.azimuth + Math.PI) % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI) - Math.PI;
  const mix = (x, y) => x + (y - x) * k;
  return { center: a.center.map((v, i) => mix(v, b.center[i])), height: mix(a.height, b.height), azimuth: a.azimuth + turn * k, elevation: mix(a.elevation, b.elevation) };
}

/* ---------- Daylight ----------
   Where the light of the sun comes from on the plan. `north` is the plan vector that
   points north, `azimuth` is counted clockwise from north, as on a compass, and
   `elevation` above the horizon, both in degrees. Returns the unit vector toward the
   sun as [x, y, z], and how much day there is: 0 at night, 1 once the sun is up. */
export function sunlight(north, sun) {
  const len = Math.hypot(north[0], north[1]) || 1, n = [north[0] / len, north[1] / len];
  const east = [-n[1], n[0]];      // y goes down on the plan: east is a quarter turn clockwise on screen
  const a = sun.azimuth * DEG, e = sun.elevation * DEG, h = Math.cos(e);
  return {
    toward: [(Math.cos(a) * n[0] + Math.sin(a) * east[0]) * h, (Math.cos(a) * n[1] + Math.sin(a) * east[1]) * h, Math.sin(e)],
    day: clamp((sun.elevation + 6) / 12, 0, 1),     // civil twilight to 6 degrees up
  };
}

/* ---------- Flat view ---------- */
const ESC = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ESC[c]);
const n = (v) => Number(v.toFixed(3));
// The four corners of an item on the floor, turned by its rotation (degrees, clockwise on the plan).
export function footprint(item) {
  const [w, d] = item.size, a = (item.rotation || 0) * DEG, c = Math.cos(a), s = Math.sin(a);
  return [[-w / 2, -d / 2], [w / 2, -d / 2], [w / 2, d / 2], [-w / 2, d / 2]].map(([x, y]) => [item.position[0] + x * c - y * s, item.position[1] + x * s + y * c]);
}

/* The plan from above as SVG, for a screen without WebGL or too narrow for the model.
   `placed` comes from placedDevices(). Options: `simple` drops furniture and names,
   `room` frames one room, `temperatures` maps room ids to their sensor reading,
   `label(device)` gives the short text of a marker and `color(device)` the color of a
   lit lamp, which also tints the floor of its room. Colors come from the stylesheet,
   through the classes. */
export function planSvg(plan, placed, { simple = false, room = null, temperatures = {}, label = () => "", color = () => null } = {}) {
  const focus = room && plan.rooms.find((r) => r.id === room);
  const b = focus ? roomBounds(focus) : bounds(plan), pad = focus ? 0.6 : 0.35;
  const parts = [];
  // a room with a lamp on takes the color of the first one
  const litBy = new Map();
  for (const { device, point, module } of placed) {
    const lamp = module === "light" && device.state && device.state.reachable !== false && device.state.on ? color(device) : null;
    const home = lamp && (roomAt(plan, point.x, point.y) || plan.rooms.find((r) => r.id === device.room));
    if (home && !litBy.has(home.id)) litBy.set(home.id, lamp);
  }
  for (const r of plan.rooms) {
    const tint = temperatureTint(temperatures[r.id]), lamp = litBy.get(r.id);
    const cls = ["pRoom", r.kind || "room", lamp ? "lit" : tint.tone || "", r.id === room ? "sel" : ""].filter(Boolean).join(" ");
    parts.push(`<path class="${cls}" data-room="${esc(r.id)}" style="--strength:${n(tint.strength)}${lamp ? `;--lamp:${esc(lamp)}` : ""}" d="M${r.polygon.map((p) => `${n(p[0])} ${n(p[1])}`).join("L")}Z"/>`);
  }
  if (!simple) {
    for (const f of plan.furniture || []) {
      if (f.elevation > CUT_HEIGHT) continue;    // hung above the cut: not seen from above either
      parts.push(`<polygon class="pFurniture" points="${footprint(f).map((p) => `${n(p[0])},${n(p[1])}`).join(" ")}"/>`);
    }
  }
  for (const wall of plan.walls || []) {
    const f = wallFrame(wall);
    for (const piece of wallPieces(plan, wall)) {
      if (piece.bottom > 0) continue;
      const x1 = wall.a[0] + f.ux * piece.from, y1 = wall.a[1] + f.uy * piece.from, x2 = wall.a[0] + f.ux * piece.to, y2 = wall.a[1] + f.uy * piece.to;
      // the wall under a window is drawn thinner: it reads as a sill
      parts.push(`<line class="pWall${piece.top < CUT_HEIGHT ? " sill" : ""}" x1="${n(x1)}" y1="${n(y1)}" x2="${n(x2)}" y2="${n(y2)}" stroke-width="${n(wall.thickness * (piece.top < CUT_HEIGHT ? 0.45 : 1))}"/>`);
    }
  }
  for (const o of plan.openings || []) {
    if (o.type !== "window" && o.type !== "french-window") continue;
    const f = openingFrame(plan, o);
    if (f) parts.push(`<line class="pGlass" x1="${n(f.start[0])}" y1="${n(f.start[1])}" x2="${n(f.end[0])}" y2="${n(f.end[1])}"/>`);
  }
  if (!simple) {
    for (const r of plan.rooms) {
      if (r.kind === "shaft" || r.kind === "unknown") continue;
      const [cx, y0] = labelPoint(r.polygon);
      // the name steps aside when a device sits in the middle of the room
      const taken = (y) => placed.some(({ point }) => Math.abs(point.x - cx) < 1 && Math.abs(point.y - y) < 0.4);
      const cy = [y0, y0 + 0.65, y0 - 0.65].find((y) => !taken(y) && pointInPolygon(r.polygon, cx, y)) ?? y0;
      parts.push(`<text class="pName${polygonArea(r.polygon) < 3 ? " small" : ""}" x="${n(cx)}" y="${n(cy)}">${esc(r.name)}</text>`);
    }
  }
  for (const { device, point, module } of placed) {
    const s = device.state || {}, on = module === "cover" ? coverClosed(s) < 1 : !!s.on;
    const cls = ["pPin", module, s.reachable === false ? "gone" : on ? "on" : "off"].join(" ");
    const lamp = module === "light" && s.on ? color(device) : null;
    let body;
    if (module === "cover") {
      // the shutter is a bar on its window, thicker as it comes down
      const f = openingFrame(plan, point.opening);
      body = `<line class="pCover" x1="${n(f.start[0])}" y1="${n(f.start[1])}" x2="${n(f.end[0])}" y2="${n(f.end[1])}" stroke-width="${n(0.06 + 0.2 * coverClosed(s))}"/><circle class="pHit" cx="${n(point.x)}" cy="${n(point.y)}" r="0.34"/>`;
    } else {
      const text = label(device);
      body = `${lamp ? `<circle class="pGlow" cx="${n(point.x)}" cy="${n(point.y)}" r="${n(0.5 + (s.brightness || 60) / 100)}"/>` : ""}<circle class="pDot" cx="${n(point.x)}" cy="${n(point.y)}" r="0.2"/>${text ? `<text class="pLabel" x="${n(point.x)}" y="${n(point.y - 0.34)}">${esc(text)}</text>` : ""}`;
    }
    const mode = module === "climate" && on && s.mode ? ` data-mode="${esc(s.mode)}"` : "";
    parts.push(`<g class="${cls}" data-device="${esc(device.id)}"${mode} role="button" tabindex="0" aria-label="${esc(device.name)}"${lamp ? ` style="--lamp:${esc(lamp)}"` : ""}>${body}</g>`);
  }
  const box = [b.minX - pad, b.minY - pad, b.maxX - b.minX + 2 * pad, b.maxY - b.minY + 2 * pad].map(n).join(" ");
  return `<svg class="planFlat" viewBox="${box}" preserveAspectRatio="xMidYMid meet">${parts.join("")}</svg>`;
}
