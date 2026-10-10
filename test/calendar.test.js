const test = require('node:test');
const assert = require('node:assert/strict');
const { nextPublicHoliday, schoolBreak } = require('../lib/calendar');

const FERIES = { '2026-11-01': 'Toussaint', '2026-11-11': '11 novembre', '2026-12-25': 'Jour de Noël' };

test('a public holiday shows from a week before, mapped to a code', () => {
  assert.deepEqual(nextPublicHoliday(FERIES, '2026-10-25'), { date: '2026-11-01', code: 'allSaints' });
  assert.deepEqual(nextPublicHoliday(FERIES, '2026-11-01'), { date: '2026-11-01', code: 'allSaints' });
  assert.equal(nextPublicHoliday(FERIES, '2026-10-24'), null);
});

const row = (description, start, end) => ({ description, start_date: start + 'T00:00:00+02:00', end_date: end + 'T00:00:00+01:00' });
// the dataset repeats each break once per académie
const ROWS = [
  row('Vacances de la Toussaint', '2026-10-17', '2026-11-02'),
  row('Vacances de la Toussaint', '2026-10-17', '2026-11-02'),
  row('Vacances de Noël', '2026-12-19', '2027-01-04'),
];

test('an upcoming school break shows two weeks ahead, once despite the duplicates', () => {
  assert.deepEqual(schoolBreak(ROWS, '2026-10-10'),
    { code: 'autumn', start: '2026-10-17', lastDay: '2026-11-01', end: '2026-11-02', ongoing: false });
  assert.equal(schoolBreak(ROWS, '2026-10-02'), null);
});

test('a running break ends the evening before classes resume', () => {
  assert.equal(schoolBreak(ROWS, '2026-11-01').ongoing, true);
  // the morning of 2 November, classes are back
  assert.equal(schoolBreak(ROWS, '2026-11-02'), null);
});

test('a row ending the day it starts is one day off', () => {
  const b = schoolBreak([row("Pont de l'Ascension", '2027-05-07', '2027-05-07')], '2027-05-07');
  assert.deepEqual(b, { code: 'ascensionBridge', start: '2027-05-07', lastDay: '2027-05-07', end: '2027-05-08', ongoing: true });
});
