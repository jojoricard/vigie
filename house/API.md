# House API

The house service drives the lights, air conditioners and heaters of a home behind one JSON API. Vigie's House tab is a client of it, and so will be the phone apps. It has no npm dependency and does not need Vigie.

- Base path: `/api/v1`
- Inside Vigie's agent (the default): `http://localhost:5252/api/v1`
- Alone: `node house/server.js`, on `house.port` (5253 by default)

All addresses, ids and names below are examples.

## Rules of the service

**Schedules live in the devices, not in the service.** The machine running the service may be off: it never runs a "turn on at 6:30" by itself. It reads and writes the weekly program stored in a heater, and reports the timers of an air conditioner. What it runs itself are scenes, on demand.

**A device only shows what it can do.** Capabilities are detected from the device (the model of an air conditioner, the commands a heater declares), never assumed from its brand.

**The temperature of a room comes from a sensor of its own.** The probe of an air conditioner sits in the unit and reads several degrees above the room: it is reported as `probeTemp`, never as the room's temperature. A room without a sensor has `temperature: null`.

**A device that fails does not fail the answer.** It comes back with `state.reachable: false` and an `error`. A command to it answers 502.

## Access

| The service listens on | Token |
|---|---|
| `127.0.0.1` (inside Vigie's agent, or alone with the default `host`) | not needed from the machine itself |
| anything else (`0.0.0.0`, a LAN address) | required on every request: `Authorization: Bearer <house.token>` |

- The service refuses to start on a network address without a token.
- A request carrying an `Origin` header from another site is refused (403) unless it holds the token: a web page cannot switch your heating.
- The token is `house.token` in `config.json`, or the `HOUSE_TOKEN` environment variable.

```bash
curl -H "Authorization: Bearer $HOUSE_TOKEN" http://192.0.2.5:5253/api/v1/rooms
```

## Model

```
room ─┬─ device (light)    driver govee-lan
      ├─ device (climate)  driver daikin
      ├─ device (heater)   driver cozytouch
      └─ device (sensor)
```

A device:

```json
{
  "id": "living-ac",
  "name": "Air conditioner",
  "type": "climate",
  "driver": "daikin",
  "room": "living",
  "capabilities": {
    "on": { "type": "boolean" },
    "mode": { "options": ["auto", "heat", "cool", "dry", "fan"] },
    "setpoint": { "min": 10, "max": 32, "step": 0.5 },
    "fan": { "options": ["auto", "quiet", "1", "2", "3", "4", "5"] },
    "swing": { "options": ["off", "vertical", "horizontal", "both"] },
    "powerful": { "type": "boolean" },
    "econo": { "type": "boolean" }
  },
  "state": {
    "reachable": true, "on": true, "mode": "heat", "setpoint": 20, "fan": "auto", "swing": "off",
    "powerful": false, "econo": false,
    "probeTemp": 23, "outdoorTemp": 8,
    "energy": { "today": 0.4, "yesterday": 0.6, "week": 20.4, "month": 56, "year": 224.1 },
    "timer": { "enabled": false }, "schedule": { "enabled": false }
  }
}
```

`capabilities` lists what can be **set**, with what a client needs to draw the control: `type: "boolean"` is a switch, `options` a choice, `min`/`max`/`step` a slider or a stepper, `type: "color"` an RGB integer (`0xRRGGBB`). `state` holds the current value of each capability, plus what the device only reports.

### Capabilities

| Capability | Types | Value |
|---|---|---|
| `on` | all | boolean |
| `brightness` | light | 1 to 100 |
| `colorRgb` | light | integer `0xRRGGBB`. `null` in the state while the light shows a color temperature |
| `colorTempK` | light | kelvin, 2000 to 9000. `null` in the state while the light shows a color |
| `mode` | climate | `auto`, `heat`, `cool`, `dry`, `fan` |
| `mode` | heater | `off`, `manual`, `schedule` (the weekly program of the heater), `auto` (the program with presence detection) |
| `setpoint` | climate, heater | °C. `null` in the state when the mode has none (dry, fan) |
| `fan` | climate | `auto`, `quiet`, `1` to `5` |
| `swing` | climate | `off`, `vertical`, `horizontal`, `both` |
| `powerful`, `econo`, `streamer` | climate | boolean, each only if the unit has it |
| `boost`, `drying` | heater | boolean. One excludes the other |
| `windowDetection` | heater | boolean |
| `schedule` | heater | the weekly program, in the heater's own format (see below) |

### Reported only

| Field | Types | Meaning |
|---|---|---|
| `reachable`, `error` | all | `error` is `"lanSilent"` for a Govee lamp that does not answer on the LAN: switched off at the wall, or "LAN Control" off in Govee Home |
| `via` | light | `"cloud"` when the lamp was reached through the Govee cloud fallback |
| `probeTemp` | climate | temperature read inside the indoor unit, °C. Not the room's |
| `outdoorTemp` | climate | temperature at the outdoor unit, °C |
| `energy` | climate | kWh of this indoor unit, heating and cooling together: `today`, `yesterday`, `week` (last 7 days), `month`, `year` |
| `timer`, `schedule` | climate | `{ "enabled": true }` when the on/off timer or the weekly program of the unit is active. Read only for now |
| `temperature` | heater, sensor | °C |

## Routes

### `GET /api/v1`

```json
{ "name": "house", "version": 1 }
```

### `GET /api/v1/rooms`

Every room with its devices and their state. This is the one call a client needs to draw everything. States are cached 15 seconds.

```json
[
  { "id": "living", "name": "Living room", "temperature": null, "devices": [ { "id": "living-lamp", "…": "…" } ] }
]
```

### `GET /api/v1/devices/:id`

One device, as above.

### `POST /api/v1/devices/:id`

Body: the capabilities to change. Answers with the device in its new state.

```bash
curl -X POST http://localhost:5252/api/v1/devices/living-lamp \
  -H "content-type: application/json" -d '{"on": true, "brightness": 40, "colorTempK": 2700}'
```

- Numbers out of range are brought back into it.
- `{"ambiance": "warm"}` applies an ambiance (below). Other keys in the same body win over it.
- 400: a capability the device does not have, or a value of the wrong kind. Nothing is sent.
- 404: unknown device. 502: the device refused or did not answer, with its reason in `error`.

### `GET /api/v1/ambiances`

Ambiances replace the scenes of the Govee app, which only exist in Govee's cloud. An ambiance is a light preset from the config: a brightness with a color or a color temperature. Applying one turns the light on.

```json
[ { "id": "warm", "name": "Warm", "brightness": 45, "colorTempK": 2700 } ]
```

### `GET /api/v1/scenes`, `POST /api/v1/scenes/:id`

A scene is a list of actions from the config, each on one device or on every device of a type. One device failing does not stop the others.

```bash
curl -X POST http://localhost:5252/api/v1/scenes/leave
```

```json
{ "id": "leave", "ok": false, "results": [
  { "device": "living-lamp", "ok": true },
  { "device": "living-ac", "ok": false, "error": "Air conditioner: timeout" }
] }
```

### `GET /api/v1/scenes/:id/run?token=…`

The same, as a plain URL for a button that can only open an address (a Stream Deck "Website" action, a shortcut). Because it acts on a GET, it always asks for the token, even from the machine itself, where any web page could otherwise load it.

```
http://localhost:5252/api/v1/scenes/leave/run?token=<house.token>
```

### `GET /api/v1/discovery`

What each driver sees, to fill the config: the Govee lamps answering on the LAN with their `device` id, the devices of the Cozytouch account with their `deviceURL`.

```json
{ "govee-lan": [ { "driver": "govee-lan", "device": "00:00:5E:00:53:01:00:01", "ip": "192.0.2.10", "sku": "H0000" } ] }
```

## Configuration

Under `house` in `config.json`:

```json
{
  "house": {
    "host": "127.0.0.1",
    "port": 5253,
    "token": "a-long-random-string",
    "rooms": [
      { "id": "living", "name": "Living room", "devices": [
        { "id": "living-lamp", "name": "Lamp", "type": "light", "driver": "govee-lan", "device": "00:00:5E:00:53:01:00:01" },
        { "id": "living-ac", "name": "Air conditioner", "type": "climate", "driver": "daikin", "ip": "192.0.2.20" }
      ] },
      { "id": "bathroom", "name": "Bathroom", "devices": [
        { "id": "towel-rail", "name": "Towel rail", "type": "heater", "driver": "cozytouch", "label": "Towel rail" }
      ] }
    ],
    "ambiances": [
      { "id": "warm", "name": "Warm", "brightness": 45, "colorTempK": 2700 },
      { "id": "cinema", "name": "Cinema", "brightness": 20, "colorRgb": 4861439 }
    ],
    "scenes": [
      { "id": "leave", "name": "Leaving", "actions": [
        { "type": "light", "set": { "on": false } },
        { "type": "climate", "set": { "on": false } }
      ] },
      { "id": "evening", "name": "Evening", "actions": [
        { "device": "living-lamp", "set": { "ambiance": "warm" } }
      ] }
    ],
    "govee": { "cloudFallback": false, "apiKey": "" },
    "cozytouch": { "username": "", "password": "" }
  }
}
```

`host`, `port` and `token` only matter when the service runs alone. Secrets can come from the environment instead of the file: `HOUSE_TOKEN`, `GOVEE_API_KEY`, `COZYTOUCH_USERNAME`, `COZYTOUCH_PASSWORD`. `HOUSE_CONFIG` names another config file.

## Drivers

| Driver | Devices | Network | Settings of a device |
|---|---|---|---|
| `govee-lan` | Govee lights | local, UDP | `device` (the id given by `/discovery`) or `ip` |
| `daikin` | Daikin air conditioners with a Wi-Fi adapter | local, HTTP | `ip` |
| `cozytouch` | Atlantic, Thermor, Sauter heaters | Cozytouch cloud | `deviceURL` or `label` |

**govee-lan.** Each lamp needs "LAN Control" switched on once in the Govee Home app (the lamp, then its settings). A scan goes to `239.255.255.250:4001` on every network card, lamps answer on port 4002, commands go to port 4003. Only one program can listen on 4002: the driver reports an error if Home Assistant or another instance already does. With `house.govee.cloudFallback` and an API key, a lamp that stays silent on the LAN and has a `sku` in its settings is reached through Govee's cloud instead, for a model without LAN support.

**daikin.** Reserve the IP of each unit on the router. The driver reads what the unit supports from `get_model_info`. Energy comes from the per-unit counters (`get_day_power_ex`, `get_week_power_ex`, `get_year_power_ex`): on a multi-split, `get_week_power` gives the total of the outdoor unit, the same on every indoor unit. Timers are only reported as active or not: the format of their entries is not documented.

**cozytouch.** Off until `house.cozytouch` holds the email and password of the Cozytouch (or Sauter, Thermor) account. Written after the open-source pyoverkiz library for an electric towel dryer, and tested on simulated answers only. The weekly program is read and written in the heater's own format, as the `schedule` capability: send back what `state.schedule` gave you, modified.

### Adding a driver

A driver is one file in `house/drivers/` exporting `create(options)`, which returns:

```js
{
  capabilities: async (device) => ({ on: { type: 'boolean' }, /* … */ }),
  state: async (device) => ({ reachable: true, on: true, /* … */ }),
  set: async (device, changes) => { /* changes are already validated against capabilities */ },
  list: async () => [ /* devices seen, for /discovery */ ],
}
```

`device` is the entry of the config. Everything is in the vocabulary above. A failure is thrown as a `DeviceError` (`house/util.js`). The driver is then registered in `buildDrivers()` of `house/server.js`.
