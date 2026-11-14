# House API

The house service drives the lights, air conditioners, heaters and shutters of a home behind one JSON API, and knows where they stand on its floor plan. Vigie's House tab is a client of it, and so will be the phone apps. It has no npm dependency and does not need Vigie.

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
      ├─ device (cover)    a shutter or a blind
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
| `schedule` | climate | the weekly program stored in the unit: `{ "type": "program", "perDay": 6, "modes": ["heat", "cool", "dry"] }`. See [Weekly program of an air conditioner](#weekly-program-of-an-air-conditioner) |
| `position` | cover | 0 (closed) to 100 (open) |
| `mode` | water | `manual`, `eco` (the heater adapts to the habits of the home), `schedule` when the heater is found on a program |
| `showers` | water | the hot water asked for, in showers |
| `boost` | water | boolean: heat now, whatever the mode |
| `away` | water | `{ "type": "period" }`. Set with `{ "from": "…", "to": "…" }` (two dates, ISO 8601), ended with `null`. The state holds the same, with `"pending": true` while the departure is still to come |
| `volume`, `muted` | tv | 0 to 100, boolean |
| `source`, `app` | tv | one of `options`, the inputs and the applications of the set. `labels` gives the name of each, as the set shows it |
| `start` | washer | `{ "type": "action" }`: set to `true` to start the cycle. Only offered while the machine waits for a remote start |

### Reported only

| Field | Types | Meaning |
|---|---|---|
| `reachable`, `error` | all | `error` is `"lanSilent"` for a Govee lamp that does not answer on the LAN: switched off at the wall, or "LAN Control" off in Govee Home |
| `via` | light | `"cloud"` when the lamp was reached through the Govee cloud fallback |
| `probeTemp` | climate | temperature read inside the indoor unit, °C. Not the room's |
| `outdoorTemp` | climate | temperature at the outdoor unit, °C |
| `energy` | climate | kWh of this indoor unit, heating and cooling together: `today`, `yesterday`, `week` (last 7 days), `month`, `year` |
| `timer` | climate | `{ "enabled": true }` when the on/off timer of the unit is active. Read only |
| `schedule` | climate | the weekly program stored in the unit (below). A unit that does not describe its entries only gives `{ "enabled": true }` |
| `temperature` | heater, sensor | °C |
| `showersLeft`, `hotWater`, `temperature`, `setpoint`, `energyKwh` | water | hot water left in showers and in percent, water at mid-height and its target in °C, energy used since the heater was installed. Each only when the heater reports it |
| `appName` | tv | what is on screen: the name of the input or of the application |
| `run` | washer | `off`, `idle`, `running`, `paused`, `scheduled`, `done`, `error` |
| `phase` | washer | while running, the step in the machine's own word: `detecting`, `running`, `rinsing`, `spinning`, `drying`… |
| `remainingMin`, `totalMin`, `endsAt` | washer | minutes left and in all, and the time the cycle ends |
| `remoteStart` | washer | whether the machine was left waiting for a remote start |

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

### Weekly program of an air conditioner

The program lives in the unit and runs with the service off. The state gives the active one of the unit's programs:

```json
"schedule": {
  "enabled": true, "program": 1, "name": "Winter", "perDay": 6,
  "days": {
    "mon": [
      { "time": "06:30", "enabled": true, "on": true, "mode": "heat", "setpoint": 20.5, "fan": "quiet" },
      { "time": "08:00", "enabled": true, "on": false, "mode": null, "setpoint": null, "fan": null }
    ],
    "tue": [], "wed": [], "thu": [], "fri": [], "sat": [], "sun": []
  }
}
```

An entry turns the unit on in a mode, or off, at a time of that day. `enabled: false` is an entry kept but skipped. Entries come sorted by time.

To change it, post what changes:

```bash
curl -X POST http://localhost:5252/api/v1/devices/living-ac \
  -H "content-type: application/json" -d '{"schedule": {"enabled": false}}'
```

- `{"schedule": {"days": {…}}}` replaces every entry of the active program: a day left out is emptied. Send back the `days` you read, modified.
- `{"schedule": {"enabled": true}}` starts or stops the program without touching its entries. Both keys can come together.
- A new entry that turns the unit on takes a `mode` among the capability's `modes`, and for heat and cool a `setpoint` (rounded to the half degree, brought into range) and a `fan` (auto by default). Dry carries neither.
- An entry the unit already holds goes back exactly as it is, whatever its mode: one set to auto in the manufacturer's app is kept, it just cannot be created from here.
- 400, and nothing sent: more entries in a day than `perDay`, two entries of a day at the same time, a time that is not `HH:MM`, a mode or a fan speed the unit does not have.
- 502: the unit refused, or answered but did not keep the program as sent. The driver reads it back after every write.

The on/off timer of a unit is only reported, as active or not.

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

### `GET /api/v1/plan`

The floor plan (see [Plan](#plan)), with the anchors that were left out in `warnings`.

```json
{ "version": 1, "units": "m", "rooms": [], "walls": [], "openings": [], "furniture": [], "anchors": [], "warnings": [] }
```

- 404: `house.planPath` is not set. A client then draws no plan.
- 500: the file cannot be read or breaks the schema, with the faults in `details`. The path of the file is never in the answer.
- Sent with `Cache-Control: no-store`, like every answer of the service.

### `GET /api/v1/discovery`

What each driver sees, to fill the config: the Govee lamps answering on the LAN with their `device` id, the devices of the Cozytouch account with their `deviceURL`.

```json
{ "govee-lan": [ { "driver": "govee-lan", "device": "00:00:5E:00:53:01:00:01", "ip": "192.0.2.10", "sku": "H0000" } ] }
```

## Plan

The floor plan of the home, for a client that draws the devices where they stand. Vigie's House tab shows it as a model above its tiles.

**The plan is private.** It is the layout of somebody's home: it lives in a file outside the repository, named by `house.planPath`, and only leaves through `GET /api/v1/plan`, under the access rules above. It is never served as a static file. The repository holds a made-up flat, `house/demo/plan.json`, for the tests and the screenshots.

Lengths are in meters. `x` and `y` are on the floor (`y` goes down on a view from above), `z` goes up.

```json
{
  "version": 1,
  "units": "m",
  "north": [0, -1],
  "rooms": [
    { "id": "living", "name": "Living room", "polygon": [[0, 0], [5.2, 0], [5.2, 3.8], [0, 3.8]], "height": 2.5, "floor": "wood" }
  ],
  "walls": [
    { "id": "w-south", "a": [0, 3.9], "b": [5.2, 3.9], "thickness": 0.25, "exterior": true }
  ],
  "openings": [
    { "id": "o-living-window", "type": "french-window", "wall": "w-south", "offset": 1.4, "width": 2.4, "height": 2.15, "sill": 0 }
  ],
  "furniture": [
    { "id": "sofa", "room": "living", "position": [1.1, 2.9], "size": [2.1, 0.9, 0.8] }
  ],
  "anchors": [
    { "deviceId": "living-lamp", "position": [2.6, 1.9, 2.3] },
    { "deviceId": "living-shutter", "openingId": "o-living-window" }
  ]
}
```

| Key | Fields |
|---|---|
| `rooms` (required) | `id`, the same as the room of the config, so the room's devices and temperature find their floor. `name`, `polygon` (at least 3 `[x, y]` points, the inner faces of the walls), `height`, `floor` (`wood`, `tile`, `concrete`, `carpet`, `none`), which gives its pattern, and optionally `floorColor` (`"#rrggbb"`), its real color. A polygon without a room in the config is fine: a hall, a balcony. Optional `kind`: `outdoor` for a balcony or a loggia (a floor of its own, a rail where no wall closes it), `shaft` for a duct, drawn but not named, `storage` for a closet, named but without a shortcut. Any other value is a room |
| `walls` | `id`, `a` and `b` (the two ends of its axis), `thickness`. Optional `exterior`: such a wall runs half a thickness past its ends so the corners close |
| `openings` | `id`, `type` (`door`, `window`, `french-window`, `passage`, `closet`), `wall`, `offset` (meters from the wall's `a` to the near edge of the opening), `width`, `height`, `sill` (height of its bottom edge, 0 for a door). Optional `hinge` (`start` or `end`) and `opensInto` (a room id) draw the leaf of a door, open. `closed: true` draws it shut: a front door |
| `furniture` | `id`, `position` (`[x, y]` of its middle), `size` (`[width, depth, height]`, in its own frame). Optional `type` and `params` (see [Furniture](#furniture)), `rotation` (degrees, clockwise on the plan: at 0 its front faces down the plan), `room`, `elevation` (height of its underside: something standing on a cabinet, hung on a wall), `planned` (drawn see-through: not there yet). Without a type it is a plain volume |
| `anchors` | `deviceId`, and either `position` (`[x, y, z]`) or `openingId` |
| `wallColor` | optional, the real color of the walls as `"#rrggbb"` |
| `north` | optional, the direction of north on the plan as `[x, y]`: `[0, -1]` when north is at the top of a view from above, `[1, 0]` when it is on the right. With it, the daylight of the model comes from where the sun is |
| `meta` | free, not read by the service: where the measures come from, what is still a guess |

A plan that breaks the schema is refused whole, with the list of what is wrong. An anchor in fault is only left out, and named in `warnings`: a device removed from the config does not take the plan away.

### Furniture

A piece of furniture is an instance of a type, with its parameters. The types are a small library in `public/js/furniture.js`: simple volumes, detailed enough to tell a sideboard from a bookcase. A plan describes a home by what stands in it ("a white cabinet with an oak top and a niche in the middle"), never by a product.

```json
{ "id": "sideboard", "type": "cabinet", "position": [3.4, 6.1], "size": [1.6, 0.42, 0.85],
  "params": { "body": "white", "top": "oak", "legs": 0.1, "niches": [[0.36, 0.64]], "baskets": 2 } }
```

| Type | Parameters |
|---|---|
| `box` | `color`. What an item without a type is |
| `cabinet` | sideboard, TV stand, chest of drawers, kitchen units: `body`, `top` (a material, or none), `front`, `legs` (their height), `doors` or `columns`, `drawers` (rows), `niches` (open parts, each `[from, to]` as fractions of the width), `nicheHeight` (a fraction of the height when a niche only takes the top, with doors under it), `baskets` and `shelf` in the niches, `handles` (`false` for none) |
| `shelving` | open shelves: `columns`, `rows`, `body`, `shelf` (when the shelves are of another material), `staggered` (every other column shifted by half a cell), `back`, `fill` (0 to 1: books and boxes), `bins` (a color: boxes closing some cells) |
| `wallShelves` | shelves hung on a wall: `count`, `spacing`, `color` |
| `table` | `top`, `legs`, `legSize`, `inset`, `apron`, `shelf`, or `pedestal: true` for one central foot |
| `desk` | `top`, `legs` (a color, or `"panel"` for full sides), `round` legs. `shape: "L"` adds a return: `returnSide` (`left` or `right`), `returnLength`, `returnDepth` |
| `chair` | `style`: `dining`, `office`, `stool`, `bar`. `color`, `legs`, `accent` |
| `sofa` | `color`, `cushion`, `seats`, `arm` (width), `chaise` (`left` or `right`) and `chaiseLength` |
| `bed` | `frame`, `linen`, `pillow`, `headboard` |
| `screen` | a television or a monitor: `stand` (`false` to hang it), `upright` (the size is still the one of the screen lying down), `lit` (a color: the screen is on) |
| `pc` | a computer case with a glass side: `body`, `glow` (the light inside) |
| `lamp` | decor, not connected: `style` (`floor`, `arc`, `table`, `arch` for a table lamp on an arch), `color`, `shade`, and for an arc `reach` and `side` |
| `plant` | `pot`, `leaves` |
| `toilet`, `radiator` | `color` |
| `appliance` | `style`: `fridge`, `washer`, `oven`, `unit` (the outdoor unit of an air conditioner). `color` |
| `slats` | wooden slats on a wall: `color`, `backing`, `slat` (width), `pitch` |
| `curtain` | a sheer curtain in front of a window: `color` |
| `art` | a canvas or a frame on a wall: `color`, `frame`, or `mirror: true`, `round: true` |
| `mannequin` | a dressmaker's dummy: `color` |

A color is a material by name (`white`, `cream`, `black`, `charcoal`, `grey`, `steel`, `oak`, `walnut`, `pine`, `wicker`, `slate`, `fabric`, `linen`, `leather`, `green`, `terracotta`, `chrome`, `red`) or any `"#rrggbb"`. Real colors are toned to the dark theme when drawn.

Furniture is cut with the walls, at 1.25 m. What is there to be seen (a lamp, a screen, shelves or a canvas on a wall, a plant) may rise half a meter above the cut, and what hangs higher is not drawn. A type the page does not know is drawn as a plain volume.

A lamp of the house service standing on a piece of furniture needs both: the `lamp` item is the object, and the anchor of the device, placed at its shade, is where its light comes from.

### Adding a device to the plan

A device appears on the plan once it has an anchor. Nothing else changes, in the plan or in the code:

```json
{ "deviceId": "bedroom-lamp", "position": [1.2, 4.6, 0.6] }
```

- A lamp, an air conditioner, a heater or a sensor takes a `position`: where it is in the room, `z` being its height above the floor.
- A shutter or a blind takes the `openingId` of its window: it is drawn in the opening, as far down as its `position` says.

The file is read again when it changes: reload the page, the service does not need a restart.

How a device is drawn follows its `type` (`light`, `climate`, `heater`, `cover`, `sensor`), and for a type the page does not know, its capabilities: a `position` makes a cover, a `brightness` a light, a `setpoint` a heater or an air conditioner. A new kind of drawing is one more module in `public/js/plan3d.js`.

## Configuration

Under `house` in `config.json`:

```json
{
  "house": {
    "host": "127.0.0.1",
    "port": 5253,
    "token": "a-long-random-string",
    "planPath": "C:\\Users\\me\\Documents\\home\\plan.json",
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
    "cozytouch": { "username": "", "password": "" },
    "lgThinq": { "token": "", "country": "FR", "region": "eic" }
  }
}
```

`host`, `port` and `token` only matter when the service runs alone. Secrets can come from the environment instead of the file: `HOUSE_TOKEN`, `GOVEE_API_KEY`, `COZYTOUCH_USERNAME`, `COZYTOUCH_PASSWORD`. `HOUSE_CONFIG` names another config file.

`planPath` is the file of the floor plan, kept outside the repository. A relative path starts from Vigie's folder inside the agent, from the folder of the config file when the service runs alone. `HOUSE_PLAN` replaces it. Without it there is no plan and `/plan` answers 404.

## Drivers

| Driver | Devices | Network | Settings of a device |
|---|---|---|---|
| `govee-lan` | Govee lights | local, UDP | `device` (the id given by `/discovery`) or `ip` |
| `daikin` | Daikin air conditioners with a Wi-Fi adapter | local, HTTP | `ip` |
| `cozytouch` | Atlantic, Thermor, Sauter heaters and water heaters | Cozytouch cloud | `deviceURL` or `label` (with a bridge), `deviceId` (appliances with their own Wi-Fi) |
| `lg-webos` | LG televisions | local, WebSocket | `host`, `key` (given by pairing), `mac` (to turn it on), `apps` |
| `lg-thinq` | LG washing machines | LG ThinQ cloud | `deviceId`, `location` for a machine with two drums |
| `demo` | made-up devices of any type, kept in memory | none | `state`, what the device starts with |

**govee-lan.** Each lamp needs "LAN Control" switched on once in the Govee Home app (the lamp, then its settings). A scan goes to `239.255.255.250:4001` on every network card, lamps answer on port 4002, commands go to port 4003. Only one program can listen on 4002: the driver reports an error if Home Assistant or another instance already does. With `house.govee.cloudFallback` and an API key, a lamp that stays silent on the LAN and has a `sku` in its settings is reached through Govee's cloud instead, for a model without LAN support.

**daikin.** Reserve the IP of each unit on the router. The driver reads what the unit supports from `get_model_info`. Energy comes from the per-unit counters (`get_day_power_ex`, `get_week_power_ex`, `get_year_power_ex`): on a multi-split, `get_week_power` gives the total of the outdoor unit, the same on every indoor unit. The weekly program is read from the unit and written into it (`get_scdltimer_info` gives the layout of an entry, `get_scdltimer_body` the entries of a program, `set_scdltimer_body` and `set_scdltimer_info` take them back). The on/off timer is only reported as active or not.

**cozytouch.** Off until `house.cozytouch` holds the email and password of the Cozytouch (or Sauter, Thermor) account. Written after the open-source pyoverkiz library for an electric towel dryer, and tested on simulated answers only. The weekly program is read and written in the heater's own format, as the `schedule` capability: send back what `state.schedule` gave you, modified.

The Cozytouch account answers on two clouds. Heaters behind a Cozytouch bridge are on Overkiz, as above. Appliances with their own Wi-Fi, such as recent water heaters, are on Atlantic's newer API, read after the open-source [gduteil/cozytouch](https://github.com/gduteil/cozytouch) integration: a device there has a number, `deviceId`, and `/discovery` lists both kinds. A water heater (`"type": "water"`) gives its mode, the showers asked for and left, its boost and the absence of the home. The absence belongs to the account: setting it from here sets it for every appliance of the account, as the Cozytouch app does. Tested on simulated answers only.

**lg-webos.** No cloud: the set is asked on the local network, over the WebSocket the LG remote apps use (port 3001, or 3000 on older sets), after the open-source [aiowebostv](https://github.com/home-assistant-libs/aiowebostv) library. A set accepts a client once, on its screen: `node house/pair-tv.js <address>` asks, and prints the key to put on the device. Turning it on is a Wake-on-LAN packet to its `mac`, which needs "Turn on via Wi-Fi" (or LAN) switched on in the settings of the set. A set that does not answer is off, not unreachable, so a scene can turn it on. Its certificate is its own and is accepted as such: the driver is for a home network. `apps` lists the ids of the applications to offer (`netflix`, `youtube.leanback.v4`…), none by default. Tested on simulated answers only.

**lg-thinq.** Off until `house.lgThinq` holds a personal access token of the LG account, made on <https://connect-pat.lgthinq.com>: `{ "token": "…", "country": "FR", "region": "eic" }` (`eic` for Europe, `aic` for the Americas, `kic` for Asia). It is the official ThinQ Connect API, after LG's own [pythinqconnect](https://github.com/thinq-connect/pythinqconnect) client. A washing machine (`"type": "washer"`) gives its state, the time left and the end of its cycle. The API does not say which program runs. A cycle can be started from here only when "Remote Start" was pressed on the machine, which is LG's rule. The cloud is asked once a minute at most. Tested on simulated answers only.

**demo.** For the tests, the screenshots and trying the House tab without any hardware. `house/demo/config.json` is a made-up flat using it, with its plan beside it:

```bash
HOUSE_CONFIG=house/demo/config.json node house/server.js     # the API alone, on port 5253
```

To see it in the page, copy its `house` block into `config.json` and set `"planPath": "house/demo/plan.json"`.

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
