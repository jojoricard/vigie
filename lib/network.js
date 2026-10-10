/* Internet latency, measured with every sample.
 * No ICMP without a privileged socket, so we time a TCP connection to a public
 * resolver. What matters is the variation, not the absolute value.
 * A failure is null, which feeds the loss rate. Above LOSS_MS it is also a failure:
 * Windows retransmits the SYN after one second, so ~1000 ms + RTT is a lost packet,
 * not latency. */
const net = require('net');
const ctx = require('./context');
const { DAY_MS, storeRange, colValues } = require('./storage');

const LOSS_MS = 800;
const target = () => ({ host: '1.1.1.1', port: 443, timeout: 2000, ...(ctx.cfg.network || {}) });

function pingTcp() {
  const { host, port, timeout } = target();
  return new Promise((resolve) => {
    const t0 = process.hrtime.bigint();
    const sock = new net.Socket();
    let done = false;
    const finish = (v) => { if (done) return; done = true; sock.destroy(); resolve(v); };
    sock.setTimeout(timeout);
    sock.once('connect', () => {
      const ms = Math.round(Number(process.hrtime.bigint() - t0) / 1e6);
      finish(ms > LOSS_MS ? null : ms);
    });
    sock.once('timeout', () => finish(null));
    sock.once('error', () => finish(null));   // a failed connection is a measured loss, not an error
    sock.connect(port, host);
  });
}

/* 24 h summary for the Network card. Losses only count from the first latency
 * measurement: older samples have no `pi` and would look like losses. */
function networkSummary() {
  const now = Date.now();
  const host = target().host;
  const firstPing = ctx.db.prepare('SELECT MIN(t) AS t FROM samples WHERE pi IS NOT NULL').get().t;
  // No successful measurement yet: hide the card rather than show 100 % loss.
  if (!firstPing) return { latest: null, samples: 0, target: host };
  const rows = storeRange(Math.max(now - DAY_MS, firstPing), now);
  if (!rows.length) return { latest: null, samples: 0, target: host };
  const vals = colValues(rows, 'pi');
  // jitter: mean gap between two consecutive measurements, what you feel in games
  let jitter = null;
  if (vals.length > 2) {
    let s = 0;
    for (let i = 1; i < vals.length; i++) s += Math.abs(vals[i] - vals[i - 1]);
    jitter = Math.round(s / (vals.length - 1));
  }
  const avg = vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null;
  return {
    // last successful measurement: one failure must not make the line look dead,
    // it is reported separately by `failingNow`.
    latest: vals.length ? vals[vals.length - 1] : null,
    failingNow: rows[rows.length - 1].pi == null,
    avg: avg != null ? Math.round(avg) : null,
    max: vals.length ? Math.max(...vals) : null,
    jitter,
    loss: Math.round(((rows.length - vals.length) / rows.length) * 1000) / 10,
    samples: rows.length,
    target: host,
  };
}

module.exports = { pingTcp, networkSummary };
