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
