/* Services watched from the Machine tab (router, NAS, websites), checked every 5 min.
 * config.json: services: [{ name, url }], an http(s) URL each.
 * Any HTTP answer below 500 means the server is up: a 401 or 403 still comes from it.
 * 500 and above is a server error, no answer at all means down. */
const ctx = require('./context');
const { request, SourceError } = require('./errors');

const stateOf = (status) => status == null ? 'down' : status >= 500 ? 'error' : 'up';
const nameOf = (s) => s.name || new URL(s.url).host;

const states = new Map();   // url -> { state, status, ms, since }

async function check(s) {
  const t = Date.now();
  let status = null;
  try {
    status = (await request(s.url, { timeout: 10000 })).status;
  } catch (e) {
    if (!(e instanceof SourceError)) throw e;
  }
  const state = stateOf(status);
  const prev = states.get(s.url);
  states.set(s.url, { state, status, ms: status == null ? null : Date.now() - t, since: prev && prev.state === state ? prev.since : t });
}

const checkServices = () => Promise.all((ctx.cfg.services || []).map(check));

// The order of the config, with the state of the last check (none yet right after start).
const services = () => (ctx.cfg.services || []).map((s) => ({ name: nameOf(s), ...(states.get(s.url) || { state: null }) }));

module.exports = { stateOf, checkServices, services };
