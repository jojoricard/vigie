/* AI briefing: the page builds the context, the agent calls the model once a day.
   The context is split in two: what the screen already shows (not to repeat) and
   what to analyze to bring something new. */
import { $, state, getJson, FetchError, DAY_MS } from "./core.js";
import { t, fmtDate, fmtTime, dayKey } from "./i18n.js";
import { wmoLabel } from "./weather.js";
import { changeText } from "./machine.js";
import { monthName } from "./energy.js";

let doneFor = null;

function machineContext() {
  const c = state.crashCounts || {};
  const m = {};
  if (c.last != null) m.daysWithoutIncident = Math.floor((Date.now() - c.last) / DAY_MS);
  if (c.d7 != null) m.incidentsThisWeek = c.d7;
  if (c.natures && (c.natures.freeze || c.natures.cut)) m.splitOver30Days = c.natures;
  // Only the titles of the breaks are on screen: the model can comment on them and
  // draw a consequence, not copy them.
  if (state.changes.length) m.detectedBreaks = state.changes.map((x) => { const tx = changeText(x); return `${tx.title}: ${tx.detail}`; });
  return Object.keys(m).length ? m : null;
}

function recentIncident() {
  if (!state.lastCrash || Date.now() - state.lastCrash.at >= DAY_MS) return null;
  const d = new Date(state.lastCrash.at);
  const day = d.toDateString() === new Date().toDateString() ? t("today.lower") : t("yesterday.lower");
  return { type: t("incidentLong." + state.lastCrash.type), when: t("crash.at", day, fmtTime(d)) };
}

function electricityContext() {
  const m = state.energy && state.energy.consumption.monthly;
  if (!m || !m.projection) return null;
  return {
    endOfMonthProjectionKwh: Math.round(m.projection * 10) / 10,
    previousMonthKwh: m.previous ? Math.round(m.previous.kwh * 10) / 10 : null,
    previousMonth: m.previous ? monthName(m.previous.month) : null,
  };
}

export async function maybeBriefing() {
  const today = dayKey();
  if (!state.cfg.hasBriefing || doneFor === today) return;
  const w0 = state.weather[0];
  if (!w0) return;
  const d0 = w0.daily;
  const ctx = {
    date: today,
    alreadyShown: {
      note: "Already visible on the dashboard, do not repeat",
      currentTemp: Math.round(w0.current.temperature_2m),
      maxToday: Math.round(d0.temperature_2m_max[0]),
      sky: wmoLabel(w0.current.weather_code),
      warnings: state.alerts.map((a) => `${t("alert." + a.type)} ${t("sev." + a.severity)} (${a.area})`),
      pollen: state.pollenSummary,
      nameDay: state.nameDay || null,
      airQuality: state.aqiSummary,
    },
    toAnalyze: {
      // next 5 days, to see what is coming (weather turning, rain arriving, heatwave ending)
      nextDays: d0.time.slice(1, 6).map((day, i) => ({
        day: fmtDate(day + "T12:00:00", { weekday: "long" }),
        max: Math.round(d0.temperature_2m_max[i + 1]),
        min: Math.round(d0.temperature_2m_min[i + 1]),
        rainChance: d0.precipitation_probability_max[i + 1],
        sky: wmoLabel(d0.weather_code[i + 1]),
      })),
      lowTonight: Math.round(d0.temperature_2m_min[0]),
      rainChanceToday: d0.precipitation_probability_max[0],
      otherCities: state.weather.slice(1).map((w, i) => w ? { name: state.cities[i + 1].short, max: Math.round(w.daily.temperature_2m_max[0]) } : null).filter(Boolean),
      recentIncident: recentIncident(),
      machine: machineContext(),
      electricity: electricityContext(),
    },
  };
  let j;
  try {
    j = await getJson("/briefing", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(ctx) });
  } catch (e) {
    if (!(e instanceof FetchError)) throw e;
    console.warn("Vigie:", e.message);
    return;
  }
  if (!j.text) return;
  $("briefing").textContent = j.text;
  $("briefing").hidden = false;
  doneFor = today;
}
