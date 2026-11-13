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

/* The weekly program of a unit, as the unit stores it, so it runs with the service off.
 * get_scdltimer_info says how an entry is laid out ("f_detail": the fields in order,
 * each with its width), which of its three programs is the active one and how many
 * entries a day holds. get_scdltimer_body gives that program: a count per day ("moc" to
 * "suc") and the entries ("mo1", "mo2"…), each one a string of fixed-width fields.
 * As read on real units:
 *   "11420.50390B------"  enabled, on, mode 4 (heat), target 20.5, minute 390 of the day
 *                         (06:30), fan B (quiet), then vane, humidity, special mode blank
 *   "10-----1350-------"  enabled, off at 22:30: mode, target and fan are dashes
 *   "112----0840-------"  on in dry mode at 14:00: no target and no fan either
 * set_scdltimer_body takes the same keys back, set_scdltimer_info the active program
 * and whether it runs. Sending back what was read leaves the unit unchanged.
 * A code that is not known reads as null, and such an entry is sent back as it came. */
const DAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];
const DAY_KEY = { mon: 'mo', tue: 'tu', wed: 'we', thu: 'th', fri: 'fr', sat: 'sa', sun: 'su' };
// what a new entry may ask for: the modes whose entries have been seen on a unit
const PROGRAM_MODES = ['heat', 'cool', 'dry'];
const WITH_TARGET = ['heat', 'cool'];

function layout(detail) {
  const fields = [];
  let at = 0;
  for (const part of String(detail || '').split(';')) {
    const [name, width] = part.split('#');
    if (!name.startsWith('_') || !(parseInt(width, 10) > 0)) continue;   // "total#18" is the sum
    fields.push({ name: name.slice(1), at, width: parseInt(width, 10) });
    at += parseInt(width, 10);
  }
  return fields;
}

const two = (n) => String(n).padStart(2, '0');
function entry(text, fields) {
  const f = {};
  for (const { name, at, width } of fields) f[name] = String(text).slice(at, at + width);
  const minute = /^\d+$/.test(f.time || '') ? Number(f.time) : null;
  return {
    time: minute != null && minute < 1440 ? `${two(Math.floor(minute / 60))}:${two(minute % 60)}` : null,
    enabled: f.en === '1', on: f.pow === '1',
    mode: MODE[f.mode] || null, setpoint: num(f.temp), fan: FAN[f.vol] || null,
  };
}

/* An entry as the unit wants it. It starts from the entry it replaces when there is
 * one, so the fields nobody sets here (vane, humidity, special mode) keep their value. */
function encode(e, fields, base) {
  const f = {};
  for (const { name, at, width } of fields) f[name] = base ? base.slice(at, at + width) : '-'.repeat(width);
  const width = (name) => (fields.find((x) => x.name === name) || { width: 0 }).width;
  const [h, m] = e.time.split(':').map(Number);
  const target = e.on && WITH_TARGET.includes(e.mode);
  Object.assign(f, {
    en: e.enabled === false ? '0' : '1', pow: e.on ? '1' : '0',
    mode: e.on ? MODE_CODE[e.mode] : '-',
    temp: target ? Number(e.setpoint).toFixed(1).padStart(width('temp'), ' ') : '-'.repeat(width('temp')),
    time: String(h * 60 + m).padStart(width('time'), '0'),
    vol: target ? codeOf(FAN, e.fan || 'auto') : '-',
  });
  return fields.map(({ name }) => f[name]).join('');
}

function program(info, body) {
  const fields = layout(info.f_detail);
  const days = {};
  for (const day of DAYS) {
    const count = parseInt(body[DAY_KEY[day] + 'c'], 10) || 0;
    days[day] = Array.from({ length: count }, (_, i) => entry(body[DAY_KEY[day] + (i + 1)] || '', fields))
      .sort((a, b) => String(a.time).localeCompare(String(b.time)));
  }
  let name = '';
  try { name = decodeURIComponent(info[`scdl${info.active_no}_name`] || ''); } catch { /* a name the unit mangled: left empty */ }
  return { enabled: info.en_scdltimer === '1', program: parseInt(info.active_no, 10) || 1, name, perDay: parseInt(info.scdl_per_day, 10) || null, days };
}

/* Checks a program asked by a client and brings it to what the unit can hold. Anything
 * the unit could not run as asked is refused: nothing is guessed into a heating device.
 * An entry the unit already holds passes as it is, whatever its mode: it goes back
 * untouched. `held(day, entry)` says so. */
const SAME = ['time', 'enabled', 'on', 'mode', 'setpoint', 'fan'];
const sameEntry = (a, b) => SAME.every((k) => (a[k] ?? null) === (b[k] ?? null));
function checkProgram(days, { perDay, setpoint, fans, held = () => false }) {
  if (!days || typeof days !== 'object' || Array.isArray(days)) throw new RangeError('"schedule.days" must map mon…sun to lists of entries');
  const out = {};
  for (const day of DAYS) {
    const list = days[day] == null ? [] : days[day];
    if (!Array.isArray(list)) throw new RangeError(`"schedule.days.${day}" must be a list`);
    if (perDay && list.length > perDay) throw new RangeError(`${day}: the unit holds ${perDay} entries a day at most`);
    out[day] = list.map((e) => {
      if (e && held(day, e)) return Object.fromEntries(SAME.map((k) => [k, e[k] ?? null]));
      if (!e || !/^([01]\d|2[0-3]):[0-5]\d$/.test(e.time || '')) throw new RangeError(`${day}: "time" must be HH:MM`);
      if (typeof e.on !== 'boolean') throw new RangeError(`${day} ${e.time}: "on" must be true or false`);
      const clean = { time: e.time, enabled: e.enabled !== false, on: e.on, mode: null, setpoint: null, fan: null };
      if (!e.on) return clean;
      if (!PROGRAM_MODES.includes(e.mode)) throw new RangeError(`${day} ${e.time}: "mode" must be one of ${PROGRAM_MODES.join(', ')}`);
      clean.mode = e.mode;
      if (!WITH_TARGET.includes(e.mode)) return clean;
      if (!Number.isFinite(Number(e.setpoint))) throw new RangeError(`${day} ${e.time}: "setpoint" must be a number`);
      clean.setpoint = Math.round(clamp(Number(e.setpoint), setpoint.min, setpoint.max) * 2) / 2;
      clean.fan = e.fan == null ? 'auto' : String(e.fan);
      if (!fans.includes(clean.fan)) throw new RangeError(`${day} ${e.time}: "fan" must be one of ${fans.join(', ')}`);
      return clean;
    }).sort((a, b) => String(a.time).localeCompare(String(b.time)));
    for (let i = 1; i < out[day].length; i++) if (out[day][i].time === out[day][i - 1].time) throw new RangeError(`${day}: two entries at ${out[day][i].time}`);
  }
  return out;
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
    // the weekly program, when the unit has one and says how its entries are laid out
    const scdl = m.en_scdltmr === '1' ? await optional(device, '/aircon/get_scdltimer_info') : null;
    if (scdl && layout(scdl.f_detail).length) caps.schedule = { type: 'program', perDay: parseInt(scdl.scdl_per_day, 10) || 6, modes: PROGRAM_MODES };
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
    // the entries of the active program, when the unit says how they are laid out
    const body = schedule && schedule.f_detail ? await optional(device, `/aircon/get_scdltimer_body?target=${schedule.active_no || 1}`) : null;
    const info = {
      at: now(),
      energy: day && week && year ? energy(day, week, year, new Date(now()).getMonth()) : null,
      // Read only, as active or not: no timer could be set on a unit to see what one looks like.
      timer: timer ? { enabled: timer.enable === '1' } : null,
      schedule: !schedule ? null : body ? program(schedule, body) : { enabled: schedule.en_scdltimer === '1' },
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
    if ('schedule' in changes) await setProgram(device, changes.schedule);
  }

  /* Writes the weekly program into the unit: { days } replaces the entries of the active
   * program, { enabled } starts or stops it, both can come together. The unit is read
   * first and read again after: an entry that did not change goes back exactly as it
   * came, and a program the unit did not keep as sent is an error, never a silence. */
  async function setProgram(device, wanted) {
    if (!wanted || typeof wanted !== 'object') throw new RangeError('"schedule" must be { enabled, days }');
    if ('enabled' in wanted && typeof wanted.enabled !== 'boolean') throw new RangeError('"schedule.enabled" must be true or false');
    const caps = await capabilities(device);
    const info = await call(device, '/aircon/get_scdltimer_info');
    const fields = layout(info.f_detail), target = info.active_no || '1';
    slow.delete(device.ip);
    if (wanted.days) {
      const body = await call(device, `/aircon/get_scdltimer_body?target=${target}`);
      const keptOf = (day) => Array.from({ length: parseInt(body[DAY_KEY[day] + 'c'], 10) || 0 }, (_, i) => body[DAY_KEY[day] + (i + 1)] || '');
      const days = checkProgram(wanted.days, {
        perDay: caps.schedule.perDay, setpoint: caps.setpoint, fans: caps.fan ? caps.fan.options : ['auto'],
        held: (day, e) => keptOf(day).some((raw) => sameEntry(entry(raw, fields), e)),
      });
      const send = [['format', info.format || 'v1'], ['target', target]];
      for (const day of DAYS) {
        const key = DAY_KEY[day], kept = keptOf(day);
        send.push([key + 'c', String(days[day].length)]);
        days[day].forEach((e, i) => {
          // the entry it replaces: the same one if nothing changed, else the one at that time
          const same = kept.find((raw) => sameEntry(entry(raw, fields), e));
          send.push([key + (i + 1), same || encode(e, fields, kept.find((raw) => entry(raw, fields).time === e.time))]);
        });
      }
      // values go as the unit gives them: the commas and equals of its answers never appear in an entry
      await call(device, '/aircon/set_scdltimer_body?' + send.map(([k, v]) => `${k}=${v}`).join('&'));
      const after = await call(device, `/aircon/get_scdltimer_body?target=${target}`);
      for (const [k, v] of send) if (k !== 'format' && (after[k] ?? '') !== v) throw new DeviceError(`${device.name}: the unit did not keep the program as sent`);
    }
    if ('enabled' in wanted) {
      const send = [['format', info.format || 'v1'], ['en_scdltimer', wanted.enabled ? '1' : '0'], ['active_no', target]];
      for (const [k, v] of Object.entries(info)) if (/^scdl\d+_name$/.test(k)) send.push([k, v]);
      await call(device, '/aircon/set_scdltimer_info?' + send.map(([k, v]) => `${k}=${v}`).join('&'));
      const after = await call(device, '/aircon/get_scdltimer_info');
      if ((after.en_scdltimer === '1') !== wanted.enabled) throw new DeviceError(`${device.name}: the unit did not ${wanted.enabled ? 'start' : 'stop'} its program`);
    }
  }

  // Units are declared by IP: the adapter has no discovery worth relying on.
  const list = async () => [];

  return { capabilities, state, set, list };
}

module.exports = { create, parse, energy, program, encode, layout };
