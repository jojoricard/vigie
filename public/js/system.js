/* System card: CPU/GPU/RAM meters with their last hour, sensor rows, the history
   chart with markers, processes, storage, batteries and the threshold banner.
   Sensors come already parsed by the agent (/sensors). */
import { $, LS, state, esc, small, getJson, load, FetchError, cssColor, GIB, MIB, COL } from "./core.js";
import { t, dec, nb, fmtDate, fmtTime } from "./i18n.js";
import { icon, deviceIcon } from "./icons.js";
import { renderEnergy } from "./energy.js";

/* ---- threshold banner (red flash at the top of the screen) ----
   Temperatures only: they are urgent and short-lived. A disk filling up is slow and
   already shows in the color of its bar, a permanent flashing banner would be noise. */
const THRESHOLDS = { cpu: 88, gpu: 95, gpuHot: 105, gpuVram: 95, liquid: 45, disk: 70, ram: 72 };
function checkHwAlerts(d) {
  const hw = {};
  if (d.cpuTemp >= THRESHOLDS.cpu) hw.cpu = `CPU ${Math.round(d.cpuTemp)} °C`;
  if (d.gpuTemp >= THRESHOLDS.gpu) hw.gpu = `GPU ${Math.round(d.gpuTemp)} °C`;
  // the real GPU risk is on the hotspot/VRAM side, hotter than the core
  if (d.gpuHot >= THRESHOLDS.gpuHot) hw.gpuHot = `GPU hotspot ${Math.round(d.gpuHot)} °C`;
  if (d.gpuVram >= THRESHOLDS.gpuVram) hw.gpuVram = `VRAM ${Math.round(d.gpuVram)} °C`;
  if (d.liquidTemp >= THRESHOLDS.liquid) hw.liquid = `${t("banner.liquid")} ${dec(d.liquidTemp)} °C`;
  if (d.ramTemp >= THRESHOLDS.ram) hw.ram = `RAM ${Math.round(d.ramTemp)} °C`;
  const hotDisk = d.diskTemps.find((v) => v >= THRESHOLDS.disk);
  if (hotDisk) hw.disk = `${t("banner.disk")} ${Math.round(hotDisk)} °C`;
  const all = Object.values(hw);
  $("alertBanner").hidden = !all.length;
  $("alertBanner").textContent = all.length ? "⚠ " + all.join("  ·  ") : "";
}

/* ---- meters: big value, temperature, and the last hour as a line ---- */
const heat = (v, warn, bad) => v == null ? "inherit" : v >= bad ? COL.bad : v >= warn ? COL.warn : "inherit";
const tempSpan = (v, warn, bad, text) => `<span style="color:${heat(v, warn, bad)}">${text}</span>`;
const fmtBps = (b) => (b == null ? "–" : b > MIB ? dec(b / MIB) + " " + t("unit.mbs") : Math.round(b / 1024) + " " + t("unit.kbs"));
// series of the last hour per meter, filled by refreshSparks()
let sparks = { cpu: [], gpu: [], ram: [] };
const SPARK_VAR = { cpu: "--accent", gpu: "--sky", ram: "--mint" };

function spark(key) {
  const values = sparks[key], color = `var(${SPARK_VAR[key]})`;
  const vs = values.filter((v) => v != null);
  if (vs.length < 2) return `<svg class="spark"></svg>`;
  // fixed 0–100 scale: load is a percentage, a flat line at 3 % must look flat
  const pts = values.map((v, i) => v == null ? null : [(i / (values.length - 1)) * 100, 40 - (Math.min(100, v) / 100) * 38]).filter(Boolean);
  const d = pts.map((p, i) => `${i ? "L" : "M"}${p[0].toFixed(2)} ${p[1].toFixed(1)}`).join("");
  // the area fades downwards, or a steady 60 % RAM turns into a solid block
  return `<svg class="spark" viewBox="0 0 100 40" preserveAspectRatio="none" aria-hidden="true">
    <defs><linearGradient id="spark-${key}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" style="stop-color:${color};stop-opacity:.24"/><stop offset="1" style="stop-color:${color};stop-opacity:0"/></linearGradient></defs>
    <path fill="url(#spark-${key})" d="${d}L${pts[pts.length - 1][0].toFixed(2)} 40L${pts[0][0].toFixed(2)} 40Z"/>
    <path class="line" style="stroke:${color}" d="${d}"/></svg>`;
}

function meter(key, label, load, sub) {
  return `<div class="meter"><div class="k">${label}</div>
    <div class="v">${load != null ? Math.round(load) : "–"}${small("%")}</div>
    <div class="s">${sub || "&nbsp;"}</div>${spark(key)}</div>`;
}

function sensorProblem(msg) {
  $("lhmStatus").hidden = false;
  $("lhmStatus").textContent = "⚠ " + msg;
  $("meters").innerHTML = meter("cpu", "CPU", null) + meter("gpu", "GPU", null) + meter("ram", "RAM", null);
  $("sysList").innerHTML = "";
}

// A 502 means LibreHardwareMonitor is down; no answer at all means the agent is.
// After 3 failed polls the page reloads once the agent is back, to start clean.
let agentFails = 0;
export async function refreshSensors() {
  let d;
  try {
    d = await getJson("/sensors");
  } catch (e) {
    if (!(e instanceof FetchError)) throw e;
    if (e.status === 502) { agentFails = 0; return sensorProblem(t("lhm.unreachable")); }
    agentFails++;
    return sensorProblem(agentFails >= 3 ? t("lhm.agentDown") : t("lhm.unreachable"));
  }
  if (agentFails >= 3) location.reload();
  agentFails = 0;
  if (!d.count) return sensorProblem(t("lhm.noSensor"));
  $("lhmStatus").hidden = true;
  const temp = (v, warn, bad, range) => v != null ? `${tempSpan(v, warn, bad, Math.round(v) + " °C")}${range ? `<span class="dim">${range}</span>` : ""}` : "";
  $("meters").innerHTML =
    meter("cpu", "CPU", d.cpuLoad, temp(d.cpuTemp, 75, THRESHOLDS.cpu, dayStats.cpu)) +
    meter("gpu", "GPU", d.gpuLoad, temp(d.gpuTemp, 80, THRESHOLDS.gpu, dayStats.gpu)) +
    meter("ram", "RAM", d.ramLoad, d.ramUsed != null ? `${dec(d.ramUsed)} ${t("unit.gb")}${state.totalRamGb ? `<span class="dim">/ ${Math.round(state.totalRamGb)} ${t("unit.gb")}</span>` : ""}` : "");
  // Installed RAM, from "used / %": the scale of the memory column
  if (d.ramUsed > 0 && d.ramLoad > 1) state.totalRamGb = (d.ramUsed / d.ramLoad) * 100;
  // live power feeds the Electricity card, redrawn when it moves by 5 W
  const watts = (d.cpuPower || 0) + (d.gpuPower || 0) || null;
  if (watts != null && Math.round(watts / 5) !== Math.round((state.liveWatts || 0) / 5)) {
    state.liveWatts = watts;
    renderEnergy();
  }
  // Two fans with the same name are told apart by their source.
  const names = {};
  d.fans.forEach((f) => (names[f.name] = (names[f.name] || 0) + 1));
  const row = (k, v) => `<div><span class="k">${k}</span><span class="v">${v}</span></div>`;
  const tc = (v, warn, bad) => v == null ? "–" : tempSpan(v, warn, bad, Math.round(v));
  $("sysList").innerHTML = [
    d.net ? row(t("sys.network"), `↓ ${fmtBps(d.net.down)}&nbsp;&nbsp;↑ ${fmtBps(d.net.up)}`) : "",
    d.diskTemps.length ? row(t("sys.diskTemp"), d.diskTemps.map((v) => tempSpan(v, 60, THRESHOLDS.disk, `${Math.round(v)} °C`)).join("&nbsp;&nbsp;")) : "",
    d.liquidTemp != null ? row(t("sys.liquid"), tempSpan(d.liquidTemp, 40, THRESHOLDS.liquid, `${dec(d.liquidTemp)} °C`)) : "",
    d.gpuHot != null || d.gpuVram != null ? row(t("sys.gpuDetail"), `${tc(d.gpuHot, 95, THRESHOLDS.gpuHot)} / ${tc(d.gpuVram, 90, THRESHOLDS.gpuVram)} °C`) : "",
    d.ramTemp != null ? row(t("sys.ramTemp"), tempSpan(d.ramTemp, 60, THRESHOLDS.ram, `${Math.round(d.ramTemp)} °C`)) : "",
    ...d.fans.map((f) => row(esc(f.name) + (names[f.name] > 1 ? " · " + t("fan." + f.source) : ""), `${nb(f.rpm)} ${t("unit.rpm")}`)),
  ].join("");
  renderSsd(d.ssd);
  checkHwAlerts(d);
}

function renderSsd(ssd) {
  $("ssdHealth").hidden = !ssd;
  if (!ssd) return;
  const parts = [];
  if (ssd.life != null) parts.push(`<b style="color:${ssd.life < 20 ? COL.bad : ssd.life < 50 ? COL.warn : "var(--ink)"}">${t("ssd.life", Math.round(ssd.life))}</b>`);
  if (ssd.hours != null) parts.push(`${nb(Math.round(ssd.hours))} h`);
  if (ssd.writtenTB != null) parts.push(t("ssd.written", nb(ssd.writtenTB, 0)));
  // lifespan: past wear extrapolated at the observed rate of use
  if (ssd.life != null && ssd.hours > 100 && ssd.life > 0 && ssd.life < 100) {
    const hoursLeft = ssd.hours * (ssd.life / (100 - ssd.life));
    const perDay = state.energy ? state.energy.consumption.hoursPerDay : null;
    parts.push(perDay > 0.5 ? t("ssd.years", Math.round(hoursLeft / (perDay * 365))) : t("ssd.hours", Math.round(hoursLeft / 1000)));
  }
  $("ssdHealth").innerHTML = `${icon("chip")}<span>${t("ssd.prefix")}${parts.join(", ")}</span>`;
}

/* ---- history (/history?range=) ----
   Columns of samples[]: [t, c, g, l, cl, gl, rf, nd, nu, d, fg, fs, pc, pg, pi]
   (CPU/GPU/liquid temp, CPU/GPU/RAM load, network down/up, disk temp, GPU/system
   fans, CPU/GPU power in W, latency in ms). A new column goes at the end
   (HIST_KEYS in agent.js), or the indexes below shift. */
const METRICS = {
  temp:    { series: () => [[1, "--accent", "CPU"], [2, "--sky", "GPU"], [3, "--mint", t("hist.liquid")], [9, "--amber", t("hist.disk")]], axis: (v) => v + "°" },
  load:    { series: () => [[4, "--accent", "CPU"], [5, "--sky", "GPU"], [6, "--mint", "RAM"]], fixed: [0, 100], axis: (v) => v + " %" },
  network: { series: () => [[7, "--accent", t("hist.down")], [8, "--sky", t("hist.up")]], zero: true, axis: (v) => v >= MIB ? (v / MIB).toFixed(0) + "M" : Math.round(v / 1024) + "K" },
  fans:    { series: () => [[10, "--sky", "GPU"], [11, "--accent", t("hist.case")]], zero: true, axis: (v) => Math.round(v) + "" },
  power:   { series: () => [[12, "--accent", "CPU"], [13, "--sky", "GPU"]], zero: true, axis: (v) => Math.round(v) + " W" },
  latency: { series: () => [[14, "--mint", t("hist.internet")]], zero: true, axis: (v) => Math.round(v) + " ms" },
};
let histRange = LS.get("vigie.histRange", "1d");
let histMetric = METRICS[LS.get("vigie.histMetric", "temp")] ? LS.get("vigie.histMetric", "temp") : "temp";
let lastHist = null;
let markers = [];
let dayStats = { cpu: "", gpu: "" }; // today's min/max temperatures, shown under the meters

export async function refreshHistory() {
  const j = await load("/history?range=" + histRange);
  if (!j) return;
  lastHist = j;
  const fmt = (v) => (v ? t("hist.today", v[0], v[1]) : "");
  dayStats = { cpu: fmt(j.today.c), gpu: fmt(j.today.g) };
  drawHistory();
}

// The meters' lines: the last hour, whatever range the chart shows.
export async function refreshSparks() {
  const j = await load("/history?range=1h");
  if (!j) return;
  sparks = { cpu: j.samples.map((s) => s[4]), gpu: j.samples.map((s) => s[5]), ram: j.samples.map((s) => s[6]) };
}

// Metric or range tabs of the chart (attr = "m" or "r").
function initTabs(id, attr, getCur, setCur) {
  const el = $(id);
  const sync = () => el.querySelectorAll("span").forEach((s) => s.classList.toggle("on", s.dataset[attr] === getCur()));
  el.querySelectorAll("span").forEach((s) => s.onclick = () => { setCur(s.dataset[attr]); sync(); refreshHistory(); });
  sync();
}
export function initHistControls() {
  initTabs("histRange", "r", () => histRange, (v) => { histRange = v; LS.set("vigie.histRange", v); });
  initTabs("histMetric", "m", () => histMetric, (v) => { histMetric = v; LS.set("vigie.histMetric", v); });
}

const markerLabel = (r) => r.type === "incident" ? t("incident." + r.kind) : t("marker." + r.kind, r.label);

/* Chart markers (incidents + driver/BIOS/Windows dates). Refreshed rarely: they
   are dates, they don't move during the day. */
export async function refreshMarkers() {
  const j = await load("/markers");
  if (!j) return;
  markers = j;
  drawHistory();
}

export function drawHistory() {
  const h = lastHist;
  const cv = $("histCanvas");
  const W = cv.clientWidth, H = cv.clientHeight;
  if (!W) return;                      // hidden tab: redrawn when shown
  // pixels per CSS pixel: the screen's ratio times the page zoom (only the rect includes it)
  const k = (devicePixelRatio || 1) * cv.getBoundingClientRect().width / W;
  cv.width = W * k; cv.height = H * k;
  const ctx = cv.getContext("2d"); ctx.scale(k, k); ctx.clearRect(0, 0, W, H);
  const ink3 = cssColor("--ink-3"), rule = cssColor("--rule");
  const font = (px) => `${px}px Bahnschrift, "Segoe UI", sans-serif`;
  const hist = h && h.samples;
  if (!hist || hist.length < 2) { ctx.fillStyle = ink3; ctx.font = font(13); ctx.fillText(t("hist.collecting"), 10, H / 2); return; }
  const m = METRICS[histMetric];
  const series = m.series().map(([i, v, label]) => [i, cssColor(v), label]);

  // Continuous segments, cut where the PC was off. The X axis follows the point
  // index, not time: segments touch and long gaps disappear.
  const gapMax = h.bucket * 2.5;
  const segs = [[0]];
  for (let i = 1; i < hist.length; i++) {
    if (hist[i][0] - hist[i - 1][0] > gapMax) segs.push([i]); else segs[segs.length - 1].push(i);
  }
  const col = new Array(hist.length); // column index of each point
  const breaks = [];                  // break columns (PC off)
  let c = 0;
  segs.forEach((seg, si) => { if (si) { breaks.push(c); c++; } for (const idx of seg) col[idx] = c++; });
  const lastCol = c - 1;
  const X = (cc) => 34 + (lastCol ? cc / lastCol : 0) * (W - 38);

  const vals = hist.flatMap((s) => series.map(([i]) => s[i])).filter((v) => v != null);
  let mn, mx, step;
  if (m.fixed) { [mn, mx] = m.fixed; step = 25; }
  else if (m.zero) { mn = 0; mx = (vals.length && Math.max(...vals) > 0 ? Math.max(...vals) : 1) * 1.15; step = mx / 4; }
  else { const lo = vals.length ? Math.min(...vals) : 30, hi = vals.length ? Math.max(...vals) : 80; mn = Math.floor(lo / 5) * 5 - 5; mx = Math.ceil(hi / 5) * 5 + 5; step = 10; }
  const Y = (v) => H - 18 - ((v - mn) / (mx - mn)) * (H - 28);

  // horizontal grid + value axis
  ctx.font = font(11); ctx.fillStyle = ink3; ctx.strokeStyle = rule; ctx.lineWidth = 1;
  for (let v = mn + (m.fixed || m.zero ? step : step / 2); v < mx; v += step) {
    ctx.beginPath(); ctx.moveTo(34, Math.round(Y(v)) + .5); ctx.lineTo(W - 4, Math.round(Y(v)) + .5); ctx.stroke();
    ctx.fillText(m.axis(Math.round(v)), 0, Y(v) + 4);
  }

  // breaks (PC off): thin dotted line
  ctx.setLineDash([2, 3]);
  for (const bc of breaks) { const x = Math.round(X(bc)) + .5; ctx.beginPath(); ctx.moveTo(x, 4); ctx.lineTo(x, H - 16); ctx.stroke(); }
  ctx.setLineDash([]);

  // time labels: end of the last point first, then segment starts from left to
  // right, skipping the ones that would overlap
  const multi = h.rangeMs >= 48 * 3600e3;
  const lab = (ts) => (multi ? fmtDate(ts, { weekday: "short" }) + " " : "") + fmtTime(ts);
  ctx.textAlign = "left";
  const PAD = 10;
  const endTxt = lab(hist[hist.length - 1][0]);
  const endX = Math.min(X(col[hist.length - 1]), W - 2);
  const endLeft = endX - ctx.measureText(endTxt).width;
  let lastRight = -999;
  for (const seg of segs) {
    const idx = seg[0], x = X(col[idx]) + 2, txt = lab(hist[idx][0]), w = ctx.measureText(txt).width;
    if (x < lastRight + PAD || x + w > endLeft - PAD) continue;
    ctx.fillText(txt, x, H - 3);
    lastRight = x + w;
  }
  ctx.textAlign = "right";
  ctx.fillText(endTxt, endX, H - 3);
  ctx.textAlign = "left";

  // curves, segment by segment (lines never cross a break)
  for (const [idx, color] of series) {
    ctx.strokeStyle = color; ctx.lineWidth = 1.6; ctx.lineJoin = "round";
    for (const seg of segs) {
      ctx.beginPath(); let started = false;
      for (const gi of seg) {
        const v = hist[gi][idx]; if (v == null) continue;
        const x = X(col[gi]), y = Y(v);
        if (started) ctx.lineTo(x, y); else ctx.moveTo(x, y);
        started = true;
      }
      ctx.stroke();
    }
  }

  // markers on top of the curves. With an X axis indexed on points, a date takes
  // the column of the nearest sample, not a rule of three.
  const t0 = hist[0][0], t1 = hist[hist.length - 1][0];
  const xForDate = (ts) => {
    if (ts < t0 || ts > t1) return null;
    let best = 0, bd = Infinity;
    for (let i = 0; i < hist.length; i++) {
      const dd = Math.abs(hist[i][0] - ts);
      if (dd < bd) { bd = dd; best = i; }
    }
    return X(col[best]);
  };
  const marks = markers.map((r) => ({ ...r, x: xForDate(r.t) })).filter((r) => r.x != null).sort((a, b) => a.x - b.x);
  const incidentCol = cssColor("--coral"), updateCol = cssColor("--accent");
  ctx.font = font(11);
  const rowEnd = [-999, -999];                // right edge used on each of the 2 rows
  for (const r of marks) {
    const c2 = r.type === "incident" ? incidentCol : updateCol;
    ctx.strokeStyle = c2; ctx.globalAlpha = .6; ctx.lineWidth = 1;
    ctx.setLineDash(r.type === "incident" ? [] : [3, 3]);
    ctx.beginPath(); ctx.moveTo(Math.round(r.x) + .5, 2); ctx.lineTo(Math.round(r.x) + .5, H - 16); ctx.stroke();
    ctx.globalAlpha = 1;
    // labels on two rows, skipping the ones that would overlap: better a silent
    // marker than a mess of text
    const txt = markerLabel(r);
    const w = ctx.measureText(txt).width;
    const row = rowEnd[0] <= r.x + 2 ? 0 : rowEnd[1] <= r.x + 2 ? 1 : -1;
    if (row < 0 || r.x + 4 + w > W) continue;
    ctx.fillStyle = c2;
    ctx.fillText(txt, r.x + 4, 11 + row * 13);
    rowEnd[row] = r.x + 4 + w + 8;
  }
  ctx.setLineDash([]);

  // legend: only series with data, and only the marker types actually drawn
  $("histLegend").innerHTML = series
    .filter(([i]) => hist.some((s) => s[i] != null))
    .map(([, color, label]) => `<span><i style="background:${color}"></i>${label}</span>`).join("")
    + (marks.some((r) => r.type === "incident") ? `<span><i style="background:${incidentCol}"></i>${t("hist.incident")}</span>` : "")
    + (marks.some((r) => r.type === "update") ? `<span><i style="background:${updateCol}"></i>${t("hist.update")}</span>` : "");
}

/* ---- uptime and top processes ---- */
const fmtUptime = (s) => { const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60); return (d ? d + " " + t("unit.day") + " " : "") + h + " h " + String(m).padStart(2, "0"); };

export async function refreshSystem() {
  const j = await load("/system");
  if (!j) return;
  $("uptimeVal").textContent = t("sys.upFor", fmtUptime(j.uptime));
  // No bars here: at rest the values sit within a few percent and a bar shows
  // nothing. Aligned figures compare well on their own.
  const head = `<tr class="pHead"><td>${t("proc.name")}</td><td class="r">${t("proc.cpu")}</td><td class="r">${t("proc.mem")}</td></tr>`;
  $("procTable").innerHTML = head + (j.processes.map((p) => {
    const col = p.cpu > 50 ? COL.bad : p.cpu > 25 ? COL.warn : "inherit";
    return `<tr>
      <td>${esc(p.name)}${p.count > 1 ? ` <span class="count">×${p.count}</span>` : ""}</td>
      <td class="r num" style="color:${col}">${dec(p.cpu)} %</td>
      <td class="r num">${dec(p.mem / GIB)} ${t("unit.gb")}</td></tr>`;
  }).join("") || '<tr><td class="err" colspan="3">–</td></tr>');
}

/* ---- disks and batteries ---- */
export async function refreshDevices() {
  const j = await load("/devices");
  if (!j) return;
  $("diskList").innerHTML = j.disks.map((d) => {
    const used = Math.round(((d.total - d.free) / d.total) * 100);
    return `<div class="diskRow"><div class="l"><span>${esc(d.id)}</span><span class="muted num">${t("disk.free", nb(d.free / GIB), used)}</span></div>
      <div class="barline"><i style="width:${used}%;background:${used > 90 ? COL.bad : used > 75 ? COL.warn : "var(--accent)"}"></i></div></div>`;
  }).join("") || '<div class="err">–</div>';
  $("btList").classList.remove("err");
  $("btList").innerHTML = j.batteries.length
    ? j.batteries.map((b) => `<div class="btRow${b.stale ? " stale" : ""}"${b.stale ? ` title="${t("battery.stale")}"` : ""}><span>${deviceIcon(b.name)}${esc(b.name)}</span><span class="num" style="color:${!b.stale && b.level < 20 ? COL.bad : "inherit"}">${b.stale ? "~" : ""}${b.level} %</span></div>`).join("")
    : `<div class="err">${t("battery.none")}</div>`;
}
