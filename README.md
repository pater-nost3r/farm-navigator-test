# Farm Navigator

An educational farming game for the NASA Space Apps Challenge. You pick a real farm location. The game
downloads the last 10 growing seasons recorded there by **NASA POWER** and replays them as 7 levels. Each season you
choose a crop, irrigation, fertilizer and soil protection. You then see the effect on yield, budget, water and soil,
with every result explained through the NASA data.

> NASA POWER data are **historical records of past seasons**, not a weather forecast. Farm Navigator uses a
> simplified, deterministic crop model. It is not a yield forecast or farming advice.

## Quick start

Requires Python 3.12 and Node.js 20 or newer.

```powershell
python -m venv .venv                     # or: uv venv --python 3.12 .venv
.venv\Scripts\activate                   # macOS/Linux: source .venv/bin/activate
pip install -r requirements-dev.txt
npm install                              # dev tools only: eslint, typescript, jsdom
uvicorn app.main:app --reload --port 8000
```

Open http://127.0.0.1:8000. The same server serves the game and the API.
Swagger UI: http://127.0.0.1:8000/docs.

If you open `farm-navigator.html` directly as a file, there is no API. The game says so and offers clearly labelled
demo data.

`.env` is optional (see `.env.example`). NASA POWER and the geocoder need no API key. `NASA_API_KEY` is never sent
to the frontend, returned or logged.

## Checks

| Command | What it does |
|---|---|
| `npm run lint` | ESLint for `js/`, `tests/`, `scripts/` |
| `npm run typecheck` | TypeScript `checkJs` on the game engine and data client (JSDoc types) |
| `npm test` | Node tests: engine, data client, translations, jsdom UI playthrough of all 7 levels |
| `npm run build` | Production build into `dist/` |
| `npm run check` | All four above |
| `ruff check .` · `mypy` · `pytest` | Python lint, typecheck, tests |

## Architecture

```
farm-navigator.html   page: markup, CSS, EN/RU translations, language/theme prefs
js/engine.js          game engine: pure, deterministic, no DOM (levels, formulas, What If, scoring, progress)
js/nasa-client.js     data client: calls OUR backend, localStorage cache, Live/Cached/Demo, timeouts, offline
js/app.js             UI controller: screens, rendering, events
app/                  FastAPI backend
  api/nasa.py         GET /api/nasa/climate, GET /api/nasa/conditions
  api/geocode.py      GET /api/geocode (city → coordinates)
  api/game.py         earlier stateful 3-season API (kept, unchanged)
  services/nasa_power.py  NASA POWER client, per-season aggregation, TTL cache
  services/geocoding.py   Open-Meteo geocoding client
api/index.py          Vercel serverless entry (imports app.main:app)
scripts/build.mjs     static build → dist/
tests/                Node tests + real NASA POWER fixtures (6 locations)
app/tests/            pytest
```

The browser never calls NASA directly. Data flow:
**browser → `/api/nasa/climate` → NASA POWER**.

Results are cached in three layers:
1. Server memory, with a 24 h TTL.
2. The CDN, via `Cache-Control: s-maxage=86400` (past seasons never change).
3. The browser's localStorage: used without a network request for 7 days, and as a fallback when offline.

### Data status shown in the game

| Badge | Meaning |
|---|---|
| **Live · NASA POWER** | Downloaded from NASA POWER for this request |
| **Cached** | Real NASA POWER data from the server cache or this browser (stale copies say so) |
| **Demo data** | Illustrative values the player chose when no data were available; never presented as real |

Error states (each with **Try again**, **Play with demo data** and **Change location**):
- offline
- NASA timeout (504)
- NASA unavailable (502)
- server unreachable
- no game server (page opened as a file)
- unexpected data

## NASA data sources

**NASA POWER** daily point API, `community=AG`:
`https://power.larc.nasa.gov/api/temporal/daily/point?parameters=T2M,PRECTOTCORR,RH2M,WS2M,ALLSKY_SFC_SW_DWN&community=AG&latitude=…&longitude=…&start=YYYYMMDD&end=YYYYMMDD&format=JSON`

| Parameter | Meaning | Used for |
|---|---|---|
| `T2M` | Air temperature at 2 m, °C | crop temperature range, water demand, heat events, hot days |
| `PRECTOTCORR` | Corrected precipitation, mm/day | rain supply, runoff, leaching, erosion, drought/downpour events, reservoir refill |
| `RH2M` | Relative humidity at 2 m, % | water demand (dry air), fungal disease risk |
| `WS2M` | Wind speed at 2 m, m/s | water demand, sprinkler losses, wind erosion |
| `ALLSKY_SFC_SW_DWN` | All-sky surface shortwave radiation, MJ/m²/day | photosynthesis limit, water demand |

How the data are prepared:
- **One request** covers the 10 most recent complete growing seasons: May–Aug in the northern hemisphere,
  Nov–Feb in the southern.
- A season counts only if it ended at least 14 days ago, because POWER publishes with a short delay.
- `-999` fill values are skipped. A season with more than 20% missing values is dropped.
- Daily values become per-season means. Rain is summed, and the total is rescaled if a few days are missing.
- Derived per season: heavy-rain days (≥ 20 mm), hot days (daily mean ≥ 25 °C) and the longest dry spell (< 1 mm).
- The mean of the 10 seasons is the "normal" each season is compared with.

**Limitation:** POWER values describe a grid cell tens of kilometres wide, built from satellites and reanalysis
models. They are not field measurements.

City search uses the **Open-Meteo Geocoding API** (GeoNames, no key). Coordinates can also be entered by hand, and six
example farms work without it.

## Levels

Each level replays real seasons chosen from the location's 10-season record: the most *typical*, *driest*, *hottest*
or *wettest*, or the most *recent*. When a level has several seasons they are distinct and in chronological order.
Levels unlock in order. Best results are saved in localStorage (`farm-navigator.progress.v1`).

| # | Level | Seasons | Start | Goal (all must be met) |
|---|---|---|---|---|
| 1 | First Harvest | typical | $6,000, water 100% | average yield ≥ 60% |
| 2 | Water Shortage | driest | $6,000, water 35% | yield ≥ 50%, reserve ≥ 5 at the end |
| 3 | Depleted Soil | 2 recent | $7,000, N 15, after wheat → wheat | soil fertility +10, yield ≥ 45% |
| 4 | Heatwave | hottest | $6,000, water 70% | yield ≥ 60% |
| 5 | Season of Downpours | wettest | $6,000, water 80% | yield ≥ 55%, erosion ≤ +5, N leached ≤ 10 kg |
| 6 | Economic Crisis | 2 recent | $2,200 | finish with ≥ $3,000 |
| 7 | Climate Challenge | driest + hottest + wettest | $5,000, water 60% | yield ≥ 55%, no season < 30%, fertility ≥ start, budget ≥ $5,000 |

- **Lose:** miss a goal, or end a season with less than $800 (not enough to buy seed = bankrupt).
- **Stars (1–3, only when the level is passed):** one per category met.
  - Yield: average yield above the level's threshold.
  - Water saving: water score ≥ 70 (65 in level 7).
  - Soil health: fertility change at or above the level's threshold.
- The tests check that every level is winnable at all 6 real fixture locations and the demo data, and that careless
  play fails most level/location pairs.

## Game model (`js/engine.js`)

All formulas are deterministic, with no randomness. The constants are in `MODEL`, `CROPS`, `IRRIGATION`,
`FERTILIZERS`, `PROTECTION` and `LEVELS`.

- **Water demand (mm)** = crop need × weather factor × days/123 × protection factor.
  - Weather factor = 1 + 0.025·(T−20) + 0.004·(60−RH) + 0.04·(WS−2) + 0.01·(SW−20), clamped to 0.7–1.6.
  - Protection factor: mulch 0.92, cover strips 1.03.
- **Water supply** = rain − runoff + stored soil water (moisture% × 120 mm) + irrigation × (1 − loss).
  - Runoff = 10 mm per heavy-rain day × (1 − protection), capped at 40% of rain.
  - Loss: sprinkler 8–30% (grows with heat and wind), drip 5%.
- **Water score** = 100 inside supply/demand 0.95–1.45.
  - Below that, it drops by (180 − 120 × drought tolerance) per unit of deficit.
  - Above that, waterlogging penalties apply.
- **Nitrogen:** available = 0.6 × soil N + fertilizer N − leaching.
  - Leaching share = 0.04 × heavy-rain days + 0.5 × max(0, ratio − 1.2), up to 60%.
  - Synthetic N leaches fully, compost at 20%, green manure at 30%.
  - Chickpea fixes 30 kg × yield.
- **Temperature:** −8 points per °C above the crop's range, −6 per °C below it.
- **Light:** −5 points per MJ below 15 MJ/m²/day.
- **Rotation and disease:**
  - Planting the same crop again adds +25 disease risk (+10 for a third time, +10 for a legume after a legume).
  - The same crop family adds +8. Humid, warm air (RH > 70%, T > 18 °C) adds +15. Waterlogging adds +10.
  - Yield loss = (risk − 20) × 0.5.
  - A cereal after a legume gets a +6 bonus. Any other rotation gets +2.
- **Yield %** = 0.45 water + 0.25 nitrogen + 0.2 temperature + 0.1 light + rotation bonus − disease + (fertility − 50)/5.
- **Soil after the season:**
  - Moisture follows the water balance.
  - Nitrogen: + fertilizer + fixation + mineralisation − uptake − leaching.
  - Organic matter: + compost/green manure/protection − decomposition − erosion.
  - Erosion: + heavy rain × crop cover × (1 − protection) + wind erosion − recovery.
- **Fertility** = 0.4 N + 0.35 organic matter + 0.25 (100 − erosion).
- **Money and water:**
  - Cost = seed + irrigation + drip + fertilizer + protection. A plan is refused if it costs more than the budget,
    so the budget never goes negative.
  - Revenue = crop price × yield %.
  - Reserve refill = rain ÷ 12 (max 35). Irrigation is refused if the reserve is too small, and the reserve is kept
    within 0–100.
- **Events** are flagged from the data compared with the 10-season normal:
  - Drought: rain ≤ 70% of normal, or < 25 mm per 30 days.
  - Heat: ≥ 1 °C above normal, or ≥ 28 °C.
  - Downpours: ≥ 5 heavy-rain days, or rain ≥ 135% of normal.
  - Water deficit: drought or heat while the reserve is below 40%.
- **Best alternative and What If:** a beam search (width 12) over all 336 decision combinations for the remaining
  seasons, ranked by the level's goals, stars, score and profit. What If simulates any alternative for the same season
  without touching saved progress.

## Deploy to Vercel

`vercel.json` builds the static game with `node scripts/build.mjs` (no npm install needed) into `dist/`. It deploys
`api/index.py` as a Python serverless function that runs FastAPI; `requirements.txt` holds the runtime dependencies.
Every `/api/*` request is rewritten to that function. `.vercelignore` keeps `.env`, virtual environments and tests
out of the upload.

```bash
npm i -g vercel && vercel        # then: vercel --prod
```

Optional environment variables in the Vercel project:
- `NASA_TIMEOUT_SECONDS` (default 20)
- `CACHE_TTL_SECONDS` (default 86400)
- `CORS_ORIGINS` (only needed if the frontend is hosted on another origin; set `window.FARM_API_BASE` in that case)

## Other API endpoints

The earlier stateful 3-season API still works. It keeps games in server memory, so it suits local use and is not
used by the level-based game:
- `POST /api/game/start`
- `POST /api/game/decision`
- `GET /api/game/{id}`
- `POST /api/game/{id}/next-season`
- `GET /api/game/{id}/results`

Its formulas are in `app/services/game_engine.py`.
