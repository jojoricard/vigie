/* Line icons drawn for Vigie, in place of emoji: emoji render as cartoons and
   change look from one Windows version to the next. Strokes use currentColor, a
   few parts carry a functional color (sun amber, water sky, ice pale). */

const svg = (body, cls = "", box = 32) =>
  `<svg class="ico ${cls}" viewBox="0 0 ${box} ${box}" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;

/* ---- weather parts, 32 x 32 ---- */
const rays = (cx, cy, r1, r2, from = 0, to = 360) => {
  let d = "";
  for (let a = from; a < to; a += 45) {
    const t = (a * Math.PI) / 180;
    d += `M${(cx + r1 * Math.cos(t)).toFixed(1)} ${(cy + r1 * Math.sin(t)).toFixed(1)}L${(cx + r2 * Math.cos(t)).toFixed(1)} ${(cy + r2 * Math.sin(t)).toFixed(1)}`;
  }
  return `<path class="sun" d="${d}"/>`;
};
const SUN = `<circle class="sun" cx="16" cy="16" r="5.5"/>${rays(16, 16, 9, 12.5)}`;
const MOON = `<path class="moon" d="M22.5 19.6A8.5 8.5 0 1 1 13.9 7a6.8 6.8 0 0 0 8.6 12.6Z"/>`;
// Clouds are filled with the background color (--ico-bg): a cloud in front hides
// the sun or moon behind it, without cutting each stroke by hand.
const CLOUD_PATH = "M10.2 24.5h12.6a4.6 4.6 0 0 0 .5-9.2 6.6 6.6 0 0 0-12.6 1.5 3.9 3.9 0 0 0-.5 7.7Z";
const cloud = (transform = "") => `<path class="occ" ${transform ? `transform="${transform}"` : ""} vector-effect="non-scaling-stroke" d="${CLOUD_PATH}"/>`;
const CLOUD = cloud();
const CLOUD_UP = cloud("translate(0 -5)");
const CLOUD_SMALL = cloud("translate(11.5 10.5) scale(.62)");
// sun or moon behind a cloud (top left), and a bigger one with a small cloud
const SUN_BEHIND = `<circle class="sun" cx="12.2" cy="12" r="4.4"/>${rays(12.2, 12, 7.2, 9.6)}`;
const MOON_BEHIND = `<path class="moon" d="M16.2 13.4A5.8 5.8 0 1 1 10.4 5.6a4.6 4.6 0 0 0 5.8 7.8Z"/>`;
const SUN_BIG = `<circle class="sun" cx="13" cy="13" r="5"/>${rays(13, 13, 8.2, 11.2)}`;
const MOON_BIG = `<path class="moon" d="M19.6 16.4A7.6 7.6 0 1 1 11.6 6a6 6 0 0 0 8 10.4Z"/>`;
const RAIN = `<path class="wet" d="M11.5 23.5l-1.4 3.6M16.5 23.5l-1.4 3.6M21.5 23.5l-1.4 3.6"/>`;
const HEAVY = `<path class="wet" d="M10 23.5l-2 5M15 23.5l-2 5M20 23.5l-2 5M25 23.5l-2 5"/>`;
const DRIZZLE = `<g class="wet" fill="currentColor" stroke="none"><circle cx="11" cy="25" r="1"/><circle cx="16" cy="27.5" r="1"/><circle cx="21" cy="25" r="1"/></g>`;
const flake = (x, y) => `M${x} ${y - 2.3}v4.6M${x - 2} ${y - 1.15}l4 2.3M${x - 2} ${y + 1.15}l4-2.3`;
const SNOW = `<path class="ice" d="${flake(11, 26)}${flake(17, 28.5)}${flake(23, 26)}"/>`;
const SLEET = `<path class="wet" d="M11.5 23.5l-1.4 3.6M21.5 23.5l-1.4 3.6"/><path class="ice" d="${flake(16.5, 27)}"/>`;
const HAIL = `<path class="wet" d="M11.5 23.5l-1.4 3.6"/><g class="ice" fill="currentColor" stroke="none"><circle cx="17" cy="26" r="1.2"/><circle cx="22" cy="28" r="1.2"/></g>`;
const BOLT = `<path class="sun" d="M17.6 20l-3.4 5h3.6l-2.6 4.8"/>`;
const FOG = `<path d="M6 13.5h20M8.5 18.5h17M6 23.5h15"/>`;

const WMO_PARTS = (code, day) => {
  const behind = day ? SUN_BEHIND : MOON_BEHIND;
  if (code === 0) return day ? SUN : MOON;
  if (code === 1) return (day ? SUN_BIG : MOON_BIG) + CLOUD_SMALL;
  if (code === 2) return behind + CLOUD;
  if (code === 3) return CLOUD;
  if (code === 45 || code === 48) return FOG;
  if (code >= 51 && code <= 55) return CLOUD_UP + DRIZZLE;
  if (code === 56 || code === 57 || code === 66 || code === 67) return CLOUD_UP + SLEET;
  if (code === 61 || code === 63) return CLOUD_UP + RAIN;
  if (code === 65) return CLOUD_UP + HEAVY;
  if (code >= 71 && code <= 77) return CLOUD_UP + SNOW;
  if (code === 80 || code === 81) return `<g transform="translate(0 -4)">${behind}</g>` + CLOUD_UP + RAIN;
  if (code === 82) return CLOUD_UP + HEAVY;
  if (code === 85 || code === 86) return `<g transform="translate(0 -4)">${behind}</g>` + CLOUD_UP + SNOW;
  if (code === 95) return CLOUD_UP + BOLT;
  if (code === 96 || code === 99) return CLOUD_UP + BOLT + HAIL;
  return CLOUD;
};
export const weatherIcon = (code, day = 1, cls = "") => svg(WMO_PARTS(code, day), "wx " + cls);

/* Moon with its real phase: p in [0, 1), 0 = new, 0.5 = full. The lit part is a
   half disc plus or minus the terminator ellipse. */
export function moonIcon(p, cls = "") {
  const r = 9, cx = 16, cy = 16;
  const k = Math.cos(2 * Math.PI * p);          // terminator: 1 new, 0 quarter, -1 full
  const waxing = p < 0.5;
  const sweepOuter = waxing ? 1 : 0;           // lit side: right when waxing
  const rx = Math.abs(k) * r;
  const sweepInner = (k > 0) === waxing ? 0 : 1;
  const lit = `M${cx} ${cy - r}A${r} ${r} 0 0 ${sweepOuter} ${cx} ${cy + r}A${rx.toFixed(2)} ${r} 0 0 ${sweepInner} ${cx} ${cy - r}Z`;
  return svg(`<circle cx="${cx}" cy="${cy}" r="${r}" class="moonDark"/><path class="moonLit" d="${lit}"/>`, "moonPhase " + cls);
}

/* ---- interface icons, 24 x 24 ---- */
const UI = {
  alert: '<path d="M12 3.5 2.8 19.5h18.4Z"/><path d="M12 9.5v4.5M12 16.8v.1"/>',
  thermoUp: '<path d="M9.5 14.2V5a2.5 2.5 0 0 1 5 0v9.2a4.5 4.5 0 1 1-5 0Z"/><path class="warm" d="M12 16.5V9"/><path d="M18.5 5.5l2 -2 2 2M20.5 3.5v6"/>',
  thermoDown: '<path d="M9.5 14.2V5a2.5 2.5 0 0 1 5 0v9.2a4.5 4.5 0 1 1-5 0Z"/><path class="ice" d="M12 16.5V13"/><path d="M18.5 7.5l2 2 2-2M20.5 9.5v-6"/>',
  thermo: '<path d="M9.5 14.2V5a2.5 2.5 0 0 1 5 0v9.2a4.5 4.5 0 1 1-5 0Z"/><path class="warm" d="M12 16.5V10"/>',
  wind: '<path d="M3 8.5h11a3 3 0 1 0-3-3M3 12.5h16a3 3 0 1 1-3 3M3 16.5h8"/>',
  waves: '<path class="wet" d="M2.5 9c2.4 0 2.4-2 4.8-2s2.4 2 4.7 2 2.4-2 4.7-2 2.4 2 4.8 2M2.5 14c2.4 0 2.4-2 4.8-2s2.4 2 4.7 2 2.4-2 4.7-2 2.4 2 4.8 2M2.5 19c2.4 0 2.4-2 4.8-2s2.4 2 4.7 2 2.4-2 4.7-2 2.4 2 4.8 2"/>',
  mountain: '<path d="M2.5 20 9.5 7l4 7.4 2-3.4 6 9Z"/><path class="ice" d="M7.6 10.5 9.5 12l1.9-1.6"/>',
  flame: '<path class="warm" d="M12 21.5c-3.9 0-6.5-2.6-6.5-6.2 0-4.6 4.3-6.3 4.6-11.3 3.2 2 6.4 5.5 6.4 9.4.9-.9 1.3-2 1.4-3.1 1.1 1.3 1.6 3 1.6 5 0 3.6-3 6.2-7.5 6.2Z"/>',
  snowflake: '<path class="ice" d="M12 2.5v19M3.8 7.2l16.4 9.6M3.8 16.8l16.4-9.6M9.5 4l2.5 2 2.5-2M9.5 20l2.5-2 2.5 2"/>',
  drop: '<path class="wet" d="M12 3.2C9 7.6 6.5 10.6 6.5 14a5.5 5.5 0 0 0 11 0c0-3.4-2.5-6.4-5.5-10.8Z"/>',
  bolt: '<path class="warm" d="M13.5 2.5 5.5 13.5h5.5L9.8 21.5l8.7-11.5H13Z"/>',
  signal: '<path d="M2.5 12h4l2.5-6 4 12 2.5-6h6"/>',
  signalBroken: '<path d="M2.5 12h4l2.5-6 2 6"/><path d="M15 15.5l1.5-3.5h5"/><path class="alarm" d="M12.5 17.5l2-1.5"/>',
  disk: '<rect x="3" y="6.5" width="18" height="11" rx="2"/><path d="M6.5 12h6M17 12h.1"/>',
  chip: '<rect x="6" y="6" width="12" height="12" rx="1.8"/><path d="M9.5 2.5v3.5M14.5 2.5v3.5M9.5 18v3.5M14.5 18v3.5M2.5 9.5H6M2.5 14.5H6M18 9.5h3.5M18 14.5h3.5"/>',
  mouse: '<rect x="6.5" y="3" width="11" height="18" rx="5.5"/><path d="M12 6.5v3.5"/>',
  keyboard: '<rect x="2.5" y="6.5" width="19" height="11" rx="2"/><path d="M6 10h.1M9.3 10h.1M12.6 10h.1M15.9 10h.1M18.2 10h.1M7.5 14h9"/>',
  headset: '<path d="M4 15v-3a8 8 0 0 1 16 0v3"/><rect x="3" y="14" width="4.5" height="6.5" rx="1.6"/><rect x="16.5" y="14" width="4.5" height="6.5" rx="1.6"/>',
  gamepad: '<path d="M7.5 7.5h9a5 5 0 0 1 4.9 6l-.8 3.9a2.4 2.4 0 0 1-4.2 1L14.8 16H9.2l-1.6 2.4a2.4 2.4 0 0 1-4.2-1l-.8-3.9a5 5 0 0 1 4.9-6Z"/><path d="M7.8 10.5v3M6.3 12h3M15.5 11.2h.1M17.3 13h.1"/>',
  bluetooth: '<path d="m7 7.5 10 9-5 4.5V3l5 4.5-10 9"/>',
  bulb: '<path class="warm" d="M9 16.5c0-2-3-3.6-3-7.5a6 6 0 0 1 12 0c0 3.9-3 5.5-3 7.5Z"/><path d="M9.5 19.5h5M10.5 22h3"/>',
  strip: '<path d="M3 15.5c3-4 6.5-7 9-7s6 3 9 7"/><g class="warm" fill="currentColor" stroke="none"><circle cx="6" cy="12.2" r="1.1"/><circle cx="10" cy="9.4" r="1.1"/><circle cx="14" cy="9.4" r="1.1"/><circle cx="18" cy="12.2" r="1.1"/></g>',
  fan: '<circle cx="12" cy="12" r="1.8"/><path d="M12 10.2c-1-3.2.2-6.2 2.6-6.2 2.2 0 2.6 3.4-.9 6.2M13.6 12.9c3.3.7 5.4 3.2 4.2 5.2-1.1 1.9-4.2.6-4.9-3.8M10.4 12.9c-2.3 2.5-5.4 3-6.6 1-1.1-1.9 1.6-4 5.7-2.6"/>',
  autoMode: '<circle cx="12" cy="12" r="9"/><path d="M8.5 16 12 7.5 15.5 16M9.6 13.3h4.8"/>',
  umbrella: '<path d="M2.8 12a9.2 9.2 0 0 1 18.4 0Z"/><path d="M12 12v6.5a2 2 0 0 1-4 0"/>',
  pollen: '<path d="M12 21.5v-9M12 12.5c0-3-2.2-5.5-5-5.5 0 3 2.2 5.5 5 5.5ZM12 12.5c0-3 2.2-5.5 5-5.5 0 3-2.2 5.5-5 5.5ZM12 9c0-2.5-1-4.5-2.5-5.5M12 9c0-2.5 1-4.5 2.5-5.5"/>',
  arrow: '<path d="M12 20V4M6 10l6-6 6 6"/>',
  link: '<path d="M8 16 16 8M10 8h6v6"/>',
  code: '<path d="m8.5 7.5-5 4.5 5 4.5M15.5 7.5l5 4.5-5 4.5M13.5 4.5l-3 15"/>',
  play: '<path d="M8 5.5v13l10.5-6.5Z"/>',
  pause: '<path d="M9 5.5v13M15 5.5v13"/>',
  restart: '<path d="M19.5 12a7.5 7.5 0 1 1-2.2-5.3"/><path d="M19.5 4.5v4.2h-4.2"/>',
  download: '<path d="M12 4v11M7.5 10.5 12 15l4.5-4.5M5 19.5h14"/>',
  pump: '<path d="M5 20.5V5.5a2 2 0 0 1 2-2h5a2 2 0 0 1 2 2v15M3.5 20.5h12M7.5 8h4"/><path d="M14 10h1.5a1.5 1.5 0 0 1 1.5 1.5v5a1.5 1.5 0 0 0 3 0V8l-2.5-2.5"/>',
};
export const icon = (name, cls = "") => svg(UI[name], "ui " + cls, 24);

// MeteoAlarm warning types, sent as codes by the agent.
const ALERT_ICON = { thunderstorm: "bolt", heat: "thermoUp", cold: "thermoDown", rainFlood: "waves", rain: "drop", flood: "waves",
  wind: "wind", snowIce: "snowflake", fog: "waves", avalanche: "mountain", forestFire: "flame", coastal: "waves", warning: "alert" };
export const alertIcon = (type) => icon(ALERT_ICON[type] || "alert");

// "What changed" kinds, sent as codes by the agent.
const CHANGE_ICON = { latency: "signal", packetLoss: "signalBroken", thermal: "thermo", consumption: "bolt", diskDrop: "disk", incidents: "alert" };
export const changeIcon = (kind) => icon(CHANGE_ICON[kind] || "alert");

// Device guessed from its name: the battery APIs give no type.
export const deviceIcon = (n) => icon(/souris|mouse/i.test(n) ? "mouse" : /clavier|keyboard/i.test(n) ? "keyboard"
  : /casque|head|buds|audio/i.test(n) ? "headset" : /manette|controller|gamepad/i.test(n) ? "gamepad" : "bluetooth");

export const ICON_NAMES = Object.keys(UI);
