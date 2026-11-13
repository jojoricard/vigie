/* The plan of the home as a small architect's model: walls cut at mid-height, soft
   volumes for furniture, and the devices of the house service shown where they are,
   in the state they are in. A lit lamp warms the floor of its room, the daylight
   follows the real sun. Loaded only when a plan exists and WebGL answers.
   Vigie runs all day: a frame is drawn when something changed, never in a loop, except
   while a view moves or an air conditioner blows, and nothing at all while hidden.
   Each kind of device is one entry of MODULES: a new type is a new entry. */
import * as THREE from "../vendor/three/three.module.min.js";
import { CUT_HEIGHT, roomBounds, polygonArea, polygonCentroid, labelPoint, openEdges, wallFrame, wallPieces, openingFrame, nearestWall, roomAt, placedDevices, temperatureTint, coverClosed, presets, clampView, frameView, mixFrame, viewAxes, sunlight, LIMITS } from "./plan.js";

const MAX_PIXEL_RATIO = 1.5;      // a 4K kiosk would otherwise shade four times the pixels
const AMBIENT_FPS = 20;           // the breath of an air conditioner needs no more
const MOVE_MS = 520;
const FLOOR_PX = 44;              // pixels per meter of a floor's pattern
const LIGHT_PX = 20;              // and of the light lamps throw on it: a soft gradient needs few
const DEG = Math.PI / 180;
const ease = (k) => 1 - (1 - k) ** 3;

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

  /* A shutter hangs in the frame of its window, which rises above the cut walls for
     it: the curtain comes down as far as the device says. */
  cover(ctx, { point }) {
    const o = point.opening, f = openingFrame(ctx.plan, o), sill = o.sill || 0, head = sill + o.height, group = new THREE.Group();
    const angle = -Math.atan2(f.uy, f.ux), t = f.wall.thickness;
    for (const end of [f.start, f.end]) {
      const post = new THREE.Mesh(new THREE.BoxGeometry(0.035, head - sill, 0.035), ctx.mat.frame);
      post.position.copy(at(end[0], end[1], (sill + head) / 2));
      group.add(post);
    }
    const lintel = new THREE.Mesh(new THREE.BoxGeometry(o.width + 0.035, 0.035, 0.035), ctx.mat.frame);
    lintel.position.copy(at(f.x, f.y, head));
    lintel.rotation.y = angle;
    const curtain = new THREE.Mesh(new THREE.BoxGeometry(o.width, 1, 0.02), ctx.mat.curtain);
    curtain.rotation.y = angle;
    const bar = new THREE.Mesh(new THREE.BoxGeometry(o.width, 0.045, 0.035), ctx.mat.frame);
    bar.rotation.y = angle;
    group.add(lintel, curtain, bar);
    let closed = 0;
    const place = () => {
      const drop = Math.max(0.03, (head - sill) * closed);
      curtain.scale.y = drop;
      curtain.position.copy(at(f.x, f.y, head - drop / 2));
      bar.position.copy(at(f.x, f.y, head - drop));
    };
    return {
      object: group, pin: at(f.x, f.y, Math.min(head, CUT_HEIGHT + 0.9) + 0.2),
      update(device) {
        const target = coverClosed(device.state);
        if (ctx.still || Math.abs(target - closed) < 0.005) { closed = target; place(); return; }
        ctx.tween(closed, target, 700, (v) => { closed = v; place(); });
      },
      extent: t,
    };
  },

  sensor(ctx, { point }) {
    const h = shown(point.z, 0.5);
    const dot = new THREE.Mesh(new THREE.SphereGeometry(0.055, 14, 10), new THREE.MeshBasicMaterial({ color: ctx.pal.accent }));
    dot.position.copy(at(point.x, point.y, h));
    return { object: dot, pin: at(point.x, point.y, h + 0.2), update() {} };
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
    planned: lambert(pal.neutral, { transparent: true, opacity: 0.4 }),
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
    const tone = hollow ? pal.abyss.clone() : (room.kind === "outdoor" ? FLOOR_TONE.outdoor : FLOOR_TONE[room.floor] || FLOOR_TONE.none).clone();
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

  for (const wall of plan.walls || []) {
    const f = wallFrame(wall), angle = -Math.atan2(f.uy, f.ux);
    for (const piece of wallPieces(plan, wall)) {
      const len = piece.to - piece.from, h = piece.top - piece.bottom, mid = (piece.from + piece.to) / 2;
      if (len < 0.005 || h < 0.005) continue;
      const full = piece.top >= CUT_HEIGHT, side = full ? mat.wall : mat.sill;
      const box = new THREE.Mesh(new THREE.BoxGeometry(len, h, wall.thickness), [side, side, full ? mat.wallTop : side, side, side, side]);
      box.position.copy(at(wall.a[0] + f.ux * mid, wall.a[1] + f.uy * mid, piece.bottom + h / 2));
      box.rotation.y = angle;
      scene.add(box);
    }
  }

  for (const o of plan.openings || []) {
    const f = openingFrame(plan, o);
    if (!f) continue;
    const angle = -Math.atan2(f.uy, f.ux), sill = o.sill || 0, top = Math.min(sill + o.height, CUT_HEIGHT);
    if (o.type === "window" || o.type === "french-window") {
      if (top - sill < 0.02) continue;
      const pane = new THREE.Mesh(new THREE.BoxGeometry(o.width, top - sill, 0.03), mat.glass);
      pane.position.copy(at(f.x, f.y, (sill + top) / 2));
      pane.rotation.y = angle;
      scene.add(pane);
    } else if (o.type === "door") {
      // the leaf stands open, on the side of the room it opens into
      const room = plan.rooms.find((r) => r.id === o.opensInto);
      const c = room ? polygonCentroid(room.polygon) : [f.x + f.nx, f.y + f.ny];
      const side = (c[0] - f.x) * f.nx + (c[1] - f.y) * f.ny >= 0 ? 1 : -1;
      const hinge = o.hinge === "end" ? f.end : f.start, along = o.hinge === "end" ? -1 : 1;
      const swing = 72 * DEG * side * along;
      const dir = [f.ux * along * Math.cos(swing) - f.uy * along * Math.sin(swing), f.ux * along * Math.sin(swing) + f.uy * along * Math.cos(swing)];
      const leaf = new THREE.Mesh(new THREE.BoxGeometry(o.width, top, 0.04), mat.leaf);
      leaf.position.copy(at(hinge[0] + dir[0] * o.width / 2, hinge[1] + dir[1] * o.width / 2, top / 2));
      leaf.rotation.y = -Math.atan2(dir[1], dir[0]);
      scene.add(leaf);
    } else if (o.type === "closet") {
      const doors = new THREE.Mesh(new THREE.BoxGeometry(o.width - 0.04, top, 0.03), mat.furniture);
      doors.position.copy(at(f.x, f.y, top / 2));
      doors.rotation.y = angle;
      scene.add(doors);
    }
  }

  for (const item of plan.furniture || []) {
    const [w, d, h] = item.size, height = Math.min(h, CUT_HEIGHT - 0.06), r = Math.min(0.09, w / 4, d / 4);
    const geo = new THREE.ExtrudeGeometry(roundedRect(w - 0.04, d - 0.04, r), { depth: Math.max(0.02, height - 0.04), bevelEnabled: true, bevelThickness: 0.02, bevelSize: 0.02, bevelSegments: 2, curveSegments: 5 }).rotateX(-Math.PI / 2);
    const mesh = new THREE.Mesh(geo, item.planned ? mat.planned : mat.furniture);
    mesh.position.copy(at(item.position[0], item.position[1], Math.min(item.elevation || 0, CUT_HEIGHT - height) + 0.02));
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

  function update(rooms) {
    const placed = placedDevices(plan, rooms), seen = new Set();
    for (const p of placed) {
      seen.add(p.device.id);
      let entry = live.get(p.device.id);
      if (!entry || entry.module !== p.module) {
        if (entry) { scene.remove(entry.instance.object); entry.el.remove(); }
        const instance = MODULES[p.module](ctx, p);
        scene.add(instance.object);
        const el = document.createElement("button");
        el.type = "button";
        el.dataset.device = p.device.id;
        overlay.appendChild(el);
        entry = { module: p.module, instance, el, html: null, w: 0, h: 0 };
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
      scene.remove(entry.instance.object); entry.el.remove(); live.delete(id);
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

  /* ---- camera: an orthographic view that can turn and zoom, within limits ----
     The frame is worked out from the view at every picture: the home fills the same
     share of the card at any angle and any size. */
  const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 400);
  const views = presets(plan);
  let view = { ...views.iso }, width = 0, height = 0, glide = null;   // glide: { from, k } while a view comes in

  function applyCamera() {
    const aspect = width / Math.max(1, height), goal = frameView(plan, view, aspect);
    const f = glide ? mixFrame(glide.from, goal, glide.k) : goal;
    shownFrame = f;
    const { back } = viewAxes(f.azimuth, f.elevation);
    const target = at(f.center[0], f.center[1], f.center[2]);
    camera.position.copy(target).addScaledVector(at(back[0], back[1], back[2]), 120);
    camera.up.set(0, 1, 0);
    camera.lookAt(target);
    const halfH = f.height / 2, halfW = halfH * aspect;
    camera.left = -halfW; camera.right = halfW; camera.top = halfH; camera.bottom = -halfH;
    camera.updateProjectionMatrix();
  }
  let shownFrame = null;
  const stopGlide = () => { if (glide) { tweens.delete(glide.tween); glide = null; } };

  function setView(goal, instant = false) {
    stopGlide();
    view = clampView(goal);
    if (instant || still || !shownFrame) { invalidate(); return; }
    glide = { from: shownFrame, k: 0 };
    glide.tween = tween(0, 1, MOVE_MS, (k) => { if (glide) glide.k = ease(k); }, () => { glide = null; });
  }
  // turning or zooming by hand starts from what is on screen, and the angle is then the hand's
  function grab() {
    if (shownFrame) view = clampView({ ...view, auto: false, azimuth: shownFrame.azimuth, elevation: shownFrame.elevation });
    stopGlide();
  }

  // name: "iso", "top", or a room id (which is also highlighted)
  function show(name) {
    const room = views.rooms[name];
    selected = room ? name : null;
    paintFloors();
    setView(room || views[name] || views.iso);
  }

  /* ---- drawing, on demand ---- */
  let raf = 0, timer = 0, dirty = true, active = true, disposed = false;
  const spot = new THREE.Vector3();
  const project = (point) => { spot.copy(point).project(camera); return [(spot.x + 1) / 2 * width, (1 - spot.y) / 2 * height]; };
  const place = (el, x, y) => { el.style.transform = `translate(${x.toFixed(1)}px, ${y.toFixed(1)}px) translate(-50%, -50%)`; };
  const overlap = (a, b) => Math.max(0, Math.min(a[2], b[2]) - Math.max(a[0], b[0])) * Math.max(0, Math.min(a[3], b[3]) - Math.max(a[1], b[1]));

  /* Markers stand where their device is. The name of a room then takes the free spot
     closest to the middle of its floor: on it, else just below or above, else beside. */
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
        const box = [x + ox - l.w / 2 - 2, y + oy - l.h / 2 - 2, x + ox + l.w / 2 + 2, y + oy + l.h / 2 + 2];
        const cost = taken.reduce((sum, t) => sum + overlap(box, t), 0);
        if (!best || cost < best.cost) best = { cost, box, x: x + ox, y: y + oy };
        if (!cost) break;
      }
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
    let alive = false;
    if (!still) for (const { instance } of live.values()) if (instance.tick && instance.tick(now / 1000)) alive = true;
    if (dirty || alive) {
      const moved = dirty;
      applyCamera();
      renderer.render(scene, camera);
      if (moved) placeLabels();      // the breath of a unit moves no label
      dirty = false;
    }
    if (tweens.size) schedule(0);
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
    invalidate();
  }

  /* ---- pointer: turn with one finger, pinch or Ctrl+wheel to zoom, tap to pick ---- */
  const pointers = new Map();
  let travelled = 0, downAt = 0, pinch = 0;
  const ray = new THREE.Raycaster(), ndc = new THREE.Vector2();
  const spread = () => { const [p, q] = [...pointers.values()]; return Math.hypot(p.x - q.x, p.y - q.y); };
  canvas.addEventListener("pointerdown", (e) => {
    canvas.setPointerCapture(e.pointerId);
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.size === 1) { travelled = 0; downAt = performance.now(); }
    if (pointers.size === 2) pinch = spread();
  });
  canvas.addEventListener("pointermove", (e) => {
    const p = pointers.get(e.pointerId);
    if (!p) return;
    const dx = e.clientX - p.x, dy = e.clientY - p.y;
    p.x = e.clientX; p.y = e.clientY;
    travelled += Math.abs(dx) + Math.abs(dy);
    if (travelled < 6) return;
    grab();
    if (pointers.size === 1) view = clampView({ ...view, azimuth: view.azimuth - dx * 0.35 * DEG, elevation: view.elevation + dy * 0.3 * DEG });
    else if (pointers.size === 2 && pinch) { const d = spread(); view = clampView({ ...view, zoom: view.zoom * d / pinch }); pinch = d; }
    invalidate();
  });
  const release = (e) => {
    if (!pointers.delete(e.pointerId) || pointers.size) return;
    if (e.type !== "pointerup" || travelled >= 6 || performance.now() - downAt > 450) return;
    // a tap: which floor is under the finger
    const box = canvas.getBoundingClientRect();
    ndc.set(((e.clientX - box.left) / box.width) * 2 - 1, -((e.clientY - box.top) / box.height) * 2 + 1);
    ray.setFromCamera(ndc, camera);
    const hit = ray.intersectObjects([...floors.values()].map((f) => f.mesh), false)[0];
    hooks.onRoom(hit ? hit.object.userData.room : null);
  };
  canvas.addEventListener("pointerup", release);
  canvas.addEventListener("pointercancel", release);
  // a plain wheel scrolls the page, as everywhere else on it
  canvas.addEventListener("wheel", (e) => {
    if (!e.ctrlKey) return;
    e.preventDefault();
    grab();
    view = clampView({ ...view, zoom: view.zoom * Math.exp(-e.deltaY * 0.0016) });
    invalidate();
  }, { passive: false });
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
    scene.traverse((o) => {
      if (o.geometry) o.geometry.dispose();
      for (const m of [].concat(o.material || [])) { for (const key of ["map", "emissiveMap"]) if (m[key]) m[key].dispose(); m.dispose(); }
    });
    ctx.glow.dispose();
    renderer.dispose();
    stage.replaceChildren();
  }

  resize();
  return { update, show, highlight, dispose, roomAt: (x, y) => roomAt(plan, x, y), limits: LIMITS, get view() { return view; }, get drawCalls() { return renderer.info.render.frame; } };
}
