/* AI briefing (optional, needs anthropicApiKey).
 * The page sends the context split in two: `alreadyShown` (on screen, must not be
 * repeated) and `toAnalyze` (what the display can't say). The model therefore only
 * brings foresight and advice.
 * The page posts its context after every refresh, the agent alone decides whether the
 * model is called again: a new time slot, or an event the last text did not know
 * about, within the limits of the rate guard. */
const fs = require('fs');
const path = require('path');
const ctx = require('./context');
const { request, parseJson, SourceError, orNull, logError } = require('./errors');
const { DAY_MS, dayKey } = require('./storage');

const MODEL = 'claude-haiku-5-5';
const cacheFile = () => path.join(ctx.root, '.briefing.json');

// config.json → briefing overrides any of these. The page reads the thresholds from /config.
const DEFAULTS = {
  slots: { morning: 5, midday: 12, evening: 17 },   // hour each slot starts at
  minIntervalMin: 30,
  maxPerDay: 8,
  rainSoonPct: 60,
  rainHourPct: 50,
  gustKmh: 50,
  fuelDeltaEur: 0.05,
  acHeatAboveC: 18,
  acCoolBelowC: 15,
  electricityGapPct: 20,
};
function settings() {
  const b = ctx.cfg.briefing || {};
  return { ...DEFAULTS, ...b, slots: { ...DEFAULTS.slots, ...b.slots } };
}

// The prompt forbids them, the model still slips one in now and then: an em dash (or a
// spaced en dash) becomes a comma, a semicolon ends the sentence. "12–18°" stays.
const plain = (s) => s.replace(/\s*—\s*|\s+–\s+/g, ', ').replace(/\s*;\s*(\S)/gu, (_, c) => '. ' + c.toUpperCase());

// Before the morning hour the day has not started: 1 am still belongs to the evening
// before, or a text written at 00:10 would stand for the whole morning.
function slotOf(now, slots) {
  const h = now.getHours();
  if (h < slots.morning) return { day: dayKey(new Date(now.getTime() - DAY_MS)), slot: 'evening' };
  return { day: dayKey(now), slot: h >= slots.evening ? 'evening' : h >= slots.midday ? 'midday' : 'morning' };
}

/* Fingerprint of the context: the events worth a new text right away. A key that
 * disappears (the shower has passed, the warning is lifted) is not one, only a key the
 * last text did not have. */
function events(context) {
  const a = context.toAnalyze || {}, s = context.alreadyShown || {};
  return [
    a.recentIncident ? 'incident:' + a.recentIncident.at : null,
    a.next12h && a.next12h.rainSoon ? 'rain' : null,
    ...(s.warnings || []).map((w) => 'warning:' + w),
    ...(a.servicesDown || []).map((x) => 'service:' + x.name),
  ].filter(Boolean).sort();
}

const isFresh = (cached, slot, lang, ev) => !!cached.text && cached.day === slot.day && cached.slot === slot.slot
  && cached.lang === lang && Array.isArray(cached.events) && ev.every((e) => cached.events.includes(e));

// Rate guard on a paid call: `calls` are the times of the past attempts, failed ones included.
function mayCall(calls, now, s) {
  const today = calls.filter((t) => dayKey(new Date(t)) === dayKey(new Date(now)));
  return today.length < s.maxPerDay && calls.every((t) => now - t >= s.minIntervalMin * 60000);
}

/* Last check before a text is cached and shown: the reason to refuse it, or null. A
 * prompt does not stop the model from thinking aloud, quoting the JSON or running long. */
const MAX_SENTENCES = 3, MAX_CHARS = 400;
const REASONING_EN = /\b(wait|actually|I need|let me|the data|correct that)\b/i;
// Keys of the context that cannot be ordinary words (nextDays, next12h): "machine" or
// "tempo" are fields too, and belong in a normal sentence.
function fieldNames(value, names = new Set()) {
  if (Array.isArray(value)) for (const v of value) fieldNames(v, names);
  else if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      if (/[A-Z0-9]/.test(k)) names.add(k);
      fieldNames(v, names);
    }
  }
  return names;
}
function rejection(text, lang, context) {
  const sentences = text.split(/[.!?…]+(?:\s+|$)/).filter((s) => s.trim()).length;
  if (sentences > MAX_SENTENCES) return `${sentences} sentences`;
  if (text.length > MAX_CHARS) return `${text.length} characters`;
  const english = lang === 'fr' && text.match(REASONING_EN);
  if (english) return `reasoning in English ("${english[0]}")`;
  const words = new Set(text.split(/[^A-Za-z0-9]+/));
  const field = [...fieldNames(context)].find((k) => words.has(k));
  return field ? `field name "${field}"` : null;
}

const prompt = (context) =>
  "You write the context line of a personal dashboard I look at all day, right next to the clock. " +
  "The JSON context below has two parts. " +
  "alreadyShown is displayed in large type next to your text: the temperature, the sky, weather warnings, today's " +
  "rain probability, pollen, air quality and the name day. Absolute rule: repeat none of it, nor its figures. " +
  "Saying it again has no value. A warning listed there is not news: never restate it, and never comment on " +
  "it when nothing in toAnalyze goes with it. " +
  "toAnalyze is what the screen cannot say, or only shows in small print without drawing anything from it. " +
  "Your job is to turn it into foresight and one concrete action. " +
  "Order of priority, stop as soon as your sentences are used up: " +
  "(1) what calls for an action today or tonight: rain or gusts in next12h, a service in servicesDown (down: no " +
  "answer, error: HTTP 5xx), a recentIncident on my PC (quote its 'when' field word for word), a red or white " +
  "Tempo day tomorrow in tempo (electricity costs more: run the heavy appliances before); " +
  "(2) what is coming in the next days: the weather turning in nextDays (rain arriving, a hot spell starting or " +
  "ending, temperatures dropping), a public holiday or a school break in holidays, a fuel price that moved in fuel " +
  "(change is in euros per litre since the day given); " +
  "(3) the machine, in one sentence at most, and only when the machine or network field is there: the incidents " +
  "of the week, the detected breaks, the freeze/power cut split, the network losses. The titles of the breaks are " +
  "already on screen, but not their figures: give the figure and above all draw a consequence, never just repeat " +
  "the title. A freeze points to the graphics driver, a hard power cut to the power supply. Without those fields, " +
  "not a word about the PC: never write that it runs fine or has had no incident. The electricity field is only " +
  "there when the end-of-month projection is clearly off from the previous month (gapPct). " +
  "Rain: next12h.rain lists the spells to come, each with its start (from) and end (to), its millimetres and its " +
  "sky. Describe rain with those hours and millimetres, and with them only in the midday and evening slots, never " +
  "with a probability. Advice must fit the phenomenon: an umbrella or a coat for rain, the car under cover only " +
  "for hail or a flood warning. " +
  "Air conditioners: house only lists the units running against the weather, heating while it is warm outside " +
  "or cooling while it is cold (outdoorTemp). Suggest turning those off. Without that field, not a word about " +
  "the house, the heating or the air conditioning. " +
  "Every field of toAnalyze was filtered before reaching you: a missing field means there is nothing to do " +
  "about it, so never write that something is fine, absent or needs no action. " +
  "The field now is the current local time and slot the part of the day you write for: morning, cover the day " +
  "ahead; midday, cover this afternoon and this evening; evening, cover tonight and tomorrow. " +
  "Use now to speak in relative terms (tonight, in 2 hours) and never announce an hour that has passed. " +
  "Style: direct, concrete, with a figure when it helps. " +
  "Good sentences (in French here, for the style only): " +
  "\"Pluie forte jusqu'à 21 h, environ 15 mm : prends un parapluie si tu sors.\" " +
  "\"Tempo rouge demain, lance le lave-linge ce soir plutôt que demain matin.\" " +
  "\"Le PC a gelé hier à 15:02, deuxième gel du mois : mets à jour le pilote graphique.\" " +
  "Bad sentences: " +
  "\"Il fait 14° et le ciel est couvert.\" (repeats the screen) " +
  "\"La météo pourrait changer dans les prochains jours, restez vigilant.\" (vague, no figure, no action) " +
  "\"Le PC tourne sans incident depuis 11 jours, rien à signaler.\" (nothing to act on: say nothing) " +
  "\"Tempo bleu demain, pas de contrainte particulière sur les appareils.\" (announces that there is nothing to do) " +
  "\"Pluie-inondation jaune dans le Rhône, mais rien de prévu dans les prochaines heures, donc rien à faire pour " +
  "l'instant.\" (restates a warning already on screen to conclude there is nothing to do) " +
  `Write in ${ctx.lang === 'fr' ? 'French' : 'English'}, no title, no list, no greeting. Never use an em dash. ` +
  "Length: 3 sentences is a ceiling, not a target. One sentence per thing that calls for an action, and nothing " +
  "else: if a single thing is useful, write a single sentence. If nothing is, write one short sentence such as " +
  "\"Rien de particulier aujourd'hui.\" and stop. " +
  "Write only the final text meant for the screen: no reasoning, no correcting yourself, no field name from the JSON. " +
  "Don't make anything up and ignore missing fields. " +
  'JSON context: ' + JSON.stringify(context);

function readCache() {
  try {
    return JSON.parse(fs.readFileSync(cacheFile(), 'utf8'));
  } catch (e) {
    if (e.code === 'ENOENT') return {};
    if (!(e instanceof SyntaxError)) throw e;
    return {};                                  // a corrupt cache is simply regenerated
  }
}

let running = false;   // two tabs posting together must not both pass the guard

async function briefing(context) {
  if (!ctx.cfg.anthropicApiKey) return { text: null };
  const now = new Date(), s = settings();
  const slot = slotOf(now, s.slots), ev = events(context);
  const cached = readCache();
  const calls = cached.calls || [];
  // While the guard holds, a text from an earlier slot of the same day beats an empty line.
  const kept = cached.text && cached.day === slot.day && cached.lang === ctx.lang
    ? { text: plain(cached.text), slot: cached.slot, at: cached.at } : { text: null };
  if (isFresh(cached, slot, ctx.lang, ev) || running || !mayCall(calls, now.getTime(), s)) return kept;
  const sent = { now: now.toTimeString().slice(0, 5), slot: slot.slot, ...context };
  let reason = null, j;
  running = true;
  try {
    j = await orNull('Anthropic', async () => {
      const url = 'https://api.anthropic.com/v1/messages';
      const r = await request(url, {
        method: 'POST', timeout: 30000,
        headers: { 'content-type': 'application/json', 'x-api-key': ctx.cfg.anthropicApiKey, 'anthropic-version': '2023-06-01' },
        body: JSON.stringify({
          // Thinking stays on, and counts in max_tokens: hence 2000 for three sentences.
          // Turned off, the model reasoned and corrected itself inside the answer.
          model: MODEL, max_tokens: 2000,
          messages: [{ role: 'user', content: prompt(sent) }],
        }),
      });
      if (r.ok) return parseJson(r.text, url);
      // Anthropic explains itself in error.message (bad key, no credit, unknown model):
      // without it the console only said "HTTP 400" and the card stayed silently empty.
      let detail = '';
      try { detail = JSON.parse(r.text).error.message; } catch { detail = r.text.slice(0, 200); }
      reason = `HTTP ${r.status}: ${detail}`;
      throw new SourceError(`api.anthropic.com: ${reason}`);
    });
  } finally {
    running = false;
  }
  // The answer opens with a `thinking` block (sometimes empty): keep only the text blocks.
  const raw = j && Array.isArray(j.content) ? j.content.filter((b) => b.type === 'text').map((b) => b.text).join('').trim() : '';
  let text = raw ? plain(raw) : null;
  if (j && !text) reason = 'answer without text';
  const flaw = text && rejection(text, ctx.lang, sent);
  if (flaw) { reason = 'text rejected: ' + flaw; text = null; }
  // a failed request was logged by orNull already
  if (j && reason) logError('Briefing', new Error(reason));
  if (j && j.stop_reason === 'max_tokens') logError('Anthropic', new Error('answer cut at max_tokens'));
  // A failed attempt counts too, or a rejected key would be retried at every refresh of the page.
  const made = [...calls, now.getTime()].filter((t) => now.getTime() - t < DAY_MS);
  const entry = text ? { day: slot.day, slot: slot.slot, lang: ctx.lang, events: ev, text, at: now.getTime() } : cached;
  fs.writeFileSync(cacheFile(), JSON.stringify({ ...entry, calls: made }));
  const out = text ? { text, slot: slot.slot, at: now.getTime() } : kept;
  return reason ? { ...out, error: reason } : out;
}

module.exports = { briefing, settings, plain, prompt, rejection, slotOf, events, isFresh, mayCall };
