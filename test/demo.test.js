// The demo: the page on made-up data, for the screenshots and the layout check. It must
// answer every route the page reads, without the network, and hold nothing real.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const demo = require('../lib/demo');
const { validate } = require('../house/plan');
const { handler } = require('../house/server');

test('the demo answers every route with data that goes through JSON', () => {
  for (const [route, make] of Object.entries(demo.GET)) {
    const out = make();
    assert.deepEqual(JSON.parse(JSON.stringify(out)), out, route);
  }
  for (const range of ['1h', '1d', '30d']) assert.ok(demo.history(range).samples.length > 10, `history ${range}`);
  for (const lang of ['en', 'fr']) {
    assert.equal(demo.config(lang).lang, lang);
    assert.ok(demo.briefing(lang).text.length > 20);
  }
  assert.equal('services' in demo.config('en'), false);
});

test('the demo stands in for the public sources the page calls itself', () => {
  // only what is asked for comes back, as the real API does
  const forecast = demo.external('https://api.open-meteo.com/v1/forecast?latitude=1&longitude=2&forecast_days=7&hourly=temperature_2m,weather_code&daily=sunrise,sunset&current=temperature_2m');
  assert.equal(forecast.hourly.time.length, forecast.hourly.temperature_2m.length);
  assert.ok(forecast.daily.sunrise.length >= 7 && forecast.current.temperature_2m != null);
  const air = demo.external('https://air-quality-api.open-meteo.com/v1/air-quality?latitude=1&longitude=2&current=european_aqi');
  assert.ok(air.current && 'european_aqi' in air.current);
  assert.equal(demo.external('https://example.org/anything'), null, 'anything else has no answer, and the agent never goes to the network for it');
});

test('the demo home is made up: its plan follows the schema and names only its own devices', async () => {
  const cfg = demo.houseConfig(), dir = path.join(__dirname, '..', 'house', 'demo');
  const ids = cfg.rooms.flatMap((r) => r.devices.map((d) => d.id));
  const { errors, warnings } = validate(JSON.parse(fs.readFileSync(path.join(dir, 'plan.json'), 'utf8')), ids);
  assert.deepEqual([errors, warnings], [[], []]);
  // every address of the demo is one reserved for documentation
  const text = fs.readFileSync(path.join(dir, 'config.json'), 'utf8');
  for (const ip of text.match(/\b\d{1,3}(?:\.\d{1,3}){3}\b/g) || []) assert.match(ip, /^(127\.0\.0\.1|192\.0\.2\.\d+|198\.51\.100\.\d+|203\.0\.113\.\d+)$/, ip);
  for (const mac of text.match(/\b(?:[0-9A-F]{2}:){5}[0-9A-F]{2}\b/gi) || []) assert.match(mac, /^00:00:5E:00:53:/i, mac);
  // and the service serves it: the home block, an unreachable lamp, a meter
  const handle = handler(cfg, { open: true, baseDir: dir });
  const get = (url) => new Promise((resolve) => handle({ method: 'GET', url, headers: {} }, { writeHead(s) { this.s = s; }, end(b) { resolve([this.s, JSON.parse(b)]); } }));
  const [, home] = await get('/api/v1/home');
  assert.ok(home.presence.length && home.network.state === 'up');
  const [, rooms] = await get('/api/v1/rooms');
  const all = rooms.flatMap((r) => r.devices);
  assert.ok(all.some((d) => d.state.error === 'cloudOffline') && all.some((d) => d.type === 'meter'));
});
