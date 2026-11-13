/* Devices that only exist in memory, to try the House tab and its plan without any
 * hardware (house/demo/). A device starts from the `state` of its config entry and
 * keeps what it is set to until the service stops. */
const CAPS = {
  light: { on: { type: 'boolean' }, brightness: { min: 1, max: 100, step: 1 }, colorRgb: { type: 'color' }, colorTempK: { min: 2000, max: 9000, step: 100 } },
  climate: { on: { type: 'boolean' }, mode: { options: ['auto', 'heat', 'cool', 'dry', 'fan'] }, setpoint: { min: 10, max: 32, step: 0.5 }, fan: { options: ['auto', 'quiet', '1', '2', '3'] }, schedule: { type: 'program', perDay: 6, modes: ['heat', 'cool', 'dry'] } },
  heater: { on: { type: 'boolean' }, mode: { options: ['off', 'manual', 'schedule'] }, setpoint: { min: 7, max: 28, step: 0.5 } },
  cover: { position: { min: 0, max: 100, step: 5 } },
  sensor: {},
};

function create() {
  const states = new Map();
  const stateOf = (device) => {
    if (!states.has(device.id)) states.set(device.id, { reachable: true, ...device.state });
    return states.get(device.id);
  };
  return {
    capabilities: async (device) => CAPS[device.type] || {},
    state: async (device) => ({ ...stateOf(device) }),
    set: async (device, changes) => {
      const s = stateOf(device);
      // a program change carries the entries, the active flag, or both
      const schedule = changes.schedule ? { ...s.schedule, ...changes.schedule } : s.schedule;
      Object.assign(s, changes, schedule ? { schedule } : {});
      // a color and a color temperature exclude each other, as on a real lamp
      if (changes.colorRgb != null) s.colorTempK = null;
      else if (changes.colorTempK != null) s.colorRgb = null;
    },
    list: async () => [],
  };
}

module.exports = { create, CAPS };
