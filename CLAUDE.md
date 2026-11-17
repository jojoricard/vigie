# CLAUDE.md

## What this is

A dashboard for a vertical screen, 100 % local, Windows only, no npm dependency and no build.

- `agent.js`: Node server entry point (`http.createServer`, no framework): config, routes, scheduled jobs
- `lib/`: the agent's logic, one CommonJS module per topic. `context.js` holds the runtime state (config, database) filled at startup, so the pure functions can be imported by the tests
- `public/`: the page, `index.html` + `style.css` + ES modules in `public/js/` (`main.js` is the entry point, `icons.js` the SVG icons, `sun.js` the solar elevation, `plan.js` the pure part of the floor plan, `furniture.js` the library of furniture types, `plan3d.js` its drawing). `public/vendor/three/` is three.js at a pinned version, the only third-party code: `public/js/` stays flat, a test reads every entry of it
- `house/`: the house service (`/api/v1`), one driver per integration in `house/drivers/`, mounted in the agent
- `scripts/`: `check-scroll.js` and `shots.js`, headless Chrome on the demo data (no npm)
- `test/`: `node:test` tests on the pure functions and the translations

## Commands

```bash
node agent.js          # starts the server (http://localhost:5252)
node --test            # runs the tests
node agent.js --demo --port=5299      # the page on made-up data, no network, no device
node scripts/check-scroll.js          # nothing scrolls: every tab, sub-view and panel at nine sizes (one size: 1080x1920)
node scripts/shots.js docs/tabs       # the screenshots of the README, from the demo
```

- `start-dashboard.bat`: starts LHM, the agent in the background and Chrome in kiosk mode. Machine-specific settings (`POS_X`, `POS_Y`, `LHM_PATH`, `BROWSER`) go in `start-dashboard.local.bat`, ignored by git.
- `stop-dashboard.bat`: stops the agent and the kiosk Chrome.
- `detect-monitors.ps1`: prints the position of each screen.
- To check a change: `node --test`, `node scripts/check-scroll.js` when a tab or a panel changed, restart `node agent.js` and reload `http://localhost:5252`. CI (GitHub Actions) runs a syntax check of every file and the tests.

`config.json` (ignored by git, start from `config.example.json`) holds the language, country, cities, snow spots, warning areas, network target, tools hub, electricity price, theme, dimming, night mode, alert thresholds, the house and API keys. Node 22.13+ is required (`node:sqlite`).

## Architecture

The page calls Open-Meteo directly for weather and air quality. Everything else goes through the agent, on the same origin. Routes are two tables (`GET`, `POST`) in `agent.js`. Routes that act (`/open`, `/briefing`) are POST only and check `Origin`. Everything under `/api/v1` belongs to the house service (`house/`, see `house/API.md`): a service of its own, mounted in the agent, that must not import anything from `lib/`. Only the files of `public/` are served, through a table built at startup.

The floor plan of a real home is private and this repository is public: it lives outside the repository (`house.planPath`) and is only served by `GET /api/v1/plan`. Never put a plan, a real dimension or a capture of a real plan in the repository. `house/demo/` holds a made-up flat for the tests and the screenshots. A device appears on the plan through an anchor in the plan file, not through code. Furniture is the same: a type of `furniture.js` with parameters, instanced in the private plan. No product name, no photo and no real layout in the repository.

### Errors

External failures are typed: `SourceError` in `lib/errors.js` (agent), `FetchError` in `public/js/core.js` (page). Catch only those, let anything else propagate. Use `orNull()` on the agent and `load()` on the page for a source whose absence just hides a card. The only catch-alls are the HTTP 500 handler and the job scheduler in `agent.js`.

### Languages

All on-screen text lives in `I18N` in `public/js/i18n.js`, with the same keys in `en` and `fr` (a test checks it). The agent sends codes and figures, never sentences. A new text means a new key in both languages.

### Storage

- `vigie.db`: `samples` every 30 s (kept 30 days), `daily` one row per day (never purged), `disk` hourly free space.
- Never use `INSERT OR REPLACE` on `daily`: it resets to `NULL` the columns missing from the query. The code uses `ON CONFLICT … DO UPDATE` column by column.
- `backups/`: one copy of `vigie.db` per day, the last 7 (ignored by git).
- `.briefing.json` and `.batteries.json`: generated caches.

### Derived diagnostics

- **Freeze or power cut** (`lib/crash.js`): the end of the samples is compared with the shutdown time in the Windows log. 120 s of silence or more: freeze. 75 s or less: power cut. In between: undetermined.
- **What changed** (`lib/changes.js`): always the median, a relative threshold and a minimum absolute gap, a minimum number of samples on both sides. Thermal drift only uses samples at 50 % load or more and is stated without a diagnosis.

### Tabs

Six tabs: Overview, Weather, House, Energy, Machine, Tools. They only show or hide `div.tabPane` (attribute `hidden`).

**Nothing ever scrolls, and nothing stays empty**, on any tab, at any size, detail panels included. A tab is a box with `data-fit` whose children are `.block` elements, laid out by `public/js/fit.js`: `data-prio` (1 must stay, 2 useful, 3 optional, 4 an extra that only comes once every other block is at its richest), `data-rich` (the block has a rich look, `.rich` in the CSS), `data-grow` (its content scales and takes the room left, `data-hmax` its ceiling), `data-c2`/`data-c3` (its column on a wide screen), `data-view` (a named sub-view; a block without it belongs to the main view). Inside a block, `.compactOnly`, `.fullOnly` (hidden when compact) and `.richOnly` choose what each look shows. The engine starts from the minimum and grows blocks by priority while they fit (normal looks, optional blocks back, rich looks, extras), folds back the same way, shortens lists (`data-rows`, never in the middle of a row), then pages the box; the room left becomes spacing between blocks, never empty space inside a card. A new block needs a priority and a compact look in `style.css`; anything else (a fixed height, `overflow: auto`, a card stretched to fill) breaks the rule. Draw the content first (with `put(el, html)` from `core.js`, which writes only what changed), then call `queueFit()`: a box is only refitted when its size changed or a block's height did. `scripts/check-scroll.js` must pass: it also fails on a view more than 12 % empty while a block could be richer, on a card with an empty zone over 15 % of the screen, on a plan where the home covers less than 85 % of the side that limits it or whose card moves when the model turns, and on uneven gaps between the blocks of the Overview. `scripts/perf.js` must pass too: nothing on the page may run in a loop at rest (an animation only with the window in front, at 15 images a second at most, never at night).

Detail panels go through `public/js/panel.js` (`openPanel({ head, tabs, body })`), which fits them the same way, with inner tabs.

Alerts are one engine, on the page (`public/js/alerts.js`): a new alert is a rule in `collect()`, never a banner of its own. Thresholds are `RULES`, overridden by `alerts` in the config.

`window.vigie` is a test hook (tabs, sub-views, panels) used by the scripts: keep it working when a tab changes.

### House modules

Devices are driven over the local network only. Each integration is a module (`MODULES` in `house/server.js`): local ones are `ready` until their settings exist, the ones that need an account are optional, `disabled` by default and labelled as such. A module without settings must open nothing and show nothing. No automation runs in the service: programs live in the devices, the PC is not always on. New drivers are tested on simulated answers (`test/house-modules.test.js`), never against a real cloud.

### Look

The palette derives from `theme.color` (config) through OKLCH relative colors at the top of `style.css`: change `--theme`, not each color. Icons are SVG from `public/js/icons.js`, never emoji. Red, orange and green are for states only. Three sizes of type per block at most.

## Before changing a card

`docs/NOTES.md` explains why each non-trivial card is built the way it is, including ideas already discarded. Read it rather than rederiving those rules from the code.

## Style

Short comments that explain why, never what. No em dash, no emoji in the interface. Show or hide with `hidden`, keep inline styles for data-driven values only (colors, sizes).
