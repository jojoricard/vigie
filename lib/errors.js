/* An external source failing (network down, timeout, HTTP error, bad payload) is
 * expected and gets its own error type. That is the only error the modules catch:
 * anything else is a bug and propagates. */
class SourceError extends Error {}

const hostOf = (url) => { try { return new URL(url).host; } catch { return String(url); } };

// Network failures become a SourceError, any HTTP status comes back to the caller.
async function request(url, { timeout = 10000, ...opts } = {}) {
  let res, text;
  try {
    res = await fetch(url, { ...opts, signal: AbortSignal.timeout(timeout) });
    text = await res.text();
  } catch (e) {
    throw new SourceError(`${hostOf(url)}: ${e.name === 'TimeoutError' ? 'timeout' : e.message}`);
  }
  return { status: res.status, ok: res.ok, text };
}

const parseJson = (text, url) => {
  try { return JSON.parse(text); } catch { throw new SourceError(`${hostOf(url)}: invalid JSON`); }
};

async function fetchText(url, opts) {
  const r = await request(url, opts);
  if (!r.ok) throw new SourceError(`${hostOf(url)}: HTTP ${r.status}`);
  return r.text;
}

async function fetchJson(url, opts) {
  return parseJson(await fetchText(url, opts), url);
}

// At most one line per context and per hour: an unreachable source must leave a
// trace without flooding the console every 30 s. Messages never include headers,
// so API keys can't end up here.
const lastLogged = new Map();
function logError(context, err) {
  const now = Date.now();
  if (now - (lastLogged.get(context) || 0) < 3600e3) return;
  lastLogged.set(context, now);
  console.error(`Vigie: ${context}: ${err && err.message ? err.message : err}`);
}

// Runs fn and turns a SourceError into null (logged). Any other error propagates.
async function orNull(context, fn) {
  try {
    return await fn();
  } catch (e) {
    if (!(e instanceof SourceError)) throw e;
    logError(context, e);
    return null;
  }
}

module.exports = { SourceError, request, parseJson, fetchText, fetchJson, logError, orNull };
