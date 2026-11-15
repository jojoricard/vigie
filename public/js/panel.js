/* A panel over the page: the settings of a device, the modules of the house, the sheet
   of the machine. Like a tab it never scrolls: its body is a box of blocks fitted by
   fit.js, cut into sub-views when they are too many, and its content may be split in
   tabs of its own (Settings, Program, Info).
   A panel is described by { head(), tabs(), body(tab), after(body), onClose() }:
   head gives { icon, title, sub }, tabs a list of { id, label } (none or one: no tab
   bar), body the blocks of a tab as HTML. */
import { esc } from "./core.js";
import { t } from "./i18n.js";
import { icon } from "./icons.js";
import { fitBox } from "./fit.js";

let el = null, spec = null, tab = null;

export function panelEl() {
  if (el) return el;
  // On <body>, outside .wrap: the anti burn-in shift is a transform, which would break position:fixed.
  el = document.createElement("div");
  el.className = "detail";
  el.hidden = true;
  el.innerHTML = `<div class="detailBackdrop" data-close></div><aside class="detailPanel" role="dialog">
    <div class="detailHead"></div><div class="segmented detailTabs" hidden></div>
    <div class="detailBody" data-fit data-col-min="300" data-max-cols="2"></div></aside>`;
  document.body.appendChild(el);
  el.addEventListener("click", (e) => {
    const tabBtn = e.target.closest("[data-ptab]");
    if (tabBtn) return setPanelTab(tabBtn.dataset.ptab);
    if (e.target.closest("[data-close]")) closePanel();
  });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && spec) closePanel(); });
  return el;
}

const tabsNow = () => (spec && spec.tabs ? spec.tabs() : []);

export function drawPanel() {
  if (!spec) return;
  const root = panelEl(), head = spec.head(), tabs = tabsNow();
  if (!tabs.some((x) => x.id === tab)) tab = tabs.length ? tabs[0].id : null;
  root.querySelector(".detailHead").innerHTML = `<span class="detailName">${head.icon || ""}<span>${esc(head.title)}${head.sub ? `<small>${esc(head.sub)}</small>` : ""}</span></span>
    <button type="button" class="detailClose" data-close aria-label="${t("house.close")}">${icon("close")}</button>`;
  const bar = root.querySelector(".detailTabs");
  bar.hidden = tabs.length < 2;
  bar.innerHTML = tabs.map((x) => `<button type="button" class="${x.id === tab ? "on" : ""}" data-ptab="${esc(x.id)}">${esc(x.label)}</button>`).join("");
  const body = root.querySelector(".detailBody");
  body.innerHTML = spec.body(tab);
  root.querySelector(".detailPanel").setAttribute("aria-label", head.title);
  root.hidden = false;
  fitBox(body);
  if (spec.after) spec.after(body);
}

export function openPanel(s) {
  if (spec && spec.onClose) spec.onClose();
  spec = s; tab = s.tab || null;
  panelEl().querySelector(".detailBody")._page = 0;
  drawPanel();
  el.querySelector("[data-close].detailClose").focus();
}
export function closePanel() {
  if (!spec) return;
  const was = spec;
  spec = null;
  el.hidden = true;
  if (was.onClose) was.onClose();
}
export const panelIs = (kind) => !!spec && spec.kind === kind;
export const panelBox = () => (spec ? el.querySelector(".detailBody") : null);
export const panelTabs = () => tabsNow().map((x) => x.id);
export function setPanelTab(id) {
  tab = id;
  el.querySelector(".detailBody")._page = 0;
  drawPanel();
}
