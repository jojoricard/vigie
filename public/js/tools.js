/* Tools tab: what came out since the last visit, then the link groups of config.json
   with the latest release of the repos they track, then the fuel prices: one more thing
   looked up before going out. Links open in the default browser (main screen) through
   /open, which only allows URLs declared in config.json. */
import { $, LS, state, esc, load, DAY_MS } from "./core.js";
import { t, dec, relTime } from "./i18n.js";
import { icon, ICON_NAMES } from "./icons.js";
import { queueFit } from "./fit.js";

const SEEN_KEY = "vigie.toolsSeen";
// Before any visit, "new" means the last two weeks.
const FIRST_VISIT_MS = 14 * DAY_MS;

/* The releases published since `seen` (the last time the tab was left), newest first.
   releases: { repo: { version, date, ... } }. */
export function releasedSince(releases, seen, now = Date.now()) {
  const from = seen || now - FIRST_VISIT_MS;
  return Object.entries(releases || {}).filter(([, v]) => v && v.date && new Date(v.date).getTime() > from)
    .map(([repo, v]) => ({ repo, ...v })).sort((a, b) => new Date(b.date) - new Date(a.date));
}

function releaseRow(repo, v, fresh) {
  // "new version" needs an installed one to be newer than. Without it the row only
  // says when the release came out.
  const date = !v.date ? "" : v.installed ? relTime(v.date) : t("tools.released", relTime(v.date));
  // installed version: behind or up to date, nothing if unknown.
  // esc(): it can come from the registry's DisplayVersion, written freely by the installer
  const loc = v.installed
    ? `<span class="rloc ${v.outdated ? "late" : "ok"}">${v.outdated ? t("tools.installed", esc(v.installed)) : t("tools.upToDate", esc(v.installed))}</span>`
    : "";
  return `<div class="relRow${fresh ? " fresh" : ""}" data-url="${encodeURIComponent(v.url || "")}">
      <span class="rn">${esc(repo.split("/").pop())}</span>
      ${loc}
      <span class="rv num">${esc(v.version)}</span>
      <span class="rd">${date}</span></div>`;
}

// an icon name from icons.js, or any short text (an emoji works)
const groupIcon = (s) => !s ? icon("link") : ICON_NAMES.includes(s) ? icon(s) : esc(s);

let seen = LS.get(SEEN_KEY, null);
// Leaving the tab is having seen it: what is new next time is what comes out from now on.
export function toolsLeft() { seen = Date.now(); LS.set(SEEN_KEY, seen); renderNews(); }

let releases = {};
function renderNews() {
  const news = releasedSince(releases, seen);
  $("newsCard").hidden = !news.length;
  $("newsMeta").textContent = news.length ? (seen ? t("tools.sinceVisit", relTime(new Date(seen).toISOString())) : t("tools.recent")) : "";
  $("newsRows").innerHTML = news.map((v) => `<div class="newsRow" data-url="${encodeURIComponent(v.url || "")}">
      <span class="rn">${esc(v.repo.split("/").pop())}</span>
      ${v.installed && v.outdated ? `<span class="rloc late">${t("tools.installed", esc(v.installed))}</span>` : ""}
      <span class="rv num">${esc(v.version)}</span><span class="rd">${relTime(v.date)}</span></div>`).join("");
}

export async function refreshTools() {
  const [groups, rel] = await Promise.all([load("/tools"), load("/releases")]);
  const pane = $("tabTools");
  releases = rel || {};
  renderNews();
  for (const el of pane.querySelectorAll(".toolGroup")) el.remove();
  const fresh = new Set(releasedSince(releases, seen).map((v) => v.repo));
  const first = $("newsCard")._order || 0;
  (groups && groups.length ? groups : [null]).forEach((g, i) => {
    const el = document.createElement("section");
    el.className = "block card toolGroup";
    el.dataset.prio = "1";
    el._order = first + 1 + i;      // between the news and the fuel prices, in the order of the config
    if (!g) el.innerHTML = `<div class="err">${t("tools.none")}</div>`;
    else {
      const repos = (g.releases || []).filter((r) => releases[r]);
      el.innerHTML = `<div class="bHead tgHead"><span class="tgIcon">${groupIcon(g.icon)}</span><span class="tgName">${esc(g.name)}</span><span class="pgr" data-pager hidden></span></div>
        <div class="rows toolGrid" data-rows data-min-rows="2">${repos.map((r) => releaseRow(r, releases[r], fresh.has(r))).join("")}${repos.length && (g.links || []).length ? '<div class="relSep"></div>' : ""}
        ${(g.links || []).map((l) => `<span class="toolLink" data-url="${encodeURIComponent(l.url)}"><span class="tl">${esc(l.label)}</span>${icon("link")}</span>`).join("")}</div>`;
    }
    pane.appendChild(el);
  });
  pane.onclick = (e) => {
    const el = e.target.closest(".toolLink, .relRow, .newsRow");
    if (el && el.dataset.url) load("/open?url=" + el.dataset.url, { method: "POST" });
  };
  queueFit();
}

/* ================= Fuel prices (France) =================
   The cheapest stations around the home city (the first one), per fuel. */
/* ================= Updates of the PC =================
   What is installed and since when: the graphics driver, the BIOS, the last Windows patch,
   and what Windows still has to install. No public source says what the latest driver or
   BIOS of a given machine is, so an age is shown, not a verdict. */
export function pcUpdates(machine, windows) {
  const m = machine || {}, w = windows || {}, rows = [];
  if (m.gpuDriver) rows.push({ id: "gpu", name: m.gpu || null, version: m.gpuDriver, date: m.gpuDriverDate || null });
  if (m.bios) rows.push({ id: "bios", name: m.motherboard || null, version: m.bios, date: m.biosDate || null });
  if (m.os) rows.push({ id: "windows", name: m.build ? `${m.os} · build ${m.build}` : m.os, version: m.hotfix || null, date: m.hotfixDate || null,
    pending: (w.updates || []).length, reboot: !!(w.reboot && w.reboot.length) });
  return rows;
}
export async function refreshPcUpdates() {
  const rows = pcUpdates(await load("/machine"), state.windows || await load("/windows"));
  $("pcUpdCard").hidden = !rows.length;
  $("pcUpdRows").innerHTML = rows.map((r) => {
    const state = r.id !== "windows" ? "" : r.reboot ? `<span class="rs warn">${t("pcupd.reboot")}</span>` : r.pending ? `<span class="rs warn">${t("pcupd.pending", r.pending)}</span>` : `<span class="rs ok">${t("pcupd.upToDate")}</span>`;
    return `<div class="relRow"><span class="rn">${t("pcupd." + r.id)}${r.name ? `<span class="dim">${esc(r.name)}</span>` : ""}</span>${state}
      <span class="rv num">${r.version ? esc(r.version) : "–"}</span><span class="rd">${r.date ? relTime(r.date) : ""}</span></div>`;
  }).join("");
  queueFit();
}

// The cheapest price of each fuel over the days the agent has kept, as one line each.
function fuelCurve(list) {
  const series = list.filter((f) => f.history && f.history.length >= 2);
  if (!series.length) return "";
  const all = series.flatMap((f) => f.history.map((h) => h.price)), lo = Math.min(...all), hi = Math.max(...all), span = hi - lo || 0.01, H = 110;
  const days = [...new Set(series.flatMap((f) => f.history.map((h) => h.date)))].sort(), x = (d) => (days.indexOf(d) / Math.max(1, days.length - 1)) * 1000;
  const line = (f, i) => `<path d="${f.history.map((h, n) => `${n ? "L" : "M"}${x(h.date).toFixed(1)} ${(8 + (1 - (h.price - lo) / span) * (H - 16)).toFixed(1)}`).join("")}" fill="none" stroke="var(--accent)" stroke-width="2" opacity="${1 - i * 0.4}" vector-effect="non-scaling-stroke"/>`;
  const day = (d) => relTime(new Date(d + "T12:00:00").toISOString());
  return `<div class="plot"><div class="chartSide"><span class="num">${dec(hi, 3)} €</span><span class="num">${dec(lo, 3)} €</span></div>
    <svg class="chart" viewBox="0 0 1000 ${H}" preserveAspectRatio="none" style="min-height:${H}px" aria-hidden="true">${series.map(line).join("")}</svg></div>
    <div class="chartFeet"><span>${day(days[0])}</span><span>${t("fuel.cheapestOver", days.length)}</span><span>${day(days[days.length - 1])}</span></div>
    <div class="chartLegend">${series.map((f, i) => `<span><i style="opacity:${1 - i * 0.4}"></i>${t("fuel." + f.type)} <b class="num">${dec(f.history[f.history.length - 1].price, 3)} €</b></span>`).join("")}</div>`;
}

export async function refreshFuel() {
  const l = await load("/fuel");
  state.fuel = l;
  $("fuelCard").hidden = !l || !l.length;
  if (!l || !l.length) return;
  $("fuelMeta").textContent = state.cities[0] ? state.cities[0].short : "";
  const curve = fuelCurve(l);
  $("fuelCurve").hidden = !curve;
  $("fuelCurve").innerHTML = curve;
  // one row per station, the cheapest of each fuel first
  $("fuelList").innerHTML = l.flatMap((f) => f.stations.length ? f.stations.map((s, i) => `<div class="fuelRow${i ? "" : " best"}">
        <span class="p num">${dec(s.price, 3)} €</span>
        <span class="a">${esc(s.address)}, ${esc(s.city)}<span class="dim">${t("fuel." + f.type)} · ${t("fuel.km", dec(s.distance / 1000))}, ${relTime(new Date(s.updated).toISOString())}</span></span>
      </div>`) : [`<div class="fuelRow"><span class="p">–</span><span class="a">${t("fuel." + f.type)}<span class="dim">${t("fuel.none")}</span></span></div>`]).join("");
}
