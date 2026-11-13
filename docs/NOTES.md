# Design notes

Why things are built the way they are, when the code alone doesn't tell. Read this before changing an existing card.

## Display principles

The Overview must fit on one screen without scrolling. Anything added there costs something removed, so new cards go to Weather, Machine or Tools.

A card that is "hidden when empty" isn't free if it is rarely empty. A first version of "What changed" lived on the Overview and made it scroll for weeks because of a single thermal drift. The Overview now only shows pills, the details live in Machine.

The Tempo badge in the header only shows when tomorrow is red. A permanent badge ends up unseen.

The Air quality card follows the same rule. While every city is "good" or "fair" (40 or less on the European index) and the home city has no pollen, there is nothing to act on: the card gives way to one line at the bottom of the weather card ("Fair air · no pollen", worded after the worst city). It comes back as soon as one city passes 40 or a pollen shows up. A city without data is ignored, no data at all keeps the card and its "unavailable". The full detail stays in Weather.

Top processes moved from the Overview to Machine: at rest the list never changes and it took half a row. Storage and Devices now share that row as two cards.

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

The agent reads LHM at most once per `lhmPollMs` (5 s by default) and serves that result to every caller, the page included. LHM itself is set to the same interval, and to the CPU, GPU, storage and network only: its memory module reads the DIMMs' SPD over SMBus (the bus iCUE drives for the RGB), its motherboard module the Super I/O and its controller module the AIO (both owned by NZXT CAM). Two programs on one of those buses is a classic cause of full freezes with nothing in the logs. The RAM load therefore comes from the OS (`withFallbacks`), the liquid temperature stays in CAM and the card simply hides it.

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

The samples recorded before the last incident sit behind a "Show the readings" button, closed by default: the diagnosis is what gets read, the table is the evidence. Its liquid column only shows when a sample has a value. LibreHardwareMonitor no longer reads the AIO (see Sensors), and a column of dashes looked like a broken sensor.

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

Off season a list of spots at 0 cm says nothing. Without snow on the ground or expected anywhere, only the main spot (the first of the config) is shown, for its 0 °C level and the snowfall expected. With snow, only the spots that have some or expect some are listed, the deepest on top.

The text of a warning is not in the MeteoAlarm feed but in the CAP document each entry links to, one per language: the agent fetches it for the warnings it keeps and takes the description in the configured language. Like the briefing, it is shown as written by the source. The link is only followed on MeteoAlarm's own host.

The gap to the seasonal normal is computed over the last 10 years at the same date (± 3 days), once a day per city.

The pressure tendency is the change over 3 hours, the meteorologists' interval: under 1 hPa it is steady, from 3.5 hPa a change of weather is close. It has its own request with the day before, the main series starts at midnight, too late for a tendency at 1 am.

The Weather tab makes no extra request: it uses the series already loaded for the Overview.

## Rain radar

Leaflet with an OpenStreetMap base and RainViewer tiles, neither needs a key. CARTO's dark bases now require a key (the tile comes back watermarked, which a plain HTTP status check doesn't reveal). The OSM base is therefore darkened by a CSS filter applied to its own layer only, so the radar isn't darkened.

The map opens on the selected city and about 150 km around it, the rain that matters in the next hours, instead of a frame from Bordeaux to Milan. The zoom is whatever fits that width in the map, so between 130 and 260 km across depending on the screen. RainViewer's free tiles stop at zoom 7 and answer beyond with a "zoom not supported" picture: Leaflet is told to stretch the level 7 tiles (`maxNativeZoom`).

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

The context sent to the model is split in two. `alreadyShown` holds what the screen shows in large type next to the text, and the model is told not to repeat it. `toAnalyze` holds what the display can't say: the next 12 hours hour by hour, the next 5 days, the house, a fuel price that moved, the state of the machine, electricity. The model therefore only produces foresight and advice, in 3 sentences at most.

Some of `toAnalyze` is on screen in small print: the titles of the breaks and the services down as pills, tomorrow's Tempo color, the coming holiday under the date. They stay there on purpose, the screen states them and draws nothing from them. The model must give the figure and a consequence, not copy the title.

A field without data is left out of the context, never sent empty or `null`: the model comments on whatever it is given. Three rules came from the first real briefings, each enforced in the data before the prompt:

- The machine is only described after an incident in the last 7 days or with a detected break. Given a quiet machine, the model wrote "11 days without incident, nothing to report".
- Rain comes as spells with their hours and millimetres ("heavy rain until 21:00, about 15 mm") and no probability. The day's probability is on screen, so it sits in `alreadyShown`. Each spell carries its sky, so that advice fits the phenomenon: the car under cover is for hail or a flood, not for rain.
- An air conditioner is only sent when it runs against the weather: heating above 18 °C outside, cooling below 15 °C. Neither the room temperature nor the target goes out. The Daikin probes read 3 to 5 °C too high, by a varying amount, and the model advised turning off a heating that was needed.

More generally, an item only reaches the model if it calls for an action, and that filter lives in the code building the context, not in the prompt. Told that tomorrow is a blue Tempo day, the model writes that there is nothing to do, whatever the prompt says. So Tempo is sent for a white or red day only, rain only when an hour passes the threshold, electricity only when the projection is 20 % off the previous month, and a warning goes without its level, which the pill already shows.

Three sentences are a ceiling, not a target: one sentence per useful thing, and "Rien de particulier aujourd'hui." when there is none.

The text used to be written once a day, at the first display: stale by the afternoon, and a crash at 3 pm only showed up the next day. It is now written per time slot (morning, midday from 12, evening from 17) and again as soon as something new happens: an incident, rain likely within 3 hours, a weather warning, a service going down. The agent also adds the current time and the slot to the context, so the model can say "tonight" or "in 2 hours".

The page decides nothing. It posts its context after every refresh of the weather, the incidents, the warnings and the services, and the agent answers from its cache unless the slot changed or the context holds an event the cached text did not know. The fingerprint is that list of events, not a hash: only a new key counts. A hash would also rewrite the text when the shower has passed or the warning is lifted, and a forecast hovering around 60 % would burn a call at every flip.

Before 5 am the slot is still the evening before. Otherwise a text written at ten past midnight would stand for the whole morning.

The call is paid, so a guard caps it: one call per 30 minutes and 8 a day, events or not. Failed attempts count, or a rejected key would be retried at every refresh. While the guard holds, the text of an earlier slot of the same day is served rather than nothing. Yesterday's is not: the page hides the line.

At startup the refreshes all land within seconds. The page waits until 8 s have passed without a new one before posting, or the first text of the day would be written before the incidents arrive and the guard would then keep them out for half an hour.

Open-Meteo's hourly rain, probability and gusts cover the hour before their timestamp. The summary labels them with the hour they start at, or "rain at 17:00" would mean rain that has ended by then.

Haiku 5.5 thinks by default and its thinking counts in `max_tokens`, hence 2000 tokens for three sentences. Thinking was first turned off to fit in 300: the model then reasoned inside its answer, in English, and corrected a first false sentence on screen ("Ah wait, I need to correct that"). This model takes no explicit thinking budget (`budget_tokens` is refused), only an effort level, left at its default.

The agent checks the text before caching and showing it, and refuses more than 3 sentences, more than 400 characters, English reasoning words in a French text, or a field name of the context. Only the keys that cannot be ordinary words are looked for (`nextDays`, `next12h`): `machine` or `tempo` are fields too. A refused text counts as a call, the previous one stays on screen.

The fuel dataset only knows today's price. To tell that a price moved, the agent keeps the cheapest one of each fuel once a day (table `fuel`), and the briefing compares it with the oldest of the last 7 days.

On screen the weather warnings and the briefing form one block, without a card. The warning pill used to float alone at the right above a text aligned at the left. The rule of the block takes the color of the worst warning, and an orange or red one tints its background. The block has a fixed width so the pills start at the same left edge with or without a text.

Figures with their unit and day names are set in medium weight by the page. The text is escaped first and the pattern runs on the escaped text, so nothing the model writes reaches `innerHTML` as markup.

A pill says until when its warning runs, from `cap:expires` in the MeteoAlarm feed. A warning renewed at the same level has several entries: the later end wins.

On the page, `state.changes` and `state.crashCounts` are updated before any early return. A briefing announcing "3 days without incident" from a stale counter would be worse than no briefing.

The prompt forbids em dashes, the model still slips one in now and then. The agent rewrites them, and semicolons, before the text reaches the page (`plain()` in `lib/briefing.js`).

## Installed versions

To compare the installed version of a program with its latest release, Vigie reads the registry's uninstall keys and matches on the repo name. The repo name must cover whole words of the display name (camelCase counts as words), never the other way round. A plain "contains" let "vscode" catch "vs_codecoveragemsi", a Visual Studio component, whose version 18.7 then passed for VS Code's. VS Code itself registers as "Microsoft Visual Studio Code" and needs a `localVersions` path.

The shortest name wins a tie. Under four characters there is no matching, there would be too many homonyms. A path declared in `localVersions` always wins.

The comparison is numeric, segment by segment, once the `v` prefix and the trailing zeros are gone: `0.102.3101.0` equals `v0.102.3101`, and `0.100` is greater than `0.9`.

The latest release is picked from the 30 most recent ones, not from GitHub's "latest". That one trusts the pre-release flag, which Node leaves off on its alphas: tags holding alpha, beta, rc, nightly or canary are skipped too. Among the stable ones the highest version wins, not the most recent date, since a project with several maintained lines publishes the old one last. Node follows its LTS line, read from the release name ("(LTS)").

"New version" is only said when the installed version is known and behind. Without an installed version the row says when the release came out ("released 2 d ago"), highlighted for two weeks. The old "new" badge only meant recent, and read as an update to install even on an up to date tool.

## Batteries

Logitech Lightspeed devices fall asleep and stop answering. The last known value is kept in `.batteries.json` and shown faded with `~`.

## Discarded ideas

- A waste collection card using a city's open data: the API catalog was unreachable, code removed. Only worth retrying if unauthenticated access comes back.
- Daily dev tips under the clock: removed, they took a line on the Overview for content tied to one person's stack.
