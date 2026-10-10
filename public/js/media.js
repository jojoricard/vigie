/* Now playing, under the briefing. The agent decides when to show it: while something
   plays, and a few minutes after a pause so play can be pressed again. */
import { $, esc, load } from "./core.js";
import { t } from "./i18n.js";
import { icon } from "./icons.js";

export async function refreshMedia() {
  const m = await load("/media");
  $("nowPlaying").hidden = !m;
  if (!m) return;
  const playing = m.status === "playing";
  $("nowPlaying").innerHTML = `<button class="npBtn" id="npBtn" aria-label="${playing ? t("media.pause") : t("media.play")}">${icon(playing ? "pause" : "play")}</button>
    <div class="npText"><div class="npTitle">${esc(m.title)}</div><div class="npSub">${esc([m.artist, m.name].filter(Boolean).join(", "))}</div></div>`;
  $("npBtn").onclick = async () => {
    await load("/media", { method: "POST", body: JSON.stringify({ action: playing ? "pause" : "play" }) });
    setTimeout(refreshMedia, 500);         // the player needs a moment to report its new state
  };
}
