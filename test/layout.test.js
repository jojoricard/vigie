// Nothing scrolls: how a box of blocks is fitted to its height (public/js/fit.js), the
// alerts of the page, the night span, and what the new blocks of the tabs are drawn from.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { pathToFileURL } = require('url');

const page = (file) => import(pathToFileURL(path.join(__dirname, '..', 'public', 'js', file)));
const block = (id, h, extra = {}) => ({ id, prio: 2, h, hc: Math.round(h * 0.7), min: h, minc: Math.round(h * 0.7), grow: 0, ...extra });
const total = (plan, ids, gap = 16) => ids.reduce((s, id) => s + plan.blocks[id].height, 0) + gap * (ids.filter((id) => plan.blocks[id].mode !== 'hidden').length - 1);

test('the page zooms on a large screen and never shrinks on a small one', async () => {
  const { uiScale, columnsFor } = await page('fit.js');
  assert.equal(uiScale(1080, 1920), 1);
  assert.equal(+uiScale(1440, 2560).toFixed(2), 1.33, 'the kiosk: a 1440 x 2560 window shown as 1080 x 1920');
  assert.equal(uiScale(1920, 1080), 1);
  assert.equal(+uiScale(2560, 1440).toFixed(2), 1.33);
  assert.equal(uiScale(400, 850), 1, 'a phone folds, it does not shrink the text');
  assert.equal(uiScale(7680, 4320), 2, 'and the zoom has a ceiling');
  // columns: one upright, two or three lying down, by the width in layout pixels
  assert.deepEqual([[1080, 1920], [1920, 1080], [1280, 800], [768, 1024], [1024, 768], [400, 850], [850, 400]].map(([w, h]) => columnsFor(w, h)), [1, 3, 2, 1, 2, 1, 2]);
});

test('blocks that fit keep their look, and the room left goes to those that grow', async () => {
  const { arrange } = await page('fit.js');
  const plan = arrange([block(0, 200), block(1, 300, { grow: 3 }), block(2, 100, { grow: 1 })], { cols: 1, height: 1000, gap: 16 });
  assert.equal(plan.pages.length, 1);
  assert.deepEqual([0, 1, 2].map((i) => plan.blocks[i].mode), ['normal', 'normal', 'normal']);
  // 1000 - 600 - 2 gaps = 368 left: three quarters to the second block, one to the third
  assert.deepEqual([0, 1, 2].map((i) => plan.blocks[i].height), [200, 576, 192]);
  assert.equal(total(plan, [0, 1, 2]), 1000);
});

test('too much for the height: optional blocks go, then useful ones turn compact', async () => {
  const { arrange } = await page('fit.js');
  const blocks = [block(0, 300, { prio: 1 }), block(1, 200, { prio: 2 }), block(2, 200, { prio: 3 }), block(3, 200, { prio: 2 })];
  // 900 + 3 gaps does not fit 800: the optional block is enough
  let plan = arrange(blocks, { cols: 1, height: 800 });
  assert.deepEqual([0, 1, 2, 3].map((i) => plan.blocks[i].mode), ['normal', 'normal', 'hidden', 'normal']);
  // 650: the last useful block turns compact (140), the first one stays as it is
  plan = arrange(blocks, { cols: 1, height: 680 });
  assert.deepEqual([0, 1, 2, 3].map((i) => plan.blocks[i].mode), ['normal', 'normal', 'hidden', 'compact']);
  // 600: both useful blocks are compact, the one that must stay is untouched
  plan = arrange(blocks, { cols: 1, height: 620 });
  assert.deepEqual([0, 1, 2, 3].map((i) => plan.blocks[i].mode), ['normal', 'compact', 'hidden', 'compact']);
  assert.equal(plan.pages.length, 1);
  assert.ok(total(plan, [0, 1, 3]) <= 620);
});

test('a list gives up rows before the box is cut into sub-views', async () => {
  const { arrange } = await page('fit.js');
  // a list of 400 px that can go down to 120 (its head and three rows)
  const blocks = [block(0, 200, { prio: 1 }), block(1, 400, { prio: 1, min: 120, minc: 100 })];
  const plan = arrange(blocks, { cols: 1, height: 500 });
  assert.equal(plan.pages.length, 1);
  assert.deepEqual([plan.blocks[0].height, plan.blocks[1].height], [200, 284], 'the list takes what is left, the other block keeps its height');
  assert.equal(plan.blocks[1].mode, 'normal');
});

test('when nothing else helps the box is cut into sub-views, every block back in its normal look', async () => {
  const { arrange } = await page('fit.js');
  const blocks = [block(0, 300, { prio: 1 }), block(1, 300, { prio: 1 }), block(2, 250, { prio: 3 }), block(3, 280, { prio: 1 })];
  const plan = arrange(blocks, { cols: 1, height: 420, pager: 26 });
  assert.deepEqual(plan.pages, [[[0]], [[1]], [[2]], [[3]]], 'four sub-views of one block each');
  assert.ok([0, 1, 2, 3].every((i) => plan.blocks[i].mode === 'normal'), 'the optional block is back: it has a page to itself');
  assert.ok([0, 1, 2, 3].every((i) => plan.blocks[i].height <= 420 - 26), 'the dots of the pager have their room');
  // two columns: the sub-views fill column after column
  const wide = arrange(blocks, { cols: 2, height: 420, pager: 26 });
  assert.deepEqual(wide.pages, [[[0], [1]], [[2], [3]]]);
});

test('on a wide screen a block goes to the column it asks for, or the columns are evened out', async () => {
  const { arrange } = await page('fit.js');
  const hinted = arrange([block(0, 200, { col: 1 }), block(1, 500, { col: 2 }), block(2, 200, { col: 3 }), block(3, 100, { col: 1 })], { cols: 3, height: 900 });
  assert.deepEqual(hinted.pages, [[[0, 3], [1], [2]]]);
  const free = arrange([block(0, 300), block(1, 300), block(2, 300), block(3, 300)], { cols: 2, height: 900 });
  assert.deepEqual(free.pages, [[[0, 1], [2, 3]]]);
  // a column that overflows degrades alone: the others keep their blocks as they are
  const tight = arrange([block(0, 500, { col: 1 }), block(1, 500, { col: 1, prio: 3 }), block(2, 300, { col: 2 })], { cols: 2, height: 800 });
  assert.deepEqual([0, 1, 2].map((i) => tight.blocks[i].mode), ['normal', 'hidden', 'normal']);
});

test('a richer look is taken only once every block shows its normal one, and what is left becomes even spacing', async () => {
  const { arrange, MAX_SPACING } = await page('fit.js');
  const blocks = [block(0, 200, { prio: 1, hr: 320 }), block(1, 200, { hr: 300 }), block(2, 150, { prio: 3 })];
  const modes = (plan) => [0, 1, 2].map((i) => plan.blocks[i].mode);
  // 500: the optional block cannot come back (150 x 0.7 + a gap), nothing richer fits either
  let plan = arrange(blocks, { cols: 1, height: 500, gap: 16 });
  assert.deepEqual(modes(plan), ['normal', 'normal', 'hidden']);
  assert.equal(plan.columns[0].could, false, 'no block could take a richer look in the room left');
  // 600: the optional block is back before anyone grows richer
  plan = arrange(blocks, { cols: 1, height: 600, gap: 16 });
  assert.deepEqual(modes(plan), ['normal', 'normal', 'normal']);
  // 900: both rich, the room left is spread between the blocks, never more than the cap
  plan = arrange(blocks, { cols: 1, height: 900, gap: 16 });
  assert.deepEqual(modes(plan), ['rich', 'rich', 'normal']);
  assert.deepEqual([plan.blocks[0].height, plan.blocks[1].height], [320, 300]);
  assert.equal(plan.columns[0].spare, 900 - 770 - 32);
  assert.equal(plan.columns[0].spacing, MAX_SPACING);
  assert.equal(plan.columns[0].could, false);
  // and it folds back: the same blocks on less height lose the rich looks first
  assert.deepEqual(modes(arrange(blocks, { cols: 1, height: 560, gap: 16 })), ['normal', 'normal', 'compact']);
  assert.deepEqual(modes(arrange(blocks, { cols: 1, height: 400, gap: 16 })), ['normal', 'compact', 'hidden']);
});

test('the rows of a list are never cut: those that do not fit start its next page', async () => {
  const { pageRows } = await page('fit.js');
  const lines = Array.from({ length: 7 }, (_, i) => ({ top: i * 40, bottom: i * 40 + 36 }));
  assert.deepEqual(pageRows(lines, 400), [0], 'all of them fit');
  assert.deepEqual(pageRows(lines, 130), [0, 3, 6], 'three whole rows a page: 36 + 40 + 40 = 116, a fourth would be cut');
  assert.deepEqual(pageRows(lines, 20), [0, 1, 2, 3, 4, 5, 6], 'a row taller than the room still gets a page of its own');
  assert.deepEqual(pageRows([], 100), []);
});

/* ---------- Alerts ---------- */
test('each source gives its alerts, with a severity and how long the condition must hold', async () => {
  const { collect, RULES } = await page('alerts.js');
  const now = Date.parse('2026-11-15T12:00:00');
  const state = {
    alerts: [{ type: 'rain', severity: 'orange', area: 'Port-Alba' }, { type: 'wind', severity: 'yellow', area: 'Port-Alba' }],
    energy: { tempoTomorrow: { code: 3 } },
    lastCrash: { at: now - 3600e3, type: 'bsod' },
    changes: [{ kind: 'packetLoss', level: 'alert', pct: 4 }, { kind: 'consumption', level: 'info' }],
    sensors: { cpuTemp: 91, gpuTemp: 60, gpuHot: 70, diskTemps: [45], ssd: { life: 12 } },
    devices: { disks: [{ id: 'C:', total: 1000, free: 50 }, { id: 'D:', total: 1000, free: 500 }], batteries: [{ name: 'Mouse', level: 9, stale: false }, { name: 'Headset', level: 5, stale: true }] },
    windows: { reboot: ['servicing'], updates: [] },
    house: { rooms: [{ id: 'a', name: 'Living room', devices: [
      { id: 'lamp', name: 'Lamp', type: 'light', state: { reachable: false, error: 'lanSilent' } },
      { id: 'ac', name: 'Air conditioner', type: 'climate', state: { reachable: true, on: true } },
      { id: 'tv', name: 'Television', type: 'tv', state: { reachable: false, error: 'timeout' } },
      { id: 'washer', name: 'Washer', type: 'washer', state: { reachable: true, run: 'done' } },
      { id: 'sink', name: 'Sink', type: 'leak', state: { reachable: true, leak: true } },
    ] }] },
    home: { network: { state: 'down' } },
  };
  const got = collect(state, RULES, now), byId = Object.fromEntries(got.map((a) => [a.id, a]));
  assert.deepEqual(Object.keys(byId).sort(), ['battery:Mouse', 'change:packetLoss', 'connection', 'disk:C:', `incident:${now - 3600e3}`, 'laundry:washer', 'leak:sink', 'longOn:ac', 'ssd', 'temp:cpu', 'tempo:2026-11-16', 'unreachable:tv', 'warning:rain:Port-Alba', 'windows:reboot'].sort());
  assert.equal('warning:wind:Port-Alba' in byId, false, 'a yellow warning stays in the Weather tab');
  assert.equal('unreachable:lamp' in byId, false, 'a lamp cut at its wall switch is not a failure');
  assert.equal('battery:Headset' in byId, false, 'the last known level of a sleeping device is not news');
  assert.deepEqual([byId['temp:cpu'].severity, byId.ssd.severity, byId['disk:C:'].severity, byId['leak:sink'].severity, byId['battery:Mouse'].severity], ['red', 'orange', 'orange', 'red', 'yellow']);
  // durations: a unit must have been on for hours, a device silent for minutes
  assert.deepEqual([byId['longOn:ac'].hold, byId['unreachable:tv'].hold, byId['temp:cpu'].hold, byId.ssd.hold], [RULES.climateOnHours * 60, RULES.unreachableMin, RULES.tempHoldMin, 0]);
  assert.deepEqual(collect({}, RULES, now), [], 'a page that knows nothing yet alerts on nothing');
});

test('an alert waits for its duration, stays quiet once acknowledged, and comes back with its cause', async () => {
  const { evaluate, worst } = await page('alerts.js');
  const t0 = 1e12, min = 60000;
  const longOn = { id: 'longOn:ac', kind: 'longOn', severity: 'yellow', hold: 720 }, leak = { id: 'leak:sink', kind: 'leak', severity: 'red', hold: 0 };
  let r = evaluate([longOn, leak], {}, t0);
  assert.deepEqual(r.active.map((a) => a.id), ['leak:sink'], 'the unit has just been seen on: not an alert yet');
  r = evaluate([longOn, leak], r.memory, t0 + 719 * min);
  assert.deepEqual(r.active.map((a) => a.id), ['leak:sink']);
  r = evaluate([longOn, leak], r.memory, t0 + 720 * min);
  assert.deepEqual(r.active.map((a) => [a.id, a.since]), [['leak:sink', t0], ['longOn:ac', t0]], 'red first, and each with the time it started');
  assert.equal(worst(r.active), 'red');
  // acknowledged: quiet while the condition lasts
  const acked = { seen: r.memory.seen, acked: { 'leak:sink': t0 + 721 * min } };
  r = evaluate([longOn, leak], acked, t0 + 722 * min);
  assert.deepEqual(r.active.map((a) => a.id), ['longOn:ac']);
  // the leak is gone, then back: it alerts again, and the unit turned off starts a new count when turned on
  r = evaluate([], r.memory, t0 + 730 * min);
  assert.deepEqual(r.memory, { seen: {}, acked: {} });
  r = evaluate([longOn, leak], r.memory, t0 + 740 * min);
  assert.deepEqual(r.active.map((a) => a.id), ['leak:sink']);
  assert.equal(worst([]), null);
});

test('the night span may cross midnight', async () => {
  const { inSpan, minutesOf } = await page('core.js');
  assert.equal(minutesOf('06:30'), 390);
  const night = (hhmm) => inSpan(minutesOf(hhmm), '23:00', '06:30');
  assert.deepEqual(['22:59', '23:00', '02:00', '06:29', '06:30', '12:00'].map(night), [false, true, true, true, false, false]);
  assert.equal(inSpan(600, '09:00', '18:00'), true);
  assert.equal(inSpan(600, null, '18:00'), false, 'without both ends there is no span');
});

/* ---------- What the new blocks are drawn from ---------- */
const lit = (room, name, state) => ({ type: 'light', name, state: { reachable: true, ...state } });

test('the Overview tells the home room by room: what is on, what heats, the television', async () => {
  const { roomLines } = await page('house.js');
  const rooms = [
    { id: 'a', name: 'Living room', temperature: 20.5, devices: [lit('a', 'Lamp', { on: true }), lit('a', 'Spot', { on: false }),
      { type: 'climate', name: 'AC', state: { reachable: true, on: true, mode: 'heat', setpoint: 21 } },
      { type: 'tv', name: 'Television', state: { reachable: true, on: true, appName: 'Player' } },
      { type: 'cover', name: 'Shutter', state: { reachable: true, position: 60 } }] },
    { id: 'b', name: 'Office', devices: [lit('b', 'Desk lamp', { on: false }), { type: 'climate', name: 'AC', state: { reachable: false, on: true } }] },
    { id: 'c', name: 'Cellar', devices: [{ type: 'light', name: 'Bulb', state: { reachable: false, error: 'lanSilent' } }] },
  ];
  const lines = roomLines(rooms);
  assert.deepEqual(lines.map((r) => r.room), ['Living room', 'Office'], 'a room with nothing that answers is left out');
  assert.deepEqual(lines[0].parts.map((p) => [p.kind, p.on]), [['lights', true], ['climate', true], ['tv', true], ['covers', true]]);
  assert.deepEqual([lines[0].parts[0].lit, lines[0].parts[0].of, lines[0].parts[1].mode, lines[0].parts[1].setpoint, lines[0].parts[2].app, lines[0].temperature], [1, 2, 'heat', 21, 'Player', 20.5]);
  assert.deepEqual(lines[1].parts, [{ icon: 'bulb', on: false, kind: 'lights', lit: 0, of: 1 }], 'a unit that does not answer counts for nothing');
  assert.deepEqual(roomLines(null), []);
});

test('the Energy tab reads the counters the units keep, and the meter when a module gives one', async () => {
  const { climateEnergy, meterOf } = await page('energy.js');
  const rooms = [{ id: 'a', name: 'Living room', devices: [
    { id: 'ac', name: 'AC', type: 'climate', state: { reachable: true, energy: { today: 2.4, week: 19.8 } } },
    { id: 'ac2', name: 'AC', type: 'climate', state: { reachable: false, energy: { today: 1, week: 2 } } },
    { id: 'lamp', name: 'Lamp', type: 'light', state: { reachable: true } },
    { id: 'linky', name: 'Linky', type: 'meter', state: { reachable: true, power: 1840 } },
  ] }];
  assert.deepEqual(climateEnergy(rooms), [{ id: 'ac', name: 'AC', room: 'Living room', today: 2.4, week: 19.8, month: null, days: null }]);
  assert.equal(meterOf(rooms).id, 'linky');
  assert.equal(meterOf([{ devices: [{ type: 'meter', state: { reachable: false } }] }]), null, 'no module answering: no meter block');
  assert.deepEqual(climateEnergy(null), []);
});

test('the week of the units stacks day by day, and the total adds the PC to them', async () => {
  const { stackDays, trackedEnergy } = await page('energy.js');
  const units = [
    { today: 2, month: 40, days: [{ heat: 2, cool: 0 }, { heat: 3, cool: 0.5 }, { heat: 1, cool: 0 }] },
    { today: 0.5, month: null, days: [{ heat: 0.5, cool: 0 }, { heat: 0, cool: 0 }] },
    { today: null, month: null, days: null },
  ];
  const week = stackDays(units, 3);
  assert.deepEqual(week.map((d) => d.ago), [2, 1, 0], 'oldest first: today is the last bar');
  assert.deepEqual(week.map((d) => d.parts), [[1, 0, 0], [3.5, 0, 0], [2, 0.5, 0]]);
  assert.deepEqual(week.map((d) => d.total), [1, 3.5, 2.5]);
  const all = trackedEnergy({ today: { kwh: 1.5 }, month: { kwh: 20 } }, units, 0.2);
  assert.deepEqual(all.today, { kwh: 4, cost: 0.8, pc: 1.5, units: 2.5 });
  assert.deepEqual(all.month, { kwh: 60, cost: 12, pc: 20, units: 40 });
  assert.equal(trackedEnergy({ today: { kwh: 1 } }, [], null).today.cost, null, 'no price, no cost');
  assert.deepEqual(trackedEnergy(null, [], 0.2), { today: null, month: null });
});

test('the Tools tab puts forward what came out since the last visit', async () => {
  const { releasedSince } = await page('tools.js');
  const now = Date.parse('2026-11-15T12:00:00Z'), day = 86400000, iso = (d) => new Date(now - d * day).toISOString();
  const releases = { 'a/old': { version: 'v1', date: iso(40) }, 'a/recent': { version: 'v2', date: iso(10) }, 'a/new': { version: 'v3', date: iso(2) }, 'a/undated': { version: 'v4' } };
  assert.deepEqual(releasedSince(releases, now - 5 * day, now).map((v) => v.repo), ['a/new']);
  assert.deepEqual(releasedSince(releases, null, now).map((v) => v.repo), ['a/new', 'a/recent'], 'before any visit: the last two weeks, newest first');
  assert.deepEqual(releasedSince(releases, now, now), []);
  assert.deepEqual(releasedSince(null, null, now), []);
});

test('the coming hours of the Overview hold sunrise and sunset at their hour', async () => {
  const { hourCells } = await page('weather.js');
  const hours = Array.from({ length: 48 }, (_, i) => `2026-11-${15 + Math.floor(i / 24)}T${String(i % 24).padStart(2, '0')}:00`);
  const w = {
    hourly: { time: hours, weather_code: hours.map(() => 3), temperature_2m: hours.map((_, i) => 10 + (i % 5)), precipitation_probability: hours.map(() => 20) },
    daily: { time: ['2026-11-15', '2026-11-16'], sunrise: ['2026-11-15T07:40', '2026-11-16T07:41'], sunset: ['2026-11-15T17:09', '2026-11-16T17:08'] },
  };
  const now = new Date('2026-11-15T14:20').getTime();
  const realNow = Date.now;
  Date.now = () => now;      // hourIndex() reads the clock
  try {
    const cells = hourCells(w, 20, now);
    assert.equal(cells.length, 20, 'the row keeps the length asked for');
    assert.equal(cells[0].time, '2026-11-15T15:00', 'it starts at the next hour');
    assert.deepEqual(cells.filter((c) => c.kind !== 'hour').map((c) => [c.kind, c.time]), [['set', '2026-11-15T17:09'], ['rise', '2026-11-16T07:41']]);
    assert.equal(cells[2].kind, 'set', 'sunset stands where 17:00 would');
    assert.deepEqual(hourCells({ hourly: null }, 8, now), []);
  } finally { Date.now = realNow; }
});

test('the PC updates card: the GPU driver, the BIOS, then Windows with what waits', async () => {
  const { pcUpdates } = await page('tools.js');
  const machine = { gpu: 'Example GPU', gpuDriver: '32.0.1', gpuDriverDate: '2026-10-01', motherboard: 'Example Board', bios: '1.2', biosDate: '2025-01-01', os: 'Windows 11', build: '26200', hotfix: 'KB1', hotfixDate: '2026-11-01' };
  const rows = pcUpdates(machine, { updates: [{ title: 'a' }, { title: 'b' }], reboot: [] });
  assert.deepEqual(rows.map((r) => r.id), ['gpu', 'bios', 'windows']);
  assert.deepEqual([rows[2].name, rows[2].version, rows[2].pending, rows[2].reboot], ['Windows 11 · build 26200', 'KB1', 2, false]);
  assert.equal(pcUpdates(machine, { updates: [], reboot: ['servicing'] })[2].reboot, true);
  assert.deepEqual(pcUpdates({ os: 'Windows 11' }, null).map((r) => r.id), ['windows'], 'what the agent could not read is left out');
  assert.deepEqual(pcUpdates(null, null), []);
});

test('a mouse at 17 % alerts: the battery threshold is 20 %', async () => {
  const { collect, RULES } = await page('alerts.js');
  assert.equal(RULES.batteryPct, 20);
  const got = collect({ devices: { batteries: [{ name: 'Mouse', level: 17, stale: false }, { name: 'Keyboard', level: 21, stale: false }] } }, RULES, Date.now());
  assert.deepEqual(got.map((a) => a.id), ['battery:Mouse']);
});

test('an extra block comes last, once every other block is at its richest, and never in a sub-view', async () => {
  const { arrange } = await page('fit.js');
  const blocks = [block(0, 200, { prio: 1, hr: 320 }), block(1, 300, { prio: 4 })];
  const modes = (plan) => [0, 1].map((i) => plan.blocks[i].mode);
  assert.deepEqual(modes(arrange(blocks, { cols: 1, height: 520, gap: 16 })), ['rich', 'hidden'], 'the rich look first, even if the extra could have fitted instead');
  assert.deepEqual(modes(arrange(blocks, { cols: 1, height: 640, gap: 16 })), ['rich', 'normal']);
  const paged = arrange([block(0, 300, { prio: 1 }), block(1, 300, { prio: 1 }), block(2, 200, { prio: 4 })], { cols: 1, height: 400, pager: 26 });
  assert.equal(paged.pages.length, 2);
  assert.equal(paged.blocks[2].mode, 'hidden');
});
