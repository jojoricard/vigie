/* Daily AI briefing (optional, needs anthropicApiKey).
 * The page sends the context split in two: `alreadyShown` (on screen, must not be
 * repeated) and `toAnalyze` (what the display can't say). The model therefore only
 * brings foresight and advice. */
const fs = require('fs');
const path = require('path');
const ctx = require('./context');
const { fetchJson, orNull, logError } = require('./errors');
const { dayKey } = require('./storage');

const MODEL = 'claude-haiku-5-5';
const cacheFile = () => path.join(ctx.root, '.briefing.json');

// The prompt forbids them, the model still slips one in now and then: an em dash (or a
// spaced en dash) becomes a comma, a semicolon ends the sentence. "12–18°" stays.
const plain = (s) => s.replace(/\s*—\s*|\s+–\s+/g, ', ').replace(/\s*;\s*(\S)/gu, (_, c) => '. ' + c.toUpperCase());

const prompt = (context) =>
  "You write the context line of a personal dashboard I look at all day. " +
  "The dashboard already shows, in large type right next to your text: the temperature, the sky, " +
  "weather warnings, pollen, air quality and the name day (field alreadyShown). " +
  "Absolute rule: repeat none of this information, nor its figures. Saying it again has no value. " +
  "Your job is to bring what the screen cannot show, from the field toAnalyze: " +
  "(1) what is coming in the next days (rain arriving, a hot spell starting or ending, " +
  "temperatures dropping); (2) one concrete piece of advice that follows from the data (air the rooms at night " +
  "if lowTonight is low, go out early, take an umbrella on a given day); (3) the state of my PC: recentIncident " +
  "(quote its 'when' field word for word), and the machine field: days without incident, detected breaks, " +
  "freeze/power cut split. The titles of the breaks are already on screen, but not their figures: give the " +
  "figure and above all draw a consequence, never just repeat the title. A freeze points to the graphics driver, " +
  "a hard power cut to the power supply. The electricity field only deserves a mention if the projection is " +
  "clearly off from the previous month. " +
  `Write in ${ctx.lang === 'fr' ? 'French' : 'English'}, 3 sentences at most, direct tone, no title, no list, no greeting. ` +
  "Spend at most one sentence on the machine, and only if something is notable. Never use an em dash. " +
  "If nothing notable stands out, write one short, honest sentence. " +
  "Don't make anything up and ignore empty fields. " +
  'JSON context: ' + JSON.stringify(context);

function readCache() {
  try {
    return JSON.parse(fs.readFileSync(cacheFile(), 'utf8'));
  } catch (e) {
    if (e.code === 'ENOENT') return null;
    if (!(e instanceof SyntaxError)) throw e;
    return null;                                // a corrupt cache is simply regenerated
  }
}

async function briefing(context) {
  if (!ctx.cfg.anthropicApiKey) return { text: null };
  const today = dayKey(new Date());
  const cached = readCache();
  if (cached && cached.date === today && cached.lang === ctx.lang && cached.text) return { ...cached, text: plain(cached.text) };
  const j = await orNull('Anthropic', () => fetchJson('https://api.anthropic.com/v1/messages', {
    method: 'POST', timeout: 30000,
    headers: { 'content-type': 'application/json', 'x-api-key': ctx.cfg.anthropicApiKey, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model: MODEL, max_tokens: 400, messages: [{ role: 'user', content: prompt(context) }] }),
  }));
  const text = j && j.content && j.content[0] && j.content[0].text ? plain(j.content[0].text.trim()) : null;
  if (j && !text) logError('Anthropic', new Error('answer without text'));
  const out = { date: today, lang: ctx.lang, text };
  if (text) fs.writeFileSync(cacheFile(), JSON.stringify(out));
  return out;
}

module.exports = { briefing, plain };
