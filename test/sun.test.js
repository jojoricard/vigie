const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { pathToFileURL } = require('url');

const load = () => import(pathToFileURL(path.join(__dirname, '..', 'public', 'js', 'sun.js')));
const near = (actual, expected, tol, msg) => assert.ok(Math.abs(actual - expected) <= tol, `${msg}: ${actual.toFixed(2)} instead of ~${expected}`);

// Lyon, 45.76 N 4.83 E. Solar noon there is around 11:41 UTC at the solstice.
const LAT = 45.76, LON = 4.83;

test('the noon sun at the June solstice reaches 90 - latitude + 23.44', async () => {
  const { solarElevation } = await load();
  near(solarElevation(Date.UTC(2026, 5, 21, 11, 41), LAT, LON), 90 - LAT + 23.44, 1, 'June noon');
});

test('the noon sun at the December solstice reaches 90 - latitude - 23.44', async () => {
  const { solarElevation } = await load();
  near(solarElevation(Date.UTC(2026, 11, 21, 11, 21), LAT, LON), 90 - LAT - 23.44, 1, 'December noon');
});

test('the sun is below the horizon at midnight and crosses it twice a day', async () => {
  const { solarElevation, sunPath } = await load();
  assert.ok(solarElevation(Date.UTC(2026, 9, 10, 23, 0), LAT, LON) < 0);
  // local midnight in Lyon on 10 October 2026 (UTC+2)
  const pathDay = sunPath(Date.UTC(2026, 9, 9, 22, 0), LAT, LON);
  const crossings = pathDay.slice(1).filter((p, i) => (p.el > 0) !== (pathDay[i].el > 0));
  assert.equal(crossings.length, 2);
  // Open-Meteo gives 07:50 and 19:04 local for that day: the crossings are close
  near(crossings[0].m, 7 * 60 + 50, 15, 'sunrise (minutes)');
  near(crossings[1].m, 19 * 60 + 4, 15, 'sunset (minutes)');
});

test('golden and blue hours frame sunrise and sunset, in the right order', async () => {
  const { lightBands } = await load();
  const bands = lightBands(Date.UTC(2026, 9, 9, 22, 0), LAT, LON);
  assert.deepEqual(bands.map((b) => b.kind), ['blue', 'golden', 'golden', 'blue']);
  const [blueAm, goldAm, goldPm, bluePm] = bands;
  // blue hour hands over to golden hour in the morning, and the other way round at night
  assert.equal(goldAm.from, blueAm.to + 5);
  assert.equal(bluePm.from, goldPm.to + 5);
  // sunrise (07:50) and sunset (19:04) fall inside the golden hours
  assert.ok(goldAm.from < 470 && 470 < goldAm.to, 'sunrise inside the morning golden hour');
  assert.ok(goldPm.from < 1144 && 1144 < goldPm.to, 'sunset inside the evening golden hour');
  // about an hour of golden light, a quarter of an hour of blue, at this latitude in October
  for (const g of [goldAm, goldPm]) assert.ok(g.to - g.from >= 40 && g.to - g.from <= 100, `golden hour of ${g.to - g.from} min`);
  for (const b of [blueAm, bluePm]) assert.ok(b.to - b.from >= 5 && b.to - b.from <= 30, `blue hour of ${b.to - b.from} min`);
});
