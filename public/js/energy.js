/* Energy: the tab, and its short form on the Overview. Tempo is EDF's daily price
   color; carbon comes from éCO2mix (RTE) and turns the machine's real consumption into
   an emission estimate; the PC's kWh are integrated by the agent from its samples; the
   air conditioners report their own counters, read on the local network by the house
   service; a Linky module, when one answers, gives the meter of the home. */
import { $, state, esc, small, readout, load, put } from "./core.js";
import { t, dec, nb, fmtDate, fmtTime, dayKey, LOCALE } from "./i18n.js";
import { renderNormal } from "./weather.js";

const TEMPO_COL = { 1: "#60a5fa", 2: "#e6e6ef", 3: "#ff6b6b" };
const carbonLevel = (g) => t("carbon")[g <= 40 ? 0 : g <= 70 ? 1 : g <= 110 ? 2 : 3];
export const monthName = (ym) => fmtDate(ym + "-15T12:00:00", { month: "long" });
const eur = (v) => v.toLocaleString(LOCALE, { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + " €";
const kwh = (v) => nb(v, v < 10 ? 2 : 1);
const tempoName = (day) => day ? `<span class="tempoDot" style="background:${TEMPO_COL[day.code]}"></span>${t("tempo.colors")[day.code]}` : `<span class="word">${t("energy.unknown")}</span>`;

export async function refreshEnergy() {
  const d = await load("/energy");
  if (!d) return;                      // keep the figures already shown
  state.energy = d;
  renderEnergy(); renderNormal();
  document.dispatchEvent(new CustomEvent("vigie:energy"));
}

/* What each unit of the house used, from the counters it keeps itself: today and the
   last seven days, in kWh. Units that do not answer or report no counter are left out. */
export function climateEnergy(rooms) {
  return (rooms || []).flatMap((room) => room.devices
    .filter((d) => d.state && d.state.reachable && d.state.energy && (d.type === "climate" || d.type === "heater"))
    .map((d) => ({ id: d.id, name: d.name, room: room.name, today: d.state.energy.today ?? null, week: d.state.energy.week ?? null, month: d.state.energy.month ?? null, days: d.state.energy.days || null })));
}

/* The week of the units day by day, oldest first, for the stacked bars: [{ ago, parts:
   [kWh of each unit, in their order], total }]. The units count from today backwards. */
export function stackDays(units, days = 7) {
  const out = [];
  for (let ago = days - 1; ago >= 0; ago--) {
    const parts = units.map((u) => { const x = u.days && u.days[ago]; return x ? Math.round(((x.heat || 0) + (x.cool || 0)) * 100) / 100 : 0; });
    out.push({ ago, parts, total: Math.round(parts.reduce((a, b) => a + b, 0) * 100) / 100 });
  }
  return out;
}

/* What Vigie can count: the PC and the units that keep counters. { today, month } in kWh,
   each null when nothing is known, with their cost when there is a price. */
export function trackedEnergy(consumption, units, price) {
  const add = (pc, key) => {
    const ac = units.filter((u) => u[key] != null), known = pc != null || ac.length;
    const kwh = (pc || 0) + ac.reduce((s, u) => s + u[key], 0);
    return known ? { kwh: Math.round(kwh * 100) / 100, cost: price ? Math.round(kwh * price * 100) / 100 : null, pc: pc || 0, units: Math.round(ac.reduce((s, u) => s + u[key], 0) * 100) / 100 } : null;
  };
  const c = consumption || {};
  return { today: add(c.today ? c.today.kwh : null, "today"), month: add(c.month ? c.month.kwh : null, "month") };
}

// A line over a filled area, the figures of its ends beside it: no axis, the shape is the message.
function curve(points, { height = 120, unit = "" } = {}) {
  const vs = points.map((p) => p.v), lo = Math.min(...vs), hi = Math.max(...vs), span = hi - lo || 1;
  const xy = points.map((p, i) => [(i / (points.length - 1)) * 1000, 8 + (1 - (p.v - lo) / span) * (height - 16)]);
  const d = xy.map(([x, y], i) => `${i ? "L" : "M"}${x.toFixed(1)} ${y.toFixed(1)}`).join("");
  return `<div class="plot"><div class="chartSide"><span class="num">${hi}${unit}</span><span class="num">${lo}${unit}</span></div>
    <svg class="chart" viewBox="0 0 1000 ${height}" preserveAspectRatio="none" style="height:${height}px" aria-hidden="true">
      <path d="${d}L1000 ${height}L0 ${height}Z" fill="var(--accent)" opacity=".14"/><path d="${d}" fill="none" stroke="var(--accent)" stroke-width="2" vector-effect="non-scaling-stroke"/></svg></div>
    <div class="chartFeet"><span>${points[0].label}</span><span>${points[Math.floor(points.length / 2)].label}</span><span>${points[points.length - 1].label}</span></div>`;
}

// The month as a calendar, Monday first: each day so far in the color it had.
function calendar(days) {
  const now = new Date(), y = now.getFullYear(), m = now.getMonth(), count = new Date(y, m + 1, 0).getDate();
  const byDay = new Map(days.map((x) => [Number(x.date.slice(8, 10)), x.code])), names = t("tempo.colors");
  // one strip of the month: the color of each day known, the weekends marked by their initial
  const cells = Array.from({ length: count }, (_, i) => {
    const code = byDay.get(i + 1), d = new Date(y, m, i + 1), we = d.getDay() === 0 || d.getDay() === 6;
    return `<span class="cd${code ? " known" : ""}${we ? " we" : ""}${i + 1 === now.getDate() ? " today" : ""}"${code ? ` style="--c:${TEMPO_COL[code]}" title="${names[code]}"` : ""}><b>${fmtDate(d, { weekday: "narrow" })}</b>${i + 1}</span>`;
  }).join("");
  return `<div class="calHead">${fmtDate(now, { month: "long", year: "numeric" })}</div><div class="calGrid" style="--n:${count}">${cells}</div>`;
}

// The meter of the home, when a device of that type answers (a Linky read over MQTT).
export const meterOf = (rooms) => (rooms || []).flatMap((r) => r.devices).find((d) => d.type === "meter" && d.state && d.state.reachable) || null;

function renderMini(d) {
  const c = d.consumption, parts = [];
  if (d.tempo) parts.push(readout(t("energy.tempo"), tempoName(d.tempo), t("energy.tomorrowIs", d.tempoTomorrow ? t("tempo.colors")[d.tempoTomorrow.code] : t("energy.unknown"))));
  if (c.today.hours > 0.02) parts.push(readout(t("energy.pcToday"), `${kwh(c.today.kwh)}${small("kWh")}`, c.today.cost != null ? eur(c.today.cost) : ""));
  const meter = meterOf(state.house && state.house.rooms);
  if (meter && meter.state.power != null) parts.push(readout(t("card.meter"), `${nb(Math.round(meter.state.power))}${small("W")}`));
  $("energyMini").hidden = !parts.length;
  put($("energyMiniRow"), parts.join(""));
}

export function renderEnergy() {
  const d = state.energy;
  if (!d) return;
  renderMini(d);
  renderEnergyTab();
}

export function renderEnergyTab() {
  const d = state.energy;
  if (!d) return;
  // Tempo: today, tomorrow, and the days left of each color in the season
  $("tempoCard").hidden = !d.tempo && !d.tempoTomorrow;
  put($("tempoDays"), [["energy.todayLabel", d.tempo], ["energy.tomorrowLabel", d.tempoTomorrow]]
    .map(([k, day]) => `<div class="tempoDay"><div class="k">${t(k)}</div><div class="v">${tempoName(day)}</div></div>`).join(""));
  const left = d.tempoLeft, names = t("tempo.colors");
  $("tempoLeft").hidden = !left;
  $("tempoMeta").textContent = left ? t("energy.daysLeft") : "";
  put($("tempoLeft"), !left ? "" : [[1, left.blue], [2, left.white], [3, left.red]].filter(([, n]) => n != null)
    .map(([code, n]) => readout(`<span class="tempoDot" style="background:${TEMPO_COL[code]}"></span>${names[code]}`, n)).join(""));

  put($("tempoCal"), d.tempoMonth && d.tempoMonth.length ? calendar(d.tempoMonth) : "");
  $("tempoCal").hidden = !(d.tempoMonth && d.tempoMonth.length);
  $("carbonCurve").hidden = !d.carbonDay;
  put($("carbonCurve"), d.carbonDay ? curve(d.carbonDay.map((p) => ({ v: p.gco2, label: fmtTime(p.at) })), { unit: " g" }) : "");

  $("carbonCard").hidden = !d.carbon;
  if (d.carbon) {
    const live = state.liveWatts ? Math.round(((state.liveWatts + d.consumption.baseWatts) * d.carbon.gco2) / 1000) : null;
    put($("carbonRow"), readout(t("energy.grid"), `${d.carbon.gco2}${small("g/kWh")}`, carbonLevel(d.carbon.gco2))
      + (live != null ? readout(t("energy.emissions"), `${live}${small("g CO₂/h")}`, t("energy.cpuGpu", Math.round(state.liveWatts))) : ""));
  }

  // The PC: today and this month, with the end-of-month projection against the whole
  // previous month (10 days against 31 would mean nothing).
  const c = d.consumption, parts = [];
  if (c.today.hours > 0.02) {
    parts.push(readout(t("energy.today"), `${kwh(c.today.kwh)}${small("kWh")}`,
      [c.today.cost != null ? eur(c.today.cost) : null, t("energy.hoursOn", dec(c.today.hours)), c.avgWatts ? t("energy.avgW", Math.round(c.avgWatts)) : null].filter(Boolean).join(", ")));
  }
  if (c.month.kwh > 0.01) {
    const m = c.monthly, sub = [c.month.cost != null ? eur(c.month.cost) : null, `${Math.round(c.month.hours)} h`];
    if (m.projection) sub.push(t("energy.projection", kwh(m.projection)));
    if (m.previous && m.previous.kwh > 0.01 && m.projection) {
      const gap = Math.round((m.projection / m.previous.kwh - 1) * 100);
      sub.push(t("energy.vs", (gap > 0 ? "+" : "") + gap, monthName(m.previous.month)));
    }
    parts.push(readout(t("energy.month"), `${kwh(c.month.kwh)}${small("kWh")}`, sub.filter(Boolean).join(", ")));
  }
  $("pcEnergyCard").hidden = !parts.length;
  put($("pcEnergyRow"), parts.join(""));
  $("pcEnergyMeta").textContent = state.liveWatts ? `${Math.round(state.liveWatts + c.baseWatts)} W` : "";

  const rooms = state.house && state.house.rooms;
  const units = climateEnergy(rooms), most = Math.max(...units.map((u) => u.week || 0), 0.1);
  $("acEnergyCard").hidden = !units.length;
  put($("acEnergyRows"), `<div class="acRow head"><span>${t("energy.unit")}</span><span class="r">${t("energy.todayLabel")}</span><span class="r">${t("energy.week")}</span><span></span></div>`
    + units.map((u) => `<div class="acRow"><span class="nm">${esc(u.room)} · ${esc(u.name)}</span>
      <span class="r num">${u.today != null ? dec(u.today, 1) + " kWh" : "–"}</span><span class="r num">${u.week != null ? dec(u.week, 1) + " kWh" : "–"}</span>
      <span class="barline"><i style="width:${Math.round(((u.week || 0) / most) * 100)}%"></i></span></div>`).join(""));

  // the week day by day, one tone a unit, and what it cost at today's price
  const stacked = units.some((u) => u.days) ? stackDays(units) : [], top = Math.max(...stacked.map((x) => x.total), 0.1);
  const tone = (i) => `opacity:${Math.max(0.3, 1 - i * 0.28)}`;
  $("acChart").hidden = !stacked.length;
  put($("acChart"), !stacked.length ? "" : `<div class="barDays">${stacked.map((x) => {
    const day = new Date(Date.now() - x.ago * 86400000);
    return `<div class="barDay"><span class="num tot">${x.total ? dec(x.total, 1) : ""}</span><div class="stack" style="height:${Math.round((x.total / top) * 100)}%">${x.parts.map((v, i) => v > 0 ? `<i style="flex:${v};${tone(i)}"></i>` : "").join("")}</div><span class="dayL">${x.ago === 0 ? t("today") : fmtDate(day, { weekday: "short" })}</span></div>`;
  }).join("")}</div>
    <div class="chartLegend">${units.map((u, i) => `<span><i style="${tone(i)}"></i>${esc(u.room)}${u.week != null && c.price ? ` <b class="num">${eur(u.week * c.price)}</b>` : ""}</span>`).join("")}<span class="dim">${t("energy.weekCost")}</span></div>`);

  // everything counted, together
  const all = trackedEnergy(c, units, c.price), total = [];
  if (all.today && units.length) total.push(readout(t("energy.today"), `${kwh(all.today.kwh)}${small("kWh")}`, [all.today.cost != null ? eur(all.today.cost) : null, t("energy.split", kwh(all.today.pc), kwh(all.today.units))].filter(Boolean).join(", ")));
  if (all.month && units.some((u) => u.month != null)) total.push(readout(t("energy.month"), `${kwh(all.month.kwh)}${small("kWh")}`, [all.month.cost != null ? eur(all.month.cost) : null, t("energy.split", kwh(all.month.pc), kwh(all.month.units))].filter(Boolean).join(", ")));
  $("totalCard").hidden = !total.length;
  put($("totalRow"), total.join(""));

  const meter = meterOf(rooms);
  $("meterCard").hidden = !meter;
  if (meter) {
    const s = meter.state;
    $("meterMeta").textContent = meter.name;
    put($("meterRow"), [
      s.power != null ? readout(t("meter.power"), `${nb(Math.round(s.power))}${small("W")}`) : "",
      s.index != null ? readout(t("meter.index"), `${nb(Math.round(s.index))}${small("kWh")}`) : "",
      s.tariff ? readout(t("meter.tariff"), `<span class="word">${esc(s.tariff)}</span>`) : "",
    ].join(""));
  }
}

/* ================= Year (daily totals of the PC) =================
   The only screen that reads the `daily` table. While it is young, it says how far
   the collection is rather than drawing a chart on two points. */
export async function refreshYear() {
  const a = await load("/year");
  $("yearCard").hidden = !a;
  if (!a) return;
  const meta = $("yearMeta"), body = $("yearBody");
  if (!a.days) {
    meta.textContent = "";
    body.innerHTML = `<div class="err">${t("year.starting")}</div>`;
    return;
  }
  const dLong = (s) => fmtDate(s + "T12:00:00", { day: "numeric", month: "long", year: "numeric" });
  meta.textContent = t("year.meta", a.days, dLong(a.first));

  const totKwh = a.months.reduce((s, m) => s + m.kwh, 0);
  const totH = a.months.reduce((s, m) => s + m.hours, 0);
  // Averages over the days actually summed in the bars: beyond a year of history,
  // dividing by every day of the table would underestimate them.
  const wd = a.windowDays;
  const totals = `<div class="readouts">
    ${readout(t("year.used"), `${nb(totKwh, 1)}${small("kWh")}`, t("year.over", wd))}
    ${readout(t("year.cost"), a.price ? `${nb(totKwh * a.price, 2)}${small("€")}` : "–", a.price ? t("year.atPrice", nb(a.price, 4)) : t("year.noPrice"))}
    ${readout(t("year.on"), `${nb(totH, 0)}${small("h")}`, t("year.perDay", nb(totH / wd, 1)))}
    ${readout(t("year.avg"), `${nb((totKwh / wd) * 1000, 0)}${small(t("unit.whDay"))}`, t("year.daily"))}
  </div>`;

  // 12 rolling months, empty months included. Local date key, like dayKey().
  const currentMonth = dayKey().slice(0, 7);
  const byMonth = new Map(a.months.map((m) => [m.month, m]));
  const now = new Date();
  const cols = [];
  for (let i = 11; i >= 0; i--) {
    const key = dayKey(new Date(now.getFullYear(), now.getMonth() - i, 1)).slice(0, 7);
    cols.push(byMonth.get(key) || { month: key, kwh: 0, hours: 0, days: 0 });
  }
  const maxK = Math.max(...cols.map((m) => m.kwh), 0.001);
  const bars = `<div class="monthRow">${cols.map((m) => `<div class="monthCol${m.days ? "" : " empty"}">
      <div class="bar"><i class="${m.month === currentMonth ? "now" : ""}" style="height:${m.days ? Math.max(3, (m.kwh / maxK) * 100) : 2}%"></i></div>
      <div class="m">${fmtDate(m.month + "-01T12:00:00", { month: "short" })}</div>
      <div class="k num">${m.days ? nb(m.kwh, m.kwh < 10 ? 1 : 0) + " kWh" : "–"}</div>
      <div class="e num">${m.days ? (a.price ? nb(m.kwh * a.price, 2) + " €" : nb(m.hours, 0) + " h") : ""}</div>
      ${!m.days ? "" : m.partial
        // The start date rather than "N days out of M": a day with the PC off
        // creates no row, the ratio would mix up absence and shutdown.
        ? `<div class="p num">${t("year.since", fmtDate(a.first + "T12:00:00", { day: "numeric", month: "short" }))}</div>`
        : m.current ? `<div class="p num dim">${t("year.current")}</div>` : ""}
    </div>`).join("")}</div>`;

  // The Overview "This month" reads 30 days of raw samples, this card the daily
  // table. Until the table covers the month the figures differ: say why.
  const cur = cols.find((m) => m.current);
  const note = cur && cur.partial ? `<div class="yearNote prose x2">${t("year.note", dLong(a.first))}</div>` : "";

  // Daily strip: height = hours on, color = max GPU temperature. The scale follows
  // the observed temperatures: with fixed thresholds, a GPU living between 55 and
  // 75 °C gave a single-color strip. Fixed red from 85 °C, and those days stay out
  // of the scale so one scorching day doesn't squeeze all the others.
  const maxH = Math.max(...a.daily.map((q) => q.h), 1);
  const temps = a.daily.map((q) => q.t).filter((x) => x != null && x < 85);
  const tMin = temps.length ? Math.min(...temps) : 0;
  const tMax = temps.length ? Math.max(...temps) : 1;
  // one hue, stronger with the temperature: red is kept for a day that really ran hot
  const tCol = (x) => {
    if (x == null) return "color-mix(in oklab, var(--ink) 18%, transparent)";
    if (x >= 85) return "var(--coral)";
    const k = tMax - tMin < 4 ? 0.6 : (x - tMin) / (tMax - tMin);      // under 4 °C of spread the gap means nothing
    return `color-mix(in oklab, var(--accent) ${Math.round(35 + k * 65)}%, transparent)`;
  };
  const scale = temps.length && tMax - tMin >= 4 ? ` (${tMin} → ${tMax} °C)` : "";
  const strip = a.daily.length > 3 ? `<div class="stripWrap x2">
    <div class="stripLegend">${t("year.strip", a.daily.length, scale)}</div>
    <div class="dayStrip">${a.daily.map((q) =>
      `<i style="height:${Math.max(4, (q.h / maxH) * 100)}%;background:${tCol(q.t)}" title="${q.d} · ${q.h} h${q.t != null ? " · " + q.t + " °C" : ""}"></i>`).join("")}</div>
  </div>` : "";

  body.innerHTML = totals + bars + note + strip;
}

