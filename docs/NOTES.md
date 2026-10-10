# Design notes

Why things are built the way they are, when the code alone doesn't tell. Read this before changing an existing card.

## Display principles

The Overview must fit on one screen without scrolling. Anything added there costs something removed, so new cards go to Weather, Machine or Tools.

A card that is "hidden when empty" isn't free if it is rarely empty. A first version of "What changed" lived on the Overview and made it scroll for weeks because of a single thermal drift. The Overview now only shows pills, the details live in Machine.

The Tempo badge in the header only shows when tomorrow is red. A permanent badge ends up unseen.

Tabs follow one rule: one tab per domain. The Year and Network cards are in Machine because the PC produces those measurements.

## Look

One color sets the theme. Every surface (background, panels, lines, text, accent) derives from `theme.color` through OKLCH relative colors in `style.css`, with lightness and saturation capped, so any color gives a readable dark palette. The background also shifts a little with the sky of the selected city: night, dusk, clouds, rain, snow.

The type is Bahnschrift, the DIN face that ships with Windows, with tabular figures so a changing number doesn't push its neighbors around. No webfont to download, the page stays local. The briefing uses Segoe UI, easier to read for full sentences.

The sun's path comes from the solar elevation computed on the page (`public/js/sun.js`, an approximation within a degree) for the selected city. The vertical scale is fixed, so a December day and a June day compare at a glance, and the night part is flattened to stay clear of the hour marks.

Icons are SVG drawn for the page (`public/js/icons.js`), never emoji: an emoji looks different on every system and can't take the theme's colors. Clouds are filled with the background color, so a sun or a moon behind them is really hidden.

The CPU, GPU and RAM sparklines use a fixed 0 to 100 scale. Scaled to their own range, a flat 3 % would look like a storm.

The page fits the screen with a CSS zoom: `fitToScreen()` in `main.js` looks for the largest zoom at which the Overview still fits without scrolling, then the last cards stretch to the bottom edge (the forecast rows, the chart, the lists). Zooming everything rather than enlarging a few fonts keeps the proportions the design was drawn with. Only `getBoundingClientRect` includes the zoom, offset and client sizes don't. A margin of 6 px is left for the anti burn-in shift, which brought back a scrollbar on a page that fitted to the pixel. Below a zoom of 0.8 (a phone, a small window) the page keeps its natural size and scrolls.

The golden hour (sun between -4 and +6 degrees) and the blue hour (between -6 and -4) are soft bands on the sun's path, computed every 5 minutes rather than from crossing times, so a band that never closes in summer far north still comes out right.

In landscape the Overview uses three fixed groups instead of CSS columns. Columns follow the page order, which stacked the clock, the briefing and the weather in the first one, too tall for a 1080p screen. On a vertical screen the groups melt into one column and `order` restores the reading order. The briefing sits next to the clock there, in space that was empty anyway.

## Languages and countries

Every text shown on screen lives in the `I18N` dictionary of `public/js/i18n.js`. The agent never builds sentences: it sends codes and figures (`{ kind: 'latency', recent: 42, usual: 15 }`) and the page writes the text in its language. The only exception is the AI briefing, written by the model in the configured language.

A missing translation key shows up as the key itself rather than silently falling back to English, and a test checks that both languages have the same keys.

`country` picks the MeteoAlarm feed (37 European countries). `"FR"` also turns on the sources that only cover France: Tempo, éCO2mix, the regulated tariff and the name day. Without it the agent doesn't call them at all.

A MeteoAlarm title reads "Yellow Rain Warning issued for Portugal - Açores - Grupo Ocidental": the area is everything after the country, since it can itself contain " - ".

Open-Meteo is called with `timezone=auto`, so the hourly series follow each city's local time.

Public and school holidays come in French from the government's sources: the agent maps them to codes. A school break is a half-open range of Paris dates, from the first day off to the morning classes resume. The dataset has to be asked with `timezone=Europe/Paris`, or Saturday 17 October comes back as Friday 16 at 22:00 UTC. It also repeats each break once per académie, and a row whose end equals its start (a bridge, a summer end not published yet) is one day off.

## Errors

An external source failing (network down, timeout, HTTP error, bad payload) is expected and has its own error type, `SourceError` on the agent and `FetchError` on the page. That is the only error the code catches: anything else is a bug and propagates. A failing source is logged at most once an hour, so an unreachable service leaves a trace without flooding the console.

There are two catch-all points, on purpose: the HTTP handler answers 500 instead of dropping the connection, and the scheduler logs a failing job instead of taking the server down.

## Sensors

LibreHardwareMonitor's tree is parsed once, by the agent (`lib/sensors.js`). The same result feeds the page (`/sensors`) and the samples stored every 30 s, so the two can't pick different sensors. The traps it handles: two "Memory" loads (physical and virtual, told apart by their parent), the GPU hotspot listed before the core, NVMe drives exposing a controller temperature next to the composite one, values written with a decimal comma.

## Storage

`vigie.db` gets one sample every 30 s, purged after 30 days. The `daily` table keeps one row per day (kWh, hours on, max temperatures, disk space) and is never purged. Today and yesterday are recomputed every 10 minutes, because yesterday may be incomplete after an agent restart.

At startup, a backfill rebuilds from the samples the days missing from `daily`. It never rewrites an existing day.

One copy of the database per day goes to `backups/` with `VACUUM INTO`, which writes a consistent copy while the agent keeps writing. The last 7 are kept.

SQLite trap: `INSERT OR REPLACE` deletes the row and reinserts it, which resets to `NULL` every column missing from the query. Since the summary reprocesses yesterday, it wiped the measured disk space every night, the one value that cannot be rebuilt. Hence the column by column `ON CONFLICT … DO UPDATE`.

## Electricity

The éCO2mix dataset holds future quarter hours whose carbon value is still empty, so the agent asks for the latest non-empty one, and refuses it if it is more than 3 hours old. An older endpoint used to serve values weeks old as if they were current.

kWh come from integrating the sampled CPU + GPU watts. A gap of more than 5 minutes between two samples means the PC was off, and is not integrated.

Hours on and kWh are counted separately. A sample where LibreHardwareMonitor didn't answer counts in the hours (the machine was running) but not in the kWh (no watts). Average power is therefore divided by the time covered by watts, not by the time on.

The red and white Tempo days left come from the same service, they only change at midnight and are cached per date.

The end-of-month projection only shows when `daily` covers the whole start of the month. The comparison with the previous month compares the projection with the full month, and needs at least 20 days of data.

## Disk space

The system disk's free space is read once an hour, and the day only keeps the median, which feeds the "disk space dropping" alert. The day's last reading got fooled by a big temporary file still there at shutdown. The maximum depends on the number of readings: a long day gives more of them, hence a higher maximum.

A fill rate ("+14 GB/week") used to show under the storage bar: removed, it never led to doing anything. A full disk doesn't light the red banner either, which stays for temperatures: a slow condition that lasts months would turn it into permanent noise.

## Year card

The color of the daily strip follows the max GPU temperature, on a scale fitted to the temperatures actually observed. With fixed thresholds, a GPU living between 55 and 75 °C gave a single-color strip. Above 85 °C it is fixed red, and those days stay out of the scale. A day without a GPU reading stays grey, with no fallback to the CPU.

## Freeze or power cut

After an unexpected shutdown (Kernel-Power 41, BugCheck 1001, 6008, WHEA), the agent looks at when the samples stopped.

- They go up to the shutdown time (75 s gap at most): hard power cut, rather the power supply.
- They stop 120 s or more before: the machine had already frozen, rather the graphics driver.
- In between: undetermined. With no sample in the half hour before, no conclusion: the agent may not have been running.

The 30 day counters are computed by the agent on the full list, because the list shown is cut to 12 rows.

## What changed

The card compares the present with the past: latency, network losses, thermal drift, yesterday's consumption, disk space, how often incidents happen. Three rules everywhere, or it becomes a card you learn to ignore:

- the median, never the mean, so a single spike triggers nothing
- a relative threshold and a minimum absolute gap, otherwise going from 2 to 5 ms looks like a tripling
- a minimum number of samples on both sides

Thermal drift only uses samples at 50 % load or more, otherwise it mostly measures the weather and your habits. The text states the fact without a diagnosis: the agent doesn't know the room temperature.

## Chart and markers

The X axis is indexed on points, not on time, which lets the periods with the PC off be stitched together (a dotted line marks the break). To place a marker (incident, driver, BIOS or Windows update), the code finds the sample nearest in time and takes its column. A rule of three on dates would land in the wrong place.

Aggregation is done by SQLite (`GROUP BY`), and the bucket size depends on the number of samples, not on the range width. With the PC off half the time, fixed time buckets gave a chart three times coarser.

## Network

Node without dependencies can't send ICMP pings, so the agent times opening a TCP connection to `1.1.1.1:443`.

A measurement above 800 ms counts as a loss. Windows retransmits the first SYN after one second, so a value around 1000 ms is a lost packet that eventually got through. The distribution confirms it: a hole between 300 and 1000 ms, then a cluster right after 1000.

Jitter is the mean gap between two consecutive measurements. It is what you feel in games.

## PowerShell

Starting `powershell.exe` costs about 1.4 s for 10 to 50 ms of work. The agent therefore keeps one interpreter open and sends commands through its stdin, base64-encoded so a multi-line script needs no escaping. A marker in the output closes each answer.

- A `[GC]::Collect()` every 25 commands keeps the interpreter's memory from growing for weeks.
- One stdin means one command at a time. Slow, rare queries (Bluetooth, event log, WMI, registry) get their own process so they don't block the others.
- Without an answer in time, the interpreter is killed and replaced. A late answer must never go to the next command.

`/system` is polled every 30 s and cached 25 s. The cache absorbs bursts, and it is a bit shorter than the poll interval so the same list is never served twice.

## Weather and snow

Each snow spot is queried with the `elevation` parameter set to its altitude. Without it Open-Meteo answers for the mean altitude of its grid cell, valley floor included, and badly underestimates snow. It remains a weather model, not the ski resort report.

The gap to the seasonal normal is computed over the last 10 years at the same date (± 3 days), once a day per city.

The pressure tendency is the change over 3 hours, the meteorologists' interval: under 1 hPa it is steady, from 3.5 hPa a change of weather is close. It has its own request with the day before, the main series starts at midnight, too late for a tendency at 1 am.

The Weather tab makes no extra request: it uses the series already loaded for the Overview.

## Rain radar

Leaflet with an OpenStreetMap base and RainViewer tiles, neither needs a key. CARTO's dark bases now require a key (the tile comes back watermarked, which a plain HTTP status check doesn't reveal). The OSM base is therefore darkened by a CSS filter applied to its own layer only, so the radar isn't darkened.

The animation alternates two radar layers: the next frame loads into the hidden one before switching. The map only recenters when the city changes, so a manual zoom isn't overridden.

## House

Daikin (BRP069 and BRP072 adapters, local API without a key):

- Node's `fetch()` gets a 403 from these units because of its `Host` header, hence `http.request`
- `set_control_info` expects every field on every call. The agent reads the current state and only changes what is asked, otherwise sending a temperature resets the mode and the fan speed

Govee (cloud API): the light list is rediscovered on every call rather than fixed in the config. The state read right after a command can stay stale for a few seconds on the cloud side, the card catches up at the next refresh.

Security: control routes refuse any device missing from the list known on the server. Air conditioners ask for confirmation for anything that costs (turning on, changing the target), never for turning off.

## Services

Any HTTP answer below 500 means the server is up: a 401 or a 403 still comes from it. A 500 or more is a server error, no answer at all within 10 s is down. Checked every 5 minutes, the state since its last change.

## Fuel prices

The government dataset writes Paris wall-clock times labelled `+00:00`: read as UTC they land two hours in the future in summer. The first 19 characters are read as local time instead. A price that hasn't moved in a week says nothing about today and is dropped, out-of-stock fuels come without a price. The dataset has no station name, only the address. In WKT the longitude comes first: swapped, the query returns nothing and no error.

## Windows waiting

Only the reliable flags count for the restart pill (servicing, Windows Update, a pending rename). `PendingFileRenameOperations` is left out: installers leave files there to delete at the next boot, it is set most of the time.

Waiting updates come from an offline search, which reads what Windows' own last scan found: an online search takes 4 to 9 s and logs an event each time. Antivirus definitions are left out, Defender installs them by itself several times a day and the count would keep flipping, and so are optional updates.

## Now playing

The media session is read through WinRT from the shared PowerShell, in a few milliseconds. The session manager is kept between calls: asking for a new one each time grew the interpreter by 15 MB over 3000 calls. The session only gives an app id (Firefox's is a hash of its path), the Start menu gives its name.

The button sends play or pause, never toggle: a toggle would restart a player paused from the keyboard in the meantime. The agent acts on the session it showed last, found again by its app id, never on an id sent by the page. A paused player stays shown 5 minutes, long enough to press play again, not hours.

## Agent security

The agent only serves the files found in `public/` at startup, through a fixed table: no path from a request ever reaches the file system. It sends no CORS header. Serving the whole folder with a `*` CORS header used to expose `config.json` (API keys included) to any page open in the browser.

Removing CORS stops a third-party site from reading an answer, not from sending a request. The routes that act (`/open`, `/briefing`, `/house/govee`, `/house/daikin`) are POST only and also check the `Origin` header.

`/open` only opens URLs declared in `config.json`.

## Briefing

The context sent to the model is split in two. `alreadyShown` holds what the screen already shows, and the model is told not to repeat it. `toAnalyze` holds what the display can't say: the next 5 days, the state of the machine, electricity. The model therefore only produces foresight and advice, in 3 sentences at most.

The titles of the breaks are already shown as pills, but not their figures. The model must give the figure and a consequence, not copy the title.

On the page, `state.changes` and `state.crashCounts` are updated before any early return. A briefing announcing "3 days without incident" from a stale counter would be worse than no briefing.

The prompt forbids em dashes, the model still slips one in now and then. The agent rewrites them, and semicolons, before the text reaches the page (`plain()` in `lib/briefing.js`).

## Installed versions

To compare the installed version of a program with its latest release, Vigie reads the registry's uninstall keys and matches on the repo name. The repo name must cover whole words of the display name (camelCase counts as words), never the other way round. A plain "contains" let "vscode" catch "vs_codecoveragemsi", a Visual Studio component, whose version 18.7 then passed for VS Code's. VS Code itself registers as "Microsoft Visual Studio Code" and needs a `localVersions` path.

The shortest name wins a tie. Under four characters there is no matching, there would be too many homonyms. A path declared in `localVersions` always wins.

The comparison is numeric: `0.9.6.0` equals `v0.9.6`, and `0.100` is greater than `0.9`.

## Batteries

Logitech Lightspeed devices fall asleep and stop answering. The last known value is kept in `.batteries.json` and shown faded with `~`.

## Discarded ideas

- A waste collection card using a city's open data: the API catalog was unreachable, code removed. Only worth retrying if unauthenticated access comes back.
- Daily dev tips under the clock: removed, they took a line on the Overview for content tied to one person's stack.
