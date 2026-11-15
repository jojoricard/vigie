// Drivers of the house service against simulated answers: Daikin (HTTP), Govee (UDP and
// cloud), Cozytouch (Overkiz JSON). Addresses and ids are documentation values.
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('events');
const daikin = require('../house/drivers/daikin');
const goveeLan = require('../house/drivers/govee-lan');
const goveeCloud = require('../house/drivers/govee-cloud');
const cozytouch = require('../house/drivers/cozytouch');
const { DeviceError } = require('../house/util');

/* ================= Daikin ================= */
const UNIT = { id: 'living-ac', name: 'Air conditioner', ip: '192.0.2.20' };
const MODEL = 'ret=OK,model=0000,type=N,en_scdltmr=1,en_frate=1,en_spmode=5,en_onofftmr=1,hmlmt_l=10.0,en_fdir=1,s_fdir=3';
const CONTROL = 'ret=OK,pow=1,mode=4,adv=,stemp=20.0,shum=0,dt1=25.0,dt2=M,dt3=24.0,dt4=20.0,dt7=25.0,dh1=AUTO,dh2=50,dh3=0,dh4=0,f_rate=A,f_dir=0';

// A unit made of canned answers. Every request is recorded.
function fakeUnit(over = {}) {
  const answers = {
    '/aircon/get_model_info': MODEL,
    '/aircon/get_control_info': CONTROL,
    '/aircon/get_sensor_info': 'ret=OK,htemp=23.0,hhum=50,otemp=8.0,err=0',
    '/aircon/get_day_power_ex': 'ret=OK,curr_day_heat=1/0/0/3,prev_1day_heat=1/1/2/1,curr_day_cool=0/0/0/0,prev_1day_cool=0/0/0/1',
    '/aircon/get_week_power_ex': 'ret=OK,s_dayw=5,week_heat=4/12/19/22/43/67/36/62/59/71/50/53/61/54,week_cool=0/0/0/0/0/0/1/9/9/9/9/9/9/9',
    '/aircon/get_year_power_ex': 'ret=OK,curr_year_heat=0/0/0/0/0/0/0/0/0/321/559/0,prev_year_heat=0/0/0/0/0/0/0/0/0/0/0/0,curr_year_cool=0/0/0/0/0/0/446/757/131/26/1/0,prev_year_cool=0/0/0/0/0/0/0/0/0/0/0/0',
    '/aircon/get_onofftimer': 'ret=OK,enable=0',
    '/aircon/get_scdltimer_info': 'ret=OK,format=v1,scdl_num=3,scdl_per_day=6,en_scdltimer=1,active_no=1',
    ...over,
  };
  const calls = [];
  const get = async (ip, path) => {
    calls.push(path);
    const key = path.split('?')[0];
    if (answers[key] instanceof Error) throw answers[key];
    return answers[key] ?? 'ret=PARAM NG';
  };
  // November: the month whose counters are read
  return { calls, driver: daikin.create({ get, now: () => new Date(2026, 10, 13, 17, 0).getTime() }) };
}
const sent = (calls, path) => Object.fromEntries(new URLSearchParams(calls.find((c) => c.startsWith(path)).split('?')[1]));

test('daikin: the answer of a unit is read into the service vocabulary', async () => {
  const s = await fakeUnit().driver.state(UNIT);
  assert.deepEqual({ on: s.on, mode: s.mode, setpoint: s.setpoint, fan: s.fan, swing: s.swing }, { on: true, mode: 'heat', setpoint: 20, fan: 'auto', swing: 'off' });
  assert.deepEqual({ probe: s.probeTemp, outdoor: s.outdoorTemp }, { probe: 23, outdoor: 8 });
  assert.deepEqual({ powerful: s.powerful, econo: s.econo }, { powerful: false, econo: false });
  assert.equal('streamer' in s, false);
});

test('daikin: energy adds heating and cooling of this unit, in kWh', async () => {
  const { energy } = await fakeUnit().driver.state(UNIT);
  assert.deepEqual(energy, {
    today: 0.4,            // 1 + 3 tenths of a kWh
    yesterday: 0.6,        // 5 heating + 1 cooling
    week: 20.4,            // the first 7 days of each list: 203 heating + 1 cooling
    month: 56,             // November: 559 heating + 1 cooling
    year: 224.1,
    // week_heat 4/12/19/22/43/67/36 and week_cool 0/0/0/0/0/0/1, today first
    days: [{ heat: 0.4, cool: 0 }, { heat: 1.2, cool: 0 }, { heat: 1.9, cool: 0 }, { heat: 2.2, cool: 0 }, { heat: 4.3, cool: 0 }, { heat: 6.7, cool: 0 }, { heat: 3.6, cool: 0.1 }],
  });
});

test('daikin: special modes are read from "adv", a missing temperature is null', async () => {
  const unit = fakeUnit({
    '/aircon/get_control_info': CONTROL.replace('adv=', 'adv=2/13').replace('stemp=20.0', 'stemp=M') + ',en_streamer=1',
    '/aircon/get_sensor_info': 'ret=OK,htemp=22.5,otemp=-,err=0',
  });
  const s = await unit.driver.state(UNIT);
  assert.deepEqual({ powerful: s.powerful, econo: s.econo, streamer: s.streamer }, { powerful: true, econo: false, streamer: true });
  assert.deepEqual({ setpoint: s.setpoint, outdoor: s.outdoorTemp }, { setpoint: null, outdoor: null });
});

test('daikin: timers are reported as on or off, read only', async () => {
  const s = await fakeUnit().driver.state(UNIT);
  assert.deepEqual([s.timer, s.schedule], [{ enabled: false }, { enabled: true }]);
});

test('daikin: capabilities are what the unit says it supports', async () => {
  const full = await fakeUnit().driver.capabilities(UNIT);
  assert.deepEqual(Object.keys(full), ['on', 'mode', 'setpoint', 'fan', 'swing', 'powerful', 'econo']);
  assert.deepEqual(full.setpoint, { min: 10, max: 32, step: 0.5 });
  assert.deepEqual(full.swing.options, ['off', 'vertical', 'horizontal', 'both']);
  const basic = await fakeUnit({
    '/aircon/get_model_info': 'ret=OK,model=0000,en_frate=0,en_fdir=0',
    '/aircon/get_control_info': 'ret=OK,pow=0,mode=3,stemp=24.0,shum=0,f_rate=A,f_dir=0',
  }).driver.capabilities(UNIT);
  assert.deepEqual(Object.keys(basic), ['on', 'mode', 'setpoint']);
});

test('daikin: an old firmware without counters or timers still gives its state', async () => {
  const unit = fakeUnit({
    '/aircon/get_model_info': 'ret=OK,model=0000,en_frate=1,en_fdir=1,s_fdir=1',
    '/aircon/get_day_power_ex': 'ret=PARAM NG', '/aircon/get_sensor_info': new DeviceError('timeout'),
  });
  const s = await unit.driver.state(UNIT);
  assert.deepEqual({ on: s.on, energy: s.energy, timer: s.timer, schedule: s.schedule, probe: s.probeTemp }, { on: true, energy: null, timer: null, schedule: null, probe: null });
  assert.equal(unit.calls.includes('/aircon/get_onofftimer'), false, 'not asked when the unit does not announce it');
});

test('daikin: a change sends every field, only the requested ones modified', async () => {
  const unit = fakeUnit({ '/aircon/set_control_info': 'ret=OK' });
  await unit.driver.set(UNIT, { setpoint: 21.5, fan: 'quiet' });
  assert.deepEqual(sent(unit.calls, '/aircon/set_control_info'), { pow: '1', mode: '4', stemp: '21.5', shum: '0', f_rate: 'B', f_dir: '0' });
});

test('daikin: a change of mode takes the target and humidity kept for that mode', async () => {
  // from dry, whose target is "M": sent as is, the unit would refuse the command
  const unit = fakeUnit({ '/aircon/get_control_info': CONTROL.replace('mode=4', 'mode=2').replace('stemp=20.0', 'stemp=M'), '/aircon/set_control_info': 'ret=OK' });
  await unit.driver.set(UNIT, { mode: 'cool', on: false, swing: 'both' });
  assert.deepEqual(sent(unit.calls, '/aircon/set_control_info'), { pow: '0', mode: '3', stemp: '24.0', shum: '0', f_rate: 'A', f_dir: '3' });
});

test('daikin: special modes have their own command and leave the rest alone', async () => {
  const unit = fakeUnit({ '/aircon/set_special_mode': 'ret=OK,adv=2' });
  await unit.driver.set(UNIT, { powerful: true, econo: false });
  const special = unit.calls.filter((c) => c.startsWith('/aircon/set_special_mode'));
  assert.deepEqual(special, ['/aircon/set_special_mode?set_spmode=1&spmode_kind=1', '/aircon/set_special_mode?set_spmode=0&spmode_kind=2']);
  assert.equal(unit.calls.some((c) => c.startsWith('/aircon/set_control_info')), false);
});

test('daikin: a refused command or a silent unit is a DeviceError naming the device', async () => {
  const refused = fakeUnit({ '/aircon/set_control_info': 'ret=PARAM NG' });
  await assert.rejects(refused.driver.set(UNIT, { setpoint: 21 }), (e) => e instanceof DeviceError && e.message === 'Air conditioner: PARAM NG');
  const silent = fakeUnit({ '/aircon/get_control_info': new DeviceError('timeout') });
  await assert.rejects(silent.driver.state(UNIT), (e) => e instanceof DeviceError && e.message === 'Air conditioner: timeout');
});

// Made-up answers in the layout real units give: the time of an entry is the minute of the day.
const SCHEDULE_INFO = 'ret=OK,format=v1,f_detail=total#18;_en#1;_pow#1;_mode#1;_temp#4;_time#4;_vol#1;_dir#1;_humi#3;_spmd#2,scdl_num=3,scdl_per_day=6,en_scdltimer=1,active_no=2,scdl1_name=,scdl2_name=%57%65%65%6b%20%c3%a9,scdl3_name=';
const SCHEDULE_BODY = 'ret=OK,format=v1,target=2,en_scdltimer=1,moc=3,mo1=11322.51065A------,mo2=11420.50390B------,mo3=10-----0495-------,tuc=0,wec=1,we1=112----1230-------,thc=0,frc=0,sac=1,sa1=01424.005555205001,suc=0';
const OFF = { mode: null, setpoint: null, fan: null };

// A unit that keeps the program it is sent, as a real one does. `deaf` answers OK and keeps nothing.
function programUnit({ body = SCHEDULE_BODY, info = SCHEDULE_INFO, deaf = false } = {}) {
  const store = { body, info }, calls = [];
  const get = async (ip, path) => {
    calls.push(path);
    const [route, query = ''] = path.split('?');
    if (route === '/aircon/get_scdltimer_info') return store.info;
    if (route === '/aircon/get_scdltimer_body') return store.body;
    if (route === '/aircon/set_scdltimer_body') { if (!deaf) store.body = 'ret=OK,' + query.split('&').join(',').replace(/(target=\d+)/, '$1,en_scdltimer=1'); return 'ret=OK'; }
    if (route === '/aircon/set_scdltimer_info') { if (!deaf) store.info = store.info.replace(/en_scdltimer=\d/, query.match(/en_scdltimer=\d/)[0]); return 'ret=OK'; }
    return { '/aircon/get_model_info': MODEL, '/aircon/get_control_info': CONTROL, '/aircon/get_onofftimer': 'ret=OK,enable=0' }[route] ?? 'ret=PARAM NG';
  };
  return { calls, store, driver: daikin.create({ get, now: () => new Date(2026, 10, 13, 17, 0).getTime() }) };
}
const bodySent = (calls) => Object.fromEntries(calls.filter((c) => c.startsWith('/aircon/set_scdltimer_body?')).pop().split('?')[1].split('&').map((kv) => kv.split('=')));

test('daikin: the weekly program is read from the layout the unit announces', async () => {
  const unit = programUnit();
  const { schedule } = await unit.driver.state(UNIT);
  assert.deepEqual({ enabled: schedule.enabled, program: schedule.program, name: schedule.name, perDay: schedule.perDay }, { enabled: true, program: 2, name: 'Week é', perDay: 6 });
  assert.ok(unit.calls.includes('/aircon/get_scdltimer_body?target=2'), 'the active program is the one read');
  // sorted by time, whatever the order in the unit. 390 is 06:30, 495 08:15, 1065 17:45
  assert.deepEqual(schedule.days.mon, [
    { time: '06:30', enabled: true, on: true, mode: 'heat', setpoint: 20.5, fan: 'quiet' },
    { time: '08:15', enabled: true, on: false, ...OFF },
    { time: '17:45', enabled: true, on: true, mode: 'cool', setpoint: 22.5, fan: 'auto' },
  ]);
  assert.deepEqual(schedule.days.wed, [{ time: '20:30', enabled: true, on: true, mode: 'dry', setpoint: null, fan: null }], 'dry has no target and no fan');
  assert.deepEqual(schedule.days.sat, [{ time: '09:15', enabled: false, on: true, mode: 'heat', setpoint: 24, fan: '3' }], 'an entry switched off in the app is kept, marked');
  assert.deepEqual([schedule.days.tue, schedule.days.sun], [[], []]);
  assert.deepEqual(Object.keys(schedule.days), ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun']);
});

test('daikin: a program entry the driver cannot read gives nulls, not a guess', async () => {
  const info = daikin.parse(SCHEDULE_INFO), body = daikin.parse('ret=OK,moc=1,mo1=10X--.-2575Z------,tuc=0');
  const [e] = daikin.program(info, body).days.mon;
  assert.deepEqual(e, { time: null, enabled: true, on: false, mode: null, setpoint: null, fan: null }, 'minute 2575 is not in a day');
  // another layout is followed, not assumed
  const other = daikin.program({ ...info, f_detail: 'total#10;_time#4;_en#1;_pow#1;_temp#4' }, daikin.parse('ret=OK,frc=1,fr1=04201121.0'));
  assert.deepEqual(other.days.fri[0], { time: '07:00', enabled: true, on: true, mode: null, setpoint: 21, fan: null });
});

test('daikin: without a layout the program is only known as active or not, and cannot be set', async () => {
  const unit = fakeUnit();
  assert.deepEqual((await unit.driver.state(UNIT)).schedule, { enabled: true });
  assert.equal(unit.calls.some((c) => c.startsWith('/aircon/get_scdltimer_body')), false);
  assert.equal('schedule' in await unit.driver.capabilities(UNIT), false);
});

test('daikin: a unit that describes its program can have it set, in the modes seen on real units', async () => {
  assert.deepEqual((await programUnit().driver.capabilities(UNIT)).schedule, { type: 'program', perDay: 6, modes: ['heat', 'cool', 'dry'] });
});

test('daikin: sending back the program that was read leaves every entry as it came', async () => {
  const unit = programUnit();
  const { schedule } = await unit.driver.state(UNIT);
  await unit.driver.set(UNIT, { schedule: { days: schedule.days } });
  const before = daikin.parse(SCHEDULE_BODY), sent = bodySent(unit.calls);
  // mon1 and mon2 were stored out of order: only their rank changes
  assert.deepEqual([sent.mo1, sent.mo2, sent.mo3], [before.mo2, before.mo3, before.mo1]);
  assert.equal(sent.sa1, before.sa1, 'vane, humidity and special mode of an entry are not lost');
  assert.deepEqual([sent.format, sent.target, sent.moc, sent.tuc, sent.wec, sent.we1, sent.sac, sent.suc], ['v1', '2', '3', '0', '1', before.we1, '1', '0']);
  assert.equal(unit.calls.some((c) => c.startsWith('/aircon/set_scdltimer_info')), false, 'the active flag is not touched when only the entries are sent');
});

test('daikin: new entries are written the way the unit writes them', async () => {
  const unit = programUnit();
  await unit.driver.set(UNIT, { schedule: { days: {
    mon: [{ time: '22:00', on: false }, { time: '07:15', on: true, mode: 'heat', setpoint: 21, fan: 'auto' }],
    tue: [{ time: '14:45', on: true, mode: 'cool', setpoint: 26.3, fan: '3' }, { time: '20:30', on: true, mode: 'dry', setpoint: 30, fan: '5' }],
    sat: [{ time: '09:15', on: true, mode: 'heat', setpoint: 19, fan: '3', enabled: true }],
  } } });
  const sent = bodySent(unit.calls);
  assert.deepEqual([sent.moc, sent.mo1, sent.mo2], ['2', '11421.00435A------', '10-----1320-------'], 'sorted by time, off is dashes');
  assert.deepEqual([sent.tuc, sent.tu1, sent.tu2], ['2', '11326.508855------', '112----1230-------'], 'the target is rounded to the half degree, dry carries none');
  assert.equal(sent.sa1, '11419.005555205001', 'an entry changed in place keeps the fields nobody sets here');
  assert.deepEqual([sent.wec, sent.we1], ['0', undefined], 'a day left out is emptied');
  // and it reads back as it was asked
  const { schedule } = await unit.driver.state(UNIT);
  assert.deepEqual(schedule.days.mon.map((e) => [e.time, e.on]), [['07:15', true], ['22:00', false]]);
  assert.equal(unit.calls.filter((c) => c.startsWith('/aircon/get_scdltimer_body')).length >= 3, true, 'read before, read after, and read again for the state');
});

test('daikin: a program the unit could not run as asked is refused before anything is sent', async () => {
  const unit = programUnit();
  const refuse = (days, why) => assert.rejects(unit.driver.set(UNIT, { schedule: { days } }), (e) => e instanceof RangeError && why.test(e.message), String(why));
  await refuse({ mon: Array.from({ length: 7 }, (_, i) => ({ time: `0${i}:00`, on: false })) }, /6 entries a day/);
  await refuse({ mon: [{ time: '25:00', on: false }] }, /HH:MM/);
  await refuse({ mon: [{ time: '07:00', on: true, mode: 'fan' }] }, /"mode" must be one of heat, cool, dry/);
  await refuse({ mon: [{ time: '07:00', on: true, mode: 'heat', setpoint: 'warm' }] }, /"setpoint"/);
  await refuse({ mon: [{ time: '07:00', on: true, mode: 'heat', setpoint: 20, fan: 'turbo' }] }, /"fan"/);
  await refuse({ mon: [{ time: '07:00', on: false }, { time: '07:00', on: true, mode: 'dry' }] }, /two entries at 07:00/);
  await refuse({ mon: 'every morning' }, /must be a list/);
  await assert.rejects(unit.driver.set(UNIT, { schedule: { enabled: 'yes' } }), RangeError);
  assert.equal(unit.calls.some((c) => c.startsWith('/aircon/set_')), false);
  // a target out of range is brought back into it, like a slider
  await unit.driver.set(UNIT, { schedule: { days: { mon: [{ time: '07:00', on: true, mode: 'heat', setpoint: 45 }] } } });
  assert.equal(bodySent(unit.calls).mo1, '11432.00420A------');
});

test('daikin: an entry in a mode that cannot be asked for still goes back untouched', async () => {
  const body = SCHEDULE_BODY.replace('thc=0', 'thc=1,th1=11023.00600A------');   // auto, set in the app
  const unit = programUnit({ body });
  const { schedule } = await unit.driver.state(UNIT);
  assert.equal(schedule.days.thu[0].mode, 'auto');
  schedule.days.fri = [{ time: '07:00', on: false }];
  await unit.driver.set(UNIT, { schedule: { days: schedule.days } });
  assert.equal(bodySent(unit.calls).th1, '11023.00600A------');
  // changed, it is a new entry in a mode nobody has seen written: refused
  schedule.days.thu[0].setpoint = 24;
  await assert.rejects(unit.driver.set(UNIT, { schedule: { days: schedule.days } }), RangeError);
});

test('daikin: a unit that answers OK but did not keep the program is an error', async () => {
  const unit = programUnit({ deaf: true });
  await assert.rejects(unit.driver.set(UNIT, { schedule: { days: { mon: [{ time: '07:00', on: false }] } } }), (e) => e instanceof DeviceError && /did not keep the program/.test(e.message));
  await assert.rejects(unit.driver.set(UNIT, { schedule: { enabled: false } }), (e) => e instanceof DeviceError && /did not stop its program/.test(e.message));
});

test('daikin: the program is started and stopped without touching its entries or its names', async () => {
  const unit = programUnit();
  await unit.driver.set(UNIT, { schedule: { enabled: false } });
  const info = unit.calls.find((c) => c.startsWith('/aircon/set_scdltimer_info?')).split('?')[1];
  assert.equal(info, 'format=v1&en_scdltimer=0&active_no=2&scdl1_name=&scdl2_name=%57%65%65%6b%20%c3%a9&scdl3_name=', 'the names go back as the unit gave them');
  assert.equal(unit.calls.some((c) => c.startsWith('/aircon/set_scdltimer_body')), false);
  assert.equal((await unit.driver.state(UNIT)).schedule.enabled, false);
});

test('daikin: counters and timers are read once per 10 minutes, the state every time', async () => {
  const unit = fakeUnit();
  await unit.driver.state(UNIT);
  await unit.driver.state(UNIT);
  const count = (p) => unit.calls.filter((c) => c === p).length;
  assert.deepEqual([count('/aircon/get_control_info'), count('/aircon/get_day_power_ex'), count('/aircon/get_model_info')], [2, 1, 1]);
});

/* ================= Govee, local network ================= */
const LAMP = { id: 'living-lamp', name: 'Lamp', device: '00:00:5E:00:53:01:00:01' };
const LAMP_IP = '192.0.2.10';

// A network with lamps on it: answers a scan and a devStatus like the real ones, on the
// socket the driver listens on.
function fakeNetwork(lamps) {
  const sent = [];
  let scans = 0;
  const sock = new EventEmitter();
  Object.assign(sock, {
    memberships: [], multicast: [],
    bind(port, cb) { sock.port = port; cb(); },
    addMembership(group, address) { sock.memberships.push([group, address]); },
    setMulticastInterface(a) { sock.multicast.push(a); },
    close() { sock.closed = true; },
    send(buf, port, address, cb) {
      const msg = JSON.parse(buf.toString()).msg;
      sent.push({ port, address, ...msg });
      cb(null);
      queueMicrotask(() => {
        if (msg.cmd === 'scan') {
          scans++;
          for (const l of lamps) if (l.lan && (address === '239.255.255.250' || address === l.ip)) {
            sock.emit('message', Buffer.from(JSON.stringify({ msg: { cmd: 'scan', data: { ip: l.ip, device: l.device, sku: 'H0000' } } })), { address: l.ip, port: 4001 });
          }
        }
        const lamp = lamps.find((l) => l.ip === address && l.lan);
        if (!lamp || port !== 4003) return;
        if (msg.cmd === 'turn') lamp.status.onOff = msg.data.value;
        if (msg.cmd === 'brightness') lamp.status.brightness = msg.data.value;
        if (msg.cmd === 'colorwc') Object.assign(lamp.status, msg.data);
        if (msg.cmd === 'devStatus') sock.emit('message', Buffer.from(JSON.stringify({ msg: { cmd: 'devStatus', data: lamp.status } })), { address: lamp.ip, port: 4003 });
      });
    },
  });
  const driver = goveeLan.create({ socket: () => sock, addresses: () => ['192.0.2.2', '198.51.100.2'], timeoutMs: 20 });
  return { sock, sent, driver, scans: () => scans };
}
const lamp = (over = {}) => ({ ip: LAMP_IP, device: LAMP.device, lan: true, status: { onOff: 1, brightness: 60, color: { r: 255, g: 128, b: 0 }, colorTemInKelvin: 0 }, ...over });

test('govee-lan: a lamp is found by a scan sent on every network card, then asked for its state', async () => {
  const net = fakeNetwork([lamp()]);
  const s = await net.driver.state(LAMP);
  assert.deepEqual(s, { reachable: true, on: true, brightness: 60, colorRgb: 0xff8000, colorTempK: null });
  assert.equal(net.sock.port, 4002);
  assert.deepEqual(net.sock.memberships, [['239.255.255.250', '192.0.2.2'], ['239.255.255.250', '198.51.100.2']]);
  assert.deepEqual(net.sock.multicast, ['192.0.2.2', '198.51.100.2']);
  const scan = net.sent.find((m) => m.cmd === 'scan');
  assert.deepEqual([scan.port, scan.address, scan.data], [4001, '239.255.255.250', { account_topic: 'reserve' }]);
  const status = net.sent.find((m) => m.cmd === 'devStatus');
  assert.deepEqual([status.port, status.address], [4003, LAMP_IP]);
});

test('govee-lan: a color temperature hides the color, and the other way round', async () => {
  const net = fakeNetwork([lamp({ status: { onOff: 0, brightness: 12, color: { r: 255, g: 200, b: 150 }, colorTemInKelvin: 2700 } })]);
  assert.deepEqual(await net.driver.state(LAMP), { reachable: true, on: false, brightness: 12, colorRgb: null, colorTempK: 2700 });
});

test('govee-lan: changes become turn, colorwc and brightness commands on port 4003', async () => {
  const net = fakeNetwork([lamp()]);
  await net.driver.set(LAMP, { on: true, brightness: 45, colorRgb: 0x10ff20 });
  await net.driver.set(LAMP, { colorTempK: 12000, brightness: 0 });
  const cmds = net.sent.filter((m) => m.port === 4003 && m.cmd !== 'devStatus').map((m) => [m.cmd, m.data]);
  assert.deepEqual(cmds, [
    ['turn', { value: 1 }],
    ['colorwc', { color: { r: 16, g: 255, b: 32 }, colorTemInKelvin: 0 }],
    ['brightness', { value: 45 }],
    ['colorwc', { color: { r: 0, g: 0, b: 0 }, colorTemInKelvin: 9000 }],
    ['brightness', { value: 1 }],
  ]);
  assert.equal((await net.driver.state(LAMP)).colorTempK, 9000);
});

test('govee-lan: a lamp that stays silent (off at the switch, or LAN Control off) is unreachable', async () => {
  const net = fakeNetwork([lamp({ lan: false })]);
  assert.deepEqual(await net.driver.state(LAMP), { reachable: false, error: 'lanSilent' });
  await assert.rejects(net.driver.set(LAMP, { on: true }), (e) => e instanceof DeviceError && /Lamp: no answer on the LAN/.test(e.message));
  // not rescanned at every poll: one scan per network card, then nothing for 30 s
  await net.driver.state(LAMP);
  assert.equal(net.scans(), 2);
});

test('govee-lan: a lamp declared by IP is asked directly, and scanned at that address', async () => {
  const net = fakeNetwork([lamp({ ip: '192.0.2.11' })]);
  const byIp = { id: 'desk', name: 'Desk lamp', ip: '192.0.2.11' };
  assert.equal((await net.driver.state(byIp)).reachable, true);
  assert.equal(net.sent.some((m) => m.cmd === 'scan'), false, 'its address is known: no scan needed');
});

test('govee-lan: a lamp that stops answering is forgotten, so a new IP is picked up', async () => {
  const l = lamp();
  const net = fakeNetwork([l]);
  assert.equal((await net.driver.state(LAMP)).reachable, true);
  l.lan = false;
  assert.equal((await net.driver.state(LAMP)).reachable, false);
});

test('govee-lan: list gives the lamps seen on the network, to fill the config', async () => {
  const net = fakeNetwork([lamp(), lamp({ ip: '192.0.2.12', device: '00:00:5E:00:53:02:00:02' }), lamp({ ip: '192.0.2.13', device: '00:00:5E:00:53:03:00:03', lan: false })]);
  assert.deepEqual(await net.driver.list(), [
    { driver: 'govee-lan', device: '00:00:5E:00:53:01:00:01', ip: '192.0.2.10', sku: 'H0000' },
    { driver: 'govee-lan', device: '00:00:5E:00:53:02:00:02', ip: '192.0.2.12', sku: 'H0000' },
  ]);
});

test('govee-lan: port 4002 already taken is a DeviceError, not a crash', async () => {
  const sock = new EventEmitter();
  sock.bind = () => queueMicrotask(() => sock.emit('error', new Error('bind EADDRINUSE 0.0.0.0:4002')));
  const driver = goveeLan.create({ socket: () => sock, addresses: () => [], timeoutMs: 20 });
  await assert.rejects(driver.state(LAMP), (e) => e instanceof DeviceError && /EADDRINUSE/.test(e.message));
});

test('govee-lan: anything that is not a Govee answer on the port is ignored', async () => {
  const net = fakeNetwork([lamp()]);
  await net.driver.state(LAMP);
  net.sock.emit('message', Buffer.from('not json'), { address: '192.0.2.99', port: 1234 });
  net.sock.emit('message', Buffer.from('{"msg":{"cmd":"scan"}}'), { address: '192.0.2.99', port: 1234 });
  assert.equal((await net.driver.state(LAMP)).reachable, true);
});

/* ================= Govee, cloud fallback ================= */
test('govee-cloud: state and commands go through the cloud API with the key', async () => {
  const calls = [];
  const fetchImpl = async (url, opts) => {
    calls.push({ url, key: opts.headers['Govee-API-Key'], body: opts.body ? JSON.parse(opts.body).payload : null });
    const body = url.endsWith('/device/state')
      ? { code: 200, payload: { capabilities: [{ instance: 'powerSwitch', state: { value: 1 } }, { instance: 'brightness', state: { value: 30 } }, { instance: 'colorRgb', state: { value: 255 } }, { instance: 'colorTemperatureK', state: { value: 0 } }] } }
      : { code: 200 };
    return new Response(JSON.stringify(body), { status: 200 });
  };
  const driver = goveeCloud.create({ apiKey: 'test-key', fetch: fetchImpl });
  const device = { name: 'Lamp', sku: 'H0000', device: '00:00:5E:00:53:01:00:01' };
  assert.deepEqual(await driver.state(device), { reachable: true, on: true, brightness: 30, colorRgb: 255, colorTempK: null });
  await driver.set(device, { on: false, colorTempK: 3000 });
  assert.deepEqual(calls.slice(1).map((c) => [c.body.capability.instance, c.body.capability.value]), [['powerSwitch', 0], ['colorTemperatureK', 3000]]);
  assert.ok(calls.every((c) => c.key === 'test-key'));
});

test('daikin: demand control is offered by a unit that has it, read and set as off, auto or a ceiling', async () => {
  const withDemand = { '/aircon/get_model_info': MODEL + ',dmnd=1', '/aircon/get_demand_control': 'ret=OK,type=1,en_demand=1,mode=0,max_pow=70,scdl_per_day=4,moc=0,tuc=0,wec=0,thc=0,frc=0,sac=0,suc=0', '/aircon/set_demand_control': 'ret=OK' };
  const unit = fakeUnit(withDemand), device = { id: 'ac', name: 'AC', ip: '192.0.2.20' };
  const caps = await unit.driver.capabilities(device);
  assert.deepEqual([caps.demand, caps.demandMax], [{ options: ['off', 'auto', 'manual'] }, { min: 40, max: 100, step: 5 }]);
  const state = await unit.driver.state(device);
  assert.deepEqual([state.demand, state.demandMax], ['manual', 70]);
  assert.equal(unit.calls.filter((c) => c === '/aircon/get_model_info').length, 1, 'the model is asked once, even by two questions at a time');
  await unit.driver.set(device, { demand: 'auto' });
  assert.deepEqual(sent(unit.calls, '/aircon/set_demand_control'), { type: '1', en_demand: '1', mode: '2', max_pow: '70' });
  unit.calls.length = 0;
  await unit.driver.set(device, { demandMax: 52 });
  assert.deepEqual(sent(unit.calls, '/aircon/set_demand_control'), { type: '1', en_demand: '1', mode: '0', max_pow: '50' }, 'a ceiling is a manual limit, by steps of 5');
  unit.calls.length = 0;
  await unit.driver.set(device, { demand: 'off' });
  assert.deepEqual(sent(unit.calls, '/aircon/set_demand_control'), { type: '1', en_demand: '0' });
  // off on the unit, and a unit without the feature
  assert.equal((await fakeUnit({ ...withDemand, '/aircon/get_demand_control': 'ret=OK,type=1,en_demand=0,mode=2,max_pow=100' }).driver.state(device)).demand, 'off');
  const plain = fakeUnit();
  assert.equal('demand' in await plain.driver.capabilities(device), false);
  assert.equal('demand' in await plain.driver.state(device), false);
  assert.ok(!plain.calls.includes('/aircon/get_demand_control'), 'a unit that does not announce it is not asked');
  // announced by the model but refused by the firmware: no control rather than a broken one
  assert.equal('demand' in await fakeUnit({ '/aircon/get_model_info': MODEL + ',dmnd=1' }).driver.capabilities(device), false);
});

test('govee-cloud: scenes, DIY scenes and music modes come from the lists of the cloud and go back as given', async () => {
  const calls = [];
  let clock = 0;
  const lamp = { name: 'Lamp', sku: 'H0000', device: '00:00:5E:00:53:01:00:01' };
  const fetchImpl = async (url, opts = {}) => {
    const body = opts.body ? JSON.parse(opts.body).payload : null, route = url.replace(/^.*\/v1/, '');
    calls.push([route, body && body.capability]);
    const answers = {
      '/device/state': { code: 200, payload: { capabilities: [{ instance: 'online', state: { value: true } }, { instance: 'powerSwitch', state: { value: 1 } }, { instance: 'brightness', state: { value: 30 } }, { instance: 'colorRgb', state: { value: 255 } }] } },
      '/device/scenes': { code: 200, payload: { capabilities: [{ type: 'devices.capabilities.dynamic_scene', instance: 'lightScene', parameters: { dataType: 'ENUM', options: [{ name: 'Sunrise', value: { paramId: 4280, id: 3853 } }, { name: 'Sunset', value: { paramId: 4281, id: 3854 } }, { name: 'Sunrise', value: { paramId: 1, id: 1 } }] } }] } },
      '/device/diy-scenes': { code: 200, payload: { capabilities: [{ type: 'devices.capabilities.diy_color_setting', instance: 'diyScene', parameters: { dataType: 'ENUM', options: [{ name: 'Mine', value: 8216930 }] } }] } },
      '/user/devices': { code: 200, data: [{ sku: 'H0000', device: lamp.device, deviceName: 'Lamp', capabilities: [{ type: 'devices.capabilities.music_setting', instance: 'musicMode', parameters: { dataType: 'STRUCT', fields: [
        { fieldName: 'musicMode', dataType: 'ENUM', options: [{ name: 'Energic', value: 5 }, { name: 'Rhythm', value: 3 }] }, { fieldName: 'sensitivity', dataType: 'INTEGER' }] } }] }] },
      '/device/control': { code: 200 },
    };
    return new Response(JSON.stringify(answers[route]), { status: 200 });
  };
  const driver = goveeCloud.create({ apiKey: 'k', fetch: fetchImpl, now: () => clock });
  const caps = await driver.capabilities(lamp);
  assert.deepEqual([caps.scene, caps.diy, caps.music], [{ options: ['Sunrise', 'Sunset'] }, { options: ['Mine'] }, { options: ['Energic', 'Rhythm'] }]);
  await driver.capabilities(lamp);
  assert.equal(calls.length, 3, 'the lists are asked once, not at every reading');
  await driver.set(lamp, { scene: 'Sunset' });
  assert.deepEqual(calls.pop()[1], { type: 'devices.capabilities.dynamic_scene', instance: 'lightScene', value: { paramId: 4281, id: 3854 } });
  assert.equal((await driver.state(lamp)).scene, 'Sunset', 'the cloud does not say what plays: the last scene asked for is remembered');
  await driver.set(lamp, { diy: 'Mine' });
  assert.deepEqual(calls.pop()[1], { type: 'devices.capabilities.diy_color_setting', instance: 'diyScene', value: 8216930 }, 'sent back with the type the list gave');
  await driver.set(lamp, { music: 'Rhythm' });
  assert.deepEqual(calls.pop()[1].value, { musicMode: 3, sensitivity: 50, autoColor: 1 });
  await driver.set(lamp, { colorRgb: 0xff0000 });
  const plain = await driver.state(lamp);
  assert.ok(!('scene' in plain) && !('music' in plain) && !('diy' in plain), 'a plain color ends the effect');
  await assert.rejects(driver.set(lamp, { scene: 'Nope' }), /no such scene/);
  // as little as possible goes to Govee: the state once a minute, whatever the page asks
  await driver.state(lamp);
  calls.length = 0;
  for (let i = 0; i < 5; i++) { await driver.state(lamp); clock += 10000; }
  assert.equal(calls.filter((c) => c[0] === '/device/state').length, 0, 'read after the last command: nothing more for a minute');
  clock += 20000;
  await driver.state(lamp);
  assert.equal(calls.filter((c) => c[0] === '/device/state').length, 1);
  // a list that fails leaves the lamp its plain controls
  const bare = goveeCloud.create({ apiKey: 'k', fetch: async (url) => new Response(JSON.stringify(url.endsWith('/state') ? { code: 200, payload: { capabilities: [] } } : { code: 500, msg: 'down' }), { status: 500 }) });
  assert.deepEqual(Object.keys(await bare.capabilities(lamp)), ['on', 'brightness', 'colorRgb', 'colorTempK']);
});

test('govee-cloud: a lamp the cloud has lost is unreachable, whatever the cloud remembers of it', async () => {
  // what Govee answers for a lamp switched off at the wall: offline, and its last values (on, 60 %)
  const answer = (online) => ({ code: 200, payload: { capabilities: [
    { type: 'devices.capabilities.online', instance: 'online', state: { value: online } },
    { type: 'devices.capabilities.on_off', instance: 'powerSwitch', state: { value: 1 } },
    { type: 'devices.capabilities.range', instance: 'brightness', state: { value: 60 } },
  ] } });
  const lamp = { sku: 'H0000', device: '00:00:5E:00:53:01:00:01' };
  const off = goveeCloud.create({ apiKey: 'k', fetch: async () => new Response(JSON.stringify(answer(false)), { status: 200 }) });
  assert.deepEqual(await off.state(lamp), { reachable: false, error: 'cloudOffline' });
  const on = goveeCloud.create({ apiKey: 'k', fetch: async () => new Response(JSON.stringify(answer(true)), { status: 200 }) });
  assert.deepEqual(await on.state(lamp), { reachable: true, on: true, brightness: 60, colorRgb: null, colorTempK: null });
});

test('govee-cloud: a refusal carries the reason given by Govee', async () => {
  const driver = goveeCloud.create({ apiKey: 'k', fetch: async () => new Response(JSON.stringify({ code: 429, msg: 'Too many requests' }), { status: 429 }) });
  await assert.rejects(driver.state({ sku: 'H0000', device: 'x' }), (e) => e instanceof DeviceError && e.message === 'Govee: Too many requests');
});

/* ================= Cozytouch (Overkiz) ================= */
const RAIL_URL = 'io://0000-0000-0000/1234567#1';
const cmd = (commandName) => ({ commandName, nparams: 1 });
const SETUP = {
  devices: [
    {
      deviceURL: RAIL_URL, label: 'Towel rail', widget: 'AtlanticElectricalTowelDryer',
      definition: { commands: ['setTowelDryerOperatingMode', 'setTargetTemperature', 'setDerogatedTargetTemperature', 'setTowelDryerTemporaryState', 'setOpenWindowDetectionActivation', 'setTowelDryerTimeProgram'].map(cmd) },
      states: [{ name: 'core:OperatingModeState', value: 'external' }, { name: 'core:OpenWindowDetectionActivationState', value: 'on' }],
    },
    { deviceURL: 'io://0000-0000-0000/1234567#7', label: 'Towel rail probe', widget: 'TemperatureSensor', definition: { commands: [] }, states: [] },
  ],
};
const PROGRAM = [{ monday: [{ start: { hour: 6, minute: 30 }, end: { hour: 8, minute: 0 } }] }];
const railStates = (over = {}) => Object.entries({
  'core:OperatingModeState': 'external', 'core:TargetTemperatureState': 21, 'io:EffectiveTemperatureSetpointState': 19,
  'io:TowelDryerTemporaryStateState': 'permanentHeating', 'core:OpenWindowDetectionActivationState': 'on', 'core:TimeProgramState': PROGRAM, ...over,
}).map(([name, value]) => ({ name, value }));

// The three Cozytouch hosts, with a session that can be made to expire.
function fakeCloud({ states = railStates(), password = 'secret' } = {}) {
  const calls = [];
  const cloud = { calls, sessions: 0, expired: false };
  cloud.fetch = async (url, opts = {}) => {
    const u = new URL(url);
    const body = opts.body && (opts.headers['content-type'] === 'application/json' ? JSON.parse(opts.body) : Object.fromEntries(new URLSearchParams(opts.body)));
    calls.push({ method: opts.method || 'GET', path: u.host + u.pathname, headers: opts.headers || {}, body });
    const json = (o, status = 200, headers = {}) => new Response(typeof o === 'string' ? o : JSON.stringify(o), { status, headers });
    if (u.pathname === '/token') return body.password === password ? json({ token_type: 'bearer', access_token: 'atlantic-token' }) : json({ error: 'invalid_grant', error_description: 'bad' }, 400);
    if (u.pathname === '/magellan/accounts/jwt') return json('"the-jwt"');
    if (u.pathname.endsWith('/login')) { cloud.sessions++; return json({ success: true }, 200, { 'set-cookie': `JSESSIONID=session-${cloud.sessions}; Path=/; HttpOnly` }); }
    if (cloud.expired) { cloud.expired = false; return json({ error: 'Not authenticated' }, 401); }
    if (u.pathname.endsWith('/setup')) return json(SETUP);
    if (u.pathname.endsWith('/states')) return json(decodeURIComponent(u.pathname).includes('#7') ? [{ name: 'core:TemperatureState', value: 22.4 }] : states);
    if (u.pathname.endsWith('/exec/apply')) return json({ execId: 'exec-1' });
    return json({ error: 'not found' }, 404);
  };
  cloud.driver = cozytouch.create({ username: 'user@example.com', password: 'secret', fetch: cloud.fetch });
  return cloud;
}
const RAIL = { id: 'rail', name: 'Towel rail', deviceURL: RAIL_URL };

test('cozytouch: login takes a token, a JWT, then an Overkiz session reused afterwards', async () => {
  const cloud = fakeCloud();
  await cloud.driver.state(RAIL);
  const [token, jwt, login, setup] = cloud.calls;
  assert.equal(token.path, 'apis.groupe-atlantic.com/token');
  assert.match(token.headers.authorization, /^Basic /);
  assert.deepEqual(token.body, { grant_type: 'password', username: 'GA-PRIVATEPERSON/user@example.com', password: 'secret' });
  assert.deepEqual([jwt.path, jwt.headers.authorization], ['apis.groupe-atlantic.com/magellan/accounts/jwt', 'Bearer atlantic-token']);
  assert.deepEqual([login.path, login.body], ['ha110-1.overkiz.com/enduser-mobile-web/enduserAPI/login', { jwt: 'the-jwt' }]);
  assert.equal(setup.headers.cookie, 'JSESSIONID=session-1');
  await cloud.driver.capabilities(RAIL);
  assert.equal(cloud.sessions, 1);
});

test('cozytouch: the states of the heater and of its probe are read into the service vocabulary', async () => {
  const s = await fakeCloud().driver.state(RAIL);
  assert.deepEqual(s, { reachable: true, on: true, mode: 'manual', setpoint: 21, temperature: 22.4, boost: false, drying: false, windowDetection: true, schedule: PROGRAM });
});

test('cozytouch: off, weekly program and auto modes, and the setpoint in force in auto', () => {
  const read = (over) => cozytouch.normalize(Object.fromEntries(railStates(over).map((s) => [s.name, s.value])));
  assert.deepEqual([read({ 'core:OperatingModeState': 'standby' }).mode, read({ 'core:OperatingModeState': 'standby' }).on], ['off', false]);
  assert.equal(read({ 'core:OperatingModeState': 'internal' }).mode, 'schedule');
  assert.deepEqual([read({ 'core:OperatingModeState': 'auto' }).mode, read({ 'core:OperatingModeState': 'auto' }).setpoint], ['auto', 19]);
  assert.equal(read({ 'io:TowelDryerTemporaryStateState': 'boost' }).boost, true);
  assert.equal(read({ 'io:TowelDryerTemporaryStateState': 'drying' }).drying, true);
});

test('cozytouch: capabilities follow the commands the heater declares', () => {
  assert.deepEqual(Object.keys(cozytouch.capabilitiesOf(SETUP.devices[0])), ['on', 'mode', 'setpoint', 'boost', 'drying', 'windowDetection', 'schedule']);
  const plain = { definition: { commands: [cmd('setTowelDryerOperatingMode'), cmd('setTargetTemperature')] }, states: [] };
  assert.deepEqual(Object.keys(cozytouch.capabilitiesOf(plain)), ['on', 'mode', 'setpoint']);
});

test('cozytouch: changes become Overkiz commands', () => {
  const manual = { 'core:OperatingModeState': 'external', 'core:OpenWindowDetectionActivationState': 'on' };
  const names = (changes, states = manual) => cozytouch.commandsFor(changes, states).map((c) => [c.name, c.parameters[0]]);
  assert.deepEqual(names({ mode: 'schedule' }), [['setTowelDryerOperatingMode', 'internal']]);
  assert.deepEqual(names({ on: false }), [['setTowelDryerOperatingMode', 'standby']]);
  assert.deepEqual(names({ on: true }), [], 'already on: nothing to send');
  assert.deepEqual(names({ on: true }, { 'core:OperatingModeState': 'standby' }), [['setTowelDryerOperatingMode', 'external']]);
  assert.deepEqual(names({ setpoint: 22.5 }), [['setTargetTemperature', 22.5]]);
  assert.deepEqual(names({ setpoint: 22.5 }, { 'core:OperatingModeState': 'auto' }), [['setDerogatedTargetTemperature', 22.5]], 'in auto the program is overridden, not rewritten');
  assert.deepEqual(names({ boost: true }), [['setTowelDryerTemporaryState', 'boost']]);
  assert.deepEqual(names({ boost: false }), [['setTowelDryerTemporaryState', 'permanentHeating']]);
  assert.deepEqual(names({ drying: true }), [['setTowelDryerTemporaryState', 'drying']]);
  assert.deepEqual(names({ windowDetection: false }), [['setOpenWindowDetectionActivation', 'off']]);
  assert.deepEqual(names({ windowDetection: true }, { 'core:OpenWindowDetectionActivationState': 'inactive' }), [['setOpenWindowDetectionActivation', 'active']]);
  assert.deepEqual(names({ schedule: PROGRAM }), [['setTowelDryerTimeProgram', PROGRAM]]);
});

test('cozytouch: a command is applied on the device, through exec/apply', async () => {
  const cloud = fakeCloud();
  await cloud.driver.set(RAIL, { boost: true, setpoint: 23 });
  const exec = cloud.calls.find((c) => c.path.endsWith('/exec/apply'));
  assert.equal(exec.method, 'POST');
  assert.deepEqual(exec.body.actions, [{ deviceURL: RAIL_URL, commands: [{ name: 'setTargetTemperature', parameters: [23] }, { name: 'setTowelDryerTemporaryState', parameters: ['boost'] }] }]);
});

test('cozytouch: an expired session logs in again once and repeats the call', async () => {
  const cloud = fakeCloud();
  await cloud.driver.state(RAIL);
  cloud.expired = true;
  await cloud.driver.set(RAIL, { boost: true });
  assert.equal(cloud.sessions, 2);
  assert.equal(cloud.calls.filter((c) => c.path.endsWith('/exec/apply')).at(-1).headers.cookie, 'JSESSIONID=session-2');
});

test('cozytouch: wrong credentials, or a heater missing from the account, are DeviceErrors', async () => {
  const wrong = fakeCloud({ password: 'other' });
  await assert.rejects(wrong.driver.state(RAIL), (e) => e instanceof DeviceError && e.message === 'Cozytouch: wrong email or password');
  await assert.rejects(fakeCloud().driver.state({ name: 'Radiator', label: 'Nowhere' }), (e) => e instanceof DeviceError && /Radiator: not found/.test(e.message));
});

test('cozytouch: list gives the devices of the account, to fill the config', async () => {
  assert.deepEqual((await fakeCloud().driver.list())[0], { driver: 'cozytouch', deviceURL: RAIL_URL, label: 'Towel rail', widget: 'AtlanticElectricalTowelDryer' });
});
