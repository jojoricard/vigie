/* Daikin air conditioners: local HTTP API of the Wi-Fi adapter (BRP069 / BRP072), no
 * key and no cloud. Answers are "key=value,key=value", never JSON.
 * Config of a device: { driver: "daikin", ip }. */
const http = require('http');
const { DeviceError, clamp } = require('../util');

function parse(text) {
  const out = {};
  for (const kv of String(text || '').split(',')) {
    const i = kv.indexOf('=');
    if (i > 0) out[kv.slice(0, i)] = kv.slice(i + 1);
  }
  return out;
}

// fetch() (undici) gets a 403 from these units: their embedded server rejects the
// "Host: ip:80" it sends. The native http module works.
function httpGet(ip, path) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: ip, port: 80, path, method: 'GET', headers: { Host: ip }, timeout: 4000 }, (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => resolve(body));
    });
    req.on('timeout', () => req.destroy(new DeviceError('timeout')));
    req.on('error', (e) => reject(e instanceof DeviceError ? e : new DeviceError(e.message)));
    req.end();
  });
}

// Values of get_control_info, as named by pydaikin and Home Assistant.
const MODE = { 0: 'auto', 1: 'auto', 7: 'auto', 2: 'dry', 3: 'cool', 4: 'heat', 6: 'fan' };
const MODE_CODE = { auto: '0', dry: '2', cool: '3', heat: '4', fan: '6' };
const FAN = { A: 'auto', B: 'quiet', 3: '1', 4: '2', 5: '3', 6: '4', 7: '5' };
const SWING = { 0: 'off', 1: 'vertical', 2: 'horizontal', 3: 'both' };
const codeOf = (map, name) => Object.keys(map).find((k) => map[k] === name);
// "adv" lists the special modes that are on: "2" powerful, "12" econo, "13" streamer, "2/13"…
const ADV = { powerful: '2', econo: '12', streamer: '13' };
const SPMODE_KIND = { powerful: '1', econo: '2' };

const num = (v) => { const n = parseFloat(v); return Number.isFinite(n) ? n : null; };   // "-", "M" and "--" are not numbers
const sum = (list) => String(list || '').split('/').reduce((s, x) => s + (parseInt(x, 10) || 0), 0);
const kwh = (tenths) => Math.round(tenths) / 10;                                          // the *_ex counters are in 0.1 kWh

/* Energy of one indoor unit, heating and cooling together, in kWh. The *_ex answers
 * are per indoor unit. get_week_power and get_year_power are not used: on a multi-split
 * they give the total of the outdoor unit, the same figure on every indoor unit. */
function energy(day, week, year, month) {
  const perDay = (k) => String(week[k] || '').split('/').map((x) => parseInt(x, 10) || 0);   // 14 days, today first
  const heat = perDay('week_heat'), cool = perDay('week_cool');
  const months = (k) => String(year[k] || '').split('/').map((x) => parseInt(x, 10) || 0);   // January first
  return {
    today: kwh(sum(day.curr_day_heat) + sum(day.curr_day_cool)),
    yesterday: kwh(sum(day.prev_1day_heat) + sum(day.prev_1day_cool)),
    week: kwh(heat.slice(0, 7).concat(cool.slice(0, 7)).reduce((a, b) => a + b, 0)),
    month: kwh((months('curr_year_heat')[month] || 0) + (months('curr_year_cool')[month] || 0)),
    year: kwh(sum(year.curr_year_heat) + sum(year.curr_year_cool)),
  };
}

const SLOW_MS = 10 * 60 * 1000;   // counters and timers move slowly: one read per 10 minutes

function create({ get = httpGet, now = Date.now } = {}) {
  const models = new Map();   // ip -> get_model_info, read once
  const known = new Map();    // ip -> capabilities, which never change
  const slow = new Map();     // ip -> { at, energy, timer, schedule }

  async function call(device, path) {
    let text;
    try {
      text = await get(device.ip, path);
    } catch (e) {
      if (!(e instanceof DeviceError)) throw e;
      throw new DeviceError(`${device.name}: ${e.message}`);
    }
    const j = parse(text);
    if (j.ret !== 'OK') throw new DeviceError(`${device.name}: ${j.ret || 'no answer'}`);
    return j;
  }
  // Optional answers: an older firmware without the endpoint just lacks the feature.
  const optional = (device, path) => call(device, path).catch((e) => { if (!(e instanceof DeviceError)) throw e; return null; });

  async function model(device) {
    if (!models.has(device.ip)) models.set(device.ip, await call(device, '/aircon/get_model_info'));
    return models.get(device.ip);
  }

  // What this unit can do, from what it says about itself: nothing is assumed.
  async function capabilities(device) {
    if (known.has(device.ip)) return known.get(device.ip);
    const [m, c] = await Promise.all([model(device), call(device, '/aircon/get_control_info')]);
    const caps = {
      on: { type: 'boolean' },
      mode: { options: ['auto', 'heat', 'cool', 'dry', 'fan'] },
      setpoint: { min: num(m.hmlmt_l) || 10, max: 32, step: 0.5 },
    };
    if (m.en_frate === '1') caps.fan = { options: ['auto', 'quiet', '1', '2', '3', '4', '5'] };
    if (m.en_fdir === '1') caps.swing = { options: m.s_fdir === '3' ? ['off', 'vertical', 'horizontal', 'both'] : ['off', 'vertical'] };
    if ('adv' in c) { caps.powerful = { type: 'boolean' }; caps.econo = { type: 'boolean' }; }
    if ('en_streamer' in c) caps.streamer = { type: 'boolean' };
    known.set(device.ip, caps);
    return caps;
  }

  async function slowInfo(device) {
    const cached = slow.get(device.ip);
    if (cached && now() - cached.at < SLOW_MS) return cached;
    const m = await model(device);
    const [day, week, year, timer, schedule] = await Promise.all([
      optional(device, '/aircon/get_day_power_ex'), optional(device, '/aircon/get_week_power_ex'), optional(device, '/aircon/get_year_power_ex'),
      m.en_onofftmr === '1' ? optional(device, '/aircon/get_onofftimer') : null,
      m.en_scdltmr === '1' ? optional(device, '/aircon/get_scdltimer_info') : null,
    ]);
    const info = {
      at: now(),
      energy: day && week && year ? energy(day, week, year, new Date(now()).getMonth()) : null,
      // Read only: the format of the timer entries is documented nowhere.
      timer: timer ? { enabled: timer.enable === '1' } : null,
      schedule: schedule ? { enabled: schedule.en_scdltimer === '1' } : null,
    };
    slow.set(device.ip, info);
    return info;
  }

  async function state(device) {
    const [c, s, info] = await Promise.all([
      call(device, '/aircon/get_control_info'),
      optional(device, '/aircon/get_sensor_info'),      // temperatures are a bonus: the unit still shows without them
      slowInfo(device),
    ]);
    const adv = String(c.adv || '').split('/');
    const out = {
      reachable: true, on: c.pow === '1', mode: MODE[c.mode] || null, setpoint: num(c.stemp),
      fan: FAN[c.f_rate] || null, swing: SWING[c.f_dir] || null,
      // the probe of the indoor unit, not the temperature of the room: it reads several degrees high
      probeTemp: s ? num(s.htemp) : null, outdoorTemp: s ? num(s.otemp) : null,
      energy: info.energy, timer: info.timer, schedule: info.schedule,
    };
    if ('adv' in c) { out.powerful = adv.includes(ADV.powerful); out.econo = adv.includes(ADV.econo); }
    if ('en_streamer' in c) out.streamer = adv.includes(ADV.streamer);
    return out;
  }

  /* set_control_info expects every field on every call: leaving one out resets it. The
   * current state is read and only the requested fields change. Each mode keeps its own
   * target (dt3 for cooling, dt4 for heating): a change of mode takes that one, since the
   * current target may be "M" (dry) or "--" (fan), which the unit refuses. */
  async function set(device, changes) {
    if (['on', 'mode', 'setpoint', 'fan', 'swing'].some((k) => k in changes)) {
      const cur = await call(device, '/aircon/get_control_info');
      const mode = changes.mode ? MODE_CODE[changes.mode] : cur.mode;
      const modeChanged = mode !== cur.mode;
      const caps = await capabilities(device);
      const stemp = changes.setpoint != null ? clamp(Number(changes.setpoint), caps.setpoint.min, caps.setpoint.max).toFixed(1)
        : modeChanged ? cur['dt' + mode] || cur.stemp : cur.stemp;
      const merged = {
        pow: changes.on != null ? (changes.on ? '1' : '0') : cur.pow,
        mode, stemp,
        shum: modeChanged ? cur['dh' + mode] || cur.shum : cur.shum,
        f_rate: changes.fan ? codeOf(FAN, changes.fan) : cur.f_rate,
        f_dir: changes.swing ? codeOf(SWING, changes.swing) : cur.f_dir,
      };
      await call(device, '/aircon/set_control_info?' + new URLSearchParams(merged).toString());
    }
    for (const k of ['powerful', 'econo']) {
      if (k in changes) await call(device, `/aircon/set_special_mode?set_spmode=${changes[k] ? 1 : 0}&spmode_kind=${SPMODE_KIND[k]}`);
    }
    if ('streamer' in changes) await call(device, `/aircon/set_special_mode?en_streamer=${changes.streamer ? 1 : 0}`);
  }

  // Units are declared by IP: the adapter has no discovery worth relying on.
  const list = async () => [];

  return { capabilities, state, set, list };
}

module.exports = { create, parse, energy };
