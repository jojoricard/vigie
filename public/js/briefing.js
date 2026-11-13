/* AI briefing: the page builds the context and posts it after every refresh that can
   change it. The agent decides whether the model is called again (new time slot, new
   event, rate guard) and answers with the text to show.
   The context is split in two: what the screen already shows (not to repeat) and
   what to analyze to bring something new. */
import { $, state, esc, getJson, FetchError, DAY_MS, DAIKIN_VALUES } from "./core.js";
import { t, fmtDate, fmtTime, dayKey } from "./i18n.js";
import { wmoLabel, hourIndex } from "./weather.js";
import { changeText, since } from "./machine.js";
import { monthName } from "./energy.js";

const HOURS_AHEAD = 12, SOON_HOURS = 3, CLOSE_DAYS = 7;

// A field without data is left out rather than sent empty: the model comments on what it sees.
const isEmpty = (v) => v == null || v === "" || (typeof v === "object" && !Object.keys(v).length);
const compact = (o) => Object.fromEntries(Object.entries(o).filter(([, v]) => !isEmpty(v)));

/* The 12 hours after the current one, from Open-Meteo's hourly series. Rain,
   probability and gusts cover the hour before their timestamp, so they are labelled
   with the hour they start at. Temperatures are instantaneous.
   Rain comes as spells with their hours and millimetres, without any probability: the
   model quoted the day's one, already on screen, instead of saying when and how much. */
export function hourlySummary(h, k0, cfg) {
  const idx = [];
  for (let i = k0 + 1; i <= k0 + HOURS_AHEAD && i < h.time.length; i++) idx.push(i);
  if (!idx.length) return null;
  const hour = (i) => h.time[i].slice(11, 16);
  const mm = (is) => Math.round(is.reduce((s, i) => s + h.precipitation[i], 0) * 10) / 10;
  const spells = [];
  for (const i of idx.filter((i) => h.precipitation_probability[i] > cfg.rainHourPct)) {
    const last = spells[spells.length - 1];
    if (last && last[last.length - 1] === i - 1) last.push(i); else spells.push([i]);
  }
  const soon = idx.slice(0, SOON_HOURS).find((i) => h.precipitation_probability[i] >= cfg.rainSoonPct);
  return compact({
    temperatures: idx.map((i) => ({ at: hour(i), temp: Math.round(h.temperature_2m[i]) })),
    rain: spells.map((is) => ({
      from: hour(is[0] - 1), to: hour(is[is.length - 1]), mm: mm(is),
      peakMmPerHour: Math.max(...is.map((i) => h.precipitation[i])),
      // WMO codes grow with severity: the highest one tells rain from a thunderstorm or hail
      sky: wmoLabel(Math.max(...is.map((i) => h.weather_code[i]))),
    })),
    // without a spell the trace amounts are not worth a sentence
    rainTotalMm: spells.length ? mm(idx) : null,
    gusts: idx.filter((i) => h.wind_gusts_10m[i] > cfg.gustKmh).map((i) => ({ from: hour(i - 1), kmh: Math.round(h.wind_gusts_10m[i]) })),
    // its presence is what makes the agent write a new text right away
    rainSoon: soon == null ? null : { from: hour(soon - 1) },
  });
}

// Nothing at all without an incident this week or a detected break: given a quiet
// machine, the model fills a sentence with "11 days without incident, nothing to report".
function machineContext() {
  const c = state.crashCounts || {};
  const m = {};
  if (!(c.d7 > 0) && !state.changes.length) return m;
  if (c.last != null) m.daysWithoutIncident = Math.floor((Date.now() - c.last) / DAY_MS);
  if (c.d7 != null) m.incidentsThisWeek = c.d7;
  if (c.natures && (c.natures.freeze || c.natures.cut)) m.splitOver30Days = c.natures;
  // Only the titles of the breaks are on screen: the model can comment on them and
  // draw a consequence, not copy them.
  if (state.changes.length) m.detectedBreaks = state.changes.map((x) => { const tx = changeText(x); return `${tx.title}: ${tx.detail}`; });
  return m;
}

function recentIncident() {
  if (!state.lastCrash || Date.now() - state.lastCrash.at >= DAY_MS) return null;
  const d = new Date(state.lastCrash.at);
  const day = d.toDateString() === new Date().toDateString() ? t("today.lower") : t("yesterday.lower");
  // `at` identifies the incident for the agent: `when` changes wording at midnight
  return { type: t("incidentLong." + state.lastCrash.type), when: t("crash.at", day, fmtTime(d)), at: state.lastCrash.at };
}

// Only a projection clearly off from the previous month: the gap itself is on the Electricity card.
function electricityContext(cfg) {
  const m = state.energy && state.energy.consumption.monthly;
  if (!m || !m.projection || !m.previous || !(m.previous.kwh > 0.01)) return null;
  const gapPct = Math.round((m.projection / m.previous.kwh - 1) * 100);
  if (Math.abs(gapPct) < cfg.electricityGapPct) return null;
  return {
    endOfMonthProjectionKwh: Math.round(m.projection * 10) / 10,
    previousMonthKwh: Math.round(m.previous.kwh * 10) / 10,
    previousMonth: monthName(m.previous.month),
    gapPct,
  };
}

// Only a white or red day tomorrow: told that tomorrow is blue, the model writes that
// there is nothing to do.
function tempoContext() {
  const e = state.energy;
  if (!e || !e.tempoTomorrow || e.tempoTomorrow.code === 1) return null;
  const names = t("tempo.colors");
  return compact({ today: e.tempo ? names[e.tempo.code] : null, tomorrow: names[e.tempoTomorrow.code] });
}

function holidaysContext() {
  const h = state.holidays;
  if (!h) return null;
  const date = (key) => fmtDate(key + "T12:00:00", { weekday: "long", day: "numeric", month: "long" });
  const inDays = (key) => Math.round((Date.parse(key + "T12:00:00") - Date.parse(dayKey() + "T12:00:00")) / DAY_MS);
  const p = h.publicHoliday, s = h.school;
  let school = null;
  if (s && s.ongoing) school = { name: t("break." + s.code), ongoing: true, lastDay: date(s.lastDay) };
  else if (s && inDays(s.start) <= CLOSE_DAYS) school = { name: t("break." + s.code), startsInDays: inDays(s.start), firstDay: date(s.start) };
  return compact({
    publicHoliday: p ? { name: t("pub." + p.code), date: date(p.date), inDays: inDays(p.date) } : null,
    schoolBreak: school,
  });
}

function networkContext() {
  const n = state.network;
  // same thresholds as the Network card: 20 readings to speak, 1 % of losses to worry
  return n && n.samples >= 20 && n.loss > 1 ? { lossPct24h: n.loss, failingNow: n.failingNow } : null;
}

/* Only the units running against the weather: heating while it is warm outside, cooling
   while it is cold. Neither the room temperature nor the target is sent: the Daikin
   probes read 3 to 5 °C too high, by a varying amount, and the model advised turning
   off a heating that was needed. */
const DAIKIN_COOL = "3", DAIKIN_HEAT = "4";
function houseContext(cfg) {
  const outdoor = state.weather[0].current.temperature_2m;
  const units = ((state.house && state.house.daikin) || [])
    .filter((u) => u.reachable && u.on && ((u.mode === DAIKIN_HEAT && outdoor > cfg.acHeatAboveC) || (u.mode === DAIKIN_COOL && outdoor < cfg.acCoolBelowC)))
    .map((u) => ({ room: u.name, mode: t("daikin.mode")[DAIKIN_VALUES.mode.indexOf(u.mode)], running: true }));
  return units.length ? { outdoorTemp: Math.round(outdoor), airConditioners: units } : null;
}

// Only a fuel whose cheapest price moved by fuelDeltaEur or more since the reference day.
function fuelContext(cfg) {
  return (state.fuel || []).map((f) => {
    if (!f.stations.length || !f.previous) return null;
    const change = Math.round((f.stations[0].price - f.previous.price) * 1000) / 1000;
    if (Math.abs(change) < cfg.fuelDeltaEur) return null;
    return { fuel: t("fuel." + f.type), pricePerLitre: f.stations[0].price, change, since: fmtDate(f.previous.date + "T12:00:00", { weekday: "long", day: "numeric", month: "long" }) };
  }).filter(Boolean);
}

export function buildContext() {
  const w0 = state.weather[0];
  if (!w0) return null;
  const d0 = w0.daily, cfg = state.cfg.briefing;
  return {
    date: dayKey(),
    alreadyShown: compact({
      note: "Already visible on the dashboard, do not repeat",
      currentTemp: Math.round(w0.current.temperature_2m),
      maxToday: Math.round(d0.temperature_2m_max[0]),
      sky: wmoLabel(w0.current.weather_code),
      // without their level: the pill shows it, and the model only repeated it
      warnings: state.alerts.map((a) => `${t("alert." + a.type)} (${a.area})`),
      pollen: state.pollenSummary,
      nameDay: state.nameDay,
      airQuality: state.aqiSummary,
      rainChanceToday: d0.precipitation_probability_max[0],
    }),
    toAnalyze: compact({
      next12h: w0.hourly ? hourlySummary(w0.hourly, hourIndex(w0.hourly.time), cfg) : null,
      // next 5 days, to see what is coming (weather turning, rain arriving, heatwave ending)
      nextDays: d0.time.slice(1, 6).map((day, i) => ({
        day: fmtDate(day + "T12:00:00", { weekday: "long" }),
        max: Math.round(d0.temperature_2m_max[i + 1]),
        min: Math.round(d0.temperature_2m_min[i + 1]),
        rainChance: d0.precipitation_probability_max[i + 1],
        sky: wmoLabel(d0.weather_code[i + 1]),
      })),
      otherCities: state.weather.slice(1).map((w, i) => w ? { name: state.cities[i + 1].short, max: Math.round(w.daily.temperature_2m_max[0]) } : null).filter(Boolean),
      tempo: tempoContext(),
      holidays: holidaysContext(),
      servicesDown: (state.services || []).filter((s) => s.state === "down" || s.state === "error")
        .map((s) => ({ name: s.name, state: s.state, since: since(s.since) })),
      network: networkContext(),
      house: houseContext(cfg),
      fuel: fuelContext(cfg),
      recentIncident: recentIncident(),
      machine: machineContext(),
      electricity: electricityContext(cfg),
    }),
  };
}

/* Figures with their unit and day names in medium weight, so the eye lands on when and
   how much. The text is escaped first and the pattern runs on the escaped text: nothing
   written by the model reaches innerHTML as markup. The lookbehind keeps the digits of
   an entity (&#39;) out. */
export function emphasize(text) {
  const days = [5, 6, 7, 8, 9, 10, 11].map((d) => fmtDate(new Date(2026, 0, d), { weekday: "long" })).join("|");
  const figure = "(?<![#\\w])\\d+(?:[.,]\\d+)?\\s?(?:°C|°|mm|km/h|%|h(?:\\s?\\d{2})?)(?![\\p{L}\\d])";
  return esc(text).replace(new RegExp(`${figure}|(?<![\\p{L}])(?:${days})(?![\\p{L}])`, "giu"), "<b>$&</b>");
}

async function sendBriefing() {
  const ctx = buildContext();
  if (!ctx) return;
  let j;
  try {
    j = await getJson("/briefing", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(ctx) });
  } catch (e) {
    if (!(e instanceof FetchError)) throw e;
    console.warn("Vigie:", e.message);
    return;
  }
  if (j.error) console.warn("Vigie: briefing:", j.error);
  // No text for today: yesterday's must not stay on screen.
  $("briefing").innerHTML = j.text ? emphasize(j.text) : "";
  $("briefing").hidden = !j.text;
  $("briefMeta").textContent = j.text ? t("brief.head", j.at ? fmtTime(j.at) : "") : "";
  $("briefMeta").hidden = !j.text;
  $("briefBlock").classList.toggle("hasText", !!j.text);
}

/* Called after each refresh the briefing depends on. At startup they all land within
   seconds: one request goes out once they have settled, so the first text of the day
   is not written before the incidents and the warnings have arrived. */
let timer = null;
export function queueBriefing() {
  if (!state.cfg.hasBriefing) return;
  clearTimeout(timer);
  timer = setTimeout(sendBriefing, 8000);
}
