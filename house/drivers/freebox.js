/* The Freebox of the home, on its local API (Freebox OS, no account with Free): who is
 * in, from the phones it sees on its network, and how the line is doing: its state, what
 * goes through it now, the last time it dropped.
 * The box accepts an application once, by a press on its own screen: `node
 * house/pair-freebox.js` asks, and prints the token to put in the config.
 * Config: house.freebox = { host: "mafreebox.freebox.fr", appToken: "…",
 *   people: [{ id: "alex", name: "Alex", devices: ["AA:BB:CC:DD:EE:FF"] }] }
 * Off until `appToken` is set. People are named in the config and nowhere else. */
const crypto = require('crypto');
const os = require('os');
const { DeviceError, request, parseJson } = require('../util');

const APP = { app_id: 'fr.vigie.house', app_name: 'Vigie', app_version: '1.0' };
const TTL_MS = 30000;
// A phone asleep on Wi-Fi goes quiet for minutes without having left the home.
const GRACE_MS = 10 * 60 * 1000;

// The password of a session: the challenge of the box, signed with the token of the application.
const sign = (appToken, challenge) => crypto.createHmac('sha1', appToken).update(challenge).digest('hex');

const mac = (s) => String(s || '').toUpperCase().replace(/-/g, ':');

// The IPv4 address of a host of the box, the one in use first. null when the box gives none.
const ipv4 = (h) => {
  const v4 = (h.l3connectivities || []).filter((c) => c && c.af === 'ipv4' && c.addr);
  return (v4.find((c) => c.active) || v4[0] || {}).addr || null;
};

/* Who is home: a person is in when one of their devices is active on the network, or
 * was within the grace time. hosts are the entries of the LAN browser. Pure. */
function presence(people, hosts, nowMs) {
  const byMac = new Map((hosts || []).map((h) => [mac(h.l2ident && h.l2ident.id), h]));
  return (people || []).map((p) => {
    const seen = (p.devices || []).map((d) => byMac.get(mac(d))).filter(Boolean);
    const last = Math.max(0, ...seen.map((h) => Math.max(h.last_activity || 0, h.last_time_reachable || 0) * 1000));
    const home = seen.some((h) => h.active) || nowMs - last < GRACE_MS;
    return { id: p.id, name: p.name, home, lastSeen: last || null };
  });
}

/* The last time the line dropped, from the log of the box: the latest "down" entry and
 * the "up" that followed. Entries are { type, state, date } with the date in seconds. Pure. */
function lastOutage(logs) {
  const sorted = (logs || []).filter((e) => e && e.date && (e.state === 'down' || e.state === 'up')).sort((a, b) => a.date - b.date);
  for (let i = sorted.length - 1; i >= 0; i--) {
    if (sorted[i].state !== 'down') continue;
    const back = sorted.slice(i + 1).find((e) => e.state === 'up');
    return { at: sorted[i].date * 1000, minutes: back ? Math.max(1, Math.round((back.date - sorted[i].date) / 60)) : null };
  }
  return null;
}

/* What goes through the line, in bytes a second. The box gives rate_down and rate_up, a
 * reading of the moment (bytes a second: bandwidth_* are in bits), and bytes_down and
 * bytes_up, counted since the line came up. A reading of the moment, taken once every
 * half minute, catches a page or a stream between two bursts and says 0 while the PC
 * shows megabytes a second: the counters, read twice, give what really went through in
 * between. The moment's reading stands in for the first one, and when the counters went
 * back (the line came up again). prev: { at, down, up } of the last reading. Pure. */
function lineRate(prev, conn, atMs) {
  const down = Number(conn.bytes_down), up = Number(conn.bytes_up);
  const counters = Number.isFinite(down) && Number.isFinite(up) ? { at: atMs, down, up } : null;
  const seconds = prev && counters ? (atMs - prev.at) / 1000 : 0;
  const usable = seconds >= 2 && seconds <= 600 && down >= prev.down && up >= prev.up;
  return {
    rateDown: usable ? Math.round((down - prev.down) / seconds) : conn.rate_down ?? null,
    rateUp: usable ? Math.round((up - prev.up) / seconds) : conn.rate_up ?? null,
    counters,
  };
}

function create({ host = 'mafreebox.freebox.fr', appToken, people = [], fetchImpl = fetch, now = Date.now } = {}) {
  let base = null, session = null, cache = null, counters = null;

  async function api(method, route, body, token) {
    if (!base) {
      const v = parseJson('freebox', (await request('freebox', `http://${host}/api_version`, {}, fetchImpl)).text);
      base = `http://${host}${v.api_base_url || '/api/'}v${parseInt(v.api_version, 10) || 8}`;
    }
    const r = await request('freebox', base + route, { method, headers: { 'Content-Type': 'application/json', ...(token ? { 'X-Fbx-App-Auth': token } : {}) }, body: body ? JSON.stringify(body) : undefined }, fetchImpl);
    const j = parseJson('freebox', r.text);
    if (!j.success) throw Object.assign(new DeviceError(`freebox: ${j.msg || j.error_code || `HTTP ${r.status}`}`), { code: j.error_code });
    return j.result;
  }

  // One login at a time: the three questions of a reading share it instead of opening three sessions.
  let opening = null;
  function login() {
    if (opening) return opening;
    opening = (async () => {
      if (!appToken) throw new DeviceError('freebox: not paired (node house/pair-freebox.js)');
      const { challenge } = await api('GET', '/login/');
      session = (await api('POST', '/login/session/', { app_id: APP.app_id, password: sign(appToken, challenge) })).session_token;
    })().finally(() => { opening = null; });
    return opening;
  }
  // A session ends by itself after a while: one new login, then the same question again.
  async function ask(route) {
    if (!session) await login();
    const used = session;
    try {
      return await api('GET', route, null, used);
    } catch (e) {
      if (!(e instanceof DeviceError) || e.code !== 'auth_required') throw e;
      // another question may already be opening the new session: it is shared
      if (session === used) session = null;
      if (!session) await login();
      return api('GET', route, null, session);
    }
  }

  async function home() {
    if (cache && now() - cache.at < TTL_MS) return cache.value;
    const [conn, hosts, logs] = await Promise.all([
      ask('/connection/'), ask('/lan/browser/pub/'),
      // the log is a comfort: a box that does not give it still gives the rest
      ask('/connection/logs/').catch((e) => { if (!(e instanceof DeviceError)) throw e; return []; }),
    ]);
    const rate = lineRate(counters, conn, now());
    counters = rate.counters;
    const value = {
      presence: presence(people, hosts, now()),
      network: {
        state: conn.state === 'up' ? 'up' : 'down', media: conn.media || null,
        rateDown: rate.rateDown, rateUp: rate.rateUp,                                    // bytes a second
        bandwidthDown: conn.bandwidth_down ?? null, bandwidthUp: conn.bandwidth_up ?? null,   // bits a second
        lastOutage: lastOutage(logs),
      },
    };
    cache = { at: now(), value };
    return value;
  }

  /* Asks the box to accept this application. Someone has to press the arrow on its
   * screen within the minute. Resolves with the token to keep. */
  async function pair({ onPrompt = () => {}, wait = (ms) => new Promise((r) => setTimeout(r, ms)), tries = 45 } = {}) {
    const { app_token: token, track_id: track } = await api('POST', '/login/authorize/', { ...APP, device_name: os.hostname() });
    onPrompt();
    for (let i = 0; i < tries; i++) {
      await wait(2000);
      const { status } = await api('GET', `/login/authorize/${track}`);
      if (status === 'granted') return token;
      if (status !== 'pending') throw new DeviceError(`freebox: ${status === 'denied' ? 'refused on the box' : status === 'timeout' ? 'nobody pressed the button in time' : status}`);
    }
    throw new DeviceError('freebox: nobody pressed the button in time');
  }

  return { home, pair, list: async () => (await ask('/lan/browser/pub/')).map((h) => ({ name: h.primary_name, mac: h.l2ident && h.l2ident.id, active: !!h.active, ip: ipv4(h) })) };
}

module.exports = { create, sign, presence, lastOutage, lineRate };
