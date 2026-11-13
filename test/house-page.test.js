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

test('the label of a room says what runs in it', async () => {
  const { roomDigest } = await page('house.js');
  assert.deepEqual(roomDigest({ temperature: 20.4, devices: [
    tile('light', 'Lamp', { on: true }), tile('light', 'Floor lamp', { on: true }), tile('light', 'Spot', { on: false }),
    tile('climate', 'Air conditioner', { on: true, mode: 'cool', setpoint: 24 }),
    tile('heater', 'Towel rail', { on: true, setpoint: 21.5 }),
  ] }), { temperature: 20.4, lights: 2, climate: [{ type: 'climate', mode: 'cool', setpoint: 24 }, { type: 'heater', mode: null, setpoint: 21.5 }] });
  assert.deepEqual(roomDigest({ devices: [tile('climate', 'Air conditioner', { on: true, setpoint: null, mode: 'fan' })] }).climate, [{ type: 'climate', mode: 'fan', setpoint: null }]);
});

test('a room where nothing runs, or nothing answers, has nothing to say', async () => {
  const { roomDigest } = await page('house.js');
  const empty = { temperature: null, lights: 0, climate: [] };
  assert.deepEqual(roomDigest({ devices: [tile('light', 'Lamp', { on: false }), tile('climate', 'Air conditioner', { on: false, setpoint: 24 })] }), empty);
  assert.deepEqual(roomDigest({ devices: [{ type: 'light', name: 'Lamp', state: { reachable: false, on: true } }] }), empty);
  assert.deepEqual(roomDigest({ temperature: null, devices: [] }), empty);
});

test('a few tiles are small cards, more become rows, many become tight rows', async () => {
  const { tileLayout } = await page('house.js');
  assert.equal(tileLayout(1028, 800, 6).look, 'tall');
  assert.equal(tileLayout(1028, 300, 12).look, 'flat');
  assert.equal(tileLayout(1028, 300, 24).look, 'dense');
  const many = tileLayout(1028, 300, 80);
  assert.ok(many.scroll && many.look === 'dense', 'past what fits, the tightest look scrolls');
  assert.equal(tileLayout(1028, 800, 6).scroll, false);
});

test('the tiles never take more than the room they are given', async () => {
  const { tileLayout, TILE_LOOKS } = await page('house.js');
  for (const width of [420, 640, 1028, 1500]) for (const height of [180, 320, 520, 900]) for (const count of [1, 3, 6, 11, 17, 30]) {
    const l = tileLayout(width, height, count), look = TILE_LOOKS.find((x) => x.look === l.look);
    assert.ok(l.columns >= 1 && l.rows * l.columns >= count, 'every tile has a cell');
    if (l.scroll) continue;
    assert.ok(l.rows * l.row + (l.rows - 1) * 10 <= height, `${count} tiles in ${width}x${height}: ${JSON.stringify(l)}`);
    assert.ok(l.row >= look.minRow && l.row <= look.maxRow, 'a row stays within what its look reads well at');
    assert.ok((width - (l.columns - 1) * 10) / l.columns >= look.minWidth, 'a tile is never narrower than its look allows');
  }
});

test('with room to spare, the columns that fill the height best are chosen', async () => {
  const { tileLayout } = await page('house.js');
  const l = tileLayout(1028, 830, 11);
  assert.deepEqual([l.look, l.columns, l.rows], ['tall', 3, 4], 'three columns of four rather than five of three');
});

test('a new block of the weekly program comes an hour after the last one, at a free time', async () => {
  const { nextEntry } = await page('house.js');
  const off = { enabled: true, on: false, mode: null, setpoint: null, fan: null };
  assert.deepEqual(nextEntry([]), { time: '07:00', ...off }, 'an empty day starts in the morning');
  assert.equal(nextEntry([{ time: '06:30' }, { time: '18:00' }]).time, '19:00');
  assert.equal(nextEntry([{ time: '23:30' }]).time, '12:00', 'not past midnight');
  assert.equal(nextEntry([{ time: '12:00' }, { time: '23:30' }]).time, '12:30', 'never on a time already taken');
});

test('two entries of a day at the same time are caught before the unit is asked', async () => {
  const { clashes } = await page('house.js');
  assert.deepEqual(clashes({ mon: [{ time: '07:00' }, { time: '08:00' }], tue: [{ time: '07:00' }, { time: '07:00' }], sun: [] }), ['tue']);
  assert.deepEqual(clashes({}), []);
});

