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
const demo = require('./drivers/demo');
const plan = require('./plan');

const PREFIX = '/api/v1';
const DEFAULT_PORT = 5253;

function withEnv(cfg, env = process.env) {
  const out = { ...cfg, token: env.HOUSE_TOKEN || cfg.token || '' };
  if (env.HOUSE_PLAN) out.planPath = env.HOUSE_PLAN;
  if (cfg.govee || env.GOVEE_API_KEY) out.govee = { ...cfg.govee, apiKey: env.GOVEE_API_KEY || (cfg.govee || {}).apiKey || '' };
  if (cfg.cozytouch || env.COZYTOUCH_USERNAME) {
    out.cozytouch = { ...cfg.cozytouch, username: env.COZYTOUCH_USERNAME || (cfg.cozytouch || {}).username, password: env.COZYTOUCH_PASSWORD || (cfg.cozytouch || {}).password };
  }
  return out;
}

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
  return drivers;
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
  const service = createService(cfg, drivers || buildDrivers(cfg), { readPlan: planFile ? (ids) => plan.load(planFile, ids) : null });
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

// Inside Vigie's agent, which listens on 127.0.0.1 only.
const mount = (cfg) => handler(cfg, { open: true });

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

module.exports = { mount, start, handler, withEnv, buildDrivers, PREFIX };
