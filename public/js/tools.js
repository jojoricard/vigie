/* Tools tab: link groups from config.json and the latest release of tracked repos.
   Links open in the default browser (main screen) through /open, which only allows
   URLs declared in config.json. */
import { $, esc, load, DAY_MS } from "./core.js";
import { t, relTime } from "./i18n.js";
import { icon, ICON_NAMES } from "./icons.js";

function releaseRows(g, rel) {
  const repos = (g.releases || []).filter((r) => rel[r]);
  if (!repos.length) return "";
  return `<div class="toolRel">${repos.map((r) => {
    const v = rel[r], fresh = v.date && Date.now() - new Date(v.date) < 14 * DAY_MS;
    // installed version: behind (orange) or up to date (green), nothing if unknown.
    // esc(): it can come from the registry's DisplayVersion, written freely by the installer
    const loc = v.installed
      ? `<span class="rloc ${v.outdated ? "late" : "ok"}">${v.outdated ? t("tools.installed", esc(v.installed)) : t("tools.upToDate", esc(v.installed))}</span>`
      : "";
    return `<div class="relRow" data-url="${encodeURIComponent(v.url || "")}">
      <span class="rn">${esc(r.split("/").pop())}</span>
      ${loc}
      ${fresh ? `<span class="relNew">${t("tools.new")}</span>` : ""}
      <span class="rv num">${esc(v.version)}</span>
      <span class="rd">${relTime(v.date)}</span></div>`;
  }).join("")}</div>`;
}

// an icon name from icons.js, or any short text (an emoji works)
const groupIcon = (s) => !s ? icon("link") : ICON_NAMES.includes(s) ? icon(s) : esc(s);

export async function refreshTools() {
  const [groups, rel] = await Promise.all([load("/tools"), load("/releases")]);
  if (!groups || !groups.length) { $("toolsList").innerHTML = `<div class="card"><div class="err">${t("tools.none")}</div></div>`; return; }
  $("toolsList").classList.remove("err");
  $("toolsList").innerHTML = groups.map((g) => `<div class="card">
    <div class="tgHead"><span class="tgIcon">${groupIcon(g.icon)}</span><span class="tgName">${esc(g.name)}</span></div>
    ${releaseRows(g, rel || {})}
    <div class="toolLinks">${(g.links || []).map((l) => `<span class="toolLink" data-url="${encodeURIComponent(l.url)}"><span class="tl">${esc(l.label)}</span>${icon("link")}</span>`).join("")}</div>
  </div>`).join("");
  document.querySelectorAll("#toolsList .toolLink, #toolsList .relRow").forEach((el) => el.onclick = () => {
    if (el.dataset.url) load("/open?url=" + el.dataset.url, { method: "POST" });
  });
}
