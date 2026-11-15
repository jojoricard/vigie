/* Devices that only exist in memory, to try the House tab and its plan without any
 * hardware (house/demo/). A device starts from the `state` of its config entry and
 * keeps what it is set to until the service stops. */
// Made-up effects, as many as a real lamp lists: enough to fill several pages of a panel.
const SCENES = ['Sunrise', 'Sunset', 'Forest', 'Ocean', 'Candle', 'Fireplace', 'Aurora', 'Rainbow', 'Storm', 'Snow', 'Meadow', 'Desert', 'Lagoon', 'Dawn', 'Dusk', 'Moonlight',
  'Reading', 'Cinema', 'Dinner', 'Party', 'Sleep', 'Wake up', 'Focus', 'Relax', 'Spring', 'Summer', 'Autumn', 'Winter', 'Breeze', 'Ember', 'Glacier', 'Orchard', 'Harbor', 'Canyon', 'Twilight', 'Morning mist'];
const CAPS = {
  light: { on: { type: 'boolean' }, brightness: { min: 1, max: 100, step: 1 }, colorRgb: { type: 'color' }, colorTempK: { min: 2000, max: 9000, step: 100 },
    scene: { options: SCENES }, diy: { options: ['Evening one', 'Evening two'] }, music: { options: ['Energic', 'Rhythm', 'Spectrum', 'Rolling'] } },
  climate: { on: { type: 'boolean' }, mode: { options: ['auto', 'heat', 'cool', 'dry', 'fan'] }, setpoint: { min: 10, max: 32, step: 0.5 }, fan: { options: ['auto', 'quiet', '1', '2', '3'] }, demand: { options: ['off', 'auto', 'manual'] }, demandMax: { min: 40, max: 100, step: 5 }, schedule: { type: 'program', perDay: 6, modes: ['heat', 'cool', 'dry'] } },
  heater: { on: { type: 'boolean' }, mode: { options: ['off', 'manual', 'schedule'] }, setpoint: { min: 7, max: 28, step: 0.5 } },
  cover: { position: { min: 0, max: 100, step: 5 } },
  sensor: {},
  water: { mode: { options: ['manual', 'eco'] }, showers: { min: 1, max: 6, step: 1 }, boost: { type: 'boolean' }, away: { type: 'period' } },
  tv: { on: { type: 'boolean' }, volume: { min: 0, max: 100, step: 1 }, muted: { type: 'boolean' }, source: { options: ['antenna', 'hdmi1', 'hdmi2'], labels: { antenna: 'Antenna', hdmi1: 'Console', hdmi2: 'Player' } } },
  washer: {},
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
      // an effect replaces the others, and a plain color ends it
      const effect = ['scene', 'diy', 'music'].find((k) => changes[k] != null);
      if (effect || changes.colorRgb != null || changes.colorTempK != null) for (const k of ['scene', 'diy', 'music']) if (k !== effect) delete s[k];
    },
    list: async () => [],
  };
}

module.exports = { create, CAPS };
