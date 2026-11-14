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

The house is a service of its own (`house/`), with its own API (`house/API.md`). It runs inside the agent by default, but nothing in it comes from Vigie: it is meant to move to a machine that stays on, and to serve phone apps too. Vigie's House tab is one client, drawn from what the service says each device can do. The page knows no brand.

The model is by room: a room holds devices, each with a type, a driver and capabilities in one vocabulary (`on`, `brightness`, `mode`, `setpoint`…). One file per driver: adding a brand means adding a driver.

Schedules live in the devices, not in the service. The PC is not on all day: a "turn on at 6:30" kept by the service would not fire. The service reads and writes the program stored in a heater and reports the timers of an air conditioner. What it runs itself are scenes, on demand.

The temperature of a room comes from a sensor of its own. The probe of a Daikin indoor unit reads 3 to 5 °C above the room, by a varying amount: it is shown small as "unit probe", never as the room's temperature.

Govee, local network (UDP):

- no key, no cloud: a scan to the multicast group, the lamps answer with their IP, commands go straight to the lamp
- each lamp needs "LAN Control" switched on once in Govee Home. A lamp that stays silent gets one message naming the two usual causes, since a lamp switched off at the wall looks exactly the same
- the scan leaves on every network card: on a PC with Hyper-V or Docker adapters, the default one is often not the one the lamps are on
- lamps are declared by the id the scan gives, not by IP, so a new DHCP lease changes nothing
- Govee's scenes only exist in its cloud. They are replaced by ambiances, light presets kept in the config
- the cloud driver stays as a fallback, off by default, for a lamp without LAN support. The cloud keeps answering with the last known state of a lamp that has no power

Daikin (BRP069 and BRP072 adapters, local API without a key):

- Node's `fetch()` gets a 403 from these units because of its `Host` header, hence `http.request`
- `set_control_info` expects every field on every call. The driver reads the current state and only changes what is asked, otherwise sending a temperature resets the mode and the fan speed
- each mode keeps its own target. A change of mode sends the target kept for the new mode: the current one may be `M` (dry) or `--` (fan), which the unit refuses
- energy comes from the per-unit counters (`get_day_power_ex` and its week and year siblings). On a multi-split, `get_week_power` gives the total of the outdoor unit, the same figure on every indoor unit: summed over the rooms it would count the bill several times
- powerful and eco are offered when the unit reports its special modes
- the weekly program lives in the unit, so it runs with the PC off: the service reads it and writes it there, and never runs one itself. Its format is documented nowhere and was read on real units, one program made in the manufacturer's app for the purpose. `get_scdltimer_info` gives the layout of an entry (`f_detail`, the fields in order with their widths), the active program among three and six entries a day. `get_scdltimer_body?target=N` gives a count per day and the entries, fixed-width strings: `11420.50390B------` is enabled, on, heat, 20.5, minute 390 of the day (06:30), quiet fan, then vane, humidity and special mode left blank. The time is the minute of the day, not hours and minutes: `0390` read as 03:90 is what gave it away. An entry that turns the unit off, or on in dry mode, has dashes for what it does not carry. `set_scdltimer_body` and `set_scdltimer_info` take the same keys back: sending a program back as read left the unit unchanged, which is how the write was first tried
- writing a program is guarded, since a guess does not go into a heating device: only the modes whose entries have been seen can be asked for (heat, cool, dry), an entry that did not change goes back as the very string that came (so one in auto mode made in the app survives), a changed one keeps the fields nobody sets here, and the program is read back after the write: a unit that answers OK without keeping it is an error
- the editor works on a draft and saves it in one go. Each change sent as it is made would be a string of slow requests to the unit, and a half-edited program would run in between
- the on/off timer is still only known as active or not: the app in use offers no way to set one, so no entry could be read. It is not emulated by the service either, for the reason schedules live in the devices

Cozytouch (Atlantic, Thermor, Sauter, through the Overkiz cloud): written after pyoverkiz and Home Assistant's integration for an electric towel dryer, and only tested on simulated answers until a heater is installed. Off until its credentials are in the config. Boost and drying are one "temporary state" of the heater: leaving either goes back to plain heating.

Security: the service will leave the PC, so it has a token from the start. Listening on the machine only, local callers need none, as for the agent. On a network address every request needs it, and the service refuses to start without one. A page of another site is refused unless it holds the token. The one GET that acts, to run a scene from a button, always asks for the token. Heating devices ask for confirmation for anything that costs (turning on, changing a running unit), never for turning off.

The service writes no file: the lamps found by a scan are kept in memory.

### Appliances

- a water heater, a television and a washing machine are devices like the others: a type, capabilities, a state. The detail panel draws what the capabilities say, so a new appliance mostly costs its driver. Three things had no control yet: a period (the absence), an action (start a cycle), and options that carry their own names (the inputs of a television)
- the Cozytouch account answers on two clouds, and nothing in the app says which one a product is on. Products behind a bridge are on Overkiz. Those with their own Wi-Fi are on Atlantic's newer API, where a device is a list of numbered capabilities. The numbers come from the gduteil/cozytouch integration, which maps them product by product. The driver keeps both under one name, since it is one account and one password, and tells them apart by what the config gives: a `deviceURL` or a `deviceId`
- the absence of a water heater is the account's, not the heater's: the app writes it on the home, then each appliance mirrors it. Writing only the capability of the heater leaves the app and the heater disagreeing. So an absence set from Vigie applies to every appliance of the account
- a television is asked on the local network. Node has a WebSocket client, but it refuses the certificate a set signs for itself and has no option to accept it: `house/ws.js` is the hundred lines that do, text frames only. A set that does not answer is off, which is a state, not a failure: reported unreachable, a scene could not turn it on
- the key of a television is in the config, written by hand after `house/pair-tv.js`. The service writes no file, and a key that appears in a file on its own is a secret nobody knows is there
- a washing machine is read on LG's official API, with a personal access token. The unofficial API of the phone app knows the program and more, and asks for the account's password and breaks at each update of the app. The official one does not name the program: the tile says the step (rinsing, spinning) and the time left, which is what one looks at
- the end of a cycle shows where the warnings are, on the overview, until the machine is emptied or turned off. The briefing gets it too, and a cycle that ends within the hour. No sound and no notification: Vigie is a screen one looks at

### Plan

The plan of a home is private, and this repository is public. The engine is here (schema, drawing, interactions) with a made-up flat for the tests and the screenshots. A real plan stays in a file outside the repository, named by `house.planPath`, and reaches the page through `GET /api/v1/plan` only: the agent serves the files of `public/` and nothing else, so a plan dropped there would be readable by anything that can reach the port. A test fails if a plan appears under `public/`.

The route follows the access rules of the service instead of always asking for the token: the page has no token, and it reads the plan like it reads the rooms. From the machine itself no token is needed, a page of another site is refused, and on a network address every request needs the token.

Adding a device is adding an anchor: its id, and a place or the id of its window. The code does not know the devices of anybody's home. An anchor whose device or opening is gone is left out with a warning rather than failing the plan: removing a lamp from the config must not blank the screen. A plan that breaks the schema is refused whole, a half-drawn home being worse than none.

Drawing:

- three.js is the only third-party code of the page, copied in `public/vendor/three/` at one pinned version with its licence: no npm, no build, no CDN. r170 because it is the last release whose module is one file. It is loaded only when the House tab has a plan to draw
- walls are cut at 1.25 m, as on an architect's model: at full height the near walls hide the rooms. That cut is the height of the walls between rooms, and of every wall seen from above
- a wall with rooms on one side only does not stay at the cut. Seen from its outside it hides what stands along it, half a meter from the front and a meter in the three-quarter view, which is where a sofa or a bookcase goes: it comes down to 0.4 m. Seen from its rooms it hides nothing, so it rises to the head of its windows. Both follow the angle, so a wall sinks or rises while the model turns. A wall between two rooms stays: lowering it would show one room and uncover the back of the other's furniture
- an opening is cut where its wall is and never moved. A window that starts at 1 m in a wall cut at 1.25 m is a 25 cm strip of glass, which is what the first version drew on every wall and read as a slit under the ceiling. Raising the cut everywhere hid the rooms, and sliding the windows down to fit lied about them. Whole on the walls at the back, with its frame, and a line of glass on the cut of a wall lowered under its sill: the window is where it is, and as much of it shows as the wall leaves. A shutter is cut the same way, and its marker says the rest
- an orthographic camera: no perspective to distort the rooms, and the labels keep one size
- the picture is drawn on demand: after a change of state, a move of the camera, a resize. Nothing runs when the plan is still. The one animation, the breath of an air conditioner that runs, ticks at 20 images a second, stops when the tab or the page is hidden, and is not played at all under `prefers-reduced-motion` (views then change without a glide)
- `devicePixelRatio` is capped at 1.5: above, a 4K screen in portrait draws twice the pixels for edges nobody tells apart
- labels and markers are HTML laid over the canvas, placed by projecting their point: text stays sharp and in the page's font, a marker is a real button for the keyboard and a screen reader, and a press on it opens the same detail panel as its tile. Nothing of the controls is duplicated on the plan: tiles stay the main way to act
- a marker says what a device is by its icon and how it is by its color: a lit lamp is a dot of its own color, an air conditioner takes the color of its mode (the same on its tile and on its breath), anything off is small and grey. One glance tells what runs, without reading
- every room is named, the small ones in small. A room that holds devices also says what runs in it ("Living room · 20.4° · 21° · 2 lamps"). Markers stand where their device is and do not move, so a name takes the free spot closest to the middle of its floor: on it, else just below or above, else beside. The middle is the point furthest from the edges, not the centroid, which for a hall shaped like an L falls in the next room
- the frame is worked out from the home, not set by hand: its corners are projected for the angle of the view and the shape of the card, and the tighter side takes 94 % of the picture. It holds while turning and at every resize. The other side follows the shape of the home: a home hardly deeper than wide cannot fill a card much taller than wide, whatever the angle. A span in meters tuned on one plan left wide margins on another, and on the same one once the card changed shape
- the model view has no fixed angle either. On a wide card it is the usual three-quarter view. On a tall one, the same view leaves a third of the card empty, so it looks from higher and from the front, chosen among a few angles as the one at which the home covers most of the picture: a home longer than wide then stands with its long axis upright, turned a quarter if it was drawn the other way. Once turned by hand, the angle is the hand's
- a lit lamp warms the floor of its room with its color. The light is painted on a picture laid over that floor, not thrown by a light of the 3D scene: without shadows, such a light crosses the walls and lights the next room, which is the opposite of what the plan must say. A room where nothing is on stays dark
- floors are told apart by material with a slight tint and a pattern (boards, tiles, slabs outdoors), furniture is a lighter grey almost without hue, and the cut top of the walls is the clearest line of the picture. Furniture in the tint of the theme, as first drawn, merged with the floors
- daylight follows the real sun: its place in the sky over the home city (the first one of the config) and the `north` of the plan give the side the light comes from, warmer when the sun is low. At night that light is off and the sky dims, so the lamps that are on are what lights the model. It is kept faint and has no shadows: walls cut at 1.25 m would throw shadows no real room has. The sun is read by quarter of an hour, on the redraw the tab already makes every minute: no timer of its own
- furniture is a library of types with parameters (`public/js/furniture.js`): a cabinet with its niche and its baskets, shelving with staggered cells, a corner desk, an arc lamp. A home is then a list of instances in its private plan, and the repository holds no product, no photo and nobody's living room. Each type is a few boxes and cylinders, returned as plain data by a pure function, so it is tested without a screen. Meshes loaded from files would have looked better and meant a format, a loader and assets to keep out of a public repository
- all the furniture is drawn as instances of one box and one cylinder, one material per look (solid, see-through, glowing): a few hundred parts cost a handful of draw calls and a few thousand triangles. One mesh per piece, as first done for plain volumes, grew a draw call with every chair
- real colors are toned to the page: pulled toward the hull and dimmed, and black lifted to a dark grey. A white sideboard at its real value glared on the dark theme, and a black desk vanished on it
- the cut applies to furniture too: a wardrobe stops with the walls. What says what a room is for (a lamp, a screen, a canvas, a plant) may rise half a meter above the cut, like the frame of a shutter
- a lamp that is connected is two things on the plan: an item of decor, and the anchor of its device, placed at the shade. The light then comes from the shade without the furniture library knowing anything about devices
- a door can be drawn shut (`closed`): a front door standing open reads as a hole in the home
- a balcony or a loggia is drawn as outdoors: a floor of slabs a step lower, and a low rail on the sides no wall closes
- a lit lamp shows its real color, the one of its tile. The tint of a room comes from the room's own sensor, never from the probe of an air conditioner, and stays neutral between 19 and 21 °C: a tint is there to point at a room that is off, not to color a home that is fine
- the plan is moved by hand like a map: drag turns, the right button or Shift slides, the wheel zooms on the pointer, two fingers pinch and slide, arrows and + - do the same from the keyboard once the plan has the focus. The wheel is taken without Ctrl because the tab no longer scrolls. A second tap on a room frames it; one tap did, and framed rooms by accident as soon as dragging became the way to look around. A button brings back the automatic frame, shown only once the view was moved
- the picture follows the view with a short lag instead of jumping to it: a move ends softly, a limit is reached without a jolt, a flick carries on for what the hand would have covered in a moment. Limits are on the view, not on the picture: no lower than 28°, a zoom from the whole home to one piece of furniture, and a slide that stops when the middle of the picture reaches the edge of the home, so some of it always shows. Drawing stops as soon as the picture has caught up
- a room name that finds no free spot is not shown, where it used to take the least bad one and sit on a marker. Markers are never hidden: they are the devices
- under 720 px, or without WebGL, the same plan is drawn from above as SVG by `planSvg()`: a model that small is unreadable, and a kiosk whose GPU is blocked still gets its plan. That view is a pure function of the plan and the states, which is also what the tests check

The pure part (`public/js/plan.js`: geometry, choice of the module of a device, limits of the camera, the SVG) knows neither the page nor three.js, so it runs under `node --test`. `plan3d.js` only draws.

One module per type of device in `plan3d.js` (`light`, `climate`, `heater`, `cover`, `sensor`). The module is chosen by the type, and by the capabilities for a type the page does not know: the shutters of a brand to come will be drawn as soon as their driver reports a `position`.

The `demo` driver keeps made-up devices in memory. It exists so the tab, the plan and the screenshots can be shown without any hardware and without anybody's home.

### Tab

The tab fits the screen, like the Overview: on a wall screen nobody scrolls. Upright, the plan takes at least half of the height, then the scenes, then the tiles. Lying down, the plan sits beside them. When the tiles are too many for their share, they are the ones that tighten, in three looks (small cards, rows, tight rows): the plan never shrinks, since a plan too small to read is worth nothing while a tile still says its figure at 46 px. What the tiles do not use goes to the plan. Under 720 px wide the tab scrolls as before.

One grid for every room instead of one row of tiles per room: a room with a single device left three quarters of a row empty, and four rooms cost four titles. The room is written small on each tile, and what runs in a room is said on the plan. Framing a room on the plan dims the tiles of the others.

A lit lamp tints its tile with its color at a quarter strength, with a band of the full color on the left. Filled with the color, as first done, a room of warm white lamps turned the screen brown, and the text had to switch between dark and light with the color.

A tile and its marker on the plan point at each other: the one under the pointer shows on the other side. On a touch screen a tap does it for a moment, since nothing hovers there.

Fuel prices left the tab for Tools: they are not the home, and their card was what made the tab scroll.

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

Removing CORS stops a third-party site from reading an answer, not from sending a request. The routes that act (`/open`, `/briefing`) are POST only and also check the `Origin` header. The house API has its own guard (see House).

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

- Controls on the plan (a slider on a lamp, a setpoint on an air conditioner): the plan shows where things are and what they do, the tiles act. Two places to set the same value drift apart, and a slider on a tilted floor is hard to hit.
- A light of the 3D scene per lamp: it crosses the walls. See the plan.
- Shadows for the daylight: they belong to walls cut at mid-height, not to the home.
- A list of the devices of the framed room under the plan: the tiles are that list, it only showed them twice.
- A plan file in `public/` read as a static file: it would have put the layout of a home one `git add` away from a public repository.
- Continuous rendering at 60 images a second with shadows: a wall screen that is on all day pays for it in heat and fan noise, for a picture that almost never changes.
- A waste collection card using a city's open data: the API catalog was unreachable, code removed. Only worth retrying if unauthenticated access comes back.
- Daily dev tips under the clock: removed, they took a line on the Overview for content tied to one person's stack.
