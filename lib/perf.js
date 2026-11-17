/* What the agent costs, for GET /perf: its CPU and memory since it started and over the
 * last minute, the memory every ten minutes over a day (a leak shows as a line that only
 * climbs), and the time each scheduled job, each source and each route takes. */
const started = Date.now();
const cpuAtStart = process.cpuUsage();
const stats = new Map();      // name -> { n, total, max, last }
const memory = [];            // { t, rssMB, heapMB }, one every 10 min, 24 h kept
let minute = { t: Date.now(), cpu: process.cpuUsage(), pct: null };

const mb = (b) => Math.round((b / 1048576) * 10) / 10;
function note(name, ms) {
  const s = stats.get(name) || { n: 0, total: 0, max: 0, last: 0 };
  s.n++; s.total += ms; s.max = Math.max(s.max, ms); s.last = ms;
  stats.set(name, s);
}
// Times a promise (or a value) under a name.
function timed(name, fn) {
  const t0 = performance.now();
  let out;
  try { out = fn(); } catch (e) { note(name, performance.now() - t0); throw e; }
  if (!out || typeof out.then !== 'function') { note(name, performance.now() - t0); return out; }
  return out.finally(() => note(name, performance.now() - t0));
}

function sampleMemory() {
  const m = process.memoryUsage();
  memory.push({ t: Date.now(), rssMB: mb(m.rss), heapMB: mb(m.heapUsed) });
  while (memory.length > 144) memory.shift();
}
function tickMinute() {
  const now = Date.now(), cpu = process.cpuUsage(minute.cpu);
  minute = { t: now, cpu: process.cpuUsage(), pct: Math.round(((cpu.user + cpu.system) / 1000 / (now - minute.t)) * 1000) / 10 };
}
sampleMemory();
setInterval(sampleMemory, 10 * 60 * 1000).unref();
setInterval(tickMinute, 60 * 1000).unref();

function snapshot() {
  const up = (Date.now() - started) / 1000, cpu = process.cpuUsage(cpuAtStart), m = process.memoryUsage();
  return {
    uptimeMin: Math.round(up / 6) / 10,
    cpuPct: { sinceStart: Math.round(((cpu.user + cpu.system) / 1e6 / up) * 1000) / 10, lastMinute: minute.pct },
    memoryMB: { rss: mb(m.rss), heap: mb(m.heapUsed), external: mb(m.external) },
    memoryEvery10Min: memory,
    timings: Object.fromEntries([...stats].sort((a, b) => b[1].total - a[1].total).map(([k, s]) => [k, {
      count: s.n, avgMs: Math.round((s.total / s.n) * 10) / 10, maxMs: Math.round(s.max), lastMs: Math.round(s.last),
      perMinute: Math.round((s.n / Math.max(1, up / 60)) * 10) / 10,
    }])),
  };
}

module.exports = { timed, note, snapshot };
