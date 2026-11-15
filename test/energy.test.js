const test = require('node:test');
const assert = require('node:assert/strict');
const { integrateKwh } = require('../lib/energy');

const MIN = 60 * 1000;
// One sample every 30 s at the given CPU + GPU watts.
const run = (start, count, pc, pg = 0) => Array.from({ length: count }, (_, i) => ({ t: start + i * 30000, pc, pg }));

test('one hour at 100 W is 0.1 kWh', () => {
  const r = integrateKwh(run(0, 121, 60, 40));
  assert.ok(Math.abs(r.kwh - 0.1) < 1e-9);
  assert.ok(Math.abs(r.hours - 1) < 1e-9);
});

test('a gap longer than 5 minutes counts neither time nor energy', () => {
  const rows = [...run(0, 61, 100), ...run(30 * MIN + 10 * MIN, 61, 100)];
  const r = integrateKwh(rows);
  assert.ok(Math.abs(r.hours - 1) < 1e-9);
  assert.ok(Math.abs(r.kwh - 0.1) < 1e-9);
});

test('samples without watts count as time on but not as kWh', () => {
  const rows = [...run(0, 61, 100), ...run(30 * MIN + 30000, 60, 0)];
  const r = integrateKwh(rows);
  assert.ok(Math.abs(r.hours - 1) < 1e-9);
  assert.ok(Math.abs(r.measured - 0.5) < 0.01);
});

test('base watts are added to CPU + GPU', () => {
  const r = integrateKwh(run(0, 121, 50), 50);
  assert.ok(Math.abs(r.kwh - 0.1) < 1e-9);
});

test('the carbon curve: hourly averages of the last 24 hours, nothing under two points', () => {
  const { carbonHours } = require('../lib/energy');
  const rows = [];
  for (let q = 0; q < 30 * 4; q++) rows.push({ date_heure: new Date(Date.UTC(2026, 10, 14, 0, q * 15)).toISOString(), taux_co2: 20 + (q % 4) * 4 });
  rows.push({ date_heure: 'nope', taux_co2: 5 }, { date_heure: rows[rows.length - 1].date_heure, taux_co2: null });
  const out = carbonHours(rows);
  assert.equal(out.length, 24, 'thirty hours of quarters, the last twenty-four kept');
  assert.equal(out[0].at, Date.UTC(2026, 10, 14, 6));
  assert.ok(out.every((h) => h.gco2 === 26), 'four quarters of 20, 24, 28, 32 average to 26');
  assert.equal(carbonHours(rows.slice(0, 4)), null, 'one hour is not a curve');
  assert.equal(carbonHours([]), null);
});
