/* House tab: one tile per device, grouped by room, drawn from what the house service
   says each device can do (house/API.md). The page knows no brand.
   A tile says at a glance what is on: a lamp takes its own color, a tap turns the
   device on or off. Everything else lives in the detail (the ⋯ button, or a long press):
   a side panel on a wide screen, a sheet from the bottom on a phone.
   A command is shown at once and taken back if the device refuses it.
   Fuel prices keep their card at the bottom. */
import { $, state, esc, load } from "./core.js";
import { t, dec, nb, relTime } from "./i18n.js";
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

// A lit lamp fills its tile with its color. `dark` asks for dark text on a pale fill.
export function lampFill(s) {
  if (!s.on) return null;
  const [r, g, b] = s.colorRgb != null ? [(s.colorRgb >> 16) & 255, (s.colorRgb >> 8) & 255, s.colorRgb & 255] : kelvinToRgb(s.colorTempK || 4000);
  const luminance = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
  return { color: `rgb(${r}, ${g}, ${b})`, dark: luminance > 0.55 };
}

// "2 lights on · Air conditioner 20°": what runs in a room, read from its title.
export function roomSummary(room) {
  const live = room.devices.filter((d) => d.state.reachable);
  const lights = live.filter((d) => d.type === "light" && d.state.on).length;
  const heating = live.filter((d) => (d.type === "climate" || d.type === "heater") && d.state.on)
    .map((d) => d.state.setpoint != null ? `${d.name} ${dec(d.state.setpoint, d.state.setpoint % 1 ? 1 : 0)}°` : d.name);
  const parts = [lights ? t("house.lightsOn", lights) : null, ...heating].filter(Boolean);
  return parts.length ? parts.join(" · ") : t("house.allOff");
}

/* ---------- Data ---------- */
const findDevice = (id) => rooms.flatMap((r) => r.devices).find((d) => d.id === id);
const roomOf = (d) => rooms.find((r) => r.id === d.room);
const heats = (d) => d.type === "climate" || d.type === "heater";

export async function refreshHouse() {
  wire();
  const r = await load(`${API}/rooms`);
  // an answer older than a command still on its way would bring the old state back
  if (r && !inFlight) { rooms = r; state.house = { rooms }; }
  if (r && !scenes) [scenes, ambiances] = await Promise.all([load(`${API}/scenes`), load(`${API}/ambiances`)]).then((l) => l.map((x) => x || []));
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
  return [degrees(s.setpoint), s.on ? (s.mode ? t(`opt.mode.${s.mode}`) : t("house.running")) : t("house.stopped")];
}

function tileHtml(d) {
  const s = d.state, id = esc(d.id);
  const error = errors.get(d.id);
  if (!s.reachable) {
    // a lamp silent on the LAN gets the two usual reasons, anything else its technical message as a tooltip
    const why = s.error === "lanSilent" ? t("house.lanSilent") : t("unreachable");
    return `<div class="tile gone" title="${esc(s.error || "")}"><div class="tileTop">${deviceIcon(d)}</div>
      <div class="tileName">${esc(d.name)}</div><div class="tileState">${why}</div></div>`;
  }
  const fill = d.type === "light" ? lampFill(s) : null;
  const [main, words] = tileText(d);
  const canToggle = !!d.capabilities.on;
  const cls = ["tile", s.on ? "on" : canToggle ? "off" : "", fill ? "lit" : "", fill && fill.dark ? "pale" : "", error ? "failed" : ""].filter(Boolean).join(" ");
  return `<div class="${cls}" data-tile="${id}"${canToggle ? ` role="button" tabindex="0" aria-pressed="${!!s.on}"` : ""}${fill ? ` style="--lamp:${fill.color}"` : ""}>
    <div class="tileTop">${deviceIcon(d)}
      ${s.via === "cloud" ? `<span class="tileCloud" title="${t("house.viaCloud")}">${icon("cloud")}</span>` : ""}
      ${Object.keys(d.capabilities).length ? `<button type="button" class="tileMore" data-more="${id}" aria-label="${t("house.details", esc(d.name))}">${icon("dots")}</button>` : ""}
    </div>
    <div class="tileName">${esc(d.name)}</div>
    <div class="tileMain num">${main}</div>
    <div class="tileState">${error ? esc(error) : words}</div>
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
  for (const [cap, c] of Object.entries(caps)) {
    if (c.type === "boolean" && cap !== "on") out.push(switchHtml(t("cap." + cap), s[cap], `data-toggle="${cap}"`));
  }
  // What the device reports and nobody sets. The probe of an air conditioner is named
  // as such: it reads several degrees above the room.
  const facts = [
    s.probeTemp != null ? t("house.probe", dec(s.probeTemp, 1)) : null,
    d.type === "heater" && s.temperature != null ? `${dec(s.temperature, 1)}°` : null,
    s.outdoorTemp != null ? t("house.outdoorUnit", dec(s.outdoorTemp, 1)) : null,
    s.energy ? t("house.energyToday", dec(s.energy.today, 1)) : null,
    s.energy ? t("house.energyWeek", dec(s.energy.week, 1)) : null,
    s.timer && s.timer.enabled ? t("house.timerOn") : null,
    s.schedule && s.schedule.enabled ? t("house.scheduleOn") : null,
    s.via === "cloud" ? t("house.viaCloud") : null,
  ].filter(Boolean);
  return `<div class="detailHead"><span class="detailName">${deviceIcon(d)}<span>${esc(d.name)}<small>${esc(roomOf(d).name)}</small></span></span>
      <button type="button" class="detailClose" data-close aria-label="${t("house.close")}">${icon("close")}</button></div>
    ${error ? `<div class="detailError">${esc(error)}</div>` : ""}
    ${out.join("")}
    ${facts.length ? `<div class="detailFacts">${facts.map((x) => `<span>${x}</span>`).join("")}</div>` : ""}`;
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

let detailEl = null;
function openDetail(id) { detailId = id; pickerOpen = false; render(); detailEl.querySelector("[data-close]").focus(); }
function closeDetail() { detailId = null; render(); }

function render() {
  $("sceneBar").hidden = !(scenes && scenes.length);
  $("sceneBar").innerHTML = sceneBar();
  $("roomList").innerHTML = rooms.map((r) => `<section class="room">
      <div class="roomHead"><h2>${esc(r.name)}</h2><span class="roomSummary">${esc(roomSummary(r))}</span>
        ${r.temperature != null ? `<span class="roomTemp num">${dec(r.temperature, 1)}°</span>` : ""}</div>
      <div class="tiles">${r.devices.map(tileHtml).join("")}</div>
    </section>`).join("");
  updateHouseEmpty();
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
    const more = e.target.closest("[data-more]");
    if (more) return openDetail(more.dataset.more);
    const tile = e.target.closest("[data-tile]");
    // the click that ends a long press has already opened the detail
    if (tile && !longPressed) togglePower(tile.dataset.tile);
  });
  tab.addEventListener("keydown", (e) => {
    const tile = e.target.closest("[data-tile]");
    if (tile && e.target === tile && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); togglePower(tile.dataset.tile); }
  });

  detailEl.addEventListener("click", (e) => {
    const el = e.target.closest("button, [data-close]");
    if (!el) return;
    const data = el.dataset;
    if ("close" in data) return closeDetail();
    if ("power" in data) return togglePower(detailId);
    if ("step" in data) return step(detailId, Number(data.step));
    if ("set" in data) return command(detailId, { [data.set]: data.value });
    if ("toggle" in data) return command(detailId, { [data.toggle]: !findDevice(detailId).state[data.toggle] });
    if ("color" in data) return command(detailId, { colorRgb: Number(data.color) });
    if ("ambiance" in data) return command(detailId, { ambiance: data.ambiance });
    if ("picker" in data) { pickerOpen = !pickerOpen; render(); }
  });
  // sliders send on release, not while dragging
  detailEl.addEventListener("change", (e) => {
    if (e.target.dataset.range) command(detailId, { [e.target.dataset.range]: Number(e.target.value) });
  });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && detailId) closeDetail(); });
}

// The empty-state card, only when no card has anything to show.
const updateHouseEmpty = () => {
  $("houseEmpty").hidden = rooms.length > 0 || !$("fuelCard").hidden;
};

/* ================= Fuel prices (France) =================
   The cheapest stations around the home city (the first one), per fuel. */
export async function refreshFuel() {
  const l = await load("/fuel");
  state.fuel = l;
  $("fuelCard").hidden = !l || !l.length;
  updateHouseEmpty();
  if (!l || !l.length) return;
  $("fuelMeta").textContent = state.cities[0] ? state.cities[0].short : "";
  $("fuelList").innerHTML = l.map((f) => `<div class="fuelCol">
      <div class="fuelName">${icon("pump")}${t("fuel." + f.type)}</div>
      ${f.stations.length ? f.stations.map((s, i) => `<div class="fuelRow${i ? "" : " best"}">
        <span class="p num">${dec(s.price, 3)} €</span>
        <span class="a">${esc(s.address)}, ${esc(s.city)}<span class="dim">${t("fuel.km", dec(s.distance / 1000))}, ${relTime(new Date(s.updated).toISOString())}</span></span>
      </div>`).join("") : `<div class="err">${t("fuel.none")}</div>`}
    </div>`).join("");
}
