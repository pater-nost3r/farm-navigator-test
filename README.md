# Farm Navigator

An educational farming strategy game built on **real historical NASA POWER daily weather**.

You set up a virtual farm: a real place (a ready-made region, a city search or coordinates), a growing period and a
soil type. The server downloads the daily NASA POWER series for that point and calendar window in each of the last 20
complete years. You then play 7 levels. In each season you choose four things:
- a crop;
- an irrigation system;
- how much water to use;
- a soil-care practice.

The server simulates the season day by day, deterministically, and reports the results with their causes:
- yield;
- money;
- water reserve;
- soil state.

> NASA POWER data are **historical records** for a regional grid cell, not measurements at a field and not a forecast.
> The soil type, nitrogen, organic matter, erosion, prices, costs and yields are **game-model values**. Farm Navigator
> is not a yield forecast or farming advice.

## Quick start

Requires Python 3.12 and Node.js 20 or newer.

```powershell
python -m venv .venv                     # or: uv venv --python 3.12 .venv
.venv\Scripts\activate                   # macOS/Linux: source .venv/bin/activate
pip install -r requirements-dev.txt
npm install                              # dev tools only: eslint, typescript, jsdom
uvicorn app.main:app --reload --port 8000
```

Open http://127.0.0.1:8000. The same server serves the game and the API; Swagger UI is at
http://127.0.0.1:8000/docs.

The game needs its server: every season is simulated there. Opened as a plain file, the page shows a "no game server"
screen with the request URL.

A page served by a local static server (VS Code Live Server on :5500, Vite on :5173…) calls uvicorn on the same host
at :8000, so keep `uvicorn app.main:app --port 8000` running. Another API address can be set with
`<meta name="farm-api-base" content="https://…">` or `window.FARM_API_BASE`, plus `CORS_ORIGINS` on the server.

`.env` is optional (see `.env.example`). NASA POWER and the geocoder need no key, and `NASA_API_KEY` is never sent
anywhere.

## Checks

| Command | What it does |
|---|---|
| `npm run lint` | ESLint for `js/`, `tests/`, `scripts/` |
| `npm run typecheck` | TypeScript `checkJs` on `js/rules.js` and `js/nasa-client.js` |
| `npm test` | Node tests: API client, UI rules, translations, and jsdom integration tests described below |
| `npm run build` | Production build into `dist/` |
| `npm run check` | All four above |
| `ruff check .` · `mypy` · `pytest` | Python lint, typecheck, tests (weather, POWER client, engine, API) |

The integration tests in `tests/ui.test.mjs` work like this:
- They start the real FastAPI server with the project's Python and point `NASA_POWER_BASE_URL` to a fake POWER
  endpoint.
- They play the page by clicking.
- They are skipped, with a message, if Python with the backend requirements is not installed.

## Architecture

```
farm-navigator.html        page: markup, CSS, EN/RU translations, language/theme preferences
js/nasa-client.js          API client: timeouts, one retry, typed errors (offline/timeout/nasa/server/no-backend)
js/rules.js                interface rules from the server config: required decisions, plan cost, progress
js/app.js                  UI controller: screens, rendering, events (no game simulation in the browser)
app/data/game_model.json   ALL rules and coefficients (crops, soils, irrigation, care, thresholds, levels)
app/services/nasa_power.py NASA POWER client: retry with deadline, memory + disk cache, stale fallback
app/services/weather.py    daily series → seasons: gaps, features, FAO-56 ET0, reference, anomalies, season names
app/services/climate.py    20-year archive for one point and window; provenance
app/services/engine.py     authoritative game engine: daily water balance, soil, economy, levels, What If
app/api/nasa.py            GET /api/nasa/archive
app/api/game.py            GET /api/game/config, POST /api/game/start | turn | what-if
app/api/geocode.py         GET /api/geocode (city → coordinates, Open-Meteo)
api/index.py               Vercel serverless entry (imports app.main:app)
docs/MODEL.md              the game model, every formula, threshold and assumption
```

**Data flow:** browser → our API → NASA POWER. The browser never calls NASA directly.

**The server is authoritative.** Game requests are stateless:
- Each request carries the farm, the start year and all decisions so far.
- The server replays them from the level start with the same NASA data.
- So budget, water and soil can only change through the published rules.

The server validates everything again:
- every decision is required;
- the plan must fit the budget, with the water bill reserved at its maximum;
- irrigating with an empty reserve is refused.

Budget and reserve therefore never go negative. The interface runs the same checks from the same config first.

## NASA POWER

Daily Point API, one request per point and window, with the parameters, units and fill value checked against the
response metadata:

```
https://power.larc.nasa.gov/api/temporal/daily/point?parameters=T2M,T2M_MAX,T2M_MIN,PRECTOTCORR,RH2M,WS2M,ALLSKY_SFC_SW_DWN&community=AG&latitude=…&longitude=…&start=YYYYMMDD&end=YYYYMMDD&format=JSON&time-standard=LST
```

| Parameter | Units (from the response) | Used for |
|---|---|---|
| `T2M` | C | mean temperature, organic-matter decay, mineralisation |
| `T2M_MAX` / `T2M_MIN` | C | degree days (maturity), heat stress, frost, hot days, ET0 |
| `PRECTOTCORR` | mm/day | rain, downpours, dry spells, runoff, drainage, leaching, erosion, reserve refill |
| `RH2M` | % | ET0, leaf-disease risk |
| `WS2M` | m/s | ET0, sprinkler losses, wind erosion |
| `ALLSKY_SFC_SW_DWN` | MJ/m^2/day | ET0, light limit |

**Time standard.** `time-standard=LST` (local solar time) is used for every request.

**Missing data.**
- `-999` and missing days are reported as gaps.
- A season with more than 10 % missing values in a required parameter is incomplete and cannot be played; the API
  suggests a complete year.
- A missing optional parameter switches off the mechanics that depend on it, and ET0 falls back to Hargreaves. The
  source is labelled.
- If a parameter's units differ from the expected ones, it is treated as unavailable.

**Recent years.** If the chosen window has not ended at least 7 days ago, that year is not offered. The API suggests
the latest complete season.

**Hemispheres.** Season names follow the hemisphere: June–August is summer in the north and winter in the south. Near
the equator the season is called "tropical".

**What each response carries:**
- parameters with units and long names;
- coordinates and the cell elevation;
- dates;
- time standard and community;
- status `live` / `cached` / `demo` and the `stale` flag;
- fetch time;
- the full request URL;
- per-season gaps.

**Cache and fallback** (`app/services/nasa_power.py`):
1. A fresh cache entry in memory or on disk (default 30 days) is used first → `cached`.
2. Otherwise NASA POWER is called, with a 15 s timeout per attempt, 2 retries with backoff and a 24 s deadline →
   `live`, and the result is cached.
3. If POWER fails, an expired cache entry is used → `cached` + `stale`.
4. With no cache at all, the API returns 502/504. The game shows the error with *Try again*. Demo mode (synthetic,
   labelled) starts only when the player chooses it.

On Vercel the disk cache lives in `/tmp` while the instance is warm.

## Levels

Every level has:
- a goal;
- a starting state;
- an allowed weather situation;
- win and lose conditions;
- three star criteria: yield, water saving and soil health.

The player chooses the year among those that fit. The rules are in `app/data/game_model.json` and summarised in
[docs/MODEL.md](docs/MODEL.md).

| # | Level | Seasons | Weather situation |
|---|---|---|---|
| 1 | First harvest | 1 | any |
| 2 | Water shortage | 1 | dry: rain ≤ 80 % of the same window's reference |
| 3 | Depleted soil | 2 in a row | any |
| 4 | Hot season | 1 | ≥ 20 days with T2M_MAX ≥ 30 °C (game threshold) |
| 5 | Downpour season | 1 | ≥ 3 days ≥ 20 mm, or rain ≥ 125 % of the reference |
| 6 | Economic crisis | 2 in a row | any; prices −20 %, costs +15 % |
| 7 | Climate challenge | 3 in a row | any |

"Anomalous" (hotter, drier, wetter than usual) is shown only after comparing the season with the other years of the
same point and window, and only if at least 8 years are available.

The best result per level is stored in the browser. Passing a level unlocks the next one, and every level can be
replayed.

## What If and reports

**What If.** After each season the server replays it with exactly **one** decision changed. The starting field state
and the NASA weather stay the same. It picks alternatives by stated criteria:
- saves water with yield within 5 pp;
- more crop from the same water;
- higher yield;
- better soil with yield within 10 pp;
- more profit.

It never calls one strategy best for every goal. The player can also try any single change.

**Season report.** Each report shows:
- the period and data status;
- the decisions;
- resource changes;
- a daily chart of rain, irrigation and root-zone water;
- every cause labelled **NASA data / Your decision / Model / Assumption**, with the yield points it cost;
- the model's limitations.

**Level and farm reports** add goals, stars, totals and data provenance, and can be exported as JSON.

## Deploy to Vercel

`vercel.json` works as follows:
- It builds the static game with `node scripts/build.mjs` into `dist/`.
- It deploys `api/index.py` (FastAPI) as a Python function, including `app/**` with `game_model.json`.
- It rewrites `/api/*` to that function.

`.vercelignore` keeps `.env`, virtual environments and tests out of the upload.

Optional environment variables:
- `NASA_TIMEOUT_SECONDS` (default 15)
- `NASA_RETRIES` (default 2)
- `NASA_DEADLINE_SECONDS` (default 24)
- `CACHE_TTL_SECONDS` (default 30 days)
- `CACHE_DIR`
- `CORS_ORIGINS`
