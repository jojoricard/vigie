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
