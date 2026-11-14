// The water heater, the television and the washing machine, on answers written for the
// tests: no appliance, no cloud and no network card is needed.
const test = require('node:test');
const assert = require('node:assert/strict');
const net = require('net');
const crypto = require('crypto');
const ws = require('../house/ws');
const lgWebos = require('../house/drivers/lg-webos');
const lgThinq = require('../house/drivers/lg-thinq');
const cozytouch = require('../house/drivers/cozytouch');
const { DeviceError } = require('../house/util');

/* ---------- WebSocket ---------- */

test('ws: a frame survives the round trip at every size of length', () => {
  for (const size of [0, 5, 125, 126, 70000]) {
    const payload = Buffer.alloc(size, 'a'), frame = ws.encode(1, payload), back = ws.decode(frame);
    assert.equal(frame[1] & 0x80, 0x80, 'a client masks what it sends');
    assert.deepEqual([back.fin, back.opcode, back.size, back.payload.equals(payload)], [true, 1, frame.length, true]);
    assert.equal(ws.decode(frame.subarray(0, frame.length - 1)) ?? ws.decode(Buffer.alloc(1)), null, 'half a frame waits for the rest');
  }
});

// The server side of the protocol, enough to answer a client: upgrade, then unmasked frames.
function fakeServer(onText) {
  const server = net.createServer((socket) => {
    let buffer = Buffer.alloc(0), upgraded = false;
    const send = (opcode, payload, fin = true) => socket.write(Buffer.concat([Buffer.from([(fin ? 0x80 : 0) | opcode, payload.length]), payload]));
    socket.on('error', () => {});
    socket.on('data', (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      if (!upgraded) {
        const stop = buffer.indexOf('\r\n\r\n');
        if (stop < 0) return;
        const key = /Sec-WebSocket-Key: (.+)\r\n/.exec(buffer.toString())[1];
        const accept = crypto.createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
        socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
        buffer = buffer.subarray(stop + 4);
        upgraded = true;
      }
      for (let f = ws.decode(buffer); f; f = ws.decode(buffer)) {
        buffer = buffer.subarray(f.size);
        if (f.opcode === 1) onText(f.payload.toString(), send);
      }
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

test('ws: a client connects, sends, and reads a message cut in two and a ping in between', async () => {
  const pongs = [];
  const server = await fakeServer((text, send) => {
    send(1, Buffer.from('you said '), false);
    send(9, Buffer.from('still there'));
    send(0, Buffer.from(text));
  });
  server.on('connection', (socket) => socket.on('data', (chunk) => { const f = ws.decode(chunk); if (f && f.opcode === 10) pongs.push(f.payload.toString()); }));
  const got = [];
  let done;
  const heard = new Promise((resolve) => { done = resolve; });
  const client = await ws.open(`ws://127.0.0.1:${server.address().port}/`, { onMessage: (text) => { got.push(text); done(); } });
  client.send('hello');
  await heard;
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.deepEqual(got, ['you said hello']);
  assert.deepEqual(pongs, ['still there'], 'a ping is answered with its own payload');
  client.close();
  server.close();
});

test('ws: nobody at the address, or something that is not a WebSocket, is a DeviceError', async () => {
  const server = await new Promise((resolve) => { const s = net.createServer((socket) => { socket.on('error', () => {}); socket.end('HTTP/1.1 200 OK\r\n\r\n'); }); s.listen(0, '127.0.0.1', () => resolve(s)); });
  const { port } = server.address();
  await assert.rejects(ws.open(`ws://127.0.0.1:${port}/`), DeviceError);
  // closed to new clients at once, whatever is left of the old one
  server.close();
  await assert.rejects(ws.open(`ws://127.0.0.1:${port}/`, { timeout: 500 }), DeviceError);
});

/* ---------- Television ---------- */

const TV = { id: 'living-tv', name: 'Television', host: '192.0.2.30', key: 'key-1', mac: '00:00:5E:00:53:30' };
const INPUTS = [{ id: 'HDMI_1', label: 'Console', appId: 'com.webos.app.hdmi1' }, { id: 'HDMI_2', label: 'Player', appId: 'com.webos.app.hdmi2' }];

// A set that answers the questions of the driver. `off`: nothing listens. `secure`: only the secure port does.
function fakeSet({ off = false, secure = true, keys = ['key-1'], power = 'Active', app = 'com.webos.app.hdmi2', accept = true } = {}) {
  const set = { opened: [], asked: [], prompts: 0, sent: [], closed: 0 };
  set.open = async (url, { onMessage }) => {
    set.opened.push(url);
    if (off || url.startsWith('wss:') !== secure) throw new DeviceError('ECONNREFUSED');
    const answer = (msg) => setImmediate(() => onMessage(JSON.stringify(msg)));
    return {
      close: () => { set.closed++; },
      send(text) {
        const msg = JSON.parse(text);
        if (msg.type === 'register') {
          const key = msg.payload['client-key'];
          if (key && keys.includes(key)) return answer({ id: msg.id, type: 'registered', payload: { 'client-key': key } });
          answer({ id: msg.id, type: 'response', payload: { pairingType: 'PROMPT', returnValue: true } });
          if (accept) answer({ id: msg.id, type: 'registered', payload: { 'client-key': 'key-new' } });
          return;
        }
        set.asked.push([msg.uri, msg.payload]);
        const payload = {
          'ssap://com.webos.service.tvpower/power/getPowerState': { state: power },
          'ssap://audio/getVolume': { volumeStatus: { volume: 14, muteStatus: false } },
          'ssap://com.webos.applicationManager/getForegroundAppInfo': { appId: app },
          'ssap://tv/getExternalInputList': { devices: INPUTS },
          'ssap://com.webos.applicationManager/listLaunchPoints': { launchPoints: [{ id: 'films', title: 'Films' }, { id: 'other', title: 'Other' }] },
        }[msg.uri];
        if (msg.uri === 'ssap://tv/switchInput' && msg.payload.inputId === 'HDMI_9') return answer({ id: msg.id, type: 'error', error: '404 no such input' });
        answer({ id: msg.id, type: 'response', payload: payload || { returnValue: true } });
      },
    };
  };
  set.udp = { createSocket: () => ({ on() {}, bind: (cb) => cb(), setBroadcast() {}, close() {}, send(packet, port, address, cb) { set.sent.push({ packet, port, address }); cb(); } }) };
  set.driver = lgWebos.create({ openSocket: set.open, udp: set.udp });
  return set;
}

test('lg-webos: a set that is on gives its volume, its input and what it can do', async () => {
  const set = fakeSet();
  assert.deepEqual(await set.driver.state(TV), { reachable: true, on: true, volume: 14, muted: false, source: 'HDMI_2', app: 'com.webos.app.hdmi2', appName: 'Player' });
  assert.deepEqual(await set.driver.capabilities(TV), {
    on: { type: 'boolean' }, volume: { min: 0, max: 100, step: 1 }, muted: { type: 'boolean' },
    source: { options: ['HDMI_1', 'HDMI_2'], labels: { HDMI_1: 'Console', HDMI_2: 'Player' } },
  });
  assert.deepEqual(set.opened, ['wss://192.0.2.30:3001/'], 'one connection, kept for the questions that follow');
});

test('lg-webos: an older set only answers on the plain port, and that is remembered', async () => {
  const set = fakeSet({ secure: false });
  assert.equal((await set.driver.state(TV)).on, true);
  assert.deepEqual(set.opened, ['wss://192.0.2.30:3001/', 'ws://192.0.2.30:3000/']);
});

test('lg-webos: a set that does not answer is off, not broken, and can still be turned on', async () => {
  const set = fakeSet({ off: true });
  assert.deepEqual(await set.driver.state(TV), { reachable: true, on: false });
  assert.deepEqual(await set.driver.capabilities(TV), { on: { type: 'boolean' } });
  await set.driver.set(TV, { on: true });
  const { packet, port, address } = set.sent[0];
  assert.deepEqual([port, address, packet.length], [9, '255.255.255.255', 102]);
  assert.equal(packet.subarray(0, 6).toString('hex'), 'ffffffffffff');
  assert.equal(packet.subarray(6, 12).toString('hex'), '00005e005330');
  assert.equal(packet.subarray(96).toString('hex'), '00005e005330', 'the address sixteen times');
  await assert.rejects(set.driver.set({ ...TV, mac: undefined }, { on: true }), /"mac" is needed/);
  assert.throws(() => lgWebos.magicPacket('living-room'), DeviceError);
});

test('lg-webos: standby with the network awake reads as off', async () => {
  assert.deepEqual(await fakeSet({ power: 'Active Standby' }).driver.state(TV), { reachable: true, on: false });
  assert.equal(lgWebos.normalize({ power: null, volume: { volume: 3, muted: true }, app: { appId: 'films' }, apps: [{ id: 'films', title: 'Films' }] }).appName, 'Films', 'an older firmware: no power state, a flat volume');
});

test('lg-webos: changes become the requests of the set, and its refusal is told', async () => {
  const set = fakeSet();
  await set.driver.set(TV, { volume: 22.4, muted: true, source: 'HDMI_1' });
  await set.driver.set({ ...TV, apps: ['films'] }, { app: 'films' });
  await set.driver.set(TV, { on: false });
  assert.deepEqual(set.asked, [
    ['ssap://audio/setVolume', { volume: 22 }], ['ssap://audio/setMute', { mute: true }], ['ssap://tv/switchInput', { inputId: 'HDMI_1' }],
    ['ssap://system.launcher/launch', { id: 'films' }], ['ssap://system/turnOff', {}],
  ]);
  await assert.rejects(set.driver.set(TV, { source: 'HDMI_9' }), /Television: 404 no such input/);
});

test('lg-webos: only the applications named in the config are offered', async () => {
  const set = fakeSet({ app: 'films' }), tv = { ...TV, apps: ['films'] };
  assert.equal((await set.driver.state(tv)).appName, 'Films');
  assert.deepEqual((await set.driver.capabilities(tv)).app, { options: ['films'], labels: { films: 'Films' } });
});

test('lg-webos: a set that was never paired says how to pair it, and pairing gives its key', async () => {
  const set = fakeSet({ keys: [] });
  await assert.rejects(set.driver.state({ ...TV, key: '' }), /not paired \(node house\/pair-tv\.js 192\.0\.2\.30\)/);
  let prompted = 0;
  assert.equal(await set.driver.pair('192.0.2.30', { onPrompt: () => { prompted++; } }), 'key-new');
  assert.equal(prompted, 1, 'the screen asked');
  assert.equal(set.closed, 1, 'nothing is left open after pairing');
  await assert.rejects(fakeSet({ keys: [], accept: false }).driver.pair('192.0.2.30', { waitMs: 30 }), /pairing not accepted on the screen/);
  // a key the set no longer knows: it asks again on its screen, which nobody answers from here
  await assert.rejects(lgWebos.create({ openSocket: fakeSet({ keys: [], accept: false }).open, answerMs: 30 }).capabilities(TV), /no answer to the registration/);
});

/* ---------- Washing machine ---------- */

const WASHER = { id: 'washer', name: 'Washing machine', deviceId: 'abc123' };
const drum = (over = {}) => [{
  location: { locationName: 'MAIN' }, runState: { currentState: 'RINSING' }, operation: { washerOperationMode: 'START' },
  remoteControlEnable: { remoteControlEnabled: false }, timer: { remainHour: 1, remainMinute: 5, totalHour: 2, totalMinute: 10 }, ...over,
}];

function fakeThinq(body = drum()) {
  const calls = [];
  const fetchImpl = async (url, opts = {}) => {
    const u = new URL(url);
    calls.push({ method: opts.method, url, headers: opts.headers, body: opts.body && JSON.parse(opts.body) });
    const json = (o, status = 200) => new Response(JSON.stringify(o), { status });
    if (opts.headers.authorization !== 'Bearer pat-1') return json({ error: { code: '1218', message: 'Invalid token' } }, 401);
    if (u.pathname === '/devices') return json({ response: [{ deviceId: 'abc123', deviceInfo: { deviceType: 'DEVICE_WASHER', modelName: 'W-1', alias: 'Washer', reportable: true } }] });
    if (u.pathname.endsWith('/state')) return json({ response: typeof body === 'function' ? body() : body });
    if (u.pathname.endsWith('/control')) return json({ response: {} });
    return json({ error: { code: '1000', message: 'Bad request' } }, 400);
  };
  let clock = 1_000_000;
  return { calls, tick: (ms) => { clock += ms; }, driver: lgThinq.create({ token: 'pat-1', country: 'FR', fetch: fetchImpl, now: () => clock }) };
}

test('lg-thinq: a running cycle gives its step, the time left and when it ends', async () => {
  const cloud = fakeThinq();
  assert.deepEqual(await cloud.driver.state(WASHER), {
    reachable: true, on: true, run: 'running', phase: 'rinsing', remoteStart: false, remainingMin: 65, totalMin: 130, endsAt: new Date(1_000_000 + 65 * 60000).toISOString(),
  });
  const { url, headers } = cloud.calls[0];
  assert.equal(url, 'https://api-eic.lgthinq.com/devices/abc123/state');
  assert.deepEqual([headers['x-country'], headers['x-service-phase'], headers['x-message-id'].length], ['FR', 'OP', 22]);
  assert.match(headers['x-client-id'], /^vigie-[0-9a-f]{32}$/);
  await cloud.driver.state(WASHER);
  assert.equal(cloud.calls.length, 1, 'the cloud is asked once a minute at most');
  cloud.tick(61000);
  await cloud.driver.state(WASHER);
  assert.equal(cloud.calls.length, 2);
  assert.equal(cloud.calls[1].headers['x-client-id'], headers['x-client-id'], 'the same client every time');
  assert.notEqual(cloud.calls[1].headers['x-message-id'], headers['x-message-id']);
});

test('lg-thinq: off, ready, finished and in error are told apart', () => {
  const run = (currentState) => lgThinq.normalize(drum({ runState: { currentState }, timer: {} }));
  assert.deepEqual(['POWER_OFF', 'SLEEP', 'INITIAL', 'PAUSE', 'RESERVED', 'END', 'ERROR', 'SPINNING'].map((s) => run(s).run), ['off', 'off', 'idle', 'paused', 'scheduled', 'done', 'error', 'running']);
  assert.deepEqual([run('POWER_OFF').on, run('END').on, run('END').endsAt, run('SPINNING').phase], [false, true, undefined, 'spinning']);
  assert.equal(run('SPINNING').remainingMin, null, 'no timer: no guess');
  // a machine with two drums answers for both: the main one unless the config says otherwise
  const two = [...drum(), { location: { locationName: 'MINI' }, runState: { currentState: 'END' } }];
  assert.deepEqual([lgThinq.normalize(two).run, lgThinq.normalize(two, { location: 'MINI' }).run], ['running', 'done']);
  assert.equal(lgThinq.normalize({ runState: { currentState: 'END' } }).run, 'done', 'a single block is read too');
});

test('lg-thinq: a cycle is only started when the machine waits for it', async () => {
  assert.deepEqual(await fakeThinq(drum({ runState: { currentState: 'INITIAL' } })).driver.capabilities(WASHER), {}, 'Remote Start is off on the machine');
  assert.deepEqual(await fakeThinq(drum({ remoteControlEnable: { remoteControlEnabled: true } })).driver.capabilities(WASHER), {}, 'already running');
  const cloud = fakeThinq(drum({ runState: { currentState: 'INITIAL' }, remoteControlEnable: { remoteControlEnabled: true } }));
  assert.deepEqual(await cloud.driver.capabilities(WASHER), { start: { type: 'action' } });
  await cloud.driver.set(WASHER, { start: true });
  const sent = cloud.calls.pop();
  assert.deepEqual([sent.method, sent.url, sent.headers['x-conditional-control']], ['POST', 'https://api-eic.lgthinq.com/devices/abc123/control', 'true']);
  assert.deepEqual(sent.body, { location: { locationName: 'MAIN' }, operation: { washerOperationMode: 'START' } });
  await cloud.driver.state(WASHER);
  assert.equal(cloud.calls.pop().method, 'GET', 'the state is read again after a command');
});

test('lg-thinq: a refusal carries what LG says, and the account lists its appliances', async () => {
  const cloud = fakeThinq();
  assert.deepEqual(await cloud.driver.list(), [{ driver: 'lg-thinq', deviceId: 'abc123', name: 'Washer', model: 'W-1', kind: 'DEVICE_WASHER' }]);
  const wrong = lgThinq.create({ token: 'pat-2', fetch: async () => new Response(JSON.stringify({ error: { code: '1218', message: 'Invalid token' } }), { status: 401 }) });
  await assert.rejects(wrong.state(WASHER), /LG ThinQ: Invalid token \(1218\)/);
});

/* ---------- Water heater ---------- */

const HEATER = { id: 'water', name: 'Hot water', deviceId: 4242 };
const values = (over = {}) => Object.entries({ 87: '3', 165: '0', 227: '0', 226: '[0,0]', 292: '3', 293: '2', 271: '65', 265: '51.5', 231: '55', 59: '123456', ...over })
  .filter(([, value]) => value !== undefined).map(([capabilityId, value]) => ({ capabilityId: Number(capabilityId), value }));
const asMap = (over) => Object.fromEntries(values(over).map((c) => [c.capabilityId, c.value]));

function fakeAtlantic({ caps = values(), failing = false } = {}) {
  const calls = [];
  const cloud = { calls, executions: 0, polls: 0 };
  cloud.fetch = async (url, opts = {}) => {
    const u = new URL(url);
    const body = opts.body && (opts.headers['content-type'] === 'application/json' ? JSON.parse(opts.body) : Object.fromEntries(new URLSearchParams(opts.body)));
    calls.push({ method: opts.method || 'GET', path: u.pathname, auth: opts.headers.authorization, body });
    const json = (o, status = 200) => new Response(JSON.stringify(o), { status });
    if (u.pathname === '/users/token') return body.password === 'secret' ? json({ token_type: 'bearer', access_token: 'bearer-1', expires_in: 3600 }) : json({ error: 'invalid_grant' }, 400);
    if (u.pathname === '/magellan/cozytouch/setupviewv2') return json([{ id: 77, name: 'Home', address: '1 Example Street', area: 60, absence: {}, internal: 'not sent back', devices: [{ deviceId: 4242, name: 'Tank', modelId: 1, productId: 2, capabilities: caps }] }]);
    if (u.pathname === '/magellan/executions/writecapability') { cloud.executions++; return json(900 + cloud.executions, 201); }
    if (u.pathname.startsWith('/magellan/executions/')) { cloud.polls++; return json({ state: failing ? 4 : cloud.polls % 2 ? 2 : 3 }); }
    if (u.pathname === '/magellan/v2/setups/77') return new Response(null, { status: 204 });
    if (u.pathname === '/token') return json({ error: 'invalid_grant' }, 400);
    return json({ error: 'not found' }, 404);
  };
  cloud.driver = cozytouch.create({ username: 'user@example.com', password: 'secret', fetch: cloud.fetch, sleep: async () => {} });
  return cloud;
}

test('cozytouch: a water heater on the newer cloud is read from its numbered capabilities', async () => {
  const cloud = fakeAtlantic();
  assert.deepEqual(await cloud.driver.state(HEATER), {
    reachable: true, on: true, mode: 'eco', showers: 3, showersLeft: 2, hotWater: 65, temperature: 51.5, setpoint: 55, boost: false, away: null, energyKwh: 123.5,
  });
  assert.deepEqual(await cloud.driver.capabilities(HEATER), { mode: { options: ['manual', 'eco'] }, showers: { min: 1, max: 6, step: 1 }, boost: { type: 'boolean' }, away: { type: 'period' } });
  assert.deepEqual(cloud.calls.map((c) => c.path), ['/users/token', '/magellan/cozytouch/setupviewv2'], 'one token, one read for both');
  assert.equal(cloud.calls[1].auth, 'Bearer bearer-1');
  await assert.rejects(cloud.driver.state({ ...HEATER, deviceId: 1 }), /Hot water: not found in the Cozytouch account/);
});

test('cozytouch: what a heater does not report is neither shown nor offered', () => {
  const bare = asMap({ 165: undefined, 227: undefined, 226: undefined, 292: undefined, 293: undefined, 59: undefined });
  assert.deepEqual(cozytouch.normalizeWater(bare), { reachable: true, on: true, mode: 'eco', showers: null, showersLeft: null, hotWater: 65, temperature: 51.5, setpoint: 55 });
  assert.deepEqual(cozytouch.waterCapabilities(bare), { mode: { options: ['manual', 'eco'] } });
  assert.deepEqual(cozytouch.waterCapabilities(asMap({ 87: '4' })).mode.options, ['manual', 'eco', 'schedule'], 'a heater found on its program keeps that choice');
  // an older product keeps its absence in 152 and 222
  const older = asMap({ 227: undefined, 226: undefined, 152: '1', 222: '[1700000000, 1700600000]' });
  assert.deepEqual(cozytouch.normalizeWater(older).away, { from: '2023-11-14T22:13:20.000Z', to: '2023-11-21T20:53:20.000Z', pending: false });
  assert.equal(cozytouch.normalizeWater(asMap({ 227: '2', 226: '[1700000000,1700600000]' })).away.pending, true, 'set for later');
});

test('cozytouch: changes of a water heater are capability writes, each waited for', async () => {
  const cloud = fakeAtlantic();
  await cloud.driver.set(HEATER, { mode: 'manual', showers: 4, boost: true });
  const writes = cloud.calls.filter((c) => c.path.endsWith('/writecapability')).map((c) => c.body);
  assert.deepEqual(writes, [{ capabilityId: 87, deviceId: 4242, value: '0' }, { capabilityId: 292, deviceId: 4242, value: '4' }, { capabilityId: 165, deviceId: 4242, value: '1' }]);
  assert.equal(cloud.polls, 6, 'each write is polled until Atlantic says it is done');
  await cloud.driver.state(HEATER);
  assert.equal(cloud.calls.filter((c) => c.path.endsWith('setupviewv2')).length, 2, 'the state is read again after a command');
  await assert.rejects(fakeAtlantic({ failing: true }).driver.set(HEATER, { boost: true }), /the command was refused \(state 4\)/);
});

test('cozytouch: an absence goes to the account, then to the heater, with its two dates', async () => {
  const cloud = fakeAtlantic(), from = '2030-03-01T08:00:00.000Z', to = '2030-03-09T00:00:00.000Z';
  const start = Date.parse(from) / 1000, end = Date.parse(to) / 1000;
  await cloud.driver.set(HEATER, { away: { from, to } });
  const put = cloud.calls.find((c) => c.method === 'PUT');
  assert.equal(put.path, '/magellan/v2/setups/77');
  assert.deepEqual(put.body, { address: '1 Example Street', area: 60, name: 'Home', absence: { startDate: start, endDate: end } }, 'only the fields the account lets be written');
  assert.deepEqual(cloud.calls.filter((c) => c.path.endsWith('/writecapability')).map((c) => [c.body.capabilityId, c.body.value]), [[226, `[${start},${end}]`], [227, '2']], 'a start still to come is set for later');
  // ending it
  const again = fakeAtlantic({ caps: values({ 227: '1', 226: `[${start},${end}]` }) });
  await again.driver.set(HEATER, { away: null });
  assert.deepEqual(again.calls.find((c) => c.method === 'PUT').body.absence, {});
  assert.deepEqual(again.calls.filter((c) => c.path.endsWith('/writecapability')).map((c) => [c.body.capabilityId, c.body.value]), [[226, '[0,0]'], [227, '0']]);
  assert.deepEqual(cozytouch.waterWrites({ away: { from: '2020-01-01T00:00:00Z', to: '2020-01-02T00:00:00Z' } }, asMap(), Date.parse('2020-01-01T12:00:00Z')).pop(), [227, '1'], 'already started: on at once');
  await assert.rejects(cloud.driver.set(HEATER, { away: { from: to, to: from } }), RangeError);
  assert.equal(cloud.calls.filter((c) => c.method === 'PUT').length, 1, 'a window that ends before it starts is sent nowhere');
});

test('cozytouch: the account lists what it has on the newer cloud when the older one has nothing', async () => {
  const cloud = fakeAtlantic();
  assert.deepEqual(await cloud.driver.list(), [{ driver: 'cozytouch', deviceId: 4242, label: 'Tank', model: 1, capabilities: [59, 87, 165, 226, 227, 231, 265, 271, 292, 293] }]);
  const nothing = cozytouch.create({ username: 'user@example.com', password: 'wrong', fetch: cloud.fetch });
  await assert.rejects(nothing.list(), /wrong email or password/);
});

/* ---------- In the service ---------- */

test('service: the new appliances are devices like the others, and a scene can turn the television on or off', async () => {
  const { createService } = require('../house/service');
  const demo = require('../house/drivers/demo');
  const cfg = require('../house/demo/config.json').house;
  const service = createService(cfg, { demo: demo.create() });
  const device = async (id) => (await service.handle('GET', `/devices/${id}`))[1];
  assert.deepEqual([(await device('kitchen-water')).type, (await device('bathroom-washer')).state.run, (await device('living-tv')).state.on], ['water', 'running', true]);
  const [, left] = await service.handle('POST', '/scenes/leave');
  assert.ok(left.ok && left.results.some((r) => r.device === 'living-tv'), 'leaving reaches the television');
  assert.equal((await device('living-tv')).state.on, false);
  await service.handle('POST', '/scenes/evening');
  assert.equal((await device('living-tv')).state.on, true);
  // an absence is a period, showers a number brought back into its range, anything else is refused
  const [status, heater] = await service.handle('POST', '/devices/kitchen-water', { away: { from: '2030-01-01T00:00:00Z', to: '2030-01-08T00:00:00Z' }, showers: 9 });
  assert.deepEqual([status, heater.state.showers, heater.state.away.to], [200, 6, '2030-01-08T00:00:00Z']);
  assert.equal((await service.handle('POST', '/devices/bathroom-washer', { start: true }))[0], 400, 'this machine does not wait for a remote start');
});
