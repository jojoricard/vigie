/* HTTP front of the house service.
 *   node house/server.js     runs it alone (a Raspberry Pi, a homelab), on house.port
 *   mount(cfg)               gives Vigie's agent a handler for /api/v1/*, same process
 * Config: the "house" section of config.json (or the file named by HOUSE_CONFIG).
 * Secrets may come from the environment instead: HOUSE_TOKEN, COZYTOUCH_USERNAME,
 * COZYTOUCH_PASSWORD, GOVEE_API_KEY, HOUSE_PLAN (the file of the floor plan). */
const http = require('http');
const fs = require('fs');
const path = require('path');
const { createService, authorize, isLoopback } = require('./service');
const daikin = require('./drivers/daikin');
const goveeLan = require('./drivers/govee-lan');
const goveeCloud = require('./drivers/govee-cloud');
const cozytouch = require('./drivers/cozytouch');
const lgWebos = require('./drivers/lg-webos');
const lgThinq = require('./drivers/lg-thinq');
const demo = require('./drivers/demo');
const freebox = require('./drivers/freebox');
const tahomaLocal = require('./drivers/tahoma-local');
const mqttDriver = require('./drivers/mqtt');
const plan = require('./plan');

const PREFIX = '/api/v1';
const DEFAULT_PORT = 5253;

function withEnv(cfg, env = process.env) {
  const out = { ...cfg, token: env.HOUSE_TOKEN || cfg.token || '' };
  if (env.HOUSE_PLAN) out.planPath = env.HOUSE_PLAN;
  if (cfg.govee || env.GOVEE_API_KEY) out.govee = { ...cfg.govee, apiKey: env.GOVEE_API_KEY || (cfg.govee || {}).apiKey || '' };
  if (cfg.lgThinq || env.LG_THINQ_TOKEN) out.lgThinq = { ...cfg.lgThinq, token: env.LG_THINQ_TOKEN || (cfg.lgThinq || {}).token || '' };
  if (cfg.cozytouch || env.COZYTOUCH_USERNAME) {
    out.cozytouch = { ...cfg.cozytouch, username: env.COZYTOUCH_USERNAME || (cfg.cozytouch || {}).username, password: env.COZYTOUCH_PASSWORD || (cfg.cozytouch || {}).password };
  }
  if (cfg.freebox || env.FREEBOX_APP_TOKEN) out.freebox = { ...cfg.freebox, appToken: env.FREEBOX_APP_TOKEN || (cfg.freebox || {}).appToken || '' };
  if (cfg.tahoma || env.TAHOMA_TOKEN) out.tahoma = { ...cfg.tahoma, token: env.TAHOMA_TOKEN || (cfg.tahoma || {}).token || '' };
  if (cfg.mqtt || env.MQTT_PASSWORD) out.mqtt = { ...cfg.mqtt, password: env.MQTT_PASSWORD || (cfg.mqtt || {}).password };
  return out;
}

/* Every integration, in the order the Modules panel lists them. `local` ones talk to
 * the device on the home network and are on as soon as their settings are there; the
 * others go through the cloud of their maker: they need an account, and stay off until
 * the config asks for them in so many words. */
const MODULES = [
  { id: 'daikin', local: true }, { id: 'govee-lan', local: true }, { id: 'lg-webos', local: true },
  { id: 'freebox', local: true }, { id: 'tahoma-local', local: true }, { id: 'mqtt', local: true },
  { id: 'govee-cloud', local: false }, { id: 'cozytouch', local: false }, { id: 'lg-thinq', local: false },
];

// Only the drivers the config asks for: no socket opened, no cloud called for nothing.
function buildDrivers(cfg) {
  const used = new Set((cfg.rooms || []).flatMap((r) => (r.devices || []).map((d) => d.driver)));
  const drivers = {};
  if (used.has('daikin')) drivers.daikin = daikin.create();
  if (used.has('govee-lan')) drivers['govee-lan'] = goveeLan.create();
  if (used.has('demo')) drivers.demo = demo.create();
  const g = cfg.govee || {};
  if (g.cloudFallback && g.apiKey) drivers['govee-cloud'] = goveeCloud.create({ apiKey: g.apiKey });
  const c = cfg.cozytouch;
  if (c && c.username && c.password) drivers.cozytouch = cozytouch.create({ username: c.username, password: c.password });
  // a television is on the local network and has its key on its own device: nothing to configure apart
  if (used.has('lg-webos')) drivers['lg-webos'] = lgWebos.create();
  const t = cfg.lgThinq;
  if (t && t.token) drivers['lg-thinq'] = lgThinq.create({ token: t.token, country: t.country, region: t.region });
  // Ready, and off until their hardware is there: a box with its token, a broker with its address.
  const s = cfg.tahoma;
  if (s && s.host && s.token) drivers['tahoma-local'] = tahomaLocal.create({ host: s.host, pin: s.pin, token: s.token });
  const m = cfg.mqtt;
  if (m && m.url) drivers.mqtt = mqttDriver.create({ url: m.url, username: m.username, password: m.password, base: m.base });
  return drivers;
}

// What reads the home itself, outside any room: the Freebox once paired, or the made-up home of the demo.
function buildHome(cfg) {
  const f = cfg.freebox;
  if (f && f.appToken) return freebox.create({ host: f.host, appToken: f.appToken, people: f.people }).home;
  if (cfg.home && (cfg.rooms || []).some((r) => (r.devices || []).some((d) => d.driver === 'demo'))) return async () => cfg.home;
  return null;
}

/* The state of each module: "active" when it runs, "ready" for a local one that waits
 * for its hardware, "disabled" for one that needs an account nobody gave. */
function moduleList(cfg, drivers, home) {
  const count = (id) => (cfg.rooms || []).reduce((n, r) => n + (r.devices || []).filter((d) => d.driver === id).length, 0);
  const list = MODULES.map(({ id, local }) => {
    const active = id === 'freebox' ? !!(home && cfg.freebox && cfg.freebox.appToken) : !!drivers[id];
    const devices = id === 'freebox' ? ((cfg.freebox && cfg.freebox.people) || []).length : count(id);
    return { id, local, account: !local, state: active ? 'active' : local ? 'ready' : 'disabled', devices: active ? devices : 0 };
  });
  if (drivers.demo) list.unshift({ id: 'demo', local: true, account: false, state: 'active', devices: count('demo') });
  return list;
}

function readBody(req) {
  return new Promise((resolve) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      if (!body) return resolve({});
      try { resolve(JSON.parse(body)); } catch { resolve(null); }
    });
  });
}

function send(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

/* `open` says the service only listens on the machine itself: local callers then need
 * no token. `baseDir` is where a relative house.planPath starts from: the folder of the
 * config file. Returns an async (req, res) for every URL under /api/v1. */
function handler(rawCfg, { open, drivers, baseDir = path.join(__dirname, '..') } = {}) {
  const cfg = withEnv(rawCfg || {});
  const planFile = cfg.planPath ? path.resolve(baseDir, cfg.planPath) : null;
  const built = drivers || buildDrivers(cfg), home = buildHome(cfg);
  const service = createService(cfg, built, { readPlan: planFile ? (ids) => plan.load(planFile, ids) : null, home, modules: moduleList(cfg, built, home) });
  return async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const denied = authorize({ token: cfg.token, open }, { authorization: req.headers.authorization, origin: req.headers.origin });
    if (denied) return send(res, denied, { error: denied === 401 ? 'token required' : 'origin refused' });
    const body = req.method === 'POST' ? await readBody(req) : null;
    if (req.method === 'POST' && body === null) return send(res, 400, { error: 'invalid JSON body' });
    const [status, out] = await service.handle(req.method, url.pathname.slice(PREFIX.length) || '/', body, Object.fromEntries(url.searchParams));
    send(res, status, out);
  };
}

/* house.remote = { url, token }: the service runs elsewhere (a machine that stays on).
 * The agent then starts none and relays every /api/v1 request there, with the token.
 * The page keeps talking to its own origin and never holds the token. A page of another
 * site is refused here, as the local service would: the relay adds the token itself. */
function relay(remote, { fetchImpl = fetch } = {}) {
  const root = String(remote.url).replace(/\/+$/, '').replace(new RegExp(`${PREFIX}$`), '');
  return async (req, res) => {
    const origin = req.headers.origin;
    if (origin && (!URL.canParse(origin) || !isLoopback(new URL(origin).hostname))) return send(res, 403, { error: 'origin refused' });
    const url = new URL(req.url, 'http://localhost');
    let body;
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      body = await new Promise((resolve) => { let b = ''; req.on('data', (c) => (b += c)); req.on('end', () => resolve(b)); });
    }
    let r, text;
    try {
      r = await fetchImpl(root + url.pathname + url.search, {
        method: req.method, body: body || undefined, signal: AbortSignal.timeout(20000),
        headers: { 'Content-Type': 'application/json', ...(remote.token ? { Authorization: `Bearer ${remote.token}` } : {}) },
      });
      text = await r.text();
    } catch (e) {
      // the one failure a relay has of its own: the other machine does not answer
      return send(res, 502, { error: `house service unreachable at ${root}: ${e.name === 'TimeoutError' ? 'timeout' : e.message}` });
    }
    res.writeHead(r.status, { 'Content-Type': r.headers.get('content-type') || 'application/json', 'Cache-Control': 'no-store' });
    res.end(text);
  };
}

// Inside Vigie's agent, which listens on 127.0.0.1 only: its own service, or the relay to another.
const mount = (cfg, { baseDir } = {}) => cfg && cfg.remote && cfg.remote.url ? relay(cfg.remote) : handler(cfg, { open: true, baseDir });

function start(cfg, log = console.log, baseDir) {
  const host = cfg.host || '127.0.0.1', port = cfg.port || DEFAULT_PORT;
  const open = isLoopback(host);
  // Reachable from the network without a token: anyone on the Wi-Fi could switch the heating.
  if (!open && !withEnv(cfg).token) throw new Error(`house: a token is required to listen on ${host} (house.token or HOUSE_TOKEN)`);
  const handle = handler(cfg, { open, baseDir });
  const server = http.createServer(async (req, res) => {
    if (!req.url.startsWith(PREFIX)) return send(res, 404, { error: 'not found' });
    try {
      await handle(req, res);
    } catch (e) {
      // the one catch-all: a bug answers 500 instead of dropping the connection
      console.error(`house: ${req.method} ${req.url.split('?')[0]}: ${e.message}`);
      send(res, 500, { error: 'internal error' });
    }
  });
  server.listen(port, host, () => log(`house: http://${host}:${port}${PREFIX}`));
  return server;
}

if (require.main === module) {
  const file = process.env.HOUSE_CONFIG || path.join(__dirname, '..', 'config.json');
  let cfg;
  try {
    cfg = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    console.error(`house: cannot read ${file}: ${e.message}`);
    process.exit(1);
  }
  if (!cfg.house) {
    console.error(`house: ${file} has no "house" section`);
    process.exit(1);
  }
  try {
    start(cfg.house, console.log, path.dirname(path.resolve(file)));
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }
}

module.exports = { mount, start, handler, relay, withEnv, buildDrivers, buildHome, moduleList, MODULES, PREFIX };
