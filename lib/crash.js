/* Last crash analysis: Windows event log + the samples recorded before it. */
const { psIsolated } = require('./powershell');
const { DAY_MS, storeRange, colValues } = require('./storage');

const PS_EVENTS =
  "$a = Get-WinEvent -FilterHashtable @{LogName='System'; Id=41,1001,6008; StartTime=(Get-Date).AddDays(-30)} -MaxEvents 40 -ErrorAction SilentlyContinue; " +
  "$b = Get-WinEvent -FilterHashtable @{LogName='System'; ProviderName='Microsoft-Windows-WHEA-Logger'; StartTime=(Get-Date).AddDays(-30)} -MaxEvents 20 -ErrorAction SilentlyContinue; " +
  "@($a) + @($b) | Where-Object { $_ } | ForEach-Object { [pscustomobject]@{ " +
  "t = ([DateTimeOffset]$_.TimeCreated).ToUnixTimeMilliseconds(); id = $_.Id; src = $_.ProviderName; " +
  "msg = $(if ($_.Message) { $m = $_.Message -replace '\\s+', ' '; $m.Substring(0, [Math]::Min(300, $m.Length)) } else { '' }) " +
  "} } | ConvertTo-Json -Compress";

/* Freeze or power cut? The black box's silence tells.
 * Samples stopping minutes before the logged shutdown: the machine had already
 * stopped responding, it froze (look at the graphics driver). Samples up to the
 * end: a hard power cut (look at the power supply). The thresholds follow the 30 s
 * sampling: 75 s allows one late sample, 120 s is four missed ones. */
function natureFromSilence(silence) {
  if (silence == null) return 'unknown';
  return silence <= 75 ? 'cut' : silence >= 120 ? 'freeze' : 'undetermined';
}

// With no sample in the half hour before, no conclusion: the agent may not have been running.
function incidentNature(t) {
  const rows = storeRange(t - 30 * 60 * 1000, t);
  const silence = rows.length ? Math.round((t - rows[rows.length - 1].t) / 1000) : null;
  return { nature: natureFromSilence(silence), silence };
}

function incidentType(e) {
  if (e.id === 1001) return 'bsod';
  if (/WHEA/i.test(e.src || '')) return 'hardware';
  if (e.id === 6008) return 'unexpected';
  return 'powerLoss';        // 41: shut down without a clean stop (includes a manual reset)
}

// Hints are codes with their figures: the page writes the sentence in its language.
function crashHints(inc, samples, nat) {
  const peak = (k) => { const v = colValues(samples, k); return v.length ? Math.max(...v) : -1; };
  const hints = [];
  const maxC = peak('c'), maxG = peak('g'), maxL = peak('l'), maxR = Math.max(peak('r'), peak('rf'));
  if (nat.nature === 'freeze') hints.push({ kind: 'freeze', silence: nat.silence });
  if (nat.nature === 'cut') hints.push({ kind: 'cut', silence: nat.silence });
  if (maxC >= 90) hints.push({ kind: 'cpuHot', temp: Math.round(maxC) });
  if (maxG >= 95) hints.push({ kind: 'gpuHot', temp: Math.round(maxG) });
  if (maxL >= 48) hints.push({ kind: 'liquidHot', temp: maxL });
  if (maxR >= 95) hints.push({ kind: 'ramFull', pct: Math.round(maxR) });
  const bug = inc.id === 1001 ? ((inc.msg || '').match(/0x[0-9a-f]{8}/i) || [])[0] : null;
  if (bug) hints.push({ kind: 'bsod', code: bug });
  if (/WHEA/i.test(inc.src || '')) hints.push({ kind: 'whea' });
  if (nat.nature === 'unknown') hints.push({ kind: 'noData' });
  return { hints, bugcheck: bug };
}

let crashCache = { at: 0, data: null };
async function crashReport() {
  if (crashCache.data && Date.now() - crashCache.at < 15 * 60 * 1000) return crashCache.data;
  const events = (await psIsolated(PS_EVENTS) || []).filter((e) => e && e.t).sort((a, b) => b.t - a.t);
  let report = null;
  const inc = events[0];
  if (inc) {
    const samples = storeRange(inc.t - 15 * 60 * 1000, inc.t);
    const nat = incidentNature(inc.t);
    report = { at: inc.t, id: inc.id, type: incidentType(inc), ...crashHints(inc, samples, nat), samples: samples.slice(-10), ...nat };
  }
  // Deduplication: one shutdown often logs a 41 and a 6008 a few seconds apart.
  const history = [];
  for (const e of events) {
    const prev = history[history.length - 1];
    if (prev && Math.abs(prev.t - e.t) < 5 * 60 * 1000) continue;
    history.push({ t: e.t, type: incidentType(e), ...incidentNature(e.t) });
  }
  // Counters computed on the full list: the one sent to the page is cut to 12 rows.
  const now = Date.now();
  const last30 = history.filter((h) => now - h.t < 30 * DAY_MS);
  const counts = {
    d30: last30.length,
    d7: history.filter((h) => now - h.t < 7 * DAY_MS).length,
    last: history.length ? history[0].t : null,
    natures: last30.reduce((a, h) => { if (h.nature !== 'unknown') a[h.nature] = (a[h.nature] || 0) + 1; return a; }, {}),
  };
  crashCache = { at: now, data: { report, counts, history: history.slice(0, 12) } };
  return crashCache.data;
}

module.exports = { natureFromSilence, incidentType, crashReport };
