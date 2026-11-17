/* Weather: the Overview card, the Weather tab with its radar and snow sub-views, air
   quality, pollen and warnings. The page calls Open-Meteo directly, with timezone=auto
   so the hourly series follow each city's local time. */
import { $, LS, state, esc, small, readout, load, COL, put } from "./core.js";
import { t, dec, nb, fmtDate, fmtTime, dayKey } from "./i18n.js";
import { weatherIcon, moonIcon, icon, alertIcon } from "./icons.js";
import { fitBox, queueFit } from "./fit.js";

export const WMO_CODES = [0, 1, 2, 3, 45, 48, 51, 53, 55, 56, 57, 61, 63, 65, 66, 67, 71, 73, 75, 77, 80, 81, 82, 85, 86, 95, 96, 99];
export const wmoLabel = (code) => WMO_CODES.includes(code) ? t("wmo." + code) : "–";
// WMO code families, shared by the background and the particle animation
const isRainy = (c) => (c >= 51 && c <= 67) || (c >= 80 && c <= 82) || c >= 95;
const isSnowy = (c) => (c >= 71 && c <= 77) || c === 85 || c === 86;
const windDir = (d) => t("windDirs")[Math.round(((d % 360) / 45)) % 8];
const hm = (iso) => iso ? iso.slice(11, 16) : "–";

// Index of the current hour in an hourly.time array (local time of the place).
export function hourIndex(times) {
  if (!Array.isArray(times) || !times.length) return 0;
  const now = Date.now();
  let i = 0;
  while (i + 1 < times.length && new Date(times[i + 1]).getTime() <= now) i++;
  return i;
}

/* ================= Background mood ================= */
// The page background shifts slightly with the hour and the sky (see data-sky in the CSS).
export function updateSky() {
  const h = new Date().getHours();
  const c = state.curCode;
  const sky = !state.curIsDay || h >= 22 || h < 6 ? "night"
    : h < 9 || h >= 19 ? "dusk"
    : isSnowy(c) ? "snow" : isRainy(c) ? "rain" : c === 3 || c === 45 || c === 48 ? "cloud" : "";
  if (sky) document.documentElement.dataset.sky = sky;
  else delete document.documentElement.dataset.sky;
}

/* ================= Moon =================
   The phase from the synodic month: an icon next to today's extremes. */
function moonPhase() {
  const syn = 29.53058867;
  const ref = Date.UTC(2000, 0, 6, 18, 14) / 86400000;
  const p = (((Date.now() / 86400000 - ref) % syn) / syn + 1) % 1;
  const i = Math.floor(((p + 1 / 16) % 1) * 8);   // eight named phases centered on their date
  return { p, name: t("moon")[i], illum: Math.round((1 - Math.cos(2 * Math.PI * p)) / 2 * 100) };
}

/* ================= Overview weather card ================= */
function cityWeatherUrl(c) {
  const u = new URL("https://api.open-meteo.com/v1/forecast");
  u.search = new URLSearchParams({
    // 7 days and full hourly series: one request serves the Overview and the Weather tab.
    latitude: c.lat, longitude: c.lon, timezone: "auto", forecast_days: "7",
    current: "temperature_2m,relative_humidity_2m,apparent_temperature,is_day,weather_code,wind_speed_10m,wind_direction_10m,wind_gusts_10m",
    hourly: "uv_index,temperature_2m,apparent_temperature,precipitation,precipitation_probability,weather_code,wind_speed_10m,wind_gusts_10m,relative_humidity_2m",
    minutely_15: "precipitation",
    daily: "weather_code,temperature_2m_max,temperature_2m_min,sunrise,sunset,daylight_duration,precipitation_probability_max,precipitation_sum,uv_index_max,wind_speed_10m_max,wind_gusts_10m_max",
  });
  return u;
}

export async function refreshWeather() {
  const all = await Promise.all(state.cities.map((c) => load(cityWeatherUrl(c))));
  // Keep the last good forecast of a city whose request failed this time.
  state.weather = all.map((w, i) => w || state.weather[i] || null);
  if (!state.weather[state.sel]) { $("wxDesc").textContent = t("wx.unavailable"); return; }
  renderWeather();
}

function renderWeather() {
  const w = state.weather[state.sel];
  if (!w || !w.current) return;
  const cur = w.current, d = w.daily;
  state.curCode = cur.weather_code; state.curIsDay = cur.is_day;
  put($("wxIcon"), weatherIcon(cur.weather_code, cur.is_day));
  $("wxTemp").textContent = Math.round(cur.temperature_2m) + "°";
  $("wxDesc").textContent = wmoLabel(cur.weather_code);
  const mp = moonPhase();
  put($("wxSub"), (d ? `<span>${t("wx.max")} <b>${Math.round(d.temperature_2m_max[0])}°</b></span><span>${t("wx.min")} <b>${Math.round(d.temperature_2m_min[0])}°</b></span>` : "")
    + `<span>${t("wx.feels")} <b>${Math.round(cur.apparent_temperature)}°</b></span><span title="${mp.name} · ${mp.illum} %">${moonIcon(mp.p)}</span><span id="wxNormal"></span>`);
  renderOverviewWeather(); renderForecast(w); updateSky(); startAnim(); renderNormal(); renderWeatherTab();
}

/* The coming hours of the Overview, as many as the card is wide: the sky, the
   temperature, the rain when it is likely. Sunrise and sunset take their place in the
   row, at their hour, where the big curve of the sun used to stand. Returns the cells:
   [{ kind: "hour" | "rise" | "set", time, ... }]. */
export function hourCells(w, count, now = Date.now()) {
  const h = w.hourly, d = w.daily;
  if (!h || !h.time) return [];
  const k0 = hourIndex(h.time), cells = [];
  for (let i = k0 + 1; i < h.time.length && cells.length < count; i++) {
    cells.push({ kind: "hour", time: h.time[i], code: h.weather_code[i], temp: h.temperature_2m[i], rain: h.precipitation_probability[i] });
  }
  if (!cells.length) return cells;
  const from = h.time[k0], to = cells[cells.length - 1].time;
  const suns = [];
  for (let day = 0; d && day < 2 && day < d.time.length; day++) suns.push({ kind: "rise", time: d.sunrise[day] }, { kind: "set", time: d.sunset[day] });
  for (const s of suns) {
    if (!s.time || s.time <= from || s.time >= to || new Date(s.time).getTime() <= now) continue;
    // in the place of the hour it falls in, so the row keeps its length
    const at = cells.findIndex((c) => c.kind === "hour" && c.time.slice(0, 13) === s.time.slice(0, 13));
    if (at >= 0) cells[at] = s;
  }
  return cells;
}

export function renderOverviewWeather() {
  const w = state.weather[state.sel], el = $("hourStrip");
  if (!w || !el.clientWidth) return;
  const count = Math.max(4, Math.min(14, Math.floor(el.clientWidth / 70)));
  if (el._count === count && el._at === w.current.time && el._sel === state.sel) return;
  Object.assign(el, { _count: count, _at: w.current.time, _sel: state.sel });
  el.innerHTML = hourCells(w, count).map((c) => {
    if (c.kind !== "hour") return `<div class="hourCell sun"><span>${c.kind === "rise" ? t("sun.rise") : t("sun.set")}</span>${icon(c.kind === "rise" ? "sunrise" : "sunset")}<span class="tp num">${hm(c.time)}</span><span class="pp"></span></div>`;
    const hour = Number(c.time.slice(11, 13));
    return `<div class="hourCell"><span class="num">${t("hourFmt", hour)}</span>${weatherIcon(c.code, hour >= 7 && hour < 21 ? 1 : 0)}<span class="tp num">${Math.round(c.temp)}°</span><span class="pp num">${c.rain >= 30 ? c.rain + " %" : ""}</span></div>`;
  }).join("");
  queueFit();      // drawn after a fit, as its width decides the count: the block's height changed
}

// Next five days as ranges on one shared scale: the week's shape reads at a glance.
function renderForecast(w) {
  const d = w.daily;
  if (!d) return;
  const days = [1, 2, 3, 4, 5];
  const lo = Math.min(...days.map((i) => d.temperature_2m_min[i])), hi = Math.max(...days.map((i) => d.temperature_2m_max[i]));
  const pos = (v) => ((v - lo) / Math.max(1, hi - lo)) * 100;
  put($("forecast"), days.map((i) => {
    const mn = d.temperature_2m_min[i], mx = d.temperature_2m_max[i], pp = d.precipitation_probability_max[i];
    return `<div class="fcRow">
      <span class="d">${fmtDate(d.time[i] + "T12:00:00", { weekday: "short" })}</span>
      <span class="i">${weatherIcon(d.weather_code[i], 1)}</span>
      <span class="pp num">${pp >= 15 ? pp + " %" : ""}</span>
      <span class="mn num">${Math.round(mn)}°</span>
      <span class="track"><i style="left:${pos(mn)}%;width:${pos(mx) - pos(mn)}%"></i></span>
      <span class="mx num">${Math.round(mx)}°</span>
    </div>`;
  }).join(""));
}

// The same selector on the Overview and in the Weather tab: one selected city for the whole page.
export function renderCityTabs() {
  for (const id of ["cityTabs", "mtCities"]) {
    $(id).innerHTML = state.cities.map((c, i) => `<button type="button" class="${i === state.sel ? "active" : ""}" data-city="${i}">${esc(c.short || c.name)}</button>`).join("");
    $(id).onclick = (e) => { const b = e.target.closest("[data-city]"); if (b) selectCity(Number(b.dataset.city)); };
  }
}

function selectCity(i) {
  if (i === state.sel) return;
  state.sel = i; LS.set("vigie.city", i);
  renderCityTabs(); renderWeather(); renderAqi(); queueFit();
}

// Gap to the seasonal normal, for the selected city (one normal per city).
export function renderNormal() {
  const el = $("wxNormal");
  const n = state.energy && state.energy.normals && state.energy.normals[state.sel];
  const w = state.weather[state.sel];
  if (!el || !n || !w || !w.daily) return;
  const gap = Math.round((w.daily.temperature_2m_max[0] - n.maxNormal) * 10) / 10;
  const delta = `<b>${nb(Math.abs(gap), 1)}°</b>`;
  el.innerHTML = Math.abs(gap) < 0.5 ? t("wx.normal") : gap > 0 ? t("wx.aboveNormal", delta) : t("wx.belowNormal", delta);
}

/* ================= Weather tab =================
   One page: the city, its warnings, 48 hours, 7 days, then a row of tiles (air, pollen,
   UV, pressure). The radar and the snow are sub-views, opened by a button. No extra
   request: everything comes from the series already loaded for the Overview. */
let view = "main";
let snowy = false;                     // there is snow on the ground or coming at one of the spots
export const weatherViews = () => ["main", "radar"];
// The radar shows in the page itself when the layout found room for its block.
const radarInline = () => { const b = $("mtRadarInline"); return view === "main" && !b.hidden && !b.classList.contains("fitHide"); };
const radarWanted = () => !$("tabWeather").hidden && (view === "radar" || radarInline());
let radarBroken = false;
/* Called after each layout of the tab: the one map goes where it is shown, and is only
   loaded then. A radar that cannot load gives its room back instead of leaving a hole. */
function placeRadar() {
  const slot = view === "radar" ? $("radarHome") : radarInline() ? $("radarSlot") : null, map = $("radarMap");
  $("mtViews").hidden = radarInline();
  if (!slot) return;
  if (map.parentElement !== slot) { slot.appendChild(map); if (radarMap) radarMap.invalidateSize(); }
  if (!radarMap || !radarTimer) showRadar();
}
export function setWeatherView(v) {
  view = weatherViews().includes(v) ? v : "main";
  $("tabWeather").dataset.view = view;
  renderViewButtons();
  fitBox($("tabWeather"));
  placeRadar();
}
function renderViewButtons() {
  put($("mtViews"), `<button type="button" class="chip" data-wx-view="radar">${t("card.radar")}</button>`);
  if (!$("tabWeather")._placed) { $("tabWeather")._placed = true; $("tabWeather").addEventListener("fit", placeRadar); }
  $("tabWeather").onclick = (e) => { const b = e.target.closest("[data-wx-view]"); if (b) setWeatherView(b.dataset.wxView); };
}

function renderWeatherTab() {
  renderViewButtons();
  renderWarningsDetail();
  const w = state.weather[state.sel];
  if (!w || !w.current) { put($("mtNow"), `<div class="err">${t("wx.unavailable")}</div>`); return; }
  const cur = w.current, d = w.daily, h = w.hourly;
  const arrow = `<span class="windArrow" style="display:inline-block;transform:rotate(${(cur.wind_direction_10m + 180) % 360}deg)">${icon("arrow")}</span>`;
  const rain = d && d.precipitation_sum ? d.precipitation_sum[0] : null;
  put($("mtNow"), `<div class="wxNow"><div class="wxIcon">${weatherIcon(cur.weather_code, cur.is_day)}</div><div class="wxTemp num">${Math.round(cur.temperature_2m)}°</div>
      <div><div class="wxDesc">${wmoLabel(cur.weather_code)}</div><div class="wxSub">${d ? `<span>${t("wx.max")} <b>${Math.round(d.temperature_2m_max[0])}°</b></span><span>${t("wx.min")} <b>${Math.round(d.temperature_2m_min[0])}°</b></span>` : ""}</div></div></div>
    <div class="readouts">${[
      readout(t("wx.feels"), `${Math.round(cur.apparent_temperature)}°`),
      readout(t("wx.humidity"), `${Math.round(cur.relative_humidity_2m)}${small("%")}`),
      readout(t("wx.wind"), `${Math.round(cur.wind_speed_10m)}${small("km/h")}${arrow}`),
      readout(t("wx.gustsLabel"), `${Math.round(cur.wind_gusts_10m)}${small("km/h")}`),
      readout(t("wx.rainToday"), rain > 0 ? `${dec(rain)}${small("mm")}` : `<span class="word">${t("wx.none")}</span>`),
    ].join("")}</div>`);
  renderTiles();
  refreshPressure();
  if (!h || !h.time) { put($("mtHours"), `<div class="err">${t("hourly.unavailable")}</div>`); return; }
  const cityName = state.cities[state.sel].short;

  // --- 48 h, in as many columns as the card is wide: every 3 hours, or more when it is narrow
  const k0 = hourIndex(h.time), width = $("mtHours").clientWidth || 900;
  const count = Math.max(5, Math.min(16, Math.floor(width / 54))), every = Math.max(3, Math.ceil(48 / count));
  const cols = [];
  for (let i = k0; i < Math.min(h.time.length, k0 + 48) && cols.length < count; i += every) cols.push(i);
  const pmax = Math.max(...cols.map((i) => h.precipitation[i] || 0), 0.5);
  $("mtHourMeta").textContent = cityName;
  put($("mtHours"), `<div class="mtHourRow">${cols.map((i) => {
    const hour = Number(h.time[i].slice(11, 13));
    const mm = h.precipitation[i] || 0;
    return `<div class="mtH">
      <div class="hr num">${t("hourFmt", hour)}</div>
      <div class="ic">${weatherIcon(h.weather_code[i], hour >= 7 && hour < 21 ? 1 : 0)}</div>
      <div class="tp num">${Math.round(h.temperature_2m[i])}°</div>
      <div class="rain"><i style="height:${mm > 0 ? Math.max(3, (mm / pmax) * 22) : 0}px"></i></div>
      <div class="pp num${h.precipitation_probability[i] >= 40 ? " on" : ""}">${h.precipitation_probability[i]} %</div>
      <div class="vt num">${Math.round(h.wind_speed_10m[i])}</div>
    </div>`;
  }).join("")}</div>`);

  // the same 48 hours as a curve: temperature, rain as bars, wind as a dashed line
  const span = [];
  for (let i = k0; i < Math.min(h.time.length, k0 + 48); i++) span.push(i);
  if (span.length > 2) {
    const temps = span.map((i) => h.temperature_2m[i]), lo = Math.min(...temps), hi = Math.max(...temps), range = hi - lo || 1;
    const winds = span.map((i) => h.wind_speed_10m[i] || 0), wmax = Math.max(...winds, 10), rmax = Math.max(...span.map((i) => h.precipitation[i] || 0), 1);
    const H = 170, x = (n) => (n / (span.length - 1)) * 1000, line = (vals, f) => vals.map((v, n) => `${n ? "L" : "M"}${x(n).toFixed(1)} ${f(v).toFixed(1)}`).join("");
    const tp = line(temps, (v) => 10 + (1 - (v - lo) / range) * (H - 60));
    const label = (i) => { const d = new Date(h.time[i]); return `${fmtDate(d, { weekday: "short" })} ${t("hourFmt", d.getHours())}`; };
    put($("mtCurve"), `<div class="plot"><div class="chartSide"><span class="num">${Math.round(hi)}°</span><span class="num">${Math.round(lo)}°</span></div>
      <svg class="chart" viewBox="0 0 1000 ${H}" preserveAspectRatio="none" style="height:${H}px" aria-hidden="true">
        ${span.map((i, n) => { const mm = h.precipitation[i] || 0; return mm > 0 ? `<rect x="${(x(n) - 7).toFixed(1)}" y="${(H - (mm / rmax) * 46).toFixed(1)}" width="14" height="${((mm / rmax) * 46).toFixed(1)}" fill="var(--sky)" opacity=".75"/>` : ""; }).join("")}
        <path d="${line(winds, (v) => H - 4 - (v / wmax) * 40)}" fill="none" stroke="var(--ink-3)" stroke-width="1.5" stroke-dasharray="4 5" vector-effect="non-scaling-stroke"/>
        <path d="${tp}L1000 ${H}L0 ${H}Z" fill="var(--accent)" opacity=".10"/><path d="${tp}" fill="none" stroke="var(--accent)" stroke-width="2.5" vector-effect="non-scaling-stroke"/></svg></div>
      <div class="chartFeet"><span>${label(span[0])}</span><span>${label(span[Math.floor(span.length / 2)])}</span><span>${label(span[span.length - 1])}</span></div>
      <div class="chartLegend"><span><i></i>${t("curve.temp")}</span><span><i style="background:var(--sky)"></i>${t("curve.rain", dec(rmax, 1))}</span><span><i style="background:var(--ink-3)"></i>${t("curve.wind", Math.round(wmax))}</span></div>`);
  }

  // --- 7 days, with the fields the Overview leaves out. Rows of a list: on a short screen
  // the last days wait on its second page.
  if (!d) return;
  $("mtWeekMeta").textContent = cityName;
  const rows = [`<div class="wkRow head" data-keep><span>${t("week.day")}</span><span>${t("week.sky")}</span><span class="r">${t("week.minmax")}</span><span class="r">${t("week.rain")}</span><span class="r c5">${t("week.wind")}</span><span class="r c6">${t("week.uv")}</span><span class="r c7">${t("week.sun")}</span></div>`];
  for (let i = 0; i < d.time.length; i++) {
    const mm = d.precipitation_sum ? d.precipitation_sum[i] : null;
    const pp = d.precipitation_probability_max[i];
    rows.push(`<div class="wkRow">
      <span class="d${i === 0 ? " today" : ""}">${i === 0 ? t("today") : fmtDate(d.time[i] + "T12:00:00", { weekday: "long", day: "numeric", month: "short" })}</span>
      <span class="sky">${weatherIcon(d.weather_code[i], 1)}<span>${wmoLabel(d.weather_code[i])}</span></span>
      <span class="r num">${Math.round(d.temperature_2m_min[i])}° / <b>${Math.round(d.temperature_2m_max[i])}°</b></span>
      <span class="r num">${mm != null && mm > 0 ? dec(mm) + " mm" : "–"}${pp ? ` <span style="color:${pp >= 60 ? "var(--sky)" : "var(--ink-3)"}">${pp} %</span>` : ""}</span>
      <span class="r num c5">${Math.round(d.wind_speed_10m_max[i])} · ${Math.round(d.wind_gusts_10m_max[i])}</span>
      <span class="r num c6">${dec(d.uv_index_max[i])}</span>
      <span class="r num c7">${hm(d.sunrise[i])} / ${hm(d.sunset[i])}</span>
    </div>`);
  }
  put($("mtWeek"), rows.join(""));
  // the week as two lines, the lows and the highs, the band between them filled
  const n = d.time.length, mins = d.temperature_2m_min, maxs = d.temperature_2m_max, wlo = Math.min(...mins), whi = Math.max(...maxs), wr = whi - wlo || 1, WH = 110;
  const wx = (i) => 40 + (i / (n - 1)) * 920, wy = (v) => 22 + (1 - (v - wlo) / wr) * (WH - 44);
  const path = (vals) => vals.map((v, i) => `${i ? "L" : "M"}${wx(i).toFixed(1)} ${wy(v).toFixed(1)}`).join("");
  put($("mtWeekCurve"), `<svg class="chart" viewBox="0 0 1000 ${WH}" preserveAspectRatio="none" style="height:${WH}px" aria-hidden="true">
      <path d="${path(maxs)}${[...mins].map((v, i) => [i, v]).reverse().map(([i, v]) => `L${wx(i).toFixed(1)} ${wy(v).toFixed(1)}`).join("")}Z" fill="var(--accent)" opacity=".12"/>
      <path d="${path(maxs)}" fill="none" stroke="var(--accent)" stroke-width="2.5" vector-effect="non-scaling-stroke"/><path d="${path(mins)}" fill="none" stroke="var(--ink-3)" stroke-width="2" vector-effect="non-scaling-stroke"/></svg>
    <div class="weekFeet">${d.time.map((day, i) => `<span><b class="num">${Math.round(maxs[i])}°</b><small class="num">${Math.round(mins[i])}°</small><em>${i === 0 ? t("today") : fmtDate(day + "T12:00:00", { weekday: "short" })}</em></span>`).join("")}</div>`);
}

/* The row of tiles under the forecasts: air, pollen, UV and pressure of the selected
   city. A figure, a word, nothing more: the detail of a pollen season is not for a wall. */
let pressureTile = "";
function renderTiles() {
  const w = state.weather[state.sel], air = state.air && state.air[state.sel] && state.air[state.sel].current;
  const tile = (name, big, label, style = "") => `<div class="tile"><div class="nm">${name}</div><div class="big num"${style}>${big}</div><div class="lab">${label}</div></div>`;
  const out = [];
  if (air) {
    const v = Math.round(air.european_aqi), lv = aqiLevel(v);
    out.push(tile(t("card.air"), v, lv ? lv.label : "", lv ? ` style="color:${lv.color}"` : ""));
    const top = POLLENS.map((k) => ({ k, v: air[k] })).filter((p) => p.v >= 1).sort((a, b) => b.v - a.v)[0];
    out.push(top ? tile(t("pollen.line"), pollenLevel(top.v)[0], pollenName(top.k), ` style="color:${pollenLevel(top.v)[1]}"`) : tile(t("pollen.line"), "–", t("pollen.noneNow")));
  }
  if (w && w.hourly && w.daily) out.push(tile(t("wx.uv"), dec(w.hourly.uv_index[hourIndex(w.hourly.time)] || 0, 1), t("wx.uvOf", dec(w.daily.uv_index_max[0], 1))));
  put($("mtTiles"), out.join("") + pressureTile);
  // rich look: each pollutant with its figure, each pollen around with its level
  const kv = (k, v) => `<div><span class="k">${k}</span><span class="v num">${v}</span></div>`, ug = (v) => `${Math.round(v)} µg/m³`;
  put($("mtAirMore"), !air ? "" : [["PM2.5", air.pm2_5], ["PM10", air.pm10], ["NO₂", air.nitrogen_dioxide], ["O₃", air.ozone]].filter(([, v]) => v != null).map(([k, v]) => kv(k, ug(v))).join("")
    + POLLENS.filter((k) => air[k] >= 1).map((k) => kv(pollenName(k), `<span style="color:${pollenLevel(air[k])[1]}">${pollenLevel(air[k])[0]}</span>`)).join(""));
  $("mtAirMeta").textContent = air && state.cities[state.sel] ? state.cities[state.sel].short : "";
  $("mtTilesBlock").toggleAttribute("data-rich", !!air);
}

/* ================= Weather warnings ================= */
// "until Sat 06:00", without the day when the warning ends today
export function alertUntil(ts) {
  const d = new Date(ts);
  const time = t("hourShort", d.getHours(), String(d.getMinutes()).padStart(2, "0"));
  return t("alert.until", dayKey(d) === dayKey() ? time : `${fmtDate(d, { weekday: "short" })} ${time}`);
}

// The warnings in force. An orange or a red one is an alert of the page (alerts.js); all
// of them are listed in the Weather tab.
export async function refreshAlerts() {
  const list = await load("/alerts");
  if (!list) return;                      // keep the warnings already shown
  state.alerts = list;
  renderWarningsDetail();
}

function renderWarningsDetail() {
  const al = state.alerts;
  $("mtAlertCard").hidden = !al.length;
  put($("mtAlerts"), al.map((a) => `<div class="chgLine">
      <span class="t"><span class="pill ${a.severity}">${alertIcon(a.type)}${t("alert." + a.type)}</span></span>
      <span class="d">${t("warn.line", esc(a.area), t("sev." + a.severity))}${a.expires ? ` · ${alertUntil(a.expires)}` : ""}${a.description ? `<span class="warnDesc x2" data-clip>${esc(a.description)}</span>` : ""}</span>
    </div>`).join(""));
}

/* ================= Rain radar (sub-view of the Weather tab) =================
   Leaflet (CDN) and RainViewer tiles, no key. Nothing of it is fetched before the radar
   is asked for: the library, the map and the frames come with the first opening. Double buffering as in RainViewer's
   official example: the next frame loads into a hidden layer, then the opacity
   flips. No flicker, and not every frame in memory. */
let radarMap = null, radarBuf = [null, null], radarActiveBuf = 0;
let radarFrames = [], radarFrameIdx = 0, radarTimer = null, radarCenteredCity = -1, radarWaiting = false;

// The city and its surroundings, about 150 km across: the rain that matters in the
// next hours. The zoom follows from the width of the map.
const RADAR_WIDTH_KM = 150;
function centerRadar() {
  const c = state.cities[state.sel];
  const dLon = RADAR_WIDTH_KM / 2 / (111.32 * Math.cos(c.lat * Math.PI / 180));
  radarMap.fitBounds([[c.lat, c.lon - dLon], [c.lat, c.lon + dLon]]);
  radarCenteredCity = state.sel;
}
// RainViewer's free tiles stop at zoom 7 and answer with a "zoom not supported" picture
// beyond: Leaflet stretches the level 7 ones instead.
const RADAR_TILES = { opacity: 0, maxNativeZoom: 7 };

function initRadarMap() {
  radarMap = L.map("radarMap").setView([46, 2], 6);
  // CARTO's dark tiles now require an API key (watermarked otherwise). OSM stays
  // free, darkened with a CSS filter (baseDark class).
  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 19, className: "baseDark",
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
  }).addTo(radarMap);
  // Recenter on the selected city, as a Leaflet control like +/-.
  const RecenterCtl = L.Control.extend({
    options: { position: "topright" },
    onAdd() {
      const div = L.DomUtil.create("div", "leaflet-bar radarRecenterCtl");
      const a = L.DomUtil.create("a", "", div);
      a.href = "#"; a.title = t("radar.recenter"); a.innerHTML = "⌖";
      L.DomEvent.disableClickPropagation(div);
      L.DomEvent.on(a, "click", (e) => {
        L.DomEvent.preventDefault(e);
        centerRadar();
      });
      return div;
    },
  });
  new RecenterCtl().addTo(radarMap);
}

const LEAFLET = "https://unpkg.com/leaflet@1.9.4/dist/leaflet";
let leaflet = null;      // the library being loaded, once
function loadLeaflet() {
  if (leaflet) return leaflet;
  leaflet = new Promise((resolve) => {
    const css = Object.assign(document.createElement("link"), { rel: "stylesheet", href: LEAFLET + ".css", integrity: "sha256-p4NxAoJBhIIN+hmNHrzRCf9tD/miZyoHS5obTRR9BMY=", crossOrigin: "" });
    const js = Object.assign(document.createElement("script"), { src: LEAFLET + ".js", integrity: "sha256-20nQCchB9co0qIjJZRGuk2/Z9VM+kNiyxNV1lvTlZBo=", crossOrigin: "" });
    js.onload = () => resolve(true);
    js.onerror = () => { leaflet = null; resolve(false); };   // without network the rest of the page still works
    document.head.append(css, js);
  });
  return leaflet;
}
let radarAsked = false;
async function showRadar() {
  radarAsked = true;
  if (!(await loadLeaflet())) {
    $("radarMeta").textContent = t("radar.unavailable");
    if (!radarBroken) { radarBroken = true; $("mtRadarInline").hidden = true; queueFit(); }
    return;
  }
  if (!radarWanted()) return;
  renderRadarMap();
  radarMap.invalidateSize();
  centerRadar();
}

export async function refreshRadarFrames() {
  if (!radarAsked) return;
  const j = await load("https://api.rainviewer.com/public/weather-maps.json");
  const past = (j && j.radar && j.radar.past) || [];
  const nowcast = (j && j.radar && j.radar.nowcast) || [];
  radarFrames = past.map((f) => ({ time: f.time, path: f.path, forecast: false }))
    .concat(nowcast.map((f) => ({ time: f.time, path: f.path, forecast: true })));
  // On first render stepRadarAnim() may have seen an empty list and gone to sleep
  // for 5 min: wake it up as soon as the frames arrive.
  if (radarFrames.length && radarWaiting) { clearTimeout(radarTimer); radarTimer = null; stepRadarAnim(); }
}

const radarFrameUrl = (f) => `https://tilecache.rainviewer.com${f.path}/256/{z}/{x}/{y}/2/1_1.png`;

function stepRadarAnim() {
  // nobody looks at the radar: the animation stops, and starts again with the sub-view
  if (!radarWanted()) { radarTimer = null; return; }
  if (!radarFrames.length) { $("radarMeta").textContent = t("radar.unavailable"); radarWaiting = true; radarTimer = setTimeout(stepRadarAnim, 5 * 60 * 1000); return; }
  radarWaiting = false;
  if (!radarBuf[0]) {
    radarBuf[0] = L.tileLayer(radarFrameUrl(radarFrames[0]), RADAR_TILES).addTo(radarMap);
    radarBuf[1] = L.tileLayer(radarFrameUrl(radarFrames[0]), RADAR_TILES).addTo(radarMap);
  }
  const f = radarFrames[radarFrameIdx];
  const next = radarBuf[1 - radarActiveBuf];
  next.setUrl(radarFrameUrl(f));
  next.setOpacity(1); radarBuf[radarActiveBuf].setOpacity(0);
  radarActiveBuf = 1 - radarActiveBuf;
  $("radarMeta").textContent = $("radarMetaInline").textContent = fmtTime(f.time * 1000) + (f.forecast ? t("radar.forecast") : "");
  const last = radarFrameIdx === radarFrames.length - 1;
  radarFrameIdx = (radarFrameIdx + 1) % radarFrames.length;
  radarTimer = setTimeout(stepRadarAnim, last ? 2800 : 900);
}

// Follows the selected city without overriding a manual zoom on every weather refresh.
function renderRadarMap() {
  if (!radarMap) initRadarMap();
  // a hidden map has no width to fit the bounds in: centered when the tab shows
  if (radarCenteredCity !== state.sel && radarMap.getSize().x) centerRadar();
  if (!radarFrames.length) refreshRadarFrames();
  if (!radarTimer) stepRadarAnim();
}

// The map is created while its tab is hidden: it only learns its real size once shown.
/* ---- Pressure (Weather tab) ----
   The tendency is the change over 3 hours, the meteorologists' interval. Below 1 hPa it
   says nothing, from 3.5 hPa a change of weather is close. */
export function pressureTrend(now, before) {
  const delta = Math.round((now - before) * 10) / 10;
  const a = Math.abs(delta);
  const kind = a < 1 ? "steady" : delta > 0 ? (a >= 3.5 ? "risingFast" : "rising") : (a >= 3.5 ? "fallingFast" : "falling");
  return { delta, kind };
}

// Its own request with the day before: the main series starts at midnight, too late
// for a tendency at 1 am.
let pressureCache = { key: null, at: 0, hourly: null };
async function refreshPressure() {
  const c = state.cities[state.sel];
  if (!c || $("tabWeather").hidden) return;
  const key = c.lat + "," + c.lon;
  if (pressureCache.key !== key || Date.now() - pressureCache.at > 15 * 60 * 1000) {
    const u = new URL("https://api.open-meteo.com/v1/forecast");
    u.search = new URLSearchParams({ latitude: c.lat, longitude: c.lon, hourly: "pressure_msl", past_days: "1", forecast_days: "2", timezone: "auto" });
    const j = await load(u.toString());
    if (!j || !j.hourly) { pressureTile = ""; return renderTiles(); }
    pressureCache = { key, at: Date.now(), hourly: j.hourly };
  }
  renderPressure(pressureCache.hourly);
}

const TREND_TURN = { steady: 90, rising: 45, risingFast: 45, falling: 135, fallingFast: 135 };
function renderPressure(h) {
  const p = h.pressure_msl, i = hourIndex(h.time);
  if (i < 3 || p[i] == null || p[i - 3] == null) pressureTile = "";
  else {
    const tr = pressureTrend(p[i], p[i - 3]);
    pressureTile = `<div class="tile"><div class="nm">${t("card.pressure")}</div>
      <div class="big num">${Math.round(p[i])}${small("hPa")}<span class="trendArrow" style="transform:rotate(${TREND_TURN[tr.kind]}deg)">${icon("arrow")}</span></div>
      <div class="lab">${t("pressure." + tr.kind)}, ${t("pressure.delta", (tr.delta > 0 ? "+" : "") + dec(tr.delta))}</div></div>`;
  }
  renderTiles();
  queueFit();
}

export function onWeatherTabShown() {
  renderWeatherTab();
  placeRadar();
  if (radarMap && !radarTimer && radarWanted()) stepRadarAnim();
}

/* ================= Air quality and pollen ================= */
const AQI_STEPS = [[20, "#50f0e6"], [40, "#50ccaa"], [60, "#f0e641"], [80, "#ff5050"], [100, "#ce4b78"], [999, "#b455e0"]];
const aqiLevel = (v) => { const i = AQI_STEPS.findIndex((x) => v <= x[0]); return i < 0 ? null : { label: t("aqi")[i], color: AQI_STEPS[i][1] }; };
const POLLENS = ["alder_pollen", "birch_pollen", "grass_pollen", "mugwort_pollen", "olive_pollen", "ragweed_pollen"];
const pollenName = (k) => t("pollen.names")[POLLENS.indexOf(k)];
const pollenLevel = (v) => v >= 60 ? [t("pollen.high"), COL.bad] : v >= 25 ? [t("pollen.moderate"), COL.warn] : [t("pollen.low"), "var(--mint)"];

/* Good or fair air everywhere and no pollen: nothing to act on, the Overview card gives
   way to one line in the weather card. 40 is the top of "fair" on the European index. */
const AQI_CALM_MAX = 40;
export function airIsCalm(values, pollens) {
  const known = values.filter((v) => v != null);
  return known.length > 0 && !pollens && known.every((v) => v <= AQI_CALM_MAX);
}

export async function refreshAqi() {
  // Pollutants, pollen and a 4 day forecast for every city: one call per city serves
  // the Overview and the Weather tab.
  const pol = POLLENS.join(",");
  const rs = await Promise.all(state.cities.map((c) => load(`https://air-quality-api.open-meteo.com/v1/air-quality?latitude=${c.lat}&longitude=${c.lon}`
    + `&current=european_aqi,pm2_5,pm10,nitrogen_dioxide,ozone,${pol}&hourly=${pol}&forecast_days=4&timezone=auto`)));
  if (!rs.some(Boolean)) { $("airLine").hidden = true; return; }
  state.air = rs;
  renderAqi();
}

/* One line at the bottom of the Overview's weather card, worded after the worst city:
   quiet while the air is good or fair everywhere and no pollen is around, and saying
   what is wrong otherwise. The figures are in the tiles of the Weather tab. */
function renderAqi() {
  const rs = state.air;
  if (!rs) return;
  const p0 = rs[0] && rs[0].current;
  const active = p0 ? POLLENS.map((k) => ({ k, v: p0[k] })).filter((p) => p.v >= 1).sort((a, b) => b.v - a.v).slice(0, 3) : [];
  state.pollenSummary = active.map((p) => `${pollenName(p.k)} ${pollenLevel(p.v)[0]}`);
  if (p0) { const v = Math.round(p0.european_aqi), l = aqiLevel(v); state.aqiSummary = l ? `${l.label} (${v})` : null; }
  const values = rs.map((r) => r && r.current ? Math.round(r.current.european_aqi) : null);
  const known = values.filter((v) => v != null);
  $("airLine").hidden = !known.length;
  if (known.length) {
    const top = Math.max(...known), level = aqiLevel(top), city = state.cities[values.indexOf(top)];
    $("airLine").classList.toggle("dim", airIsCalm(values, active.length));
    $("airLine").textContent = airIsCalm(values, active.length) ? t("air.calm", level.label)
      : [t("air.worst", level.label, top, city.short), ...state.pollenSummary].join(" · ");
  }
  renderTiles();
}

/* ================= Snow (Weather tab) =================
   `elevation` is set to the spot's altitude: without it Open-Meteo answers for the
   mean altitude of its grid cell, valley floor included, and underestimates snow.
   It is a weather model, not the ski resort report. */
/* Which spots to show, from the list in the order of the config. Without snow anywhere
   only the main spot (the first one) stays, for its 0 °C level and what is expected.
   Otherwise the spots with snow on the ground or coming, the deepest on top. */
export function snowRows(spots) {
  const snowy = spots.filter((s) => s.cm > 0 || s.total > 0).sort((a, b) => b.cm - a.cm || b.total - a.total);
  return snowy.length ? { top: snowy[0], list: snowy.slice(1) } : { top: spots[0], list: [] };
}

export async function refreshSnow() {
  const spots = state.cfg.snowSpots;
  if (!spots.length) return;
  const rs = await Promise.all(spots.map((s) => load(`https://api.open-meteo.com/v1/forecast?latitude=${s.lat}&longitude=${s.lon}`
    + (s.alt ? `&elevation=${s.alt}` : "") + "&hourly=snow_depth,temperature_2m,freezing_level_height&daily=snowfall_sum&timezone=auto&forecast_days=5")));
  const top = $("snowTop"), list = $("snowList"), meta = $("snowMeta");
  if (!rs.some(Boolean)) {
    top.innerHTML = ""; meta.textContent = "";
    list.innerHTML = `<div class="err">${t("snow.unavailable")}</div>`;
    return;
  }
  const data = rs.map((r, i) => {
    const h = (r && r.hourly) || {}, d = (r && r.daily) || {};
    const k = hourIndex(h.time);
    return {
      name: spots[i].name, alt: spots[i].alt || null,
      cm: Math.round(((h.snow_depth || [])[k] || 0) * 100),            // snow_depth is in meters
      total: Math.round((d.snowfall_sum || []).slice(0, 5).reduce((a, b) => a + (b || 0), 0)),
      temp: (h.temperature_2m || [])[k],
      iso: (h.freezing_level_height || [])[k],
    };
  });

  const tp = (v) => v == null ? "–" : `${Math.round(v)}°`;
  const { top: f, list: others } = snowRows(data);
  // the sub-view is only offered with snow on the ground or coming
  const was = snowy;
  snowy = data.some((s) => s.cm > 0 || s.total > 0);
  if (was !== snowy) { $("snowCard").hidden = !snowy; queueFit(); }
  meta.textContent = f.iso != null ? t("snow.isotherm", nb(Math.round(f.iso))) : "";
  top.innerHTML = `<div class="snowTop">
    <div class="ic">${icon(f.cm ? "snowflake" : "mountain")}</div>
    <div>
      <div class="nm">${esc(f.name)}${f.alt ? " · " + f.alt + " m" : ""}</div>
      <div class="d num">${f.cm}${small("cm")}</div>
      <div class="sub">${t("snow.onSite", tp(f.temp))}</div>
    </div>
    <div class="right">${f.total > 0 ? t("snow.coming", f.total) : t("snow.noFall")}</div>
  </div>`;
  const ref = Math.max(...data.map((s) => s.cm), 1);
  list.innerHTML = others.map((s) => `<div class="snowLine">
    <div class="name">${esc(s.name)}</div>
    <div class="alt num">${s.alt ? s.alt + " m" : ""}</div>
    <div class="snowBar"><i style="width:${Math.round((s.cm / ref) * 100)}%"></i></div>
    <div class="cm num">${s.cm} cm</div>
    <div class="tp num">${tp(s.temp)}</div>
    <div class="nx${s.total > 0 ? "" : " none"}">${s.total > 0 ? "+" + s.total + " cm" : "–"}</div>
  </div>`).join("");
}

/* ================= Weather animations (rain / snow) =================
   A few drops over the weather card, at 15 images a second: enough for rain, a quarter of
   what the screen would draw. Only while it can be seen and looked at: not on another tab,
   not with the window in the background (the kiosk, while one works on the other screen),
   not at night, never when the system asks for less motion. */
const ANIM_FPS = 15;
let animRAF = null, animTimer = 0;
const stillMotion = typeof matchMedia === "function" ? matchMedia("(prefers-reduced-motion: reduce)") : { matches: true, addEventListener() {} };
function stopAnim() { cancelAnimationFrame(animRAF); clearTimeout(animTimer); animRAF = null; animTimer = 0; }
let animWired = false;
function wireAnim() {
  if (animWired) return;
  animWired = true;
  for (const [target, type] of [[window, "focus"], [window, "blur"], [document, "visibilitychange"]]) target.addEventListener(type, () => startAnim());
  stillMotion.addEventListener("change", () => startAnim());
}
export function startAnim() {
  wireAnim();
  const c = state.curCode;
  const rain = isRainy(c), snow = isSnowy(c);
  const cv = $("wxAnim");
  stopAnim();
  const ctx = cv.getContext("2d");
  const card = $("wxCard");
  const wanted = (rain || snow) && !$("tabOverview").hidden && card.clientWidth && !document.hidden && document.hasFocus()
    && !document.getElementById("nightVeil") && !stillMotion.matches;
  if (!wanted) { ctx.clearRect(0, 0, cv.width, cv.height); return; }
  cv.width = card.clientWidth; cv.height = card.clientHeight;
  const particles = Array.from({ length: rain ? 60 : 40 }, () => ({
    x: Math.random() * cv.width, y: Math.random() * cv.height,
    v: rain ? 3 + Math.random() * 4 : 0.4 + Math.random() * 0.7,
    l: rain ? 8 + Math.random() * 10 : 1.5 + Math.random() * 2,
    drift: (Math.random() - 0.5) * (snow ? 0.6 : 0.15),
  }));
  // v and drift are speeds per frame at 60 Hz, scaled by the time elapsed
  let lastT = null;
  const step = (ts) => {
    animRAF = null;
    const k = lastT != null ? Math.min(ts - lastT, 200) / (1000 / 60) : 1;
    lastT = ts;
    ctx.clearRect(0, 0, cv.width, cv.height);
    ctx.strokeStyle = "rgba(160,200,255,.35)"; ctx.fillStyle = "rgba(230,240,255,.5)"; ctx.lineWidth = 1;
    ctx.beginPath();
    for (const p of particles) {
      if (rain) { ctx.moveTo(p.x, p.y); ctx.lineTo(p.x + p.drift * 4, p.y + p.l); }
      else { ctx.moveTo(p.x + p.l, p.y); ctx.arc(p.x, p.y, p.l, 0, 7); }
      p.y += p.v * k; p.x += p.drift * k;
      if (p.y > cv.height) { p.y = -10; p.x = Math.random() * cv.width; }
      if (p.x > cv.width) p.x = 0;
      if (p.x < 0) p.x = cv.width;
    }
    if (rain) ctx.stroke(); else ctx.fill();
    animTimer = setTimeout(() => { animTimer = 0; animRAF = requestAnimationFrame(step); }, 1000 / ANIM_FPS);
  };
  animRAF = requestAnimationFrame(step);
}
