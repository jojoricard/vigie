/* Weather: the horizon instrument, the Overview card, the Weather tab, rain radar,
   air quality, pollen, snow and warnings. The page calls Open-Meteo directly, with
   timezone=auto so the hourly series follow each city's local time. */
import { $, LS, state, esc, small, readout, load, COL } from "./core.js";
import { t, dec, nb, fmtDate, fmtTime } from "./i18n.js";
import { weatherIcon, moonIcon, icon, alertIcon } from "./icons.js";
import { solarElevation, sunPath, lightBands } from "./sun.js";

export const WMO_CODES = [0, 1, 2, 3, 45, 48, 51, 53, 55, 56, 57, 61, 63, 65, 66, 67, 71, 73, 75, 77, 80, 81, 82, 85, 86, 95, 96, 99];
export const wmoLabel = (code) => WMO_CODES.includes(code) ? t("wmo." + code) : "–";
// WMO code families, shared by the background and the particle animation
const isRainy = (c) => (c >= 51 && c <= 67) || (c >= 80 && c <= 82) || c >= 95;
const isSnowy = (c) => (c >= 71 && c <= 77) || c === 85 || c === 86;
const windDir = (d) => t("windDirs")[Math.round(((d % 360) / 45)) % 8];
const hm = (iso) => iso ? iso.slice(11, 16) : "–";
const minutesOf = (iso) => Number(iso.slice(11, 13)) * 60 + Number(iso.slice(14, 16));

// Index of the current hour in an hourly.time array (local time of the place).
function hourIndex(times) {
  if (!Array.isArray(times) || !times.length) return 0;
  const now = Date.now();
  let i = 0;
  while (i + 1 < times.length && new Date(times[i + 1]).getTime() <= now) i++;
  return i;
}

/* Temperature to color, on fixed stops: the same 18° has the same color every day,
   so a range bar can be read without its numbers. */
const TEMP_STOPS = [[-10, [168, 216, 255]], [0, [108, 197, 255]], [10, [95, 214, 166]], [18, [229, 211, 107]], [25, [242, 180, 76]], [33, [255, 122, 114]]];
function tempColor(v) {
  if (v <= TEMP_STOPS[0][0]) return `rgb(${TEMP_STOPS[0][1]})`;
  for (let i = 1; i < TEMP_STOPS.length; i++) {
    const [t1, c1] = TEMP_STOPS[i];
    if (v <= t1) {
      const [t0, c0] = TEMP_STOPS[i - 1];
      const k = (v - t0) / (t1 - t0);
      return `rgb(${c0.map((x, j) => Math.round(x + (c1[j] - x) * k)).join(",")})`;
    }
  }
  return `rgb(${TEMP_STOPS[TEMP_STOPS.length - 1][1]})`;
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

/* ================= Horizon instrument =================
   The real sun elevation over the local day of the selected city: solid above the
   horizon, dotted below, the marker is the sun now. The x axis is the city's clock,
   midnight to midnight, graduated hour by hour. */
function moonPhase() {
  const syn = 29.53058867;
  const ref = Date.UTC(2000, 0, 6, 18, 14) / 86400000;
  const p = (((Date.now() / 86400000 - ref) % syn) / syn + 1) % 1;
  const i = Math.floor(((p + 1 / 16) % 1) * 8);   // eight named phases centered on their date
  return { p, name: t("moon")[i], illum: Math.round((1 - Math.cos(2 * Math.PI * p)) / 2 * 100) };
}

export function renderHorizon() {
  const el = $("horizon");
  const w = state.weather[state.sel], c = state.cities[state.sel];
  if (!w || !w.daily || w.utc_offset_seconds == null) { el.innerHTML = ""; return; }
  const midnight = Date.parse(w.daily.time[0] + "T00:00:00Z") - w.utc_offset_seconds * 1000;
  // 104 px tall drawing, horizon at 74: about 0.93 px per degree above it, the night
  // part flattened below so it stays clear of the hour marks, even in winter.
  const H0 = 74;
  const Y = (e) => (e > 0 ? H0 - e * 0.93 : H0 - e * 0.25);
  const X = (m) => (m / 1440) * 1000;
  const pts = sunPath(midnight, c.lat, c.lon, 10);
  // runs of points on the same side of the horizon
  const runs = [];
  for (const p of pts) {
    const up = p.el >= 0;
    if (!runs.length || runs[runs.length - 1].up !== up) runs.push({ up, pts: [] });
    runs[runs.length - 1].pts.push(p);
  }
  const line = (r) => r.pts.map((p, i) => `${i ? "L" : "M"}${X(p.m).toFixed(1)} ${Y(p.el).toFixed(1)}`).join("");
  const day = runs.filter((r) => r.up);
  const fills = day.map((r) => `<path class="hzFill" d="M${X(r.pts[0].m).toFixed(1)} ${H0}${line(r).replace(/^M/, "L")}L${X(r.pts[r.pts.length - 1].m).toFixed(1)} ${H0}Z"/>`).join("");
  let ticks = "";
  for (let hr = 0; hr <= 24; hr++) {
    const major = hr % 6 === 0;
    ticks += `<path class="hzTick${major ? " major" : ""}" d="M${X(hr * 60)} ${H0}V${H0 + (major ? 9 : 5)}"/>`;
  }
  const nowMin = Math.min(1440, Math.max(0, (Date.now() - midnight) / 60000));
  const nowEl = solarElevation(Date.now(), c.lat, c.lon);
  // golden and blue hours, as soft bands behind the curve, brightest on the horizon
  const bands = lightBands(midnight, c.lat, c.lon).map((b) =>
    `<rect class="hzBand ${b.kind}" x="${X(b.from).toFixed(1)}" y="0" width="${(X(b.to + 5) - X(b.from)).toFixed(1)}" height="104"/>`).join("");
  const glow = (id, color, peak) => `<linearGradient id="${id}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" style="stop-color:var(${color});stop-opacity:0"/><stop offset="${(H0 / 104).toFixed(2)}" style="stop-color:var(${color});stop-opacity:${peak}"/><stop offset="1" style="stop-color:var(${color});stop-opacity:.04"/></linearGradient>`;
  const svg = `<svg viewBox="0 0 1000 104" preserveAspectRatio="none" aria-hidden="true">
    <defs><linearGradient id="hzGrad" x1="0" y1="0" x2="0" y2="1"><stop offset="0" style="stop-color:var(--amber);stop-opacity:.26"/><stop offset="1" style="stop-color:var(--amber);stop-opacity:0"/></linearGradient>${glow("hzGold", "--amber", 0.22)}${glow("hzBlue", "--sky", 0.28)}</defs>
    ${bands}
    ${fills}
    ${runs.filter((r) => !r.up).map((r) => `<path class="hzNight" vector-effect="non-scaling-stroke" d="${line(r)}"/>`).join("")}
    ${day.map((r) => `<path class="hzDay" vector-effect="non-scaling-stroke" d="${line(r)}"/>`).join("")}
    <path class="hzLine" vector-effect="non-scaling-stroke" d="M0 ${H0}H1000"/>
    <g vector-effect="non-scaling-stroke">${ticks}</g>
    <path class="hzNow" vector-effect="non-scaling-stroke" d="M${X(nowMin).toFixed(1)} 0V${H0}"/>
  </svg>`;
  // The sun marker is HTML: a circle drawn in a stretched SVG would turn oval.
  const sun = `<i class="hzSun${nowEl < 0 ? " night" : ""}" style="left:${(nowMin / 14.4).toFixed(2)}%;top:${Y(nowEl).toFixed(1)}px"></i>`;
  const rise = w.daily.sunrise[0], set = w.daily.sunset[0];
  let labels = "";
  if (rise && set) {
    const r = minutesOf(rise), s = minutesOf(set), len = w.daily.daylight_duration[0];
    labels = `<div class="hzLabel" style="left:${r / 14.4}%">${t("sun.rise")} <b>${hm(rise)}</b></div>
      <div class="hzLabel center" style="left:${(r + s) / 2 / 14.4}%">${t("sun.daylight", Math.floor(len / 3600), String(Math.round((len % 3600) / 60)).padStart(2, "0"))}</div>
      <div class="hzLabel" style="left:${s / 14.4}%">${t("sun.set")} <b>${hm(set)}</b></div>`;
  }
  // hour marks under the major ticks, the same in every language
  const hours = [0, 6, 12, 18, 24].map((hr) => `<div class="hzHour${hr === 0 ? " first" : hr === 24 ? " last" : ""}" style="left:${hr / 24 * 100}%">${String(hr).padStart(2, "0")}</div>`).join("");
  const mp = moonPhase();
  el.innerHTML = svg + sun + hours + labels + `<div class="hzMoon"><span>${mp.name} · ${mp.illum} %</span>${moonIcon(mp.p)}</div>`;
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
  $("wxIcon").innerHTML = weatherIcon(cur.weather_code, cur.is_day);
  $("wxTemp").textContent = Math.round(cur.temperature_2m) + "°";
  $("wxDesc").textContent = wmoLabel(cur.weather_code);
  $("wxSub").innerHTML = (d ? `<span>${t("wx.max")} <b>${Math.round(d.temperature_2m_max[0])}°</b></span><span>${t("wx.min")} <b>${Math.round(d.temperature_2m_min[0])}°</b></span>` : "")
    + `<span id="wxNormal"></span>`;
  const uvNow = w.hourly ? dec(w.hourly.uv_index[hourIndex(w.hourly.time)] || 0, 1) : "–";
  // the arrow points where the wind goes, the words say where it comes from
  const arrow = `<span class="windArrow" style="display:inline-block;transform:rotate(${(cur.wind_direction_10m + 180) % 360}deg)">${icon("arrow")}</span>`;
  const rainToday = d && d.precipitation_sum ? d.precipitation_sum[0] : null;
  $("wxReadouts").innerHTML = [
    readout(t("wx.feels"), `${Math.round(cur.apparent_temperature)}°`),
    readout(t("wx.humidity"), `${cur.relative_humidity_2m}${small("%")}`),
    readout(t("wx.wind"), `${Math.round(cur.wind_speed_10m)}${small("km/h")}${arrow}`, windDir(cur.wind_direction_10m)),
    readout(t("wx.gustsLabel"), `${Math.round(cur.wind_gusts_10m)}${small("km/h")}`),
    readout(t("wx.uv"), `${uvNow}${d ? small("/ " + Math.round(d.uv_index_max[0])) : ""}`),
    readout(t("wx.rainToday"), rainToday > 0 ? `${dec(rainToday)}${small("mm")}` : `<span class="word">${t("wx.none")}</span>`, d ? `${d.precipitation_probability_max[0]} %` : ""),
  ].join("");
  renderRain(w); renderForecast(w); renderHorizon(); updateSky(); startAnim(); renderNormal(); renderWeatherTab();
}

function renderRain(w) {
  const wrap = $("rainWrap"), el = $("rainBars");
  const m = w.minutely_15;
  if (!m || !m.time) { wrap.hidden = true; return; }
  const now = Date.now();
  let start = m.time.findIndex((x) => new Date(x).getTime() >= now - 15 * 60000);
  if (start < 0) start = 0;
  const vals = m.precipitation.slice(start, start + 8);
  const times = m.time.slice(start, start + 8);
  // Nothing in the next two hours: the line disappears, the readouts already say it.
  if (vals.reduce((a, b) => a + b, 0) < 0.05) { wrap.hidden = true; return; }
  wrap.hidden = false;
  $("rainLbl").innerHTML = `${icon("umbrella")}${t("rain.label")}`;
  const max = Math.max(...vals, 0.4);
  el.innerHTML = vals.map((v, i) => `<div class="b"><div class="bar" style="height:${Math.max(2, Math.round((v / max) * 30))}px;opacity:${v > 0 ? 1 : 0.25}"></div><div class="h">${times[i].slice(11, 16)}</div></div>`).join("");
}

// Next five days as ranges on one shared scale: the week's shape reads at a glance.
function renderForecast(w) {
  const d = w.daily;
  if (!d) return;
  const days = [1, 2, 3, 4, 5];
  const lo = Math.min(...days.map((i) => d.temperature_2m_min[i])), hi = Math.max(...days.map((i) => d.temperature_2m_max[i]));
  const pos = (v) => ((v - lo) / Math.max(1, hi - lo)) * 100;
  $("forecast").innerHTML = days.map((i) => {
    const mn = d.temperature_2m_min[i], mx = d.temperature_2m_max[i], pp = d.precipitation_probability_max[i];
    return `<div class="fcRow">
      <span class="d">${fmtDate(d.time[i] + "T12:00:00", { weekday: "short" })}</span>
      <span class="i">${weatherIcon(d.weather_code[i], 1)}</span>
      <span class="pp num">${pp >= 15 ? pp + " %" : ""}</span>
      <span class="mn num">${Math.round(mn)}°</span>
      <span class="track"><i style="left:${pos(mn)}%;width:${pos(mx) - pos(mn)}%;background:linear-gradient(90deg,${tempColor(mn)},${tempColor(mx)})"></i></span>
      <span class="mx num">${Math.round(mx)}°</span>
    </div>`;
  }).join("");
}

export function renderCityTabs() {
  $("cityTabs").innerHTML = state.cities.map((c, i) => `<button class="${i === state.sel ? "active" : ""}" data-city="${i}">${esc(c.short || c.name)}</button>`).join("");
  $("cityTabs").querySelectorAll("button").forEach((b) => b.onclick = () => selectCity(Number(b.dataset.city)));
}

function selectCity(i) {
  if (i === state.sel) return;
  state.sel = i; LS.set("vigie.city", i);
  renderCityTabs(); renderWeather();
}

// Gap to the seasonal normal, for the selected city (one normal per city).
export function renderNormal() {
  const el = $("wxNormal");
  const n = state.energy && state.energy.normals && state.energy.normals[state.sel];
  const w = state.weather[state.sel];
  if (!el || !n || !w || !w.daily) return;
  const gap = Math.round((w.daily.temperature_2m_max[0] - n.maxNormal) * 10) / 10;
  const col = Math.abs(gap) < 2 ? "var(--ink-2)" : gap > 0 ? COL.bad : "var(--sky)";
  const delta = `<b style="color:${col}">${nb(Math.abs(gap), 1)}°</b>`;
  el.innerHTML = Math.abs(gap) < 0.5 ? t("wx.normal") : gap > 0 ? t("wx.aboveNormal", delta) : t("wx.belowNormal", delta);
}

/* ================= Weather tab =================
   No extra request: everything comes from the series already loaded for the Overview. */
function renderWeatherTab() {
  // Clickable cities: the rest of the tab follows the selected one. Same state as
  // the Overview, so the two screens can't disagree.
  $("mtCities").innerHTML = state.cities.map((c, i) => {
    const w = state.weather[i];
    if (!w || !w.current) return `<div class="mtCity" data-city="${i}"><div class="nm">${esc(c.short)}</div><div class="err">–</div></div>`;
    const cur = w.current, d = w.daily;
    const kv = (k, v) => `<div><span class="k">${k}</span><span class="v num">${v}</span></div>`;
    const rain = d && d.precipitation_sum ? d.precipitation_sum[0] : null;
    return `<div class="mtCity${i === state.sel ? " on" : ""}" data-city="${i}">
      <div class="nm">${esc(c.short)}</div>
      <div class="hd">
        ${weatherIcon(cur.weather_code, cur.is_day)}
        <span class="tp num">${Math.round(cur.temperature_2m)}°</span>
        <span class="mm num">${d ? `${Math.round(d.temperature_2m_max[0])}° / ${Math.round(d.temperature_2m_min[0])}°` : ""}</span>
      </div>
      <div class="desc">${wmoLabel(cur.weather_code)}</div>
      <div class="det">
        ${kv(t("wx.feels"), Math.round(cur.apparent_temperature) + "°")}
        ${kv(t("wx.humidity"), Math.round(cur.relative_humidity_2m) + " %")}
        ${kv(t("wx.wind"), Math.round(cur.wind_speed_10m) + " km/h")}
        ${kv(t("wx.gustsLabel"), Math.round(cur.wind_gusts_10m) + " km/h")}
        ${kv(t("wx.rainToday"), rain != null && rain > 0 ? dec(rain) + " mm" : t("wx.none"))}
        ${kv(t("wx.uvMax"), d ? dec(d.uv_index_max[0]) : "–")}
      </div>
    </div>`;
  }).join("");
  document.querySelectorAll("#mtCities .mtCity").forEach((el) => el.onclick = () => selectCity(Number(el.dataset.city)));

  renderWarningsDetail();
  renderRadarMap();
  renderWeatherAir();
  refreshPressure();

  const w = state.weather[state.sel];
  const h = w && w.hourly;
  if (!h || !h.time) { $("mtHours").innerHTML = `<div class="err">${t("hourly.unavailable")}</div>`; return; }
  const cityName = state.cities[state.sel].short;

  // --- 48 h in 3 h steps
  const k0 = hourIndex(h.time);
  const cols = [];
  for (let i = k0; i < Math.min(h.time.length, k0 + 48); i += 3) cols.push(i);
  const pmax = Math.max(...cols.map((i) => h.precipitation[i] || 0), 0.5);
  $("mtHourMeta").textContent = cityName;
  $("mtHours").innerHTML = `<div class="mtHourRow">${cols.map((i) => {
    const hour = Number(h.time[i].slice(11, 13));
    const mm = h.precipitation[i] || 0;
    return `<div class="mtH">
      <div class="hr num">${t("hourFmt", hour)}</div>
      <div class="ic">${weatherIcon(h.weather_code[i], hour >= 7 && hour < 21 ? 1 : 0)}</div>
      <div class="tp num">${Math.round(h.temperature_2m[i])}°</div>
      <div class="rain"><i style="height:${mm > 0 ? Math.max(3, (mm / pmax) * 26) : 0}px"></i></div>
      <div class="pp num${h.precipitation_probability[i] >= 40 ? " on" : ""}">${h.precipitation_probability[i]} %</div>
      <div class="vt num">${Math.round(h.wind_speed_10m[i])}</div>
    </div>`;
  }).join("")}</div>
  <div class="mtLeg">${t("hourly.legend")}</div>`;

  // --- 7 days, with the fields the Overview strip leaves out
  const d = w.daily;
  if (!d) return;
  $("mtWeekMeta").textContent = cityName;
  const rows = [`<tr class="pHead"><td>${t("week.day")}</td><td>${t("week.sky")}</td><td class="r">${t("week.minmax")}</td><td class="r">${t("week.rain")}</td><td class="r">${t("week.wind")}</td><td class="r">${t("week.uv")}</td><td class="r">${t("week.sun")}</td></tr>`];
  for (let i = 0; i < d.time.length; i++) {
    const mm = d.precipitation_sum ? d.precipitation_sum[i] : null;
    const pp = d.precipitation_probability_max[i];
    rows.push(`<tr>
      <td${i === 0 ? ' class="today"' : ""}>${i === 0 ? t("today") : fmtDate(d.time[i] + "T12:00:00", { weekday: "long", day: "numeric", month: "short" })}</td>
      <td class="muted">${weatherIcon(d.weather_code[i], 1)}${wmoLabel(d.weather_code[i])}</td>
      <td class="r num">${Math.round(d.temperature_2m_min[i])}° / <b>${Math.round(d.temperature_2m_max[i])}°</b></td>
      <td class="r num">${mm != null && mm > 0 ? dec(mm) + " mm" : "–"}${pp ? ` <span style="color:${pp >= 60 ? "var(--sky)" : "var(--ink-3)"}">${pp} %</span>` : ""}</td>
      <td class="r num">${Math.round(d.wind_speed_10m_max[i])} · ${Math.round(d.wind_gusts_10m_max[i])}</td>
      <td class="r num">${dec(d.uv_index_max[i])}</td>
      <td class="r num">${hm(d.sunrise[i])} / ${hm(d.sunset[i])}</td>
    </tr>`);
  }
  $("mtWeek").innerHTML = rows.join("");
}

/* ================= Weather warnings ================= */
export async function refreshAlerts() {
  const list = await load("/alerts");
  if (!list) return;                      // keep the warnings already shown
  state.alerts = list;
  // compact badges in the hero, grouped by area: nothing shown when there is none
  const byArea = {};
  for (const a of list) (byArea[a.area] = byArea[a.area] || []).push(a);
  $("alertsList").innerHTML = Object.entries(byArea).map(([area, items]) =>
    `<div class="warnGroup"><span class="area">${esc(area)}</span>` +
    items.map((i) => `<span class="pill ${i.severity}">${alertIcon(i.type)}${t("alert." + i.type)}</span>`).join("") + `</div>`).join("");
  renderWarningsDetail();
}

function renderWarningsDetail() {
  const al = state.alerts;
  $("mtAlertCard").hidden = !al.length;
  $("mtAlerts").innerHTML = al.map((a) => `<div class="chgLine">
      <span class="t"><span class="pill ${a.severity}">${alertIcon(a.type)}${t("alert." + a.type)}</span></span>
      <span class="d">${t("warn.line", esc(a.area), t("sev." + a.severity))}</span>
    </div>`).join("");
}

/* ================= Rain radar (Weather tab) =================
   Leaflet (CDN) and RainViewer tiles, no key. Double buffering as in RainViewer's
   official example: the next frame loads into a hidden layer, then the opacity
   flips. No flicker, and not every frame in memory. */
let radarMap = null, radarBuf = [null, null], radarActiveBuf = 0;
let radarFrames = [], radarFrameIdx = 0, radarTimer = null, radarCenteredCity = -1, radarWaiting = false;

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
        const c = state.cities[state.sel];
        radarMap.setView([c.lat, c.lon], 7);
      });
      return div;
    },
  });
  new RecenterCtl().addTo(radarMap);
}

export async function refreshRadarFrames() {
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
  if (!radarFrames.length) { $("radarMeta").textContent = t("radar.unavailable"); radarWaiting = true; radarTimer = setTimeout(stepRadarAnim, 5 * 60 * 1000); return; }
  radarWaiting = false;
  if (!radarBuf[0]) {
    radarBuf[0] = L.tileLayer(radarFrameUrl(radarFrames[0]), { opacity: 0 }).addTo(radarMap);
    radarBuf[1] = L.tileLayer(radarFrameUrl(radarFrames[0]), { opacity: 0 }).addTo(radarMap);
  }
  const f = radarFrames[radarFrameIdx];
  const next = radarBuf[1 - radarActiveBuf];
  next.setUrl(radarFrameUrl(f));
  next.setOpacity(1); radarBuf[radarActiveBuf].setOpacity(0);
  radarActiveBuf = 1 - radarActiveBuf;
  $("radarMeta").textContent = fmtTime(f.time * 1000) + (f.forecast ? t("radar.forecast") : "");
  const last = radarFrameIdx === radarFrames.length - 1;
  radarFrameIdx = (radarFrameIdx + 1) % radarFrames.length;
  radarTimer = setTimeout(stepRadarAnim, last ? 2800 : 900);
}

// Follows the selected city without overriding a manual zoom on every weather refresh.
function renderRadarMap() {
  // Leaflet comes from a CDN: without network the rest of the page still works.
  if (typeof L === "undefined") { $("radarMeta").textContent = t("radar.unavailable"); return; }
  if (!radarMap) initRadarMap();
  if (radarCenteredCity !== state.sel) {
    const c = state.cities[state.sel];
    radarMap.setView([c.lat, c.lon], 7);
    radarCenteredCity = state.sel;
  }
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
  if (!c) return;
  const key = c.lat + "," + c.lon;
  if (pressureCache.key !== key || Date.now() - pressureCache.at > 15 * 60 * 1000) {
    const u = new URL("https://api.open-meteo.com/v1/forecast");
    u.search = new URLSearchParams({ latitude: c.lat, longitude: c.lon, hourly: "pressure_msl", past_days: "1", forecast_days: "2", timezone: "auto" });
    const j = await load(u.toString());
    if (!j || !j.hourly) { $("pressureCard").hidden = true; return; }
    pressureCache = { key, at: Date.now(), hourly: j.hourly };
  }
  renderPressure(pressureCache.hourly, c);
}

const TREND_TURN = { steady: 90, rising: 45, risingFast: 45, falling: 135, fallingFast: 135 };
function renderPressure(h, c) {
  const p = h.pressure_msl, i = hourIndex(h.time);
  if (i < 3 || p[i] == null || p[i - 3] == null) { $("pressureCard").hidden = true; return; }
  const tr = pressureTrend(p[i], p[i - 3]);
  // the last 24 h and the next 24 h, on a scale fitted to them
  const from = Math.max(0, i - 24), to = Math.min(p.length - 1, i + 24);
  const vs = p.slice(from, to + 1);
  const lo = Math.min(...vs.filter((v) => v != null)) - 1, hi = Math.max(...vs.filter((v) => v != null)) + 1;
  const X = (k) => ((k - from) / (to - from)) * 480, Y = (v) => 70 - ((v - lo) / (hi - lo)) * 64;
  const line = vs.map((v, k) => v == null ? "" : `${k && vs[k - 1] != null ? "L" : "M"}${X(from + k).toFixed(1)} ${Y(v).toFixed(1)}`).join("");
  $("pressureMeta").textContent = c.short;
  $("pressureBody").innerHTML = `<div class="pressNow">
      <div class="v num">${Math.round(p[i])}${small("hPa")}</div>
      <div class="s${tr.kind.endsWith("Fast") ? " fast" : ""}"><span class="trendArrow" style="transform:rotate(${TREND_TURN[tr.kind]}deg)">${icon("arrow")}</span>${t("pressure." + tr.kind)}, ${t("pressure.delta", (tr.delta > 0 ? "+" : "") + dec(tr.delta))}</div>
    </div>
    <div class="pressChart">
      <svg viewBox="0 0 480 76" preserveAspectRatio="none" aria-hidden="true">
        <path class="line" vector-effect="non-scaling-stroke" d="${line}"/>
        <path class="now" vector-effect="non-scaling-stroke" d="M${X(i).toFixed(1)} 0V76"/>
      </svg>
      <div class="axis"><span>${t("pressure.past")}</span><span>${t("pressure.now")}</span><span>${t("pressure.next")}</span></div>
    </div>`;
  $("pressureCard").hidden = false;
}

export function onWeatherTabShown() { if (radarMap) radarMap.invalidateSize(); }

/* ================= Air quality and pollen ================= */
const AQI_STEPS = [[20, "#50f0e6"], [40, "#50ccaa"], [60, "#f0e641"], [80, "#ff5050"], [100, "#ce4b78"], [999, "#b455e0"]];
const aqiLevel = (v) => { const i = AQI_STEPS.findIndex((x) => v <= x[0]); return i < 0 ? null : { label: t("aqi")[i], color: AQI_STEPS[i][1] }; };
const POLLENS = ["alder_pollen", "birch_pollen", "grass_pollen", "mugwort_pollen", "olive_pollen", "ragweed_pollen"];
const pollenName = (k) => t("pollen.names")[POLLENS.indexOf(k)];
const pollenLevel = (v) => v >= 60 ? [t("pollen.high"), COL.bad] : v >= 25 ? [t("pollen.moderate"), COL.warn] : [t("pollen.low"), "var(--mint)"];

export async function refreshAqi() {
  // Pollutants, pollen and a 4 day forecast for every city: one call per city serves
  // the Overview and the Weather tab.
  const pol = POLLENS.join(",");
  const rs = await Promise.all(state.cities.map((c) => load(`https://air-quality-api.open-meteo.com/v1/air-quality?latitude=${c.lat}&longitude=${c.lon}`
    + `&current=european_aqi,pm2_5,pm10,nitrogen_dioxide,ozone,${pol}&hourly=${pol}&forecast_days=4&timezone=auto`)));
  if (!rs.some(Boolean)) { $("aqiRow").innerHTML = `<div class="err">${t("unavailable")}</div>`; return; }
  state.air = rs;
  renderAqi();
  renderWeatherAir();
}

// One readout per city, with its place on the 0–100 European index.
function renderAqi() {
  const rs = state.air;
  const p0 = rs[0] && rs[0].current;
  const active = p0 ? POLLENS.map((k) => ({ k, v: p0[k] })).filter((p) => p.v >= 1).sort((a, b) => b.v - a.v).slice(0, 3) : [];
  state.pollenSummary = active.map((p) => `${pollenName(p.k)} ${pollenLevel(p.v)[0]}`);
  if (p0) { const v = Math.round(p0.european_aqi), l = aqiLevel(v); state.aqiSummary = l ? `${l.label} (${v})` : null; }
  $("pollenLine").hidden = !active.length;
  $("pollenLine").innerHTML = icon("pollen") + `<span>${t("pollen.line")}</span>` + active.map((p) => {
    const [lab, col] = pollenLevel(p.v);
    return `<span>${pollenName(p.k)} <b style="color:${col}">${lab}</b></span>`;
  }).join("");
  $("aqiRow").innerHTML = rs.map((r, i) => {
    const v = r && r.current ? Math.round(r.current.european_aqi) : null;
    const lv = v != null ? aqiLevel(v) : null;
    if (!lv) return readout(esc(state.cities[i].short), "–");
    const scale = `<div class="track aqiScale"><span class="mark" style="left:${Math.min(100, v)}%"></span></div>`;
    return readout(esc(state.cities[i].short), `<span style="color:${lv.color}">${v}</span>`, `${lv.label}${scale}`);
  }).join("");
}

/* Air and pollen details of the Weather tab, no extra request. Above all the pollen
   forecast: for an allergy, knowing it rises tomorrow helps more than seeing today. */
function renderWeatherAir() {
  const rs = state.air;
  if (!rs) return;
  $("mtAirMeta").textContent = state.cities[state.sel].short;
  const pol = (v, u) => v == null ? "–" : `${Math.round(v)} ${small(u)}`;
  $("mtAir").innerHTML = `<div class="triRow">${rs.map((r, i) => {
    const c = r && r.current;
    if (!c) return `<div class="tile"><div class="nm">${esc(state.cities[i].short)}</div><div class="err">–</div></div>`;
    const v = Math.round(c.european_aqi), lv = aqiLevel(v);
    return `<div class="tile">
      <div class="nm">${esc(state.cities[i].short)}</div>
      <div class="big num" style="color:${lv ? lv.color : "inherit"}">${v}</div>
      <div class="lab" style="color:${lv ? lv.color : "inherit"}">${lv ? lv.label : ""}</div>
      <div class="det">
        <div><span class="k">PM2.5</span><span class="v num">${pol(c.pm2_5, "µg/m³")}</span></div>
        <div><span class="k">PM10</span><span class="v num">${pol(c.pm10, "µg/m³")}</span></div>
        <div><span class="k">NO₂</span><span class="v num">${pol(c.nitrogen_dioxide, "µg/m³")}</span></div>
        <div><span class="k">O₃</span><span class="v num">${pol(c.ozone, "µg/m³")}</span></div>
      </div>
    </div>`;
  }).join("")}</div>`;

  // --- 4 day pollen forecast for the selected city
  const h = rs[state.sel] && rs[state.sel].hourly;
  if (!h || !h.time) { $("mtPollens").innerHTML = ""; return; }
  // maximum per day and species: the peak triggers an allergy, not the average of a
  // day half spent at night
  const days = [];
  for (let i = 0; i < h.time.length; i++) {
    const d = h.time[i].slice(0, 10);
    let e = days.find((x) => x.d === d);
    if (!e) days.push(e = { d, max: {} });
    for (const k of POLLENS) {
      const v = h[k] ? h[k][i] : null;
      if (v != null && (e.max[k] == null || v > e.max[k])) e.max[k] = v;
    }
  }
  const actives = POLLENS.filter((k) => days.some((d) => (d.max[k] || 0) >= 1));
  if (!actives.length) { $("mtPollens").innerHTML = `<div class="mtLeg gap">${t("pollen.none")}</div>`; return; }
  const head = days.map((d, i) => `<td class="r">${i === 0 ? t("pollen.today") : fmtDate(d.d + "T12:00:00", { weekday: "short" })}</td>`).join("");
  const rows = actives.map((k) => `<tr><td>${pollenName(k)}</td>${days.map((d) => {
    const v = d.max[k] || 0;
    if (v < 1) return '<td class="r dim">–</td>';
    const [lab, col] = pollenLevel(v);
    return `<td class="r num" style="color:${col}">${lab} <span class="count">${Math.round(v)}</span></td>`;
  }).join("")}</tr>`).join("");
  $("mtPollens").innerHTML = `<h2 class="sub">${t("pollen.title")}</h2>
    <table><tr class="pHead"><td>${t("pollen.species")}</td>${head}</tr>${rows}</table>
    <div class="mtLeg left">${t("pollen.legend")}</div>`;
}

/* ================= Snow (Weather tab) =================
   `elevation` is set to the spot's altitude: without it Open-Meteo answers for the
   mean altitude of its grid cell, valley floor included, and underestimates snow.
   It is a weather model, not the ski resort report. */
export async function refreshSnow() {
  const spots = state.cfg.snowSpots;
  $("snowCard").hidden = !spots.length;
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
  }).sort((a, b) => b.cm - a.cm || b.total - a.total);

  const tp = (v) => v == null ? "–" : `${Math.round(v)}°`;
  meta.textContent = data[0].iso != null ? t("snow.isotherm", nb(Math.round(data[0].iso))) : "";
  // Off season, rows of zeros say nothing: one sentence is enough.
  if (!data[0].cm && !data[0].total) {
    top.innerHTML = `<div class="snowTop"><div class="ic">${icon("mountain")}</div><div>
      <div class="d text">${t("snow.none")}</div>
      <div class="sub">${t("snow.noneDetail", data.length)}</div></div></div>`;
    list.innerHTML = "";
    return;
  }
  const f = data[0];
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
  list.innerHTML = data.slice(1).map((s) => `<div class="snowLine">
    <div class="name">${esc(s.name)}</div>
    <div class="alt num">${s.alt ? s.alt + " m" : ""}</div>
    <div class="snowBar"><i style="width:${Math.round((s.cm / ref) * 100)}%"></i></div>
    <div class="cm num">${s.cm} cm</div>
    <div class="tp num">${tp(s.temp)}</div>
    <div class="nx${s.total > 0 ? "" : " none"}">${s.total > 0 ? "+" + s.total + " cm" : "–"}</div>
  </div>`).join("");
}

/* ================= Weather animations (rain / snow) ================= */
let animRAF = null;
export function startAnim() {
  const c = state.curCode;
  const rain = isRainy(c), snow = isSnowy(c);
  const cv = $("wxAnim");
  cancelAnimationFrame(animRAF);
  const ctx = cv.getContext("2d");
  if (!rain && !snow) { ctx.clearRect(0, 0, cv.width, cv.height); return; }
  const card = $("wxCard");
  cv.width = card.clientWidth; cv.height = card.clientHeight;
  const particles = Array.from({ length: rain ? 60 : 40 }, () => ({
    x: Math.random() * cv.width, y: Math.random() * cv.height,
    v: rain ? 3 + Math.random() * 4 : 0.4 + Math.random() * 0.7,
    l: rain ? 8 + Math.random() * 10 : 1.5 + Math.random() * 2,
    drift: (Math.random() - 0.5) * (snow ? 0.6 : 0.15),
  }));
  // v and drift are speeds per frame at 60 Hz: without scaling by elapsed time, rain
  // would fall 2.4 times faster on a 144 Hz screen.
  let lastT = null;
  const step = (ts) => {
    const k = lastT != null ? Math.min(ts - lastT, 100) / (1000 / 60) : 1;
    lastT = ts;
    ctx.clearRect(0, 0, cv.width, cv.height);
    ctx.strokeStyle = "rgba(160,200,255,.35)"; ctx.fillStyle = "rgba(230,240,255,.5)"; ctx.lineWidth = 1;
    for (const p of particles) {
      ctx.beginPath();
      if (rain) { ctx.moveTo(p.x, p.y); ctx.lineTo(p.x + p.drift * 4, p.y + p.l); ctx.stroke(); }
      else { ctx.arc(p.x, p.y, p.l, 0, 7); ctx.fill(); }
      p.y += p.v * k; p.x += p.drift * k;
      if (p.y > cv.height) { p.y = -10; p.x = Math.random() * cv.width; }
      if (p.x > cv.width) p.x = 0;
      if (p.x < 0) p.x = cv.width;
    }
    animRAF = requestAnimationFrame(step);
  };
  animRAF = requestAnimationFrame(step);
}
