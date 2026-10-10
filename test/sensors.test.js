const test = require('node:test');
const assert = require('node:assert/strict');
const { parseLhm, toSample } = require('../lib/sensors');

// A trimmed LibreHardwareMonitor tree, with the traps the parser must avoid.
const node = (Text, children = []) => ({ Text, Children: children });
const sensor = (Text, Type, SensorId, Value) => ({ Text, Type, SensorId, Value, Children: [] });
const tree = node('Sensor', [
  node('PC', [
    node('CPU', [
      sensor('Core Max', 'Temperature', '/intelcpu/0/temperature/10', '61,5 °C'),
      sensor('CPU Total', 'Load', '/intelcpu/0/load/0', '12,0 %'),
      sensor('CPU Package', 'Power', '/intelcpu/0/power/0', '40,2 W'),
    ]),
    node('Memory', [
      node('Virtual Memory', [sensor('Memory', 'Load', '/vram/load/0', '80,0 %')]),
      node('Total Memory', [sensor('Memory', 'Load', '/ram/load/0', '55,0 %')]),
    ]),
    node('GPU', [
      sensor('GPU Hot Spot', 'Temperature', '/gpu-amd/0/temperature/2', '70,0 °C'),
      sensor('GPU Core', 'Temperature', '/gpu-amd/0/temperature/0', '58,0 °C'),
      sensor('GPU Fan', 'Fan', '/gpu-amd/0/fan/0', '900 RPM'),
    ]),
    node('NVMe', [
      sensor('Temperature 1', 'Temperature', '/nvme/0/temperature/1', '70,0 °C'),
      sensor('Temperature', 'Temperature', '/nvme/0/temperature/0', '45,0 °C'),
    ]),
    node('Motherboard', [sensor('Fan #3', 'Fan', '/lpc/nct6796dr/0/fan/2', '1200 RPM')]),
  ]),
]);

test('values in the French locale are parsed', () => {
  const p = parseLhm(tree);
  assert.equal(p.cpuTemp, 61.5);
  assert.equal(p.cpuLoad, 12);
});

test('physical RAM is picked, not the virtual memory listed first', () => {
  assert.equal(parseLhm(tree).ramLoad, 55);
});

test('the GPU core temperature is picked, not the hotspot listed first', () => {
  const p = parseLhm(tree);
  assert.equal(p.gpuTemp, 58);
  assert.equal(p.gpuHot, 70);
});

test('an NVMe keeps its composite temperature, not the controller one', () => {
  assert.deepEqual(parseLhm(tree).diskTemps, [45]);
});

test('fans keep their source, and the sample splits GPU from system fans', () => {
  const p = parseLhm(tree);
  assert.deepEqual(p.fans.map((f) => f.source), ['gpu', 'motherboard']);
  const s = toSample(p);
  assert.equal(s.fg, 900);
  assert.equal(s.fs, 1200);
  assert.equal(s.c, 61.5);
  assert.equal(s.pc, 40);
});
