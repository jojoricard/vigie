/* "Fills and folds": nothing on the page ever scrolls, and nothing stretches empty.
   A box (a tab, a detail panel) has a fixed size and holds blocks. Each block says how
   much it matters (data-prio: 1 must stay, 2 is useful, 3 is optional, 4 an extra that
   only comes once every other block is at its richest, never in a sub-view) and has up to three
   looks: compact (.compact in the CSS), normal, and rich (.rich, for a block that carries
   data-rich). The box starts from its minimum (optional blocks away, the others compact,
   lists down to their fewest rows) and grows its blocks by order of priority for as long
   as there is room: the normal look of what must stay, lists at full length, the normal
   look of the rest, optional blocks back, then rich looks, then the extras. When even the
   minimum does not fit, the box is cut into sub-views, with dots to
   go from one to the next. A list is never cut through a row: the rows that do not fit
   wait on its next page.
   A block is as tall as its content in the look it has: the room left over goes to the
   blocks whose content really scales (data-grow: a plan, a chart, a grid of tiles), up to
   their ceiling (data-hmax), then to the spacing between the blocks, never inside a card.
   arrange() and the helpers above it are pure and tested; fitBox() applies them to the DOM. */

/* ---------- Pure ---------- */
// The page is drawn for 1080 px upright and 1920 px lying down: a larger screen zooms it, a smaller one folds it.
export const uiScale = (width, height) => Math.min(2, Math.max(1, width / (width >= height ? 1920 : 1080)));

// Columns of a box of that size, in layout pixels.
export function columnsFor(width, height) {
  if (width >= height) return width >= 1500 ? 3 : width >= 700 ? 2 : 1;
  return width >= 1300 ? 2 : 1;
}

const pref = (b, mode) => mode === "rich" ? b.hr : mode === "compact" ? b.hc : b.h;
// the same with its lists down to their fewest rows
const least = (b, mode) => mode === "rich" ? Math.max(Math.min(b.min, b.h), b.hr - (b.h - Math.min(b.min, b.h)))
  : mode === "compact" ? Math.min(b.minc, b.hc) : Math.min(b.min, b.h);
const rank = (b) => Math.min(4, Math.max(1, b.prio || 2));      // 4: an extra, once everything else is at its richest
// What a block would cost to take its next look, or null when it has none.
function step(b, mode, gap) {
  if (mode === "hidden") return b.hc + gap;
  if (mode === "compact") return b.h - b.hc;
  if (mode === "normal" && b.hr != null) return b.hr - b.h;
  return null;
}
export const MAX_GAP = 48;   // the most two blocks are apart on screen, gap included, in screen pixels
export const MAX_SPACING = MAX_GAP - 16;   // what spacing may add to the gap of the CSS (16 px, unzoomed)

/* Where each block goes, in which look, and how tall it is.
   blocks: [{ id, prio, h, hc, hr, min, minc, grow, max, col }] in reading order. h, hc and
   hr are the heights of the normal, compact and rich looks (hr null: no rich look), min
   and minc the first two with a list down to its fewest rows, grow the share of the room
   left over for a block whose content scales, max its ceiling, col the column wished for
   when there are several.
   Returns { pages, blocks: { id: { page, col, mode, height } }, columns: [{ page, col,
   spare, spacing, could }] }: mode is "rich", "normal", "compact" or "hidden"; spare is
   the room no block took, spacing what each gap gets of it, could whether a block of the
   column still had a richer look that fitted (never, unless something is wrong). */
export function arrange(blocks, { cols = 1, height, gap = 16, pager = 0, maxSpacing = MAX_SPACING }) {
  const total = (list, modes, f) => {
    const shown = list.filter((b) => modes.get(b.id) !== "hidden");
    return shown.reduce((s, b) => s + f(b, modes.get(b.id)), 0) + gap * Math.max(0, shown.length - 1);
  };
  // One column, from its minimum up: each block takes its next look if the column still fits.
  const settle = (column) => {
    const modes = new Map(column.map((b) => [b.id, rank(b) >= 3 ? "hidden" : "compact"]));
    if (total(column, modes, least) > height) return null;
    const attempt = (b, mode, f) => {
      const was = modes.get(b.id);
      modes.set(b.id, mode);
      if (total(column, modes, f) <= height) return true;
      modes.set(b.id, was);
      return false;
    };
    // what must stay takes its normal look first, even if a list gives rows for it
    for (const b of column) if (rank(b) === 1) attempt(b, "normal", least);
    // the rest comes at the expense of nobody: lists keep their full length
    for (const b of column) if (rank(b) === 2) attempt(b, "normal", pref);
    for (const b of column) if (rank(b) === 3) attempt(b, "normal", pref) || attempt(b, "compact", pref);
    for (const p of [1, 2, 3]) for (const b of column) if (rank(b) === p && b.hr != null && modes.get(b.id) === "normal") attempt(b, "rich", pref);
    // an extra only comes when no other block of the column can grow richer
    for (const b of column) if (rank(b) === 4) attempt(b, "normal", pref);
    return modes;
  };
  const split = () => {
    if (cols === 1) return [blocks];
    const columns = Array.from({ length: cols }, () => []);
    if (blocks.every((b) => b.col)) { for (const b of blocks) columns[Math.min(cols, b.col) - 1].push(b); return columns; }
    // no wish: the columns end as even as reading order allows
    const share = blocks.reduce((s, b) => s + b.h, 0) / cols;
    let c = 0, used = 0;
    for (const b of blocks) {
      if (c < cols - 1 && used > 0 && used + b.h / 2 > share) { c++; used = 0; }
      columns[c].push(b); used += b.h;
    }
    return columns;
  };

  let pages = null;
  const one = split(), settled = one.map(settle);
  if (settled.every(Boolean)) pages = [one.map((column, i) => column.map((b) => ({ b, mode: settled[i].get(b.id) })))];
  else {
    // Sub-views: everything is back in its normal look, and fills column after column.
    const room = height - pager, slots = [[]];
    let used = 0;
    for (const b of blocks) {
      if (rank(b) === 4) { slots[slots.length - 1].push({ b, mode: "hidden" }); continue; }      // an extra has no sub-view of its own
      const mode = b.h <= room ? "normal" : "compact", h = Math.min(room, pref(b, mode));
      const seen = (slot) => slot.some((x) => x.mode !== "hidden");
      if (seen(slots[slots.length - 1]) && used + gap + h > room) { slots.push([]); used = 0; }
      const slot = slots[slots.length - 1];
      used += (seen(slot) ? gap : 0) + h;
      slot.push({ b, mode });
    }
    pages = [];
    for (let i = 0; i < slots.length; i += cols) pages.push(Array.from({ length: cols }, (_, c) => slots[i + c] || []));
  }

  const out = {}, info = [];
  const room = pages.length > 1 ? height - pager : height;
  pages.forEach((columns, page) => columns.forEach((column, col) => {
    const shown = column.filter((x) => x.mode !== "hidden");
    for (const x of column) if (x.mode === "hidden") out[x.b.id] = { page, col, mode: "hidden", height: 0 };
    const heights = shown.map((x) => pref(x.b, x.mode));
    const wanted = heights.reduce((s, h) => s + h, 0) + gap * Math.max(0, shown.length - 1);
    let spare = room - wanted;
    if (spare < 0) {
      // lists give rows back, each in proportion of what it can give
      const slack = shown.reduce((s, x) => s + pref(x.b, x.mode) - least(x.b, x.mode), 0), over = -spare;
      if (slack > 0) shown.forEach((x, i) => { heights[i] -= Math.min(1, over / slack) * (heights[i] - least(x.b, x.mode)); });
      // nothing left to give: the last block takes what remains, cut rather than pushing the page
      if (over > slack && shown.length) heights[shown.length - 1] = Math.max(0, room - heights.slice(0, -1).reduce((s, h) => s + h + gap, 0));
      spare = 0;
    } else {
      // what scales takes the room, each up to its ceiling
      for (let turn = 0; turn < 4 && spare > 0.5; turn++) {
        const open = shown.map((x, i) => ((x.b.grow || 0) > 0 && x.mode !== "compact" && (x.b.max == null || heights[i] < x.b.max - 0.5) ? i : -1)).filter((i) => i >= 0);      // a compact look stays short
        const shares = open.reduce((s, i) => s + shown[i].b.grow, 0);
        if (!shares) break;
        let given = 0;
        for (const i of open) {
          const b = shown[i].b, add = Math.min((spare * b.grow) / shares, b.max == null ? Infinity : b.max - heights[i]);
          heights[i] += add; given += add;
        }
        spare -= given;
      }
    }
    shown.forEach((x, i) => { out[x.b.id] = { page, col, mode: x.mode, height: Math.max(0, Math.floor(heights[i])) }; });
    const could = pages.length === 1 && column.some((x) => { const cost = step(x.b, x.mode, shown.length ? gap : 0); return cost != null && cost <= spare; });
    info.push({ page, col, spare: Math.max(0, Math.floor(spare)), spacing: shown.length > 1 ? Math.min(maxSpacing, Math.floor(Math.max(0, spare) / (shown.length - 1))) : 0, could, stacked: shown.length > 1 });
  }));
  // one spacing for the whole page: the tightest column sets it, so the gaps look the same
  // from one column to the next (what the others keep stays at their bottom)
  for (const page of new Set(info.map((c) => c.page))) {
    const cols = info.filter((c) => c.page === page), stacked = cols.filter((c) => c.stacked);
    const even = stacked.length ? Math.min(...stacked.map((c) => c.spacing)) : 0;
    for (const c of cols) c.spacing = Math.min(c.spacing, even);
  }
  for (const c of info) delete c.stacked;
  return { pages: pages.map((columns) => columns.map((column) => column.map((x) => x.b.id))), blocks: out, columns: info };
}

/* Rows of a list cut into pages: `lines` are [{ top, bottom }] in order, `height` the
   room. Returns the index of the first line of each page. A line taller than the room
   still gets a page of its own. */
export function pageRows(lines, height) {
  const starts = [];
  let from = null;
  lines.forEach((line, i) => {
    if (from == null || line.bottom - from > height + 2) { starts.push(i); from = line.top; }      // two pixels: the heights are rounded
  });
  return starts;
}

/* ---------- DOM ---------- */
const GAP = 16, PAGER = 26;
let order = 0;
const boxes = new Set();
const resized = typeof ResizeObserver === "function" ? new ResizeObserver(() => queueFit()) : null;
/* What changed in a box since its last fit. A refresh that writes the same text changes
   nothing (writers compare before writing), and a change that leaves every block as tall
   as it was costs one reading of their heights instead of five layouts. */
function noteChanges(records) {
  for (const r of records) {
    const box = r.target.closest ? r.target.closest("[data-fit]") : r.target.parentElement && r.target.parentElement.closest("[data-fit]");
    if (!box) continue;
    const block = (r.target.closest ? r.target : r.target.parentElement).closest(".block");
    (box._touched = box._touched || new Set()).add(block && block.closest("[data-fit]") === box ? block : box);
  }
}
const touched = typeof MutationObserver === "function" ? new MutationObserver(noteChanges) : null;
const WATCHED = { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ["hidden", "data-view", "data-rich", "data-grow", "data-hn", "data-hmax", "data-hmin", "data-prio"] };

// A block keeps the place it had when first seen, wherever fitting moves it afterwards.
// Spaced out, so a block added later can be given a place between two others.
const blocksOf = (box) => [...box.querySelectorAll(".block")].filter((b) => b.closest("[data-fit]") === box)
  .map((b) => { if (!b._order) b._order = (order += 100); return b; }).sort((a, b) => a._order - b._order);
export const orderBlocks = (box) => { blocksOf(box); };
const inView = (box, b) => !b.hidden && (b.dataset.view || "main") === (box.dataset.view || "main");      // a block without data-view belongs to the main view
const num = (v, d) => v == null || v === "" ? d : Number(v);

function listsOf(block) { return [...block.querySelectorAll("[data-rows]")].filter((l) => l.closest(".block") === block); }
const rowsOf = (list) => [...list.children].filter((r) => !r.hidden);

function measure(box, blocks) {
  box.classList.add("measuring");
  const lists = blocks.flatMap(listsOf);
  const cut = (on) => { for (const l of lists) rowsOf(l).forEach((r, i) => r.classList.toggle("rowOut", on && i >= num(l.dataset.minRows, 3))); };
  const read = () => blocks.map((b) => b.offsetHeight);
  const was = blocks.map((b) => (b.classList.contains("rich") ? "rich" : b.classList.contains("compact") ? "compact" : "normal"));
  const look = (name) => { for (const b of blocks) { b.classList.toggle("compact", name === "compact"); b.classList.toggle("rich", name === "rich" && "rich" in b.dataset); } };
  look("normal");
  cut(false); const h = read();
  cut(true); const min = read();
  look("compact");
  const minc = read();
  cut(false); const hc = read();
  look("rich");
  const hr = read();
  blocks.forEach((b, i) => { b.classList.toggle("compact", was[i] === "compact"); b.classList.toggle("rich", was[i] === "rich"); });
  box.classList.remove("measuring");
  return blocks.map((b, i) => {
    const d = b.dataset, fixed = d.hn != null;
    return {
      id: i, prio: num(d.prio, 2), grow: num(d.grow, 0), max: d.hmax != null ? num(d.hmax) : null,
      h: fixed ? num(d.hn) : h[i], hc: d.hc != null ? num(d.hc) : fixed ? num(d.hn) : hc[i],
      hr: !("rich" in d) ? null : d.hr != null ? num(d.hr) : hr[i],
      min: d.hmin != null ? num(d.hmin) : fixed ? num(d.hn) : min[i], minc: d.hminc != null ? num(d.hminc) : d.hmin != null ? num(d.hmin) : fixed ? num(d.hc, num(d.hn)) : minc[i],
    };
  });
}

function build(box, pages, cols) {
  const ratio = (box.dataset.colw || "").split(",").map(Number).filter((x) => x > 0);
  const keep = [...box.children].filter((el) => el.matches(".pager, [data-keep]"));
  const frag = document.createDocumentFragment();
  pages.forEach((columns) => {
    const pg = document.createElement("div");
    pg.className = "pg";
    columns.forEach((column, c) => {
      const pc = document.createElement("div");
      pc.className = "pc";
      if (ratio.length === cols) pc.style.flexGrow = ratio[c];
      for (const el of column) pc.appendChild(el);
      pg.appendChild(pc);
    });
    frag.appendChild(pg);
  });
  box.replaceChildren(frag, ...keep);
}

function showPage(box) {
  const pgs = [...box.children].filter((el) => el.classList.contains("pg"));
  box._page = Math.min(Math.max(0, box._page || 0), pgs.length - 1);
  pgs.forEach((pg, i) => { pg.hidden = i !== box._page; });
  let pager = [...box.children].find((el) => el.classList.contains("pager"));
  if (pgs.length < 2) { if (pager) pager.remove(); return; }
  if (!pager) { pager = document.createElement("div"); pager.className = "pager"; box.appendChild(pager); }
  pager.innerHTML = pgs.map((_, i) => `<button type="button" class="${i === box._page ? "on" : ""}" data-page="${i}" aria-label="${i + 1} / ${pgs.length}"></button>`).join("");
}

// The rows of a list that fit its box, the others on its next pages (a small pager in the head of the block).
export function fitRows(list, again = false) {
  const rows = rowsOf(list);
  for (const r of rows) r.classList.remove("rowOut");
  const block = list.closest(".block") || list.parentElement, holder = block.querySelector("[data-pager]");
  const lines = [];
  for (const r of rows) {
    const top = r.offsetTop, last = lines[lines.length - 1];
    if (last && Math.abs(last.top - top) < 2) { last.rows.push(r); last.bottom = Math.max(last.bottom, top + r.offsetHeight); }
    else lines.push({ top, bottom: top + r.offsetHeight, rows: [r] });
  }
  const room = list.clientHeight;
  const starts = lines.length ? pageRows(lines, room) : [0];
  list._pages = starts.length;
  list._page = Math.min(Math.max(0, list._page || 0), starts.length - 1);
  if (starts.length > 1) {
    const from = starts[list._page], to = starts[list._page + 1] ?? lines.length;
    lines.forEach((line, i) => { if (i < from || i >= to) for (const r of line.rows) r.classList.add("rowOut"); });
  }
  if (!holder) return;
  holder._list = list;
  holder.hidden = starts.length < 2;
  holder.innerHTML = starts.length < 2 ? "" : starts.length > 7
    ? `<button type="button" data-row-step="-1" aria-label="‹">‹</button><span class="num">${list._page + 1} / ${starts.length}</span><button type="button" data-row-step="1" aria-label="›">›</button>`
    : starts.map((_, i) => `<button type="button" class="dot${i === list._page ? " on" : ""}" data-row-page="${i}" aria-label="${i + 1} / ${starts.length}"></button>`).join("");
  // a pager that shows up may take a line from the list it pages: once more with the room that is left
  if (list.clientHeight !== room && !again) fitRows(list, true);
}

/* Fits one box now. Returns the number of sub-views. `cols` forces the columns (a panel
   is one column whatever its width). */
export function fitBox(box, { cols: forced, force = false } = {}) {
  if (!box || !box.isConnected || box.hidden || !box.clientHeight) return 0;
  if (!boxes.has(box)) {
    if (resized) resized.observe(box);      // the bar above may grow after a fit: refit then
    if (touched) touched.observe(box, WATCHED);
  }
  boxes.add(box);
  if (!force && unchanged(box)) return pagesOf(box);
  const all = blocksOf(box), blocks = all.filter((b) => inView(box, b));
  for (const b of all) if (!blocks.includes(b)) b.classList.add("fitHide");
  for (const b of blocks) b.classList.remove("fitHide");
  const W = box.clientWidth, H = box.clientHeight;
  // data-col-min: as many columns of at least that width as fit (a panel), instead of the columns of a tab
  const most = num(box.dataset.maxCols, 9), colMin = num(box.dataset.colMin, 0);
  const cols = forced || num(box.dataset.cols, 0) || Math.min(most, colMin ? Math.max(1, Math.floor(W / colMin)) : columnsFor(W, H));
  // blocks must sit in a column of the right width to be measured
  if (box._cols !== cols || blocks.some((b) => !b.parentElement.classList.contains("pc"))) {
    build(box, [Array.from({ length: cols }, (_, c) => all.filter((b) => Math.min(cols, num(b.dataset[`c${cols}`], 1)) === c + 1))], cols);
    box._cols = cols; box._sig = null;
  }
  const sized = measure(box, blocks);
  blocks.forEach((b, i) => { sized[i].col = num(b.dataset[`c${cols}`], 0); });
  // the gap is the one of the CSS, which tightens on a small screen
  const column = box.querySelector(".pc"), gap = column ? parseFloat(getComputedStyle(column).rowGap) || 0 : GAP;
  const sig = JSON.stringify([W, H, cols, gap, box.dataset.view, sized]);
  // Same sizes as last time: the blocks stay where they are, nothing is moved in the DOM.
  if (sig !== box._sig) {
    box._sig = sig;
    // the page is zoomed on a large screen: the most it may add is set in screen pixels
    const zoom = parseFloat(getComputedStyle(document.body).getPropertyValue("--z")) || 1;
    box._plan = arrange(sized, { cols, height: H, gap, pager: PAGER, maxSpacing: Math.max(0, Math.floor(MAX_GAP / zoom - gap)) });
    build(box, box._plan.pages.map((columns, p) => columns.map((ids, c) => [...ids.map((i) => blocks[i]), ...(p === 0 && c === 0 ? all.filter((b) => !blocks.includes(b)) : [])])), cols);
    showPage(box);
  }
  const first = new Set();
  blocks.forEach((b, i) => {
    const x = box._plan.blocks[i], column = box._plan.columns.find((c) => c.page === x.page && c.col === x.col), key = `${x.page}:${x.col}`;
    b.classList.toggle("fitHide", x.mode === "hidden");
    b.classList.toggle("compact", x.mode === "compact");
    b.classList.toggle("rich", x.mode === "rich");
    b.style.height = `${x.height}px`;
    // the room nobody took is spread between the blocks of the column, never inside one
    b.style.marginTop = x.mode !== "hidden" && first.has(key) && column && column.spacing ? `${column.spacing}px` : "";
    if (x.mode !== "hidden") first.add(key);
  });
  for (const b of blocks) for (const l of listsOf(b)) fitRows(l);
  box.dispatchEvent(new CustomEvent("fit"));
  settle(box, forced);
  return [...box.children].filter((el) => el.classList.contains("pg")).length;
}

// The heights of the blocks as laid out, without their fixed height: what unchanged() compares.
function naturalHeights(box, blocks) {
  box.classList.add("measuring");
  const h = blocks.map((b) => b.offsetHeight);
  box.classList.remove("measuring");
  return h;
}
// After a fit: what it was done for, and its own changes to the DOM forgotten.
function settle(box, forced) {
  const blocks = blocksOf(box).filter((b) => inView(box, b) && !b.classList.contains("fitHide"));
  box._fitFor = { W: box.clientWidth, H: box.clientHeight, cols: forced || 0, blocks, heights: naturalHeights(box, blocks) };
  if (touched) touched.takeRecords();
  box._touched = null;
}
/* Nothing to redo: same size, and either nothing written in the box or blocks that are
   still as tall as they were in their look (their lists are fitted again, their rows may
   have changed). */
function unchanged(box) {
  const was = box._fitFor;
  if (!was || was.W !== box.clientWidth || was.H !== box.clientHeight) return false;
  if (touched) noteChanges(touched.takeRecords());
  const changed = box._touched;
  if (!changed || !changed.size) return true;
  if (changed.has(box)) return false;
  const blocks = blocksOf(box).filter((b) => inView(box, b) && !b.classList.contains("fitHide"));
  if (blocks.length !== was.blocks.length || blocks.some((b, i) => b !== was.blocks[i])) return false;
  const heights = naturalHeights(box, blocks);
  if (heights.some((h, i) => Math.abs(h - was.heights[i]) > 0.5)) return false;
  for (const b of changed) for (const l of listsOf(b)) fitRows(l);
  if (touched) touched.takeRecords();
  box._touched = null;
  return true;
}

// How full a box is, for the layout check: the room left in each column of the sub-view
// on screen, and whether a block there could still have taken a richer look.
export function layoutOf(box) {
  if (!box || !box._plan) return null;
  const columns = box._plan.columns.filter((c) => c.page === (box._page || 0));
  return { height: box.clientHeight, pages: box._plan.pages.length, columns: columns.map((c) => ({ spare: c.spare, could: c.could })) };
}

export const pagesOf = (box) => [...box.children].filter((el) => el.classList.contains("pg")).length;
export function setPage(box, i) {
  const n = pagesOf(box);
  if (n < 2) return;
  box._page = ((i % n) + n) % n;
  showPage(box);
  for (const b of blocksOf(box)) if (inView(box, b)) for (const l of listsOf(b)) fitRows(l);
  box.dispatchEvent(new CustomEvent("fit"));
}
export function setRowPage(list, i) {
  if (!list || !(list._pages > 1)) return;
  list._page = ((i % list._pages) + list._pages) % list._pages;
  fitRows(list);
}

// Every box on screen, at the next frame: called after each refresh and each resize.
let queued = false;
export function queueFit() {
  if (queued) return;
  queued = true;
  requestAnimationFrame(() => { queued = false; for (const box of boxes) if (box.isConnected) fitBox(box); else boxes.delete(box); });
}

/* Dots, arrows and fingers: one set of listeners for every box and every list. A swipe
   turns the list under the finger when it has pages, the sub-view of its box otherwise. */
export function wireFit(root = document) {
  root.addEventListener("click", (e) => {
    const dot = e.target.closest("[data-page]");
    if (dot && dot.parentElement.classList.contains("pager")) return setPage(dot.closest("[data-fit]"), Number(dot.dataset.page));
    const row = e.target.closest("[data-row-page], [data-row-step]");
    if (row) {
      const list = row.closest("[data-pager]")._list;
      setRowPage(list, row.dataset.rowPage != null ? Number(row.dataset.rowPage) : list._page + Number(row.dataset.rowStep));
    }
  });
  const front = () => [...boxes].filter((b) => b.isConnected && !b.hidden && b.clientHeight).pop();
  root.addEventListener("keydown", (e) => {
    if (e.target.closest && e.target.closest("input, textarea, [data-plan-keys]")) return;
    const step = e.key === "ArrowRight" || e.key === "PageDown" ? 1 : e.key === "ArrowLeft" || e.key === "PageUp" ? -1 : 0;
    const box = step && front();
    if (box && pagesOf(box) > 1) { e.preventDefault(); setPage(box, (box._page || 0) + step); }
  });
  let down = null;
  root.addEventListener("pointerdown", (e) => { down = e.target.closest && !e.target.closest("[data-viewport], input, .svBox") ? { x: e.clientX, y: e.clientY, target: e.target } : null; });
  root.addEventListener("pointerup", (e) => {
    if (!down) return;
    const dx = e.clientX - down.x, dy = e.clientY - down.y, from = down.target;
    down = null;
    if (Math.abs(dx) < 70 || Math.abs(dy) > 50) return;
    const list = from.closest("[data-rows]"), box = from.closest("[data-fit]");
    if (list && list._pages > 1) setRowPage(list, list._page + (dx < 0 ? 1 : -1));
    else if (box && pagesOf(box) > 1) setPage(box, (box._page || 0) + (dx < 0 ? 1 : -1));
  });
}
