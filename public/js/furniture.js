/* Furniture of the floor plan: a small library of types, each drawn from a few
   parameters as simple volumes. A plan says "a cabinet this wide, white, with an oak
   top and a niche in the middle"; it never names a product. No DOM and no three.js
   here: a type returns a list of parts, plan3d.js turns them into instances.

   An item of the plan: { type, position: [x, y], size: [width, depth, height],
   rotation, elevation, params }. Its own frame: x along its width, y from its back
   (-depth/2, against the wall) to its front (+depth/2), z up from its feet.
   `rotation` is in degrees, clockwise on the plan: at 0 the front faces down the plan.

   A part: { shape: "box" | "cyl", size: [w, d, h], at: [x, y, z] (its center),
   color, look, turn, tilt, bound }. `look` is "solid", "glass" (see-through), "sheer"
   (a curtain) or "glow" (lit by itself: a screen, a lit case). `turn` turns the part on
   itself, `tilt` leans it from the vertical toward its front (the stem of a plant).
   `bound` says the part is fixed to the wall behind its item: it is cut where that wall
   is cut for the view, not at the cut of the furniture. */
import { CUT_HEIGHT } from "./plan.js";

/* Materials by name. A plan may also give any "#rrggbb". These are real colors: the
   model tones them to the dark theme when it draws them. */
export const MATERIALS = {
  white: "#ece9e4", cream: "#e4dccd", black: "#2a282d", charcoal: "#45434a", grey: "#9a989e", steel: "#b4b7bc",
  oak: "#c59a63", walnut: "#7b5236", pine: "#d9b98a", wicker: "#b99766", slate: "#3c3d43",
  fabric: "#c9c2b6", linen: "#ddd6c8", leather: "#34323a", green: "#5d8a4e", terracotta: "#b76b4a",
  glass: "#bcd4e6", chrome: "#c9ccd1", red: "#b8323c", screen: "#15141a",
};
export const colorOf = (name, fallback = null) => !name ? fallback : MATERIALS[name] || (/^#[0-9a-f]{6}$/i.test(name) ? name : fallback);

/* Volumes that stand on the floor are cut with the walls. Thin things that say what a
   room is for may rise a little above the cut: a lamp, a screen, shelves on a wall. */
const FLOOR_LIMIT = CUT_HEIGHT - 0.06, TALL_LIMIT = CUT_HEIGHT + 0.5;

/* ---------- Building blocks ---------- */
const kit = () => {
  const parts = [];
  // a box given by its size and the middle of its underside
  const box = (color, w, d, h, x = 0, y = 0, z = 0, extra) => { if (w > 0.002 && d > 0.002 && h > 0.002) parts.push({ shape: "box", size: [w, d, h], at: [x, y, z + h / 2], color, look: "solid", ...extra }); };
  // an upright cylinder given by its radius, its height and the middle of its underside
  const cyl = (color, r, h, x = 0, y = 0, z = 0, extra) => { if (r > 0.002 && h > 0.002) parts.push({ shape: "cyl", size: [2 * r, 2 * r, h], at: [x, y, z + h / 2], color, look: "solid", ...extra }); };
  return { parts, box, cyl };
};
// a color a little darker, to tell two leaves or two fronts apart
const shade = (hexColor, k) => "#" + [1, 3, 5].map((i) => Math.min(255, Math.round(parseInt(hexColor.slice(i, i + 2), 16) * k)).toString(16).padStart(2, "0")).join("");
// a number that looks random and is always the same for the same place
const scatter = (i, j = 0) => (((i * 73 + j * 151 + 11) * 2654435761) >>> 0) % 1000 / 1000;
const BOOKS = ["#8c4a3f", "#3f5f7a", "#c9b88f", "#4f6b4f", "#d8d2c4", "#6a5a7a", "#b98a4e"];

/* ---------- Types ----------
   Each takes (size, params) and returns parts in the item's frame, feet at z = 0. */
const TYPES = {
  // a plain volume: what an item without a type is
  box([w, d, h], p) {
    const k = kit();
    k.box(colorOf(p.color), w, d, h);
    return k.parts;
  },

  /* A cabinet: sideboard, TV stand, chest of drawers, bedside table, kitchen units.
     body, top (a material, or none), legs (height), doors or drawers (counts, drawn as
     fronts), niches: open parts given as [from, to] fractions of the width, each with
     `baskets` in it, handles on or off. With `nicheHeight` (a fraction of the height)
     a niche only takes the top of the carcass, and doors close what is under it. */
  cabinet([w, d, h], p) {
    const k = kit(), body = colorOf(p.body, MATERIALS.white), legs = p.legs || 0, topT = p.top ? 0.03 : 0;
    const z0 = legs, ch = h - legs - topT, niches = (p.niches || []).map(([a, b]) => [a * w - w / 2, b * w - w / 2]);
    if (legs) for (const sx of [-1, 1]) for (const sy of [-1, 1]) k.box(colorOf(p.legColor, body), 0.04, 0.04, legs, sx * (w / 2 - 0.05), sy * (d / 2 - 0.05), 0);
    // the carcass, split around the niches
    let cursor = -w / 2;
    const closed = [];
    for (const [a, b] of [...niches, [w / 2, w / 2]]) { if (a - cursor > 0.01) closed.push([cursor, a]); cursor = b; }
    for (const [a, b] of closed) k.box(body, b - a, d, ch, (a + b) / 2, 0, z0);
    const under = ch * (1 - Math.min(1, Math.max(0.1, p.nicheHeight || 1))), nh = ch - under, front = colorOf(p.front, body);
    for (const [a, b] of niches) {
      k.box(body, b - a, d, under + 0.03, (a + b) / 2, 0, z0);               // what is under the niche, up to its floor
      k.box(body, b - a, 0.02, ch, (a + b) / 2, -d / 2 + 0.01, z0);          // its back
      const n = p.baskets || 0, bw = (b - a) / Math.max(1, n) - 0.03, doors = Math.max(1, Math.round((b - a) / 0.5));
      for (let i = 0; i < n; i++) k.box(colorOf(p.basketColor, MATERIALS.wicker), bw, d * 0.8, Math.min(0.24, nh * 0.7), a + (i + 0.5) * (b - a) / n, 0.02, z0 + under + 0.03);
      if (p.shelf) k.box(body, b - a, d - 0.02, 0.02, (a + b) / 2, 0, z0 + under + nh * 0.55);
      if (under > 0.05) for (let c = 0; c < doors; c++) k.box(front, (b - a) / doors - 0.008, 0.012, under - 0.008, a + (c + 0.5) * (b - a) / doors, d / 2 + 0.006, z0 + 0.004);
    }
    // fronts: doors side by side, or rows of drawers, proud of the carcass by a hair
    const rows = p.drawers || 1;
    for (const [a, b] of closed) {
      const cols = Math.max(1, Math.round((p.doors || p.columns || Math.max(1, Math.round((b - a) / 0.5)))));
      for (let c = 0; c < cols; c++) for (let r = 0; r < rows; r++) {
        const fw = (b - a) / cols - 0.008, fh = ch / rows - 0.008;
        k.box(front, fw, 0.012, fh, a + (c + 0.5) * (b - a) / cols, d / 2 + 0.006, z0 + r * ch / rows + 0.004);
        if (p.handles !== false) k.box(colorOf(p.handleColor, MATERIALS.charcoal), rows > 1 ? Math.min(0.14, fw * 0.4) : 0.012, 0.012, rows > 1 ? 0.012 : Math.min(0.12, fh * 0.3), a + (c + (rows > 1 ? 0.5 : c < cols / 2 ? 0.86 : 0.14)) * (b - a) / cols, d / 2 + 0.018, z0 + (r + (rows > 1 ? 0.72 : 0.6)) * ch / rows);
      }
    }
    if (p.top) k.box(colorOf(p.top), w + 0.02, d + 0.02, topT, 0, 0, h - topT);
    return k.parts;
  },

  /* Open shelving: a frame of `columns` by `rows` cells. `shelf` is the material of the
     shelves when it differs from the frame, `staggered` shifts every other column by
     half a cell, `back` closes it, `fill` (0 to 1) puts books and boxes in the cells,
     `bins` the color of the boxes that close some cells. */
  shelving([w, d, h], p) {
    const k = kit(), body = colorOf(p.body, MATERIALS.white), shelf = colorOf(p.shelf, body), t = 0.025;
    const cols = Math.max(1, p.columns || Math.round(w / 0.38)), rows = Math.max(1, p.rows || Math.round(h / 0.38));
    const cw = (w - t) / cols, rh = (h - t) / rows;
    for (let c = 0; c <= cols; c++) k.box(body, t, d, h, -w / 2 + t / 2 + c * cw, 0, 0);
    if (p.back) k.box(body, w, 0.012, h, 0, -d / 2 + 0.006, 0);
    for (let c = 0; c < cols; c++) {
      const shift = p.staggered && c % 2 ? rh / 2 : 0, x = -w / 2 + t / 2 + (c + 0.5) * cw;
      for (let r = 0; r <= rows; r++) {
        const z = Math.min(h - t, r * rh + (r > 0 && r < rows ? shift : 0));
        k.box(shelf, cw - t, d, t, x, 0, z);
        if (r === rows) continue;
        const pick = scatter(c, r);
        if (p.bins && pick < 0.3) k.box(colorOf(p.bins), cw - t - 0.02, d * 0.9, rh - t - 0.03, x, 0.01, z + t);
        else if (pick < (p.fill ?? 0.5)) {
          // a row of books of uneven heights, or a low box
          const n = 3 + Math.floor(pick * 10) % 4, bw = (cw - t - 0.04) * 0.75 / n;
          for (let b = 0; b < n; b++) k.box(BOOKS[Math.floor(scatter(c * 7 + b, r) * BOOKS.length)], bw - 0.004, d * 0.6, (rh - t) * (0.55 + 0.35 * scatter(b, c + r)), x - (cw - t) / 2 + 0.03 + (b + 0.5) * bw, -d * 0.1, z + t);
        }
      }
    }
    return k.parts;
  },

  // Shelves hung on a wall, one above the other: `count`, `spacing`, `color`, a few things on them.
  wallShelves([w, d, h], p) {
    const k = kit(), n = Math.max(1, p.count || 2), gap = p.spacing || (n > 1 ? (h - 0.03) / (n - 1) : 0);
    for (let i = 0; i < n; i++) {
      k.box(colorOf(p.color, MATERIALS.white), w, d, 0.03, 0, 0, i * gap);
      if (p.fill !== 0) for (let j = 0; j < 3; j++) if (scatter(i, j) < 0.7) k.box(BOOKS[(i * 3 + j) % BOOKS.length], 0.06 + 0.08 * scatter(j, i), d * 0.5, 0.08 + 0.1 * scatter(i + j, 3), -w / 2 + (j + 0.5) * w / 3, 0, i * gap + 0.03);
    }
    return k.parts;
  },

  /* A table: `top` material, `legs` color, `legSize`, legs set in by `inset`. With
     `pedestal` it stands on one central foot (a high table). */
  table([w, d, h], p) {
    const k = kit(), t = p.thickness || 0.04, leg = p.legSize || 0.06, inset = p.inset ?? 0.03, legs = colorOf(p.legs, MATERIALS.white);
    k.box(colorOf(p.top, MATERIALS.oak), w, d, t, 0, 0, h - t);
    if (p.pedestal) { k.cyl(legs, 0.04, h - t - 0.02, 0, 0, 0.02); k.cyl(legs, Math.min(w, d) * 0.32, 0.02); }
    else {
      for (const sx of [-1, 1]) for (const sy of [-1, 1]) k.box(legs, leg, leg, h - t, sx * (w / 2 - leg / 2 - inset), sy * (d / 2 - leg / 2 - inset), 0);
      if (p.apron !== false && h > 0.5) for (const sy of [-1, 1]) k.box(legs, w - 2 * (leg + inset), 0.02, 0.07, 0, sy * (d / 2 - leg / 2 - inset), h - t - 0.07);
    }
    if (p.shelf) k.box(colorOf(p.shelfColor, legs), w - 0.1, d - 0.1, 0.03, 0, 0, h * 0.25);
    return k.parts;
  },

  /* A desk. Plain, or with `shape: "L"`: a return of `returnLength` by `returnDepth`
     leaves the front on the `returnSide` ("left" or "right"). `legs` can be "panel"
     (two full sides) or a color for four legs. */
  desk([w, d, h], p) {
    const k = kit(), t = 0.035, top = colorOf(p.top, MATERIALS.white), legColor = colorOf(p.legs === "panel" ? p.body : p.legs, top);
    const leg = (x, y) => p.round ? k.cyl(legColor, 0.025, h - t, x, y, 0) : k.box(legColor, 0.05, 0.05, h - t, x, y, 0);
    k.box(top, w, d, t, 0, 0, h - t);
    if (p.legs === "panel") for (const sx of [-1, 1]) k.box(legColor, 0.03, d - 0.04, h - t, sx * (w / 2 - 0.02), 0, 0);
    else for (const sx of [-1, 1]) for (const sy of [-1, 1]) leg(sx * (w / 2 - 0.06), sy * (d / 2 - 0.06));
    if (p.shape === "L") {
      const side = p.returnSide === "left" ? -1 : 1, rl = p.returnLength || 1.2, rd = p.returnDepth || d;
      const x = side * (w / 2 - rd / 2), y = d / 2 + rl / 2;
      k.box(top, rd, rl, t, x, y, h - t);
      if (p.legs === "panel") k.box(legColor, rd - 0.04, 0.03, h - t, x, d / 2 + rl - 0.02, 0);
      else for (const sx of [-1, 1]) leg(x + sx * (rd / 2 - 0.06), d / 2 + rl - 0.06);
    }
    return k.parts;
  },

  /* A seat. `style`: "dining" (a shell on four legs), "office" (a high back, arms, a
     foot with five branches), "stool" (a round seat on a column), "bar" (the same,
     higher, with a low back). */
  chair([w, d, h], p) {
    const k = kit(), style = p.style || "dining", seat = colorOf(p.color, MATERIALS.white), legs = colorOf(p.legs, style === "dining" ? MATERIALS.oak : MATERIALS.charcoal);
    if (style === "stool" || style === "bar") {
      const sh = style === "bar" ? Math.min(h, 0.75) : h;
      k.cyl(legs, w * 0.4, 0.02); k.cyl(legs, 0.022, sh - 0.07, 0, 0, 0.02); k.cyl(seat, w * 0.45, 0.05, 0, 0, sh - 0.05);
      if (style === "bar") k.box(legs, w * 0.7, 0.02, h - sh, 0, -d / 2 + 0.02, sh);
    } else if (style === "office") {
      const sh = 0.48;
      for (let i = 0; i < 5; i++) k.box(legs, 0.04, w * 0.5, 0.03, Math.sin(i * 1.2566) * w * 0.25, -Math.cos(i * 1.2566) * w * 0.25, 0.03, { turn: i * 72 });
      k.cyl(legs, 0.03, sh - 0.12, 0, 0, 0.05);
      k.box(seat, w * 0.82, d * 0.8, 0.1, 0, 0.02, sh - 0.08);
      k.box(seat, w * 0.78, 0.1, h - sh, 0, -d / 2 + 0.08, sh);                       // the back
      k.box(colorOf(p.accent, seat), w * 0.5, 0.11, 0.16, 0, -d / 2 + 0.08, h - 0.2); // its head cushion
      for (const sx of [-1, 1]) k.box(legs, 0.06, d * 0.5, 0.04, sx * w * 0.44, 0.02, sh + 0.16);
    } else {
      const sh = Math.min(0.46, h * 0.55);
      for (const sx of [-1, 1]) for (const sy of [-1, 1]) k.box(legs, 0.03, 0.03, sh - 0.03, sx * (w / 2 - 0.05), sy * (d / 2 - 0.05), 0);
      k.box(seat, w, d, 0.05, 0, 0, sh - 0.05);
      k.box(seat, w, 0.04, h - sh, 0, -d / 2 + 0.02, sh);
    }
    return k.parts;
  },

  /* A sofa: a base, a back, arms and `seats` cushions. `chaise` ("left" or "right")
     adds a long seat on that side, `chaiseLength` deep in all. */
  sofa([w, d, h], p) {
    const k = kit(), c = colorOf(p.color, MATERIALS.linen), cushion = colorOf(p.cushion, c), arm = p.arm ?? 0.16, back = 0.2, sh = Math.min(0.42, h * 0.55);
    k.box(c, w, d, sh - 0.12, 0, 0, 0.04);
    k.box(c, w, back, h - 0.04, 0, -d / 2 + back / 2, 0.04);
    for (const sx of [-1, 1]) k.box(c, arm, d, Math.min(h - 0.12, sh + 0.16), sx * (w / 2 - arm / 2), 0, 0.04);
    const n = Math.max(1, p.seats || Math.round((w - 2 * arm) / 0.75)), cw = (w - 2 * arm) / n;
    for (let i = 0; i < n; i++) {
      k.box(cushion, cw - 0.02, d - back - 0.02, 0.13, -w / 2 + arm + (i + 0.5) * cw, back / 2, sh - 0.1);
      k.box(cushion, cw - 0.04, 0.14, h - sh - 0.1, -w / 2 + arm + (i + 0.5) * cw, -d / 2 + back + 0.06, sh + 0.03);
    }
    if (p.chaise) {
      const side = p.chaise === "left" ? -1 : 1, len = (p.chaiseLength || d + 0.7) - d, x = side * (w / 2 - arm - cw / 2);
      k.box(c, cw + arm, len, sh - 0.12, x + side * arm / 2, d / 2 + len / 2, 0.04);
      k.box(cushion, cw - 0.02, len, 0.13, x, d / 2 + len / 2 - 0.01, sh - 0.1);
    }
    return k.parts;
  },

  // A bed: a base, a mattress, a duvet and pillows at the back. `frame`, `linen`, `headboard`.
  bed([w, d, h], p) {
    const k = kit(), frame = colorOf(p.frame, MATERIALS.oak), linen = colorOf(p.linen, MATERIALS.linen);
    k.box(frame, w, d, h * 0.45, 0, 0, 0.03);
    k.box(MATERIALS.white, w - 0.04, d - 0.04, h * 0.4, 0, 0, h * 0.45 + 0.03);
    k.box(linen, w + 0.02, d * 0.68, 0.07, 0, d * 0.16, h * 0.85 + 0.01);
    const n = w > 1.2 ? 2 : 1;
    for (let i = 0; i < n; i++) k.box(colorOf(p.pillow, MATERIALS.white), w / n - 0.12, 0.38, 0.1, -w / 2 + (i + 0.5) * w / n, -d / 2 + 0.24, h * 0.85 + 0.03);
    if (p.headboard) k.box(colorOf(p.headboard), w, 0.05, h + 0.45, 0, -d / 2 - 0.025, 0);
    return k.parts;
  },

  /* A screen: a television or a monitor. `stand` true puts it on a foot, false hangs it
     (set `elevation`). `upright` turns it to portrait. `lit` (a color) lights its face. */
  screen([w, d, h], p) {
    const k = kit(), foot = p.stand === false ? 0 : Math.min(0.09, h * 0.2), sw = p.upright ? h - foot : w, sh = p.upright ? w : h - foot;
    if (foot) { k.box(MATERIALS.charcoal, Math.min(sw * 0.4, 0.3), Math.max(d, 0.16), 0.015); k.box(MATERIALS.charcoal, 0.04, 0.03, foot, 0, -0.01, 0.015); }
    k.box(colorOf(p.frame, MATERIALS.screen), sw, 0.03, sh, 0, 0, foot);
    k.box(colorOf(p.lit, "#26232e"), sw - 0.03, 0.006, sh - 0.03, 0, 0.018, foot + 0.015, { look: p.lit ? "glow" : "solid" });
    return k.parts;
  },

  // A computer case with a glass side: `glow` (a color) is the light inside, seen through it.
  pc([w, d, h], p) {
    const k = kit(), body = colorOf(p.body, MATERIALS.black);
    k.box(body, w, d, 0.03); k.box(body, w, d, 0.03, 0, 0, h - 0.03);
    k.box(body, 0.02, d, h, -w / 2 + 0.01, 0, 0); k.box(body, w, 0.02, h, 0, -d / 2 + 0.01, 0);
    if (p.glow) k.box(colorOf(p.glow), w - 0.07, d - 0.07, h - 0.1, 0.01, 0.01, 0.05, { look: "glow" });
    k.box(MATERIALS.glass, 0.008, d, h - 0.06, w / 2 - 0.004, 0, 0.03, { look: "glass" });
    k.box(MATERIALS.glass, w, 0.008, h - 0.06, 0, d / 2 - 0.004, 0.03, { look: "glass" });
    return k.parts;
  },

  /* A lamp as decor. `style`: "floor" (a pole and a shade), "arc" (a pole, then an arm
     that carries the shade `reach` away toward the left of the item, or the right
     with `side: "right"`), "table", "arch" (a table lamp whose base is an arch, under
     a drum shade as wide as the item). The light of a connected lamp is not drawn
     here: its anchor on the plan stands at the shade. */
  lamp([w, d, h], p) {
    const k = kit(), metal = colorOf(p.color, MATERIALS.white), shade = colorOf(p.shade, MATERIALS.cream), style = p.style || "floor";
    if (style === "arch") {
      const base = h * 0.46, post = Math.min(w * 0.14, 0.05);
      for (const sx of [-1, 1]) k.cyl(metal, post, base - post, sx * (w * 0.34 - post), 0, 0);
      k.box(metal, w * 0.68, 2 * post, 2 * post, 0, 0, base - 2 * post);
      k.cyl(shade, p.shadeSize || w / 2, h - base - 0.02, 0, 0, base + 0.02);
      return k.parts;
    }
    k.cyl(metal, Math.min(w, d) * 0.45, 0.025);
    if (style === "arc") {
      const side = p.side === "right" ? 1 : -1, reach = p.reach || 0.6, steps = 6;
      k.cyl(metal, 0.012, h * 0.62, 0, 0, 0.025);
      // the arm rises and comes back down in a few straight pieces
      for (let i = 0; i < steps; i++) {
        const a = i / steps * Math.PI / 2, b = (i + 1) / steps * Math.PI / 2;
        const x0 = side * reach * (1 - Math.cos(a)), x1 = side * reach * (1 - Math.cos(b)), z0 = h * 0.62 + h * 0.38 * Math.sin(a), z1 = h * 0.62 + h * 0.38 * Math.sin(b);
        k.box(metal, Math.abs(x1 - x0) + 0.02, 0.02, Math.abs(z1 - z0) + 0.02, (x0 + x1) / 2, 0, Math.min(z0, z1));
      }
      k.cyl(shade, p.shadeSize || 0.11, 0.14, side * reach, 0, h - 0.2);
    } else {
      k.cyl(metal, 0.012, h - 0.2, 0, 0, 0.025);
      k.cyl(shade, p.shadeSize || (style === "table" ? 0.1 : 0.16), 0.2, 0, 0, h - 0.2);
    }
    return k.parts;
  },

  /* A plant in a round pot: stems that lean outward, each ending in a large leaf, and
     pebbles on the soil. `pot` and `leaves` are colors, `stems` their number,
     `pebbles: false` leaves the soil bare, `stakes` adds canes. The size is the pot's
     footprint and the height of the whole plant. */
  plant([w, d, h], p) {
    const k = kit(), r = Math.min(w, d) / 2, ph = Math.min(0.48, h * 0.27), pot = colorOf(p.pot, MATERIALS.terracotta), green = colorOf(p.leaves, MATERIALS.green);
    // the pot widens toward its rim
    k.cyl(pot, r * 0.74, ph * 0.5); k.cyl(pot, r * 0.87, ph * 0.5, 0, 0, ph * 0.5); k.cyl(pot, r * 0.95, 0.03, 0, 0, ph);
    k.cyl("#3b3128", r * 0.82, 0.012, 0, 0, ph + 0.03);
    const GOLDEN = 137.5 * Math.PI / 180;
    if (p.pebbles !== false) {
      for (let i = 0; i < 11; i++) {
        const a = i * GOLDEN, rad = r * 0.7 * Math.sqrt((i + 0.5) / 11);
        k.cyl(i % 3 ? "#d9d5cb" : "#aaa49a", r * (0.1 + 0.05 * scatter(i, 5)), 0.03, Math.cos(a) * rad, Math.sin(a) * rad, ph + 0.04);
      }
    }
    const stems = Math.max(3, Math.min(12, p.stems || 7)), tall = h - ph;
    for (let i = 0; i < stems; i++) {
      // each stem leaves the middle of the pot in its own direction, the inner ones taller and straighter
      const phi = i * GOLDEN + scatter(i, 1), lean = (5 + 15 * (i / stems) + 6 * scatter(i, 2)) * Math.PI / 180;
      const length = tall * (0.78 - 0.34 * (i / stems) + 0.08 * scatter(i, 3)), turn = Math.atan2(-Math.cos(phi), Math.sin(phi)) * 180 / Math.PI;
      const dir = (t) => [Math.sin(t) * Math.cos(phi), Math.sin(t) * Math.sin(phi), Math.cos(t)];
      const foot = [Math.cos(phi) * r * 0.2, Math.sin(phi) * r * 0.2, ph + 0.03], u = dir(lean);
      k.parts.push({ shape: "cyl", size: [0.02, 0.02, length], at: [foot[0] + u[0] * length / 2, foot[1] + u[1] * length / 2, foot[2] + u[2] * length / 2], color: green, look: "solid", turn, tilt: lean * 180 / Math.PI });
      // the leaf carries on from the tip of its stem, leaning further out: a long blade, wider than it is thick
      const tip = [foot[0] + u[0] * length, foot[1] + u[1] * length, foot[2] + u[2] * length], bend = lean + (20 + 16 * scatter(i, 4)) * Math.PI / 180, v = dir(bend);
      const blade = Math.min(tall * 0.36, h - tip[2] + 0.1) * (0.85 + 0.3 * scatter(i, 6)), wide = 0.13 + 0.07 * scatter(i, 7);
      k.parts.push({ shape: "box", size: [wide, 0.014, blade], at: [tip[0] + v[0] * blade / 2, tip[1] + v[1] * blade / 2, tip[2] + v[2] * blade / 2], color: i % 2 ? green : shade(green, 0.86), look: "solid", turn, tilt: bend * 180 / Math.PI });
    }
    for (let i = 0; i < (p.stakes || 0); i++) k.cyl(MATERIALS.wicker, 0.008, tall * 0.92, (i - 0.5) * 0.06, -r * 0.3, ph);
    return k.parts;
  },

  // A toilet: the tank at the back, the bowl in front of it.
  toilet([w, d, h], p) {
    const k = kit(), c = colorOf(p.color, MATERIALS.white);
    k.box(c, w * 0.95, d * 0.28, h * 1.9, 0, -d / 2 + d * 0.14, 0);
    k.box(c, w * 0.6, d * 0.3, h * 0.9, 0, -d * 0.1, 0);
    k.cyl(c, w * 0.45, h, 0, d * 0.16, 0);
    k.cyl(colorOf(p.lid, c), w * 0.47, 0.03, 0, d * 0.16, h);
    return k.parts;
  },

  // A radiator on a wall: a panel and its fins. Decor: a connected heater has its own marker.
  radiator([w, d, h], p) {
    const k = kit(), c = colorOf(p.color, MATERIALS.white), n = Math.max(2, Math.round(w / 0.07));
    k.box(c, w, d * 0.5, h, 0, -d * 0.25, 0);
    for (let i = 0; i < n; i++) k.box(c, 0.03, d * 0.5, h - 0.06, -w / 2 + (i + 0.5) * w / n, d * 0.25, 0.03);
    return k.parts;
  },

  /* Wooden slats on a wall: upright battens of `slat` width every `pitch`, on a dark
     backing. A wall covering, as thin as the plan says. */
  slats([w, d, h], p) {
    const k = kit(), slat = p.slat || 0.028, pitch = p.pitch || 0.045, n = Math.max(1, Math.floor(w / pitch));
    k.box(colorOf(p.backing, MATERIALS.black), w, d * 0.4, h, 0, -d * 0.3, 0);
    for (let i = 0; i < n; i++) k.box(colorOf(p.color, MATERIALS.oak), slat, d * 0.6, h, -w / 2 + (i + 0.5) * w / n, d * 0.2, 0);
    return k.parts;
  },

  /* A sheer curtain placed by hand, for a window the plan does not describe: soft folds
     from its rod to the floor, seen through. A window of the plan takes `curtain` on its
     opening instead, and the model hangs it by itself. */
  curtain([w, d, h], p) {
    const k = kit(), n = Math.max(3, Math.round(w / 0.16));
    for (let i = 0; i < n; i++) k.box(colorOf(p.color, MATERIALS.white), w / n + 0.004, 0.012, h, -w / 2 + (i + 0.5) * w / n, (i % 2 ? 1 : -1) * d * 0.3, 0, { look: "sheer", bound: true });
    k.box(MATERIALS.charcoal, w + 0.06, 0.025, 0.025, 0, 0, h, { bound: true });
    return k.parts;
  },

  /* A run of kitchen units against a wall, at the standard sizes whatever height the
     plan gives: a plinth, base units 0.87 m high, a worktop that ends at 0.90 m. `doors`
     is the number of fronts, `body` and `top` their colors. `uppers: true` adds the wall
     units, fixed to the wall above the worktop (from 1.40 m to 2.10 m, 0.35 m deep).
     `hob` and `sink` are [from, to] fractions of the width. */
  kitchen([w, d], p) {
    const k = kit(), body = colorOf(p.body, MATERIALS.white), top = colorOf(p.top, MATERIALS.slate), doors = Math.max(1, p.doors || Math.round(w / 0.6));
    const PLINTH = 0.1, WORKTOP = 0.9, SLAB = 0.03;
    k.box(MATERIALS.charcoal, w, d - 0.06, PLINTH, 0, -0.03, 0);
    k.box(body, w, d - 0.02, WORKTOP - SLAB - PLINTH, 0, -0.01, PLINTH);
    for (let i = 0; i < doors; i++) {
      const x = -w / 2 + (i + 0.5) * w / doors;
      k.box(body, w / doors - 0.008, 0.016, WORKTOP - SLAB - PLINTH - 0.01, x, d / 2 - 0.012, PLINTH + 0.005);
      k.box(MATERIALS.charcoal, 0.012, 0.014, 0.14, x + (i % 2 ? -1 : 1) * (w / doors / 2 - 0.05), d / 2 + 0.004, 0.62);
    }
    k.box(top, w, d + 0.02, SLAB, 0, 0.01, WORKTOP - SLAB);
    const span = ([a, b]) => [(a + b) / 2 * w - w / 2, (b - a) * w];
    if (Array.isArray(p.hob)) { const [x, len] = span(p.hob); k.box(MATERIALS.screen, len, d * 0.78, 0.008, x, 0, WORKTOP); }
    if (Array.isArray(p.sink)) { const [x, len] = span(p.sink); k.box(MATERIALS.steel, len, d * 0.66, 0.008, x, 0, WORKTOP); k.cyl(MATERIALS.chrome, 0.012, 0.22, x, -d * 0.36, WORKTOP); }
    if (p.uppers) {
      const UP_FROM = 1.4, UP_HEIGHT = 0.7, UP_DEEP = 0.35, n = Math.max(1, typeof p.uppers === "number" ? p.uppers : doors);
      k.box(body, w, UP_DEEP, UP_HEIGHT, 0, -d / 2 + UP_DEEP / 2, UP_FROM, { bound: true });
      for (let i = 0; i < n; i++) k.box(shade(body, 0.94), w / n - 0.008, 0.016, UP_HEIGHT - 0.01, -w / 2 + (i + 0.5) * w / n, -d / 2 + UP_DEEP + 0.004, UP_FROM + 0.005, { bound: true });
      // the splashback, from the worktop up behind the wall units: it is what holds them to the wall for the eye
      k.box(colorOf(p.splash, shade(body, 1.04)), w, 0.012, UP_FROM + UP_HEIGHT - WORKTOP, 0, -d / 2 + 0.006, WORKTOP, { bound: true });
    }
    return k.parts;
  },

  // Something hung flat on a wall: a canvas, a frame, a mirror (`mirror: true`, `round: true`).
  art([w, d, h], p) {
    const k = kit(), frame = colorOf(p.frame, MATERIALS.black), inner = colorOf(p.color, MATERIALS.cream);
    if (p.round) { k.parts.push({ shape: "cyl", size: [w, w, d], at: [0, 0, w / 2], color: p.mirror ? MATERIALS.glass : inner, look: p.mirror ? "glass" : "solid", lie: true }); return k.parts; }
    if (p.frame !== false) k.box(frame, w, d, h);
    k.box(p.mirror ? MATERIALS.glass : inner, w - 0.05, d * 0.5, h - 0.05, 0, d * 0.4, 0.025, p.mirror ? { look: "glass" } : undefined);
    return k.parts;
  },

  // A dressmaker's dummy: a foot, a pole, a bust.
  mannequin([w, d, h], p) {
    const k = kit(), c = colorOf(p.color, MATERIALS.cream), r = Math.min(w, d) / 2;
    k.cyl(MATERIALS.charcoal, r * 0.8, 0.02); k.cyl(MATERIALS.charcoal, 0.015, h * 0.5, 0, 0, 0.02);
    k.cyl(c, r * 0.95, h * 0.14, 0, 0, h * 0.5); k.cyl(c, r * 0.72, h * 0.12, 0, 0, h * 0.64); k.cyl(c, r, h * 0.16, 0, 0, h * 0.76);
    k.cyl(c, r * 0.3, h * 0.06, 0, 0, h * 0.92); k.cyl(MATERIALS.charcoal, r * 0.2, 0.02, 0, 0, h * 0.98);
    return k.parts;
  },

  /* A household appliance. `style`: "fridge" (two doors and their handles), "washer"
     (a round door), "oven" (a hob on top, a glass door), "unit" (a grille: the outdoor
     unit of an air conditioner), or nothing for a plain case. */
  appliance([w, d, h], p) {
    const k = kit(), c = colorOf(p.color, p.style === "fridge" ? MATERIALS.steel : MATERIALS.white);
    k.box(c, w, d, h);
    if (p.style === "fridge") for (const sx of [-1, 1]) { k.box(c, w / 2 - 0.01, 0.015, h - 0.06, sx * w / 4, d / 2 + 0.008, 0.04); k.box(MATERIALS.charcoal, 0.015, 0.02, h * 0.3, sx * 0.04, d / 2 + 0.025, h * 0.45); }
    else if (p.style === "washer") k.parts.push({ shape: "cyl", size: [w * 0.6, w * 0.6, 0.03], at: [0, d / 2 + 0.015, h * 0.5], color: MATERIALS.charcoal, look: "solid", lie: true });
    else if (p.style === "oven") { k.box(MATERIALS.screen, w - 0.06, 0.012, h * 0.45, 0, d / 2 + 0.006, h * 0.12); k.box(MATERIALS.charcoal, w - 0.02, d - 0.02, 0.012, 0, 0, h); }
    else if (p.style === "unit") for (let i = 0; i < 6; i++) k.box(MATERIALS.grey, w - 0.1, 0.012, 0.012, 0, d / 2 + 0.006, h * (0.15 + i * 0.13));
    return k.parts;
  },
};
// types whose point is to be seen: they may rise above the cut of the walls
const TALL = new Set(["lamp", "screen", "wallShelves", "art", "mannequin", "plant", "curtain", "pc"]);
export const FURNITURE_TYPES = Object.keys(TYPES);

/* The parts of an item, in the item's frame, cut at the height the model shows. An
   unknown type is drawn as a plain volume: a plan written for a later version of the
   page still shows its furniture. */
export function furnitureParts(item) {
  const type = TYPES[item.type] ? item.type : "box", params = item.params || {};
  const built = TYPES[type](item.size, type === "box" ? { color: item.color || params.color } : params);
  const limit = (TALL.has(type) ? TALL_LIMIT : FLOOR_LIMIT) - (item.elevation || 0), out = [];
  for (const part of built) {
    // what is fixed to a wall is cut by the model, where that wall is cut for the view
    if (part.bound) { out.push(part); continue; }
    // a leaning part is as tall as its lean leaves it
    const h = part.lie ? part.size[0] : part.size[2] * Math.cos((part.tilt || 0) * Math.PI / 180), bottom = part.at[2] - h / 2, top = part.at[2] + h / 2;
    if (bottom >= limit) continue;
    if (top <= limit || part.lie || part.tilt) { out.push(part); continue; }
    out.push({ ...part, size: [part.size[0], part.size[1], limit - bottom], at: [part.at[0], part.at[1], (bottom + limit) / 2] });
  }
  return out;
}

/* Where a part stands on the plan: its center [x, y, z] and its angle in degrees, from
   the place and the rotation of its item. */
export function placePart(item, part) {
  const a = (item.rotation || 0) * Math.PI / 180, c = Math.cos(a), s = Math.sin(a);
  return {
    at: [item.position[0] + part.at[0] * c - part.at[1] * s, item.position[1] + part.at[0] * s + part.at[1] * c, (item.elevation || 0) + part.at[2]],
    angle: (item.rotation || 0) + (part.turn || 0),
  };
}
