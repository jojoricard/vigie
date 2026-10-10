/* Sample storage in vigie.db (native SQLite, Node 22.13+).
 * `samples`: one row every 30 s, kept 30 days.
 * `daily`: one row per day, never purged, for month and year comparisons.
 * `disk`: raw hourly free space readings, `daily.free` keeps the day's median. */
const fs = require('fs');
const path = require('path');
const ctx = require('./context');

const DAY_MS = 24 * 3600 * 1000;
const KEEP_MS = 30 * DAY_MS;
const COLS = ['c', 'g', 'l', 'r', 'cl', 'gl', 'd', 'rf', 'nd', 'nu', 'fg', 'fs', 'pc', 'pg', 'pi'];

// Local YYYY-MM-DD. toISOString() would give UTC, still yesterday between local and UTC midnight.
const dayKey = (d) => d.toLocaleDateString('fr-CA');
const colValues = (rows, key) => rows.map((s) => s[key]).filter((x) => x != null);

function openDatabase(file) {
  let DatabaseSync;
  try {
    ({ DatabaseSync } = require('node:sqlite'));
  } catch (e) {
    if (e.code !== 'ERR_UNKNOWN_BUILTIN_MODULE') throw e;
    console.error(`Vigie needs Node 22.13 or later (node:sqlite), this is ${process.version}.`);
    process.exit(1);
  }
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA synchronous = NORMAL');
  db.exec(`CREATE TABLE IF NOT EXISTS samples (t INTEGER PRIMARY KEY, ${COLS.map((c) => c + ' REAL').join(', ')})`);
  db.exec('CREATE TABLE IF NOT EXISTS daily (d TEXT PRIMARY KEY, kwh REAL, hours REAL, tc REAL, tg REAL, updated INTEGER, free REAL, total REAL)');
  db.exec('CREATE TABLE IF NOT EXISTS disk (t INTEGER PRIMARY KEY, free REAL, total REAL)');
  return db;
}

let stInsert = null;
function storeAdd(rec) {
  stInsert = stInsert || ctx.db.prepare(`INSERT OR REPLACE INTO samples (t, ${COLS.join(', ')}) VALUES (?${', ?'.repeat(COLS.length)})`);
  stInsert.run(rec.t, ...COLS.map((c) => rec[c] ?? null));
}

const storeRange = (a, b) => ctx.db.prepare('SELECT * FROM samples WHERE t >= ? AND t <= ? ORDER BY t').all(a, b);
const storeTrim = () => ctx.db.prepare('DELETE FROM samples WHERE t < ?').run(Date.now() - KEEP_MS);

// Median of a column over a time range. `cond` always comes from a constant in the
// code, never from outside input.
function sqlMedian(col, a, b, cond = '') {
  const where = `FROM samples WHERE t>=? AND t<=? AND ${col} IS NOT NULL ${cond}`;
  const n = ctx.db.prepare(`SELECT COUNT(${col}) AS n ${where}`).get(a, b).n;
  if (!n) return { n: 0, med: null };
  const r = ctx.db.prepare(`SELECT ${col} AS v ${where} ORDER BY ${col} LIMIT 1 OFFSET ?`).get(a, b, Math.floor(n / 2));
  return { n, med: r ? r.v : null };
}

// One copy of the database per day in backups/, the last 7 kept: the daily table is the
// only history beyond 30 days. VACUUM INTO writes a consistent copy while the agent keeps
// writing to the live file.
const BACKUP_KEEP = 7;
function backupDaily() {
  const dir = path.join(ctx.root, 'backups');
  const file = path.join(dir, `vigie-${dayKey(new Date())}.db`);
  if (fs.existsSync(file)) return;
  fs.mkdirSync(dir, { recursive: true });
  ctx.db.exec(`VACUUM INTO '${file.replace(/'/g, "''")}'`);
  const copies = fs.readdirSync(dir).filter((f) => /^vigie-\d{4}-\d{2}-\d{2}\.db$/.test(f)).sort();
  for (const f of copies.slice(0, -BACKUP_KEEP)) fs.unlinkSync(path.join(dir, f));
}

module.exports = { DAY_MS, dayKey, colValues, openDatabase, storeAdd, storeRange, storeTrim, sqlMedian, backupDaily };
