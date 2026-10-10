const test = require('node:test');
const assert = require('node:assert/strict');
const { stateOf } = require('../lib/services');

test('any answer below 500 means the server is up, even a 403', () => {
  assert.equal(stateOf(200), 'up');
  assert.equal(stateOf(403), 'up');
  assert.equal(stateOf(503), 'error');
  assert.equal(stateOf(null), 'down');
});
