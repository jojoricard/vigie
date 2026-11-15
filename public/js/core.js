/* Shared state and helpers. */

export const $ = (id) => document.getElementById(id);

// localStorage can be blocked (private window, kiosk profile): the page works without it.
export const LS = {
  get(k, d) { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* nothing to keep */ } },
};

// Everything the cards share, including what the briefing reads.
export const state = {
  cfg: null,
  cities: [],
  sel: LS.get("vigie.city", 0),
  weather: [],
  air: null,
  energy: null,
  liveWatts: null,
  totalRamGb: null,
  alerts: [],
  pollenSummary: [],
  aqiSummary: null,
  nameDay: "",
  changes: [],
  crashCounts: null,
  lastCrash: null,
  holidays: null,
  network: null,
  house: null,
  home: null,            // what the house service knows that belongs to no room: presence, connection
  notices: [],           // the alerts in progress (alerts.js)
  sensors: null,
  devices: null,
  windows: null,
  fuel: null,
  curCode: 0,
  curIsDay: 1,
};

export const GIB = 1073741824, MIB = 1048576;
export const DAY_MS = 24 * 3600 * 1000;
export const COL = { warn: "#fce100", bad: "#ff6b6b", accent: "#b980ff" }; // state colors (gauges, thresholds)

/* Escaping before innerHTML: text from WMI, the Windows log or config.json that we
   didn't write ourselves. */
const ESC = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
export const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ESC[c]);

export const small = (u) => `<span class="unit">${u}</span>`;
export const readout = (k, v, s) => `<div class="readout"><div class="k">${k}</div><div class="v">${v}</div>${s ? `<div class="s">${s}</div>` : ""}</div>`;

/* Theme from config.json → theme: { color, accent }. Every surface derives from
   the color in CSS (OKLCH), the accent is derived too unless given. An invalid
   value is reported and ignored, the default theme stays. */
export function applyTheme(theme) {
  if (!theme) return;
  for (const [key, prop] of [["color", "--theme"], ["accent", "--accent"]]) {
    if (theme[key] == null) continue;
    if (CSS.supports("color", theme[key])) document.documentElement.style.setProperty(prop, theme[key]);
    else console.warn(`Vigie: config.json theme.${key} is not a color: ${theme[key]}`);
  }
}

// Resolved value of a color custom property, for the canvas drawings.
export function cssColor(name) {
  const probe = document.createElement("i");
  probe.style.color = `var(${name})`;
  document.body.appendChild(probe);
  const c = getComputedStyle(probe).color;
  probe.remove();
  return c;
}

/* A request that fails (agent stopped, source down) is expected and has its own
   error type. Callers catch only that one: anything else is a bug and propagates. */
export class FetchError extends Error {
  constructor(message, status = null) { super(message); this.status = status; }
}

// In demo mode the agent answers what the page would ask the outside world (lib/demo.js).
const local = (url) => state.cfg && state.cfg.demo && /^https?:/.test(String(url)) ? "/demo/ext?u=" + encodeURIComponent(String(url)) : url;

export async function getJson(url, opts) {
  let res;
  url = local(url);
  try { res = await fetch(url, opts); } catch (e) { throw new FetchError(`${url}: ${e.message}`); }
  if (!res.ok) throw new FetchError(`${url}: HTTP ${res.status}`, res.status);
  try { return await res.json(); } catch { throw new FetchError(`${url}: invalid JSON`, res.status); }
}

// getJson for cards that simply hide or show "unavailable" when the data is missing.
export async function load(url, opts) {
  try {
    return await getJson(url, opts);
  } catch (e) {
    if (!(e instanceof FetchError)) throw e;
    console.warn("Vigie:", e.message);
    return null;
  }
}

/* "22:30" to minutes, and whether a time of day falls in a span that may cross midnight
   (from 23:00 to 06:30). Without both ends there is no span. */
export const minutesOf = (hhmm) => { const [h, m] = String(hhmm).split(":").map(Number); return h * 60 + (m || 0); };
export function inSpan(minute, from, to) {
  if (!from || !to) return false;
  const a = minutesOf(from), b = minutesOf(to);
  return a > b ? minute >= a || minute < b : minute >= a && minute < b;
}
