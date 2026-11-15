/* Captures of every tab, upright and lying down, and of one detail panel.
 *   node scripts/shots.js <folder>                 the demo, in English
 *   node scripts/shots.js <folder> --lang=fr       the demo, in French
 *   node scripts/shots.js <folder> --url=http://localhost:5252/    a running agent: your own data
 * Captures of your own home are yours: point <folder> outside the repository. */
const path = require('path');
const { launch, demoAgent } = require('./chrome');

const SIZES = { portrait: [1440, 2560], landscape: [1920, 1080] };     // the kiosk upright, a desktop screen

(async () => {
  const args = process.argv.slice(2), out = args.find((a) => !a.startsWith('--'));
  const opt = (name) => { const a = args.find((x) => x.startsWith(`--${name}=`)); return a ? a.slice(name.length + 3) : null; };
  if (!out) { console.error('Usage: node scripts/shots.js <folder> [--lang=fr] [--url=http://localhost:5252/]'); process.exit(2); }
  const agent = opt('url') ? { url: opt('url'), stop() {} } : await demoAgent({ lang: opt('lang') || 'en' });
  const chrome = await launch();
  try {
    const page = await chrome.page();
    for (const [name, [width, height]] of Object.entries(SIZES)) {
      await page.size(width, height);
      await page.goto(agent.url);
      await page.evaluate('window.vigie.ready');
      await new Promise((r) => setTimeout(r, 1500));
      for (const tab of await page.evaluate('window.vigie.tabs')) {
        await page.evaluate(`window.vigie.show(${JSON.stringify(tab)})`);
        await new Promise((r) => setTimeout(r, tab === 'house' ? 2500 : 500));      // the model of the plan loads three.js
        const file = path.join(out, `${tab}-${name}.png`);
        await page.shot(file);
        console.log(file);
      }
      if (name !== 'portrait') continue;
      // one detail panel: the weekly program of the first device that has one
      await page.evaluate('window.vigie.show("house")');
      for (const id of await page.evaluate('window.vigie.devices()')) {
        await page.evaluate(`window.vigie.open(${JSON.stringify(id)})`);
        if ((await page.evaluate('window.vigie.panelTabs()')).includes('program')) {
          await page.evaluate('window.vigie.panelTab("program")');
          await new Promise((r) => setTimeout(r, 500));
          const file = path.join(out, 'panel-program.png');
          await page.shot(file);
          console.log(file);
          break;
        }
      }
      await page.evaluate('window.vigie.close()');
    }
  } finally {
    chrome.close();
    agent.stop();
  }
})().catch((e) => { console.error(e.message); process.exit(2); });
