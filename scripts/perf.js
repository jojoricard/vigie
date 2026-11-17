/* What the page costs at rest: 30 s on each tab of the demo in headless Chrome. Fails
 * when the main thread of the page is busy more than the threshold of the tab, in
 * milliseconds per second. The window is in front (the worst case: animations run only
 * then), except on the House tab, measured as the kiosk shows it, the window in the
 * background: a headless Chrome in a container draws WebGL in software, and the breath
 * of the units, at 10 images a second, would measure SwiftShader rather than the page.
 *
 *   node scripts/perf.js            every tab
 *   node scripts/perf.js house 10   one tab, 10 s
 *
 * The thresholds come from the measures after the performance work (docs/NOTES.md,
 * "Performance"), with a margin of about two to three times: a regression that brings back
 * a loop or a refit at every refresh goes well past them, the noise of a busy machine does
 * not. */
const { launch, demoAgent } = require('./chrome');

const BUSY_MS_PER_S = { overview: 8, weather: 4, house: 4, energy: 4, machine: 5, tools: 4 };
// layouts a minute: the clock of the Overview makes one a second (in a box of its own), the
// charts of the Machine tab a few; a fit at every refresh brought 100 to 200 on every tab
const LAYOUTS_PER_MIN = { overview: 120, machine: 60 };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const [only, seconds = '30'] = process.argv.slice(2);
  const agent = await demoAgent({ lang: 'fr' }), chrome = await launch();
  const rows = [];
  let failed = false;
  try {
    const page = await chrome.page();
    await page.size(1440, 2560);
    await page.send('Performance.enable', { timeDomain: 'threadTicks' });
    await page.goto(agent.url);
    await page.evaluate('window.vigie.ready');
    const metrics = async () => Object.fromEntries((await page.send('Performance.getMetrics')).metrics.map((m) => [m.name, m.value]));
    for (const tab of only ? [only] : await page.evaluate('window.vigie.tabs')) {
      await page.send('Emulation.setFocusEmulationEnabled', { enabled: tab !== 'house' });
      await page.evaluate(`window.vigie.show(${JSON.stringify(tab)})`);
      await sleep(5000);      // what the tab draws when it shows is not rest
      const a = await metrics(), t0 = Date.now();
      await sleep(Number(seconds) * 1000);
      const b = await metrics(), dt = (Date.now() - t0) / 1000;
      const per = (k) => ((b[k] - a[k]) * 1000) / dt;
      const busy = per('TaskDuration'), limit = BUSY_MS_PER_S[tab] ?? 4, layoutLimit = LAYOUTS_PER_MIN[tab] ?? 20;
      const row = { tab, busy: busy.toFixed(1), script: per('ScriptDuration').toFixed(1), layout: (per('LayoutDuration') + per('RecalcStyleDuration')).toFixed(1),
        layoutsPerMin: Math.round(((b.LayoutCount - a.LayoutCount) / dt) * 60), heapMB: (b.JSHeapUsedSize / 1048576).toFixed(1), nodes: b.Nodes, limit };
      rows.push(row);
      const ok = busy <= limit && row.layoutsPerMin <= layoutLimit;
      if (!ok) failed = true;
      console.log(`${ok ? 'ok  ' : 'FAIL'} ${tab.padEnd(9)} busy ${row.busy} ms/s (limit ${limit}) · script ${row.script} · style+layout ${row.layout} · ${row.layoutsPerMin} layouts/min (limit ${layoutLimit}) · heap ${row.heapMB} MB · ${row.nodes} nodes`);
    }
    for (const e of page.errors) { failed = true; console.log(`error in the page: ${e}`); }
  } finally { chrome.close(); agent.stop(); }
  console.log(failed ? '\nThe page works more at rest than it should.' : '\nAt rest, every tab stays under its threshold.');
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
