/* Machine tab: hardware sheet, what changed, incidents, network health, year view. */
import { $, state, esc, small, readout, load, DAY_MS, COL } from "./core.js";
import { changeIcon, icon } from "./icons.js";
import { t, dec, nb, fmtDate, fmtTime, relTime, dayKey, LOCALE } from "./i18n.js";

/* ================= Machine sheet: hardware + drivers =================
   Recent dates are highlighted: "what changed before this crash?" */
export async function refreshMachine() {
  const m = await load("/machine");
  $("machCard").hidden = false;
  if (!m || (!m.cpu && !m.gpu)) {   // say it rather than hide the card silently
    $("machBody").innerHTML = `<div class="err">${t("mach.unavailable")}</div>`;
    return;
  }
  // a date less than 30 days old is a recent change
  const when = (d) => {
    if (!d) return "";
    const recent = Date.now() - new Date(d) <= 30 * DAY_MS;
    return ` <span class="${recent ? "machRecent" : "dim"}">(${relTime(d)})</span>`;
  };
  const row = (lab, val) => val ? `<div class="machRow"><div class="ml">${lab}</div><div class="mv">${val}</div></div>` : "";
  const gb = t("unit.gb");
  const ram = (m.ram || []).filter((r) => r.gb);
  const ramTxt = ram.length
    ? `<b>${ram.length} × ${ram[0].gb} ${gb}</b> = ${ram.reduce((n, r) => n + r.gb, 0)} ${gb}${ram[0].mhz ? ` · ${ram[0].mhz} MHz` : ""}${ram[0].part ? ` · <span class="dim">${esc(ram[0].part)}</span>` : ""}`
    : "";
  const disks = (m.disks || []).filter((d) => d.gb)
    .map((d) => `<b>${esc(d.model)}</b> ${d.gb >= 1000 ? dec(d.gb / 1000) + " " + t("unit.tb") : d.gb + " " + gb}`).join("<br>");
  $("machBody").innerHTML = [
    row(t("mach.cpu"), m.cpu ? `<b>${esc(m.cpu)}</b>${m.cores ? ` · ${t("mach.cores", m.cores, m.threads)}` : ""}` : ""),
    row(t("mach.gpu"), m.gpu ? `<b>${esc(m.gpu)}</b>${m.gpuDriver ? `<br>${t("mach.driver", esc(m.gpuDriver))}${when(m.gpuDriverDate)}` : ""}` : ""),
    row(t("mach.board"), m.motherboard ? `<b>${esc(m.motherboard)}</b>${m.bios ? ` · BIOS ${esc(m.bios)}${when(m.biosDate)}` : ""}` : ""),
    row(t("mach.ram"), ramTxt),
    row(t("mach.disks"), disks),
    row(t("mach.windows"), m.os ? `<b>${esc(m.os)}</b>${m.build ? ` · build ${esc(m.build)}` : ""}${m.hotfix ? `<br>${t("mach.hotfix", esc(m.hotfix))}${when(m.hotfixDate)}` : ""}` : ""),
  ].join("");
}

/* ================= What changed (breaks found by the agent) =================
   Nothing to report = no card. An alert card seen every day becomes a card nobody
   opens anymore. */
export const changeText = (c) => {
  const [title, detail] = t("chg." + c.kind);
  return { title: typeof title === "function" ? title(c) : title, detail: detail(c) };
};

export async function refreshChanges() {
  const l = await load("/changes");
  if (!l) return;
  state.changes = l;
  // Overview: titles only, as pills, the screen must fit without scrolling.
  $("changeBadges").innerHTML = l.map((c) =>
    `<span class="pill ${c.level === "alert" ? "red" : "yellow"}">${changeIcon(c.kind)}${esc(changeText(c).title)}</span>`).join("");
  // Machine tab: the full card, with the figures.
  $("changeCard").hidden = !l.length;
  $("changeCard").classList.toggle("alert", l.some((c) => c.level === "alert"));
  $("changeBody").innerHTML = l.map((c) => {
    const x = changeText(c);
    return `<div class="chgLine ${c.level}"><span class="ic">${changeIcon(c.kind)}</span><span class="t">${esc(x.title)}</span><span class="d">${esc(x.detail)}</span></div>`;
  }).join("");
}

/* ================= Incidents (black box + Windows log) ================= */
const crashAt = (ts) => t("crash.at", fmtDate(ts, { weekday: "short", day: "numeric", month: "short" }), fmtTime(ts));
const NATURE_COL = { freeze: "#ff8b96", cut: "var(--warn)", undetermined: "var(--txt3)" };

export async function refreshCrash() {
  const j = await load("/crash");
  if (!j) return;
  // Set before any early return: a briefing built on a stale counter would be worse
  // than no briefing.
  state.crashCounts = j.counts;
  state.lastCrash = j.report ? { at: j.report.at, type: j.report.type } : null;
  const r = j.report, hist = j.history, cnt = j.counts;
  $("crashCard").hidden = !r && !hist.length;
  if (!r && !hist.length) return;

  // Days without incident: the only way to know whether a fix (driver, undervolt…) worked.
  const daysWithout = cnt.last != null ? Math.floor((Date.now() - cnt.last) / DAY_MS) : null;
  const colWithout = daysWithout == null ? "var(--txt2)" : daysWithout >= 14 ? "#7ee0a3" : daysWithout >= 3 ? "var(--warn)" : "#ff8b96";
  const streak = `<div class="streak" style="color:${colWithout}">${
    daysWithout == null ? t("crash.none30") : daysWithout === 0 ? t("crash.today") : t("crash.daysWithout", daysWithout)}</div>`;
  // Freeze / cut split: two families point to two different fixes (graphics driver
  // on one side, power supply on the other).
  const nat = cnt.natures;
  const split = nat.freeze || nat.cut
    ? `<div class="crashSplit">${[
        nat.freeze ? `<b style="color:#ff8b96">${t("crash.freezes", nat.freeze)}</b> ${t("crash.freezeNote")}` : null,
        nat.cut ? `<b style="color:var(--warn)">${t("crash.cuts", nat.cut)}</b> ${t("crash.cutNote")}` : null,
      ].filter(Boolean).join(" · ")}</div>` : "";
  const freq = streak + `<div class="crashFreq${split ? " tight" : ""}">
      <b style="color:${cnt.d7 >= 2 ? "#ff8b96" : "var(--txt)"}">${t("crash.count", cnt.d30)}</b>
      <span class="dim">${t("crash.over30", cnt.d7)}</span></div>` + split;

  // Incident list, latest first
  const list = hist.map((h) => {
    const tag = NATURE_COL[h.nature]
      ? ` <span class="natTag" style="color:${NATURE_COL[h.nature]}">${t("nature." + h.nature)}${h.nature === "freeze" ? ` · ${t("crash.silence", Math.max(1, Math.round(h.silence / 60)))}` : ""}</span>`
      : "";
    return `<div class="incRow"><span class="it">${t("incident." + h.type)}${tag}</span><span class="dim">${crashAt(h.t)}</span></div>`;
  }).join("");

  // Details of the last one, with the samples recorded just before
  let detail = "";
  if (r) {
    const when = fmtDate(r.at, { weekday: "long", day: "numeric", month: "long", hour: "2-digit", minute: "2-digit" });
    const cols = t("crash.cols");
    const rows = r.samples.map((s) => `<tr><td class="num">${new Date(s.t).toLocaleTimeString(LOCALE)}</td>
      <td class="r num">${s.c != null ? Math.round(s.c) + "°" : "–"}</td><td class="r num">${s.g != null ? Math.round(s.g) + "°" : "–"}</td>
      <td class="r num">${s.l != null ? dec(s.l) + "°" : "–"}</td><td class="r num">${s.r ?? s.rf ? dec(s.r ?? s.rf) + " %" : "–"}</td></tr>`).join("");
    detail = `<div class="crashDetail">
      <div class="crashTitle"><b>${t("incidentLong." + r.type)}</b> <span class="dim">· ${when}</span></div>
      ${r.hints.map((h) => `<div class="hint prose">${t("hint." + h.kind, h)}</div>`).join("")}
      ${rows ? `<table class="crashTable"><tr class="dim"><td>${cols[0]}</td>${cols.slice(1).map((c) => `<td class="r">${c}</td>`).join("")}</tr>${rows}</table>` : ""}</div>`;
  }
  $("crashBody").innerHTML = freq + list + detail;
}

/* ================= Network health (latency measured by the agent) ================= */
export async function refreshNetwork() {
  const d = await load("/network");
  $("netCard").hidden = !d || !d.samples;
  if (!d || !d.samples) return;
  // Right after startup there are only a few readings: a "24 h average" over three
  // points would look true without being so.
  const young = d.samples < 20;
  $("netMeta").textContent = young ? t("net.metaYoung", d.target, d.samples) : t("net.meta", d.target, d.samples);
  const col = (ms) => ms == null ? "var(--txt3)" : ms < 30 ? "#7ee0a3" : ms < 70 ? "var(--warn)" : "var(--bad)";
  const ms = (v) => v == null ? "–" : `${v}${small("ms")}`;
  $("netRow").innerHTML = [
    readout(t("net.latency"), `<span style="color:${d.failingNow ? "var(--bad)" : col(d.latest)}">${ms(d.latest)}</span>`,
      d.latest == null ? t("net.noAnswer") : d.failingNow ? t("net.lastFailed") : t("net.last")),
    readout(t("net.avg"), young ? "–" : ms(d.avg), young ? t("net.notEnough") : (d.max != null ? t("net.peak", d.max) : "")),
    readout(t("net.jitter"), young ? "–" : ms(d.jitter), t("net.jitterSub")),
    readout(t("net.loss"), young ? "–" : `<span style="color:${d.loss > 1 ? "var(--bad)" : "#7ee0a3"}">${nb(d.loss, 1)} %</span>`,
      young ? "" : d.loss > 1 ? t("net.unstable") : t("net.stable")),
  ].join("");
}

/* ================= Year (daily totals) =================
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
  const note = cur && cur.partial ? `<div class="yearNote prose">${t("year.note", dLong(a.first))}</div>` : "";

  // Daily strip: height = hours on, color = max GPU temperature. The scale follows
  // the observed temperatures: with fixed thresholds, a GPU living between 55 and
  // 75 °C gave a single-color strip. Fixed red from 85 °C, and those days stay out
  // of the scale so one scorching day doesn't squeeze all the others.
  const maxH = Math.max(...a.daily.map((q) => q.h), 1);
  const temps = a.daily.map((q) => q.t).filter((x) => x != null && x < 85);
  const tMin = temps.length ? Math.min(...temps) : 0;
  const tMax = temps.length ? Math.max(...temps) : 1;
  const mix = (c1, c2, k) => "#" + [0, 1, 2].map((i) => Math.round(c1[i] + (c2[i] - c1[i]) * k).toString(16).padStart(2, "0")).join("");
  const tCol = (x) => {
    if (x == null) return "rgba(255,255,255,.18)";
    if (x >= 85) return COL.bad;
    if (tMax - tMin < 4) return "#a385e0";      // under 4 °C of spread the gap means nothing
    return mix([110, 231, 183], [255, 140, 120], (x - tMin) / (tMax - tMin));
  };
  const scale = temps.length && tMax - tMin >= 4 ? ` (${tMin} → ${tMax} °C)` : "";
  const strip = a.daily.length > 3 ? `<div class="stripWrap">
    <div class="stripLegend">${t("year.strip", a.daily.length, scale)}</div>
    <div class="dayStrip">${a.daily.map((q) =>
      `<i style="height:${Math.max(4, (q.h / maxH) * 100)}%;background:${tCol(q.t)}" title="${q.d} · ${q.h} h${q.t != null ? " · " + q.t + " °C" : ""}"></i>`).join("")}</div>
  </div>` : "";

  body.innerHTML = totals + bars + note + strip;
}

/* ================= Windows waiting, services down =================
   On the Overview only as pills, and only when it's the case. Details here. */
const pills = { windows: "", services: "" };
const drawPills = () => { $("machineBadges").innerHTML = pills.windows + pills.services; };

export async function refreshWindows() {
  const w = await load("/windows");
  if (!w) return;
  const reboot = !!(w.reboot && w.reboot.length), updates = w.updates ? w.updates.length : 0;
  pills.windows = (reboot ? `<span class="pill yellow">${icon("restart")}${t("win.reboot")}</span>` : "")
    + (updates ? `<span class="pill yellow">${icon("download")}${t("win.updates", updates)}</span>` : "");
  drawPills();
  $("winStatus").hidden = !reboot && !updates;
  $("winStatus").innerHTML = [reboot ? t("win.rebootLong") : "", updates ? t("win.updatesList", updates, w.updates.map(esc).join(", ")) : ""]
    .filter(Boolean).join("<br>");
}

const SVC_COLOR = { up: "var(--mint)", error: "var(--amber)", down: "var(--coral)" };
// "since 14:02", with the day once it is no longer today
const since = (ts) => dayKey(new Date(ts)) === dayKey() ? fmtTime(ts) : fmtDate(ts, { weekday: "short", hour: "2-digit", minute: "2-digit" });

export async function refreshServices() {
  const l = await load("/services");
  if (!l) return;
  $("servicesCard").hidden = !l.length;
  $("servicesList").innerHTML = l.map((s) => {
    const detail = s.state == null ? t("svc.waiting")
      : s.state === "up" ? `${nb(s.ms)} ms${s.status >= 400 ? `, HTTP ${s.status}` : ""}`
      : s.state === "error" ? t("svc.error", s.status, since(s.since))
      : t("svc.down", since(s.since));
    return `<div class="svcRow"><span class="dot" style="background:${SVC_COLOR[s.state] || "var(--ink-3)"}"></span><span class="nm">${esc(s.name)}</span><span class="d num">${detail}</span></div>`;
  }).join("");
  pills.services = l.filter((s) => s.state === "down" || s.state === "error")
    .map((s) => `<span class="pill red">${icon("signalBroken")}${s.state === "down" ? t("svc.pillDown", esc(s.name)) : t("svc.pillError", esc(s.name))}</span>`).join("");
  drawPills();
}
