/* Electricity: consumption integrated from the samples, daily totals, the year view,
 * and in France the Tempo color, grid carbon intensity and regulated tariff.
 * Also the daily disk space reading, kept in the same daily table for the disk drop
 * alert of changes.js. */
const ctx = require('./context');
const { fetchJson, orNull } = require('./errors');
const { DAY_MS, dayKey, colValues, storeRange } = require('./storage');
const { ps } = require('./powershell');
const { PS_DISKS } = require('./system');

const inFrance = () => ctx.cfg.country === 'FR';
const electricity = () => ctx.cfg.electricity || {};

/* ---------- Tempo color + grid carbon intensity (France) ----------
 * Public sources without a key: api-couleur-tempo.fr and éCO2mix (ODRÉ, g CO2/kWh,
 * every 15 min). If one fails, the other still shows. */
const TEMPO_COLORS = { 1: 'blue', 2: 'white', 3: 'red' };
let gridCache = { at: 0, data: null };

async function tempoDay(when) {
  const j = await orNull('Tempo', () => fetchJson(`https://www.api-couleur-tempo.fr/api/jourTempo/${when}`, { timeout: 8000 }));
  const code = j && Number(j.codeJour);
  return code >= 1 && code <= 3 ? { code, color: TEMPO_COLORS[code] } : null;   // 0 = not known yet
}

// Red and white days left in the Tempo season (1 September to 31 August). They only
// change at midnight: cached per local date.
let tempoLeftCache = { day: null, data: null };
async function tempoLeft() {
  const today = dayKey(new Date());
  if (tempoLeftCache.day === today) return tempoLeftCache.data;
  const j = await orNull('Tempo', () => fetchJson('https://www.api-couleur-tempo.fr/api/stats', { timeout: 8000 }));
  if (!j || j.joursRougesRestants == null || j.joursBlancsRestants == null) return null;
  tempoLeftCache = { day: today, data: { red: j.joursRougesRestants, white: j.joursBlancsRestants } };
  return tempoLeftCache.data;
}

/* The dataset holds future quarter hours with taux_co2 still null, so the latest
 * non-null value is asked for explicitly. The old v1 endpoint served values weeks
 * old as if current: anything older than CARBON_MAX_AGE_MS is refused. */
const CARBON_MAX_AGE_MS = 3 * 3600 * 1000;
async function carbonIntensity() {
  const u = new URL('https://odre.opendatasoft.com/api/explore/v2.1/catalog/datasets/eco2mix-national-tr/records');
  u.search = new URLSearchParams({ where: 'taux_co2 is not null', order_by: '-date_heure', limit: '1', select: 'date_heure,taux_co2' });
  const j = await orNull('éCO2mix', () => fetchJson(u));
  const r = j && j.results && j.results[0];
  if (!r || Date.now() - Date.parse(r.date_heure) > CARBON_MAX_AGE_MS) return null;
  return { gco2: Math.round(Number(r.taux_co2)), at: r.date_heure };
}

async function grid() {
  if (!inFrance()) return { tempo: null, tempoTomorrow: null, tempoLeft: null, carbon: null };
  if (gridCache.data && Date.now() - gridCache.at < 15 * 60 * 1000) return gridCache.data;
  const [tempo, tempoTomorrow, left, carbon] = await Promise.all([tempoDay('today'), tempoDay('tomorrow'), tempoLeft(), carbonIntensity()]);
  const data = { tempo, tempoTomorrow, tempoLeft: left, carbon };
  if (tempo || carbon) gridCache = { at: Date.now(), data };     // don't cache a total failure
  return data;
}

/* ---------- Regulated tariff (fallback when no price is set, France) ----------
 * open-dpe.fr publishes the TRV grids sometimes months late, hence the date sent
 * with the price. The price in config.json always wins. */
let tariffCache = { at: 0, data: null };
async function regulatedTariff() {
  if (!inFrance()) return null;
  if (tariffCache.data && Date.now() - tariffCache.at < DAY_MS) return tariffCache.data;
  const j = await orNull('open-dpe', () => fetchJson('https://open-dpe.fr/api/v1/electricity.php?tarif=EDF_bleu'));
  const p = j && j.options && j.options.base && j.options.base.prix_kWh;
  if (p) tariffCache = { at: Date.now(), data: { pricePerKwh: Number(p), date: j.date_tarif || null } };
  return tariffCache.data;
}

/* ---------- Energy used: integrating the watts already sampled ----------
 * A gap longer than GAP_MS between two samples means the PC was off and is skipped,
 * or we would count phantom consumption. A sample without watts (LHM silent) still
 * counts as time on, but not as kWh. */
const GAP_MS = 5 * 60 * 1000;

function integrateKwh(rows, baseWatts = 0) {
  let wh = 0, ms = 0, measured = 0;
  for (let i = 1; i < rows.length; i++) {
    const dt = rows[i].t - rows[i - 1].t;
    if (dt <= 0 || dt > GAP_MS) continue;
    ms += dt;
    const w = (a) => (a.pc || 0) + (a.pg || 0);
    const p0 = w(rows[i - 1]), p1 = w(rows[i]);
    if (!p0 && !p1) continue;
    wh += ((p0 + p1) / 2 + baseWatts) * (dt / 3600000);
    measured += dt;
  }
  // `hours` = time on, `measured` = time covered by watts. Average power divides by
  // the latter, or LHM's silences would drag it down.
  return { kwh: wh / 1000, hours: ms / 3600000, measured: measured / 3600000 };
}
const kwhBetween = (from, to) => integrateKwh(storeRange(from, to), electricity().baseWatts || 0);
const kwhSince = (from) => kwhBetween(from, Date.now());

/* ---------- Daily totals: the long memory of consumption ---------- */
function dailyRow(dayStart) {
  const rows = storeRange(dayStart, dayStart + DAY_MS);
  if (!rows.length) return null;                           // PC off all day
  const { kwh, hours } = kwhBetween(dayStart, dayStart + DAY_MS);
  const max = (k) => { const v = colValues(rows, k); return v.length ? Math.max(...v) : null; };
  return { kwh, hours, tc: max('c'), tg: max('g') };
}

// Today and yesterday are recomputed (yesterday is incomplete if the agent
// restarted), older days stay frozen.
function rollupDaily() {
  for (const back of [0, 1]) {
    const d0 = new Date(); d0.setHours(0, 0, 0, 0); d0.setDate(d0.getDate() - back);
    const r = dailyRow(d0.getTime());
    if (!r) continue;
    // No INSERT OR REPLACE: it deletes then reinserts the row, which would wipe
    // yesterday's disk space (`free`, `total`) every night.
    ctx.db.prepare(`INSERT INTO daily (d,kwh,hours,tc,tg,updated) VALUES (?,?,?,?,?,?)
      ON CONFLICT(d) DO UPDATE SET kwh=excluded.kwh, hours=excluded.hours,
        tc=excluded.tc, tg=excluded.tg, updated=excluded.updated`)
      .run(dayKey(d0), r.kwh, r.hours, r.tc, r.tg, Date.now());
  }
}

/* Rebuilds the days covered by samples but missing from `daily`, or the Year card
 * contradicts the Electricity card. Never writes an existing day, so idempotent. */
function backfillDaily() {
  const bounds = ctx.db.prepare('SELECT MIN(t) AS a, MAX(t) AS b FROM samples').get();
  if (!bounds.a) return;
  const known = new Set(ctx.db.prepare('SELECT d FROM daily').all().map((r) => r.d));
  const ins = ctx.db.prepare('INSERT OR IGNORE INTO daily (d,kwh,hours,tc,tg,updated) VALUES (?,?,?,?,?,?)');
  const d = new Date(bounds.a); d.setHours(0, 0, 0, 0);
  let n = 0;
  for (; d.getTime() <= bounds.b; d.setDate(d.getDate() + 1)) {
    if (known.has(dayKey(d))) continue;
    const r = dailyRow(d.getTime());
    if (!r) continue;
    ins.run(dayKey(d), r.kwh, r.hours, r.tc, r.tg, Date.now());
    n++;
  }
  if (n) console.log(`Vigie: ${n} day(s) rebuilt from samples`);
}

/* ---------- Disk space: one reading per hour, one median per day ----------
 * The median depends neither on the last hour (a big temp file at shutdown) nor on
 * the number of readings, while the maximum mechanically rises on long days. */
const GIB = 1024 ** 3;
async function rollupDisk() {
  const disks = await ps(PS_DISKS);
  if (!disks || !disks.length) return;
  const sys = (process.env.SystemDrive || 'C:').toUpperCase();
  const d = disks.find((x) => String(x.id || '').toUpperCase() === sys) || disks[0];
  if (!d.total) return;
  const start = new Date(); start.setHours(0, 0, 0, 0);
  const a = start.getTime(), b = a + DAY_MS, today = dayKey(start);
  const db = ctx.db;
  db.prepare('INSERT OR REPLACE INTO disk (t, free, total) VALUES (?, ?, ?)').run(Date.now(), d.free / GIB, d.total / GIB);
  const n = db.prepare('SELECT COUNT(*) AS n FROM disk WHERE t >= ? AND t < ?').get(a, b).n;
  const med = db.prepare('SELECT free FROM disk WHERE t >= ? AND t < ? ORDER BY free LIMIT 1 OFFSET ?').get(a, b, Math.floor(n / 2));
  // Today's row may not exist yet (agent started before the first rollup)
  db.prepare('INSERT OR IGNORE INTO daily (d, updated) VALUES (?, ?)').run(today, Date.now());
  db.prepare('UPDATE daily SET free = ?, total = ? WHERE d = ?').run(med.free, d.total / GIB, today);
}

/* ---------- Year view: what the daily table can tell ---------- */
async function year() {
  const limit = dayKey(new Date(Date.now() - 366 * DAY_MS));
  const rows = ctx.db.prepare('SELECT d, kwh, hours, tg FROM daily WHERE d >= ? ORDER BY d').all(limit);
  if (!rows.length) return { days: 0, months: [], daily: [] };
  const byMonth = new Map();
  for (const r of rows) {
    const m = r.d.slice(0, 7);
    const a = byMonth.get(m) || { month: m, kwh: 0, hours: 0, days: 0 };
    a.kwh += r.kwh || 0; a.hours += r.hours || 0; a.days++;
    byMonth.set(m, a);
  }
  // The table's first month is almost always cut short and its bar must say so.
  // We read the real start of the table, not rows[0] (limited to 366 days), or a
  // complete month in the database would be flagged partial.
  const all = ctx.db.prepare('SELECT COUNT(*) AS n, MIN(d) AS d FROM daily').get();
  const currentMonth = dayKey(new Date()).slice(0, 7);
  const auto = electricity().pricePerKwh ? null : await regulatedTariff();
  return {
    // `days`/`first` describe the whole table, `windowDays` the days summed in the bars.
    days: all.n, first: all.d, windowDays: rows.length,
    price: electricity().pricePerKwh || (auto ? auto.pricePerKwh : null),
    months: [...byMonth.values()].map((m) => ({
      ...m,
      partial: m.month === all.d.slice(0, 7) && all.d.slice(8) !== '01',
      current: m.month === currentMonth,
    })),
    // `t` is the GPU temperature alone: falling back to the CPU would make the legend lie.
    daily: rows.slice(-70).map((r) => ({ d: r.d, h: Math.round((r.hours || 0) * 10) / 10, t: r.tg != null ? Math.round(r.tg) : null })),
  };
}

/* Month-over-month comparison and end-of-month projection, read from `daily`.
 * Without a complete enough previous month, `previous` stays null rather than a
 * gap computed on three days. */
function monthStats() {
  const now = new Date();
  const sum = (prefix) => {
    const r = ctx.db.prepare('SELECT COUNT(*) AS n, SUM(kwh) AS k, SUM(hours) AS h FROM daily WHERE d LIKE ?').get(prefix + '-%');
    return r.n ? { days: r.n, kwh: r.k || 0, hours: r.h || 0 } : null;
  };
  const month = dayKey(now).slice(0, 7);
  const prevMonth = dayKey(new Date(now.getFullYear(), now.getMonth() - 1, 1)).slice(0, 7);
  const current = sum(month), previous = sum(prevMonth);
  // Linear projection, a known approximation (hence "projection", not "forecast").
  // None if the table doesn't cover the whole start of the month: the daily
  // average would be diluted by days without data.
  const first = ctx.db.prepare('SELECT MIN(d) AS d FROM daily').get().d;
  const complete = !!first && first <= month + '-01';
  const monthDays = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
  const projection = current && complete && now.getDate() >= 3 ? (current.kwh / now.getDate()) * monthDays : null;
  return {
    month, current, projection,
    // a credible previous month = at least 20 recorded days
    previous: previous && previous.days >= 20 ? { ...previous, month: prevMonth } : null,
    previousPartialDays: previous ? previous.days : 0,
  };
}

function consumption(autoTariff, tempo) {
  const now = new Date();
  const d0 = new Date(now); d0.setHours(0, 0, 0, 0);
  const today = kwhSince(d0.getTime());
  const month = kwhSince(new Date(now.getFullYear(), now.getMonth(), 1).getTime());
  const cfg = electricity();
  // price order: Tempo price for today's color > configured price > regulated tariff
  const basePrice = cfg.pricePerKwh || (autoTariff ? autoTariff.pricePerKwh : null);
  const todayPrice = (tempo && cfg.tempoPrices && cfg.tempoPrices[tempo.color]) || basePrice;
  const auto = !cfg.pricePerKwh && !!(autoTariff && autoTariff.pricePerKwh);
  // Raw samples only go back 30 days: on the 31st, the 1st is already purged. As
  // soon as `daily` covers the whole month, it is the reference.
  const stats = monthStats();
  const monthFinal = stats.projection != null && stats.current ? { kwh: stats.current.kwh, hours: stats.current.hours } : month;
  return {
    today: { ...today, cost: todayPrice ? today.kwh * todayPrice : null },
    month: { ...monthFinal, cost: basePrice ? monthFinal.kwh * basePrice : null },
    avgWatts: today.measured > 0.05 ? (today.kwh * 1000) / today.measured : null,
    baseWatts: cfg.baseWatts || 0,
    price: todayPrice, autoTariff: auto, tariffDate: auto ? autoTariff.date : null,
    // average hours on per day over 7 days: turns SSD wear into years
    hoursPerDay: kwhSince(Date.now() - 7 * DAY_MS).hours / 7,
    // kWh only: the cost is applied on display at the current price (past Tempo colors are unknown)
    monthly: stats,
  };
}

async function energy() {
  const g = await grid();
  const tariff = await regulatedTariff();
  return { ...g, consumption: consumption(tariff, g.tempo) };
}

module.exports = { integrateKwh, energy, rollupDaily, backfillDaily, rollupDisk, year };
