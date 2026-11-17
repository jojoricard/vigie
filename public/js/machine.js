/* Machine tab: the hardware sheet (short, its detail in a panel), what changed, the
   incidents, the health of the connection. */
import { $, state, esc, small, readout, load, DAY_MS, put } from "./core.js";
import { changeIcon, icon } from "./icons.js";
import { t, dec, nb, fmtDate, fmtTime, relTime, LOCALE } from "./i18n.js";
import { openPanel } from "./panel.js";

/* ================= Machine sheet: hardware + drivers =================
   Recent dates are highlighted: "what changed before this crash?" */
let sheet = null;
const block = (html) => `<div class="block" data-prio="1">${html}</div>`;
// a date less than 30 days old is a recent change
const when = (d) => {
  if (!d) return "";
  const recent = Date.now() - new Date(d) <= 30 * DAY_MS;
  return ` <span class="${recent ? "machRecent" : "dim"}">(${relTime(d)})</span>`;
};

function sheetRows(m) {
  const gb = t("unit.gb");
  const ram = (m.ram || []).filter((r) => r.gb);
  const ramTxt = ram.length
    ? `<b>${ram.length} × ${ram[0].gb} ${gb}</b> = ${ram.reduce((n, r) => n + r.gb, 0)} ${gb}${ram[0].mhz ? ` · ${ram[0].mhz} MHz` : ""}${ram[0].part ? ` · <span class="dim">${esc(ram[0].part)}</span>` : ""}`
    : "";
  const disks = (m.disks || []).filter((d) => d.gb)
    .map((d) => `<b>${esc(d.model)}</b> ${d.gb >= 1000 ? dec(d.gb / 1000) + " " + t("unit.tb") : d.gb + " " + gb}`).join("<br>");
  return [
    [t("mach.cpu"), m.cpu ? `<b>${esc(m.cpu)}</b>${m.cores ? ` · ${t("mach.cores", m.cores, m.threads)}` : ""}` : ""],
    [t("mach.gpu"), m.gpu ? `<b>${esc(m.gpu)}</b>${m.gpuDriver ? `<br>${t("mach.driver", esc(m.gpuDriver))}${when(m.gpuDriverDate)}` : ""}` : ""],
    [t("mach.board"), m.motherboard ? `<b>${esc(m.motherboard)}</b>${m.bios ? ` · BIOS ${esc(m.bios)}${when(m.biosDate)}` : ""}` : ""],
    [t("mach.ram"), ramTxt],
    [t("mach.disks"), disks],
    [t("mach.windows"), m.os ? `<b>${esc(m.os)}</b>${m.build ? ` · build ${esc(m.build)}` : ""}${m.hotfix ? `<br>${t("mach.hotfix", esc(m.hotfix))}${when(m.hotfixDate)}` : ""}` : ""],
  ].filter(([, v]) => v);
}

// The whole sheet, in a panel: one block per line, so it folds like everything else.
function openSheet() {
  if (!sheet) return;
  openPanel({
    kind: "sheet",
    head: () => ({ icon: icon("chip"), title: t("card.machine") }),
    body: () => sheetRows(sheet).map(([k, v]) => block(`<div class="machRow"><div class="ml">${k}</div><div class="mv">${v}</div></div>`)).join(""),
  });
}

export async function refreshMachine() {
  const m = await load("/machine");
  $("machCard").hidden = false;
  if (!m || (!m.cpu && !m.gpu)) {   // say it rather than hide the card silently
    sheet = null;
    $("machMore").hidden = true;
    put($("machShort"), `<div class="err">${t("mach.unavailable")}</div>`);
    return;
  }
  sheet = m;
  $("machMore").hidden = false;
  // the short sheet: what the machine is, and the two dates that explain a crash
  const total = (m.ram || []).reduce((n, r) => n + (r.gb || 0), 0);
  put($("machShort"), [
    m.cpu ? [t("mach.cpu"), esc(m.cpu)] : null,
    m.gpu ? [t("mach.gpu"), `${esc(m.gpu)}${m.gpuDriverDate ? when(m.gpuDriverDate) : ""}`] : null,
    total ? [t("mach.ram"), `${total} ${t("unit.gb")}`] : null,
    m.os ? [t("mach.windows"), `${m.build ? `build ${esc(m.build)}` : esc(m.os)}${m.hotfixDate ? when(m.hotfixDate) : ""}`] : null,
  ].filter(Boolean).map(([k, v]) => `<div><span class="k">${k}</span>${v}</div>`).join(""));
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
  // A break at the "alert" level is an alert of the page (alerts.js); here, all of them with their figures.
  $("changeCard").hidden = !l.length;
  $("changeCard").classList.toggle("alert", l.some((c) => c.level === "alert"));
  put($("changeBody"), l.map((c) => {
    const x = changeText(c);
    return `<div class="chgLine ${c.level}"><span class="ic">${changeIcon(c.kind)}</span><span class="t">${esc(x.title)}</span><span class="d">${esc(x.detail)}</span></div>`;
  }).join(""));
}

/* ================= Incidents (black box + Windows log) ================= */
const crashAt = (ts) => t("crash.at", fmtDate(ts, { weekday: "short", day: "numeric", month: "short" }), fmtTime(ts));

let lastReport = null;
export async function refreshCrash() {
  const j = await load("/crash");
  if (!j) return;
  // Set before any early return: a briefing built on a stale counter would be worse
  // than no briefing.
  state.crashCounts = j.counts;
  state.lastCrash = j.report ? { at: j.report.at, type: j.report.type } : null;
  const r = j.report, hist = j.history, cnt = j.counts;
  lastReport = r;
  $("crashCard").hidden = !r && !hist.length;
  $("crashMore").hidden = !r;
  if (!r && !hist.length) return;

  // Days without incident: the only way to know whether a fix (driver, undervolt…) worked.
  const daysWithout = cnt.last != null ? Math.floor((Date.now() - cnt.last) / DAY_MS) : null;
  const colWithout = daysWithout == null ? "var(--ink-2)" : daysWithout >= 14 ? "var(--mint)" : daysWithout >= 3 ? "var(--amber)" : "var(--coral)";
  const streak = `<div class="streak" style="color:${colWithout}">${
    daysWithout == null ? t("crash.none30") : daysWithout === 0 ? t("crash.today") : t("crash.daysWithout", daysWithout)}</div>`;
  // Freeze / cut split: two families point to two different fixes (graphics driver
  // on one side, power supply on the other).
  const nat = cnt.natures;
  const split = nat.freeze || nat.cut
    ? `<div class="crashSplit x2">${[
        nat.freeze ? `<b>${t("crash.freezes", nat.freeze)}</b> ${t("crash.freezeNote")}` : null,
        nat.cut ? `<b>${t("crash.cuts", nat.cut)}</b> ${t("crash.cutNote")}` : null,
      ].filter(Boolean).join(" · ")}</div>` : "";
  put($("crashTop"), streak + `<div class="crashFreq${split ? " tight" : ""}">
      <b>${t("crash.count", cnt.d30)}</b>
      <span class="dim">${t("crash.over30", cnt.d7)}</span></div>` + split);

  // Incident list, latest first: rows of a list, the older ones on its next pages
  put($("crashList"), hist.map((h) => {
    const tag = NATURES.includes(h.nature)
      ? ` <span class="natTag dim">${t("nature." + h.nature)}${h.nature === "freeze" ? ` · ${t("crash.silence", Math.max(1, Math.round(h.silence / 60)))}` : ""}</span>`
      : "";
    return `<div class="incRow"><span class="it">${t("incident." + h.type)}${tag}</span><span class="dim">${crashAt(h.t)}</span></div>`;
  }).join(""));
}
const NATURES = ["freeze", "cut", "undetermined"];

// The last incident in a panel: the diagnosis first, the readings recorded just before behind their own tab.
function openIncident() {
  const r = lastReport;
  if (!r) return;
  const at = fmtDate(r.at, { weekday: "long", day: "numeric", month: "long", hour: "2-digit", minute: "2-digit" });
  // The liquid column only when a sample has a value: LibreHardwareMonitor no longer
  // reads the AIO, a column of dashes says nothing.
  const liquid = r.samples.some((s) => s.l != null);
  const cols = t("crash.cols").filter((_, i) => i !== 3 || liquid);
  const line = (cells) => `<div class="factRow sample">${cells.map((c) => `<span class="num">${c}</span>`).join("")}</div>`;
  openPanel({
    kind: "incident",
    head: () => ({ icon: icon("alert"), title: t("incidentLong." + r.type), sub: at }),
    tabs: () => [{ id: "diagnosis", label: t("crash.diagnosis") }, ...(r.samples.length ? [{ id: "samples", label: t("crash.showSamples") }] : [])],
    body: (tab) => tab === "samples"
      ? block(`<div class="bHead"><h2>${t("crash.showSamples")}</h2><span class="pgr" data-pager hidden></span></div>${line(cols)}
          <div class="rows" data-rows data-min-rows="3">${r.samples.map((s) => line([new Date(s.t).toLocaleTimeString(LOCALE), s.c != null ? Math.round(s.c) + "°" : "–", s.g != null ? Math.round(s.g) + "°" : "–",
            ...(liquid ? [s.l != null ? dec(s.l) + "°" : "–"] : []), s.r ?? s.rf ? dec(s.r ?? s.rf) + " %" : "–"])).join("")}</div>`)
      : r.hints.map((h) => block(`<div class="hint prose">${t("hint." + h.kind, h)}</div>`)).join("") || block(`<p class="helpText">${t("crash.noHint")}</p>`),
  });
}

export function wireMachine() {
  $("machMore").dataset.panel = "sheet";
  $("crashMore").dataset.panel = "incident";
  $("machMore").onclick = openSheet;
  $("crashMore").onclick = openIncident;
}

/* ================= Network health (latency measured by the agent) ================= */
export async function refreshNetwork() {
  const d = await load("/network");
  state.network = d;
  $("netCard").hidden = !d || !d.samples;
  if (!d || !d.samples) return;
  // Right after startup there are only a few readings: a "24 h average" over three
  // points would look true without being so.
  const young = d.samples < 20;
  $("netMeta").textContent = young ? t("net.metaYoung", d.target, d.samples) : t("net.meta", d.target, d.samples);
  const col = (ms) => ms == null ? "var(--ink-3)" : ms < 30 ? "var(--mint)" : ms < 70 ? "var(--amber)" : "var(--coral)";
  const ms = (v) => v == null ? "–" : `${v}${small("ms")}`;
  put($("netRow"), [
    readout(t("net.latency"), `<span style="color:${d.failingNow ? "var(--coral)" : col(d.latest)}">${ms(d.latest)}</span>`,
      d.latest == null ? t("net.noAnswer") : d.failingNow ? t("net.lastFailed") : t("net.last")),
    readout(t("net.avg"), young ? "–" : ms(d.avg), young ? t("net.notEnough") : (d.max != null ? t("net.peak", d.max) : "")),
    readout(t("net.jitter"), young ? "–" : ms(d.jitter), t("net.jitterSub")),
    readout(t("net.loss"), young ? "–" : `<span style="color:${d.loss > 1 ? "var(--coral)" : "var(--mint)"}">${nb(d.loss, 1)} %</span>`,
      young ? "" : d.loss > 1 ? t("net.unstable") : t("net.stable")),
  ].join(""));
  renderBox();
}

/* The box of the home, when the house service has a module that reads one: the state
   of the line, what goes through it now, and the last time it dropped. */
const mbps = (bytesPerSecond) => nb((bytesPerSecond * 8) / 1e6, bytesPerSecond * 8 < 1e7 ? 1 : 0);
export function renderBox() {
  const n = state.home && state.home.network;
  $("boxRow").hidden = !n;
  if (!n) return;
  const up = n.state === "up", last = n.lastOutage;
  put($("boxRow"), [
    readout(t("box.line"), `<span style="color:${up ? "var(--mint)" : "var(--coral)"}">${up ? t("box.up") : t("box.down")}</span>`, n.media ? esc(n.media) : ""),
    n.rateDown != null ? readout(t("box.down.rate"), `${mbps(n.rateDown)}${small("Mb/s")}`, n.bandwidthDown ? t("box.of", nb(n.bandwidthDown / 1e6, 0)) : "") : "",
    n.rateUp != null ? readout(t("box.up.rate"), `${mbps(n.rateUp)}${small("Mb/s")}`, n.bandwidthUp ? t("box.of", nb(n.bandwidthUp / 1e6, 0)) : "") : "",
    readout(t("box.outage"), last ? `<span class="word">${fmtDate(last.at, { day: "numeric", month: "short" })}</span>` : `<span class="word">${t("box.none")}</span>`,
      last ? `${fmtTime(last.at)}${last.minutes != null ? ` · ${t("house.minutes", last.minutes)}` : ""}` : ""),
  ].join(""));
}

/* ================= Windows waiting =================
   A restart or updates waiting are alerts of the page (alerts.js). Their detail is here,
   under the sheet. */
export async function refreshWindows() {
  const w = await load("/windows");
  if (!w) return;
  state.windows = w;
  const reboot = !!(w.reboot && w.reboot.length), updates = w.updates ? w.updates.length : 0;
  $("winStatus").hidden = !reboot && !updates;
  put($("winStatus"), [reboot ? t("win.rebootLong") : "", updates ? t("win.updatesList", updates, w.updates.map(esc).join(", ")) : ""]
    .filter(Boolean).join("<br>"));
}

// "since 14:02", with the day once it is no longer today
export const since = (ts) => new Date(ts).toDateString() === new Date().toDateString() ? fmtTime(ts) : fmtDate(ts, { weekday: "short", hour: "2-digit", minute: "2-digit" });
