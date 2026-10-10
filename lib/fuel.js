/* Fuel prices around the main city (France, government open data, no key).
 * config.json: fuel: { types: ["e10", "sp98"], radiusKm: 5 }. */
const ctx = require('./context');
const { fetchJson, orNull, logError } = require('./errors');

const TYPES = ['gazole', 'sp95', 'e10', 'sp98', 'e85', 'gplc'];
const MAX_AGE_MS = 7 * 24 * 3600 * 1000;   // a station that hasn't updated in a week says nothing about today
const SHOWN = 3;

// The dataset writes Paris wall-clock times labelled "+00:00": reading the 19 first
// characters as local time gives the right instant (the agent runs in France).
const parseUpdate = (s) => new Date(String(s).slice(0, 19)).getTime();

// Cheapest stations with a recent price, nearest first on a tie (rows come sorted).
function cheapest(rows, type, now = Date.now()) {
  return rows
    .map((r) => ({ address: r.adresse, city: r.ville, price: r[type + '_prix'], updated: parseUpdate(r[type + '_maj']), distance: Math.round(r.dist) }))
    .filter((s) => s.price != null && now - s.updated < MAX_AGE_MS)
    .slice(0, SHOWN);
}

let cache = { at: 0, data: null };
async function fuel() {
  const f = ctx.cfg.fuel;
  if (!f || ctx.cfg.country !== 'FR') return null;
  if (cache.data && Date.now() - cache.at < 30 * 60 * 1000) return cache.data;
  const { lat, lon } = ctx.cfg.cities[0];
  const point = `geom'POINT(${lon} ${lat})'`;    // WKT: longitude first
  const types = (f.types || []).filter((t) => {
    if (!TYPES.includes(t)) logError('Fuel', new Error(`unknown type "${t}", expected one of ${TYPES.join(', ')}`));
    return TYPES.includes(t);
  });
  const data = await Promise.all(types.map(async (type) => {
    const u = new URL('https://data.economie.gouv.fr/api/explore/v2.1/catalog/datasets/prix-des-carburants-en-france-flux-instantane-v2/records');
    u.search = new URLSearchParams({
      select: `adresse,ville,${type}_prix,${type}_maj,distance(geom, ${point}) as dist`,
      where: `within_distance(geom, ${point}, ${Number(f.radiusKm) || 5}km) AND ${type}_prix is not null`,
      order_by: `${type}_prix,dist`, limit: '30',
    });
    const j = await orNull('Fuel', () => fetchJson(u));
    return j && { type, stations: cheapest(j.results, type) };
  }));
  if (data.every(Boolean)) cache = { at: Date.now(), data };
  return data.filter(Boolean);
}

module.exports = { parseUpdate, cheapest, fuel };
