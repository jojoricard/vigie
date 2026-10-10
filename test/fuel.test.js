const test = require('node:test');
const assert = require('node:assert/strict');
const { parseUpdate, cheapest } = require('../lib/fuel');

test('update times are Paris wall-clock times despite their +00:00 label', () => {
  assert.equal(parseUpdate('2026-10-10T19:46:51+00:00'), new Date(2026, 9, 10, 19, 46, 51).getTime());
});

test('only recent prices are kept, three at most, in the order given', () => {
  const now = new Date(2026, 9, 10, 20, 0).getTime();
  const st = (adresse, prix, maj) => ({ adresse, ville: 'Lyon', e10_prix: prix, e10_maj: maj, dist: 1234.5 });
  const rows = [
    st('A', 1.99, '2026-10-10T08:00:00+00:00'),
    st('B', 2.01, '2026-09-20T08:00:00+00:00'),   // three weeks old
    st('C', 2.05, '2026-10-09T08:00:00+00:00'),
    st('D', 2.10, '2026-10-09T08:00:00+00:00'),
    st('E', 2.11, '2026-10-09T08:00:00+00:00'),
  ];
  const r = cheapest(rows, 'e10', now);
  assert.deepEqual(r.map((s) => s.address), ['A', 'C', 'D']);
  assert.equal(r[0].distance, 1235);
});
