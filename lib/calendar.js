/* French public and school holidays (country "FR"), shown under the date. The sources
 * name them in French: the agent maps the names to codes, the page writes them in its
 * language. Without schoolZone, only public holidays. */
const ctx = require('./context');
const { fetchJson, orNull, logError } = require('./errors');
const { DAY_MS, dayKey } = require('./storage');

// calendrier.api.gouv.fr, metropole
const PUBLIC_CODES = {
  '1er janvier': 'newYear', 'Lundi de Pâques': 'easterMonday', '1er mai': 'labourDay', '8 mai': 'victoryDay',
  'Ascension': 'ascension', 'Lundi de Pentecôte': 'whitMonday', '14 juillet': 'bastilleDay', 'Assomption': 'assumption',
  'Toussaint': 'allSaints', '11 novembre': 'armistice', 'Jour de Noël': 'christmas',
};
// data.education.gouv.fr, fr-en-calendrier-scolaire
const SCHOOL_CODES = {
  'Vacances de la Toussaint': 'autumn', 'Vacances de Noël': 'christmas', "Vacances d'Hiver": 'winter',
  'Vacances de Printemps': 'spring', "Pont de l'Ascension": 'ascensionBridge', "Vacances d'Été": 'summer',
  "Début des Vacances d'Été": 'summer',
};

const addDays = (key, n) => dayKey(new Date(Date.parse(key + 'T12:00:00') + n * DAY_MS));

// First public holiday from today to `days` ahead. `byDate` is { "YYYY-MM-DD": name }.
function nextPublicHoliday(byDate, today, days = 7) {
  const last = addDays(today, days);
  const date = Object.keys(byDate).sort().find((d) => d >= today && d <= last);
  if (!date) return null;
  if (!PUBLIC_CODES[byDate[date]]) logError('Holidays', new Error('unknown public holiday: ' + byDate[date]));
  return { date, code: PUBLIC_CODES[byDate[date]] || 'other' };
}

/* School breaks are a half-open range of Paris dates: start is the first day off, end
 * the morning classes resume. A row whose end equals its start (a bridge, or a summer
 * end not published yet) is one day off. The dataset repeats each break once per
 * académie: rows are deduplicated on their dates. */
function schoolBreak(rows, today, days = 14) {
  const seen = new Set();
  const breaks = [];
  for (const r of rows) {
    const start = r.start_date.slice(0, 10);
    let end = r.end_date.slice(0, 10);
    if (end <= start) end = addDays(start, 1);
    if (seen.has(start + end)) continue;
    seen.add(start + end);
    if (!SCHOOL_CODES[r.description]) logError('Holidays', new Error('unknown school break: ' + r.description));
    breaks.push({ code: SCHOOL_CODES[r.description] || 'other', start, lastDay: addDays(end, -1), end });
  }
  breaks.sort((a, b) => a.start.localeCompare(b.start));
  const current = breaks.find((b) => b.start <= today && today < b.end);
  if (current) return { ...current, ongoing: true };
  const next = breaks.find((b) => b.start > today && b.start <= addDays(today, days));
  return next ? { ...next, ongoing: false } : null;
}

// Both change once a year at most: fetched once a day.
let cache = { day: null, data: null };
async function holidays() {
  if (ctx.cfg.country !== 'FR') return { publicHoliday: null, school: null };
  const today = dayKey(new Date());
  if (cache.day === today) return cache.data;
  const year = today.slice(0, 4);
  // two years, so a holiday early in January shows from late December
  const feries = await Promise.all([year, String(+year + 1)].map((y) =>
    orNull('Holidays', () => fetchJson(`https://calendrier.api.gouv.fr/jours-feries/metropole/${y}.json`))));
  let rows = null;
  if (ctx.cfg.schoolZone) {
    const u = new URL('https://data.education.gouv.fr/api/explore/v2.1/catalog/datasets/fr-en-calendrier-scolaire/records');
    // Paris time zone, or the dates come back the evening before in UTC
    u.search = new URLSearchParams({
      select: 'description,start_date,end_date', order_by: 'start_date', limit: '100', timezone: 'Europe/Paris',
      where: `zones="Zone ${ctx.cfg.schoolZone}" AND population IN ("-", "Élèves") AND end_date > now()`,
    });
    const j = await orNull('Holidays', () => fetchJson(u));
    rows = j && j.results;
  }
  const data = {
    publicHoliday: feries[0] ? nextPublicHoliday(Object.assign({}, ...feries.filter(Boolean)), today) : null,
    school: rows ? schoolBreak(rows, today) : null,
  };
  if (feries[0] && (rows || !ctx.cfg.schoolZone)) cache = { day: today, data };   // a failure is retried next time
  return data;
}

module.exports = { nextPublicHoliday, schoolBreak, holidays };
