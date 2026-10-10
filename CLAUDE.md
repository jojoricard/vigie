# CLAUDE.md

## What this is

A dashboard for a vertical screen, 100 % local, Windows only, no npm dependency and no build.

- `agent.js`: Node server entry point (`http.createServer`, no framework): config, routes, scheduled jobs
- `lib/`: the agent's logic, one CommonJS module per topic. `context.js` holds the runtime state (config, database) filled at startup, so the pure functions can be imported by the tests
- `public/`: the page, `index.html` + `style.css` + ES modules in `public/js/` (`main.js` is the entry point, `icons.js` the SVG icons, `sun.js` the solar elevation)
- `test/`: `node:test` tests on the pure functions and the translations

## Commands

```bash
node agent.js          # starts the server (http://localhost:5252)
node --test            # runs the tests
```

- `start-dashboard.bat`: starts LHM, the agent in the background and Chrome in kiosk mode. Machine-specific settings (`POS_X`, `POS_Y`, `LHM_PATH`, `BROWSER`) go in `start-dashboard.local.bat`, ignored by git.
- `stop-dashboard.bat`: stops the agent and the kiosk Chrome.
- `detect-monitors.ps1`: prints the position of each screen.
- To check a change: `node --test`, restart `node agent.js` and reload `http://localhost:5252`. CI (GitHub Actions) runs a syntax check of every file and the tests.

`config.json` (ignored by git, start from `config.example.json`) holds the language, country, cities, snow spots, warning areas, network target, tools hub, electricity price, theme, dimming and API keys. Node 22.13+ is required (`node:sqlite`).

## Architecture

The page calls Open-Meteo directly for weather and air quality. Everything else goes through the agent, on the same origin. Routes are two tables (`GET`, `POST`) in `agent.js`. Routes that act (`/open`, `/briefing`, `/house/*`) are POST only and check `Origin`. Only the files of `public/` are served, through a table built at startup.

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

Tabs only show or hide `div.tabPane` (attribute `hidden`). The Overview must fit on one screen without scrolling, in portrait and in landscape: anything added there costs something removed, new cards go to Weather, Machine or Tools.

The Overview's three `.col` groups sit side by side in landscape and melt into one column in portrait (`display: contents` plus `order` in `style.css`). A card moved there must find its place in both. `fitToScreen()` in `main.js` zooms the page so the Overview fills the screen: measure with `getBoundingClientRect`, the only size that includes the zoom.

### Look

The palette derives from `theme.color` (config) through OKLCH relative colors at the top of `style.css`: change `--theme`, not each color. Icons are SVG from `public/js/icons.js`, never emoji.

## Before changing a card

`docs/NOTES.md` explains why each non-trivial card is built the way it is, including ideas already discarded. Read it rather than rederiving those rules from the code.

## Style

Short comments that explain why, never what. No em dash, no emoji in the interface. Show or hide with `hidden`, keep inline styles for data-driven values only (colors, sizes).
