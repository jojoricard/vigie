/*
 * Vigie local agent (Node 22.13+, no npm dependency).
 * Serves the page in public/ and a JSON API on 127.0.0.1. The logic lives in lib/,
 * this file only wires config, routes and scheduled jobs.
 */
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');

const ctx = require('./lib/context');
const { SourceError, logError } = require('./lib/errors');
const storage = require('./lib/storage');
const sensors = require('./lib/sensors');
const { pingTcp, networkSummary } = require('./lib/network');
const { topProcesses, devices } = require('./lib/system');
const weather = require('./lib/weather');
const energy = require('./lib/energy');
const { crashReport } = require('./lib/crash');
const { changes, markers } = require('./lib/changes');
const machine = require('./lib/machine');
const house = require('./lib/house');
const { briefing } = require('./lib/briefing');
const { holidays } = require('./lib/calendar');
const { fuel } = require('./lib/fuel');
const { checkServices, services } = require('./lib/services');
const { windowsStatus } = require('./lib/windows');
const media = require('./lib/media');

/* ---------- Config ---------- */
function fail(message) {
  console.error('Vigie: ' + message);
  process.exit(1);
}

function loadConfig(file) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;
    fail('config.json not found. Copy config.example.json to config.json, then edit it.');
  }
  let cfg;
  try { cfg = JSON.parse(text); } catch (e) { fail(`config.json is not valid JSON: ${e.message}`); }
  if (!Array.isArray(cfg.cities) || !cfg.cities.length) fail('config.json: "cities" must list at least one city.');
  return cfg;
}

ctx.root = __dirname;
ctx.cfg = loadConfig(path.join(__dirname, 'config.json'));
ctx.lang = ctx.cfg.lang === 'fr' ? 'fr' : 'en';
ctx.db = storage.openDatabase(path.join(__dirname, 'vigie.db'));
const PORT = ctx.cfg.port || 5252;

/* ---------- Static files ----------
 * Only the files found in public/ at startup are served, through a fixed table:
 * no path from the request ever reaches the file system, so config.json and
 * vigie.db can't leak. */
const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.png': 'image/png', '.svg': 'image/svg+xml' };
const PUBLIC = path.join(__dirname, 'public');
const staticFiles = new Map();
for (const rel of fs.readdirSync(PUBLIC, { recursive: true })) {
  const file = path.join(PUBLIC, rel);
  if (MIME[path.extname(file)] && fs.statSync(file).isFile()) staticFiles.set('/' + rel.split(path.sep).join('/'), file);
}
staticFiles.set('/', path.join(PUBLIC, 'index.html'));

/* ---------- HTTP ---------- */
// No Access-Control-Allow-Origin header: the page is same-origin. A "*" would make
// every answer readable by any page open in the browser.
function send(res, code, body, type = 'application/json') {
  res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  res.end(type === 'application/json' ? JSON.stringify(body) : body);
}

/* Anti-CSRF guard for the routes that act (link, lights, air conditioners, paid
 * model call). A "simple" POST (text/plain) goes out without a CORS preflight: the
 * browser only blocks reading the answer, the command has already run. No Origin
 * header means a local client (curl), not a third-party page. */
function sameOrigin(req) {
  const o = req.headers.origin;
  if (!o) return true;
  if (!URL.canParse(o)) return false;
  const h = new URL(o).hostname;
  return h === 'localhost' || h === '127.0.0.1' || h === '[::1]';
}

function readJson(req) {
  return new Promise((resolve) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      try { resolve(JSON.parse(body)); } catch { resolve(null); }   // invalid body: answered with a 400
    });
  });
}

const GET = {
  '/config': () => ({
    lang: ctx.lang,
    country: ctx.cfg.country || null,
    cities: ctx.cfg.cities,
    snowSpots: ctx.cfg.snowSpots || [],
    dimming: ctx.cfg.dimming || null,
    theme: ctx.cfg.theme || null,
    hasBriefing: !!ctx.cfg.anthropicApiKey,
  }),
  '/sensors': sensors.readSensors,
  '/system': async () => ({ uptime: os.uptime(), processes: await topProcesses() }),
  '/devices': devices,
  '/alerts': weather.alerts,
  '/nameday': weather.nameDay,
  '/energy': async () => ({ ...(await energy.energy()), normals: await weather.seasonalNormals() }),
  '/network': networkSummary,
  '/changes': changes,
  '/markers': markers,
  '/year': energy.year,
  '/crash': crashReport,
  '/machine': machine.machine,
  '/tools': () => ctx.cfg.tools || [],
  '/releases': machine.releases,
  '/house': house.house,
  '/holidays': holidays,
  '/fuel': fuel,
  '/services': services,
  '/windows': windowsStatus,
  '/media': media.nowPlaying,
};

// Routes that act: POST only, same origin only.
const POST = {
  // Default browser (main screen), not the kiosk. Known links only.
  '/open': async (url) => {
    const u = url.searchParams.get('url');
    if (!u || !machine.knownToolUrls().has(u)) return [404, { error: 'unknown link' }];
    execFile('rundll32', ['url.dll,FileProtocolHandler', u], { windowsHide: true }, (err) => { if (err) logError('/open', err); });
    return [200, { ok: true }];
  },
  '/briefing': async (url, body) => [200, await briefing(body)],
  '/media': async (url, b) => [200, { ok: await media.mediaAction(b.action) }],
  '/house/govee': async (url, b) => {
    // Device checked against the list given by Govee, capability limited to GOVEE_CAP_TYPE.
    if (!(await house.isKnownGovee(b.device, b.sku)) || !house.GOVEE_CAP_TYPE[b.instance]) return [400, { error: 'unknown device or capability' }];
    let value = b.value;
    if (b.instance === 'colorTemperatureK') value = Math.min(9000, Math.max(2000, Number(value)));
    if (b.instance === 'colorRgb') value = Math.min(0xffffff, Math.max(0, Number(value) || 0));
    if (b.instance === 'lightScene' || b.instance === 'diyScene') {
      // id/paramId taken from a scene Govee listed for this device, never from the page.
      const match = (await house.goveeScenes(b.sku, b.device)).find((s) => s.id === (value && value.id));
      if (!match) return [400, { error: 'unknown scene' }];
      value = { id: match.id, paramId: match.paramId };
    }
    await house.goveeControl(b.device, b.sku, b.instance, value);
    house.invalidateHouse();
    return [200, await house.house()];
  },
  '/house/daikin': async (url, b) => {
    if (!house.isKnownDaikin(b.name)) return [400, { error: 'unknown unit' }];
    await house.daikinControl(b.name, b);
    house.invalidateHouse();
    return [200, await house.house()];
  },
};

async function route(req, res) {
  const url = new URL(req.url, 'http://localhost');
  const p = url.pathname;
  if (req.method === 'GET' && staticFiles.has(p)) {
    const file = staticFiles.get(p);
    return send(res, 200, fs.readFileSync(file), MIME[path.extname(file)]);
  }
  if (req.method === 'GET' && GET[p]) return send(res, 200, await GET[p](url));
  if (req.method === 'GET' && p === '/history') return send(res, 200, history(url.searchParams.get('range')));
  if (req.method === 'GET' && p === '/house/govee/scenes') {
    const device = url.searchParams.get('device'), sku = url.searchParams.get('sku');
    if (!(await house.isKnownGovee(device, sku))) return send(res, 400, { error: 'unknown device' });
    return send(res, 200, await house.goveeScenes(sku, device));
  }
  if (req.method === 'POST' && POST[p]) {
    if (!sameOrigin(req)) return send(res, 403, { error: 'origin refused' });
    const body = p === '/open' ? {} : await readJson(req);
    if (!body) return send(res, 400, { error: 'invalid JSON body' });
    const [code, out] = await POST[p](url, body);
    return send(res, code, out);
  }
  send(res, 404, { error: 'not found' });
}

const server = http.createServer(async (req, res) => {
  try {
    await route(req, res);
  } catch (e) {
    // A source that fails while the page waits (sensors, a light) is a 502 with its
    // reason. Anything else is a bug: 500, logged.
    if (e instanceof SourceError) return send(res, 502, { error: e.message });
    logError(req.url, e);
    send(res, 500, { error: String(e.message || e) });
  }
});

/* ---------- Chart history ---------- */
// 30 d = all of vigie.db's retention, enough to see an old update on the chart.
const HIST_RANGES = { '1h': 3600e3, '6h': 6 * 3600e3, '12h': 12 * 3600e3, '1d': storage.DAY_MS, '7d': 7 * storage.DAY_MS, '30d': 30 * storage.DAY_MS };
// Series returned, in the column order of each point (after the time). A new series
// goes at the end, or the page's column indexes shift.
const HIST_KEYS = ['c', 'g', 'l', 'cl', 'gl', 'rf', 'nd', 'nu', 'd', 'fg', 'fs', 'pc', 'pg', 'pi'];

function history(rangeKey) {
  const rangeMs = HIST_RANGES[rangeKey] || HIST_RANGES['1d'];
  const now = Date.now();
  // Bucket sized on the number of samples, not on the range width: with the PC off
  // half the time, 600 time slices would give far fewer points. AVG() skips NULLs.
  const n = ctx.db.prepare('SELECT COUNT(*) AS n FROM samples WHERE t >= ? AND t <= ?').get(now - rangeMs, now).n;
  const bucket = Math.max(30000, Math.round(n / 600) * 30000);
  const samples = ctx.db.prepare(
    `SELECT CAST(t / ? AS INTEGER) AS b, ${HIST_KEYS.map((k) => `AVG(${k}) AS ${k}`).join(', ')}
     FROM samples WHERE t >= ? AND t <= ? GROUP BY b ORDER BY b`).all(bucket, now - rangeMs, now)
    .map((r) => [r.b * bucket, ...HIST_KEYS.map((k) => r[k] == null ? null : Math.round(r[k] * 10) / 10)]);
  // today's min/max temperatures (for the gauges), independent of the displayed range
  const start = new Date(); start.setHours(0, 0, 0, 0);
  const j = ctx.db.prepare('SELECT MIN(c) AS cn, MAX(c) AS cx, MIN(g) AS gn, MAX(g) AS gx FROM samples WHERE t >= ? AND t <= ?').get(start.getTime(), now);
  const mm = (a, b) => a == null ? null : [Math.round(a), Math.round(b)];
  return { rangeMs, bucket, samples, today: { c: mm(j.cn, j.cx), g: mm(j.gn, j.gx) } };
}

/* ---------- Scheduled jobs ---------- */
async function sample() {
  const rec = { t: Date.now() };
  const parsed = await sensors.readSensors().catch((e) => { if (!(e instanceof SourceError)) throw e; logError('LibreHardwareMonitor', e); return null; });
  if (parsed) Object.assign(rec, sensors.toSample(parsed));
  rec.rf = Math.round((1 - os.freemem() / os.totalmem()) * 1000) / 10; // RAM % seen by the OS
  rec.pi = await pingTcp();                                            // internet latency (ms), null on failure
  storage.storeAdd(rec);
}

// The one generic catch of the scheduler: a failing job must not take the server
// down, it is logged and runs again at its next turn.
function every(ms, name, fn) {
  const run = () => Promise.resolve().then(fn).catch((e) => logError(name, e));
  run();
  setInterval(run, ms);
}

every(30000, 'sample', sample);
every(3600 * 1000, 'trim', storage.storeTrim);
energy.backfillDaily();
// Daily summary recomputed often so it runs before the samples are purged.
every(10 * 60 * 1000, 'daily', energy.rollupDaily);
// Disk space: one reading per hour, the day keeps the median (disk drop alert).
every(3600 * 1000, 'disk', energy.rollupDisk);
every(3600 * 1000, 'backup', storage.backupDaily);
every(5 * 60 * 1000, 'services', checkServices);

server.listen(PORT, '127.0.0.1', () => {
  console.log(`Vigie: http://localhost:${PORT}`);
});
