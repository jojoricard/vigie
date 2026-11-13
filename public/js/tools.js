/* Tools tab: link groups from config.json and the latest release of tracked repos.
   Links open in the default browser (main screen) through /open, which only allows
   URLs declared in config.json. Fuel prices sit below: one more thing looked up
   before going out, and the House tab has no room for a card that is not the home. */
import { $, state, esc, load, DAY_MS } from "./core.js";
import { t, dec, relTime } from "./i18n.js";
import { icon, ICON_NAMES } from "./icons.js";

function releaseRows(g, rel) {
  const repos = (g.releases || []).filter((r) => rel[r]);
  if (!repos.length) return "";
  return `<div class="toolRel">${repos.map((r) => {
    const v = rel[r], fresh = v.date && Date.now() - new Date(v.date) < 14 * DAY_MS;
    // "new version" needs an installed one to be newer than. Without it the row only
    // says when the release came out, highlighted while it is recent.
    const date = !v.date ? "" : v.installed ? relTime(v.date) : t("tools.released", relTime(v.date));
    // installed version: behind (orange) or up to date (green), nothing if unknown.
    // esc(): it can come from the registry's DisplayVersion, written freely by the installer
    const loc = v.installed
      ? `<span class="rloc ${v.outdated ? "late" : "ok"}">${v.outdated ? t("tools.installed", esc(v.installed)) : t("tools.upToDate", esc(v.installed))}</span>`
      : "";
    return `<div class="relRow" data-url="${encodeURIComponent(v.url || "")}">
      <span class="rn">${esc(r.split("/").pop())}</span>
      ${loc}
      ${v.outdated ? `<span class="relNew">${t("tools.new")}</span>` : ""}
      <span class="rv num">${esc(v.version)}</span>
      <span class="rd${fresh && !v.installed ? " fresh" : ""}">${date}</span></div>`;
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

/* ================= Fuel prices (France) =================
   The cheapest stations around the home city (the first one), per fuel. */
export async function refreshFuel() {
  const l = await load("/fuel");
  state.fuel = l;
  $("fuelCard").hidden = !l || !l.length;
  if (!l || !l.length) return;
  $("fuelMeta").textContent = state.cities[0] ? state.cities[0].short : "";
  $("fuelList").innerHTML = l.map((f) => `<div class="fuelCol">
      <div class="fuelName">${icon("pump")}${t("fuel." + f.type)}</div>
      ${f.stations.length ? f.stations.map((s, i) => `<div class="fuelRow${i ? "" : " best"}">
        <span class="p num">${dec(s.price, 3)} €</span>
        <span class="a">${esc(s.address)}, ${esc(s.city)}<span class="dim">${t("fuel.km", dec(s.distance / 1000))}, ${relTime(new Date(s.updated).toISOString())}</span></span>
      </div>`).join("") : `<div class="err">${t("fuel.none")}</div>`}
    </div>`).join("");
}
