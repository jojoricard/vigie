/* Nothing scrolls, anywhere, at any size: the check.
 *   node scripts/check-scroll.js            every size below, on the demo
 *   node scripts/check-scroll.js 400x850    one size
 * Opens the page on the demo data in headless Chrome and goes through every tab, every
 * sub-view and every panel at each size. It fails if the page scrolls, or if any
 * container holds more than it shows (scrollHeight > clientHeight): content cut by an
 * "overflow: hidden" is caught like a scrollbar would be.
 * Two kinds of elements are windows on purpose and are left out: one line of text
 * ending in an ellipsis, and what is marked data-viewport (a map, the model of the
 * plan) or data-clip (a text clamped to two lines). */
const { launch, demoAgent } = require('./chrome');

// name: [width, height, device scale]. The kiosk is a 1440 x 2560 window, which the page zooms by 1.33.
const SIZES = {
  'portrait 1080x1920': [1080, 1920], 'kiosk 1440x2560': [1440, 2560], 'landscape 1920x1080': [1920, 1080], 'landscape 2560x1440': [2560, 1440],
  'laptop 1280x800': [1280, 800], 'tablet 768x1024': [768, 1024], 'tablet 1024x768': [1024, 768], 'phone 400x850': [400, 850], 'phone 850x400': [850, 400],
};

// Runs in the page: every container that overflows, as "selector: content > box".
const FIND = `(() => {
  const name = (el) => (el.id ? "#" + el.id : el.tagName.toLowerCase() + (el.className && typeof el.className === "string" ? "." + el.className.trim().split(/\\s+/).join(".") : ""));
  const where = (el) => { const parts = []; for (let e = el; e && e !== document.body && parts.length < 4; e = e.parentElement) parts.unshift(name(e)); return parts.join(" > "); };
  const bad = [];
  const root = document.scrollingElement;
  if (root.scrollHeight > innerHeight + 1 || root.scrollWidth > innerWidth + 1) bad.push("the page scrolls: " + root.scrollWidth + "x" + root.scrollHeight + " in " + innerWidth + "x" + innerHeight);
  for (const el of document.body.querySelectorAll("*")) {
    if (!(el instanceof HTMLElement) || !el.clientHeight || el.closest("[data-viewport], [data-clip], [hidden]")) continue;
    const cs = getComputedStyle(el);
    if (cs.visibility === "hidden" || cs.display === "none") continue;
    const line = cs.whiteSpace === "nowrap" && cs.textOverflow === "ellipsis";
    if (cs.overflowY !== "visible" && !line && el.scrollHeight > el.clientHeight + 1) bad.push(where(el) + ": " + el.scrollHeight + " > " + el.clientHeight + " high");
    if ((cs.overflowX === "auto" || cs.overflowX === "scroll") && el.scrollWidth > el.clientWidth + 1) bad.push(where(el) + ": " + el.scrollWidth + " > " + el.clientWidth + " wide");
  }
  // and nothing may stick out of the window either
  const body = document.body.getBoundingClientRect();
  for (const el of document.querySelectorAll(".block:not(.fitHide), .detailPanel, .tabnav")) {
    if (el.closest("[hidden]") || !el.offsetParent && el.tagName !== "ASIDE") continue;
    const r = el.getBoundingClientRect();
    if (r.width && (r.right > body.right + 1 || r.bottom > body.bottom + 1 || r.left < body.left - 1)) bad.push(where(el) + ": outside the window");
  }
  // Filled, too. A view may not keep more than 12 % of its height empty while one of its
  // blocks had a richer look that fitted, and no card may hold an empty zone taller than
  // 15 % of the screen: room goes to content or to the spacing between blocks.
  const layout = window.vigie.layout();
  if (layout && layout.pages === 1) layout.columns.forEach((c, i) => {
    if (c.could && c.spare > 0.12 * layout.height) bad.push("column " + (i + 1) + ": " + c.spare + " px left empty of " + layout.height + " while a block could grow");
  });
  const screen = window.innerHeight;
  for (const card of document.querySelectorAll(".block.card:not(.fitHide)")) {
    if (card.closest("[hidden]") || !card.offsetParent) continue;
    const box = card.getBoundingClientRect();
    if (!box.height) continue;
    let bottom = box.top;
    for (const el of card.querySelectorAll("*")) {
      if (el.firstElementChild || el.closest("[hidden]")) continue;
      const r = el.getBoundingClientRect();
      if (r.width && r.height && r.bottom <= box.bottom + 1) bottom = Math.max(bottom, r.bottom);
    }
    const empty = box.bottom - bottom - parseFloat(getComputedStyle(card).paddingBottom || 0);
    if (empty > 0.15 * screen) bad.push(where(card) + ": " + Math.round(empty) + " px of the card are empty (" + Math.round((empty / screen) * 100) + " % of the screen)");
  }
  // The plan of the home: the home covers at least 85 % of the side that limits it, and a
  // plan limited by its width keeps no empty bands above and below it taller than 15 % of
  // the screen (the card is given the height the home needs, no more). A plan squeezed by
  // the height of a small screen has bands on its sides: they cannot go anywhere else.
  const share = window.vigie.planShare && window.vigie.planShare();
  const stage = document.getElementById("planStage");
  if (share && stage && stage.offsetParent) {
    const most = Math.max(share.w, share.h), band = share.w >= share.h ? (1 - share.h) * stage.clientHeight : 0;
    if (most < 0.85) bad.push("#planStage: the home covers " + Math.round(most * 100) + " % of the side that limits it");
    if (band > 0.15 * screen) bad.push("#planStage: " + Math.round(band) + " px of the plan are empty above and below the home (" + Math.round((band / screen) * 100) + " % of the screen)");
  }
  // On the Overview the gaps between the blocks one sees are the same everywhere: a bare
  // block counts from its content, not from its box.
  const overview = document.getElementById("tabOverview");
  if (overview && !overview.hidden) {
    const seen = (b) => {
      if (b.classList.contains("card") || getComputedStyle(b).backgroundColor !== "rgba(0, 0, 0, 0)") return b.getBoundingClientRect();
      let top = Infinity, bottom = -Infinity;
      for (const el of b.querySelectorAll("*")) {
        const ownText = [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim());
        if ((el.firstElementChild && !ownText) || el.closest("[hidden]")) continue;
        const r = el.getBoundingClientRect();
        if (r.width && r.height) { top = Math.min(top, r.top); bottom = Math.max(bottom, r.bottom); }
      }
      return top < bottom ? { top, bottom, left: b.getBoundingClientRect().left } : null;
    };
    const cols = {};
    for (const b of overview.querySelectorAll(".block:not(.fitHide)")) {
      if (b.closest("[hidden]") || !b.offsetParent) continue;
      const r = seen(b);
      if (r) (cols[Math.round(b.getBoundingClientRect().left)] = cols[Math.round(b.getBoundingClientRect().left)] || []).push(r);
    }
    for (const list of Object.values(cols)) {
      list.sort((a, b) => a.top - b.top);
      const gaps = list.slice(1).map((r, i) => r.top - list[i].bottom);
      if (gaps.length > 1 && Math.max(...gaps) - Math.min(...gaps) > 8) bad.push("#tabOverview: uneven gaps between the blocks, " + gaps.map(Math.round).join(", ") + " px");
    }
  }
  return bad;
})()`;

async function checkSize(page, url, label, [width, height, scale = 1]) {
  await page.size(width, height, scale);
  await page.goto(url);
  await page.evaluate('window.vigie.ready');
  await new Promise((r) => setTimeout(r, 400));     // the briefing lands a moment after the rest
  const failures = [];
  let seen = 0;
  const check = async (where) => {
    seen++;
    for (const b of await page.evaluate(FIND)) failures.push(`${label} · ${where} · ${b}`);
  };
  // every sub-view of what is in front: a tab, or the panel over it
  const pages = async (where) => {
    const n = await page.evaluate('window.vigie.pages()');
    for (let i = 0; i < n; i++) { await page.evaluate(`window.vigie.page(${i})`); await check(n > 1 ? `${where} ${i + 1}/${n}` : where); }
  };
  for (const tab of await page.evaluate('window.vigie.tabs')) {
    await page.evaluate(`window.vigie.show(${JSON.stringify(tab)})`);
    for (const view of await page.evaluate('window.vigie.views()')) {
      await page.evaluate(`window.vigie.view(${JSON.stringify(view)})`);
      await pages(view === 'main' ? tab : `${tab}/${view}`);
    }
    await page.evaluate('window.vigie.view("main")');
    const panels = [...(await page.evaluate('window.vigie.panels()')), ...(tab === 'house' ? await page.evaluate('window.vigie.devices()') : [])];
    for (const panel of panels) {
      await page.evaluate(`window.vigie.open(${JSON.stringify(panel)})`);
      const inner = await page.evaluate('window.vigie.panelTabs()');
      for (const t of inner.length ? inner : [null]) {
        if (t) await page.evaluate(`window.vigie.panelTab(${JSON.stringify(t)})`);
        await pages(`${tab} · panel ${panel}${t ? `/${t}` : ''}`);
      }
      await page.evaluate('window.vigie.close()');
    }
  }
  await page.evaluate('window.vigie.show("overview")');
  await page.evaluate('window.vigie.night(true)');
  await check('night');
  await page.evaluate('window.vigie.night(false)');
  for (const e of page.errors.splice(0)) failures.push(`${label} · error in the page · ${e}`);
  return { failures, seen };
}

(async () => {
  const only = process.argv[2];
  const sizes = only ? { [only]: only.split('x').map(Number) } : SIZES;
  const agent = await demoAgent();
  const chrome = await launch();
  let failed = 0, views = 0;
  try {
    const page = await chrome.page();
    for (const [label, size] of Object.entries(sizes)) {
      const { failures, seen } = await checkSize(page, agent.url, label, size);
      views += seen;
      failed += failures.length;
      console.log(`${failures.length ? 'FAIL' : 'ok  '} ${label} (${seen} views)`);
      for (const f of failures) console.log(`     ${f}`);
    }
  } finally {
    chrome.close();
    agent.stop();
  }
  console.log(failed ? `\n${failed} layout fault(s) in ${views} views` : `\nNothing scrolls and nothing stays empty: ${views} views checked at ${Object.keys(sizes).length} sizes`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e.message); process.exit(2); });
