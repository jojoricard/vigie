/* PowerShell: one long-lived interpreter fed through stdin.
 * Starting powershell.exe costs ~1.4 s for 10 to 50 ms of actual work, so we keep
 * one interpreter alive. Commands are base64-encoded, one per line, so multi-line
 * scripts need no escaping, and a marker closes each answer.
 * The periodic [GC]::Collect() matters: the interpreter lives for weeks and its
 * memory keeps growing without it.
 * A single stdin means commands run one at a time. On timeout the interpreter is
 * killed and the next command starts a fresh one, so an answer never goes to the
 * wrong command. */
const { execFile, spawn } = require('child_process');
const { logError } = require('./errors');

const PS_ARGS = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command'];
// Without it, output uses the console code page and accents come out garbled.
const UTF8 = '[Console]::OutputEncoding = [Text.Encoding]::UTF8; ';
const PS_MARK = '<<<VIGIE-END>>>';
const PS_REPL = UTF8 +
  '$MaximumHistoryCount = 1; $n = 0; while ($true) { $l = [Console]::In.ReadLine(); if ($null -eq $l) { break }; ' +
  'if ($l) { try { Invoke-Expression ([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($l))) } catch { } }; ' +
  '$Error.Clear(); $n++; if ($n % 25 -eq 0) { [System.GC]::Collect() }; ' +
  `Write-Output '${PS_MARK}' }`;

let proc = null, buf = '', gen = 0, current = null;
const queue = [];

function start() {
  if (proc) return;
  const myGen = ++gen;                       // a dead instance must not resolve anything
  const p = spawn('powershell.exe', [...PS_ARGS, PS_REPL], { windowsHide: true });
  proc = p; buf = '';
  p.stdout.setEncoding('utf8');
  p.stdout.on('data', (c) => {
    if (myGen !== gen) return;
    buf += c;
    let i;
    while ((i = buf.indexOf(PS_MARK)) >= 0) {
      const output = buf.slice(0, i);
      buf = buf.slice(i + PS_MARK.length);
      answer(output);
    }
  });
  p.stderr.resume();                         // only stdout carries the JSON
  p.stdin.on('error', () => {});             // writing to a process that just died is expected
  const died = () => { if (myGen !== gen) return; proc = null; answer(null); };
  p.on('exit', died);
  p.on('error', (e) => { logError('PowerShell', e); died(); });
}

function kill() {
  const p = proc;
  proc = null; gen++;                        // detaches the listeners of the killed instance
  if (p) p.kill();
}

function answer(output) {
  const task = current;
  if (!task) return;
  current = null;
  clearTimeout(task.timer);
  task.resolve(output);
  send();
}

function send() {
  if (current || !queue.length) return;
  const task = queue.shift();
  start();
  current = task;
  task.timer = setTimeout(() => { logError('PowerShell', new Error('timeout, interpreter restarted')); kill(); answer(null); }, task.timeout);
  proc.stdin.write(Buffer.from(task.cmd, 'utf8').toString('base64') + '\n');
}

// Empty output means "nothing found", unreadable output is logged. Both give null.
function parseOutput(output) {
  const text = String(output || '').trim();
  if (!text) return null;
  try {
    const j = JSON.parse(text);
    return Array.isArray(j) ? j : [j];
  } catch (e) {
    if (!(e instanceof SyntaxError)) throw e;
    logError('PowerShell', new Error('unreadable output: ' + text.slice(0, 80)));
    return null;
  }
}

function ps(cmd, timeout = 20000) {
  return new Promise((resolve) => {
    queue.push({ cmd, timeout, resolve: (output) => resolve(parseOutput(output)) });
    send();
  });
}

/* Slow, rare queries (Bluetooth takes 10 s, event log and WMI a few seconds) get
 * their own process so they don't block the shared queue. The rule is frequency,
 * not duration: paying 1.4 s of startup makes sense every 30 s, not every 5 min
 * for a command that already costs 10 s. */
function psIsolated(cmd, timeout = 30000) {
  return new Promise((resolve) => {
    execFile('powershell.exe', [...PS_ARGS, UTF8 + cmd],
      { timeout, maxBuffer: 16 * 1024 * 1024, windowsHide: true },
      (err, stdout) => {
        if (err) { logError('PowerShell', err); return resolve(null); }
        resolve(parseOutput(stdout));
      });
  });
}

module.exports = { ps, psIsolated };
