/* The plan of the home as a small architect's model: walls cut at mid-height, soft
   volumes for furniture, and the devices of the house service shown where they are,
   in the state they are in. A lit lamp warms the floor of its room, the daylight
   follows the real sun. Loaded only when a plan exists and WebGL answers.
   Vigie runs all day: a frame is drawn when something changed, never in a loop, except
   while a view moves or an air conditioner blows, and nothing at all while hidden.
   Each kind of device is one entry of MODULES: a new type is a new entry. */
import * as THREE from "../vendor/three/three.module.min.js";
import { furnitureParts, placePart, colorOf } from "./furniture.js";
import { CUT_HEIGHT, roomBounds, polygonArea, polygonCentroid, labelPoint, openEdges, wallFrame, wallPieces, openingFrame, nearestWall, roomAt, placedDevices, temperatureTint, coverClosed, presets, clampView, frameView, mixFrame, viewAxes, sunlight, wallHeight, standHeight, wallInside, highOf, curtainOf, holdView, panBy, zoomAt, LIMITS, homeShare } from "./plan.js";

const MAX_PIXEL_RATIO = 1.5;      // a 4K kiosk would otherwise shade four times the pixels
const AMBIENT_FPS = 10;           // the breath of an air conditioner needs no more
const FOLLOW_MS = 90;             // how far behind the view the picture trails
const FLICK_MS = 160;             // how long a move goes on once let go
const FLOOR_PX = 44;              // pixels per meter of a floor's pattern
const LIGHT_PX = 20;              // and of the light lamps throw on it: a soft gradient needs few
const DEG = Math.PI / 180;

/* The palette of the stylesheet is OKLCH derived from one theme color. The browser
   resolves it: one pixel is painted with the CSS color and read back. */
function paletteReader() {
  const ctx = Object.assign(document.createElement("canvas"), { width: 1, height: 1 }).getContext("2d", { willReadFrequently: true });
  return (css) => {
    ctx.clearRect(0, 0, 1, 1);
    ctx.fillStyle = css;
    ctx.fillRect(0, 0, 1, 1);
    const [r, g, b] = ctx.getImageData(0, 0, 1, 1).data;
    return new THREE.Color().setRGB(r / 255, g / 255, b / 255, THREE.SRGBColorSpace);
  };
}

// Plan (x, y on the floor, z up) to the scene (y up).
const at = (x, y, z = 0) => new THREE.Vector3(x, z, y);

function roundedRect(w, d, r) {
  const s = new THREE.Shape(), x = -w / 2, y = -d / 2;
  r = Math.min(r, w / 2, d / 2);
  s.moveTo(x + r, y); s.lineTo(x + w - r, y); s.quadraticCurveTo(x + w, y, x + w, y + r);
  s.lineTo(x + w, y + d - r); s.quadraticCurveTo(x + w, y + d, x + w - r, y + d);
  s.lineTo(x + r, y + d); s.quadraticCurveTo(x, y + d, x, y + d - r);
  s.lineTo(x, y + r); s.quadraticCurveTo(x, y, x + r, y);
  return s;
}

function glowTexture() {
  const c = Object.assign(document.createElement("canvas"), { width: 128, height: 128 }), g = c.getContext("2d");
  const grad = g.createRadialGradient(64, 64, 0, 64, 64, 64);
  grad.addColorStop(0, "rgba(255,255,255,1)"); grad.addColorStop(0.25, "rgba(255,255,255,.55)"); grad.addColorStop(1, "rgba(255,255,255,0)");
  g.fillStyle = grad; g.fillRect(0, 0, 128, 128);
  return new THREE.CanvasTexture(c);
}

/* The pattern of a floor, drawn once in near-white: the material color tints it. Boards
   run along the long side of the room, tiles and slabs make a grid. Each board gets a
   shade of its own, always the same from one drawing to the next. */
function floorPattern(room, w, h) {
  const c = Object.assign(document.createElement("canvas"), { width: Math.max(8, Math.round(w * FLOOR_PX)), height: Math.max(8, Math.round(h * FLOOR_PX)) });
  const g = c.getContext("2d"), kind = room.kind === "outdoor" ? "slab" : room.floor;
  const shade = (i, j) => 0.93 + 0.07 * (((i * 73 + j * 151 + 7) * 2654435761 >>> 0) % 1000) / 1000;
  const grey = (v) => { const k = Math.round(255 * v); return `rgb(${k},${k},${k})`; };
  g.fillStyle = kind === "wood" ? grey(0.84) : "#fff"; g.fillRect(0, 0, c.width, c.height);
  if (kind === "wood") {
    const along = w >= h, board = 0.14 * FLOOR_PX, plank = 1.3 * FLOOR_PX, across = along ? c.height : c.width, run = along ? c.width : c.height;
    for (let i = 0; i * board < across; i++) for (let j = -1; j * plank < run; j++) {
      const a = j * plank + (i % 3) * plank / 3, b0 = i * board;
      g.fillStyle = grey(shade(i, j));
      if (along) g.fillRect(a, b0, plank - 1, board - 1); else g.fillRect(b0, a, board - 1, plank - 1);
    }
  } else if (kind === "tile" || kind === "slab") {
    const step = (kind === "slab" ? 0.5 : 0.45) * FLOOR_PX, joint = kind === "slab" ? 2 : 1.4;
    g.fillStyle = grey(kind === "slab" ? 0.74 : 0.84); g.fillRect(0, 0, c.width, c.height);
    for (let i = 0; i * step < c.width; i++) for (let j = 0; j * step < c.height; j++) {
      g.fillStyle = grey(shade(i, j));
      g.fillRect(i * step + joint / 2, j * step + joint / 2, step - joint, step - joint);
    }
  }
  const texture = new THREE.CanvasTexture(c);
  texture.flipY = false;
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 4;
  return texture;
}

/* ---------- One module per kind of device ----------
   create(ctx, placed) returns { object, update(device), tick?(seconds), pin } where
   `pin` is the point its label hangs from. update() only sets values: the frame is
   drawn by the caller. tick() moves what is alive and says whether it still is. */
const shown = (z, min = 0.3) => Math.min(Math.max(z, min), CUT_HEIGHT + 0.55);   // nothing floats far above the cut walls

// A wall unit lies along the nearest wall and faces the room.
function onWall(ctx, point) {
  const wall = nearestWall(ctx.plan, point.x, point.y);
  if (!wall) return { angle: 0, out: [0, 1] };
  const side = (point.x - wall.wall.a[0]) * wall.nx + (point.y - wall.wall.a[1]) * wall.ny >= 0 ? 1 : -1;
  return { angle: -Math.atan2(wall.uy, wall.ux), out: [wall.nx * side, wall.ny * side] };
}

// The color of a mode, the same on the unit, its breath and its pin (see .planPin in the stylesheet).
const MODE_TONE = { heat: "amber", cool: "sky", dry: "mint", fan: "ink2", auto: "accent" };

const MODULES = {
  light(ctx, { point }) {
    const h = shown(point.z), group = new THREE.Group();
    const bulb = new THREE.Mesh(new THREE.SphereGeometry(0.085, 20, 14), new THREE.MeshBasicMaterial());
    bulb.position.copy(at(point.x, point.y, h));
    // a thin stem ties the bulb to the floor, so its place in the room reads at once
    const stem = new THREE.Mesh(new THREE.CylinderGeometry(0.012, 0.012, h, 6), ctx.mat.stem);
    stem.position.copy(at(point.x, point.y, h / 2));
    const halo = new THREE.Sprite(new THREE.SpriteMaterial({ map: ctx.glow, blending: THREE.AdditiveBlending, depthWrite: false, transparent: true }));
    halo.position.copy(bulb.position);
    group.add(stem, bulb, halo);
    return {
      object: group, pin: at(point.x, point.y, h + 0.22),
      update(device) {
        const s = device.state, css = s.reachable && s.on ? ctx.hooks.lampColor(device) : null;
        const level = (s.brightness ?? 70) / 100;
        halo.visible = !!css;
        if (css) {
          const c = ctx.color(css);
          bulb.material.color.copy(c).lerp(ctx.pal.white, 0.45);
          halo.material.color.copy(c);
          halo.material.opacity = 0.3 + 0.3 * level;
          halo.scale.setScalar(0.7 + 0.9 * level);
        } else bulb.material.color.copy(ctx.pal.off);
      },
      // what it throws on the floor of its room: the floor paints it, walls stop it
      pool(device) {
        const s = device.state;
        return s.reachable && s.on ? { x: point.x, y: point.y, css: ctx.hooks.lampColor(device), level: (s.brightness ?? 70) / 100, reach: 1.7 + 2.3 * (s.brightness ?? 70) / 100 } : null;
      },
    };
  },

  climate(ctx, { point }) {
    const h = shown(point.z, 0.9), { angle, out } = onWall(ctx, point), group = new THREE.Group();
    const body = new THREE.Mesh(new THREE.BoxGeometry(0.82, 0.26, 0.2), new THREE.MeshLambertMaterial());
    body.position.copy(at(point.x + out[0] * 0.1, point.y + out[1] * 0.1, h));
    body.rotation.y = angle;
    group.add(body);
    // three veils of air leave the unit one after the other
    const puffs = [0, 1, 2].map((i) => {
      const m = new THREE.Mesh(new THREE.PlaneGeometry(0.62, 0.3), new THREE.MeshBasicMaterial({ transparent: true, opacity: 0, depthWrite: false, side: THREE.DoubleSide }));
      m.rotation.set(-Math.PI / 2, 0, angle);
      m.userData.phase = i / 3;
      group.add(m);
      return m;
    });
    let running = false;
    const place = (seconds) => {
      for (const p of puffs) {
        const k = (seconds * 0.45 + p.userData.phase) % 1, reach = 0.25 + k * 1.15;
        p.position.copy(at(point.x + out[0] * reach, point.y + out[1] * reach, h - 0.12 - k * 0.5));
        p.material.opacity = running ? 0.26 * Math.sin(Math.PI * k) : 0;
        p.scale.setScalar(0.8 + k * 0.7);
      }
    };
    return {
      object: group, pin: at(point.x + out[0] * 0.1, point.y + out[1] * 0.1, h + 0.3),
      update(device) {
        const s = device.state;
        running = !!(s.reachable && s.on);
        const tone = ctx.pal[MODE_TONE[s.mode]] || ctx.pal.accent;
        body.material.color.copy(running ? ctx.pal.ink : ctx.pal.off);
        body.material.emissive.copy(running ? tone : ctx.pal.black).multiplyScalar(0.25);
        for (const p of puffs) p.material.color.copy(tone);
        place(ctx.still ? 0.5 : performance.now() / 1000);   // without motion the veils stay, frozen mid-way
      },
      tick(seconds) { if (running) place(seconds); return running; },
    };
  },

  heater(ctx, { point }) {
    const h = shown(point.z, 0.35), { angle, out } = onWall(ctx, point), group = new THREE.Group();
    const body = new THREE.Mesh(new THREE.BoxGeometry(0.55, 0.6, 0.07), new THREE.MeshLambertMaterial());
    body.position.copy(at(point.x + out[0] * 0.05, point.y + out[1] * 0.05, h));
    body.rotation.y = angle;
    const glow = new THREE.Sprite(new THREE.SpriteMaterial({ map: ctx.glow, blending: THREE.AdditiveBlending, depthWrite: false, transparent: true, opacity: 0.6 }));
    glow.position.copy(at(point.x + out[0] * 0.3, point.y + out[1] * 0.3, h));
    glow.material.color.copy(ctx.pal.amber);
    glow.scale.setScalar(1.2);
    group.add(body, glow);
    return {
      object: group, pin: at(point.x + out[0] * 0.05, point.y + out[1] * 0.05, h + 0.48),
      update(device) {
        const on = !!(device.state.reachable && device.state.on);
        glow.visible = on;
        body.material.color.copy(on ? ctx.pal.ink : ctx.pal.off);
        body.material.emissive.copy(on ? ctx.pal.amber : ctx.pal.black).multiplyScalar(0.45);
      },
      pool(device) {
        const s = device.state;
        return s.reachable && s.on ? { x: point.x + out[0] * 0.4, y: point.y + out[1] * 0.4, css: "#" + ctx.pal.amber.getHexString(), level: 0.35, reach: 1.5 } : null;
      },
    };
  },

  /* A shutter hangs in the frame of its window: the curtain comes down as far as the
     device says, and shows as far up as the wall of the window is cut. */
  cover(ctx, { point }) {
    const o = point.opening, f = openingFrame(ctx.plan, o), sill = o.sill || 0, head = sill + o.height, group = new THREE.Group();
    const angle = -Math.atan2(f.uy, f.ux), t = f.wall.thickness;
    const curtain = new THREE.Mesh(new THREE.BoxGeometry(o.width, 1, 0.02), ctx.mat.curtain);
    curtain.rotation.y = angle;
    const bar = new THREE.Mesh(new THREE.BoxGeometry(o.width, 0.045, 0.035), ctx.mat.frame);
    bar.rotation.y = angle;
    group.add(curtain, bar);
    const pin = at(f.x, f.y, 0);
    let closed = 0, cut = CUT_HEIGHT;
    const place = () => {
      const low = head - Math.max(0.03, (head - sill) * closed), top = Math.min(head, cut);
      curtain.visible = top - low > 0.01;
      curtain.scale.y = Math.max(0.01, top - low);
      curtain.position.copy(at(f.x, f.y, (top + low) / 2));
      bar.visible = low < cut;
      bar.position.copy(at(f.x, f.y, low));
      pin.copy(at(f.x, f.y, top + 0.2));
    };
    return {
      object: group, pin,
      update(device) {
        const target = coverClosed(device.state);
        if (ctx.still || Math.abs(target - closed) < 0.005) { closed = target; place(); return; }
        ctx.tween(closed, target, 700, (v) => { closed = v; place(); });
      },
      cut(h) { cut = h; place(); },
      extent: t,
    };
  },

  sensor(ctx, { point }) {
    const h = shown(point.z, 0.5);
    const dot = new THREE.Mesh(new THREE.SphereGeometry(0.055, 14, 10), new THREE.MeshBasicMaterial({ color: ctx.pal.accent }));
    dot.position.copy(at(point.x, point.y, h));
    return { object: dot, pin: at(point.x, point.y, h + 0.2), update() {} };
  },

  // A water heater, a television, a washing machine: the furniture of the plan draws them, the marker says how they are.
  appliance(ctx, { point }) {
    return { object: new THREE.Group(), pin: at(point.x, point.y, shown(point.z, 0.9) + 0.15), update() {} };
  },
};
export const MODULE_NAMES = Object.keys(MODULES);

/* ---------- The model ----------
   hooks: css(name) resolves a custom property, lampColor(device) the color of a lit
   lamp, pin(device, module) what its marker shows ({ html, cls, lamp, mode }),
   roomLabel(room) the label of a room ({ html, equipped }), sun() where the sun is
   ({ azimuth, elevation } in degrees, or null), onDevice(id) and onRoom(id) the taps,
   onHover(id or null) the device under the pointer.
   Returns null when WebGL does not answer: the caller draws the flat view. */
export function createPlan3d(stage, plan, hooks) {
  const canvas = document.createElement("canvas");
  canvas.className = "planCanvas";
  // asked for here rather than by three, which throws and logs when there is none
  const context = canvas.getContext("webgl2", { antialias: true, alpha: true, powerPreference: "low-power" });
  if (!context) return null;
  const renderer = new THREE.WebGLRenderer({ canvas, context });
  const overlay = document.createElement("div");
  overlay.className = "planOverlay";
  stage.replaceChildren(canvas, overlay);
  renderer.setClearAlpha(0);

  const color = paletteReader();
  const css = (name) => color(hooks.css(name));
  const pal = {
    abyss: css("--abyss"), hull: css("--hull"), hull2: css("--hull-2"), ink: css("--ink"), ink2: css("--ink-2"), ink3: css("--ink-3"),
    accent: css("--accent"), amber: css("--amber"), sky: css("--sky"), mint: css("--mint"), white: new THREE.Color(1, 1, 1), black: new THREE.Color(0, 0, 0),
  };
  pal.off = pal.hull2.clone().lerp(pal.ink3, 0.55);
  pal.cool = pal.sky; pal.warm = pal.amber;
  // furniture stays out of the way: lighter than any floor and almost without hue
  const hsl = pal.ink3.clone().lerp(pal.ink2, 0.2).getHSL({});
  pal.neutral = new THREE.Color().setHSL(hsl.h, hsl.s * 0.3, hsl.l);
  const lambert = (c, extra) => new THREE.MeshLambertMaterial({ color: c, ...extra });
  const mat = {
    wall: lambert(pal.hull2.clone().lerp(pal.ink3, 0.42)),
    // the cut is what makes the model: the top of every wall is a clear line
    wallTop: new THREE.MeshBasicMaterial({ color: pal.ink.clone().lerp(pal.ink2, 0.6) }),
    sill: lambert(pal.hull2.clone().lerp(pal.ink3, 0.3)),
    furniture: lambert(pal.neutral),
    glass: new THREE.MeshBasicMaterial({ color: pal.sky, transparent: true, opacity: 0.38, depthWrite: false }),
    leaf: lambert(pal.ink3),
    base: lambert(pal.abyss.clone().lerp(pal.hull, 0.5)),
    stem: new THREE.MeshBasicMaterial({ color: pal.ink3, transparent: true, opacity: 0.5 }),
    frame: new THREE.MeshBasicMaterial({ color: pal.ink3 }),
    curtain: lambert(pal.ink3.clone().lerp(pal.hull2, 0.25), { transparent: true, opacity: 0.9 }),
    rail: new THREE.MeshBasicMaterial({ color: pal.ink2 }),
    railPane: new THREE.MeshBasicMaterial({ color: pal.ink3, transparent: true, opacity: 0.16, depthWrite: false }),
  };
  // what each floor is made of, told apart by a slight tint and a pattern
  const FLOOR_TONE = {
    wood: pal.hull2.clone().lerp(pal.amber, 0.14).lerp(pal.ink3, 0.12),
    tile: pal.hull2.clone().lerp(pal.sky, 0.14).lerp(pal.ink3, 0.2),
    concrete: pal.hull2.clone().lerp(pal.ink3, 0.26),
    carpet: pal.hull2.clone().lerp(pal.accent, 0.2).lerp(pal.ink3, 0.06),
    none: pal.hull2.clone().lerp(pal.ink3, 0.12),
    outdoor: pal.hull.clone().lerp(pal.ink3, 0.2),
  };

  /* A real color brought to the dark theme: pulled toward the hull and dimmed, so a white
     cabinet does not glare on the page and an oak top still reads as oak. */
  function real(hex, pull = 0.14, level = 0.86) {
    const c = new THREE.Color().setStyle(hex, THREE.SRGBColorSpace).lerp(pal.hull2, pull).multiplyScalar(level);
    // black furniture would vanish on a dark page: it is lifted to a dark grey that still reads as black
    const hsl = c.getHSL({});
    return hsl.l < 0.16 ? c.setHSL(hsl.h, hsl.s * 0.6, 0.16 + hsl.l * 0.35) : c;
  }
  if (plan.wallColor) mat.wall.color.copy(real(plan.wallColor, 0.5, 0.55));

  const scene = new THREE.Scene();
  const sky = new THREE.HemisphereLight(pal.ink, pal.hull, 2);
  const sun = new THREE.DirectionalLight(0xffffff, 1.4);
  sun.position.set(-7, 14, 5);
  scene.add(sky, sun);

  /* ---- what never moves: base, floors, walls, openings, furniture ---- */
  // one pad under each room rather than one under the whole plan: a home is rarely a rectangle
  for (const room of plan.rooms) {
    const r = roomBounds(room);
    const pad = new THREE.Mesh(new THREE.ExtrudeGeometry(roundedRect(r.maxX - r.minX + 0.9, r.maxY - r.minY + 0.9, 0.3), { depth: 0.08, bevelEnabled: false }).rotateX(-Math.PI / 2), mat.base);
    pad.position.copy(at((r.minX + r.maxX) / 2, (r.minY + r.maxY) / 2, -0.1));
    scene.add(pad);
  }

  /* A floor carries two pictures laid over its room: the pattern of its material, drawn
     once, and the light lamps throw on it, redrawn when a lamp changes. The light is a
     picture of the floor, so the walls of the room stop it. */
  const floors = new Map();   // room id -> { mesh, tone, box, light: { canvas, g, texture, key } }
  for (const room of plan.rooms) {
    const shape = new THREE.Shape(room.polygon.map(([x, y]) => new THREE.Vector2(x, -y)));
    const geo = new THREE.ShapeGeometry(shape).rotateX(-Math.PI / 2);
    const box = roomBounds(room), w = box.maxX - box.minX, h = box.maxY - box.minY;
    const pos = geo.attributes.position, uv = geo.attributes.uv;
    for (let i = 0; i < pos.count; i++) uv.setXY(i, (pos.getX(i) - box.minX) / w, (pos.getZ(i) - box.minY) / h);
    const hollow = room.kind === "shaft" || room.kind === "unknown";
    // the real color of a floor when the plan gives one, else the tint of its material
    const tone = hollow ? pal.abyss.clone() : room.floorColor ? real(room.floorColor, 0.3, 0.62) : (room.kind === "outdoor" ? FLOOR_TONE.outdoor : FLOOR_TONE[room.floor] || FLOOR_TONE.none).clone();
    const lc = Object.assign(document.createElement("canvas"), { width: Math.max(4, Math.round(w * LIGHT_PX)), height: Math.max(4, Math.round(h * LIGHT_PX)) });
    const light = { canvas: lc, g: lc.getContext("2d"), texture: new THREE.CanvasTexture(lc), key: "" };
    light.texture.flipY = false;
    light.texture.colorSpace = THREE.SRGBColorSpace;
    const material = lambert(tone.clone(), hollow ? {} : { map: floorPattern(room, w, h), emissive: 0xffffff, emissiveMap: light.texture, emissiveIntensity: 0.85 });
    const mesh = new THREE.Mesh(geo, material);
    mesh.position.y = room.kind === "outdoor" ? -0.012 : 0;   // a balcony sits a step lower
    mesh.userData.room = room.id;
    scene.add(mesh);
    floors.set(room.id, { mesh, tone, box, light, hollow });
    // a balcony or a loggia ends on a low rail where no wall closes it
    if (room.kind === "outdoor") for (const [a, b] of openEdges(plan, room)) {
      const len = Math.hypot(b[0] - a[0], b[1] - a[1]), angle = -Math.atan2(b[1] - a[1], b[0] - a[0]), mx = (a[0] + b[0]) / 2, my = (a[1] + b[1]) / 2;
      const bar = new THREE.Mesh(new THREE.BoxGeometry(len, 0.04, 0.05), mat.rail);
      bar.position.copy(at(mx, my, 0.95));
      const pane = new THREE.Mesh(new THREE.BoxGeometry(len, 0.9, 0.02), mat.railPane);
      pane.position.copy(at(mx, my, 0.48));
      bar.rotation.y = pane.rotation.y = angle;
      scene.add(bar, pane);
      for (const end of [a, b]) {
        const post = new THREE.Mesh(new THREE.BoxGeometry(0.04, 0.95, 0.04), mat.rail);
        post.position.copy(at(end[0], end[1], 0.475));
        scene.add(post);
      }
    }
  }

  /* Walls and what is set in them are cut where the view cuts their wall (wallHeight):
     low when the wall is in the way of its rooms, high enough for its windows when it
     stands behind them. Every part is a unit box stretched to what is left of it, so
     a wall that sinks or rises while the model turns allocates nothing. An opening is
     cut with its wall and never moves: under its sill, a window is no more than a
     line of glass on the cut. */
  const unit = new THREE.BoxGeometry(1, 1, 1);
  const walls = new Map();   // wall id -> { wall, sets: [(height) => void], height }
  // a box between two heights, hidden when nothing is left of it
  const stretch = (mesh, x, y, bottom, top) => {
    mesh.visible = top - bottom > 0.005;
    if (!mesh.visible) return;
    mesh.scale.y = top - bottom;
    mesh.position.copy(at(x, y, (bottom + top) / 2));
  };
  const slab = (material, length, thickness, angle) => {
    const mesh = new THREE.Mesh(unit, material);
    mesh.scale.set(length, 1, thickness);
    mesh.rotation.y = angle;
    scene.add(mesh);
    return mesh;
  };
  for (const wall of plan.walls || []) {
    // a wall that can stand behind its rooms is built up to the height of the home's walls, a wall between two rooms up to the cut
    const f = wallFrame(wall), angle = -Math.atan2(f.uy, f.ux), tall = wallInside(plan, wall) ? highOf(plan) : CUT_HEIGHT, sets = [];
    walls.set(wall.id, { wall, sets, height: null });
    for (const piece of wallPieces(plan, wall, tall)) {
      const len = piece.to - piece.from, mid = (piece.from + piece.to) / 2;
      if (len < 0.005 || piece.top - piece.bottom < 0.005) continue;
      const whole = piece.top >= tall, side = whole ? mat.wall : mat.sill;
      const box = slab([side, side, mat.wallTop, side, side, side], len, wall.thickness, angle);
      const x = wall.a[0] + f.ux * mid, y = wall.a[1] + f.uy * mid;
      sets.push((h) => {
        const top = Math.min(piece.top, h);
        // the cut is the clear line of the model; a sill that is not cut keeps the color of its wall
        box.material[2] = whole || top < piece.top ? mat.wallTop : side;
        stretch(box, x, y, piece.bottom, top);
      });
    }
  }
  // What hangs on a wall between two rooms, by piece of furniture: { room, inside, sets, height }.
  const hung = [];
  function raiseWalls(azimuth, elevation) {
    for (const entry of walls.values()) {
      const h = wallHeight(plan, entry.wall, azimuth, elevation);
      if (entry.height !== null && Math.abs(h - entry.height) < 0.002) continue;
      entry.height = h;
      for (const set of entry.sets) set(h);
    }
    for (const entry of hung) {
      // shown for the room one is looking at; in a view of the whole home they would hide the room behind them
      const h = view && view.subject === entry.room ? standHeight(plan, entry.inside, azimuth, elevation) : CUT_HEIGHT;
      if (entry.height !== null && Math.abs(h - entry.height) < 0.002) continue;
      entry.height = h;
      for (const set of entry.sets) set(h);
    }
  }

  for (const o of plan.openings || []) {
    const f = openingFrame(plan, o), entry = f && walls.get(o.wall);
    if (!entry) continue;
    const angle = -Math.atan2(f.uy, f.ux), sill = o.sill || 0, head = sill + o.height;
    /* The floor goes on under an opening that reaches it. Rooms stop at the faces of
       their walls: without this, a doorway is a strip of void under the leaf. The
       threshold takes the floor of the room the door opens into, else of a room beside it. */
    if (sill === 0) {
      const reach = f.wall.thickness / 2 + 0.15;
      const beside = [1, -1].map((k) => roomAt(plan, f.x + f.nx * reach * k, f.y + f.ny * reach * k)).filter(Boolean);
      const room = beside.find((r) => r.id === o.opensInto) || beside.find((r) => r.kind !== "outdoor") || beside[0];
      const floor = room && floors.get(room.id);
      if (floor && !floor.hollow) {
        const step = new THREE.Mesh(unit, lambert(floor.tone.clone()));
        step.scale.set(o.width, 0.012, f.wall.thickness + 0.02);
        step.rotation.y = angle;
        step.position.copy(at(f.x, f.y, -0.005));
        scene.add(step);
      }
    }
    /* A curtain belongs to its window (curtainOf): against the wall on the side of the
       room, its rod just above the head of the window, falling to the floor. It is cut
       with its wall, like the window it hangs at: a curtain left standing in front of
       a lowered wall would hide the room it dresses. */
    const drape = curtainOf(plan, o);
    if (drape) {
      const tone = drape.color && colorOf(drape.color) ? real(colorOf(drape.color)) : pal.ink2.clone();
      const cloth = new THREE.MeshLambertMaterial({ color: tone, transparent: true, opacity: 0.34, depthWrite: false, side: THREE.DoubleSide });
      const turn = -drape.angle, folds = Math.max(4, Math.round(drape.length / 0.16)), ux = Math.cos(drape.angle), uy = Math.sin(drape.angle);
      const strips = [];
      for (let i = 0; i < folds; i++) {
        const along = -drape.length / 2 + (i + 0.5) * drape.length / folds, out = (i % 2 ? 1 : -1) * drape.depth * 0.25;
        const mesh = slab(cloth, drape.length / folds + 0.004, 0.012, turn);
        mesh.renderOrder = 1;
        strips.push({ mesh, x: drape.x + ux * along + drape.inside[0] * out, y: drape.y + uy * along + drape.inside[1] * out });
      }
      const rod = slab(mat.frame, drape.length + 0.06, 0.025, turn);
      entry.sets.push((h) => {
        for (const st of strips) stretch(st.mesh, st.x, st.y, 0, Math.min(drape.top, h));
        stretch(rod, drape.x, drape.y, drape.top, drape.rodTop <= h + 1e-6 ? drape.rodTop : drape.top);
      });
    }
    if (o.type === "window" || o.type === "french-window") {
      const pane = slab(mat.glass, o.width, 0.03, angle), bar = 0.045, deep = Math.min(0.08, f.wall.thickness * 0.5);
      // the frame: both jambs, a middle post when there are two leaves, the sill and the head
      const posts = [0, ...(o.width >= 1 ? [0.5] : []), 1].map((k) => ({ k, mesh: slab(mat.frame, bar, deep, angle) }));
      const rails = [sill > 0 ? sill + bar / 2 : -1, head - bar / 2].map((z) => ({ z, mesh: slab(mat.frame, o.width + bar, deep, angle) }));
      const trace = slab(mat.glass, o.width, f.wall.thickness * 0.45, angle);
      entry.sets.push((h) => {
        const top = Math.min(head, h);
        stretch(pane, f.x, f.y, sill, top);
        for (const { k, mesh } of posts) stretch(mesh, f.start[0] + (f.end[0] - f.start[0]) * k, f.start[1] + (f.end[1] - f.start[1]) * k, sill, top);
        for (const { z, mesh } of rails) stretch(mesh, f.x, f.y, z - bar / 2, z > 0 && z + bar / 2 <= h + 1e-6 ? z + bar / 2 : z - bar / 2);
        stretch(trace, f.x, f.y, h, top > sill ? h : h + 0.012);
      });
    } else if (o.type === "door" || o.type === "closet") {
      let x = f.x, y = f.y, turn = angle;
      if (o.type === "door" && !o.closed) {
        // the leaf stands open, on the side of the room it opens into
        const room = plan.rooms.find((r) => r.id === o.opensInto);
        const c = room ? polygonCentroid(room.polygon) : [f.x + f.nx, f.y + f.ny];
        const side = (c[0] - f.x) * f.nx + (c[1] - f.y) * f.ny >= 0 ? 1 : -1;
        const hinge = o.hinge === "end" ? f.end : f.start, along = o.hinge === "end" ? -1 : 1;
        const swing = 72 * DEG * side * along;
        const dir = [f.ux * along * Math.cos(swing) - f.uy * along * Math.sin(swing), f.ux * along * Math.sin(swing) + f.uy * along * Math.cos(swing)];
        x = hinge[0] + dir[0] * o.width / 2; y = hinge[1] + dir[1] * o.width / 2; turn = -Math.atan2(dir[1], dir[0]);
      }
      const closet = o.type === "closet";
      const leaf = slab(closet ? mat.furniture : mat.leaf, closet ? o.width - 0.04 : o.width, closet ? 0.03 : 0.04, turn);
      // an open leaf is cut like the walls between rooms: it stands in one of them
      entry.sets.push((h) => stretch(leaf, x, y, 0, Math.min(head, o.type === "door" && !o.closed ? Math.min(h, CUT_HEIGHT) : h)));
    }
  }

  /* Furniture: every piece is a few boxes and cylinders (furniture.js). They are drawn
     as instances of one box and one cylinder, with one material per look: a home full
     of furniture costs a handful of draw calls, whatever the number of pieces. */
  const LOOKS = {
    solid: () => new THREE.MeshLambertMaterial(),
    ghost: () => new THREE.MeshLambertMaterial({ transparent: true, opacity: 0.38, depthWrite: false }),   // planned, not there yet
    glass: () => new THREE.MeshBasicMaterial({ transparent: true, opacity: 0.26, depthWrite: false }),
    sheer: () => new THREE.MeshLambertMaterial({ transparent: true, opacity: 0.3, depthWrite: false, side: THREE.DoubleSide }),
    glow: () => new THREE.MeshBasicMaterial(),
  };
  const SHAPES = { box: () => new THREE.BoxGeometry(1, 1, 1), cyl: () => new THREE.CylinderGeometry(0.5, 0.5, 1, 18) };
  const batches = new Map();   // "shape|look" -> [{ matrix, color }]
  const up = new THREE.Vector3(0, 1, 0), flat = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), Math.PI / 2);
  const lean = new THREE.Vector3(1, 0, 0);
  for (const item of plan.furniture || []) {
    // what is fixed to a wall (kitchen wall units, a curtain) is cut where that wall is cut, not at the cut of the furniture
    const backing = nearestWall(plan, item.position[0], item.position[1]);
    let holder = backing && backing.distance < 0.7 ? walls.get(backing.wall.id) : null;
    if (holder && !wallInside(plan, backing.wall)) {
      // a wall between two rooms stays at the cut: what hangs on it follows the side of its own room
      const s = Math.sign((item.position[0] - backing.wall.a[0]) * backing.nx + (item.position[1] - backing.wall.a[1]) * backing.ny) || 1;
      holder = { sets: [], height: null, room: item.room, inside: [backing.nx * s, backing.ny * s] };
      hung.push(holder);
    }
    for (const part of furnitureParts(item)) {
      const placed = placePart(item, part), look = item.planned && part.look === "solid" ? "ghost" : part.look;
      if (part.bound && holder && part.shape === "box") {
        const tone = !part.color ? pal.neutral : real(part.color);
        const material = look === "sheer" ? new THREE.MeshLambertMaterial({ color: tone, transparent: true, opacity: 0.34, depthWrite: false, side: THREE.DoubleSide }) : lambert(tone);
        const mesh = new THREE.Mesh(unit, material);
        mesh.scale.set(part.size[0], 1, part.size[1]);
        mesh.rotation.y = -placed.angle * DEG;
        if (look === "sheer") mesh.renderOrder = 1;
        scene.add(mesh);
        const bottom = placed.at[2] - part.size[2] / 2, top = placed.at[2] + part.size[2] / 2;
        // under a wall that came down, nothing of it is left: a wall unit does not float over a low wall
        holder.sets.push((h) => stretch(mesh, placed.at[0], placed.at[1], bottom, h > bottom + 0.05 ? Math.min(top, h) : bottom));
        continue;
      }
      const turn = new THREE.Quaternion().setFromAxisAngle(up, -placed.angle * DEG);
      // a part may lean from the vertical toward its front: the stem of a plant, its leaves
      if (part.tilt) turn.multiply(new THREE.Quaternion().setFromAxisAngle(lean, part.tilt * DEG));
      // a cylinder lying against a wall: its axis goes from the back to the front of its item
      const scale = new THREE.Vector3(part.size[0], part.size[2], part.size[1]);
      const matrix = new THREE.Matrix4().compose(at(placed.at[0], placed.at[1], placed.at[2] + 0.02), part.lie ? turn.multiply(flat) : turn, scale);
      const color = !part.color ? pal.neutral : look === "glow" ? new THREE.Color().setStyle(part.color, THREE.SRGBColorSpace) : real(part.color);
      const key = `${part.shape}|${look}`;
      batches.set(key, [...(batches.get(key) || []), { matrix, color }]);
    }
  }
  let furnitureParts3d = 0;
  for (const [key, list] of batches) {
    const [shape, look] = key.split("|");
    const mesh = new THREE.InstancedMesh(SHAPES[shape](), LOOKS[look](), list.length);
    list.forEach((p, i) => { mesh.setMatrixAt(i, p.matrix); mesh.setColorAt(i, p.color); });
    mesh.instanceMatrix.needsUpdate = true;
    mesh.instanceColor.needsUpdate = true;
    mesh.renderOrder = look === "solid" || look === "glow" ? 0 : 1;   // what is seen through comes after
    furnitureParts3d += list.length;
    scene.add(mesh);
  }

  /* ---- what lives: devices, drawn by their module ---- */
  const still = matchMedia("(prefers-reduced-motion: reduce)").matches;
  const tweens = new Set();
  const tween = (from, to, ms, set, done) => { const tw = { from, to, ms, set, done, start: performance.now() }; tweens.add(tw); invalidate(); return tw; };
  const ctx = { plan, hooks, pal, mat, color, glow: glowTexture(), still, tween };
  const live = new Map();     // device id -> { module, instance, el, w, h }
  const labels = [];          // one per room that has a name to show
  for (const room of plan.rooms) {
    if (room.kind === "shaft" || room.kind === "unknown") continue;
    const el = document.createElement("span");
    el.className = "planRoomName";
    overlay.appendChild(el);
    const [x, y] = labelPoint(room.polygon);
    labels.push({ el, point: at(x, y, 0.02), room, area: polygonArea(room.polygon), html: null, w: 0, h: 0 });
  }

  // The light of the lamps and heaters of each room, painted on its floor.
  function paintLight(placed) {
    const pools = new Map();
    for (const p of placed) {
      const entry = live.get(p.device.id), pool = entry && entry.instance.pool && entry.instance.pool(p.device);
      if (!pool || !pool.css) continue;
      const room = roomAt(plan, pool.x, pool.y) || plan.rooms.find((r) => r.id === p.device.room);
      if (room) pools.set(room.id, [...(pools.get(room.id) || []), pool]);
    }
    for (const [id, floor] of floors) {
      if (floor.hollow) continue;
      const list = pools.get(id) || [], key = JSON.stringify(list);
      if (key === floor.light.key) continue;
      floor.light.key = key;
      const { canvas: c, g } = floor.light;
      g.globalCompositeOperation = "source-over";
      g.fillStyle = "#000"; g.fillRect(0, 0, c.width, c.height);
      g.globalCompositeOperation = "lighter";
      for (const pool of list) {
        const x = (pool.x - floor.box.minX) * LIGHT_PX, y = (pool.y - floor.box.minY) * LIGHT_PX, reach = pool.reach * LIGHT_PX;
        // the whole room takes a little of the color, then the lamp draws its pool
        g.globalAlpha = 0.1 + 0.12 * pool.level;
        g.fillStyle = pool.css; g.fillRect(0, 0, c.width, c.height);
        const grad = g.createRadialGradient(x, y, 0, x, y, reach);
        grad.addColorStop(0, pool.css); grad.addColorStop(1, "rgba(0,0,0,0)");
        g.globalAlpha = 0.34 + 0.3 * pool.level;
        g.fillStyle = grad; g.fillRect(0, 0, c.width, c.height);
      }
      g.globalAlpha = 1;
      floor.light.texture.needsUpdate = true;
    }
  }

  /* Daylight: the sun of the model stands where the real one is, seen from the home.
     At night it is off and the sky dims: only the lamps that are on light the rooms.
     Kept faint on purpose, a hint of the hour rather than a lighting study. */
  function daylight() {
    const now = hooks.sun && hooks.sun();
    if (!now) return;                         // no place known: the fixed light of the model
    const { toward, day } = sunlight(plan.north || [0, -1], now);
    if (plan.north) sun.position.copy(at(toward[0], toward[1], Math.max(toward[2], 0.12))).multiplyScalar(30);
    const height = Math.max(0, Math.sin(now.elevation * DEG));
    sun.intensity = day * (0.55 + 0.95 * height);
    sun.color.copy(pal.white).lerp(pal.amber, 0.45 * (1 - Math.min(1, height * 2.2)));   // low sun, warm light
    sky.intensity = 1.15 + 0.85 * day;
  }

  function retire(entry) {
    if (entry.wall) entry.wall.sets.splice(entry.wall.sets.indexOf(entry.instance.cut), 1);
    entry.instance.object.removeFromParent();
    entry.el.remove();
  }
  function update(rooms) {
    const placed = placedDevices(plan, rooms), seen = new Set();
    for (const p of placed) {
      seen.add(p.device.id);
      let entry = live.get(p.device.id);
      if (!entry || entry.module !== p.module) {
        if (entry) { retire(entry); }
        const instance = MODULES[p.module](ctx, p);
        scene.add(instance.object);
        // a shutter shows as far up as the wall of its window is cut
        const wall = instance.cut && walls.get(p.point.opening.wall);
        if (wall) { wall.sets.push(instance.cut); if (wall.height !== null) instance.cut(wall.height); }
        const el = document.createElement("button");
        el.type = "button";
        el.dataset.device = p.device.id;
        overlay.appendChild(el);
        entry = { module: p.module, instance, wall, el, html: null, w: 0, h: 0 };
        live.set(p.device.id, entry);
      }
      entry.instance.update(p.device);
      const pin = hooks.pin(p.device, p.module);
      entry.el.className = `planPin ${p.module} ${pin.cls}${p.device.id === lit ? " hl" : ""}`;
      if (pin.mode) entry.el.dataset.mode = pin.mode; else delete entry.el.dataset.mode;
      entry.el.setAttribute("aria-label", p.device.name);
      entry.el.style.setProperty("--lamp", pin.lamp || "");
      if (entry.html !== pin.html) { entry.el.innerHTML = entry.html = pin.html; entry.w = 0; }
    }
    for (const [id, entry] of live) {
      if (seen.has(id)) continue;
      retire(entry); live.delete(id);
    }
    for (const l of labels) {
      const label = hooks.roomLabel(l.room);
      l.equipped = label.equipped;
      if (l.html !== label.html) { l.el.innerHTML = l.html = label.html; l.w = 0; }
      l.el.classList.toggle("bare", !label.equipped);
    }
    // a room takes the tint of its own sensor, never of an air conditioner's probe
    for (const room of rooms || []) {
      const floor = floors.get(room.id);
      if (!floor) continue;
      const tint = temperatureTint(room.temperature);
      floor.tint = floor.tone.clone().lerp(tint.tone === "cool" ? pal.cool : pal.warm, tint.tone ? 0.1 + 0.28 * tint.strength : 0);
    }
    paintFloors();
    paintLight(placed);
    daylight();
    invalidate();
  }

  let selected = null;
  function paintFloors() {
    for (const [id, floor] of floors) floor.mesh.material.color.copy(floor.tint || floor.tone).lerp(pal.accent, id === selected ? 0.1 : 0);
  }

  // The marker of a device stands out while its tile is under the pointer, and back.
  let lit = null;
  function highlight(id) {
    lit = id || null;
    for (const [device, entry] of live) entry.el.classList.toggle("hl", device === lit);
  }

  /* ---- camera: an orthographic view that turns, zooms and slides, within limits ----
     The frame is worked out from the view at every picture: the home fills the same
     share of the card at any angle and any size. The picture follows the view with a
     short lag: a move ends softly, a limit is reached without a jolt, a flick carries
     on a little. Once it has caught up, nothing is drawn. */
  const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 400);
  const views = presets(plan);
  let view = { ...views.iso }, shownName = "iso", width = 0, height = 0, shownFrame = null, snap = true, clock = 0;
  const turnBetween = (a, b) => Math.abs(((b - a + Math.PI) % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI) - Math.PI);
  const caughtUp = (f, g) => turnBetween(f.azimuth, g.azimuth) < 4e-4 && Math.abs(f.elevation - g.elevation) < 4e-4
    && Math.abs(f.height - g.height) < g.height * 8e-4 && Math.hypot(f.center[0] - g.center[0], f.center[1] - g.center[1], f.center[2] - g.center[2]) < 0.004;

  // Draws the camera one step closer to the view. True once it is there.
  function applyCamera(now) {
    const aspect = width / Math.max(1, height), goal = frameView(plan, view, aspect);
    // the first picture of a move counts as one frame; a slow machine catches up by longer steps
    const dt = clock ? Math.min(250, Math.max(1, now - clock)) : 16;
    clock = now;
    if (snap || still || !shownFrame) shownFrame = goal;
    else {
      shownFrame = mixFrame(shownFrame, goal, 1 - Math.exp(-dt / FOLLOW_MS));
      if (caughtUp(shownFrame, goal)) shownFrame = goal;
    }
    snap = false;
    const f = shownFrame;
    raiseWalls(f.azimuth, f.elevation);
    const { back } = viewAxes(f.azimuth, f.elevation);
    const target = at(f.center[0], f.center[1], f.center[2]);
    camera.position.copy(target).addScaledVector(at(back[0], back[1], back[2]), 120);
    camera.up.set(0, 1, 0);
    camera.lookAt(target);
    const halfH = f.height / 2, halfW = halfH * aspect;
    camera.left = -halfW; camera.right = halfW; camera.top = halfH; camera.bottom = -halfH;
    camera.updateProjectionMatrix();
    if (f === goal) clock = 0;
    return f === goal;
  }

  let byHand = false;
  const handed = (on) => { if (on !== byHand) { byHand = on; if (hooks.onMoved) hooks.onMoved(on); } };
  function setView(goal, instant = false) {
    view = holdView(plan, goal);
    if (instant) snap = true;
    invalidate();
  }
  // a move by hand starts from the angle on screen, and the angle is then the hand's
  function grab() {
    const from = shownFrame || frameView(plan, view, width / Math.max(1, height));
    if (view.auto) view = { ...view, auto: false, azimuth: from.azimuth, elevation: from.elevation };
    handed(true);
  }

  // name: "iso", "top", or a room id (which is also highlighted)
  function show(name) {
    const room = views.rooms[name];
    selected = room ? name : null;
    shownName = room || views[name] ? name : "iso";
    paintFloors();
    handed(false);
    setView(room || views[name] || views.iso);
  }

  /* ---- drawing, on demand ---- */
  let raf = 0, timer = 0, dirty = true, active = true, disposed = false;
  const spot = new THREE.Vector3();
  const project = (point) => { spot.copy(point).project(camera); return [(spot.x + 1) / 2 * width, (1 - spot.y) / 2 * height]; };
  const place = (el, x, y) => { el.style.transform = `translate(${x.toFixed(1)}px, ${y.toFixed(1)}px) translate(-50%, -50%)`; };
  const overlap = (a, b) => Math.max(0, Math.min(a[2], b[2]) - Math.max(a[0], b[0])) * Math.max(0, Math.min(a[3], b[3]) - Math.max(a[1], b[1]));

  /* Markers stand where their device is and are always shown. The name of a room then
     takes the free spot closest to the middle of its floor: on it, else just below or
     above, else beside. A name left without a free spot is not shown: two texts over
     each other say less than one. */
  function placeLabels() {
    const taken = [];
    for (const entry of live.values()) {
      if (!entry.w) { entry.w = entry.el.offsetWidth; entry.h = entry.el.offsetHeight; }
      const [x, y] = project(entry.instance.pin);
      entry.el.hidden = x < -20 || y < -20 || x > width + 20 || y > height + 20;
      if (entry.el.hidden) continue;
      place(entry.el, x, y);
      taken.push([x - entry.w / 2, y - entry.h / 2, x + entry.w / 2, y + entry.h / 2]);
    }
    // rooms with something in them choose first, then the largest
    for (const l of [...labels].sort((a, b) => (b.equipped - a.equipped) || b.area - a.area)) {
      if (!l.w) { l.w = l.el.offsetWidth; l.h = l.el.offsetHeight; }
      const [x, y] = project(l.point), dy = l.h + 5, dx = l.w / 2 + 20;
      l.el.hidden = x < -20 || y < -20 || x > width + 20 || y > height + 20;
      if (l.el.hidden) continue;
      let best = null;
      for (const [ox, oy] of [[0, 0], [0, dy], [0, -dy], [0, 2 * dy], [0, -2 * dy], [dx, 0], [-dx, 0], [dx, dy], [-dx, dy], [dx, -dy], [-dx, -dy]]) {
        const box = [x + ox - l.w / 2 - 3, y + oy - l.h / 2 - 3, x + ox + l.w / 2 + 3, y + oy + l.h / 2 + 3];
        if (taken.some((t) => overlap(box, t) > 0)) continue;
        best = { box, x: x + ox, y: y + oy };
        break;
      }
      l.el.hidden = !best;
      if (!best) continue;
      place(l.el, best.x, best.y);
      taken.push(best.box);
    }
  }

  function frame(now) {
    raf = 0;
    if (!active || disposed) return;
    for (const tw of tweens) {
      const k = Math.min(1, (now - tw.start) / tw.ms);
      tw.set(tw.from + (tw.to - tw.from) * k);
      if (k >= 1) { tweens.delete(tw); if (tw.done) tw.done(); }
      dirty = true;
    }
    // the breath of the units only for someone looking: not with the window in the background, not at night
    let alive = false;
    const ambient = !still && document.hasFocus() && !document.getElementById("nightVeil");
    if (ambient) for (const { instance } of live.values()) if (instance.tick && instance.tick(now / 1000)) alive = true;
    if (dirty || alive) {
      const moved = dirty;
      // still catching up with the view: another picture follows this one
      dirty = !applyCamera(now);
      renderer.render(scene, camera);
      if (moved) placeLabels();      // the breath of a unit moves no label
    }
    if (tweens.size || dirty) schedule(0);
    else if (alive) schedule(1000 / AMBIENT_FPS);
  }
  function schedule(delay) {
    if (raf || timer || !active || disposed) return;
    if (delay) timer = setTimeout(() => { timer = 0; raf = requestAnimationFrame(frame); }, delay);
    else raf = requestAnimationFrame(frame);
  }
  function invalidate() { dirty = true; schedule(0); }

  function resize() {
    const box = stage.getBoundingClientRect();
    // the page is zoomed to fit the screen: client sizes are the layout ones, which is what the canvas needs
    width = stage.clientWidth; height = stage.clientHeight;
    if (!width || !height) return;
    renderer.setPixelRatio(Math.min(MAX_PIXEL_RATIO, devicePixelRatio * (box.width / width || 1)));
    renderer.setSize(width, height, false);
    snap = true;      // a new size is not a move
    invalidate();
  }

  /* ---- by hand ----
     Mouse: drag to turn, right button or Shift to slide, wheel to zoom on the pointer.
     Touch: one finger turns, two pinch and slide. Twice on a room frames it. Keys, when
     the plan has the focus: arrows turn, Shift + arrows slide, + and - zoom. */
  const pointers = new Map();
  let travelled = 0, downAt = 0, pinch = null, sliding = false, flick = null, lastTap = null;
  const ray = new THREE.Raycaster(), ndc = new THREE.Vector2();
  const goal = () => frameView(plan, view, width / Math.max(1, height));
  // from a point of the page to meters from the middle of the picture, right and up
  function onPicture(clientX, clientY) {
    const box = canvas.getBoundingClientRect(), k = goal().height / box.height;
    return [(clientX - box.left - box.width / 2) * k, -(clientY - box.top - box.height / 2) * k, k];
  }
  const turn = (dx, dy) => { view = holdView(plan, { ...view, azimuth: view.azimuth - dx * 0.35 * DEG, elevation: view.elevation + dy * 0.3 * DEG }); };
  const slide = (dx, dy) => { const k = onPicture(0, 0)[2]; view = panBy(plan, view, dx * k, -dy * k); };
  const zoomOn = (clientX, clientY, k) => { const [right, up] = onPicture(clientX, clientY); view = zoomAt(plan, view, k, right, up); };
  const between = () => { const [p, q] = [...pointers.values()]; return { x: (p.x + q.x) / 2, y: (p.y + q.y) / 2, d: Math.hypot(p.x - q.x, p.y - q.y) }; };
  canvas.tabIndex = 0;
  canvas.addEventListener("pointerdown", (e) => {
    canvas.setPointerCapture(e.pointerId);
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    flick = null;
    if (pointers.size === 1) { travelled = 0; downAt = performance.now(); sliding = e.button === 2 || e.shiftKey; }
    if (pointers.size === 2) pinch = between();
  });
  canvas.addEventListener("pointermove", (e) => {
    const p = pointers.get(e.pointerId);
    if (!p) return;
    const dx = e.clientX - p.x, dy = e.clientY - p.y;
    p.x = e.clientX; p.y = e.clientY;
    travelled += Math.abs(dx) + Math.abs(dy);
    if (travelled < 6) return;
    grab();
    if (pointers.size === 1) {
      if (sliding) slide(dx, dy); else turn(dx, dy);
      // the speed of the hand, kept for what follows the release
      const now = performance.now(), dt = Math.max(1, now - (flick ? flick.at : now - 16));
      flick = { at: now, sliding, vx: ((flick ? flick.vx : 0) + dx / dt) / 2, vy: ((flick ? flick.vy : 0) + dy / dt) / 2 };
    } else if (pointers.size === 2 && pinch) {
      const now = between();
      slide(now.x - pinch.x, now.y - pinch.y);
      if (pinch.d > 0) zoomOn(now.x, now.y, now.d / pinch.d);
      pinch = now;
    }
    invalidate();
  });
  const release = (e) => {
    if (!pointers.delete(e.pointerId)) return;
    if (pointers.size) { pinch = null; flick = null; return; }
    const now = performance.now();
    if (e.type === "pointerup" && travelled < 6 && now - downAt < 450) {
      // a second tap at the same place: frame the room under it, or the home beside any room
      if (lastTap && now - lastTap.at < 400 && Math.hypot(e.clientX - lastTap.x, e.clientY - lastTap.y) < 30) {
        lastTap = null;
        const box = canvas.getBoundingClientRect();
        ndc.set(((e.clientX - box.left) / box.width) * 2 - 1, -((e.clientY - box.top) / box.height) * 2 + 1);
        ray.setFromCamera(ndc, camera);
        const hit = ray.intersectObjects([...floors.values()].map((f) => f.mesh), false)[0];
        hooks.onRoom(hit ? hit.object.userData.room : null);
      } else lastTap = { at: now, x: e.clientX, y: e.clientY };
      return;
    }
    // let go while moving: the view goes on for what the hand would have covered in a moment
    if (e.type === "pointerup" && flick && now - flick.at < 80 && !still) {
      if (flick.sliding) slide(flick.vx * FLICK_MS, flick.vy * FLICK_MS); else turn(flick.vx * FLICK_MS, flick.vy * FLICK_MS);
      invalidate();
    }
    flick = null;
  };
  canvas.addEventListener("pointerup", release);
  canvas.addEventListener("pointercancel", release);
  canvas.addEventListener("contextmenu", (e) => e.preventDefault());
  // the tab does not scroll: the wheel belongs to the plan
  canvas.addEventListener("wheel", (e) => {
    e.preventDefault();
    grab();
    zoomOn(e.clientX, e.clientY, Math.exp(-e.deltaY * (e.deltaMode === 1 ? 0.05 : 0.0016)));
    invalidate();
  }, { passive: false });
  canvas.addEventListener("keydown", (e) => {
    const arrow = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[e.key];
    const zoom = { "+": 1.25, "=": 1.25, "-": 0.8, _: 0.8 }[e.key];
    if (e.ctrlKey || e.metaKey || e.altKey || (!arrow && !zoom && e.key !== "Home" && e.key !== "0")) return;
    e.preventDefault();
    if (!arrow && !zoom) { recenter(); return; }
    grab();
    if (zoom) view = zoomAt(plan, view, zoom, 0, 0);
    else if (e.shiftKey) slide(-arrow[0] * 60, -arrow[1] * 60);
    else turn(-arrow[0] * 30, -arrow[1] * 20);
    invalidate();
  });
  // back to the automatic frame of what is shown
  function recenter() { show(shownName); }
  overlay.addEventListener("click", (e) => {
    const pin = e.target.closest("[data-device]");
    if (pin) hooks.onDevice(pin.dataset.device);
  });
  // a marker under the pointer, or holding the focus, points at its tile
  const hover = (e) => { const pin = e.target.closest && e.target.closest("[data-device]"); if (pin) hooks.onHover(e.type === "pointerover" || e.type === "focusin" ? pin.dataset.device : null); };
  for (const type of ["pointerover", "pointerout", "focusin", "focusout"]) overlay.addEventListener(type, hover);

  /* ---- awake only when seen ---- */
  const sizes = new ResizeObserver(resize);
  sizes.observe(stage);
  const seen = new IntersectionObserver(([entry]) => setActive(entry.isIntersecting && !document.hidden));
  seen.observe(stage);
  const onVisibility = () => setActive(!document.hidden && stage.offsetParent !== null);
  document.addEventListener("visibilitychange", onVisibility);
  addEventListener("focus", invalidate);      // the breath starts again
  function setActive(on) {
    if (on === active) return;
    active = on;
    if (!on) { cancelAnimationFrame(raf); clearTimeout(timer); raf = timer = 0; return; }
    // tweens started while hidden would otherwise jump: restart their clock
    for (const tw of tweens) tw.start = performance.now();
    resize();
  }
  // A lost context (driver reset, sleep) comes back by itself: draw again when it does.
  canvas.addEventListener("webglcontextlost", (e) => e.preventDefault());
  canvas.addEventListener("webglcontextrestored", invalidate);

  function dispose() {
    disposed = true;
    cancelAnimationFrame(raf); clearTimeout(timer);
    sizes.disconnect(); seen.disconnect();
    document.removeEventListener("visibilitychange", onVisibility);
    removeEventListener("focus", invalidate);
    scene.traverse((o) => {
      if (o.geometry) o.geometry.dispose();
      for (const m of [].concat(o.material || [])) { for (const key of ["map", "emissiveMap"]) if (m[key]) m[key].dispose(); m.dispose(); }
    });
    ctx.glow.dispose();
    renderer.dispose();
    stage.replaceChildren();
  }

  resize();
  // what the page needs to give the plan the height its home fills, and to check it does
  const share = () => homeShare(plan, view, width / Math.max(1, height));
  // a turn by hand, as a drag of (dx, dy) pixels would make it (scripts/check-scroll.js)
  const spin = (dx, dy = 0) => { grab(); turn(dx, dy); invalidate(); };
  return { update, show, recenter, highlight, dispose, share, spin, look: (goal) => setView(goal, true), roomAt: (x, y) => roomAt(plan, x, y), limits: LIMITS, get view() { return view; }, get drawCalls() { return renderer.info.render.frame; }, get stats() { return { parts: furnitureParts3d, batches: batches.size, calls: renderer.info.render.calls, triangles: renderer.info.render.triangles }; } };
}
