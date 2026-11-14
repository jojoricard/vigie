/* House tab: one tile per device, all rooms in one grid, drawn from what the house
   service says each device can do (house/API.md). The page knows no brand.
   A tile says at a glance what is on: a lamp takes a tint and a band of its own color,
   a tap turns the device on or off. Everything else lives in the detail (the ⋯ button,
   or a long press): a side panel on a wide screen, a sheet from the bottom on a phone.
   A command is shown at once and taken back if the device refuses it.
   When the service has a floor plan, it is drawn above the tiles: the same devices,
   shown where they are (plan.js, plan3d.js). The tiles stay the main control, and the
   whole tab fits the screen: the plan keeps its half, the tiles tighten when many. */
import { $, state, esc, load, cssColor } from "./core.js";
import { moduleFor, placedDevices, planSvg } from "./plan.js";
import { solarPosition } from "./sun.js";
import { t, dec, nb, fmtDate, fmtTime } from "./i18n.js";
import { icon } from "./icons.js";

const API = "/api/v1";
let rooms = [];
let scenes = null, ambiances = [];     // from the config of the service: loaded once
let detailId = null;                   // the device whose detail is open
let pickerOpen = false;                // the free color picker of that detail
let inFlight = 0;                      // commands on their way: a poll must not undo what they show
const errors = new Map();              // device id -> why its last command failed
let sceneRun = null;                   // { id, phase: "running" | "done" | "failed" }

/* ---------- What a tile shows (no DOM here: tested) ---------- */
const clamp255 = (v) => Math.round(Math.min(255, Math.max(0, v)));
// Color of a white light from its temperature (Tanner Helland's approximation): the
// lamp gives kelvins, a tile needs a color.
export function kelvinToRgb(kelvin) {
  const k = kelvin / 100;
  const r = k <= 66 ? 255 : 329.698727446 * (k - 60) ** -0.1332047592;
  const g = k <= 66 ? 99.4708025861 * Math.log(k) - 161.1195681661 : 288.1221695283 * (k - 60) ** -0.0755148492;
  const b = k >= 66 ? 255 : k <= 19 ? 0 : 138.5177312231 * Math.log(k - 10) - 305.0447927307;
  return [clamp255(r), clamp255(g), clamp255(b)];
}

// The color of a lit lamp, for its tile and its marker on the plan. `dark` asks for
// dark text where that color is used as a fill.
export function lampFill(s) {
  if (!s.on) return null;
  const [r, g, b] = s.colorRgb != null ? [(s.colorRgb >> 16) & 255, (s.colorRgb >> 8) & 255, s.colorRgb & 255] : kelvinToRgb(s.colorTempK || 4000);
  const luminance = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
  return { color: `rgb(${r}, ${g}, ${b})`, dark: luminance > 0.55 };
}

/* What runs in a room, for its label on the plan: the reading of its own sensor (never
   the probe of an air conditioner), what heats or cools with its target, and how many
   lamps are lit. A device that does not answer counts for nothing. */
export function roomDigest(room) {
  const live = room.devices.filter((d) => d.state.reachable);
  return {
    temperature: room.temperature ?? null,
    climate: live.filter((d) => (d.type === "climate" || d.type === "heater") && d.state.on).map((d) => ({ type: d.type, mode: d.state.mode || null, setpoint: d.state.setpoint ?? null })),
    lights: live.filter((d) => d.type === "light" && d.state.on).length,
  };
}

/* How the tiles share the room left to them: `width` and `height` in pixels, `count`
   tiles. Small cards when there is room, rows otherwise, tighter rows when they are
   many: the plan never gives up its share. Within a look, the columns that fill the
   height best, without stretching a tile wider than it reads well. Returns the
   columns, the height of a row and the look, with `scroll` when even the tightest
   look does not fit. */
export const TILE_LOOKS = [
  { look: "tall", minWidth: 190, maxWidth: 340, minRow: 98, maxRow: 128 },
  { look: "flat", minWidth: 256, maxWidth: 420, minRow: 60, maxRow: 76 },
  { look: "dense", minWidth: 200, maxWidth: 360, minRow: 44, maxRow: 54 },
];
export function tileLayout(width, height, count, gap = 10) {
  const columnsFor = (w) => Math.max(1, Math.floor((width + gap) / (w + gap)));
  for (const { look, minWidth, maxWidth, minRow, maxRow } of TILE_LOOKS) {
    let best = null;
    for (let columns = Math.min(columnsFor(maxWidth) + 1, columnsFor(minWidth)); columns <= columnsFor(minWidth); columns++) {
      const rows = Math.ceil(count / columns) || 1, row = Math.min(maxRow, Math.floor((height - gap * (rows - 1)) / rows));
      if (row >= minRow && (!best || rows * row > best.rows * best.row)) best = { look, columns, rows, row, scroll: false };
    }
    if (best) return best;
  }
  const last = TILE_LOOKS[TILE_LOOKS.length - 1], columns = columnsFor(last.minWidth);
  return { look: last.look, columns, rows: Math.ceil(count / columns) || 1, row: last.minRow, scroll: true };
}

/* ---------- Data ---------- */
const findDevice = (id) => rooms.flatMap((r) => r.devices).find((d) => d.id === id);
const roomOf = (d) => rooms.find((r) => r.id === d.room);
const heats = (d) => d.type === "climate" || d.type === "heater";
// What makes a tile and a marker stand out: a lamp that is on, a blind that is up, a
// cycle that runs, a boost. A water heater is always on, which says nothing.
const active = (d) => d.type === "cover" ? d.state.position > 0 : d.type === "washer" ? d.state.run === "running" || d.state.run === "paused"
  : d.type === "water" ? !!d.state.boost : !!d.state.on;
// "1 h 05", "40 min"
const duration = (min) => min == null ? "" : min >= 60 ? t("house.hours", Math.floor(min / 60), String(min % 60).padStart(2, "0")) : t("house.minutes", min);
// A washer that has finished and waits to be emptied: what the overview and the briefing tell.
export const cyclesDone = (list) => (list || []).flatMap((room) => room.devices.filter((d) => d.type === "washer" && d.state.reachable && d.state.run === "done").map((d) => ({ name: d.name, room: room.name })));

export async function refreshHouse() {
  wire();
  const r = await load(`${API}/rooms`);
  // an answer older than a command still on its way would bring the old state back
  if (r && !inFlight) { rooms = r; state.house = { rooms }; }
  // a finished cycle is told on the overview, with the warnings, until the machine is emptied
  const done = cyclesDone(rooms);
  $("houseAlerts").hidden = !done.length;
  $("houseAlerts").innerHTML = done.map((c) => `<span class="pill note">${icon("washer")}${t("house.cycleDone", esc(c.name))}</span>`).join("");
  if (r && !scenes) [scenes, ambiances] = await Promise.all([load(`${API}/scenes`), load(`${API}/ambiances`)]).then((l) => l.map((x) => x || []));
  // asked once: the service answers 404 when it has no plan, and the card stays hidden
  if (r && plan === undefined) plan = (await load(`${API}/plan`)) || null;
  render();
}

/* A command shows at once. If the service or the device refuses it, the state it
   replaced comes back and the reason is written on the tile. */
async function command(id, changes, before) {
  const d = findDevice(id);
  const previous = before || { ...d.state };
  const shown = { ...changes };
  if (changes.ambiance) {
    const a = ambiances.find((x) => x.id === changes.ambiance);
    delete shown.ambiance;
    Object.assign(shown, { on: true }, a && { brightness: a.brightness, colorRgb: a.colorRgb, colorTempK: a.colorTempK });
  }
  // a program change carries only what changes: the rest of the program stays shown
  if (shown.schedule) shown.schedule = { ...d.state.schedule, ...shown.schedule };
  // a color and a color temperature exclude each other
  if (shown.colorRgb != null) shown.colorTempK = null;
  else if (shown.colorTempK != null) shown.colorRgb = null;
  Object.assign(d.state, Object.fromEntries(Object.entries(shown).filter(([, v]) => v !== undefined)));
  errors.delete(id);
  inFlight++;
  render();
  let res = null;
  try {
    res = await fetch(`${API}/devices/${encodeURIComponent(id)}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(changes) });
  } catch {
    // fetch only throws when the agent can't be reached
  }
  const j = res ? await res.json().catch(() => ({})) : {};
  inFlight--;
  if (!res || !res.ok) {
    d.state = previous;
    errors.set(id, res ? j.error || t("failed") : t("requestFailed"));
  } else Object.assign(d, j);
  render();
}

// Heating that starts costs money: turning it on asks first. Turning off never does.
async function togglePower(id) {
  const d = findDevice(id);
  if (!d.state.reachable || !d.capabilities.on) return;
  if (heats(d) && !d.state.on && !(await askConfirm(t("confirm.turnOn", `${d.name} (${roomOf(d).name})`)))) return;
  command(id, { on: !d.state.on });
}

// Several taps on − or + make one command: the figure follows the finger, the device
// gets the last value.
const stepping = new Map();   // device id -> { timer, before }
function step(id, direction) {
  const d = findDevice(id), c = d.capabilities.setpoint;
  const pendingStep = stepping.get(id) || { before: { ...d.state } };
  clearTimeout(pendingStep.timer);
  // from a mode without a target (dry, fan) the stepper starts at the bottom of the range
  const next = Math.min(c.max, Math.max(c.min, Math.round(((d.state.setpoint ?? c.min) + direction * c.step) / c.step) * c.step));
  d.state.setpoint = next;
  pendingStep.timer = setTimeout(() => { stepping.delete(id); command(id, { setpoint: next }, pendingStep.before); }, 600);
  stepping.set(id, pendingStep);
  render();
}

async function runScene(id) {
  if (sceneRun && sceneRun.phase === "running") return;
  sceneRun = { id, phase: "running" };
  render();
  let res = null;
  try {
    res = await fetch(`${API}/scenes/${encodeURIComponent(id)}`, { method: "POST" });
  } catch {
    // agent unreachable: shown as a failed scene
  }
  const j = res && res.ok ? await res.json().catch(() => null) : null;
  // each device that did not follow says so on its own tile
  for (const r of (j && j.results) || []) if (!r.ok) errors.set(r.device, r.error || t("failed"));
  sceneRun = { id, phase: j && j.ok ? "done" : "failed" };
  await refreshHouse();
  setTimeout(() => { if (sceneRun && sceneRun.id === id && sceneRun.phase !== "running") { sceneRun = null; render(); } }, 2500);
}

/* ---------- Drawing ---------- */
const MODE_ICON = { auto: "autoMode", dry: "drop", cool: "snowflake", heat: "flame", fan: "fan" };
function deviceIcon(d) {
  if (d.type === "light") return icon(/bandeau|ruban|strip|led/i.test(d.name) ? "strip" : "bulb");
  if (d.type === "climate") return icon(MODE_ICON[d.state.mode] || "snowflake");
  if (d.type === "cover") return icon("blind");
  if (d.type === "water") return icon("shower");
  if (d.type === "tv") return icon("tv");
  if (d.type === "washer") return icon("washer");
  return icon(d.type === "heater" ? "flame" : "thermo");
}
// A scene has a name and nothing else: its icon is guessed from it.
const sceneIcon = (s) => icon(/pars|part|leave|leaving|away|depart|sortie/i.test(s.id + s.name) ? "door"
  : /nuit|night|dodo|sleep/i.test(s.id + s.name) ? "moon" : /soir|evening|film|cin/i.test(s.id + s.name) ? "sofa" : "sparkle");
const degrees = (v) => v != null ? `${dec(v, 1)}°` : "–";

// The two lines under the name: the figure that matters, then the state in words.
function tileText(d) {
  const s = d.state;
  if (d.type === "light") return [s.on && s.brightness != null ? `${s.brightness} %` : "", s.on ? t("house.lightOn") : t("house.lightOff")];
  if (d.type === "sensor") return [degrees(s.temperature), ""];
  if (d.type === "cover") return [s.position != null ? `${s.position} %` : "", s.position > 0 ? t("house.open") : t("house.closed")];
  if (d.type === "water") return [s.showersLeft != null ? String(s.showersLeft) : s.temperature != null ? degrees(s.temperature) : "", [s.away ? t("house.away") : s.mode ? t(`opt.mode.${s.mode}`) : "", s.boost ? t("cap.boost") : "", s.showersLeft != null ? t("house.showersLeft", s.showersLeft) : ""].filter(Boolean).join(" · ")];
  if (d.type === "tv") return ["", s.on ? s.appName || t("house.isOn") : t("house.isOff")];
  if (d.type === "washer") return [s.run === "running" || s.run === "paused" ? duration(s.remainingMin) : "", washerWords(s)];
  return [degrees(s.setpoint), s.on ? (s.mode ? t(`opt.mode.${s.mode}`) : t("house.running")) : t("house.stopped")];
}

// "Rinsing", "Done", "Off": the step of the cycle when the machine names one we know.
const PHASES = ["detecting", "running", "rinsing", "spinning", "drying", "soaking", "prewash", "cooling"];
function washerWords(s) {
  if (s.run === "running") return PHASES.includes(s.phase) ? t(`washer.phase.${s.phase}`) : t("washer.run.running");
  return s.run ? t(`washer.run.${s.run}`) : "";
}

function tileHtml(d) {
  const s = d.state, id = esc(d.id), room = esc(roomOf(d).name);
  const error = errors.get(d.id);
  if (!s.reachable) {
    // a lamp silent on the LAN gets the two usual reasons, anything else its technical message as a tooltip
    const why = s.error === "lanSilent" ? t("house.lanSilent") : t("unreachable");
    return `<div class="tile gone" data-device="${id}" data-room="${esc(d.room)}" title="${esc(s.error || "")}"><span class="tileIcon">${deviceIcon(d)}</span>
      <span class="tileText"><span class="tileName">${esc(d.name)}</span><span class="tileState">${room} · ${why}</span></span></div>`;
  }
  const fill = d.type === "light" ? lampFill(s) : null;
  const [main, words] = tileText(d);
  const canToggle = !!d.capabilities.on;
  const on = active(d);
  const cls = ["tile", d.type, on ? "on" : canToggle || ["cover", "washer", "water"].includes(d.type) ? "off" : "", fill ? "lit" : "", error ? "failed" : ""].filter(Boolean).join(" ");
  const mode = d.type === "climate" && s.on && s.mode ? ` data-mode="${esc(s.mode)}"` : "";
  return `<div class="${cls}" data-tile="${id}" data-device="${id}" data-room="${esc(d.room)}"${mode}${canToggle ? ` role="button" tabindex="0" aria-pressed="${!!s.on}"` : ""}${fill ? ` style="--lamp:${fill.color}"` : ""}>
    <span class="tileIcon">${deviceIcon(d)}</span>
    <span class="tileText"><span class="tileName">${esc(d.name)}</span>
      <span class="tileState">${error ? `<b>${esc(error)}</b>` : [room, words].filter(Boolean).join(" · ")}</span></span>
    <span class="tileMain num">${main}</span>
    ${s.via === "cloud" ? `<span class="tileCloud" title="${t("house.viaCloud")}">${icon("cloud")}</span>` : ""}
    ${Object.keys(d.capabilities).length ? `<button type="button" class="tileMore" data-more="${id}" aria-label="${t("house.details", esc(d.name))}">${icon("dots")}</button>` : ""}
  </div>`;
}

function sceneBar() {
  return (scenes || []).map((s) => {
    const phase = sceneRun && sceneRun.id === s.id ? sceneRun.phase : "";
    const mark = phase === "done" ? icon("check") : phase === "failed" ? icon("alert") : sceneIcon(s);
    const note = phase ? `<small>${t("scene." + phase)}</small>` : "";
    return `<button type="button" class="sceneBtn ${phase}" data-scene="${esc(s.id)}"${phase === "running" ? " disabled" : ""}>${mark}<span>${esc(s.name)}${note}</span></button>`;
  }).join("");
}

/* ---------- Detail ---------- */
const QUICK = [0xffffff, 0xff3b30, 0xff9500, 0x34c759, 0x0a84ff, 0xaf52de];
const hex = (v) => "#" + v.toString(16).padStart(6, "0");
const switchHtml = (label, on, attrs) => `<div class="switchRow"><span>${label}</span>
  <button type="button" class="switch${on ? " on" : ""}" role="switch" aria-checked="${!!on}" aria-label="${label}" ${attrs}><i></i></button></div>`;
const field = (label, body) => `<div class="field"><div class="fieldLabel">${label}</div>${body}</div>`;
const slider = (d, cap, label, value) => {
  const c = d.capabilities[cap];
  return `<label class="slider"><span>${label}</span>
    <input type="range" data-range="${cap}" min="${c.min}" max="${c.max}" step="${c.step}" value="${d.state[cap] ?? c.min}">
    <span class="val num">${value}</span></label>`;
};

function hsvToRgb(h, s, v) {
  const c = v * s, x = c * (1 - Math.abs((h / 60) % 2 - 1)), m = v - c;
  const [r0, g0, b0] = [[c, x, 0], [x, c, 0], [0, c, x], [0, x, c], [x, 0, c], [c, 0, x]][Math.floor(h / 60) % 6];
  return [Math.round((r0 + m) * 255), Math.round((g0 + m) * 255), Math.round((b0 + m) * 255)];
}
function rgbToHsv(r, g, b) {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b), d = max - Math.min(r, g, b);
  let h = 0;
  if (d) h = max === r ? 60 * (((g - b) / d) % 6) : max === g ? 60 * ((b - r) / d + 2) : 60 * ((r - g) / d + 4);
  return [h < 0 ? h + 360 : h, max ? d / max : 0, max];
}

/* Every control stays live on a device that is off: a mode, a target or a fan speed
   can be set before turning it on. Nothing is greyed here, a refusal of the device
   comes back as an error. */
function detailHtml(d) {
  const s = d.state, caps = d.capabilities;
  const error = errors.get(d.id);
  const out = [];
  if (caps.on) out.push(switchHtml(d.type === "light" ? (s.on ? t("house.lightOn") : t("house.lightOff")) : s.on ? t("house.isOn") : t("house.isOff"), s.on, "data-power"));
  if (caps.setpoint) {
    out.push(`<div class="bigStep"><button type="button" data-step="-1" aria-label="${t("house.cooler")}">−</button>
      <span class="v num">${degrees(s.setpoint)}</span>
      <button type="button" data-step="1" aria-label="${t("house.warmer")}">+</button></div>`);
  }
  for (const cap of ["mode", "fan", "swing"]) {
    if (!caps[cap]) continue;
    out.push(field(t("field." + cap), `<div class="segmented">${caps[cap].options.map((v) =>
      `<button type="button" class="${v === s[cap] ? "on" : ""}" data-set="${cap}" data-value="${esc(v)}">${t(`opt.${cap}.${v}`)}</button>`).join("")}</div>`));
  }
  // what a television offers has the names it gives: its inputs, its applications
  for (const cap of ["source", "app"]) {
    if (!caps[cap]) continue;
    out.push(field(t("field." + cap), `<div class="chips">${caps[cap].options.map((v) =>
      `<button type="button" class="chip${v === s[cap] ? " on" : ""}" data-set="${cap}" data-value="${esc(v)}">${esc((caps[cap].labels || {})[v] || v)}</button>`).join("")}</div>`));
  }
  if (caps.volume) out.push(slider(d, "volume", t("slider.volume"), s.volume ?? "–"));
  if (caps.showers) out.push(slider(d, "showers", t("slider.showers"), s.showers ?? "–"));
  if (caps.away) out.push(awayHtml(s));
  if (caps.start) out.push(`<button type="button" class="bigAction" data-action="start">${icon("play")}<span>${t("house.start")}</span></button>`);
  if (caps.colorRgb) {
    const names = t("house.colors");
    out.push(field(t("field.color"), `<div class="swatchRow">${QUICK.map((v, i) =>
      `<button type="button" class="swatch${s.colorRgb === v ? " on" : ""}" style="background:${hex(v)}" data-color="${v}" title="${names[i]}" aria-label="${names[i]}"></button>`).join("")}
      <button type="button" class="swatch more${pickerOpen ? " on" : ""}" data-picker title="${t("moreColors")}" aria-label="${t("moreColors")}"></button></div>
      ${pickerOpen ? `<div class="picker"><div class="svBox"><div class="svDot"></div></div><input type="range" class="hueSlider" min="0" max="359" aria-label="${t("moreColors")}"></div>` : ""}`));
  }
  if (d.type === "light" && ambiances.length) {
    out.push(field(t("house.ambiance"), `<div class="chips">${ambiances.map((a) => `<button type="button" class="chip" data-ambiance="${esc(a.id)}">${esc(a.name)}</button>`).join("")}</div>`));
  }
  if (caps.brightness) out.push(slider(d, "brightness", t("slider.brightness"), `${s.brightness ?? "–"} %`));
  if (caps.colorTempK) out.push(slider(d, "colorTempK", t("slider.colorTemp"), s.colorTempK ? `${nb(s.colorTempK)} K` : "–"));
  if (caps.position) out.push(slider(d, "position", t("slider.position"), `${s.position ?? "–"} %`));
  for (const [cap, c] of Object.entries(caps)) {
    if (c.type === "boolean" && cap !== "on") out.push(switchHtml(t("cap." + cap), s[cap], `data-toggle="${cap}"`));
  }
  if (s.schedule && s.schedule.days) out.push(programHtml(d));
  // What the device reports and nobody sets. The probe of an air conditioner is named
  // as such: it reads several degrees above the room.
  const facts = [
    d.type === "water" && s.hotWater != null ? t("house.hotWater", Math.round(s.hotWater)) : null,
    d.type === "water" && s.temperature != null ? t("house.waterTemp", dec(s.temperature, 0)) : null,
    s.energyKwh != null ? t("house.energyTotal", nb(Math.round(s.energyKwh))) : null,
    d.type === "washer" ? washerWords(s) : null,
    d.type === "washer" && s.remainingMin != null ? t("house.remaining", duration(s.remainingMin)) : null,
    d.type === "washer" && s.endsAt ? t("house.endsAt", fmtTime(new Date(s.endsAt))) : null,
    d.type === "washer" && s.run !== "off" && !caps.start ? t("house.noRemoteStart") : null,
    d.type === "tv" && s.appName ? esc(s.appName) : null,
    s.probeTemp != null ? t("house.probe", dec(s.probeTemp, 1)) : null,
    d.type === "heater" && s.temperature != null ? `${dec(s.temperature, 1)}°` : null,
    s.outdoorTemp != null ? t("house.outdoorUnit", dec(s.outdoorTemp, 1)) : null,
    s.energy ? t("house.energyToday", dec(s.energy.today, 1)) : null,
    s.energy ? t("house.energyWeek", dec(s.energy.week, 1)) : null,
    s.timer && s.timer.enabled ? t("house.timerOn") : null,
    s.schedule && s.schedule.enabled && !s.schedule.days ? t("house.scheduleOn") : null,
    s.via === "cloud" ? t("house.viaCloud") : null,
  ].filter(Boolean);
  return `<div class="detailHead"><span class="detailName">${deviceIcon(d)}<span>${esc(d.name)}<small>${esc(roomOf(d).name)}</small></span></span>
      <button type="button" class="detailClose" data-close aria-label="${t("house.close")}">${icon("close")}</button></div>
    ${error ? `<div class="detailError">${esc(error)}</div>` : ""}
    ${out.join("")}
    ${facts.length ? `<div class="detailFacts">${facts.map((x) => `<span>${x}</span>`).join("")}</div>` : ""}`;
}

/* ---------- Absence ----------
   A water heater that is told when the home is empty stops heating for nothing and is
   warm again for the return. Two days: the one of the departure, the one of the return. */
let awayDraft = null;   // { from, to } as the two fields hold them, while they are being filled
const dayOf = (iso) => { const d = new Date(iso); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; };
function awayHtml(s) {
  const today = dayOf(Date.now()), draft = awayDraft || (s.away ? { from: dayOf(s.away.from), to: dayOf(s.away.to) } : { from: today, to: "" });
  const now = s.away ? `<p class="awayNow">${s.away.pending ? t("house.awayFrom", fmtDate(s.away.from, { weekday: "short", day: "numeric", month: "short" })) + " · " : ""}${t("house.awayUntil", fmtDate(s.away.to, { weekday: "short", day: "numeric", month: "short" }))}</p>` : "";
  return field(t("house.away"), `${now}<div class="awayRow">
      <label><span>${t("house.leaving")}</span><input type="date" data-away="from" min="${today}" value="${esc(draft.from)}"></label>
      <label><span>${t("house.back")}</span><input type="date" data-away="to" min="${esc(draft.from || today)}" value="${esc(draft.to)}"></label>
    </div><div class="awayRow">
      <button type="button" class="chip" data-away-set ${draft.from && draft.to && draft.to > draft.from ? "" : "disabled"}>${t("house.awaySet")}</button>
      ${s.away ? `<button type="button" class="chip" data-away-end>${t("house.awayEnd")}</button>` : ""}</div>`);
}
// the day of the departure starts now when it is today, and the return is the morning of its day
function awayPeriod(draft) {
  const start = new Date(`${draft.from}T00:00:00`), back = new Date(`${draft.to}T00:00:00`);
  return { from: new Date(Math.max(start.getTime(), Date.now())).toISOString(), to: back.toISOString() };
}

/* ---------- Weekly program ----------
   The program stored in an air conditioner, one line per day, one block per entry. It
   is edited on a draft kept here and written to the unit in one go: the unit holds the
   program and runs it with the PC off, so each save is a few slow requests. */
const WEEK = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];
const dayName = (i, weekday = "short") => fmtDate(new Date(2024, 0, 1 + i), { weekday });   // the first of January 2024 was a Monday
const byTime = (a, b) => String(a.time).localeCompare(String(b.time));
let draft = null;   // { id, days, open: { day, i } | null, copy: { from, to: [] } | null, error }

// Two entries of one day at the same time: the unit could only keep one.
export const clashes = (days) => WEEK.filter((day) => new Set((days[day] || []).map((e) => e.time)).size < (days[day] || []).length);
// The entry a new block starts as: an hour after the last one of the day, turning the unit off.
export function nextEntry(list) {
  const taken = new Set(list.map((e) => e.time));
  const last = list.reduce((m, e) => Math.max(m, e.time ? Number(e.time.slice(0, 2)) * 60 + Number(e.time.slice(3)) : 0), list.length ? 0 : 6 * 60);
  // past midnight the day is over: the new block starts at noon rather than at half past twelve at night
  for (let minute = last + 60 < 1440 ? last + 60 : 720, n = 0; n < 1440; minute = (minute + 30) % 1440, n++) {
    const time = `${String(Math.floor(minute / 60)).padStart(2, "0")}:${String(minute % 60).padStart(2, "0")}`;
    if (!taken.has(time)) return { time, enabled: true, on: false, mode: null, setpoint: null, fan: null };
  }
  return null;
}

function programHtml(d) {
  const schedule = d.state.schedule, cap = d.capabilities.schedule, editing = draft && draft.id === d.id;
  const days = editing ? draft.days : schedule.days;
  const block = (e, day, i) => {
    const open = editing && draft.open && draft.open.day === day && draft.open.i === i;
    const body = `<b class="num">${esc(e.time || "?")}</b>${e.on ? `${icon(MODE_ICON[e.mode] || "snowflake")}<span class="num">${e.setpoint != null ? degrees(e.setpoint) : ""}</span>` : `<span>${t("house.stopped")}</span>`}`;
    const cls = `progBlock${e.enabled ? "" : " skipped"}${e.on ? "" : " off"}${open ? " open" : ""}`, mode = e.on && e.mode ? ` data-mode="${esc(e.mode)}"` : "";
    return editing ? `<button type="button" class="${cls}"${mode} data-prog="open" data-day="${day}" data-i="${i}">${body}</button>` : `<span class="${cls}"${mode}>${body}</span>`;
  };
  const rows = WEEK.map((day, i) => {
    const list = days[day] || [];
    const tools = !editing ? "" : `<span class="progTools">
        ${cap && list.length < cap.perDay ? `<button type="button" data-prog="add" data-day="${day}" aria-label="${t("house.programAdd", dayName(i, "long"))}">${icon("plus")}</button>` : ""}
        ${list.length ? `<button type="button" data-prog="copy" data-day="${day}" aria-label="${t("house.programCopyTo", dayName(i, "long"))}">${icon("copy")}</button>` : ""}</span>`;
    return `<div class="progDay"><span class="progName">${dayName(i)}</span><div class="progBlocks">${list.map((e, n) => block(e, day, n)).join("")}</div>${tools}</div>`;
  }).join("");
  const title = `${t("house.program")}${schedule.name ? ` · ${esc(schedule.name)}` : ""}`;
  const head = cap ? switchHtml(title, schedule.enabled, 'data-prog="toggle"') : `<div class="fieldLabel">${title} · ${schedule.enabled ? t("house.programOn") : t("house.programOff")}</div>`;
  let foot = "";
  if (editing) {
    foot = `${draft.open ? entryEditor(d) : draft.copy ? copyEditor() : ""}
      ${draft.error ? `<div class="detailError">${esc(draft.error)}</div>` : ""}
      <div class="progActions"><button type="button" class="chip" data-prog="cancel">${t("confirm.cancel")}</button>
        <button type="button" class="chip strong" data-prog="save">${t("house.programSave")}</button></div>`;
  } else if (cap) foot = `<div class="progActions"><button type="button" class="chip" data-prog="edit">${t("house.programEdit")}</button></div>`;
  return `<div class="field">${head}<div class="program${schedule.enabled ? "" : " idle"}">${rows}</div>${foot}</div>`;
}

// The entry being edited: when, on or off, and for "on" the mode, the target and the fan.
function entryEditor(d) {
  const e = draft.days[draft.open.day][draft.open.i], caps = d.capabilities;
  const seg = (name, options, current, label) => `<div class="segmented">${options.map((v) =>
    `<button type="button" class="${v === current ? "on" : ""}" data-prog="${name}" data-value="${esc(v)}">${label(v)}</button>`).join("")}</div>`;
  const target = e.on && (e.mode === "heat" || e.mode === "cool");
  return `<div class="progEdit">
      <div class="progEditRow"><input type="time" data-prog-time value="${esc(e.time || "")}" aria-label="${t("house.programTime")}">
        ${seg("power", ["on", "off"], e.on ? "on" : "off", (v) => v === "on" ? t("house.turnsOn") : t("house.turnsOff"))}</div>
      ${e.on ? seg("mode", caps.schedule.modes, e.mode, (v) => t(`opt.mode.${v}`)) : ""}
      ${target ? `<div class="progEditRow"><div class="miniStep"><button type="button" data-prog="step" data-value="-1" aria-label="${t("house.cooler")}">−</button>
          <span class="num">${degrees(e.setpoint)}</span><button type="button" data-prog="step" data-value="1" aria-label="${t("house.warmer")}">+</button></div></div>` : ""}
      ${target && caps.fan ? seg("fan", caps.fan.options, e.fan || "auto", (v) => t(`opt.fan.${v}`)) : ""}
      <div class="progActions"><button type="button" class="chip" data-prog="delete">${t("house.programDelete")}</button>
        <button type="button" class="chip" data-prog="close">${t("confirm.ok")}</button></div></div>`;
}

function copyEditor() {
  const from = WEEK.indexOf(draft.copy.from);
  return `<div class="progEdit"><div class="fieldLabel">${t("house.programCopyTo", dayName(from, "long"))}</div>
      <div class="chips">${WEEK.map((day, i) => day === draft.copy.from ? "" :
        `<button type="button" class="chip${draft.copy.to.includes(day) ? " on" : ""}" data-prog="copyDay" data-day="${day}">${dayName(i)}</button>`).join("")}</div>
      <div class="progActions"><button type="button" class="chip" data-prog="copyCancel">${t("confirm.cancel")}</button>
        <button type="button" class="chip strong" data-prog="copyDo">${t("house.programCopy")}</button></div></div>`;
}

async function programAction(data, value) {
  const d = findDevice(detailId), caps = d.capabilities, act = data.prog;
  if (act === "toggle") return command(d.id, { schedule: { enabled: !d.state.schedule.enabled } });
  if (act === "edit") { draft = { id: d.id, days: structuredClone(d.state.schedule.days), open: null, copy: null, error: "" }; return render(); }
  if (!draft || draft.id !== d.id) return;
  const list = draft.days[data.day || (draft.open && draft.open.day)], cur = draft.open ? draft.days[draft.open.day][draft.open.i] : null;
  const settle = () => { if (draft.open) draft.days[draft.open.day].sort(byTime); draft.open = null; };
  draft.error = "";
  if (act === "open") { settle(); draft.copy = null; draft.open = { day: data.day, i: draft.days[data.day].indexOf(list[Number(data.i)]) }; }
  else if (act === "add") { settle(); const e = nextEntry(list); if (e) { list.push(e); draft.copy = null; draft.open = { day: data.day, i: list.length - 1 }; } }
  else if (act === "time" && cur) cur.time = value;
  else if (act === "power" && cur) {
    cur.on = data.value === "on";
    if (!cur.on) Object.assign(cur, { mode: null, setpoint: null, fan: null });
    // a block that starts the unit begins as the unit is set now
    else Object.assign(cur, { mode: caps.schedule.modes.includes(d.state.mode) ? d.state.mode : "heat", setpoint: d.state.setpoint ?? 20, fan: "auto" });
  } else if (act === "mode" && cur) {
    cur.mode = data.value;
    const target = cur.mode === "heat" || cur.mode === "cool";
    Object.assign(cur, { setpoint: target ? cur.setpoint ?? d.state.setpoint ?? 20 : null, fan: target ? cur.fan || "auto" : null });
  } else if (act === "step" && cur) cur.setpoint = Math.min(caps.setpoint.max, Math.max(caps.setpoint.min, cur.setpoint + Number(data.value) * 0.5));
  else if (act === "fan" && cur) cur.fan = data.value;
  else if (act === "delete" && cur) { list.splice(draft.open.i, 1); draft.open = null; }
  else if (act === "close") settle();
  else if (act === "copy") { settle(); draft.copy = { from: data.day, to: [] }; }
  else if (act === "copyDay") draft.copy.to = draft.copy.to.includes(data.day) ? draft.copy.to.filter((x) => x !== data.day) : [...draft.copy.to, data.day];
  else if (act === "copyCancel") draft.copy = null;
  else if (act === "copyDo") { for (const day of draft.copy.to) draft.days[day] = structuredClone(draft.days[draft.copy.from]); draft.copy = null; }
  else if (act === "cancel") draft = null;
  else if (act === "save") {
    settle();
    if (clashes(draft.days).length) draft.error = t("house.programSameTime");
    else {
      // the draft comes back if the unit refuses, so nothing typed is lost
      const kept = draft;
      draft = null;
      await command(d.id, { schedule: { days: kept.days } });
      if (errors.has(d.id) && detailId === d.id) draft = kept;
    }
  }
  render();
}

// The free picker: saturation/value square and hue slider. The color is sent on
// release, never while dragging: one command per color is enough for the lamp.
function wirePicker(panel, d) {
  const svBox = panel.querySelector(".svBox"), dot = panel.querySelector(".svDot"), hueEl = panel.querySelector(".hueSlider");
  const cur = d.state.colorRgb ?? 0xffffff;
  let [hue, s0, v0] = rgbToHsv((cur >> 16) & 255, (cur >> 8) & 255, cur & 255);
  hueEl.value = Math.round(hue);
  const paintHue = () => { svBox.style.backgroundColor = `hsl(${hue}, 100%, 50%)`; };
  const placeDot = (s, v) => { dot.style.left = s * 100 + "%"; dot.style.top = (1 - v) * 100 + "%"; };
  paintHue(); placeDot(s0, v0);
  const pickAt = (x, y) => {
    const box = svBox.getBoundingClientRect();
    const s = Math.min(1, Math.max(0, (x - box.left) / box.width));
    const v = Math.min(1, Math.max(0, 1 - (y - box.top) / box.height));
    placeDot(s, v);
    return [s, v];
  };
  const sendColor = (s, v) => {
    const [rr, gg, bb] = hsvToRgb(hue, s, v);
    command(d.id, { colorRgb: (rr << 16) | (gg << 8) | bb });
  };
  let dragging = false;
  svBox.onpointerdown = (e) => { dragging = true; svBox.setPointerCapture(e.pointerId); pickAt(e.clientX, e.clientY); };
  svBox.onpointermove = (e) => { if (dragging) pickAt(e.clientX, e.clientY); };
  svBox.onpointerup = (e) => { if (!dragging) return; dragging = false; sendColor(...pickAt(e.clientX, e.clientY)); };
  hueEl.oninput = () => { hue = Number(hueEl.value); paintHue(); };
  hueEl.onchange = () => sendColor(parseFloat(dot.style.left) / 100, 1 - parseFloat(dot.style.top) / 100);
}

/* ---------- Plan ----------
   The floor plan comes from the service (GET /plan), never from a file of the page: it
   is private. A tap on a room frames it and lists its devices, a tap on a device opens
   the same detail as its tile. The model needs WebGL and some width: without either,
   the plan is drawn flat, from above. */
const NARROW = "(max-width: 719px)";
let plan;                    // undefined: not asked yet. null: the service has none
let planView = null;         // the model, once three.js is loaded
let planLoading = false, noWebgl = false;
let planShown = "iso";       // "iso", "top" or the id of the framed room
let planOverview = "iso";    // the whole-plan view a framed room goes back to
const VIEW_NAME = { iso: () => t("plan.iso"), top: () => t("plan.top") };

const lampColor = (d) => (lampFill(d.state) || {}).color || null;
// The few characters next to a marker: the target of what heats, the reading of a sensor.
function pinLabel(d) {
  const s = d.state, module = moduleFor(d);
  if (!s.reachable) return "";
  if (module === "sensor") return degrees(s.temperature);
  if (d.type === "washer") return s.run === "running" ? duration(s.remainingMin) : "";
  if (d.type === "water") return s.showersLeft != null ? String(s.showersLeft) : "";
  return (module === "climate" || module === "heater") && s.on && s.setpoint != null ? degrees(s.setpoint) : "";
}
/* A marker says what it is and how it is: a lit lamp is a dot of its color, an air
   conditioner takes the color of its mode, anything off is small and grey. */
function pinOf(d, module) {
  const s = d.state, on = active(d), text = pinLabel(d);
  const fill = module === "light" && s.reachable ? lampFill(s) : null;
  return {
    html: `${deviceIcon(d)}${text ? `<span class="num">${text}</span>` : ""}`,
    cls: (!s.reachable ? "gone" : on ? "on" : "off") + (fill && fill.dark ? " pale" : ""),
    lamp: fill ? fill.color : null,
    mode: module === "climate" && s.reachable && s.on ? s.mode : null,
  };
}
// "Living room · 20.4° · 21° · 2 lamps": the name of a room and, when it holds devices, what runs in it.
function roomLabel(p) {
  const room = rooms.find((r) => r.id === p.id), parts = [];
  if (room) {
    const digest = roomDigest(room);
    if (digest.temperature != null) parts.push(`<span class="num">${degrees(digest.temperature)}</span>`);
    for (const c of digest.climate) parts.push(`<span class="num" data-mode="${esc(c.mode || "heat")}">${icon(c.type === "heater" ? "flame" : MODE_ICON[c.mode] || "snowflake")}${c.setpoint != null ? degrees(c.setpoint) : ""}</span>`);
    if (digest.lights) parts.push(`<span>${t("plan.lamps", digest.lights)}</span>`);
  }
  return { html: `<b>${esc(p.name)}</b>${parts.join("")}`, equipped: !!(room && room.devices.length) };
}
// Where the sun is over the home city, the first one, by quarter of an hour: the light of the plan moves no faster.
const QUARTER = 15 * 60 * 1000;
function sunNow() {
  const home = state.cities[0];
  return home ? solarPosition(Math.floor(Date.now() / QUARTER) * QUARTER, home.lat, home.lon) : null;
}

// A second tap on the framed room, or a tap outside the plan, goes back to the whole.
function showPlan(name) {
  if (name in VIEW_NAME) planOverview = name;
  planShown = !name || name === planShown ? planOverview : name;
  if (planView) planView.show(planShown);
  render();
}

/* A device under the pointer shows in both places: its tile and its marker on the plan.
   Classes are set straight on the elements: redrawing would end the hover it comes from. */
let pointed = null, pointedTimer = 0;
function point(id, hold = 0) {
  clearTimeout(pointedTimer);
  pointed = id || null;
  for (const el of $("tabHouse").querySelectorAll("[data-device]")) el.classList.toggle("hl", el.dataset.device === pointed);
  if (planView) planView.highlight(pointed);
  // a tap has no "leave": the mark fades by itself
  if (pointed && hold) pointedTimer = setTimeout(() => point(null), hold);
}

// The rooms worth a shortcut and a name: not the ducts, not the closets.
const namedRooms = () => plan.rooms.filter((p) => !["shaft", "unknown", "storage"].includes(p.kind));

function drawPlan() {
  $("planCard").hidden = !plan;
  if (!plan) return;
  const stage = $("planStage"), narrow = matchMedia(NARROW).matches, flat = narrow || noWebgl;
  const framed = plan.rooms.find((r) => r.id === planShown);
  if (flat) {
    if (planView) { planView.dispose(); planView = null; }
    stage.innerHTML = planSvg(plan, placedDevices(plan, rooms), {
      simple: narrow, room: framed ? framed.id : null, label: pinLabel, color: lampColor,
      temperatures: Object.fromEntries(rooms.map((r) => [r.id, r.temperature])),
    });
  } else if (planView) planView.update(rooms);
  else if (!planLoading) {
    // three.js is only fetched once there is a plan to draw
    planLoading = true;
    import("./plan3d.js").then(({ createPlan3d }) => {
      planLoading = false;
      planView = createPlan3d(stage, plan, { css: cssColor, lampColor, pin: pinOf, roomLabel, sun: sunNow, onDevice: openDetail, onRoom: showPlan, onHover: point, onMoved: (moved) => { $("planRecenter").hidden = !moved; } });
      if (planView) planView.show(planShown);
      else noWebgl = true;      // no WebGL context: the flat view, for good
      render();
    });
  }
  stage.classList.toggle("flat", flat);
  stage.setAttribute("aria-label", t("plan.label"));
  stage.title = flat ? "" : t("plan.hint");
  $("planViews").hidden = flat;
  const recenter = $("planRecenter");
  if (flat) recenter.hidden = true;
  if (!recenter.firstChild) recenter.innerHTML = icon("center");
  recenter.title = t("plan.recenter");
  recenter.setAttribute("aria-label", t("plan.recenter"));
  $("planViews").innerHTML = Object.keys(VIEW_NAME).map((v) => `<button type="button" class="${planShown === v ? "on" : ""}" data-view="${v}">${VIEW_NAME[v]()}</button>`).join("");
  $("planRooms").innerHTML = namedRooms().map((p) => `<button type="button" class="chip${planShown === p.id ? " on" : ""}" data-room="${esc(p.id)}">${esc(p.name)}</button>`).join("");
  const ignored = (plan.warnings || []).length;
  $("planNote").hidden = !ignored;
  $("planNote").textContent = ignored ? t("plan.ignored", ignored) : "";
  $("planNote").title = (plan.warnings || []).join("\n");
}

/* ---------- Fitting the screen ----------
   On a screen large enough the tab never scrolls. Upright, the plan takes half of the
   height and the tiles the rest; lying down, they sit side by side. When the tiles are
   too many for their share they tighten (tileLayout), the plan keeps its own. Sizes are
   taken with getBoundingClientRect, the only ones that include the zoom of the page. */
const SHIFT_ROOM = 6;   // the anti burn-in shift of the page (see main.js)
function fitHouse() {
  const pane = $("tabHouse"), grid = $("tileGrid"), card = $("planCard");
  if (pane.hidden) return;
  const count = grid.children.length;
  const fitted = !!plan && innerWidth >= 720 && innerHeight >= 620;
  const wide = fitted && matchMedia("(orientation: landscape) and (min-width: 1000px)").matches;
  pane.classList.toggle("fitted", fitted);
  pane.classList.toggle("wide", wide);
  grid.className = "tiles";
  for (const el of [pane, card, grid]) el.style.height = "";
  grid.style.gridTemplateColumns = grid.style.gridAutoRows = "";
  if (!fitted) return;
  const wrap = document.querySelector(".wrap"), zoom = Number(wrap.style.zoom) || 1;
  const top = pane.getBoundingClientRect().top + scrollY;
  const height = Math.floor((innerHeight - SHIFT_ROOM - top) / zoom - parseFloat(getComputedStyle(wrap).paddingBottom));
  pane.style.height = `${height}px`;
  const gap = parseFloat(getComputedStyle(pane).rowGap) || 0;
  const scenes = $("sceneBar").hidden ? 0 : $("sceneBar").offsetHeight + gap;
  // lying down the tiles have the whole height of their column, upright what the plan's half leaves
  const share = wide ? height - scenes : height - Math.round(height * 0.5) - gap - scenes;
  const layout = tileLayout(grid.clientWidth, share, count);
  const used = count ? layout.rows * layout.row + (layout.rows - 1) * 10 : 0;
  grid.classList.add(layout.look);
  grid.classList.toggle("scroll", layout.scroll);
  grid.style.gridTemplateColumns = `repeat(${layout.columns}, minmax(0, 1fr))`;
  grid.style.gridAutoRows = `${layout.row}px`;
  grid.style.height = `${layout.scroll ? share : used}px`;
  // what the tiles leave goes to the plan
  if (!wide) card.style.height = `${height - scenes - (count ? Math.min(used, share) + gap : 0)}px`;
}

let detailEl = null;
function openDetail(id) { detailId = id; pickerOpen = false; draft = null; awayDraft = null; render(); detailEl.querySelector("[data-close]").focus(); }
function closeDetail() { detailId = null; draft = null; awayDraft = null; render(); }

function render() {
  drawPlan();
  $("sceneBar").hidden = !(scenes && scenes.length);
  $("sceneBar").innerHTML = sceneBar();
  // with a room framed on the plan, its tiles stand out from the others
  const framed = plan && plan.rooms.some((r) => r.id === planShown) ? planShown : null;
  $("tileGrid").innerHTML = rooms.flatMap((r) => r.devices).map(tileHtml).join("");
  for (const el of $("tileGrid").children) {
    el.classList.toggle("away", !!framed && el.dataset.room !== framed);
    el.classList.toggle("hl", el.dataset.device === pointed);
  }
  $("houseEmpty").hidden = rooms.length > 0;
  fitHouse();
  const d = detailId && findDevice(detailId);
  detailEl.hidden = !d || !d.state.reachable;
  if (detailEl.hidden) { detailId = null; return; }
  // the page is zoomed to fit the screen (fitToScreen): the panel, outside it, follows
  detailEl.style.zoom = document.querySelector(".wrap").style.zoom || 1;
  const panel = detailEl.querySelector(".detailPanel");
  const scroll = panel.scrollTop;
  panel.innerHTML = detailHtml(d);
  panel.setAttribute("aria-label", d.name);
  panel.scrollTop = scroll;
  if (pickerOpen) wirePicker(panel, d);
}

// Custom confirmation: window.confirm() opens an off-theme native popup.
function askConfirm(message) {
  return new Promise((resolve) => {
    const overlay = document.createElement("div");
    overlay.className = "confirmOverlay";
    overlay.innerHTML = `<div class="confirmBox"><p></p><div class="confirmBtns">
      <button type="button" class="confirmCancel">${t("confirm.cancel")}</button>
      <button type="button" class="confirmOk">${t("confirm.ok")}</button>
    </div></div>`;
    overlay.querySelector("p").textContent = message; // textContent: never any HTML injection
    document.body.appendChild(overlay);
    const done = (val) => { overlay.remove(); resolve(val); };
    overlay.querySelector(".confirmOk").onclick = () => done(true);
    overlay.querySelector(".confirmCancel").onclick = () => done(false);
    overlay.onclick = (e) => { if (e.target === overlay) done(false); }; // click on the backdrop = cancel
    overlay.querySelector(".confirmOk").focus();
  });
}

/* ---------- Events: one set of listeners, the tiles are redrawn at every refresh ---------- */
const LONG_PRESS_MS = 500;
let wired = false;
function wire() {
  if (wired) return;
  wired = true;
  // On <body>, outside .wrap: the anti burn-in shift is a transform, which would break position:fixed.
  detailEl = document.createElement("div");
  detailEl.className = "detail";
  detailEl.hidden = true;
  detailEl.innerHTML = `<div class="detailBackdrop" data-close></div><aside class="detailPanel" role="dialog"></aside>`;
  document.body.appendChild(detailEl);

  let pressTimer = null, longPressed = false;
  const tab = $("tabHouse");
  tab.addEventListener("pointerdown", (e) => {
    const tile = e.target.closest("[data-tile]");
    if (!tile || e.target.closest("[data-more]")) return;
    longPressed = false;
    pressTimer = setTimeout(() => { longPressed = true; openDetail(tile.dataset.tile); }, LONG_PRESS_MS);
  });
  for (const type of ["pointerup", "pointerleave", "pointercancel"]) tab.addEventListener(type, () => clearTimeout(pressTimer), true);
  tab.addEventListener("click", (e) => {
    const scene = e.target.closest("[data-scene]");
    if (scene) return runScene(scene.dataset.scene);
    const planBtn = e.target.closest("#planViews [data-view], #planRooms [data-room], .planFlat [data-room]");
    if (planBtn) return showPlan(planBtn.dataset.view || planBtn.dataset.room);
    if (e.target.closest("#planRecenter")) return planView && planView.recenter();
    const flatPin = e.target.closest(".planFlat [data-device]");
    if (flatPin) return openDetail(flatPin.dataset.device);
    const more = e.target.closest("[data-more]");
    if (more) return openDetail(more.dataset.more);
    const tile = e.target.closest("[data-tile]");
    // the click that ends a long press has already opened the detail
    if (tile && !longPressed) { point(tile.dataset.tile, 1600); togglePower(tile.dataset.tile); }
  });
  // a tile or a flat marker under the pointer shows on the other side (the model reports its own markers)
  const pointable = (e) => e.target.closest && e.target.closest(".tile[data-device], .planFlat [data-device]");
  tab.addEventListener("pointerover", (e) => { const el = pointable(e); if (el && e.pointerType !== "touch" && el.dataset.device !== pointed) point(el.dataset.device); });
  tab.addEventListener("pointerout", (e) => { const el = pointable(e); if (el && !el.contains(e.relatedTarget)) point(null); });
  tab.addEventListener("keydown", (e) => {
    const tile = e.target.closest("[data-tile]");
    if (tile && e.target === tile && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); togglePower(tile.dataset.tile); }
    const flatPin = e.target.closest(".planFlat [data-device]");
    if (flatPin && e.key === "Enter") openDetail(flatPin.dataset.device);
  });
  // crossing the width under which the model gives way to the flat view
  matchMedia(NARROW).addEventListener("change", render);
  addEventListener("resize", fitHouse);

  detailEl.addEventListener("click", (e) => {
    const el = e.target.closest("button, [data-close]");
    if (!el) return;
    const data = el.dataset;
    if ("prog" in data) return programAction(data);
    if ("close" in data) return closeDetail();
    if ("power" in data) return togglePower(detailId);
    if ("step" in data) return step(detailId, Number(data.step));
    if ("set" in data) return command(detailId, { [data.set]: data.value });
    if ("toggle" in data) return command(detailId, { [data.toggle]: !findDevice(detailId).state[data.toggle] });
    if ("color" in data) return command(detailId, { colorRgb: Number(data.color) });
    if ("ambiance" in data) return command(detailId, { ambiance: data.ambiance });
    if ("picker" in data) { pickerOpen = !pickerOpen; render(); }
    if ("action" in data) return command(detailId, { [data.action]: true });
    if ("awaySet" in data && awayDraft) { const away = awayPeriod(awayDraft); awayDraft = null; return command(detailId, { away }); }
    if ("awayEnd" in data) { awayDraft = null; return command(detailId, { away: null }); }
  });
  // sliders send on release, not while dragging
  detailEl.addEventListener("change", (e) => {
    if ("progTime" in e.target.dataset && e.target.value) return programAction({ prog: "time" }, e.target.value);
    if (e.target.dataset.away) {
      const s = findDevice(detailId).state;
      awayDraft = { ...(awayDraft || (s.away ? { from: dayOf(s.away.from), to: dayOf(s.away.to) } : { from: dayOf(Date.now()), to: "" })), [e.target.dataset.away]: e.target.value };
      return render();
    }
    if (e.target.dataset.range) command(detailId, { [e.target.dataset.range]: Number(e.target.value) });
  });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && detailId) closeDetail(); });
}
