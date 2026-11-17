// The modules of the house service: the Freebox, the TaHoma box and MQTT on answers
// written for the tests (no box, no broker, no network), the relay to a service running
// elsewhere, and where each module stands.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const http = require('http');
const net = require('net');
const path = require('path');
const crypto = require('crypto');
const freebox = require('../house/drivers/freebox');
const tahoma = require('../house/drivers/tahoma-local');
const mqtt = require('../house/mqtt');
const mqttDriver = require('../house/drivers/mqtt');
const { createService } = require('../house/service');
const { handler, relay, mount, moduleList, buildDrivers, buildHome, withEnv } = require('../house/server');
const { DeviceError } = require('../house/util');

const json = (body, status = 200) => ({ status, ok: status < 400, text: async () => JSON.stringify(body), headers: new Map() });
const listen = (server) => new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));

/* ---------- Freebox ---------- */
test('freebox: a session password is the challenge signed with the token of the application', () => {
  // the two examples published with the API, token and challenge in, password out
  assert.equal(freebox.sign('89vtuOaDxJ/TDeBDPgWSk9083SbQgEMnHdIGoHg2qK2tpWcLuiRofIjuxZSG8yJn', 'drMHV/Atq4ZTtFItdgqfklDdT75k92qE'), 'b4015852c9216f99f4ba20964b21c010bb779d99');
  assert.equal(freebox.sign('89vtuOaDxJ/TDeBDPgWSk9083SbQgEMnHdIGoHg2qK2tpWcLuiRofIjuxZSG8yJn', 'lmvoOr2CNRVjePm+jtxY99ENTWGX/Tzs'), '228eea552e159d4bd223b2a0afbe0e1d8effaf70');
});

test('freebox: someone is home when one of their devices is on the network, or was a moment ago', () => {
  const now = 1.8e12, sec = (ms) => Math.round(ms / 1000);
  const hosts = [
    { l2ident: { id: '00:00:5E:00:53:01', type: 'mac_address' }, active: true, last_activity: sec(now) },
    { l2ident: { id: '00:00:5E:00:53:02', type: 'mac_address' }, active: false, last_activity: sec(now - 4 * 60000) },
    { l2ident: { id: '00:00:5E:00:53:03', type: 'mac_address' }, active: false, last_activity: sec(now - 3 * 3600e3) },
  ];
  const people = [
    { id: 'a', name: 'Alex', devices: ['00:00:5e:00:53:01'] },                       // lower case in the config: the same device
    { id: 's', name: 'Sam', devices: ['00-00-5E-00-53-02'] },                        // asleep on Wi-Fi for four minutes
    { id: 'j', name: 'Jo', devices: ['00:00:5E:00:53:03', '00:00:5E:00:53:99'] },    // gone for hours, and a device the box never saw
  ];
  assert.deepEqual(freebox.presence(people, hosts, now).map((p) => [p.name, p.home]), [['Alex', true], ['Sam', true], ['Jo', false]]);
  assert.deepEqual(freebox.presence([], hosts, now), []);
});

test('freebox: the last outage is the latest "down" of the log and the "up" that followed', () => {
  const logs = [{ type: 'conn', state: 'up', date: 1000 }, { type: 'conn', state: 'down', date: 5000 }, { type: 'conn', state: 'up', date: 5240 }, { type: 'link', state: 'up', date: 5241 }];
  assert.deepEqual(freebox.lastOutage(logs), { at: 5000000, minutes: 4 });
  assert.deepEqual(freebox.lastOutage([...logs, { type: 'conn', state: 'down', date: 9000 }]), { at: 9000000, minutes: null }, 'still down: no duration yet');
  assert.equal(freebox.lastOutage([{ type: 'conn', state: 'up', date: 1 }]), null);
  assert.equal(freebox.lastOutage(null), null);
});

// A Freebox that answers the four questions the driver asks, and counts the logins.
function fakeBox({ token = 'app-token', expire = false, connection = () => ({}) } = {}) {
  const seen = { logins: 0, calls: [] };
  let session = null, expired = expire;
  const fetchImpl = async (url, opts = {}) => {
    const u = new URL(url), route = u.pathname.replace(/^\/api\/v\d+/, ''), auth = opts.headers && opts.headers['X-Fbx-App-Auth'];
    seen.calls.push(`${opts.method || 'GET'} ${u.pathname}`);
    if (u.pathname === '/api_version') return json({ api_version: '12.1', api_base_url: '/api/' });
    if (route === '/login/' && (opts.method || 'GET') === 'GET') return json({ success: true, result: { logged_in: false, challenge: 'the-challenge' } });
    if (route === '/login/session/') {
      const body = JSON.parse(opts.body);
      if (body.password !== freebox.sign(token, 'the-challenge')) return json({ success: false, error_code: 'invalid_token', msg: 'wrong password' }, 403);
      session = `session-${++seen.logins}`;
      return json({ success: true, result: { session_token: session } });
    }
    if (auth !== session || (expired && seen.logins < 2 && !(expired = false))) return json({ success: false, error_code: 'auth_required', msg: 'log in again' }, 403);
    if (route === '/connection/') return json({ success: true, result: { state: 'up', media: 'ftth', rate_down: 125000, rate_up: 20000, bandwidth_down: 1e9, bandwidth_up: 7e8, ...connection() } });
    if (route === '/lan/browser/pub/') return json({ success: true, result: [{ primary_name: 'phone', l2ident: { id: '00:00:5E:00:53:01', type: 'mac_address' }, active: true, last_activity: 1,
      l3connectivities: [{ addr: '2001:db8::1', af: 'ipv6', active: true }, { addr: '192.0.2.50', af: 'ipv4', active: false }, { addr: '192.0.2.51', af: 'ipv4', active: true }] }] });
    if (route === '/connection/logs/') return json({ success: true, result: [{ type: 'conn', state: 'down', date: 100 }, { type: 'conn', state: 'up', date: 400 }] });
    return json({ success: false, msg: 'unknown' }, 404);
  };
  return { fetchImpl, seen };
}

test('freebox: who is in and how the line is doing, with one login for many questions', async () => {
  const box = fakeBox(), clock = { t: 1.8e12 };
  const driver = freebox.create({ appToken: 'app-token', people: [{ id: 'a', name: 'Alex', devices: ['00:00:5E:00:53:01'] }], fetchImpl: box.fetchImpl, now: () => clock.t });
  const home = await driver.home();
  assert.deepEqual(home.presence.map((p) => [p.name, p.home]), [['Alex', true]]);
  assert.deepEqual(home.network, { state: 'up', media: 'ftth', rateDown: 125000, rateUp: 20000, bandwidthDown: 1e9, bandwidthUp: 7e8, lastOutage: { at: 100000, minutes: 5 } });
  assert.ok(box.seen.calls.includes('GET /api/v12/connection/'), 'the version of the API is the one the box announces');
  await driver.home();
  assert.equal(box.seen.calls.filter((c) => c.endsWith('/connection/')).length, 1, 'asked again within half a minute: the same answer, no request');
  clock.t += 60000;
  await driver.home();
  assert.equal(box.seen.logins, 1, 'the session is kept between two readings');
  assert.deepEqual(await driver.list(), [{ name: 'phone', mac: '00:00:5E:00:53:01', active: true, ip: '192.0.2.51' }], 'the list for the config gives the IPv4 address in use');
});

/* What a fibre Freebox answers on /connection/ (the fields of Freebox OS, the figures made
   up): rate_* a reading of the moment in bytes a second, bandwidth_* in bits a second, and
   bytes_* counted since the line came up. Here the PC pulls 1.8 MB/s while the moment's
   reading, taken between two bursts, says 8.8 kB/s. */
test('freebox: the rate of the line comes from its counters, read half a minute apart, in bytes a second', async () => {
  const clock = { t: 1.8e12 }, counted = { down: 412_884_201_550, up: 38_115_002_118 };
  const box = fakeBox({ connection: () => ({ type: 'ethernet', media: 'ftth', ipv4: '192.0.2.1', rate_down: 8792, rate_up: 4682,
    bandwidth_down: 8_000_000_000, bandwidth_up: 8_000_000_000, bytes_down: counted.down, bytes_up: counted.up }) });
  const driver = freebox.create({ appToken: 'app-token', fetchImpl: box.fetchImpl, now: () => clock.t });
  let net = (await driver.home()).network;
  assert.deepEqual([net.rateDown, net.rateUp], [8792, 4682], 'first reading: what the box reads at that moment');
  clock.t += 30_000; counted.down += 54_000_000; counted.up += 2_400_000;
  net = (await driver.home()).network;
  assert.deepEqual([net.rateDown, net.rateUp], [1_800_000, 80_000], '54 MB in 30 s is 1.8 MB/s, as the network card of the PC says');
  assert.equal(Math.round((net.rateDown * 8) / 1e6 * 10) / 10, 14.4, 'shown as 14.4 Mb/s');
  assert.equal(net.bandwidthDown, 8e9, 'the bandwidth stays in bits a second');
  // the line came up again: the counters start over, the moment's reading stands in
  clock.t += 30_000; counted.down = 1_000; counted.up = 500;
  net = (await driver.home()).network;
  assert.deepEqual([net.rateDown, net.rateUp], [8792, 4682]);
});

test('freebox: the rate of the line, pure', () => {
  const prev = { at: 0, down: 1000, up: 100 };
  assert.deepEqual(freebox.lineRate(prev, { bytes_down: 61000, bytes_up: 700, rate_down: 5, rate_up: 6 }, 30000), { rateDown: 2000, rateUp: 20, counters: { at: 30000, down: 61000, up: 700 } });
  assert.deepEqual(freebox.lineRate(prev, { rate_down: 5, rate_up: 6 }, 30000), { rateDown: 5, rateUp: 6, counters: null }, 'no counters: the moment');
  assert.equal(freebox.lineRate(prev, { bytes_down: 61000, bytes_up: 700, rate_down: 5 }, 1000).rateDown, 5, 'too close to divide');
  assert.equal(freebox.lineRate(prev, { bytes_down: 61000, bytes_up: 700, rate_down: 5 }, 3_600_000).rateDown, 5, 'an hour old: not what goes through now');
});

test('freebox: a session that ended is opened again, a box never paired says how to pair it', async () => {
  const box = fakeBox({ expire: true });
  const driver = freebox.create({ appToken: 'app-token', fetchImpl: box.fetchImpl });
  assert.equal((await driver.home()).network.state, 'up');
  assert.equal(box.seen.logins, 2);
  await assert.rejects(freebox.create({ fetchImpl: box.fetchImpl }).home(), (e) => e instanceof DeviceError && /pair-freebox/.test(e.message));
  await assert.rejects(freebox.create({ appToken: 'wrong', fetchImpl: fakeBox().fetchImpl }).home(), DeviceError);
});

test('freebox: pairing waits for the press on the box and gives the token to keep', async () => {
  let polls = 0;
  const fetchImpl = async (url, opts = {}) => {
    const p = new URL(url).pathname;
    if (p === '/api_version') return json({ api_version: '8.0', api_base_url: '/api/' });
    if (p.endsWith('/login/authorize/') && opts.method === 'POST') { assert.equal(JSON.parse(opts.body).app_id, 'fr.vigie.house'); return json({ success: true, result: { app_token: 'new-token', track_id: 42 } }); }
    if (p.endsWith('/login/authorize/42')) return json({ success: true, result: { status: ++polls < 3 ? 'pending' : 'granted' } });
    return json({ success: false }, 404);
  };
  let prompted = 0;
  const token = await freebox.create({ fetchImpl }).pair({ onPrompt: () => prompted++, wait: async () => {} });
  assert.deepEqual([token, prompted, polls], ['new-token', 1, 3]);
  const denied = async (url, opts = {}) => new URL(url).pathname.endsWith('/42') ? json({ success: true, result: { status: 'denied' } }) : fetchImpl(url, opts);
  await assert.rejects(freebox.create({ fetchImpl: denied }).pair({ wait: async () => {} }), /refused on the box/);
});

/* ---------- TaHoma ---------- */
test('tahoma: the authority of the box is the one shipped, and TLS is never switched off', () => {
  const cert = new crypto.X509Certificate(tahoma.CA);
  assert.match(cert.subject, /CN=Overkiz Root CA/);
  assert.ok(cert.ca && cert.verify(cert.publicKey), 'a root authority, signed by itself');
  assert.equal(cert.fingerprint256, 'BB:FA:96:11:1E:AE:15:E3:C6:ED:15:F3:43:27:6C:0C:27:26:03:2E:A1:9D:F5:BB:D0:67:E2:F1:CF:FC:44:DB');
  assert.ok(new Date(cert.validTo) > new Date('2030-01-01'));
  const source = fs.readFileSync(path.join(__dirname, '..', 'house', 'drivers', 'tahoma-local.js'), 'utf8');
  assert.ok(!/rejectUnauthorized\s*:\s*false/.test(source) && !/NODE_TLS_REJECT_UNAUTHORIZED/.test(source), 'no way around the certificate');
  assert.match(source, /ca: CA/);
});

test('tahoma: the box counts the closure, the service how open a shutter is', () => {
  const states = (closure, extra = []) => ({ states: [{ name: 'core:ClosureState', value: closure }, ...extra] });
  assert.deepEqual(tahoma.normalize(states(0)), { reachable: true, position: 100 }, 'closure 0 on the box: fully open');
  assert.deepEqual(tahoma.normalize(states(100)), { reachable: true, position: 0 }, 'closure 100: closed');
  assert.equal(tahoma.normalize(states(30)).position, 70);
  assert.deepEqual(tahoma.normalize({ states: [] }), { reachable: true, position: null }, 'a motor without feedback: moves, but no position');
  assert.equal(tahoma.normalize(states(0, [{ name: 'core:StatusState', value: 'unavailable' }])).reachable, false);
});

// A TaHoma box in memory: its devices, a listener, and the events it has in store.
function fakeTahoma() {
  const box = { calls: [], events: [], listeners: 0, drop: false, token: 'good' };
  const setup = [
    { deviceURL: 'io://1234-5678-9012/1', label: 'Living room', controllableName: 'io:RollerShutterGenericIOComponent', available: true,
      definition: { commands: ['open', 'close', 'stop', 'my', 'setClosure'].map((commandName) => ({ commandName })) }, states: [{ name: 'core:ClosureState', value: 100 }] },
    { deviceURL: 'rts://1234-5678-9012/2', label: 'Old shutter', controllableName: 'rts:RollerShutterRTSComponent', available: true,
      definition: { commands: ['open', 'close', 'stop', 'my'].map((commandName) => ({ commandName })) }, states: [] },
  ];
  box.request = async (target, method, route, body) => {
    box.calls.push(`${method} ${route}`);
    if (target.token !== box.token) return { status: 401, text: '{}' };
    if (route === '/setup/devices') return { status: 200, text: JSON.stringify(setup) };
    if (route === '/events/register') return { status: 200, text: JSON.stringify({ id: `l${++box.listeners}` }) };
    if (/^\/events\/l\d+\/fetch$/.test(route)) {
      if (box.drop) { box.drop = false; return { status: 400, text: JSON.stringify({ error: 'No registered event listener' }) }; }
      return { status: 200, text: JSON.stringify(box.events.splice(0)) };
    }
    if (route === '/exec/apply') { box.applied = body; return { status: 200, text: JSON.stringify({ execId: 'e1' }) }; }
    return { status: 404, text: '' };
  };
  return box;
}
const shutter = { id: 'living-shutter', name: 'Shutter', type: 'cover', driver: 'tahoma-local', deviceURL: 'io://1234-5678-9012/1' };

test('tahoma: a shutter moved from its wall switch is followed through the events of the box', async () => {
  const box = fakeTahoma(), clock = { t: 0 };
  const driver = tahoma.create({ host: 'gateway-1234-5678-9012.local', token: 'good', request: box.request, now: () => clock.t });
  assert.deepEqual(await driver.state(shutter), { reachable: true, position: 0 });
  assert.deepEqual(box.calls, ['GET /setup/devices', 'POST /events/register']);
  // someone presses the switch on the wall: the box says so, nobody asked through the service
  box.events.push({ name: 'DeviceStateChangedEvent', deviceURL: shutter.deviceURL, deviceStates: [{ name: 'core:ClosureState', type: 1, value: 25 }] });
  clock.t += 500;
  assert.equal((await driver.state(shutter)).position, 0, 'the box wants one fetch a second at most');
  clock.t += 600;
  assert.equal((await driver.state(shutter)).position, 75);
  // a listener the box dropped (nobody fetched for ten minutes): everything is read again
  box.drop = true;
  clock.t += 5000;
  await driver.state(shutter);
  assert.deepEqual(box.calls.slice(-3), ['POST /events/l1/fetch', 'GET /setup/devices', 'POST /events/register']);
});

test('tahoma: what a shutter can do comes from the box, and a position is sent the way the box counts', async () => {
  const box = fakeTahoma();
  const driver = tahoma.create({ host: '192.0.2.40', pin: '1234-5678-9012', token: 'good', request: box.request });
  assert.deepEqual(Object.keys(await driver.capabilities(shutter)), ['position', 'open', 'close', 'stop', 'my']);
  const rts = { ...shutter, id: 'old', deviceURL: 'rts://1234-5678-9012/2' };
  assert.deepEqual(Object.keys(await driver.capabilities(rts)), ['open', 'close', 'stop', 'my'], 'no feedback, no position');
  await driver.set(shutter, { position: 70 });
  assert.deepEqual(box.applied.actions, [{ deviceURL: shutter.deviceURL, commands: [{ name: 'setClosure', parameters: [30] }] }]);
  await driver.set(rts, { my: true });
  assert.deepEqual(box.applied.actions[0].commands, [{ name: 'my', parameters: [] }]);
  assert.deepEqual((await driver.list()).map((d) => d.label), ['Living room', 'Old shutter']);
  await assert.rejects(driver.state({ ...shutter, deviceURL: 'io://nope/9' }), /not a device of the box/);
  await assert.rejects(tahoma.create({ host: 'h', token: 'bad', request: box.request }).state(shutter), /token refused/);
});

/* ---------- MQTT ---------- */
test('mqtt: packets survive the round trip, whatever their length', () => {
  assert.deepEqual([...mqtt.lengthBytes(0)], [0]);
  assert.deepEqual([...mqtt.lengthBytes(127)], [127]);
  assert.deepEqual([...mqtt.lengthBytes(128)], [0x80, 1]);
  assert.deepEqual([...mqtt.lengthBytes(16384)], [0x80, 0x80, 1]);
  for (const size of [0, 10, 200, 20000]) {
    const frame = mqtt.publishPacket('home/sensor', 'x'.repeat(size)), back = mqtt.decode(frame);
    assert.deepEqual([back.type, back.size], [mqtt.TYPE.publish, frame.length]);
    assert.deepEqual(mqtt.parsePublish(back.flags, back.body), { topic: 'home/sensor', payload: 'x'.repeat(size) });
    assert.equal(mqtt.decode(frame.subarray(0, frame.length - 1)), null, 'half a packet waits for the rest');
  }
  const connect = mqtt.decode(mqtt.connectPacket({ clientId: 'c', username: 'u', password: 'p' }));
  assert.equal(connect.body.subarray(2, 6).toString(), 'MQTT');
  assert.equal(connect.body[7] & 0xc2, 0xc2, 'a name, a password, a clean session');
});

// The broker side of the protocol, enough for a client: CONNACK, SUBACK, and what it is told to send.
function fakeBroker({ refuse = 0 } = {}) {
  const seen = { subscribed: [], published: [], sockets: [] };
  const server = net.createServer((socket) => {
    let buffer = Buffer.alloc(0);
    seen.sockets.push(socket);
    socket.on('error', () => {});
    socket.on('data', (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      for (let p = mqtt.decode(buffer); p; p = mqtt.decode(buffer)) {
        buffer = buffer.subarray(p.size);
        if (p.type === mqtt.TYPE.connect) socket.write(Buffer.from([0x20, 2, 0, refuse]));
        else if (p.type === mqtt.TYPE.subscribe) {
          for (let at = 2; at < p.body.length;) { const n = p.body.readUInt16BE(at); seen.subscribed.push(p.body.subarray(at + 2, at + 2 + n).toString()); at += 2 + n + 1; }
          socket.write(Buffer.from([0x90, 3, p.body[0], p.body[1], 0]));
        } else if (p.type === mqtt.TYPE.publish) seen.published.push(mqtt.parsePublish(p.flags, p.body));
        else if (p.type === mqtt.TYPE.pingreq) socket.write(Buffer.from([0xd0, 0]));
      }
    });
  });
  const say = (topic, value) => { for (const s of seen.sockets) s.write(mqtt.publishPacket(topic, typeof value === 'string' ? value : JSON.stringify(value))); };
  return { server, seen, say };
}
const until = async (check) => { for (let i = 0; i < 200 && !check(); i++) await new Promise((r) => setTimeout(r, 5)); };

test('mqtt: the client connects, subscribes, hears and speaks', async () => {
  const broker = fakeBroker(), port = await listen(broker.server), heard = [];
  const client = await mqtt.open(`mqtt://127.0.0.1:${port}`, { onMessage: (topic, text) => heard.push([topic, text]) });
  await client.subscribe(['zigbee2mqtt/a', 'zigbee2mqtt/b']);
  assert.deepEqual(broker.seen.subscribed, ['zigbee2mqtt/a', 'zigbee2mqtt/b']);
  broker.say('zigbee2mqtt/a', { temperature: 20.5 });
  await until(() => heard.length);
  assert.deepEqual(heard, [['zigbee2mqtt/a', '{"temperature":20.5}']]);
  client.publish('zigbee2mqtt/a/set', '{"state":"ON"}');
  await until(() => broker.seen.published.length);
  assert.deepEqual(broker.seen.published, [{ topic: 'zigbee2mqtt/a/set', payload: '{"state":"ON"}' }]);
  client.close();
  broker.server.close();
  const refusing = fakeBroker({ refuse: 5 }), port2 = await listen(refusing.server);
  await assert.rejects(mqtt.open(`mqtt://127.0.0.1:${port2}`), (e) => e instanceof DeviceError && /refused by the broker/.test(e.message));
  refusing.server.close();
  await assert.rejects(mqtt.open('not a url'), DeviceError);
});

test('mqtt: the cycle of an appliance is read from the power its plug measures', () => {
  const { cycleStep } = mqttDriver, min = 60000;
  let c = cycleStep(null, 1, 0);
  assert.equal(c.run, 'idle');
  c = cycleStep(c, 180, 1 * min);
  assert.equal(c.run, 'running');
  c = cycleStep(c, 2, 40 * min);
  assert.equal(c.run, 'running', 'a pause between two phases is not the end');
  c = cycleStep(c, 300, 41 * min);
  c = cycleStep(c, 1, 60 * min);
  c = cycleStep(c, 1, 62 * min);
  assert.equal(c.run, 'running');
  c = cycleStep(c, 1, 63 * min);
  assert.deepEqual([c.run, c.since], ['done', 63 * min], 'three quiet minutes: the cycle has ended');
  assert.equal(cycleStep(c, 1, 100 * min).run, 'done', 'done until someone empties it');
  assert.equal(cycleStep(c, 1, 190 * min).run, 'idle', 'and forgotten after two hours');
  assert.equal(cycleStep(c, 200, 70 * min).run, 'running', 'a new cycle starts from "done" too');
  assert.equal(cycleStep(c, null, 70 * min), c, 'a message without power changes nothing');
});

test('mqtt: each type of device is read from what Zigbee2MQTT publishes, and commanded on its /set topic', async () => {
  const broker = fakeBroker(), port = await listen(broker.server), clock = { t: 1e9 };
  const driver = mqttDriver.create({ url: `mqtt://127.0.0.1:${port}`, now: () => clock.t });
  const dev = (id, type, extra = {}) => ({ id, name: id, type, driver: 'mqtt', ...extra });
  const sensor = dev('Living sensor', 'sensor'), door = dev('Door', 'contact'), sink = dev('Sink', 'leak'), plug = dev('Washer plug', 'plug'),
    wire = dev('Radiator', 'heater', { topic: 'zigbee2mqtt/kitchen-radiator' }), linky = dev('Linky', 'meter', { fields: { tariff: 'tarif_en_cours' } });
  assert.deepEqual(await driver.state(sensor), { reachable: false, error: 'no message yet' });
  for (const d of [door, sink, plug, wire, linky]) await driver.state(d);
  assert.ok(broker.seen.subscribed.includes('zigbee2mqtt/Living sensor') && broker.seen.subscribed.includes('zigbee2mqtt/kitchen-radiator') && broker.seen.subscribed.includes('zigbee2mqtt/Door/availability'));
  broker.say('zigbee2mqtt/Living sensor', { temperature: 20.4, humidity: 48, battery: 91 });
  broker.say('zigbee2mqtt/Door', { contact: false });
  broker.say('zigbee2mqtt/Sink', { water_leak: true });
  broker.say('zigbee2mqtt/Washer plug', { state: 'ON', power: 240, energy: 12.5 });
  broker.say('zigbee2mqtt/kitchen-radiator', { pilot_wire_mode: 'frost_protection' });
  broker.say('zigbee2mqtt/Linky', { apparent_power: 1840, current_summ_delivered: 15320.4, tarif_en_cours: 'HP BLEU ' });
  broker.say('zigbee2mqtt/bridge/state', 'online');       // not JSON, not ours
  await until(() => false);                               // let the messages land
  await new Promise((r) => setTimeout(r, 30));
  assert.deepEqual(await driver.state(sensor), { reachable: true, battery: 91, temperature: 20.4, humidity: 48 });
  assert.deepEqual(await driver.state(door), { reachable: true, open: true });
  assert.deepEqual(await driver.state(sink), { reachable: true, leak: true });
  assert.deepEqual(await driver.state(plug), { reachable: true, on: true, power: 240, energyKwh: 12.5, run: 'running' });
  assert.deepEqual(await driver.state(wire), { reachable: true, mode: 'frost', on: true });
  assert.deepEqual(await driver.state(linky), { reachable: true, power: 1840, index: 15320.4, tariff: 'HP BLEU' });
  // commands: a plug is switched, a pilot wire takes a mode (and "on" means comfort)
  assert.deepEqual(Object.keys(await driver.capabilities(wire)), ['on', 'mode']);
  assert.deepEqual(await driver.capabilities(sensor), {});
  await driver.set(plug, { on: false });
  await driver.set(wire, { mode: 'eco' });
  await driver.set(wire, { on: false });
  await until(() => broker.seen.published.length >= 3);
  assert.deepEqual(broker.seen.published, [
    { topic: 'zigbee2mqtt/Washer plug/set', payload: '{"state":"OFF"}' },
    { topic: 'zigbee2mqtt/kitchen-radiator/set', payload: '{"pilot_wire_mode":"eco"}' },
    { topic: 'zigbee2mqtt/kitchen-radiator/set', payload: '{"pilot_wire_mode":"off"}' },
  ]);
  await assert.rejects(driver.set(sensor, { on: true }), DeviceError);
  // the bridge says a device is gone
  broker.say('zigbee2mqtt/Door/availability', { state: 'offline' });
  await new Promise((r) => setTimeout(r, 30));
  assert.deepEqual(await driver.state(door), { reachable: false, error: 'offline' });
  driver.close();
  broker.server.close();
});

test('mqtt: a broker that is not there fails the device, not the service, and is not hammered', async () => {
  let tries = 0;
  const clock = { t: 0 };
  const driver = mqttDriver.create({ url: 'mqtt://192.0.2.1:1883', now: () => clock.t, open: async () => { tries++; throw new DeviceError('mqtt: timeout'); } });
  const service = createService({ rooms: [{ id: 'r', name: 'Room', devices: [{ id: 's', name: 'Sensor', type: 'sensor', driver: 'mqtt' }] }] }, { mqtt: driver });
  const [status, rooms] = await service.handle('GET', '/rooms');
  assert.equal(status, 200);
  assert.deepEqual(rooms[0].devices[0].state, { reachable: false, error: 'mqtt: timeout' });
  await assert.rejects(driver.state({ id: 's', name: 'Sensor', type: 'sensor' }), DeviceError);
  assert.equal(tries, 1, 'one try, then nothing for half a minute');
  clock.t += 31000;
  await assert.rejects(driver.state({ id: 's', name: 'Sensor', type: 'sensor' }), DeviceError);
  assert.equal(tries, 2);
});

/* ---------- Modules ---------- */
const rooms = [{ id: 'living', name: 'Living room', devices: [
  { id: 'ac', name: 'Air conditioner', type: 'climate', driver: 'daikin', ip: '192.0.2.20' },
  { id: 'shutter', name: 'Shutter', type: 'cover', driver: 'tahoma-local', deviceURL: 'io://1234-5678-9012/1' },
  { id: 'sensor', name: 'Thermometer', type: 'sensor', driver: 'mqtt' },
  { id: 'towel', name: 'Towel rail', type: 'heater', driver: 'cozytouch', label: 'Towel rail' },
  { id: 'typo', name: 'Lamp', type: 'light', driver: 'govee-lam' },
] }];

test('modules: local ones are ready until their hardware is there, cloud ones off until an account is given', () => {
  const state = (cfg) => { const c = withEnv(cfg, {}); return Object.fromEntries(moduleList(c, buildDrivers(c), buildHome(c)).map((m) => [m.id, m.state])); };
  assert.deepEqual(state({ rooms }), {
    daikin: 'active', 'govee-lan': 'ready', 'lg-webos': 'ready', freebox: 'ready', 'tahoma-local': 'ready', mqtt: 'ready',
    'govee-cloud': 'disabled', cozytouch: 'disabled', 'lg-thinq': 'disabled',
  });
  const full = state({
    rooms, freebox: { appToken: 't', people: [{ id: 'a', name: 'Alex', devices: [] }] }, tahoma: { host: 'gateway-1234-5678-9012.local', token: 't' },
    mqtt: { url: 'mqtt://192.0.2.9:1883' }, cozytouch: { username: 'user@example.com', password: 'secret' }, govee: { cloudFallback: true, apiKey: 'k' },
  });
  assert.deepEqual([full.freebox, full['tahoma-local'], full.mqtt, full.cozytouch, full['govee-cloud'], full['lg-thinq']], ['active', 'active', 'active', 'active', 'active', 'disabled']);
  // half a config is no config: a box without its token stays ready, and asks nothing
  assert.equal(state({ rooms, tahoma: { host: 'gateway-1234-5678-9012.local', token: '' }, freebox: { appToken: '' }, mqtt: {} })['tahoma-local'], 'ready');
  const list = moduleList({ rooms }, buildDrivers({ rooms }), null);
  assert.deepEqual(list.filter((m) => m.account).map((m) => m.id), ['govee-cloud', 'cozytouch', 'lg-thinq'], 'the three that need an account say so');
  assert.equal(list.find((m) => m.id === 'daikin').devices, 1);
});

test('modules: the devices of a module that waits are left out, and nothing is asked of it', async () => {
  const handle = handler({ rooms }, { open: true, drivers: { daikin: { capabilities: async () => ({}), state: async () => ({ reachable: true, on: false }), set: async () => {}, list: async () => [] } } });
  const get = (url) => new Promise((resolve) => {
    const res = { writeHead(status) { this.status = status; }, end(body) { resolve([this.status, JSON.parse(body)]); } };
    handle({ method: 'GET', url, headers: {} }, res);
  });
  const [, list] = await get('/api/v1/rooms');
  assert.deepEqual(list[0].devices.map((d) => d.id), ['ac', 'typo'], 'the shutter, the sensor and the towel rail wait for their module');
  assert.match(list[0].devices[1].state.error, /no driver "govee-lam"/, 'a driver nobody knows is a mistake, and says so');
  assert.equal((await get('/api/v1/devices/shutter'))[0], 404);
  const [status, modules] = await get('/api/v1/modules');
  assert.equal(status, 200);
  assert.equal(modules.find((m) => m.id === 'tahoma-local').state, 'ready');
  assert.deepEqual((await get('/api/v1/home'))[1], { presence: [], network: null }, 'no module reads the home: an empty answer, not an error');
});

test('modules: a module that fails says so in /home without failing the answer', async () => {
  const service = createService({}, {}, { home: async () => { throw new DeviceError('freebox: timeout'); } });
  assert.deepEqual(await service.handle('GET', '/home'), [200, { presence: [], network: null, error: 'freebox: timeout' }]);
});

test('a scene that turns the lights off does not fail on a lamp cut at its wall switch', async () => {
  const silent = { capabilities: async () => ({ on: { type: 'boolean' } }), state: async (d) => d.id === 'cut' ? { reachable: false, error: 'lanSilent' } : d.id === 'gone' ? { reachable: false, error: 'timeout' } : { reachable: true, on: true }, set: async () => {}, list: async () => [] };
  const cfg = (ids) => ({ rooms: [{ id: 'r', name: 'Room', devices: ids.map((id) => ({ id, name: id, type: 'light', driver: 'x' })) }],
    scenes: [{ id: 'leave', name: 'Leaving', actions: [{ type: 'light', set: { on: false } }] }, { id: 'evening', name: 'Evening', actions: [{ type: 'light', set: { on: true } }] }] });
  let [, out] = await createService(cfg(['lamp', 'cut']), { x: silent }).handle('POST', '/scenes/leave');
  assert.deepEqual([out.ok, out.results.map((r) => r.ok)], [true, [true, true]], 'without power it is off: it has followed');
  [, out] = await createService(cfg(['lamp', 'cut']), { x: silent }).handle('POST', '/scenes/evening');
  assert.equal(out.ok, false, 'asked to turn on, it has not');
  [, out] = await createService(cfg(['lamp', 'gone']), { x: silent }).handle('POST', '/scenes/leave');
  assert.equal(out.ok, false, 'a device that fails for another reason still fails the scene');
});

test('a lamp silent on the LAN is only shown through the cloud when the cloud reaches it', async () => {
  const lan = { capabilities: async () => ({ on: { type: 'boolean' } }), state: async () => ({ reachable: false, error: 'lanSilent' }), set: async () => {}, list: async () => [] };
  const cloud = (answer) => ({ capabilities: async () => ({ on: { type: 'boolean' } }), state: async () => { if (answer instanceof Error) throw answer; return answer; }, set: async () => {}, list: async () => [] });
  const cfg = { rooms: [{ id: 'r', name: 'Room', devices: [{ id: 'lamp', name: 'Lamp', type: 'light', driver: 'govee-lan', sku: 'H0000', device: 'x' }] }] };
  const stateWith = async (answer) => (await createService(cfg, { 'govee-lan': lan, 'govee-cloud': cloud(answer) }).handle('GET', '/devices/lamp'))[1];
  // LAN Control is off but the lamp has power: the cloud stands in
  assert.deepEqual((await stateWith({ reachable: true, on: true, brightness: 60 })).state, { reachable: true, on: true, brightness: 60, via: 'cloud' });
  // switched off at the wall: the cloud has lost it too, says so, and it is not shown lit
  const cut = await stateWith({ reachable: false, error: 'cloudOffline' });
  assert.deepEqual([cut.state, cut.capabilities], [{ reachable: false, error: 'cloudOffline', via: 'cloud' }, {}]);
  // no internet: the same, and no error of the cloud on the tile of the lamp
  assert.deepEqual((await stateWith(new DeviceError('Govee: fetch failed'))).state, { reachable: false, error: 'lanSilent' });
});

/* ---------- Relay ---------- */
test('relay: with house.remote the agent passes /api/v1 on, with the token, and starts no service of its own', async () => {
  const seen = [];
  const remote = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      seen.push({ method: req.method, url: req.url, auth: req.headers.authorization, body });
      if (req.url.startsWith('/api/v1/devices/missing')) { res.writeHead(404, { 'Content-Type': 'application/json' }); return res.end('{"error":"unknown device"}'); }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ from: 'remote', url: req.url }));
    });
  });
  const port = await listen(remote);
  // what the agent mounts: a relay, not the local service (which would know no room called "elsewhere")
  const handle = mount({ remote: { url: `http://127.0.0.1:${port}`, token: 'the-token' }, rooms: [] });
  const agent = http.createServer((req, res) => handle(req, res));
  const agentPort = await listen(agent);
  const call = async (route, opts) => { const r = await fetch(`http://127.0.0.1:${agentPort}${route}`, opts); return [r.status, await r.json()]; };
  assert.deepEqual(await call('/api/v1/rooms?x=1'), [200, { from: 'remote', url: '/api/v1/rooms?x=1' }]);
  assert.deepEqual(await call('/api/v1/devices/lamp', { method: 'POST', body: '{"on":true}', headers: { 'content-type': 'application/json' } }), [200, { from: 'remote', url: '/api/v1/devices/lamp' }]);
  assert.deepEqual(seen.map((s) => [s.method, s.auth, s.body]), [['GET', 'Bearer the-token', ''], ['POST', 'Bearer the-token', '{"on":true}']]);
  assert.deepEqual(await call('/api/v1/devices/missing'), [404, { error: 'unknown device' }], 'the answer of the service comes back as it is');
  // a page of another site is refused before anything leaves, as the local service would
  assert.equal((await call('/api/v1/rooms', { headers: { origin: 'https://evil.example' } }))[0], 403);
  assert.equal((await call('/api/v1/rooms', { headers: { origin: 'http://localhost:5252' } }))[0], 200);
  assert.equal(seen.length, 4);
  remote.close(); agent.close();
  // the other machine is off: a clear 502, not a crash
  const down = relay({ url: `http://127.0.0.1:${port}/api/v1/`, token: 't' });
  const [status, out] = await new Promise((resolve) => down({ method: 'GET', url: '/api/v1/rooms', headers: {} }, { writeHead(s) { this.s = s; }, end(b) { resolve([this.s, JSON.parse(b)]); } }));
  assert.equal(status, 502);
  assert.match(out.error, /house service unreachable/);
});

test('relay: without house.remote nothing changes, the agent runs its own service', async () => {
  const handle = mount({ rooms: [{ id: 'r', name: 'Room', devices: [{ id: 'd', name: 'Lamp', type: 'light', driver: 'demo', state: { on: true } }] }] });
  const [status, out] = await new Promise((resolve) => handle({ method: 'GET', url: '/api/v1/rooms', headers: {} }, { writeHead(s) { this.s = s; }, end(b) { resolve([this.s, JSON.parse(b)]); } }));
  assert.equal(status, 200);
  assert.equal(out[0].devices[0].state.on, true);
});
