/* Weather warnings (MeteoAlarm), seasonal normals (Open-Meteo archive) and the
 * French name day (Nominis). */
const ctx = require('./context');
const { fetchText, fetchJson, orNull } = require('./errors');
const { DAY_MS, dayKey } = require('./storage');

/* ---------- Weather warnings (MeteoAlarm) ---------- */
// ISO country code -> feed name. North Macedonia has no legacy feed (404).
const ALERT_FEEDS = {
  AT: 'austria', BA: 'bosnia-herzegovina', BE: 'belgium', BG: 'bulgaria', CH: 'switzerland', CY: 'cyprus',
  CZ: 'czechia', DE: 'germany', DK: 'denmark', EE: 'estonia', ES: 'spain', FI: 'finland', FR: 'france',
  GB: 'united-kingdom', GR: 'greece', HR: 'croatia', HU: 'hungary', IE: 'ireland', IL: 'israel', IS: 'iceland',
  IT: 'italy', LT: 'lithuania', LU: 'luxembourg', LV: 'latvia', MD: 'moldova', ME: 'montenegro', MT: 'malta',
  NL: 'netherlands', NO: 'norway', PL: 'poland', PT: 'portugal', RO: 'romania', RS: 'serbia', SE: 'sweden',
  SI: 'slovenia', SK: 'slovakia', UA: 'ukraine',
};
const ALERT_TYPES = [
  [/thunder/i, 'thunderstorm'],
  [/high[- ]?temperature|heat/i, 'heat'],
  [/low[- ]?temperature|cold/i, 'cold'],
  [/rain[- ]?flood/i, 'rainFlood'],
  [/rain/i, 'rain'],
  [/flood/i, 'flood'],
  [/wind/i, 'wind'],
  [/snow|ice/i, 'snowIce'],
  [/fog/i, 'fog'],
  [/avalanche/i, 'avalanche'],
  [/forest[- ]?fire|wildfire/i, 'forestFire'],
  [/coastal/i, 'coastal'],
];
const SEV_RANK = { yellow: 1, orange: 2, red: 3 };

/* "Yellow Rain Warning issued for Portugal - Açores - Grupo Ocidental": the area is
 * everything after the country, which may itself contain " - ". The match on the
 * configured areas is exact, so "Rhône" doesn't catch "Bouches-du-Rhône". */
function parseAlertFeed(xml, areas) {
  const wanted = new Map(areas.map((a) => [a.toLowerCase(), a]));
  const best = {};
  for (const entry of xml.split(/<entry[\s>]/).slice(1)) {
    const title = ((entry.match(/<title[^>]*>([\s\S]*?)<\/title>/) || [])[1] || '').replace(/<[^>]+>/g, '').trim();
    const m = title.match(/^(\w+) .* issued for .+? - (.+)$/);
    if (!m) continue;
    const area = wanted.get(m[2].trim().toLowerCase());
    const severity = m[1].toLowerCase();
    if (!area || !SEV_RANK[severity]) continue;
    const match = ALERT_TYPES.find(([re]) => re.test(title));
    const type = match ? match[1] : 'warning';
    const key = area + '|' + type;
    if (!best[key] || SEV_RANK[severity] > SEV_RANK[best[key].severity]) {
      best[key] = { area, type, severity };
    }
  }
  return Object.values(best).sort((a, b) => SEV_RANK[b.severity] - SEV_RANK[a.severity]);
}

let alertCache = { at: 0, data: [] };
async function alerts() {
  const feed = ALERT_FEEDS[ctx.cfg.country];
  if (!feed || !(ctx.cfg.alertAreas || []).length) return [];
  if (Date.now() - alertCache.at < 15 * 60 * 1000) return alertCache.data;
  const xml = await orNull('MeteoAlarm', () => fetchText(`https://feeds.meteoalarm.org/feeds/meteoalarm-legacy-atom-${feed}`, { timeout: 15000 }));
  // A failed fetch keeps the last known warnings rather than claiming there are none.
  alertCache = { at: Date.now(), data: xml == null ? alertCache.data : parseAlertFeed(xml, ctx.cfg.alertAreas) };
  return alertCache.data;
}

/* ---------- Seasonal normal: mean of the last 10 years at this date ----------
 * Open-Meteo archive (no key), ±3 day window to smooth, computed once a day. */
let normCache = { day: null, data: null };

async function cityNormal(c, today) {
  const y = today.getFullYear();
  const u = new URL('https://archive-api.open-meteo.com/v1/archive');
  u.search = new URLSearchParams({
    latitude: c.lat, longitude: c.lon, timezone: 'auto',
    start_date: `${y - 10}-01-01`, end_date: `${y - 1}-12-31`, daily: 'temperature_2m_max',
  });
  const j = await orNull('Open-Meteo archive', () => fetchJson(u, { timeout: 20000 }));
  if (!j || !j.daily) return null;
  const times = j.daily.time, vals = j.daily.temperature_2m_max;
  // Circular distance between days of the year, or January 1st would be far from December 31st.
  const doy = (d) => Math.round((d - new Date(d.getFullYear(), 0, 0)) / DAY_MS);
  const target = doy(today);
  const close = [];
  for (let i = 0; i < times.length; i++) {
    if (vals[i] == null) continue;
    let diff = Math.abs(doy(new Date(times[i] + 'T12:00:00')) - target);
    if (diff > 182) diff = 365 - diff;
    if (diff <= 3) close.push(vals[i]);
  }
  if (close.length < 20) return null;               // not enough history to be credible
  const avg = close.reduce((a, b) => a + b, 0) / close.length;
  return { maxNormal: Math.round(avg * 10) / 10, days: close.length };
}

// One normal per city, in the order of config.cities.
async function seasonalNormals() {
  const today = new Date();
  const key = dayKey(today);
  if (normCache.day === key) return normCache.data;
  const data = await Promise.all(ctx.cfg.cities.map((c) => cityNormal(c, today)));
  // Don't cache a day where every city failed: retry at the next call.
  if (data.some(Boolean)) normCache = { day: key, data };
  return data;
}

/* ---------- Name day (Nominis, France) ---------- */
let nameDayCache = { date: null, text: null };
async function nameDay() {
  if (ctx.cfg.country !== 'FR') return { text: null };
  const today = dayKey(new Date());
  if (nameDayCache.date === today) return { text: nameDayCache.text };
  const j = await orNull('Nominis', () => fetchJson('https://nominis.cef.fr/json/nominis.php'));
  if (!j) return { text: null };
  const p = j.response && j.response.prenoms;
  const main = p && (p.majeurs || p);
  const names = typeof main === 'string' ? [main] : Array.isArray(main) ? main : main ? Object.keys(main) : [];
  nameDayCache = { date: today, text: names.length ? names.slice(0, 2).join(', ') : null };
  return { text: nameDayCache.text };
}

module.exports = { parseAlertFeed, alerts, seasonalNormals, nameDay };
