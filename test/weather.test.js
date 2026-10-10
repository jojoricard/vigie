const test = require('node:test');
const assert = require('node:assert/strict');
const { parseAlertFeed } = require('../lib/weather');

const feed = (...titles) => titles.map((t) => `<entry><title>${t}</title></entry>`).join('');

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
