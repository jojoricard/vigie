/* Demo mode (node agent.js --demo): every route answers with made-up figures, so the
 * page can be shown, captured and checked on any machine, without LibreHardwareMonitor,
 * PowerShell, a network or anybody's home. Nothing here is read from config.json or
 * vigie.db, and nothing is written. The house is the made-up flat of house/demo. */
const fs = require('fs');
const path = require('path');

const HOUR = 3600e3, DAY = 24 * HOUR;
const pad = (n) => String(n).padStart(2, '0');
const localIso = (t) => { const d = new Date(t); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`; };
const dayKey = (t) => localIso(t).slice(0, 10);
// The same figures at every call: a capture must not change with the dice.
const wave = (i, period, amp, phase = 0) => Math.sin((i / period) * 2 * Math.PI + phase) * amp;
const noise = (i, seed = 1) => { const x = Math.sin(i * 127.1 + seed * 311.7) * 43758.5453; return x - Math.floor(x); };
const round = (v, n = 1) => Math.round(v * 10 ** n) / 10 ** n;

const CITIES = [
  { name: 'Port-Alba', short: 'Port-Alba', lat: 46.2, lon: 2.4 },
  { name: 'Valmont', short: 'Valmont', lat: 45.6, lon: 4.1 },
  { name: 'Les Aiguilles', short: 'Les Aiguilles', lat: 45.1, lon: 6.2 },
];
const SNOW = [
  { name: 'Col du Lac', lat: 45.12, lon: 6.21, alt: 1920 },
  { name: 'Les Aiguilles', lat: 45.1, lon: 6.2, alt: 1580 },
  { name: 'Pré Rond', lat: 45.08, lon: 6.15, alt: 1320 },
];
const TOOLS = [
  { name: 'Dev', icon: 'code', releases: ['example/runtime', 'example/editor'], links: ['Docs', 'Reference', 'Playground', 'Packages', 'Status'].map((label) => ({ label, url: `https://example.com/${label.toLowerCase()}` })) },
  { name: 'Hardware', icon: 'chip', releases: ['example/monitor', 'example/tray'], links: ['Monitor', 'Drivers', 'Firmware'].map((label) => ({ label, url: `https://example.com/${label.toLowerCase()}` })) },
  { name: 'Console', icon: 'gamepad', releases: ['example/loader'], links: ['Guide', 'Releases', 'Themes', 'Saves'].map((label) => ({ label, url: `https://example.org/${label.toLowerCase()}` })) },
];

function houseConfig() {
  return JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'house', 'demo', 'config.json'), 'utf8')).house;
}

function config(lang) {
  return {
    lang: lang === 'fr' ? 'fr' : 'en', country: 'FR', cities: CITIES, snowSpots: SNOW, theme: { color: '#51007a' },
    anthropicApiKey: 'demo', tools: TOOLS, house: houseConfig(),
    night: null, dimming: null,
  };
}

/* ---------- Agent routes ---------- */
function history(range) {
  const rangeMs = { '1h': HOUR, '6h': 6 * HOUR, '12h': 12 * HOUR, '1d': DAY, '7d': 7 * DAY, '30d': 30 * DAY }[range] || DAY;
  const n = 240, bucket = Math.max(30000, Math.round(rangeMs / n / 30000) * 30000), now = Date.now();
  const samples = [];
  for (let i = 0; i < n; i++) {
    const t = now - (n - 1 - i) * bucket, k = Math.round(t / 600000);
    const load = 12 + wave(k, 37, 10) + noise(k) * 14;
    samples.push([t, round(44 + load * 0.5), round(48 + load * 0.4 + noise(k, 2) * 6), null, round(load), round(load * 1.3 + noise(k, 3) * 9), round(38 + wave(k, 90, 4)),
      round(noise(k, 4) * 900000, 0), round(noise(k, 5) * 90000, 0), round(47 + wave(k, 120, 3)), round(600 + load * 9, 0), round(820 + load * 6, 0), round(28 + load), round(40 + load * 2.2), round(8 + noise(k, 6) * 6)]);
  }
  return { rangeMs, bucket, samples, today: { c: [38, 71], g: [41, 66] } };
}

function year() {
  const now = Date.now(), daily = [], months = new Map();
  for (let i = 79; i >= 0; i--) {
    const t = now - i * DAY, h = round(4 + noise(i, 7) * 9), kwh = round(h * 0.19, 2), m = dayKey(t).slice(0, 7);
    daily.push({ d: dayKey(t), h, t: Math.round(52 + noise(i, 8) * 22) });
    const e = months.get(m) || { month: m, kwh: 0, hours: 0, days: 0 };
    e.kwh = round(e.kwh + kwh, 2); e.hours = round(e.hours + h); e.days++;
    months.set(m, e);
  }
  const list = [...months.values()], cur = dayKey(now).slice(0, 7);
  list[0].partial = true;
  for (const m of list) m.current = m.month === cur;
  return { days: 80, first: dayKey(now - 79 * DAY), windowDays: 80, price: 0.2016, months: list, daily: daily.slice(-70) };
}

const GET = {
  '/sensors': () => ({
    count: 42, cpuLoad: 14, cpuTemp: 46, gpuLoad: 22, gpuTemp: 51, gpuHot: 62, gpuVram: 58, ramLoad: 41, ramUsed: 13.1, ramTemp: null, liquidTemp: null,
    cpuPower: 38, gpuPower: 64, net: { down: 420000, up: 38000 }, diskTemps: [47], fans: [{ name: 'GPU Fan', rpm: 640, source: 'gpu' }],
    ssd: { life: 91, hours: 5200, writtenTB: 112 },
  }),
  '/system': () => ({ uptime: 5 * 3600 + 40 * 60 }),
  '/devices': () => ({
    disks: [{ id: 'C:', total: 2e12, free: 1.21e12 }, { id: 'D:', total: 4e12, free: 0.9e12 }],
    batteries: [{ name: 'Wireless Mouse', level: 12, stale: false }, { name: 'Wireless Keyboard', level: 80, stale: false }, { name: 'Headset', level: 55, stale: true }],
  }),
  '/alerts': () => [
    { type: 'rain', severity: 'orange', area: 'Port-Alba', expires: Date.now() + 9 * HOUR, description: 'Heavy rain expected from the late afternoon, with local flooding of low roads. Made-up warning of the demo.' },
    { type: 'wind', severity: 'yellow', area: 'Les Aiguilles', expires: Date.now() + 20 * HOUR, description: 'Gusts up to 80 km/h on the ridges.' },
  ],
  '/nameday': () => ({ text: 'Albert' }),
  '/energy': () => ({
    tempo: { code: 1, color: 'blue' }, tempoTomorrow: { code: 3, color: 'red' }, tempoLeft: { blue: 214, white: 38, red: 19 }, carbon: { gco2: 34 },
    tempoMonth: Array.from({ length: new Date().getDate() }, (_, i) => ({ date: dayKey(new Date(new Date().getFullYear(), new Date().getMonth(), i + 1).getTime()), code: [1, 1, 2, 1, 1, 3, 1, 2, 1, 1][i % 10] })),
    carbonDay: Array.from({ length: 24 }, (_, i) => ({ at: Math.floor(Date.now() / HOUR) * HOUR - (23 - i) * HOUR, gco2: Math.round(38 + 16 * Math.sin((i - 6) / 3.8) + (i % 5)) })),
    consumption: {
      today: { kwh: 1.42, hours: 5.6, cost: 0.29, measured: 5.6 }, month: { kwh: 21.8, hours: 96, cost: 4.39 }, avgWatts: 254, baseWatts: 0, price: 0.2016,
      hoursPerDay: 7.4, monthly: { projection: 43.5, previous: { month: dayKey(Date.now() - 31 * DAY).slice(0, 7), kwh: 38.2 }, current: { kwh: 21.8, hours: 96 } },
    },
    normals: [{ maxNormal: 11.5 }, { maxNormal: 10.8 }, { maxNormal: 6.2 }],
  }),
  '/network': () => ({ samples: 1120, target: '1.1.1.1', latest: 9, failingNow: false, avg: 11, max: 48, jitter: 2, loss: 0.2 }),
  '/changes': () => [{ kind: 'consumption', level: 'info', yesterday: 2.4, usual: 1.3 }],
  '/markers': () => [{ t: Date.now() - 9 * HOUR, type: 'update', kind: 'gpuDriver' }],
  '/year': year,
  '/crash': () => {
    const at = Date.now() - 12 * DAY;
    return {
      report: { at, type: 'unexpected', hints: [{ kind: 'freeze', silence: 540 }], samples: [0, 1, 2, 3].map((i) => ({ t: at - 600000 - i * 30000, c: 52 + i, g: 61 - i, l: null, r: 44 })) },
      history: [{ t: at, type: 'unexpected', nature: 'freeze', silence: 540 }, { t: at - 16 * DAY, type: 'bsod', nature: 'undetermined', silence: 90 }],
      counts: { last: at, d7: 0, d30: 2, natures: { freeze: 1, cut: 0 } },
    };
  },
  '/machine': () => ({
    cpu: 'Example Core 16', cores: 16, threads: 24, gpu: 'Example Graphics 7900', gpuDriver: '32.0.1', gpuDriverDate: new Date(Date.now() - 21 * DAY).toISOString(),
    motherboard: 'Example Board Z', bios: '18.02', biosDate: new Date(Date.now() - 400 * DAY).toISOString(), ram: [{ gb: 16, mhz: 4800, part: 'EX32G' }, { gb: 16, mhz: 4800, part: 'EX32G' }],
    disks: [{ model: 'Example NVMe', gb: 1900 }, { model: 'Example HDD', gb: 4000 }], os: 'Windows 11 Pro', build: '26200', hotfix: 'KB5000001', hotfixDate: new Date(Date.now() - 4 * DAY).toISOString(),
  }),
  '/tools': () => TOOLS,
  '/releases': () => ({
    'example/runtime': { version: 'v26.13.1', url: 'https://example.com/runtime', date: new Date(Date.now() - 3 * DAY).toISOString(), installed: '24.14.0', outdated: true },
    'example/editor': { version: 'v1.102', url: 'https://example.com/editor', date: new Date(Date.now() - 23 * DAY).toISOString(), installed: '1.102', outdated: false },
    'example/monitor': { version: 'v0.9.6', url: 'https://example.com/monitor', date: new Date(Date.now() - 270 * DAY).toISOString(), installed: '0.9.6', outdated: false },
    'example/tray': { version: 'v3.0.3', url: 'https://example.com/tray', date: new Date(Date.now() - 900 * DAY).toISOString() },
    'example/loader': { version: 'v6.5.5', url: 'https://example.org/loader', date: new Date(Date.now() - 2 * DAY).toISOString() },
  }),
  '/holidays': () => ({ publicHoliday: null, school: null }),
  '/fuel': () => ['e10', 'sp98'].map((type, k) => ({
    type, previous: { date: dayKey(Date.now() - 6 * DAY), price: 1.71 + k * 0.1 },
    history: Array.from({ length: 30 }, (_, i) => ({ date: dayKey(Date.now() - (29 - i) * DAY), price: round(1.74 + k * 0.1 - i * 0.0015 + 0.02 * Math.sin(i / 3), 3) })),
    stations: [0, 1, 2].map((i) => ({ price: round(1.699 + k * 0.1 + i * 0.03, 3), address: `${12 + i * 31} Harbour Road`, city: 'Port-Alba', distance: 1200 + i * 1400, updated: Date.now() - i * DAY })),
  })),
  '/windows': () => ({ reboot: [], updates: [] }),
  '/media': () => ({ status: 'playing', title: 'Morning Set', artist: 'The Examples', name: 'Player' }),
};

function configRoute(base) {
  return { ...base, demo: true, hasBriefing: true };
}

const BRIEF = {
  en: 'Heavy rain from 17:00 to 21:00, about 15 mm: take an umbrella if you go out. Tempo is red tomorrow, run the washing machine tonight.',
  fr: 'Pluie forte de 17 h à 21 h, environ 15 mm : prends un parapluie si tu sors. Tempo rouge demain, lance le lave-linge ce soir.',
};
const briefing = (lang) => ({ text: BRIEF[lang] || BRIEF.en, at: Date.now() - 40 * 60000 });

/* ---------- What the page asks the outside world, answered here ----------
 * Open-Meteo's shapes (forecast, air quality), from the hour and the place asked. */
function hourly(startMidnight, days, fn) {
  const time = [], out = {};
  for (let i = 0; i < days * 24; i++) {
    time.push(localIso(startMidnight + i * HOUR));
    for (const [k, v] of Object.entries(fn(i))) (out[k] = out[k] || []).push(v);
  }
  return { time, ...out };
}

function forecast(q) {
  const lat = Number(q.get('latitude')) || 46, alt = Number(q.get('elevation')) || 0, now = Date.now();
  const midnight = new Date(now); midnight.setHours(0, 0, 0, 0);
  const past = Number(q.get('past_days')) || 0, days = Number(q.get('forecast_days')) || 7;
  const start = midnight.getTime() - past * DAY;
  const cold = (46 - lat) * -4 + alt / 180;          // the mountain city is colder
  const temp = (i) => round(11 - cold + wave(i - 9, 24, 4.5) - Math.floor(i / 24) * 0.6);
  const rainAt = (i) => { const h = i % 24, d = Math.floor(i / 24); return (d === 0 && h >= 17 && h <= 21) || d === 2 ? round(0.6 + noise(i) * 3.2) : 0; };
  const code = (i) => rainAt(i) > 2 ? 63 : rainAt(i) > 0 ? 61 : [3, 2, 3, 1][Math.floor(i / 24) % 4];
  const out = { latitude: lat, longitude: Number(q.get('longitude')), utc_offset_seconds: -new Date().getTimezoneOffset() * 60 };
  const wantsHourly = (q.get('hourly') || '').split(',').filter(Boolean);
  if (wantsHourly.length) {
    const all = hourly(start, past + days, (i) => ({
      uv_index: round(Math.max(0, wave((i % 24) - 6, 24, 2.4))), temperature_2m: temp(i), apparent_temperature: round(temp(i) - 2.2), precipitation: rainAt(i),
      precipitation_probability: rainAt(i) > 0 ? 80 + Math.round(noise(i, 2) * 15) : Math.round(noise(i, 3) * 20), weather_code: code(i),
      wind_speed_10m: Math.round(14 + noise(i, 4) * 16), wind_gusts_10m: Math.round(30 + noise(i, 5) * 28), relative_humidity_2m: Math.round(70 + wave(i, 24, 12)),
      pressure_msl: round(1013 + wave(i, 60, 6) - i * 0.04), snow_depth: alt > 1500 ? round(0.18 + i * 0.0015, 3) : alt > 1300 ? 0.04 : 0, freezing_level_height: 2250 - i * 4,
    }));
    out.hourly = { time: all.time, ...Object.fromEntries(wantsHourly.filter((k) => all[k]).map((k) => [k, all[k]])) };
  }
  if (q.get('current')) {
    const i = new Date(now).getHours();
    out.current = { time: localIso(now), temperature_2m: temp(i), relative_humidity_2m: 73, apparent_temperature: round(temp(i) - 2.4), is_day: i >= 8 && i < 17 ? 1 : 0, weather_code: 3, wind_speed_10m: 25, wind_direction_10m: 190, wind_gusts_10m: 44 };
  }
  if (q.get('minutely_15')) {
    const t0 = Math.floor(now / 900000) * 900000;
    out.minutely_15 = { time: Array.from({ length: 12 }, (_, i) => localIso(t0 + i * 900000)), precipitation: [0, 0, 0.1, 0.4, 0.9, 1.2, 0.8, 0.3, 0, 0, 0, 0] };
  }
  if (q.get('daily')) {
    const idx = Array.from({ length: days }, (_, d) => d);
    const dayTemps = (d) => Array.from({ length: 24 }, (_, h) => temp(d * 24 + h));
    out.daily = {
      time: idx.map((d) => dayKey(midnight.getTime() + d * DAY)), weather_code: idx.map((d) => d === 0 ? 61 : d === 2 ? 63 : [3, 2, 3, 1, 45][d % 5]),
      temperature_2m_max: idx.map((d) => Math.max(...dayTemps(d))), temperature_2m_min: idx.map((d) => Math.min(...dayTemps(d))),
      sunrise: idx.map((d) => `${dayKey(midnight.getTime() + d * DAY)}T07:${pad(40 + d)}`), sunset: idx.map((d) => `${dayKey(midnight.getTime() + d * DAY)}T17:${pad(9 - d)}`),
      daylight_duration: idx.map((d) => 34140 - d * 120), precipitation_probability_max: idx.map((d) => d === 0 ? 90 : d === 2 ? 100 : 18 + d * 6), precipitation_sum: idx.map((d) => d === 0 ? 14.6 : d === 2 ? 9.2 : 0),
      uv_index_max: idx.map((d) => round(2.5 - d * 0.2)), wind_speed_10m_max: idx.map((d) => 21 + d * 2), wind_gusts_10m_max: idx.map((d) => 44 + d * 3),
      snowfall_sum: idx.map((d) => alt > 1300 ? (d === 2 ? 9 : d === 3 ? 4 : 0) : 0),
    };
  }
  return out;
}

function airQuality(q) {
  const lat = Number(q.get('latitude')) || 46, midnight = new Date(); midnight.setHours(0, 0, 0, 0);
  const pollens = ['alder_pollen', 'birch_pollen', 'grass_pollen', 'mugwort_pollen', 'olive_pollen', 'ragweed_pollen'];
  const grass = (i) => Math.max(0, round(18 + wave(i - 8, 24, 16) + Math.floor(i / 24) * 6));
  return {
    current: { european_aqi: lat > 46 ? 52 : lat > 45.5 ? 28 : 16, pm2_5: 9, pm10: 14, nitrogen_dioxide: 11, ozone: 61, ...Object.fromEntries(pollens.map((p) => [p, p === 'grass_pollen' ? 22 : 0])) },
    hourly: hourly(midnight.getTime(), 4, (i) => Object.fromEntries(pollens.map((p) => [p, p === 'grass_pollen' ? grass(i) : 0]))),
  };
}

// Answer for an outside URL the page would have fetched, or null when the demo has none.
function external(raw) {
  if (!URL.canParse(raw)) return null;
  const u = new URL(raw);
  if (u.hostname === 'api.open-meteo.com') return forecast(u.searchParams);
  if (u.hostname === 'air-quality-api.open-meteo.com') return airQuality(u.searchParams);
  if (u.hostname === 'api.rainviewer.com') return { radar: { past: [], nowcast: [] } };
  return null;
}

module.exports = { config, configRoute, houseConfig, GET, history, briefing, external, forecast, airQuality };
