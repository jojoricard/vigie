/* Top processes, disks and device batteries (Bluetooth + Logitech). */
const fs = require('fs');
const os = require('os');
const path = require('path');
const ctx = require('./context');
const { ps, psIsolated } = require('./powershell');
const { SourceError, fetchText, parseJson, logError } = require('./errors');
const { DAY_MS } = require('./storage');

const NCPU = Math.max(1, os.cpus().length);

/* ---------- Top processes (CPU delta between two snapshots) ---------- */
const PS_PROC =
  "Get-Process | Group-Object ProcessName | ForEach-Object { " +
  "$cpu = ($_.Group | Where-Object { $_.CPU } | Measure-Object CPU -Sum).Sum; " +
  "$mem = ($_.Group | Measure-Object WorkingSet64 -Sum).Sum; " +
  "[pscustomobject]@{ n = $_.Name; c = [math]::Round([double]$cpu, 3); m = [long]$mem; i = $_.Count } " +
  "} | ConvertTo-Json -Compress";

/* The page polls /system every 30 s. This cache only absorbs bursts (reload,
 * second tab), and its TTL is a bit shorter than the poll interval: otherwise a
 * request arriving a few ms early gets the previous list and CPU deltas look
 * frozen for a whole cycle. The promise is cached so two close calls share one
 * measurement. */
const PROC_TTL_MS = 25000;
let procCache = { at: 0, res: null };
let prevSnap = null;

function topProcesses() {
  if (procCache.res && Date.now() - procCache.at < PROC_TTL_MS) return procCache.res;
  procCache = { at: Date.now(), res: measureProcesses() };
  return procCache.res;
}

async function measureProcesses() {
  const rows = await ps(PS_PROC);
  if (!rows) return [];
  const now = Date.now();
  const map = {};
  for (const r of rows) map[r.n] = { cpu: r.c || 0, mem: r.m || 0, count: r.i || 1 };
  const elapsed = prevSnap && now - prevSnap.at > 1500 ? (now - prevSnap.at) / 1000 : null;
  const list = Object.keys(map).map((n) => {
    const prev = elapsed && prevSnap.map[n];
    const d = prev ? Math.max(0, map[n].cpu - prev.cpu) : 0;
    return { name: n, cpu: elapsed ? Math.min(100, (d / elapsed / NCPU) * 100) : 0, mem: map[n].mem, count: map[n].count };
  });
  list.sort((a, b) => b.cpu - a.cpu || b.mem - a.mem);
  prevSnap = { at: now, map };
  return list.filter((p) => !['Idle', 'System'].includes(p.name)).slice(0, 7);
}

/* ---------- Disks + Bluetooth ---------- */
const PS_DISKS =
  "Get-CimInstance Win32_LogicalDisk -Filter 'DriveType=3' | ForEach-Object { " +
  "[pscustomobject]@{ id = $_.DeviceID; total = [long]$_.Size; free = [long]$_.FreeSpace } } | ConvertTo-Json -Compress";

const PS_BT =
  // Windows keeps paired devices "present" when they are off, with a cached
  // battery level: keep only those actually connected.
  "Get-PnpDevice -PresentOnly -Class Bluetooth -ErrorAction SilentlyContinue | ForEach-Object { " +
  "$conn = Get-PnpDeviceProperty -InstanceId $_.InstanceId -KeyName '{83DA6326-97A6-4088-9453-A1923F573B29} 15' -ErrorAction SilentlyContinue; " +
  "if ($conn -and $conn.Data -eq $true) { " +
  "$p = Get-PnpDeviceProperty -InstanceId $_.InstanceId -KeyName '{104EA319-6EE2-4701-BD47-8DDBF425BBE5} 2' -ErrorAction SilentlyContinue; " +
  "if ($p -and $p.Data -ne $null) { [pscustomobject]@{ name = $_.FriendlyName; level = [int]$p.Data } } } " +
  "} | Where-Object { $_ } | ConvertTo-Json -Compress";

/* ---------- Logitech batteries through LGSTrayBattery (local API) ----------
 * Asleep, Lightspeed/Unifying devices answer -1 or vanish from LGSTray: we keep
 * the last known value (.batteries.json), flagged `stale`. */
const BATT_STALE_MS = 15 * 60 * 1000;          // beyond: shown as asleep
const BATT_EXPIRE_MS = 7 * DAY_MS;             // beyond: device forgotten
const battFile = () => path.join(ctx.root, '.batteries.json');
let lastBatt = null;

function loadBatteries() {
  try {
    return JSON.parse(fs.readFileSync(battFile(), 'utf8'));
  } catch (e) {
    if (e.code === 'ENOENT') return {};
    if (!(e instanceof SyntaxError)) throw e;
    logError('.batteries.json', new Error('unreadable, starting from scratch'));
    return {};
  }
}

// Depending on the version, LGSTray listens on IPv4 only or IPv6 only: try both.
async function lgstrayFetch(suffix) {
  const cfg = (ctx.cfg.lgstrayUrl || 'http://localhost:12321').replace(/\/$/, '');
  const bases = [...new Set([cfg, cfg.replace('127.0.0.1', 'localhost'), cfg.replace('localhost', '127.0.0.1'), cfg.replace(/127\.0\.0\.1|localhost/, '[::1]')])];
  let lastErr;
  for (const base of bases) {
    try { return await fetchText(base + suffix, { timeout: 4000 }); }
    catch (e) { if (!(e instanceof SourceError)) throw e; lastErr = e; }
  }
  throw lastErr;
}

// LGSTray answers JSON or HTML depending on the version.
async function lgstrayDevices() {
  const text = await lgstrayFetch('/devices');
  if (text.trim().startsWith('[') || text.trim().startsWith('{')) {
    const j = parseJson(text, 'LGSTray');
    return (Array.isArray(j) ? j : j.devices || []).map((d) => ({ id: d.deviceID || d.device_id || d.id, name: d.deviceName || d.device_name || d.name }));
  }
  const devs = [];
  const re = /\/device\/([\w.-]+)['"]?[^>]*>([^<]*)/gi;
  let m;
  while ((m = re.exec(text))) devs.push({ id: m[1], name: (m[2] || '').trim() });
  return devs;
}

async function lgstrayBattery(d) {
  const x = await lgstrayFetch('/device/' + encodeURIComponent(d.id));
  let name = d.name, pct = null;
  if (x.trim().startsWith('{')) {
    const j = parseJson(x, 'LGSTray');
    pct = j.battery_percent ?? j.batteryPercent ?? j.percentage;
    name = j.device_name || j.deviceName || name;
  } else {
    const pm = x.match(/battery_percent[^0-9-]*(-?[\d.]+)/i);
    if (pm) pct = parseFloat(pm[1]);
    const nm = x.match(/device_name[^>]*>([^<]+)</i);
    if (nm) name = nm[1].trim();
  }
  // pct < 0: device asleep, keep the last value
  return pct != null && pct >= 0 && pct <= 100 ? { name: name || 'Logitech', level: Math.round(pct) } : null;
}

async function logitechBatteries() {
  if (!lastBatt) lastBatt = loadBatteries();
  const now = Date.now();
  let fresh = [];
  try {
    const devs = (await lgstrayDevices()).filter((d) => d.id).slice(0, 8);
    fresh = await Promise.all(devs.map((d) => lgstrayBattery(d).catch((e) => { if (!(e instanceof SourceError)) throw e; return null; })));
  } catch (e) {
    // LGSTray unreachable: the last known values below still show
    if (!(e instanceof SourceError)) throw e;
    logError('LGSTray', e);
  }
  let changed = false;
  for (const b of fresh) {
    if (!b) continue;
    lastBatt[b.name] = { level: b.level, at: now };
    changed = true;
  }
  for (const k of Object.keys(lastBatt)) {
    if (now - lastBatt[k].at > BATT_EXPIRE_MS) { delete lastBatt[k]; changed = true; }
  }
  if (changed) fs.writeFileSync(battFile(), JSON.stringify(lastBatt));
  return Object.entries(lastBatt).map(([name, v]) => ({ name, level: v.level, stale: now - v.at > BATT_STALE_MS }));
}

let devCache = { at: 0, data: null };
async function devices() {
  if (devCache.data && Date.now() - devCache.at < 120000) return devCache.data;
  const [disks, bt, logi] = await Promise.all([ps(PS_DISKS), psIsolated(PS_BT), logitechBatteries()]);
  const seen = new Set();
  const batteries = [...logi, ...(bt || [])].filter((b) => {
    const k = (b.name || '').toLowerCase();
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  devCache = { at: Date.now(), data: { disks: disks || [], batteries } };
  return devCache.data;
}

module.exports = { topProcesses, devices, PS_DISKS };
