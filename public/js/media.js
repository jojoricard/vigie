/* Now playing, under the briefing: there only while something plays. A paused player
   says nothing worth a line of the Overview. */
import { $, esc, load, put } from "./core.js";
import { t } from "./i18n.js";
import { icon } from "./icons.js";

export async function refreshMedia() {
  const m = await load("/media");
  const playing = !!m && m.status === "playing";
  $("nowPlaying").hidden = !playing;
  if (!playing) return;
  put($("nowPlaying"), `<button class="npBtn" id="npBtn" aria-label="${t("media.pause")}">${icon("pause")}</button>
    <div class="npText"><div class="npTitle">${esc(m.title)}</div><div class="npSub">${esc([m.artist, m.name].filter(Boolean).join(", "))}</div></div>`);
  $("npBtn").onclick = async () => {
    await load("/media", { method: "POST", body: JSON.stringify({ action: "pause" }) });
    setTimeout(refreshMedia, 500);         // the player needs a moment to report its new state
  };
}
