# Vigie

A dashboard for a vertical screen sitting next to your PC. It shows the weather, the state of the machine, its power use, and a few everyday things. Everything runs locally on Windows, with no account, no subscription and no npm dependency.

A small Node server reads the sensors and serves a plain HTML page. There is nothing to build and nothing to install besides Node.

<p align="center"><img src="docs/screenshot.png" alt="Vigie's Overview tab" width="480"></p>

The interface is available in English and French.

## What it shows

The interface has five tabs. The Overview is meant to be read at a glance and fits on one screen without scrolling, on a vertical screen as on a 1080p landscape one. The other tabs go into detail.

- **Overview**: time and the sun's path over the day with its golden and blue hours, today's weather and a 5 day forecast, electricity (machine consumption and cost), CPU/GPU/RAM with their last hour and a 30 day chart, storage, device batteries. Air quality gets its card only when it is worth a look. What is playing shows up with a play/pause button, and pills appear only when something needs you: a restart, updates waiting, a service down.
- **Weather**: all your cities side by side, 48 hours hour by hour, pressure and its tendency, 7 days, animated rain radar, pollen, snow depth at a few spots.
- **Machine**: hardware sheet (drivers, BIOS, updates), what changed recently, crash history with a diagnosis, top processes, connection quality, the services you watch (router, NAS, websites), a yearly summary.
- **Tools**: your favorite links grouped by topic, and the latest versions of software you follow on GitHub.
- **House**: your home room by room, with Govee lights, Daikin air conditioners and Cozytouch heaters, scenes in one tap, and fuel prices around home.

Optionally, a short briefing written by Claude sits next to the clock and sums up what deserves your attention, in the morning, at midday and in the late afternoon.

Weather warnings come from MeteoAlarm and work in 37 European countries, set with `country`. A few cards use French public data and only appear when `country` is `"FR"`: the EDF Tempo color and the days left, the grid's carbon intensity (éCO2mix), the regulated electricity price, the name day, public and school holidays, fuel prices.

## Requirements

- Windows 10 or 11
- [Node.js 22.13](https://nodejs.org) or later (for its built-in SQLite)
- [LibreHardwareMonitor](https://github.com/LibreHardwareMonitor/LibreHardwareMonitor/releases) for the sensors
- Google Chrome for the full screen mode (any browser is fine to try it out)

Optional:

- [LGSTrayBattery](https://github.com/andyvorld/LGSTrayBattery/releases) for the battery of Logitech wireless devices
- an Anthropic API key for the briefing
- Govee lights, Daikin units with a WiFi adapter, or an Atlantic, Thermor or Sauter heater on Cozytouch, for the House tab

## Install

1. Clone the repository, then copy `config.example.json` to `config.json`.
2. Start LibreHardwareMonitor as administrator and enable **Options → Remote Web Server → Run** (port 8085). Check that `http://localhost:8085/data.json` answers.
3. Run `node agent.js` and open http://localhost:5252.

To get it full screen on the vertical display:

1. Run `powershell -ExecutionPolicy Bypass -File detect-monitors.ps1` to find the position of your screens.
2. Create a `start-dashboard.local.bat` file with your settings. Git ignores it, so updates won't overwrite it.

   ```bat
   set POS_X=1920
   set POS_Y=0
   set "LHM_PATH=C:\Tools\LibreHardwareMonitor\LibreHardwareMonitor.exe"
   ```

3. Double-click `start-dashboard.bat`. It starts LibreHardwareMonitor, the agent, then Chrome full screen on the right display. `stop-dashboard.bat` stops everything.

To start it at every login, double-click `install-startup.bat` once. Also enable **Run On Windows Startup** in LibreHardwareMonitor, otherwise it starts without admin rights and some sensors are missing.

When the folder is a git clone, `start-dashboard.bat` runs a `git pull` at every start.

## Configuration

Everything is set in `config.json`. Only the cities are really needed: any card whose settings are missing simply stays hidden.

| Key | What it does |
|---|---|
| `lang` | Interface language, `"en"` or `"fr"` |
| `country` | Two-letter country code (`"FR"`, `"DE"`, `"BE"`…) for weather warnings. `"FR"` also turns on the France-only cards |
| `cities` | Cities shown, the first one is the main city |
| `snowSpots` | Spots tracked for snow, with their altitude `alt` |
| `alertAreas` | Areas for MeteoAlarm warnings, with their exact name in the feed ("Rhône", "Isère") |
| `schoolZone` | French school holiday zone, `"A"`, `"B"` or `"C"`. Without it, only public holidays show |
| `network` | Target of the latency test (`1.1.1.1:443` by default) |
| `services` | Services watched in the Machine tab, `{ name, url }` with an http(s) URL. `name` defaults to the host |
| `tools` | Link groups of the Tools tab. `icon` takes a name from `public/js/icons.js` (`code`, `chip`, `gamepad`…) or an emoji, `releases` lists GitHub repos whose latest version to track |
| `localVersions` | Path to an `.exe` to compare its installed version with the latest release |
| `electricity.pricePerKwh` | Your price per kWh. In France, left at `null`, Vigie uses the regulated tariff |
| `electricity.tempoPrices` | For a Tempo contract: `{ "blue": 0.13, "white": 0.16, "red": 0.75 }` |
| `electricity.baseWatts` | Watts to add to CPU + GPU for the rest of the machine |
| `fuel` | Fuel prices around the first city: `{ "types": ["e10", "sp98"], "radiusKm": 5 }`, among `gazole`, `sp95`, `e10`, `sp98`, `e85`, `gplc` |
| `anthropicApiKey` | Turns on the briefing |
| `briefing` | Optional tuning of the briefing, see below |
| `house` | Rooms, devices, ambiances and scenes of the House tab, see below |
| `theme` | Background color, the whole palette derives from it: `{ "color": "#0d3b66" }`. Add `"accent"` to pick the highlight color yourself |
| `dimming` | Screen dimming: `{ "level": 0.45 }` all the time, or `{ "level": 0.45, "from": "22:00", "to": "06:30" }` at night. No key, no dimming |
| `port`, `lhmUrl`, `lgstrayUrl` | Ports and addresses of the local services |

The other colors (warnings, temperature scale) are in `public/style.css`, alert thresholds (`THRESHOLDS`) in `public/js/system.js`.

### House

The House tab talks to a small service of its own (`house/`), started inside the agent. It drives the devices directly, so the manufacturers' apps are no longer needed day to day:

- **Govee lights** over the local network, without key or cloud. Switch on **LAN Control** once per lamp in Govee Home (the lamp, then its settings).
- **Daikin** air conditioners through their Wi-Fi adapter, also local: mode, fan, vanes, target, powerful and eco modes, energy used. Reserve their IPs on your router.
- **Atlantic, Thermor and Sauter** heaters through the Cozytouch cloud, once `house.cozytouch` holds the account's email and password.

Describe your home under `house` in `config.json`, by room:

```json
"house": {
  "rooms": [
    { "id": "living", "name": "Living room", "devices": [
      { "id": "living-lamp", "name": "Lamp", "type": "light", "driver": "govee-lan", "device": "00:00:5E:00:53:01:00:01" },
      { "id": "living-ac", "name": "Air conditioner", "type": "climate", "driver": "daikin", "ip": "192.0.2.20" }
    ] }
  ],
  "ambiances": [{ "id": "warm", "name": "Warm", "brightness": 45, "colorTempK": 2700 }],
  "scenes": [{ "id": "leave", "name": "Leaving", "actions": [{ "type": "light", "set": { "on": false } }, { "type": "climate", "set": { "on": false } }] }]
}
```

Open `http://localhost:5252/api/v1/discovery` to get the `device` id of each lamp that answers on your network. Ambiances are your own light presets, they replace Govee's scenes. Scenes are buttons at the top of the tab, and each one also has a plain URL for a Stream Deck or a shortcut. Once everything answers here, the Govee Home and Daikin apps can be uninstalled: reinstall Govee Home only to add a new lamp.

The service can also run alone on a machine that stays on (`node house/server.js`), with a token. Its API, the full configuration and how to add a driver are in [house/API.md](house/API.md).

### Briefing

The briefing is rewritten three times a day, and right away when something new happens (a PC incident, rain coming, a weather warning, a service down). Every key of `briefing` is optional:

| Key | Default | What it does |
|---|---|---|
| `slots` | `{ "morning": 5, "midday": 12, "evening": 17 }` | Hour each time slot starts at. Before `morning`, the night still counts as the evening before |
| `minIntervalMin` | `30` | Minimum minutes between two calls to the model |
| `maxPerDay` | `8` | Maximum calls to the model per day |
| `rainSoonPct` | `60` | Rain probability within the next 3 hours that triggers a new briefing |
| `rainHourPct` | `50` | Rain probability above which an hour is listed for the model |
| `gustKmh` | `50` | Gust speed above which an hour is listed for the model |
| `fuelDeltaEur` | `0.05` | Price change in € per litre, over up to 7 days, from which a fuel is mentioned |
| `acHeatAboveC` | `18` | Outdoor temperature above which a heating left on is pointed out |
| `acCoolBelowC` | `15` | Outdoor temperature below which a cooling left on is pointed out |
| `electricityGapPct` | `20` | Gap in % between the month's projection and the previous month from which electricity is mentioned |

## How it works

```
start-dashboard.bat ──▶ agent.js (http://localhost:5252)
                          ├─ serves the page in public/
                          ├─ reads LibreHardwareMonitor, PowerShell, the Windows event log
                          ├─ records the sensors every 30 s in vigie.db
                          ├─ runs the house service (lights, air conditioners, heaters)
                          └─ queries MeteoAlarm, Tempo, éCO2mix, GitHub, Claude
```

| Path | Content |
|---|---|
| `agent.js` | Entry point: config, routes, scheduled jobs |
| `lib/` | The agent's logic, one module per topic (sensors, energy, weather, crash…) |
| `house/` | The house service: its API, one driver per brand. Runs inside the agent or alone |
| `public/` | The page: `index.html`, `style.css`, and ES modules in `js/` (no build) |
| `test/` | Tests, run with `node --test` |

The page calls Open-Meteo directly for the weather. Everything else goes through the agent, on the same origin.

The agent only listens on `127.0.0.1`. It only serves the files of `public/` (your config and keys are not reachable), and the routes that act on hardware check where the request comes from.

Measurements are stored in `vigie.db` (SQLite, built into Node). Raw samples are kept 30 days, and one summary per day is kept forever for the yearly view. The agent also writes one copy of it per day in `backups/` and keeps the last 7. They sit on the same disk: copy that folder elsewhere if you care about your history.

The reasons behind some choices (freeze or power cut diagnosis, how latency is computed, the Daikin and Govee API traps…) are explained in [docs/NOTES.md](docs/NOTES.md).

## Services used

Without a key: [Open-Meteo](https://open-meteo.com) (weather, air, pollen, snow), [RainViewer](https://www.rainviewer.com/api.html) and OpenStreetMap (radar), the GitHub API (versions), [MeteoAlarm](https://meteoalarm.org) (warnings). In France also [API Couleur Tempo](https://www.api-couleur-tempo.fr), [éCO2mix / ODRÉ](https://odre.opendatasoft.com), [open-dpe.fr](https://open-dpe.fr), [Nominis](https://nominis.cef.fr), the [public holidays](https://calendrier.api.gouv.fr) and [school calendar](https://data.education.gouv.fr) of the French government, and its [fuel prices](https://data.economie.gouv.fr).

The only external library is [Leaflet](https://leafletjs.com), loaded from a CDN with an integrity check, for the radar map.

## Troubleshooting

- **"LibreHardwareMonitor unreachable"**: the Remote Web Server is not running. Check `http://localhost:8085/data.json`.
- **Some sensors are missing**: LibreHardwareMonitor must run as administrator. If you use NZXT CAM, it locks the NZXT pump and fans while it is open.
- **A mouse or keyboard battery is missing**: check that LGSTray is running (`http://localhost:12321/devices`) and wake the device up. A faded value with `~` is normal, it is the last known value of a sleeping device.
- **A Bluetooth controller or headset is missing**: Windows only reports the battery of standard Bluetooth devices that are connected.
- **No weather warning shown**: good news, nothing is active for your areas. Check that `country` is set and that `alertAreas` uses the exact names of the MeteoAlarm feed.
- **Errors**: run `node agent.js` in a terminal to see what a source or a device answers.
- **A Daikin unit stopped answering**: its IP probably changed. Reserve it on your router.
- **A Govee lamp says "no answer on the local network"**: it has no power (switched off at the wall), or LAN Control is off for it in Govee Home.

## Development

No dependency to install. `node --test` runs the tests, and GitHub Actions runs them on every push with a syntax check of every file. Comments explain why, not what, and every text shown on screen goes through the `I18N` dictionary in `public/js/i18n.js`, in both languages.

## License

[MIT](LICENSE)
