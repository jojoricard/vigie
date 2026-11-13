// House tab: what a tile and a room title show, from the state the service gives.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { pathToFileURL } = require('url');

const page = (file) => import(pathToFileURL(path.join(__dirname, '..', 'public', 'js', file)));

test('a lit lamp fills its tile with its color, a lamp that is off stays neutral', async () => {
  const { lampFill } = await page('house.js');
  assert.equal(lampFill({ on: false, colorRgb: 0xff0000 }), null);
  assert.deepEqual(lampFill({ on: true, colorRgb: 0xff9500, colorTempK: null }), { color: 'rgb(255, 149, 0)', dark: true });
  assert.deepEqual(lampFill({ on: true, colorRgb: 0x0a84ff, colorTempK: null }), { color: 'rgb(10, 132, 255)', dark: false });
  assert.deepEqual(lampFill({ on: true, colorRgb: 0, colorTempK: null }), { color: 'rgb(0, 0, 0)', dark: false });
});

test('a white lamp is drawn from its color temperature: warm at 2700 K, cold at 9000 K', async () => {
  const { kelvinToRgb, lampFill } = await page('house.js');
  const [rw, gw, bw] = kelvinToRgb(2700), [rc, gc, bc] = kelvinToRgb(9000);
  assert.ok(rw === 255 && gw > 150 && gw < 190 && bw < 110, `2700 K is orange-white, got ${[rw, gw, bw]}`);
  assert.ok(bc === 255 && rc < 230 && gc < 245, `9000 K is blue-white, got ${[rc, gc, bc]}`);
  assert.deepEqual(kelvinToRgb(6600), [255, 255, 255]);
  assert.equal(lampFill({ on: true, colorRgb: null, colorTempK: 4000 }).dark, true, 'a white fill takes dark text');
});

const tile = (type, name, state) => ({ type, name, state: { reachable: true, ...state } });

test('the title of a room says what runs in it', async () => {
  const { roomSummary } = await page('house.js');
  assert.equal(roomSummary({ devices: [
    tile('light', 'Lamp', { on: true }), tile('light', 'Floor lamp', { on: true }), tile('light', 'Spot', { on: false }),
    tile('climate', 'Air conditioner', { on: true, setpoint: 20 }),
  ] }), '2 lights on · Air conditioner 20°');
  assert.equal(roomSummary({ devices: [tile('light', 'Lamp', { on: true }), tile('heater', 'Towel rail', { on: true, setpoint: 21.5 })] }), '1 light on · Towel rail 21.5°');
  assert.equal(roomSummary({ devices: [tile('climate', 'Air conditioner', { on: true, setpoint: null, mode: 'fan' })] }), 'Air conditioner');
});

test('a room where nothing runs, or nothing answers, says so', async () => {
  const { roomSummary } = await page('house.js');
  assert.equal(roomSummary({ devices: [tile('light', 'Lamp', { on: false }), tile('climate', 'Air conditioner', { on: false, setpoint: 24 })] }), 'everything is off');
  assert.equal(roomSummary({ devices: [{ type: 'light', name: 'Lamp', state: { reachable: false, on: true } }] }), 'everything is off');
  assert.equal(roomSummary({ devices: [] }), 'everything is off');
});
