const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { pathToFileURL } = require('url');
const { parseAlertFeed, capDescription } = require('../lib/weather');

const page = () => import(pathToFileURL(path.join(__dirname, '..', 'public', 'js', 'weather.js')));

const feed = (...titles) => titles.map((t) => `<entry><title>${t}</title></entry>`).join('');
const entry = (title, expires) => `<entry><cap:expires>${expires}</cap:expires><cap:onset>2026-11-13T23:00:00+00:00</cap:onset><title>${title}</title></entry>`;

test('the end of a warning is read from cap:expires, and left out when the feed has none', () => {
  const out = parseAlertFeed(entry('Yellow Rain-flood Warning issued for France - Rhône', '2026-11-14T05:00:00+00:00')
    + feed('Yellow Wind Warning issued for France - Rhône'), ['Rhône']);
  assert.deepEqual(out, [
    { area: 'Rhône', type: 'rainFlood', severity: 'yellow', expires: Date.UTC(2026, 10, 14, 5) },
    { area: 'Rhône', type: 'wind', severity: 'yellow' },
  ]);
});

test('a warning renewed at the same level ends with the later entry, a higher level keeps its own end', () => {
  const title = (sev) => `${sev} Wind Warning issued for France - Isère`;
  const renewed = parseAlertFeed(entry(title('Yellow'), '2026-11-15T23:00:00+00:00') + entry(title('Yellow'), '2026-11-14T23:00:00+00:00'), ['Isère']);
  assert.equal(renewed[0].expires, Date.UTC(2026, 10, 15, 23));
  const raised = parseAlertFeed(entry(title('Orange'), '2026-11-14T05:00:00+00:00') + entry(title('Yellow'), '2026-11-15T23:00:00+00:00'), ['Isère']);
  assert.deepEqual(raised, [{ area: 'Isère', type: 'wind', severity: 'orange', expires: Date.UTC(2026, 10, 14, 5) }]);
});

test('a warning for a configured area is kept, with its type and severity', () => {
  const out = parseAlertFeed(feed('Orange Thunderstorm Warning issued for France - Rhône'), ['Rhône']);
  assert.deepEqual(out, [{ area: 'Rhône', type: 'thunderstorm', severity: 'orange' }]);
});

test('the area match is exact: "Rhône" does not catch "Bouches-du-Rhône"', () => {
  assert.deepEqual(parseAlertFeed(feed('Yellow Wind Warning issued for France - Bouches-du-Rhône'), ['Rhône']), []);
});

test('an area containing " - " is read whole', () => {
  const out = parseAlertFeed(feed('Yellow Rain Warning issued for Portugal - Açores - Grupo Ocidental'), ['Açores - Grupo Ocidental']);
  assert.equal(out.length, 1);
  assert.equal(out[0].area, 'Açores - Grupo Ocidental');
});

test('the highest severity wins for the same area and type, sorted most severe first', () => {
  const out = parseAlertFeed(feed(
    'Yellow Wind Warning issued for France - Isère',
    'Red Wind Warning issued for France - Isère',
    'Yellow Fog Warning issued for France - Isère',
  ), ['Isère']);
  assert.deepEqual(out.map((a) => `${a.type}:${a.severity}`), ['wind:red', 'fog:yellow']);
});

/* ---------- Text of a warning (CAP document linked from the feed) ---------- */
const CAP = `<alert><info><language>fr-FR</language><headline>Vigilance jaune</headline>
  <description>Des phénomènes habituels
    mais localement dangereux &amp; soudains.</description></info>
  <info><language>en-GB</language><description>Moderate damages may occur.</description></info></alert>`;

test('the description of a warning is the one written in the configured language', () => {
  assert.equal(capDescription(CAP, 'fr'), 'Des phénomènes habituels mais localement dangereux & soudains.');
  assert.equal(capDescription(CAP, 'en'), 'Moderate damages may occur.');
});

test('without that language the first description is used, without any there is none', () => {
  assert.equal(capDescription(CAP, 'de'), 'Des phénomènes habituels mais localement dangereux & soudains.');
  assert.equal(capDescription('<alert><info><language>fr-FR</language></info></alert>', 'fr'), null);
  assert.equal(capDescription('<alert></alert>', 'fr'), null);
});

test('the link to the CAP document is kept with the warning', () => {
  const xml = '<entry><link type="application/cap+xml" href="https://feeds.meteoalarm.org/api/v1/warnings/feeds-france/abc"/><title>Yellow Wind Warning issued for France - Rhône</title></entry>';
  assert.equal(parseAlertFeed(xml, ['Rhône'])[0].cap, 'https://feeds.meteoalarm.org/api/v1/warnings/feeds-france/abc');
});

/* ---------- Air quality: a card or one line ---------- */
test('good or fair air everywhere and no pollen: the card gives way to one line', async () => {
  const { airIsCalm } = await page();
  assert.equal(airIsCalm([23, 22, 24], 0), true);
  assert.equal(airIsCalm([12, 40, 20], 0), true, '40 is still fair');
});

test('one city above fair, or a pollen, brings the card back', async () => {
  const { airIsCalm } = await page();
  assert.equal(airIsCalm([23, 41, 24], 0), false);
  assert.equal(airIsCalm([23, 22, 24], 1), false);
});

test('a city without data is ignored, no data at all keeps the card and its message', async () => {
  const { airIsCalm } = await page();
  assert.equal(airIsCalm([23, null, 24], 0), true);
  assert.equal(airIsCalm([null, null], 0), false);
});

/* ---------- Snow: which spots to show ---------- */
const spot = (name, cm, total) => ({ name, cm, total });

test('without snow anywhere, only the main spot is shown', async () => {
  const { snowRows } = await page();
  const main = spot("L'Alpe d'Huez", 0, 0);
  assert.deepEqual(snowRows([main, spot('Chamrousse', 0, 0), spot('Chamonix', 0, 0)]), { top: main, list: [] });
});

test('with snow, only the spots that have some or expect some, the deepest on top', async () => {
  const { snowRows } = await page();
  const r = snowRows([spot("L'Alpe d'Huez", 0, 0), spot('Les Deux Alpes', 40, 0), spot('Chamrousse', 0, 12), spot('Chamonix', 85, 5)]);
  assert.equal(r.top.name, 'Chamonix');
  assert.deepEqual(r.list.map((s) => s.name), ['Les Deux Alpes', 'Chamrousse']);
});

test('a single spot expecting snow is shown alone', async () => {
  const { snowRows } = await page();
  const r = snowRows([spot("L'Alpe d'Huez", 0, 0), spot('Chamrousse', 0, 8)]);
  assert.equal(r.top.name, 'Chamrousse');
  assert.deepEqual(r.list, []);
});
