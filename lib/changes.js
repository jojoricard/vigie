/* What changed: the present compared with the machine's past, and the chart markers.
 * Everywhere: median rather than mean, a relative threshold and a minimum absolute
 * gap (2 → 5 ms is not an alert), a minimum number of samples on both sides.
 * Otherwise the card cries wolf and ends up ignored. Each change is a code with its
 * figures: the page writes title and detail in its language. */
const ctx = require('./context');
const { DAY_MS, dayKey, sqlMedian } = require('./storage');
const { crashReport } = require('./crash');
const { machine } = require('./machine');

const r1 = (v) => Math.round(v * 10) / 10;

function latencyChange(now) {
  const lat1 = sqlMedian('pi', now - 3600e3, now);
  const lat7 = sqlMedian('pi', now - 7 * DAY_MS, now - 3600e3);
  if (lat1.n >= 20 && lat7.n >= 200 && lat1.med >= lat7.med * 2 && lat1.med - lat7.med >= 15) {
    return { level: 'alert', kind: 'latency', recent: Math.round(lat1.med), usual: Math.round(lat7.med) };
  }
  return null;
}

function lossChange(now) {
  // COUNT(pi) skips NULLs: the gap with COUNT(*) is the failures.
  const l = ctx.db.prepare('SELECT COUNT(*) AS tot, COUNT(pi) AS ok FROM samples WHERE t >= ?').get(now - 3600e3);
  const pct = l.tot ? ((l.tot - l.ok) / l.tot) * 100 : 0;
  return l.tot >= 40 && pct >= 5 ? { level: 'alert', kind: 'packetLoss', pct: r1(pct) } : null;
}

// At comparable load, or we'd measure usage rather than hardware. `floor`: a rise
// doesn't count while the temperature stays normal for the part. The fact comes
// without a diagnosis: a warmer room is enough to explain it.
function thermalChanges(now) {
  const out = [];
  for (const [col, load, part, gap, floor] of [['g', 'gl', 'GPU', 5, 80], ['c', 'cl', 'CPU', 5, 80]]) {
    const recent = sqlMedian(col, now - 7 * DAY_MS, now, `AND ${load} >= 50`);
    const before = sqlMedian(col, now - 28 * DAY_MS, now - 8 * DAY_MS, `AND ${load} >= 50`);
    if (recent.n >= 100 && before.n >= 100 && recent.med - before.med >= gap && recent.med >= floor) {
      out.push({ level: 'info', kind: 'thermal', part, recent: Math.round(recent.med), before: Math.round(before.med) });
    }
  }
  return out;
}

// Yesterday against the median of the 14 days before. Today is a partial total.
function consumptionChange() {
  const j = ctx.db.prepare('SELECT d, kwh FROM daily WHERE kwh IS NOT NULL AND d < ? ORDER BY d DESC LIMIT 15').all(dayKey(new Date()));
  if (j.length < 8) return null;
  const ref = j.slice(1).map((x) => x.kwh).sort((a, b) => a - b);
  const med = ref[Math.floor(ref.length / 2)];
  const y = j[0].kwh;
  return med > 0.2 && y >= med * 1.6 && y - med >= 0.5 ? { level: 'info', kind: 'consumption', yesterday: r1(y), usual: r1(med) } : null;
}

// The last two readings are not always consecutive (PC off): beyond 2 days, no comparison.
function diskDropChange() {
  const d = ctx.db.prepare('SELECT d, free FROM daily WHERE free IS NOT NULL ORDER BY d DESC LIMIT 2').all();
  if (d.length < 2) return null;
  const gapDays = Math.round((new Date(d[0].d + 'T12:00:00') - new Date(d[1].d + 'T12:00:00')) / DAY_MS);
  const lost = d[1].free - d[0].free;
  return gapDays >= 1 && gapDays <= 2 && lost >= 15 ? { level: 'info', kind: 'diskDrop', lost: Math.round(lost), gapDays, free: Math.round(d[0].free) } : null;
}

async function incidentsChange() {
  const { counts } = await crashReport();
  if (counts.d7 < 2) return null;
  const perWeek = ((counts.d30 - counts.d7) / 23) * 7;        // the 23 days before, as a weekly rate
  return counts.d7 > Math.max(1, perWeek * 2) ? { level: 'alert', kind: 'incidents', week: counts.d7, perWeek: r1(perWeek) } : null;
}

let cache = { at: 0, data: [] };
async function changes() {
  if (Date.now() - cache.at < 5 * 60 * 1000) return cache.data;
  const now = Date.now();
  const all = [latencyChange(now), lossChange(now), ...thermalChanges(now), consumptionChange(), diskDropChange(), await incidentsChange()];
  const rank = { alert: 0, info: 1 };
  cache = { at: now, data: all.filter(Boolean).sort((a, b) => rank[a.level] - rank[b.level]).slice(0, 4) };
  return cache.data;
}

/* Chart markers: Windows log incidents and the update dates of the machine sheet,
 * to see what changed before a freeze. */
async function markers() {
  const out = (await crashReport()).history.map((h) => ({ t: h.t, type: 'incident', kind: h.type }));
  const m = await machine();
  const add = (day, kind, label) => {
    if (!day) return;
    const d = new Date(day + 'T12:00:00');       // noon: the log only has the date
    if (!isNaN(d)) out.push({ t: d.getTime(), type: 'update', kind, label });
  };
  if (m) {
    add(m.gpuDriverDate, 'gpuDriver');
    add(m.biosDate, 'bios');
    add(m.hotfixDate, 'windows', m.hotfix || '');
  }
  return out.sort((a, b) => a.t - b.t);
}

module.exports = { changes, markers };
