/* Chrome driven without any dependency: started headless with its remote debugging
 * port, then talked to over the DevTools protocol on Node's own WebSocket. Shared by
 * the layout check (check-scroll.js) and the captures (shots.js).
 * CHROME names the browser when it is not at one of the usual places. */
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const PLACES = [
  process.env.CHROME,
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser',
].filter(Boolean);

function findChrome() {
  const found = PLACES.find((p) => fs.existsSync(p));
  if (!found) throw new Error('Chrome not found: set CHROME to the path of chrome.exe (or of Edge, Chromium)');
  return found;
}

/* Starts the browser and resolves with { page(), browser(), close() }. page() opens a tab and
 * resolves with { send(method, params), evaluate(expression), waitEvent(method), size(w, h, scale),
 * goto(url), shot(file), close() }. */
async function launch() {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'vigie-chrome-'));
  const args = ['--headless=new', '--remote-debugging-port=0', `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check',
    '--enable-unsafe-swiftshader', '--use-angle=swiftshader', '--hide-scrollbars=false', 'about:blank'];
  // root in a container has no sandbox to run in
  if (process.getuid && process.getuid() === 0) args.unshift('--no-sandbox');
  const child = spawn(findChrome(), args, { stdio: ['ignore', 'ignore', 'pipe'] });
  const port = await new Promise((resolve, reject) => {
    let err = '';
    const timer = setTimeout(() => reject(new Error(`Chrome did not start:\n${err}`)), 20000);
    child.stderr.on('data', (c) => {
      err += c;
      const m = /DevTools listening on ws:\/\/[^:]+:(\d+)\//.exec(err);
      if (m) { clearTimeout(timer); resolve(Number(m[1])); }
    });
    child.on('exit', (code) => { clearTimeout(timer); reject(new Error(`Chrome exited (${code}):\n${err}`)); });
  });

  async function page() {
    const target = await (await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: 'PUT' })).json();
    const socket = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = () => reject(new Error('DevTools socket refused')); });
    let next = 1;
    const waiting = new Map(), errors = [], listeners = new Map();
    socket.onmessage = (e) => {
      const m = JSON.parse(e.data);
      for (const fn of listeners.get(m.method) || []) fn(m.params);
      if (m.method === 'Runtime.exceptionThrown') errors.push(m.params.exceptionDetails.exception ? m.params.exceptionDetails.exception.description : m.params.exceptionDetails.text);
      const w = waiting.get(m.id);
      if (!w) return;
      waiting.delete(m.id);
      if (m.error) w.reject(new Error(`${w.method}: ${m.error.message}`)); else w.resolve(m.result);
    };
    const send = (method, params = {}) => new Promise((resolve, reject) => { const id = next++; waiting.set(id, { resolve, reject, method }); socket.send(JSON.stringify({ id, method, params })); });
    await send('Page.enable');
    await send('Runtime.enable');
    const evaluate = async (expression) => {
      const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
      if (r.exceptionDetails) throw new Error(`in the page: ${r.exceptionDetails.exception ? r.exceptionDetails.exception.description : r.exceptionDetails.text}`);
      return r.result.value;
    };
    // resolves with the parameters of the next event of that name
    const waitEvent = (method) => new Promise((resolve) => {
      const fn = (params) => { listeners.set(method, (listeners.get(method) || []).filter((f) => f !== fn)); resolve(params); };
      listeners.set(method, [...(listeners.get(method) || []), fn]);
    });
    return {
      send, evaluate, errors, waitEvent,
      size: (width, height, scale = 1) => send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: scale, mobile: false }),
      async goto(url) {
        await send('Page.navigate', { url });
        for (let i = 0; i < 200; i++) {
          if (await evaluate('document.readyState === "complete" && !!window.vigie').catch(() => false)) return;
          await new Promise((r) => setTimeout(r, 100));
        }
        throw new Error(`the page did not load: ${url}\n${errors.join('\n')}`);
      },
      async shot(file) {
        const { data } = await send('Page.captureScreenshot', { format: 'png' });
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, Buffer.from(data, 'base64'));
      },
      close: () => socket.close(),
    };
  }

  // The browser itself (not a tab), for what only it knows: SystemInfo.getProcessInfo
  // gives the CPU time of each of its processes.
  async function browser() {
    const { webSocketDebuggerUrl } = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
    const socket = new WebSocket(webSocketDebuggerUrl);
    await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = () => reject(new Error('DevTools socket refused')); });
    let next = 1;
    const waiting = new Map();
    socket.onmessage = (e) => { const m = JSON.parse(e.data), w = waiting.get(m.id); if (!w) return; waiting.delete(m.id); if (m.error) w.reject(new Error(m.error.message)); else w.resolve(m.result); };
    const send = (method, params = {}) => new Promise((resolve, reject) => { const id = next++; waiting.set(id, { resolve, reject }); socket.send(JSON.stringify({ id, method, params })); });
    return { send, close: () => socket.close() };
  }

  return {
    page, browser,
    close() {
      child.kill();
      try { fs.rmSync(profile, { recursive: true, force: true }); } catch { /* the profile is in the temp folder anyway */ }
    },
  };
}

/* The agent in demo mode on a free port, for the time of a run. Resolves with { url, stop() }. */
function demoAgent({ lang = 'en' } = {}) {
  const net = require('net');
  return new Promise((resolve, reject) => {
    const probe = net.createServer().listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => {
        const child = spawn(process.execPath, [path.join(__dirname, '..', 'agent.js'), '--demo', `--port=${port}`, `--lang=${lang}`], { stdio: ['ignore', 'pipe', 'inherit'] });
        const timer = setTimeout(() => reject(new Error('the demo agent did not start')), 10000);
        child.stdout.on('data', (c) => { if (String(c).includes('http://')) { clearTimeout(timer); resolve({ url: `http://127.0.0.1:${port}/`, stop: () => child.kill() }); } });
        child.on('exit', (code) => { clearTimeout(timer); reject(new Error(`the demo agent exited (${code})`)); });
      });
    });
  });
}

module.exports = { launch, demoAgent, findChrome };
