/* LibreHardwareMonitor sensors, parsed once here for both the page and the samples.
 * Sensors are picked by Type + SensorId (e.g. "/intelcpu/0/temperature/10"), more
 * reliable than group names. */
const ctx = require('./context');
const { fetchJson } = require('./errors');

// LHM values follow the system locale: "45,5 °C" as well as "45.5 °C".
const parseNum = (s) => { const m = String(s ?? '').match(/-?\d+(?:[.,]\d+)?/); return m ? parseFloat(m[0].replace(',', '.')) : null; };
const GIB = 1073741824, MIB = 1048576;

function parseLhm(json) {
  const sensors = [];
  // The parent path is kept: LHM exposes two "Memory" sensors (under "Total Memory"
  // = physical and "Virtual Memory" = commit) that only their group tells apart.
  (function walk(node, parents) {
    if (!node || typeof node !== 'object') return;
    const kids = node.Children || [];
    if (node.SensorId || (kids.length === 0 && node.Type)) {
      sensors.push({ id: node.SensorId || '', type: node.Type || '', name: node.Text || '', raw: node.Value, val: parseNum(node.Value), path: parents.join(' / ') });
      return;
    }
    const p = node.Text ? [...parents, node.Text] : parents;
    for (const k of kids) walk(k, p);
  })(json, []);

  const first = (f) => sensors.find(f) || null;
  const by = (f) => sensors.filter(f);
  const val = (s) => (s ? s.val : null);
  const isCpu = (s) => /cpu\//i.test(s.id);
  const isGpu = (s) => /gpu/i.test(s.id);
  const isStorage = (s) => /nvme|hdd|ssd|storage/i.test(s.id);

  const cpuTemp = first((s) => s.type === 'Temperature' && isCpu(s) && /Package|Average|Tctl|Core Max/i.test(s.name))
    || first((s) => s.type === 'Temperature' && isCpu(s));
  const liquid = first((s) => s.type === 'Temperature' && /liquid|liquide/i.test(s.name))
    || first((s) => s.type === 'Temperature' && /kraken|aio/i.test(s.id));
  const gpuTemp = first((s) => s.type === 'Temperature' && isGpu(s) && /GPU Core/i.test(s.name))
    || first((s) => s.type === 'Temperature' && isGpu(s));
  // On RDNA3, hotspot and VRAM run hotter than the core: they are the limit
  const gpuHot = first((s) => s.type === 'Temperature' && isGpu(s) && /hot ?spot/i.test(s.name));
  const gpuVram = first((s) => s.type === 'Temperature' && isGpu(s) && /memory/i.test(s.name));
  const ramTemps = by((s) => s.type === 'Temperature' && /dimm/i.test(s.name)).map(val).filter((v) => v != null);
  const powCpu = first((s) => s.type === 'Power' && isCpu(s) && /package/i.test(s.name)) || first((s) => s.type === 'Power' && isCpu(s));
  const powGpu = first((s) => s.type === 'Power' && isGpu(s) && /package|total|ppt|board/i.test(s.name)) || first((s) => s.type === 'Power' && isGpu(s));
  const ssdLife = first((s) => isStorage(s) && /^life$/i.test(s.name));
  const ssdHours = first((s) => isStorage(s) && /power on hours/i.test(s.name));
  const ssdWritten = first((s) => isStorage(s) && /data written/i.test(s.name));

  // An NVMe exposes several sensors (composite + controller/NAND): keep only the
  // composite "Temperature" per disk, else its first one.
  const diskGroups = {};
  for (const s of by((s) => s.type === 'Temperature' && isStorage(s))) {
    const k = s.id.replace(/\/temperature\/\d+$/i, '');
    (diskGroups[k] = diskGroups[k] || []).push(s);
  }
  const diskTemps = Object.values(diskGroups).map((g) => val(g.find((s) => /^Temperature$/i.test(s.name)) || g[0])).filter((v) => v != null);

  // Network throughput (bytes/s): the interface with the most download
  const toBps = (s) => { const v = parseNum(s.raw) || 0; return /GB\/s/i.test(s.raw) ? v * GIB : /MB\/s/i.test(s.raw) ? v * MIB : v * 1024; };
  const downs = by((s) => s.type === 'Throughput' && /download/i.test(s.name));
  let net = null;
  if (downs.length) {
    const best = downs.reduce((a, b) => (toBps(b) > toBps(a) ? b : a));
    const hw = best.id.replace(/\/[^/]+\/\d+$/, '');
    const up = first((s) => s.type === 'Throughput' && /upload/i.test(s.name) && s.id.startsWith(hw));
    net = { down: Math.round(toBps(best)), up: up ? Math.round(toBps(up)) : 0 };
  }

  const fanSource = (id) => /kraken/i.test(id) ? 'kraken' : /nzxt/i.test(id) ? 'nzxt' : /gpu/i.test(id) ? 'gpu' : 'motherboard';
  const seenFan = new Set();
  const fans = by((s) => s.type === 'Fan' && s.val != null && s.val > 0 && !seenFan.has(s.id) && seenFan.add(s.id))
    .map((s) => ({ name: s.name, source: fanSource(s.id), rpm: Math.round(s.val) }));

  const cpuLoad = first((s) => s.type === 'Load' && isCpu(s) && /CPU Total/i.test(s.name)) || first((s) => s.type === 'Load' && isCpu(s) && /Total/i.test(s.name));
  const gpuLoad = first((s) => s.type === 'Load' && isGpu(s) && /GPU Core/i.test(s.name)) || first((s) => s.type === 'Load' && isGpu(s));
  // physical RAM: virtual memory (commit = RAM + page file) is left out
  const ramLoad = first((s) => s.type === 'Load' && /ram/i.test(s.id) && /^Memory$/i.test(s.name) && !/virtual/i.test(s.path))
    || first((s) => s.type === 'Load' && /ram/i.test(s.id) && /^Memory$/i.test(s.name))
    || first((s) => s.type === 'Load' && /ram/i.test(s.id));
  const ramUsed = first((s) => /ram/i.test(s.id) && /used/i.test(s.name) && !/virtual/i.test(s.name) && !/virtual/i.test(s.path));

  return {
    count: sensors.length,
    cpuLoad: val(cpuLoad), cpuTemp: val(cpuTemp), cpuPower: val(powCpu),
    gpuLoad: val(gpuLoad), gpuTemp: val(gpuTemp), gpuPower: val(powGpu), gpuHot: val(gpuHot), gpuVram: val(gpuVram),
    ramLoad: val(ramLoad), ramUsed: val(ramUsed), ramTemp: ramTemps.length ? Math.max(...ramTemps) : null,
    liquidTemp: val(liquid),
    diskTemps, net, fans,
    ssd: (ssdLife || ssdHours || ssdWritten) ? {
      life: val(ssdLife),
      hours: val(ssdHours),
      writtenTB: ssdWritten ? parseNum(ssdWritten.raw) / 1024 : null, // LHM gives GB
    } : null,
  };
}

// Columns stored every 30 s (see storage.js), from the parsed sensors.
function toSample(p) {
  const r = {};
  const set = (k, v) => { if (v != null) r[k] = v; };
  set('c', p.cpuTemp); set('g', p.gpuTemp); set('l', p.liquidTemp); set('r', p.ramLoad);
  set('cl', p.cpuLoad); set('gl', p.gpuLoad);
  if (p.diskTemps.length) r.d = Math.max(...p.diskTemps);
  if (p.net) { r.nd = p.net.down; r.nu = p.net.up; }
  const gpuFan = p.fans.find((f) => f.source === 'gpu');
  const sysFans = p.fans.filter((f) => f.source !== 'gpu');
  if (gpuFan) r.fg = gpuFan.rpm;
  if (sysFans.length) r.fs = Math.max(...sysFans.map((f) => f.rpm));
  if (p.cpuPower != null) r.pc = Math.round(p.cpuPower);
  if (p.gpuPower != null) r.pg = Math.round(p.gpuPower);
  return r;
}

const readSensors = async () => parseLhm(await fetchJson(ctx.cfg.lhmUrl, { timeout: 5000 }));

module.exports = { parseLhm, toSample, readSensors };
