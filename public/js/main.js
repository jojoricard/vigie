/* Entry point: loads the config, then starts every card and its refresh rhythm. */
import { $, state, load, applyTheme } from "./core.js";
import { t, setLang, fmtDate, dayKey } from "./i18n.js";
import { refreshWeather, renderCityTabs, renderHorizon, refreshAqi, refreshSnow, refreshAlerts, refreshRadarFrames, startAnim, updateSky, onWeatherTabShown } from "./weather.js";
import { refreshEnergy } from "./energy.js";
import { refreshSensors, refreshSparks, refreshHistory, initHistControls, refreshMarkers, drawHistory, refreshSystem, refreshDevices } from "./system.js";
import { refreshMachine, refreshChanges, refreshCrash, refreshNetwork, refreshYear, refreshWindows, refreshServices } from "./machine.js";
import { refreshHouse, refreshFuel } from "./house.js";
import { refreshMedia } from "./media.js";
import { refreshTools } from "./tools.js";
import { maybeBriefing } from "./briefing.js";

const MIN = 60 * 1000;

function tickClock() {
  const n = new Date();
  const p = (x) => String(x).padStart(2, "0");
  $("clock").innerHTML = `${p(n.getHours())}:${p(n.getMinutes())}<span class="sec">${p(n.getSeconds())}</span>`;
  $("dateLine").textContent = fmtDate(n, { weekday: "long", day: "numeric", month: "long", year: "numeric" });
}

async function refreshNameDay() {
  const j = await load("/nameday");
  if (!j) return;
  state.nameDay = j.text || "";
  $("nameDayLine").hidden = !state.nameDay;
  $("nameDayLine").textContent = state.nameDay ? t("nameday", state.nameDay) : "";
}

/* Public holiday and school break (France), under the name day, only when close:
   a public holiday within a week, a school break running or starting within two. */
async function refreshHolidays() {
  const j = await load("/holidays");
  if (!j) return;
  const today = dayKey();
  const tomorrow = dayKey(new Date(Date.now() + 86400000));
  const parts = [];
  const p = j.publicHoliday;
  if (p) {
    const name = t("pub." + p.code);
    parts.push(p.date === today ? t("hol.today", name) : p.date === tomorrow ? t("hol.tomorrow", name)
      : t("hol.on", name, fmtDate(p.date + "T12:00:00", { weekday: "long" })));
  }
  const s = j.school;
  if (s) {
    const name = t("break." + s.code);
    const days = Math.round((Date.parse(s.start + "T12:00:00") - Date.parse(today + "T12:00:00")) / 86400000);
    parts.push(s.ongoing ? t("school.until", name, fmtDate(s.lastDay + "T12:00:00", { weekday: "long", day: "numeric", month: "long" }))
      : days === 1 ? t("school.tomorrow", name) : t("school.in", name, days));
  }
  $("holidayLine").hidden = !parts.length;
  $("holidayLine").textContent = parts.join(", ");
}

/* Screen dimming, from config.json → dimming: { level, from, to }. Without from/to
   the dimming is permanent, without the key there is none. */
const minutes = (hhmm) => { const [h, m] = hhmm.split(":").map(Number); return h * 60 + m; };
function updateDimming() {
  const d = state.cfg.dimming;
  let on = false;
  if (d) {
    const n = new Date(), m = n.getHours() * 60 + n.getMinutes();
    const from = d.from ? minutes(d.from) : null, to = d.to ? minutes(d.to) : null;
    on = from == null || to == null || (from > to ? m >= from || m < to : m >= from && m < to);
  }
  $("nightShade").style.opacity = on ? d.level : 0;
}

/* Anti burn-in: tiny shift of the content every 5 min. */
function pixelShift() {
  const x = Math.round(Math.random() * 4 - 2), y = Math.round(Math.random() * 4 - 2);
  document.querySelector(".wrap").style.transform = `translate(${x}px, ${y}px)`;
}

function initTabnav() {
  const panes = { overview: "tabOverview", weather: "tabWeather", machine: "tabMachine", tools: "tabTools", house: "tabHouse" };
  $("tabnav").querySelectorAll("span").forEach((s) => s.onclick = () => {
    const tab = s.dataset.tab;
    $("tabnav").querySelectorAll("span").forEach((x) => x.classList.toggle("on", x === s));
    Object.entries(panes).forEach(([k, id]) => { $(id).hidden = k !== tab; });
    // a hidden canvas has a zero width: redraw when coming back
    if (tab === "overview") { drawHistory(); startAnim(); queueFit(); }
    if (tab === "weather") onWeatherTabShown();
    if (tab === "house") { refreshHouse(); refreshFuel(); }
  });
}

/* Fit to the screen: the page is zoomed to the largest size at which the Overview still
   fits without scrolling, then the last cards stretch to the bottom edge. Below ZOOM_MIN
   (a phone, a small window) it keeps its natural size and scrolls. Only
   getBoundingClientRect includes the zoom, offset and client sizes don't. */
const ZOOM_MIN = 0.8, ZOOM_MAX = 1.8;
// room for the anti burn-in shift (± 2 px), which would otherwise bring back a scrollbar
const SHIFT_ROOM = 6;
let zoom = 1;
function fitToScreen() {
  const wrap = document.querySelector(".wrap");
  if ($("tabOverview").hidden) return;              // the other tabs scroll anyway
  // narrowest layout that stays readable: three columns, or one
  const threeCols = matchMedia("(orientation: landscape) and (min-width: 1600px)").matches;
  const top = Math.min(ZOOM_MAX, innerWidth / (threeCols ? 1600 : 1080));
  const before = [wrap.style.zoom, wrap.style.minHeight];
  wrap.style.minHeight = "";
  const fits = (z) => { wrap.style.zoom = z; return wrap.getBoundingClientRect().height <= innerHeight - SHIFT_ROOM; };
  let z = null;
  if (innerWidth >= 720 && top >= ZOOM_MIN && fits(ZOOM_MIN)) {
    // most calls change nothing: check the current zoom first
    if (zoom <= top && fits(zoom) && (zoom + 0.01 > top || !fits(zoom + 0.01))) z = zoom;
    else {
      let lo = ZOOM_MIN, hi = top;
      if (fits(hi)) lo = hi;
      else for (let i = 0; i < 8; i++) { const mid = (lo + hi) / 2; if (fits(mid)) lo = mid; else hi = mid; }
      z = lo;
    }
  }
  zoom = z || 1;
  wrap.style.zoom = zoom;
  wrap.style.minHeight = z ? (innerHeight - SHIFT_ROOM) / zoom + "px" : "";
  if (wrap.style.zoom !== before[0] || wrap.style.minHeight !== before[1]) { startAnim(); drawHistory(); renderHorizon(); }
}
let fitQueued = false;
function queueFit() {
  if (fitQueued) return;
  fitQueued = true;
  requestAnimationFrame(() => { fitQueued = false; fitToScreen(); });
}

// Runs fn now, then every `ms`.
function every(ms, fn) {
  fn();
  setInterval(fn, ms);
}

(async function init() {
  every(1000, tickClock);
  state.cfg = await load("/config");
  if (!state.cfg) {
    setLang("en");
    $("wxDesc").textContent = t("config.error");
    return;
  }
  applyTheme(state.cfg.theme);
  setLang(state.cfg.lang);
  tickClock();
  state.cities = state.cfg.cities;
  if (state.sel >= state.cities.length) state.sel = 0;
  renderCityTabs();
  initTabnav();
  initHistControls();

  every(MIN, () => { updateSky(); renderHorizon(); });   // the sun moves on the horizon
  every(MIN, updateDimming);
  every(5 * MIN, pixelShift);
  every(MIN, refreshSparks);
  every(2000, refreshSensors);
  every(MIN, refreshHistory);
  every(30000, refreshSystem);          // matches the agent's cache (see PROC_TTL_MS)
  every(5 * MIN, refreshDevices);
  every(5 * MIN, refreshEnergy);
  every(MIN, refreshNetwork);
  every(10 * MIN, refreshChanges);
  every(60 * MIN, refreshCrash);
  every(60 * MIN, refreshMarkers);      // they are dates: they don't move
  every(30 * MIN, refreshYear);
  every(12 * 60 * MIN, refreshMachine);
  every(6 * 60 * MIN, refreshTools);
  every(6 * 60 * MIN, refreshNameDay);
  every(6 * 60 * MIN, refreshHolidays);
  every(5000, refreshMedia);
  every(5 * MIN, refreshServices);
  every(30 * MIN, refreshWindows);
  every(30 * MIN, refreshFuel);
  every(MIN, refreshHouse);
  every(30 * MIN, refreshAlerts);
  every(60 * MIN, refreshAqi);
  every(60 * MIN, refreshSnow);
  every(10 * MIN, refreshRadarFrames);  // RainViewer's real frame rate
  // The briefing waits for the weather, then for warnings, pollen and incidents to arrive.
  every(15 * MIN, () => refreshWeather().then(() => setTimeout(maybeBriefing, 8000)));
  addEventListener("resize", () => { startAnim(); drawHistory(); renderHorizon(); queueFit(); });
  // content that grows (briefing, rain, a new device) refits the page
  new ResizeObserver(queueFit).observe(document.querySelector(".wrap"));
  new ResizeObserver(() => drawHistory()).observe($("histCanvas"));
})();
