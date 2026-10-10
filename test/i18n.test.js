// Every key used by the page exists in both languages, with the same shape.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');

const JS_DIR = path.join(__dirname, '..', 'public', 'js');
const sources = fs.readdirSync(JS_DIR).map((f) => fs.readFileSync(path.join(JS_DIR, f), 'utf8')).join('\n')
  + fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');

// Keys built at runtime, with every value they can take.
const DYNAMIC = {
  'alert.': ['thunderstorm', 'heat', 'cold', 'rainFlood', 'rain', 'flood', 'wind', 'snowIce', 'fog', 'avalanche', 'forestFire', 'coastal', 'warning'],
  'sev.': ['yellow', 'orange', 'red'],
  'incident.': ['bsod', 'hardware', 'unexpected', 'powerLoss'],
  'incidentLong.': ['bsod', 'hardware', 'unexpected', 'powerLoss'],
  'nature.': ['freeze', 'cut', 'undetermined'],
  'hint.': ['cpuHot', 'gpuHot', 'liquidHot', 'ramFull', 'bsod', 'whea', 'freeze', 'cut', 'noData'],
  'marker.': ['gpuDriver', 'bios', 'windows'],
  'chg.': ['latency', 'packetLoss', 'thermal', 'consumption', 'diskDrop', 'incidents'],
  'fan.': ['kraken', 'nzxt', 'gpu', 'motherboard'],
  'daikin.': ['mode', 'rate', 'dir'],
  'pub.': ['newYear', 'easterMonday', 'labourDay', 'victoryDay', 'ascension', 'whitMonday', 'bastilleDay', 'assumption', 'allSaints', 'armistice', 'christmas', 'other'],
  'break.': ['autumn', 'christmas', 'winter', 'spring', 'ascensionBridge', 'summer', 'other'],
  'pressure.': ['steady', 'rising', 'falling', 'risingFast', 'fallingFast'],
  'fuel.': ['gazole', 'sp95', 'e10', 'sp98', 'e85', 'gplc'],
};

test('the dictionaries are complete and consistent', async () => {
  const { I18N } = await import(pathToFileURL(path.join(JS_DIR, 'i18n.js')));
  const { WMO_CODES } = await import(pathToFileURL(path.join(JS_DIR, 'weather.js')));
  const en = Object.keys(I18N.en), fr = Object.keys(I18N.fr);
  assert.deepEqual([...en].sort(), [...fr].sort(), 'en and fr must have the same keys');

  for (const k of en) {
    assert.equal(typeof I18N.en[k], typeof I18N.fr[k], `${k}: same type in both languages`);
    if (Array.isArray(I18N.en[k])) assert.equal(I18N.en[k].length, I18N.fr[k].length, `${k}: same length`);
  }

  const used = new Set();
  for (const m of sources.matchAll(/\bt\("([^"]+)"/g)) if (!m[1].endsWith('.')) used.add(m[1]);
  for (const m of sources.matchAll(/data-i18n="([^"]+)"/g)) used.add(m[1]);
  for (const [prefix, values] of Object.entries(DYNAMIC)) for (const v of values) used.add(prefix + v);
  for (const code of WMO_CODES) used.add('wmo.' + code);

  const missing = [...used].filter((k) => !(k in I18N.en));
  assert.deepEqual(missing, [], 'keys used but not defined');
  const unused = en.filter((k) => !used.has(k));
  assert.deepEqual(unused, [], 'keys defined but never used');
});
