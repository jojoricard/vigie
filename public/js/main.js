/* Entry point: loads the config, then starts every block and its refresh rhythm.
   The page is one screen: the tab shown is a box fitted by fit.js after every refresh
   and every resize, nothing scrolls. */
import { $, state, load, applyTheme, inSpan } from "./core.js";
import { t, setLang, fmtDate, dayKey } from "./i18n.js";
import { uiScale, fitBox, queueFit, wireFit, pagesOf, setPage, orderBlocks, layoutOf } from "./fit.js";
import { refreshWeather, renderCityTabs, refreshAqi, refreshSnow, refreshAlerts, refreshRadarFrames, startAnim, updateSky, onWeatherTabShown, renderOverviewWeather, setWeatherView, weatherViews } from "./weather.js";
import { refreshEnergy, renderEnergy, refreshYear } from "./energy.js";
import { refreshSensors, refreshSparks, refreshHistory, initHistControls, refreshMarkers, drawHistory, refreshSystem, refreshDevices } from "./system.js";
import { refreshMachine, refreshChanges, refreshCrash, refreshNetwork, refreshWindows, wireMachine, renderBox } from "./machine.js";
import { refreshHouse, houseTabShown, openDetail, lookAtPlan, planShare } from "./house.js";
import { refreshMedia } from "./media.js";
import { refreshTools, refreshFuel, refreshPcUpdates, toolsLeft } from "./tools.js";
import { queueBriefing } from "./briefing.js";
import { refreshNotices, wireNotices, worst, noticeLine } from "./alerts.js";
import { panelBox, closePanel, panelTabs, setPanelTab } from "./panel.js";
import { icon } from "./icons.js";

const MIN = 60 * 1000;
const TABS = { overview: "tabOverview", weather: "tabWeather", house: "tabHouse", energy: "tabEnergy", machine: "tabMachine", tools: "tabTools" };
let tab = "overview";

const two = (x) => String(x).padStart(2, "0");
const clockHtml = (n) => `${two(n.getHours())}:${two(n.getMinutes())}<span class="sec">${two(n.getSeconds())}</span>`;
function tickClock() {
  const n = new Date();
  $("clock").innerHTML = clockHtml(n);
  $("dateLine").textContent = fmtDate(n, { weekday: "long", day: "numeric", month: "long", year: "numeric" });
  const veil = $("nightVeil");
  if (veil) veil.querySelector(".clock").innerHTML = clockHtml(n);
}

/* Under the date: the name day, then a public holiday within a week and a school break
   running or starting within two (France). */
function renderDayNotes() {
  const parts = [];
  if (state.nameDay) parts.push(t("nameday", state.nameDay));
  const j = state.holidays, today = dayKey(), tomorrow = dayKey(new Date(Date.now() + 86400000));
  const p = j && j.publicHoliday, s = j && j.school;
  if (p) {
    const name = t("pub." + p.code);
    parts.push(p.date === today ? t("hol.today", name) : p.date === tomorrow ? t("hol.tomorrow", name)
      : t("hol.on", name, fmtDate(p.date + "T12:00:00", { weekday: "long" })));
  }
  if (s) {
    const name = t("break." + s.code);
    const days = Math.round((Date.parse(s.start + "T12:00:00") - Date.parse(today + "T12:00:00")) / 86400000);
    parts.push(s.ongoing ? t("school.until", name, fmtDate(s.lastDay + "T12:00:00", { weekday: "long", day: "numeric", month: "long" }))
      : days === 1 ? t("school.tomorrow", name) : t("school.in", name, days));
  }
  $("dayNotes").hidden = !parts.length;
  $("dayNotes").textContent = parts.join(" · ");
}
async function refreshNameDay() {
  const j = await load("/nameday");
  if (j) state.nameDay = j.text || "";
  renderDayNotes();
}
async function refreshHolidays() {
  const j = await load("/holidays");
  if (j) state.holidays = j;
  renderDayNotes();
}

/* Screen dimming, from config.json → dimming: { level, from, to }. Without from/to
   the dimming is permanent, without the key there is none. */
function updateDimming() {
  const d = state.cfg.dimming, n = new Date();
  const on = !!d && (!d.from || !d.to || inSpan(n.getHours() * 60 + n.getMinutes(), d.from, d.to));
  $("nightShade").style.opacity = on ? d.level : 0;
}

/* Night mode, from config.json → night: { from, to }. Between the two hours the screen
   goes dark and only keeps the clock and the alerts in progress. The first click, touch
   or key brings the page back at once; it goes dark again after a few minutes without
   anyone touching it. */
const NIGHT_WAKE_MS = 3 * MIN;
let awakeUntil = 0;
function updateNight() {
  const n = state.cfg.night, now = new Date();
  const dark = !!n && inSpan(now.getHours() * 60 + now.getMinutes(), n.from, n.to) && Date.now() >= awakeUntil;
  let veil = $("nightVeil");
  if (!dark) { if (veil) veil.remove(); return; }
  if (!veil) {
    veil = document.createElement("div");
    veil.id = "nightVeil";
    veil.innerHTML = `<div class="clock"></div><div class="nightAlerts"></div>`;
    document.body.appendChild(veil);
    tickClock();
  }
  veil.querySelector(".nightAlerts").innerHTML = state.notices.slice(0, 4).map(noticeLine).join("");
}
function wake() {
  const n = state.cfg && state.cfg.night;
  if (!n) return;
  const wasDark = !!$("nightVeil");
  awakeUntil = Date.now() + NIGHT_WAKE_MS;
  if (wasDark) updateNight();
}

/* Anti burn-in: tiny shift of the content every 5 min. The padding of the page absorbs it. */
function pixelShift() {
  const x = Math.round(Math.random() * 4 - 2), y = Math.round(Math.random() * 4 - 2);
  $("wrap").style.transform = `translate(${x}px, ${y}px)`;
}

/* The size of the page: the window, divided by the zoom that brings a large screen
   back to the size the page is drawn for. */
function applyScale() {
  const z = uiScale(innerWidth, innerHeight), s = document.body.style;
  s.setProperty("--z", z);
  s.setProperty("--lw", `${innerWidth / z}px`);
  s.setProperty("--lh", `${innerHeight / z}px`);
}

/* The pills of the tab bar: the alerts in progress, and today's Tempo color. */
const TEMPO_COL = { 1: "#60a5fa", 2: "#e6e6ef", 3: "#ff6b6b" };
function renderStatus() {
  const n = state.notices, e = state.energy, sev = worst(n);
  $("status").innerHTML = (n.length ? `<button type="button" class="statPill ${sev}" data-goto="overview" aria-label="${t("card.alerts")}">${icon("alert")}${n.length}</button>` : "")
    + (e && e.tempo ? `<button type="button" class="statPill tempo" data-goto="energy" title="${t("energy.tempo")}"><i style="background:${TEMPO_COL[e.tempo.code]}"></i><span>${t("tempo.colors")[e.tempo.code]}</span></button>` : "");
}

export function showTab(name) {
  if (!TABS[name]) return;
  if (tab === "tools" && name !== "tools") toolsLeft();
  tab = name;
  for (const b of $("tabs").children) { b.classList.toggle("on", b.dataset.tab === name); b.setAttribute("aria-selected", b.dataset.tab === name); }
  for (const [k, id] of Object.entries(TABS)) $(id).hidden = k !== name;
  // what a tab only draws when it shows, then its fit; a hidden canvas has no size, so
  // what is drawn on one is drawn again once it has
  if (name === "weather") onWeatherTabShown();
  if (name === "house") houseTabShown();
  fitBox($(TABS[name]));
  if (name === "overview") startAnim();
  if (name === "machine") drawHistory();
}

function wire() {
  $("tabs").addEventListener("click", (e) => { const b = e.target.closest("[data-tab]"); if (b) showTab(b.dataset.tab); });
  // a block or a pill that leads to a tab
  document.addEventListener("click", (e) => { const el = e.target.closest("[data-goto]"); if (el && !e.target.closest("[data-ack], [data-scene], .seg")) showTab(el.dataset.goto); });
  for (const type of ["pointerdown", "keydown"]) document.addEventListener(type, wake, true);
  document.addEventListener("vigie:notices", () => { renderStatus(); updateNight(); queueBriefing(); queueFit(); });
  document.addEventListener("vigie:energy", renderStatus);
  for (const id of Object.values(TABS)) $(id).addEventListener("fit", () => { if (id === "tabOverview") { renderOverviewWeather(); startAnim(); } if (id === "tabMachine") drawHistory(); });
  addEventListener("resize", () => { applyScale(); queueFit(); });
  for (const id of Object.values(TABS)) orderBlocks($(id));
  wireFit();
  wireNotices();
  wireMachine();
}

// Runs fn now, then every `ms`, and fits the page once it has drawn. A turn that falls
// while the page is not visible (another window over the kiosk, screen asleep) is
// skipped, nothing to redraw and nothing asked of the agent, and caught up as soon as
// the page shows again.
const timers = [];
const started = [];
function every(ms, fn) {
  const run = () => Promise.resolve(fn()).then(() => { refreshNotices(); queueFit(); });
  started.push(run());
  const timer = { run, missed: false };
  timers.push(timer);
  setInterval(() => { if (document.hidden) timer.missed = true; else run(); }, ms);
}
document.addEventListener("visibilitychange", () => {
  if (document.hidden) return;
  for (const timer of timers) if (timer.missed) { timer.missed = false; timer.run(); }
});

/* What the layout check and the captures drive the page with (scripts/): the tabs, the
   sub-views, the panels. `ready` resolves once every block has drawn a first time. */
function expose() {
  const frame = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => requestAnimationFrame(r))));
  const box = () => panelBox() || $(TABS[tab]);
  window.vigie = {
    ready: Promise.all(started).then(frame),
    tabs: Object.keys(TABS),
    show: async (name) => { closePanel(); showTab(name); await frame(); },
    views: () => tab === "weather" ? weatherViews() : ["main"],
    view: async (v) => { if (tab === "weather") setWeatherView(v); await frame(); },
    pages: () => Math.max(1, pagesOf(box())),
    layout: () => layoutOf(box()),
    planShare: () => planShare(),
    page: async (i) => { setPage(box(), i); await frame(); },
    devices: () => ((state.house && state.house.rooms) || []).flatMap((r) => r.devices).filter((d) => !d.state.reachable || Object.keys(d.capabilities).length).map((d) => d.id),
    panels: () => [...document.querySelectorAll("[data-panel]")].filter((el) => !el.closest("[hidden]")).map((el) => el.dataset.panel),
    open: async (what) => { const el = document.querySelector(`[data-panel="${what}"]`); if (el) el.click(); else openDetail(what); await frame(); },
    panelTabs, panelTab: async (id) => { setPanelTab(id); await frame(); },
    close: async () => { closePanel(); await frame(); },
    look: async (...angle) => { lookAtPlan(...angle); await frame(); },
    night: async (on) => { state.cfg.night = on ? { from: "00:00", to: "23:59" } : null; awakeUntil = 0; updateNight(); await frame(); },
  };
}

(async function init() {
  applyScale();
  setInterval(tickClock, 1000);
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
  initHistControls();
  wire();

  every(MIN, updateSky);
  every(MIN, updateDimming);
  every(MIN, updateNight);
  every(5 * MIN, pixelShift);
  every(MIN, refreshSparks);
  every(5000, refreshSensors);          // LibreHardwareMonitor refreshes every 5 s, the agent caches as long (lhmPollMs)
  every(MIN, refreshHistory);
  every(MIN, refreshSystem);
  every(5 * MIN, refreshDevices);
  every(5 * MIN, refreshEnergy);
  every(MIN, refreshNetwork);
  every(10 * MIN, refreshChanges);
  // Weather, incidents and warnings feed the briefing: each refresh offers the agent a
  // fresh context, which is also how the midday and evening texts get asked for.
  every(60 * MIN, () => refreshCrash().then(queueBriefing));
  every(60 * MIN, refreshMarkers);      // they are dates: they don't move
  every(30 * MIN, refreshYear);
  every(12 * 60 * MIN, refreshMachine);
  every(6 * 60 * MIN, refreshTools);
  every(6 * 60 * MIN, refreshNameDay);
  every(6 * 60 * MIN, refreshHolidays);
  every(10000, refreshMedia);           // one PowerShell round trip each time
  every(30 * MIN, refreshWindows);
  every(30 * MIN, refreshFuel);
  every(30 * MIN, refreshPcUpdates);
  every(MIN, () => refreshHouse().then(() => { renderBox(); renderEnergy(); }));   // the box and the counters of the units come with the house
  every(30 * MIN, () => refreshAlerts().then(queueBriefing));
  every(60 * MIN, refreshAqi);
  every(60 * MIN, refreshSnow);
  every(10 * MIN, refreshRadarFrames);  // RainViewer's real frame rate, only asked once the radar was opened
  every(15 * MIN, () => refreshWeather().then(queueBriefing));
  expose();
  showTab(tab);
})();
