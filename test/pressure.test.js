const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { pathToFileURL } = require('url');

const load = () => import(pathToFileURL(path.join(__dirname, '..', 'public', 'js', 'weather.js')));

test('the pressure tendency over 3 hours: steady under 1 hPa, fast from 3.5', async () => {
  const { pressureTrend } = await load();
  assert.deepEqual(pressureTrend(1013.4, 1013.0), { delta: 0.4, kind: 'steady' });
  assert.deepEqual(pressureTrend(1011.0, 1013.0), { delta: -2, kind: 'falling' });
  assert.deepEqual(pressureTrend(1017.5, 1014.0), { delta: 3.5, kind: 'risingFast' });
  assert.deepEqual(pressureTrend(1006.0, 1010.2), { delta: -4.2, kind: 'fallingFast' });
});
