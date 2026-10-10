const test = require('node:test');
const assert = require('node:assert/strict');
const { plain } = require('../lib/briefing');

test('the em dashes and semicolons the model slips in are rewritten', () => {
  assert.equal(plain('Redoux mercredi — aérez ce soir ; vérifiez vos branchements.'),
    'Redoux mercredi, aérez ce soir. Vérifiez vos branchements.');
  assert.equal(plain('A warm spell – then rain.'), 'A warm spell, then rain.');
});

test('a range written with an en dash is left alone', () => {
  assert.equal(plain('Entre 12–18° demain.'), 'Entre 12–18° demain.');
});
