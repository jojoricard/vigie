/* One engine for every alert of the page. Each source gives candidates: a condition
   that holds now, with a severity and how long it must have held to count. The engine
   keeps when each one was first seen and which ones were acknowledged, and gives the
   alerts in progress: they feed the band of the Overview, the pill of the tab bar, the
   night screen and the briefing. An acknowledged alert stays quiet until it gets worse
   (a higher severity, a lower battery, less free space...), until a day has passed, or
   until its condition has gone for a while and come back. collect() and evaluate() are pure. */
import { $, LS, state, esc, DAY_MS } from "./core.js";
import { t, fmtTime, fmtDate, dayKey } from "./i18n.js";
import { icon, alertIcon } from "./icons.js";
import { changeText } from "./machine.js";

// Thresholds and durations, each overridable under "alerts" in config.json.
export const RULES = {
  batteryPct: 20,          // a mouse, a keyboard, a headset at or below: the level at which they start to warn too
  diskFreePct: 8,          // free space of a disk, in % of its size
  ssdLifePct: 15,          // life left of the system SSD
  unreachableMin: 10,      // a device of the house without an answer for that long
  climateOnHours: 12,      // an air conditioner or a heater on without a break
  incidentHours: 24,       // an incident of the PC stays an alert that long
  ackHours: 24,            // an acknowledged alert still there comes back after that long
  goneMin: 15,             // a condition missing that long is over; less is a source still loading or a blip
  cpuTemp: 88, gpuTemp: 95, gpuHotTemp: 105, diskTemp: 70, tempHoldMin: 1,
};
const RANK = { red: 3, orange: 2, yellow: 1 };

/* What holds now. `s` is the state of the page (or a part of it, in the tests).
   Returns [{ id, kind, severity, hold (minutes), ...what the text needs }]. */
export function collect(s, rules = RULES, now = Date.now()) {
  const out = [];
  const add = (id, kind, severity, extra = {}, hold = 0) => out.push({ id, kind, severity, hold, ...extra });
  for (const a of s.alerts || []) {
    if (a.severity === "orange" || a.severity === "red") add(`warning:${a.type}:${a.area}`, "warning", a.severity, { type: a.type, area: a.area, expires: a.expires || null });
  }
  const e = s.energy;
  if (e && e.tempoTomorrow && e.tempoTomorrow.code === 3) add(`tempo:${dayKey(new Date(now + DAY_MS))}`, "tempoRed", "yellow");
  if (s.lastCrash && now - s.lastCrash.at < rules.incidentHours * 3600e3) add(`incident:${s.lastCrash.at}`, "incident", "orange", { type: s.lastCrash.type, at: s.lastCrash.at });
  for (const c of s.changes || []) if (c.level === "alert") add(`change:${c.kind}`, "change", "orange", { change: c });
  const d = s.sensors;
  if (d) {
    const hot = (key, value, limit) => { if (value != null && value >= limit) add(`temp:${key}`, "temp", "red", { part: key, value: Math.round(value), worse: Math.round(value) }, rules.tempHoldMin); };
    hot("cpu", d.cpuTemp, rules.cpuTemp); hot("gpu", d.gpuTemp, rules.gpuTemp); hot("gpuHot", d.gpuHot, rules.gpuHotTemp);
    hot("disk", Math.max(...(d.diskTemps || []), -Infinity), rules.diskTemp);
    if (d.ssd && d.ssd.life != null && d.ssd.life <= rules.ssdLifePct) add("ssd", "ssd", d.ssd.life <= rules.ssdLifePct / 2 ? "red" : "orange", { life: Math.round(d.ssd.life), worse: -Math.round(d.ssd.life) });
  }
  for (const k of (s.devices && s.devices.disks) || []) {
    const free = k.total ? (k.free / k.total) * 100 : 100;
    if (free <= rules.diskFreePct) add(`disk:${k.id}`, "disk", free <= rules.diskFreePct / 2 ? "red" : "orange", { disk: k.id, free: Math.round(free), worse: -Math.round(free) });
  }
  for (const b of (s.devices && s.devices.batteries) || []) {
    if (!b.stale && b.level <= rules.batteryPct) add(`battery:${b.name}`, "battery", "yellow", { name: b.name, level: b.level, worse: -b.level });
  }
  const w = s.windows;
  if (w && w.reboot && w.reboot.length) add("windows:reboot", "reboot", "yellow");
  if (w && w.updates && w.updates.length) add("windows:updates", "updates", "yellow", { count: w.updates.length });
  for (const room of (s.house && s.house.rooms) || []) {
    for (const dev of room.devices) {
      const st = dev.state || {}, where = { name: dev.name, room: room.name };
      // a lamp cut at its wall switch is silent on the LAN, or lost by the cloud: a state of the lamp, not a failure
      if (!st.reachable && st.error !== "lanSilent" && st.error !== "cloudOffline") add(`unreachable:${dev.id}`, "unreachable", "yellow", where, rules.unreachableMin);
      if (!st.reachable) continue;
      if ((dev.type === "climate" || dev.type === "heater") && st.on) add(`longOn:${dev.id}`, "longOn", "yellow", { ...where, hours: rules.climateOnHours }, rules.climateOnHours * 60);
      // a washing machine, or any appliance behind a plug that measures its power
      if ((dev.type === "washer" || dev.type === "plug") && st.run === "done") add(`laundry:${dev.id}`, "laundry", "yellow", where);
      if (dev.type === "leak" && st.leak) add(`leak:${dev.id}`, "leak", "red", where);
    }
  }
  const net = s.home && s.home.network;
  if (net && net.state && net.state !== "up") add("connection", "connection", "red", { since: net.since || null }, 1);
  return out;
}

/* The alerts in progress among the candidates, and the memory to keep:
   { seen: { id: first time }, acked: { id: { at, severity, worse } }, gone: { id: since } }.
   `worse` is a number that grows as the trouble does (minus the battery level, minus the
   free space, the temperature). An acknowledged alert comes back when it is worse than
   when it was acknowledged, or once ackHours have passed. A candidate that goes missing
   keeps its memory for goneMin: after a reload the sources are not all loaded yet, and
   an alert must neither come back as new nor lose its acknowledgment for that. */
export function evaluate(candidates, memory = {}, now = Date.now(), rules = RULES) {
  const seen = {}, acked = {}, gone = {};
  const active = [], here = new Set(candidates.map((c) => c.id));
  for (const c of candidates) {
    seen[c.id] = (memory.seen && memory.seen[c.id]) || now;
    let ack = memory.acked && memory.acked[c.id];
    if (typeof ack === "number") ack = { at: ack };      // the memory of an earlier version
    const back = ack && (now - ack.at >= rules.ackHours * 3600e3
      || (ack.severity && RANK[c.severity] > RANK[ack.severity])
      || (ack.worse != null && c.worse != null && c.worse > ack.worse));
    if (ack && !back) { acked[c.id] = ack; continue; }
    if (now - seen[c.id] >= (c.hold || 0) * 60000) active.push({ ...c, since: seen[c.id] });
  }
  // what went missing is kept a while, then forgotten
  for (const id of Object.keys(memory.seen || {})) {
    if (here.has(id)) continue;
    const since = (memory.gone && memory.gone[id]) || now;
    if (now - since >= rules.goneMin * 60000) continue;
    seen[id] = memory.seen[id]; gone[id] = since;
    if (memory.acked && memory.acked[id]) acked[id] = memory.acked[id];
  }
  active.sort((a, b) => RANK[b.severity] - RANK[a.severity] || a.since - b.since);
  return { active, memory: { seen, acked, gone } };
}

export const worst = (list) => list.reduce((w, a) => RANK[a.severity] > (RANK[w] || 0) ? a.severity : w, null);

/* ---------- Page ---------- */
const KIND_ICON = { tempoRed: "bolt", incident: "alert", change: "signal", temp: "thermoUp", ssd: "disk", disk: "disk", battery: "battery", reboot: "restart", updates: "download", unreachable: "signalBroken", longOn: "flame", laundry: "washer", leak: "drop", connection: "signalBroken" };
const iconOf = (a) => a.kind === "warning" ? alertIcon(a.type) : icon(KIND_ICON[a.kind] || "alert");
const whenOf = (ts) => dayKey(new Date(ts)) === dayKey() ? fmtTime(ts) : fmtDate(ts, { weekday: "short", hour: "2-digit", minute: "2-digit" });

// Title and detail of an alert, in the language of the page.
export function alertText(a) {
  // a break found by the agent keeps the wording it has in the Machine tab
  if (a.kind === "change") return changeText(a.change);
  const [title, detail] = t("notice." + a.kind);
  const f = (v) => typeof v === "function" ? v(a) : v;
  return { title: f(title), detail: f(detail) };
}

let memory = LS.get("vigie.alerts", {});
let told = null;
export function refreshNotices() {
  if (!state.cfg) return;
  const rules = { ...RULES, ...(state.cfg.alerts || {}) };
  const result = evaluate(collect(state, rules), memory, Date.now(), rules);
  memory = result.memory;
  LS.set("vigie.alerts", memory);
  state.notices = result.active;
  render();
}

// Acknowledged as it is now: worse than that, it comes back.
export function acknowledge(id) {
  const a = (state.notices || []).find((x) => x.id === id) || {};
  memory = { ...memory, acked: { ...(memory.acked || {}), [id]: { at: Date.now(), severity: a.severity || null, worse: a.worse ?? null } } };
  refreshNotices();
}

// The line of an alert on the night screen and in the band.
export const noticeLine = (a) => { const x = alertText(a); return `<div class="${a.severity}">${iconOf(a)}<span>${esc(x.title)}</span></div>`; };

function render() {
  const list = state.notices, band = $("alertBand");
  band.hidden = !list.length;
  band.dataset.sev = worst(list) || "";
  $("alertRows").innerHTML = list.map((a) => {
    const x = alertText(a);
    return `<div class="alertRow ${a.severity}">${iconOf(a)}
      <div class="tx"><div class="tt">${esc(x.title)}</div><div class="dd">${[esc(x.detail), t("notice.since", whenOf(a.since))].filter(Boolean).join(" · ")}</div></div>
      <button type="button" class="chip" data-ack="${esc(a.id)}">${t("notice.ack")}</button></div>`;
  }).join("");
  // told only when the alerts change: this runs after every refresh, every few seconds
  const now = list.map((a) => `${a.id}:${a.severity}`).join("|");
  if (now === told) return;
  told = now;
  document.dispatchEvent(new CustomEvent("vigie:notices"));
}

export function wireNotices() {
  $("alertRows").addEventListener("click", (e) => { const b = e.target.closest("[data-ack]"); if (b) acknowledge(b.dataset.ack); });
}
