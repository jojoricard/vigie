const test = require('node:test');
const assert = require('node:assert/strict');
const { natureFromSilence, incidentType } = require('../lib/crash');

test('samples up to the shutdown mean a hard power cut', () => {
  assert.equal(natureFromSilence(0), 'cut');
  assert.equal(natureFromSilence(75), 'cut');
});

test('samples stopping two minutes or more before mean a freeze', () => {
  assert.equal(natureFromSilence(120), 'freeze');
  assert.equal(natureFromSilence(900), 'freeze');
});

test('between the two thresholds nothing is concluded', () => {
  assert.equal(natureFromSilence(76), 'undetermined');
  assert.equal(natureFromSilence(119), 'undetermined');
});

test('no sample at all means unknown, not a freeze', () => {
  assert.equal(natureFromSilence(null), 'unknown');
});

test('event ids map to incident types', () => {
  assert.equal(incidentType({ id: 1001 }), 'bsod');
  assert.equal(incidentType({ id: 6008 }), 'unexpected');
  assert.equal(incidentType({ id: 41 }), 'powerLoss');
  assert.equal(incidentType({ id: 18, src: 'Microsoft-Windows-WHEA-Logger' }), 'hardware');
});
