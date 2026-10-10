/* House tab: Govee lights, Daikin air conditioners, fuel prices around home.
   Lights go without confirmation. For an air conditioner we confirm turning it on
   and any setting on a running unit. Turning off, or setting a unit that is off,
   stays direct: nothing costly starts. */
import { $, state, esc, load } from "./core.js";
import { t, dec, relTime } from "./i18n.js";
import { icon } from "./icons.js";

let houseData = null;

export async function refreshHouse() {
  houseData = await load("/house");
  renderHouse();
}

// Control answers carry the new state, or an error whose message is shown as is.
async function control(path, body, who) {
  let res;
  try {
    res = await fetch(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  } catch {
    // fetch only throws when the agent can't be reached
    return alert(t("houseError", who, t("requestFailed")));
  }
  const j = await res.json().catch(() => ({}));
  if (!res.ok) return alert(t("houseError", who, j.error || t("failed")));
  houseData = j;
  renderHouse();
}
const goveeAction = (device, sku, instance, value) => control("/house/govee", { device, sku, instance, value }, t("light"));
const daikinAction = (name, changes) => control("/house/daikin", { name, ...changes }, t("aircon", name));

// Daikin values, in the order of their I18N labels.
const DAIKIN_VALUES = { mode: ["0", "2", "3", "4", "6"], f_rate: ["A", "B", "3", "4", "5", "6", "7"], f_dir: ["0", "1", "2", "3"] };
const DAIKIN_LABELS = { mode: "daikin.mode", f_rate: "daikin.rate", f_dir: "daikin.dir" };
const daikinOptions = (field) => DAIKIN_VALUES[field].map((v, i) => [v, t(DAIKIN_LABELS[field])[i]]);
// Quick color swatches: the native picker cannot be styled (popup outside the DOM).
const GOVEE_PRESETS = [0xffffff, 0xff3b30, 0xff9500, 0xffcc00, 0x34c759, 0x32ade6, 0x0a84ff, 0xaf52de, 0xff2d92];
const hex = (v) => "#" + v.toString(16).padStart(6, "0");
// Icon guessed from the name, like btIcon(): the Govee SKU doesn't tell a bulb from a strip.
const goveeIcon = (n) => icon(/bandeau|ruban|strip|led/i.test(n) ? "strip" : "bulb");
// Air conditioners: the icon shows the current mode, useful at a glance.
const DAIKIN_MODE_ICON = { "0": "autoMode", "2": "drop", "3": "snowflake", "4": "flame", "6": "fan" };

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

/* Floating panels (dropdown, color picker, scene menu) are placed with
   position:fixed on <body>: inside the card, overflow:hidden clipped them without
   any visible error. Only one is open at a time. */
let openPanel = null;
function closePanel() {
  if (openPanel) { openPanel.el.remove(); openPanel = null; }
}
function openFloating(btn, className, html) {
  const wasOpen = openPanel && openPanel.btn === btn;
  closePanel();
  if (wasOpen) return null;
  const el = document.createElement("div");
  el.className = className;
  el.innerHTML = html;
  document.body.appendChild(el);
  const r = btn.getBoundingClientRect();
  Object.assign(el.style, { position: "fixed", top: r.bottom + 4 + "px", left: r.left + "px", minWidth: r.width + "px" });
  openPanel = { btn, el };
  return el;
}
// A click elsewhere or a scroll closes the panel, or it would stay at a stale position.
document.addEventListener("click", (e) => { if (openPanel && !openPanel.el.contains(e.target) && !openPanel.btn.contains(e.target)) closePanel(); });
// Scrolling inside the scene list fires the event too: without this guard it closed at once.
window.addEventListener("scroll", (e) => { if (!(openPanel && openPanel.el.contains(e.target))) closePanel(); }, true);

function ddown(name, field, cur) {
  const label = (daikinOptions(field).find(([v]) => v === cur) || [, "–"])[1];
  return `<button type="button" class="ddownBtn" data-name="${esc(name)}" data-field="${field}">${label}</button>`;
}
function toggleDdown(btn) {
  const { name, field } = btn.dataset;
  const unit = houseData.daikin.find((u) => u.name === name);
  const menu = openFloating(btn, "ddownMenu", daikinOptions(field).map(([v, l]) =>
    `<button type="button" class="ddownOpt${v === unit[field] ? " on" : ""}" data-value="${v}">${l}</button>`).join(""));
  if (!menu) return;
  menu.querySelectorAll(".ddownOpt").forEach((o) => o.onclick = async () => {
    closePanel();
    if (unit.on && !(await askConfirm(t("confirm.apply", name)))) return;
    daikinAction(name, { [field]: o.dataset.value });
  });
}

// Full color picker: saturation/value square and hue slider. The color is sent on
// release, never while dragging: the Govee API is rate limited.
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
function togglePicker(btn, device, sku, curRgb) {
  let [hue, s0, v0] = rgbToHsv((curRgb >> 16) & 255, (curRgb >> 8) & 255, curRgb & 255);
  const panel = openFloating(btn, "colorPicker", `<div class="svBox"><div class="svDot"></div></div><input type="range" class="hueSlider" min="0" max="359" value="${Math.round(hue)}">`);
  if (!panel) return;
  const svBox = panel.querySelector(".svBox"), dot = panel.querySelector(".svDot"), hueEl = panel.querySelector(".hueSlider");
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
    goveeAction(device, sku, "colorRgb", (rr << 16) | (gg << 8) | bb);
  };
  let dragging = false;
  svBox.onpointerdown = (e) => { dragging = true; svBox.setPointerCapture(e.pointerId); pickAt(e.clientX, e.clientY); };
  svBox.onpointermove = (e) => { if (dragging) pickAt(e.clientX, e.clientY); };
  svBox.onpointerup = (e) => { if (!dragging) return; dragging = false; sendColor(...pickAt(e.clientX, e.clientY)); };
  hueEl.oninput = () => { hue = Number(hueEl.value); paintHue(); };
  hueEl.onchange = () => sendColor(parseFloat(dot.style.left) / 100, 1 - parseFloat(dot.style.top) / 100);
}

// Govee scenes (~60 per device): too heavy for the /house poll, loaded when the menu
// opens and then cached.
const sceneCache = new Map();
async function toggleSceneMenu(btn, device, sku) {
  const menu = openFloating(btn, "ddownMenu sceneMenu", `<div class="ddownOpt muted">${t("loading")}</div>`);
  if (!menu) return;
  if (!sceneCache.has(device)) {
    const scenes = await load(`/house/govee/scenes?device=${encodeURIComponent(device)}&sku=${encodeURIComponent(sku)}`);
    if (scenes) sceneCache.set(device, scenes);
  }
  if (!openPanel || openPanel.el !== menu) return; // closed in the meantime
  const scenes = sceneCache.get(device) || [];
  const firstDiy = scenes.findIndex((s) => s.diy);
  menu.innerHTML = scenes.length
    ? scenes.map((s, i) => (i === firstDiy ? `<div class="ddownOpt muted">${t("scenes.custom")}</div>` : "") +
        `<button type="button" class="ddownOpt" data-id="${s.id}" data-param="${s.paramId}" data-diy="${!!s.diy}">${esc(s.name)}</button>`).join("")
    : `<div class="ddownOpt muted">${t("scenes.none")}</div>`;
  menu.querySelectorAll(".ddownOpt[data-id]").forEach((o) => o.onclick = () => {
    closePanel();
    goveeAction(device, sku, o.dataset.diy === "true" ? "diyScene" : "lightScene", { id: Number(o.dataset.id), paramId: Number(o.dataset.param) });
  });
}

function renderHouse() {
  closePanel(); // the re-render replaces the buttons of an open panel
  const govee = (houseData && houseData.govee) || [];
  const daikin = (houseData && houseData.daikin) || [];
  // Always the home city (index 0): indoor comfort compares with the weather at
  // home, not with the city on display.
  const home = state.weather[0];
  $("goveeCard").hidden = !govee.length;
  $("daikinCard").hidden = !daikin.length;
  updateHouseEmpty();
  $("daikinMeta").textContent = home && home.current ? t("outside", Math.round(home.current.temperature_2m)) : "";

  const colorNames = t("govee.colors");
  const ids = (d) => `data-device="${esc(d.device)}" data-sku="${esc(d.sku)}"`;
  $("goveeList").innerHTML = govee.map((d) => `
    <div class="houseRow">
      <span>${goveeIcon(d.name)}${esc(d.name)}</span>
      <span class="ctrl">
        <span class="swatchRow" ${ids(d)}>
          ${GOVEE_PRESETS.map((v, i) => `<button type="button" class="swatch${d.colorRgb === v ? " on" : ""}" style="background:${hex(v)}" data-value="${v}" title="${colorNames[i]}"></button>`).join("")}
          <button type="button" class="swatch more colorPickerBtn" ${ids(d)} data-rgb="${d.colorRgb ?? 0xffffff}" title="${t("moreColors")}"></button>
        </span>
        <input type="range" class="goveeCt" min="2000" max="9000" step="100" value="${d.colorTemperatureK || 4000}" title="${t("colorTemp", d.colorTemperatureK ?? "–")}" ${ids(d)}>
        <input type="range" class="goveeBright" min="1" max="100" value="${d.brightness || 50}" title="${t("brightness", d.brightness ?? "–")}" ${ids(d)}>
        <button type="button" class="ddownBtn sceneBtn" ${ids(d)}>${t("scene")}</button>
        <button class="pwrBtn${d.on ? " on" : ""}" ${ids(d)}>${d.on ? t("on") : t("off")}</button>
      </span>
    </div>`).join("");

  $("daikinList").innerHTML = daikin.map((u) => u.reachable ? `
    <div class="houseRow">
      <span>${icon(DAIKIN_MODE_ICON[u.mode] || "snowflake")}${esc(u.name)}${u.ambientTemp != null ? ` <small class="muted">${dec(u.ambientTemp, 1)}°</small>` : ""}</span>
      <span class="ctrl">
        ${ddown(u.name, "mode", u.mode)}
        ${ddown(u.name, "f_rate", u.f_rate)}
        ${ddown(u.name, "f_dir", u.f_dir)}
        <span class="tempStep">
          <button data-daikin-step="-1" data-name="${esc(u.name)}">−</button>
          <span class="v num">${dec(u.targetTemp, 1)}°</span>
          <button data-daikin-step="1" data-name="${esc(u.name)}">+</button>
        </span>
        <button class="pwrBtn${u.on ? " on" : ""}" data-daikin-pow="${u.on ? 0 : 1}" data-name="${esc(u.name)}">${u.on ? t("on") : t("off")}</button>
      </span>
    </div>` : `
    <div class="houseRow"><span>${esc(u.name)}</span><span class="houseOffline">${t("unreachable")}</span></div>`).join("");

  const each = (sel, fn) => document.querySelectorAll(sel).forEach(fn);
  each("#goveeList .pwrBtn", (b) => b.onclick = () => goveeAction(b.dataset.device, b.dataset.sku, "powerSwitch", b.classList.contains("on") ? 0 : 1));
  each("#goveeList .goveeBright", (r) => r.onchange = () => goveeAction(r.dataset.device, r.dataset.sku, "brightness", Number(r.value)));
  each("#goveeList .goveeCt", (r) => r.onchange = () => goveeAction(r.dataset.device, r.dataset.sku, "colorTemperatureK", Number(r.value)));
  each("#goveeList .swatch:not(.colorPickerBtn)", (s) => s.onclick = () => {
    const row = s.closest(".swatchRow");
    goveeAction(row.dataset.device, row.dataset.sku, "colorRgb", Number(s.dataset.value));
  });
  each("#goveeList .colorPickerBtn", (b) => b.onclick = () => togglePicker(b, b.dataset.device, b.dataset.sku, Number(b.dataset.rgb)));
  each("#goveeList .sceneBtn", (b) => b.onclick = () => toggleSceneMenu(b, b.dataset.device, b.dataset.sku));

  // Confirmation to turn on, or to change a running unit. Turning off stays direct.
  each("#daikinList .pwrBtn", (b) => b.onclick = async () => {
    const turningOn = Number(b.dataset.daikinPow) === 1;
    if (turningOn && !(await askConfirm(t("confirm.turnOn", b.dataset.name)))) return;
    daikinAction(b.dataset.name, { pow: Number(b.dataset.daikinPow) });
  });
  each("#daikinList [data-daikin-step]", (b) => b.onclick = async () => {
    const unit = daikin.find((u) => u.name === b.dataset.name);
    const next = Math.round((unit.targetTemp + Number(b.dataset.daikinStep) * 0.5) * 2) / 2;
    if (unit.on && !(await askConfirm(t("confirm.setTemp", b.dataset.name, dec(next, 1))))) return;
    daikinAction(b.dataset.name, { stemp: next });
  });
  each("#daikinList .ddownBtn", (b) => b.onclick = () => toggleDdown(b));
}

// The empty-state card, only when no card has anything to show.
const updateHouseEmpty = () => {
  $("houseEmpty").hidden = !$("goveeCard").hidden || !$("daikinCard").hidden || !$("fuelCard").hidden;
};

/* ================= Fuel prices (France) =================
   The cheapest stations around the home city (the first one), per fuel. */
export async function refreshFuel() {
  const l = await load("/fuel");
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
