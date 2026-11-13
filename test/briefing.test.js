const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { pathToFileURL } = require('url');
const { plain, prompt, rejection, slotOf, events, isFresh, mayCall } = require('../lib/briefing');

const page = (file) => import(pathToFileURL(path.join(__dirname, '..', 'public', 'js', file)));

test('the em dashes and semicolons the model slips in are rewritten', () => {
  assert.equal(plain('Redoux mercredi — aérez ce soir ; vérifiez vos branchements.'),
    'Redoux mercredi, aérez ce soir. Vérifiez vos branchements.');
  assert.equal(plain('A warm spell – then rain.'), 'A warm spell, then rain.');
});

test('a range written with an en dash is left alone', () => {
  assert.equal(plain('Entre 12–18° demain.'), 'Entre 12–18° demain.');
});

/* ---------- Time slot ---------- */
const SLOTS = { morning: 5, midday: 12, evening: 17 };
const at = (h, m = 0) => new Date(2026, 10, 13, h, m);

test('the slot follows the hour: morning, midday from 12, evening from 17', () => {
  assert.deepEqual(slotOf(at(5), SLOTS), { day: '2026-11-13', slot: 'morning' });
  assert.deepEqual(slotOf(at(11, 59), SLOTS), { day: '2026-11-13', slot: 'morning' });
  assert.deepEqual(slotOf(at(12), SLOTS), { day: '2026-11-13', slot: 'midday' });
  assert.deepEqual(slotOf(at(16, 59), SLOTS), { day: '2026-11-13', slot: 'midday' });
  assert.deepEqual(slotOf(at(17), SLOTS), { day: '2026-11-13', slot: 'evening' });
  assert.deepEqual(slotOf(at(23, 59), SLOTS), { day: '2026-11-13', slot: 'evening' });
});

test('before the morning hour, the night still belongs to the evening before', () => {
  assert.deepEqual(slotOf(at(0, 10), SLOTS), { day: '2026-11-12', slot: 'evening' });
  assert.deepEqual(slotOf(at(4, 59), SLOTS), { day: '2026-11-12', slot: 'evening' });
});

test('the slot hours come from the settings', () => {
  assert.equal(slotOf(at(13), { morning: 6, midday: 14, evening: 19 }).slot, 'morning');
  assert.equal(slotOf(at(18), { morning: 6, midday: 14, evening: 19 }).slot, 'midday');
});

/* ---------- Fingerprint and cache ---------- */
const context = (toAnalyze = {}, warnings = []) => ({ alreadyShown: { warnings }, toAnalyze });

test('the fingerprint lists the incident, the rain to come, the warnings and the services down', () => {
  const ev = events(context({
    recentIncident: { type: 'Blue screen', when: 'today at 15:02', at: 1794578520000 },
    next12h: { rainSoon: { from: '16:00' }, rainTotalMm: 3 },
    servicesDown: [{ name: 'NAS', state: 'down', since: '14:02' }],
  }, ['Rain (Rhône)']));
  assert.deepEqual(ev, ['incident:1794578520000', 'rain', 'service:NAS', 'warning:Rain (Rhône)']);
});

test('a context without any event, or without its two parts, has an empty fingerprint', () => {
  assert.deepEqual(events(context({ next12h: { rainTotalMm: 0 }, machine: { daysWithoutIncident: 12 } })), []);
  assert.deepEqual(events({}), []);
});

const SLOT = { day: '2026-11-13', slot: 'midday' };
const cached = { day: '2026-11-13', slot: 'midday', lang: 'fr', events: ['rain', 'service:NAS'], text: 'Pluie à 17 h.' };

test('the cached text holds for its slot, its language and the events it knew', () => {
  assert.equal(isFresh(cached, SLOT, 'fr', ['rain', 'service:NAS']), true);
  assert.equal(isFresh(cached, SLOT, 'fr', ['rain']), true, 'an event that ended is not a reason to rewrite');
  assert.equal(isFresh(cached, SLOT, 'fr', []), true);
});

test('a new slot, a new day, another language or a new event invalidate it', () => {
  assert.equal(isFresh(cached, { day: '2026-11-13', slot: 'evening' }, 'fr', ['rain']), false);
  assert.equal(isFresh(cached, { day: '2026-11-14', slot: 'midday' }, 'fr', ['rain']), false);
  assert.equal(isFresh(cached, SLOT, 'en', ['rain']), false);
  assert.equal(isFresh(cached, SLOT, 'fr', ['rain', 'incident:1794578520000']), false);
  assert.equal(isFresh(cached, SLOT, 'fr', ['warning:Rain (Rhône)']), false);
});

test('an empty cache, or one written by the daily version, is never fresh', () => {
  assert.equal(isFresh({}, SLOT, 'fr', []), false);
  assert.equal(isFresh({ date: '2026-11-13', lang: 'fr', text: 'Ancien format.' }, SLOT, 'fr', []), false);
});

/* ---------- Rate guard ---------- */
const GUARD = { minIntervalMin: 30, maxPerDay: 8 };
const ms = (h, m = 0) => at(h, m).getTime();

test('no call within 30 minutes of the previous one', () => {
  assert.equal(mayCall([], ms(9), GUARD), true);
  assert.equal(mayCall([ms(9)], ms(9, 29), GUARD), false);
  assert.equal(mayCall([ms(9)], ms(9, 30), GUARD), true);
  assert.equal(mayCall([ms(8), ms(9)], ms(9, 10), GUARD), false);
});

test('no more than 8 calls a day, and the count starts again the next day', () => {
  const eight = [6, 7, 8, 9, 10, 11, 12, 13].map((h) => ms(h));
  assert.equal(mayCall(eight.slice(0, 7), ms(15), GUARD), true);
  assert.equal(mayCall(eight, ms(15), GUARD), false);
  assert.equal(mayCall(eight, new Date(2026, 10, 14, 6).getTime(), GUARD), true);
});

test('the interval still holds across midnight', () => {
  assert.equal(mayCall([ms(23, 50)], new Date(2026, 10, 14, 0, 5).getTime(), GUARD), false);
});

/* ---------- Context built by the page ---------- */
const CFG = { rainSoonPct: 60, rainHourPct: 50, gustKmh: 50, fuelDeltaEur: 0.05, acHeatAboveC: 18, acCoolBelowC: 15, electricityGapPct: 20 };

// 24 hours from 08:00, everything calm unless overridden by hour
function hourly(over = {}) {
  const h = { time: [], temperature_2m: [], precipitation: [], precipitation_probability: [], wind_gusts_10m: [], weather_code: [] };
  for (let i = 0; i < 24; i++) {
    const hour = (8 + i) % 24, o = over[hour] || {};
    h.time.push(`2026-11-${hour >= 8 ? 13 : 14}T${String(hour).padStart(2, '0')}:00`);
    h.temperature_2m.push(o.temp ?? 10);
    h.precipitation.push(o.mm ?? 0);
    h.precipitation_probability.push(o.chance ?? 0);
    h.wind_gusts_10m.push(o.gust ?? 20);
    h.weather_code.push(o.code ?? 3);
  }
  return h;
}

test('the hourly summary covers the 12 hours after the current one', async () => {
  const { hourlySummary } = await page('briefing.js');
  // current hour 15:00 (index 7)
  const s = hourlySummary(hourly({ 16: { temp: 14.4 }, 3: { temp: 5.6 }, 4: { temp: 1 } }), 7, CFG);
  assert.equal(s.temperatures.length, 12);
  assert.deepEqual(s.temperatures[0], { at: '16:00', temp: 14 });
  assert.deepEqual(s.temperatures[11], { at: '03:00', temp: 6 });
});

test('rain above 50 % comes as spells with their hours, their mm and their sky, never a probability', async () => {
  const { hourlySummary } = await page('briefing.js');
  const s = hourlySummary(hourly({
    18: { chance: 50, mm: 0.2 },                // not above the threshold, still counted in the total
    19: { chance: 80, mm: 1.5, code: 63 },
    20: { chance: 55, mm: 6.4, code: 96 },
    21: { chance: 90, mm: 3, code: 65 },
    23: { chance: 70, mm: 0.3, code: 61 },      // a dry hour in between: another spell
    5: { chance: 90, mm: 4 },                   // beyond the 12 hours
  }), 7, CFG);
  assert.deepEqual(s.rain, [
    { from: '18:00', to: '21:00', mm: 10.9, peakMmPerHour: 6.4, sky: 'Thunderstorm with hail' },
    { from: '22:00', to: '23:00', mm: 0.3, peakMmPerHour: 0.3, sky: 'Light rain' },
  ]);
  assert.equal(s.rainTotalMm, 11.4);
  assert.equal('rainSoon' in s, false, 'rain at 18:00 is not within 3 hours of 15:00');
  assert.doesNotMatch(JSON.stringify(s), /chance|probab/i);
});

test('gusts above 50 km/h are listed with the hour they start at', async () => {
  const { hourlySummary } = await page('briefing.js');
  const s = hourlySummary(hourly({ 20: { gust: 62.4 }, 21: { gust: 50 } }), 7, CFG);
  assert.deepEqual(s.gusts, [{ from: '19:00', kmh: 62 }]);
});

test('rain at 60 % or more within 3 hours is flagged, a dry forecast sends no rain field at all', async () => {
  const { hourlySummary } = await page('briefing.js');
  const wet = hourlySummary(hourly({ 17: { chance: 59 }, 18: { chance: 60, mm: 0.8 } }), 7, CFG);
  assert.deepEqual(wet.rainSoon, { from: '17:00' });
  // drizzle under the threshold: no spell, so no total either
  const dry = hourlySummary(hourly({ 18: { chance: 40, mm: 0.3 } }), 7, CFG);
  assert.deepEqual(Object.keys(dry), ['temperatures']);
});

test('at the end of the series the summary shortens, then disappears', async () => {
  const { hourlySummary } = await page('briefing.js');
  assert.equal(hourlySummary(hourly(), 20, CFG).temperatures.length, 3);
  assert.equal(hourlySummary(hourly(), 23, CFG), null);
});

// What the page always has once the weather is loaded, and nothing else.
async function bareState() {
  const { state } = await page('core.js');
  const days = [13, 14, 15, 16, 17, 18, 19].map((d) => `2026-11-${d}`);
  Object.assign(state, {
    cfg: { briefing: CFG }, cities: [{ short: 'Lyon' }],
    weather: [{
      current: { temperature_2m: 14.2, weather_code: 3 },
      daily: { time: days, temperature_2m_max: days.map(() => 15), temperature_2m_min: days.map(() => 6), precipitation_probability_max: days.map(() => 10), weather_code: days.map(() => 3) },
    }],
    alerts: [], pollenSummary: [], aqiSummary: null, nameDay: '', changes: [], crashCounts: null, lastCrash: null,
    energy: null, holidays: null, services: null, network: null, house: null, fuel: null,
  });
  return state;
}

test('without weather there is no context', async () => {
  const { buildContext } = await page('briefing.js');
  const state = await bareState();
  state.weather = [];
  assert.equal(buildContext(), null);
});

test('a source without data leaves no field behind, not even an empty one', async () => {
  const { buildContext } = await page('briefing.js');
  await bareState();
  const c = buildContext();
  assert.deepEqual(Object.keys(c.alreadyShown), ['note', 'currentTemp', 'maxToday', 'sky', 'rainChanceToday']);
  assert.deepEqual(Object.keys(c.toAnalyze), ['nextDays']);
  assert.equal(c.toAnalyze.nextDays.length, 5);
});

test('sources that answer with nothing to say are left out too', async () => {
  const { buildContext } = await page('briefing.js');
  const state = await bareState();
  Object.assign(state, {
    // Tempo blue tomorrow and a projection 10 % above last month: nothing to do about either
    energy: { tempo: { code: 3 }, tempoTomorrow: { code: 1 }, consumption: { monthly: { projection: 55, previous: { month: '2026-10', kwh: 50 } } } },
    holidays: { publicHoliday: null, school: null },
    services: [{ name: 'Router', state: 'up' }, { name: 'NAS', state: null }],
    network: { samples: 2880, loss: 0.4, failingNow: false },
    // 14° outside: heating is expected, an idle unit or a fan says nothing
    house: { rooms: [{ id: 'salon', name: 'Salon', devices: [{ id: 'salon-ac', type: 'climate', state: { reachable: false } }] }, { id: 'bureau', name: 'Bureau', devices: [{ id: 'bureau-ac', type: 'climate', state: { reachable: true, on: true, mode: 'heat', setpoint: 20, probeTemp: 23 } }] }, { id: 'chambre', name: 'Chambre', devices: [{ id: 'chambre-ac', type: 'climate', state: { reachable: true, on: false, mode: 'cool' } }] }, { id: 'cuisine', name: 'Cuisine', devices: [{ id: 'cuisine-ac', type: 'climate', state: { reachable: true, on: true, mode: 'fan' } }] }, { id: 'hall', name: 'Hall', devices: [{ id: 'hall-lamp', type: 'light', state: { reachable: true, on: true } }] }] },
    fuel: [
      { type: 'e10', stations: [{ price: 1.72 }], previous: { date: '2026-11-07', price: 1.69 } },   // 3 cents: not notable
      { type: 'gazole', stations: [{ price: 1.6 }], previous: null },                                // no history yet
      { type: 'sp98', stations: [], previous: { date: '2026-11-07', price: 1.9 } },                  // no recent price
    ],
    crashCounts: { last: Date.now() - 11 * 24 * 3600 * 1000, d7: 0, d30: 2, natures: { freeze: 2, cut: 0 } },   // quiet for a week
    lastCrash: { at: Date.now() - 3 * 24 * 3600 * 1000, type: 'bsod' },                             // older than a day
  });
  assert.deepEqual(Object.keys(buildContext().toAnalyze), ['nextDays']);
});

test('each source that has something to say gets its field', async () => {
  const { buildContext } = await page('briefing.js');
  const state = await bareState();
  const crashAt = Date.now() - 3600 * 1000;
  Object.assign(state, {
    alerts: [{ type: 'rain', severity: 'yellow', area: 'Rhône' }],
    energy: { tempo: { code: 1 }, tempoTomorrow: { code: 3 }, consumption: { monthly: { projection: 65, previous: { month: '2026-10', kwh: 50 } } } },
    holidays: { publicHoliday: { date: '2026-11-11', code: 'armistice' }, school: null },
    services: [{ name: 'Router', state: 'up' }, { name: 'NAS', state: 'down', since: Date.now() }],
    network: { samples: 2880, loss: 3.2, failingNow: false },
    house: { rooms: [{ id: 'bureau', name: 'Bureau', devices: [{ id: 'bureau-ac', type: 'climate', state: { reachable: true, on: true, mode: 'cool', setpoint: 19, probeTemp: 25 } }] }, { id: 'salon', name: 'Salon', devices: [{ id: 'salon-ac', type: 'climate', state: { reachable: true, on: true, mode: 'heat', setpoint: 21, probeTemp: 24 } }] }, { id: 'chambre', name: 'Chambre', devices: [{ id: 'chambre-ac', type: 'climate', state: { reachable: false } }] }] },
    fuel: [{ type: 'e10', stations: [{ price: 1.759 }], previous: { date: '2026-11-07', price: 1.699 } }],
    lastCrash: { at: crashAt, type: 'bsod' },
  });
  const c = buildContext();
  const a = c.toAnalyze;
  assert.deepEqual(c.alreadyShown.warnings, ['Rain (Rhône)'], 'the level stays on the pill');
  assert.deepEqual(a.tempo, { today: 'Blue', tomorrow: 'Red' });
  assert.equal(a.holidays.publicHoliday.name, 'Armistice Day');
  assert.equal('schoolBreak' in a.holidays, false);
  assert.deepEqual(a.servicesDown.map((s) => [s.name, s.state]), [['NAS', 'down']]);
  assert.deepEqual(a.network, { lossPct24h: 3.2, failingNow: false });
  // cooling at 14° outside is flagged, heating is not, and no probe reading leaves the page
  assert.deepEqual(a.house, { outdoorTemp: 14, airConditioners: [{ room: 'Bureau', mode: 'Cool', running: true }] });
  assert.deepEqual(a.electricity, { endOfMonthProjectionKwh: 65, previousMonthKwh: 50, previousMonth: 'October', gapPct: 30 });
  assert.equal(a.fuel.length, 1);
  assert.equal(a.fuel[0].change, 0.06);
  assert.equal(a.recentIncident.at, crashAt);
  // the agent reads its events from this very context
  assert.deepEqual(events(c), [`incident:${crashAt}`, 'service:NAS', 'warning:Rain (Rhône)']);
});

test('a heating left on is flagged above 18° outside, a white Tempo day is announced', async () => {
  const { buildContext } = await page('briefing.js');
  const state = await bareState();
  state.house = { rooms: [{ id: 'salon', name: 'Salon', devices: [{ id: 'salon-ac', type: 'climate', state: { reachable: true, on: true, mode: 'heat' } }] }] };
  state.energy = { tempo: { code: 1 }, tempoTomorrow: { code: 2 }, consumption: { monthly: { projection: null } } };
  state.weather[0].current.temperature_2m = 18;
  assert.equal('house' in buildContext().toAnalyze, false, '18° is not above 18°');
  state.weather[0].current.temperature_2m = 18.6;
  const a = buildContext().toAnalyze;
  assert.deepEqual(a.house, { outdoorTemp: 19, airConditioners: [{ room: 'Salon', mode: 'Heat', running: true }] });
  assert.deepEqual(a.tempo, { today: 'Blue', tomorrow: 'White' });
});

test('the machine is only described after an incident this week or a detected break', async () => {
  const { buildContext } = await page('briefing.js');
  const state = await bareState();
  const counts = { last: Date.now() - 2 * 24 * 3600 * 1000, d7: 1, d30: 3, natures: { freeze: 3, cut: 0 } };
  state.crashCounts = counts;
  assert.deepEqual(buildContext().toAnalyze.machine, { daysWithoutIncident: 2, incidentsThisWeek: 1, splitOver30Days: { freeze: 3, cut: 0 } });
  state.crashCounts = { ...counts, last: Date.now() - 11 * 24 * 3600 * 1000, d7: 0 };
  assert.equal('machine' in buildContext().toAnalyze, false);
  state.changes = [{ kind: 'latency', level: 'warn', recent: 42, usual: 15 }];
  assert.deepEqual(buildContext().toAnalyze.machine.detectedBreaks, ['Latency degraded: 42 ms over the last hour, against 15 ms usually']);
});

/* ---------- Prompt ---------- */
test('the prompt carries the context, the language and the three rules learnt from real briefings', () => {
  const ctx = require('../lib/context');
  ctx.lang = 'fr';
  const p = prompt({ now: '15:33', slot: 'midday', toAnalyze: {} });
  assert.match(p, /Write in French/);
  assert.ok(p.endsWith('JSON context: {"now":"15:33","slot":"midday","toAnalyze":{}}'));
  assert.match(p, /never write that it runs fine or has had no incident/);
  assert.match(p, /sans incident depuis 11 jours/);
  assert.match(p, /never with a probability/);
  assert.match(p, /only for hail or a flood warning/);
  assert.match(p, /Without that field, not a word about the house/);
  assert.match(p, /3 sentences is a ceiling, not a target/);
  assert.match(p, /Rien de particulier aujourd'hui\./);
  assert.match(p, /Tempo bleu demain, pas de contrainte/);
  assert.match(p, /Pluie-inondation jaune dans le Rhône, mais rien de prévu/);
  assert.doesNotMatch(p, /—/);
  assert.match(p, /Write only the final text meant for the screen: no reasoning, no correcting yourself, no field name/);
  ctx.lang = 'en';
});

/* ---------- Validation of the answer ---------- */
const SENT = {
  now: '15:33', slot: 'midday', date: '2026-11-13',
  alreadyShown: { currentTemp: 14, rainChanceToday: 80 },
  toAnalyze: { next12h: { temperatures: [{ at: '16:00', temp: 14 }] }, nextDays: [{ day: 'samedi', rainChance: 20 }], machine: { incidentsThisWeek: 1 }, tempo: { tomorrow: 'Rouge' } },
};

test('a text that fits the screen is accepted', () => {
  assert.equal(rejection("Pluie forte jusqu'à 21 h, environ 15 mm : prends un parapluie si tu sors.", 'fr', SENT), null);
  assert.equal(rejection('Tempo rouge demain, lance le lave-linge ce soir. La machine a gelé hier à 15:02 ! Mets à jour le pilote graphique.', 'fr', SENT), null);
  assert.equal(rejection("Rien de particulier aujourd'hui.", 'fr', SENT), null);
});

test('the answer where the model reasoned aloud and corrected itself is rejected', () => {
  const real = 'Pluie forte attendue à partir de 17 h. Ah wait, I need to correct that: the next12h data shows no rain spell...';
  assert.equal(rejection(real, 'fr', SENT), 'reasoning in English ("wait")');
});

test('more than 3 sentences or more than 400 characters are rejected', () => {
  assert.equal(rejection('Un. Deux ! Trois ? Quatre.', 'fr', SENT), '4 sentences');
  assert.equal(rejection('Une seule phrase, 14.5 mm à 15:02, sans point final', 'fr', SENT), null);
  assert.equal(rejection('a'.repeat(400) + '.', 'fr', SENT), '401 characters');
});

test('English reasoning words are rejected in a French text only', () => {
  for (const w of ['Wait', 'actually', 'I need', 'Let me', 'the data', 'correct that']) {
    assert.match(rejection(`Pluie à 17 h. ${w} vérifier.`, 'fr', SENT), /^reasoning in English/, w);
  }
  assert.equal(rejection('Rain from 17:00. Actually bring a coat.', 'en', SENT), null);
  assert.equal(rejection('Attends la fin de la pluie avant de sortir.', 'fr', SENT), null);
});

test('a field name of the context is rejected, in any language', () => {
  assert.equal(rejection("D'après next12h, pas de pluie.", 'fr', SENT), 'field name "next12h"');
  assert.equal(rejection('Le champ toAnalyze est vide.', 'fr', SENT), 'field name "toAnalyze"');
  assert.equal(rejection('Samedi, rainChance à 20.', 'fr', SENT), 'field name "rainChance"');
  assert.equal(rejection('Nothing in alreadyShown.', 'en', SENT), 'field name "alreadyShown"');
});

/* ---------- Display ---------- */
test('figures with their unit and day names are set in medium weight', async () => {
  const { emphasize } = await page('briefing.js');
  assert.equal(emphasize('Saturday down to 0 °C, 15 mm by 21 h and gusts at 62 km/h, 80 % sure.'),
    '<b>Saturday</b> down to <b>0 °C</b>, <b>15 mm</b> by <b>21 h</b> and gusts at <b>62 km/h</b>, <b>80 %</b> sure.');
  assert.equal(emphasize('Rain at 6 h 30, 1,5 mm then 12°.'), 'Rain at <b>6 h 30</b>, <b>1,5 mm</b> then <b>12°</b>.');
});

test('a bare number, a time, a word starting like a unit or a day inside a word are left alone', async () => {
  const { emphasize } = await page('briefing.js');
  for (const s of ['Frozen at 15:02, 3 incidents.', 'Back in 2 hours.', '11 days of Mondayitis.']) assert.equal(emphasize(s), s);
});

test('the text is escaped before any markup is added', async () => {
  const { emphasize } = await page('briefing.js');
  assert.equal(emphasize(`<img src=x onerror=1> l'eau & 5 mm`), '&lt;img src=x onerror=1&gt; l&#39;eau &amp; <b>5 mm</b>');
  assert.equal(emphasize("l'h et d'hier"), 'l&#39;h et d&#39;hier', 'the digits of an entity are not a figure');
});

test('the end of a warning reads as a day and an hour, without the day when it ends today', async () => {
  const { alertUntil } = await page('weather.js');
  const today = new Date(); today.setHours(18, 0, 0, 0);
  assert.equal(alertUntil(today.getTime()), 'until 18:00');
  const later = new Date(Date.now() + 3 * 24 * 3600 * 1000); later.setHours(6, 30, 0, 0);
  assert.equal(alertUntil(later.getTime()), `until ${later.toLocaleDateString('en-GB', { weekday: 'short' })} 06:30`);
});

test('the French hour is written "6 h", with its minutes only when there are some', async () => {
  const { I18N } = await page('i18n.js');
  assert.equal(I18N.fr['alert.until'](`sam. ${I18N.fr.hourShort(6, '00')}`), "jusqu'à sam. 6 h");
  assert.equal(I18N.fr.hourShort(6, '30'), '6 h 30');
  assert.equal(I18N.fr.hourShort(0, '30'), '0 h 30');
});

test('a warning ending at 00:00 runs until midnight, in both languages', async () => {
  const { I18N } = await page('i18n.js');
  const { alertUntil } = await page('weather.js');
  assert.equal(I18N.fr['alert.until'](I18N.fr.hourShort(0, '00')), "jusqu'à minuit");
  assert.equal(I18N.fr['alert.until'](`sam. ${I18N.fr.hourShort(0, '00')}`), "jusqu'à sam. minuit");
  assert.equal(I18N.en.hourShort(0, '00'), 'midnight');
  assert.equal(I18N.en.hourShort(0, '30'), '00:30');
  const later = new Date(Date.now() + 3 * 24 * 3600 * 1000); later.setHours(0, 0, 0, 0);
  assert.equal(alertUntil(later.getTime()), `until ${later.toLocaleDateString('en-GB', { weekday: 'short' })} midnight`);
  assert.equal(I18N.fr['brief.head']('16:02'), 'Brief · mis à jour 16:02');
  assert.equal(I18N.fr['brief.head'](''), 'Brief');
});
