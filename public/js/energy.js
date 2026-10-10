/* Electricity card: consumption, plus Tempo and grid carbon in France. Tempo is
   EDF's daily price color. Carbon comes from éCO2mix (RTE) and turns the machine's
   real consumption into an emission estimate. */
import { $, state, small, readout, load, COL } from "./core.js";
import { t, dec, nb, fmtDate, LOCALE } from "./i18n.js";
import { renderNormal } from "./weather.js";
import { icon } from "./icons.js";

const TEMPO_COL = { 1: "#60a5fa", 2: "#e6e6ef", 3: "#ff6b6b" };
const carbonLevel = (g) => { const i = g <= 40 ? 0 : g <= 70 ? 1 : g <= 110 ? 2 : 3; return [t("carbon")[i], ["#6ee7b7", "#7ee0a3", COL.warn, COL.bad][i]]; };
export const monthName = (ym) => fmtDate(ym + "-15T12:00:00", { month: "long" });

export async function refreshEnergy() {
  const d = await load("/energy");
  if (!d) return;                      // keep the figures already shown
  state.energy = d;
  renderEnergy(); renderNormal();
}

/* Tempo badge only when tomorrow is Red: a rare badge makes you look up, a
   permanent one ends up unseen. */
function renderTempoBadge(d) {
  const tom = d.tempoTomorrow;
  $("tempoBadge").innerHTML = tom && tom.code === 3 ? `<span class="pill red">${icon("bolt")}${t("tempo.redTomorrow")}</span>` : "";
}

export function renderEnergy() {
  const d = state.energy;
  if (!d) return;
  renderTempoBadge(d);
  const parts = [];
  if (d.tempo) {
    const c = TEMPO_COL[d.tempo.code];
    const names = t("tempo.colors");
    parts.push(readout(t("energy.tempo"),
      `<span class="tempoDot" style="background:${c}"></span><span style="color:${c}">${names[d.tempo.code]}</span>`,
      (d.tempoTomorrow ? t("energy.tomorrow", names[d.tempoTomorrow.code]) : t("energy.tomorrowUnknown"))
      + (d.tempoLeft ? "<br>" + t("energy.tempoLeft", d.tempoLeft.red, d.tempoLeft.white) : "")));
  }
  if (d.carbon) {
    const [lab, col] = carbonLevel(d.carbon.gco2);
    parts.push(readout(t("energy.carbon"), `<span style="color:${col}">${d.carbon.gco2}</span>${small("g/kWh")}`, `<span style="color:${col}">${lab}</span>, éCO2mix`));
    if (state.liveWatts) {
      const gph = Math.round(((state.liveWatts + d.consumption.baseWatts) * d.carbon.gco2) / 1000);
      parts.push(readout(t("energy.emissions"), `${gph}${small("g CO₂/h")}`, t("energy.cpuGpu", Math.round(state.liveWatts))));
    }
  }
  // Cumulative consumption, integrated from the agent's samples
  const c = d.consumption;
  const eur = (v) => v.toLocaleString(LOCALE, { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + " €";
  const kwh = (v) => nb(v, v < 10 ? 2 : 1);
  if (c.today.hours > 0.02) {
    parts.push(readout(t("energy.today"), `${kwh(c.today.kwh)}${small("kWh")}`,
      [c.today.cost != null ? eur(c.today.cost) : null, t("energy.hoursOn", dec(c.today.hours)),
       c.avgWatts ? t("energy.avgW", Math.round(c.avgWatts)) : null].filter(Boolean).join(", ")));
  }
  if (c.month.kwh > 0.01) {
    // The end-of-month projection is compared with the whole previous month:
    // 10 days against 31 would mean nothing.
    const m = c.monthly;
    const sub = [c.month.cost != null ? eur(c.month.cost) : null, `${Math.round(c.month.hours)} h`];
    if (m.projection) sub.push(t("energy.projection", kwh(m.projection)));
    if (m.previous && m.previous.kwh > 0.01 && m.projection) {
      const gap = Math.round((m.projection / m.previous.kwh - 1) * 100);
      sub.push(`<span class="delta ${gap > 0 ? "up" : "down"}">${t("energy.vs", (gap > 0 ? "+" : "") + gap, monthName(m.previous.month))}</span>`);
    } else if (!m.previous) {
      sub.push(`<span class="dim">${t("energy.nextMonth")}</span>`);
    }
    parts.push(readout(t("energy.month"), `${kwh(c.month.kwh)}${small("kWh")}`, sub.filter(Boolean).join(", ")));
  }
  $("energyCard").hidden = !parts.length;
  $("energyRow").innerHTML = parts.join("");
}
