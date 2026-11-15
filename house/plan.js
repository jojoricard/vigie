/* The floor plan of the home: rooms, walls, openings, furniture, and anchors that tie
 * a device of the service to a place (see API.md). Private data: it is read from the
 * file named by house.planPath and only leaves through GET /api/v1/plan, behind the
 * service's access rules. Nothing of it belongs in a public folder.
 * Units are meters, x and y on the floor, z up. */
const fs = require('fs');

const VERSION = 1;
const OPENING_TYPES = ['door', 'window', 'french-window', 'passage', 'closet'];
const FLOORS = ['wood', 'tile', 'concrete', 'carpet', 'none'];
const EPS = 1e-6;

// A plan that cannot be read or does not follow the schema: the route answers with its
// list of faults, the service keeps running.
class PlanError extends Error {
  constructor(message, details = []) { super(message); this.details = details; }
}

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const isPoint = (p, n = 2) => Array.isArray(p) && p.length === n && p.every(isNum);
const isId = (v) => typeof v === 'string' && v.length > 0;
const isColor = (v) => typeof v === 'string' && /^#[0-9a-f]{6}$/i.test(v);
const wallLength = (w) => Math.hypot(w.b[0] - w.a[0], w.b[1] - w.a[1]);

/* Checks a plan against the schema. Structure faults are errors: the plan is refused.
 * An anchor that points to a device or an opening that does not exist is a warning:
 * it is left out and the rest of the plan is served, as a device that fails does not
 * fail the answer. `deviceIds` are the devices of the service, when known. */
function validate(plan, deviceIds = null) {
  const errors = [], warnings = [];
  if (!plan || typeof plan !== 'object' || Array.isArray(plan)) return { errors: ['the plan must be a JSON object'], warnings, plan: null };
  if (plan.version !== VERSION) errors.push(`"version" must be ${VERSION}`);
  if (plan.units != null && plan.units !== 'm') errors.push('"units" must be "m"');
  if (plan.wallColor != null && !isColor(plan.wallColor)) errors.push('"wallColor" must be "#rrggbb"');
  if (plan.north != null && !(isPoint(plan.north) && Math.hypot(plan.north[0], plan.north[1]) > EPS)) errors.push('"north" must be an [x, y] direction');

  const unique = (list, what) => {
    const seen = new Set();
    for (const item of list) {
      if (!item || !isId(item.id)) { errors.push(`${what}: an "id" is required`); continue; }
      if (seen.has(item.id)) errors.push(`${what} "${item.id}": duplicate id`);
      seen.add(item.id);
    }
    return seen;
  };
  const list = (key, required) => {
    if (plan[key] == null && !required) return [];
    if (!Array.isArray(plan[key]) || (required && !plan[key].length)) { errors.push(`"${key}" must be ${required ? 'a non-empty' : 'an'} array`); return []; }
    return plan[key];
  };

  const rooms = list('rooms', true);
  const roomIds = unique(rooms, 'room');
  for (const r of rooms.filter((x) => x && isId(x.id))) {
    if (!Array.isArray(r.polygon) || r.polygon.length < 3 || !r.polygon.every((p) => isPoint(p))) errors.push(`room "${r.id}": "polygon" must list at least 3 [x, y] points`);
    if (r.height != null && !(isNum(r.height) && r.height > 0)) errors.push(`room "${r.id}": "height" must be a positive number`);
    if (r.floor != null && !FLOORS.includes(r.floor)) errors.push(`room "${r.id}": "floor" must be one of ${FLOORS.join(', ')}`);
    if (r.floorColor != null && !isColor(r.floorColor)) errors.push(`room "${r.id}": "floorColor" must be "#rrggbb"`);
  }

  const walls = list('walls', false);
  unique(walls, 'wall');
  const wallById = new Map();
  for (const w of walls.filter((x) => x && isId(x.id))) {
    if (!isPoint(w.a) || !isPoint(w.b)) { errors.push(`wall "${w.id}": "a" and "b" must be [x, y] points`); continue; }
    if (wallLength(w) < EPS) { errors.push(`wall "${w.id}": "a" and "b" are the same point`); continue; }
    if (!(isNum(w.thickness) && w.thickness > 0)) errors.push(`wall "${w.id}": "thickness" must be a positive number`);
    wallById.set(w.id, w);
  }

  const openings = list('openings', false);
  const openingIds = unique(openings, 'opening');
  const perWall = new Map();
  for (const o of openings.filter((x) => x && isId(x.id))) {
    if (!OPENING_TYPES.includes(o.type)) errors.push(`opening "${o.id}": "type" must be one of ${OPENING_TYPES.join(', ')}`);
    const wall = wallById.get(o.wall);
    if (!wall) { errors.push(`opening "${o.id}": unknown wall "${o.wall}"`); continue; }
    if (!(isNum(o.offset) && o.offset >= 0) || !(isNum(o.width) && o.width > 0)) { errors.push(`opening "${o.id}": "offset" and "width" must be numbers, the width positive`); continue; }
    if (o.offset + o.width > wallLength(wall) + EPS) errors.push(`opening "${o.id}": goes past the end of wall "${o.wall}"`);
    if (!(isNum(o.height) && o.height > 0)) errors.push(`opening "${o.id}": "height" must be a positive number`);
    if (o.sill != null && !(isNum(o.sill) && o.sill >= 0)) errors.push(`opening "${o.id}": "sill" must be zero or more`);
    // a curtain hung at the opening: true, the name of its color, or { color, room }
    if (o.curtain != null && !(o.curtain === true || o.curtain === false || typeof o.curtain === 'string' || (typeof o.curtain === 'object' && !Array.isArray(o.curtain)))) errors.push(`opening "${o.id}": "curtain" must be true, a color or an object`);
    if (!perWall.has(o.wall)) perWall.set(o.wall, []);
    perWall.get(o.wall).push(o);
  }
  for (const group of perWall.values()) {
    group.sort((p, q) => p.offset - q.offset);
    for (let i = 1; i < group.length; i++) {
      if (group[i - 1].offset + group[i - 1].width > group[i].offset + EPS) errors.push(`openings "${group[i - 1].id}" and "${group[i].id}" overlap`);
    }
  }

  const furniture = list('furniture', false);
  unique(furniture, 'furniture');
  for (const f of furniture.filter((x) => x && isId(x.id))) {
    if (!isPoint(f.position)) errors.push(`furniture "${f.id}": "position" must be [x, y]`);
    if (!isPoint(f.size, 3) || !f.size.every((v) => v > 0)) errors.push(`furniture "${f.id}": "size" must be [width, depth, height], all positive`);
    if (f.room != null && !roomIds.has(f.room)) errors.push(`furniture "${f.id}": unknown room "${f.room}"`);
    if (f.type != null && !isId(f.type)) errors.push(`furniture "${f.id}": "type" must be a name`);
    if (f.rotation != null && !isNum(f.rotation)) errors.push(`furniture "${f.id}": "rotation" must be a number of degrees`);
    if (f.elevation != null && !(isNum(f.elevation) && f.elevation >= 0)) errors.push(`furniture "${f.id}": "elevation" must be zero or more`);
    if (f.params != null && (typeof f.params !== 'object' || Array.isArray(f.params))) errors.push(`furniture "${f.id}": "params" must be an object`);
  }

  const anchors = [], anchored = new Set();
  for (const a of list('anchors', false)) {
    if (!a || !isId(a.deviceId)) { errors.push('anchor: a "deviceId" is required'); continue; }
    const hasPosition = a.position != null, hasOpening = a.openingId != null;
    if (hasPosition === hasOpening) { errors.push(`anchor "${a.deviceId}": give either "position" or "openingId"`); continue; }
    if (hasPosition && !isPoint(a.position, 3)) { errors.push(`anchor "${a.deviceId}": "position" must be [x, y, z]`); continue; }
    if (anchored.has(a.deviceId)) { warnings.push(`anchor "${a.deviceId}": a second anchor for the same device is ignored`); continue; }
    if (deviceIds && !deviceIds.includes(a.deviceId)) { warnings.push(`anchor "${a.deviceId}": no such device in the service`); continue; }
    if (hasOpening && !openingIds.has(a.openingId)) { warnings.push(`anchor "${a.deviceId}": unknown opening "${a.openingId}"`); continue; }
    anchored.add(a.deviceId);
    anchors.push(a);
  }

  return { errors, warnings, plan: errors.length ? null : { ...plan, units: 'm', walls, openings, furniture, anchors } };
}

/* Reads and checks the file. Kept until the file changes: editing the plan shows on the
 * next request, without restarting the service. */
const cache = new Map();   // file -> { mtimeMs, plan, warnings }
function load(file, deviceIds = null) {
  let stat, text, raw;
  try {
    stat = fs.statSync(file);
    const hit = cache.get(file);
    if (hit && hit.mtimeMs === stat.mtimeMs) return { plan: hit.plan, warnings: hit.warnings };
    text = fs.readFileSync(file, 'utf8');
  } catch (e) {
    // the path stays out of the message: it would tell a caller where the plan lives
    throw new PlanError(`the plan file cannot be read (${e.code || e.message})`);
  }
  try { raw = JSON.parse(text.replace(/^﻿/, '')); } catch (e) { throw new PlanError(`the plan file is not valid JSON: ${e.message}`); }
  const { errors, warnings, plan } = validate(raw, deviceIds);
  if (errors.length) throw new PlanError('the plan does not follow the schema', errors);
  cache.set(file, { mtimeMs: stat.mtimeMs, plan, warnings });
  return { plan, warnings };
}

module.exports = { validate, load, PlanError, VERSION, OPENING_TYPES, FLOORS };
