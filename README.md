# Farm Navigator

Educational farming game about using NASA Earth data (NASA Space Apps Challenge 2025).
The player manages a farm for three seasons, choosing a crop, irrigation level and fertilizer.
Real NASA POWER climate data determine the outcome, and every result is explained.

> Farm Navigator uses a simplified, deterministic crop model. It is **not** an agronomic
> forecast or farming advice.

## Backend (FastAPI)

### Setup

Requires Python 3.12.

```powershell
python -m venv .venv            # or: uv venv --python 3.12 .venv
.venv\Scripts\activate          # macOS/Linux: source .venv/bin/activate
pip install -r requirements.txt
copy .env.example .env          # macOS/Linux: cp .env.example .env
```

Put your key in `.env` (`NASA_API_KEY=...`). `.env` is git-ignored. The key is never
sent to the frontend, returned in responses or logged. NASA POWER is a public API and
does not need the key, so it is only kept for other official NASA APIs.

Optional settings in `.env`: `NASA_TIMEOUT_SECONDS` (default 20), `CORS_ORIGINS`
(comma-separated; defaults to localhost ports 3000, 4321 and 5173).

### Run

```powershell
uvicorn app.main:app --reload --port 8000
```

- Swagger UI: http://127.0.0.1:8000/docs
- ReDoc: http://127.0.0.1:8000/redoc

### Tests

```powershell
pytest -q app/tests
```

### Endpoints

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/health` | Health check |
| GET | `/api/nasa/conditions?latitude&longitude&start_date&end_date` | Aggregated NASA POWER conditions |
| POST | `/api/game/start` | New game, loads season 1 conditions |
| POST | `/api/game/decision` | Crop, irrigation and fertilizer choice for the current season |
| GET | `/api/game/{game_id}` | Full game state and history |
| POST | `/api/game/{game_id}/next-season` | Next season with new NASA conditions |
| GET | `/api/game/{game_id}/results` | Scores and lessons |

Every data response includes `data_source`/`source`, `period`, `is_demo` and `limitations`.

Example game:

```bash
curl -X POST http://127.0.0.1:8000/api/game/start -H "Content-Type: application/json" \
  -d '{"location":{"name":"Almaty","latitude":43.24,"longitude":76.95},"difficulty":"normal"}'
curl -X POST http://127.0.0.1:8000/api/game/decision -H "Content-Type: application/json" \
  -d '{"game_id":"<id>","crop":"wheat","irrigation":"medium","fertilizer":"organic"}'
curl -X POST http://127.0.0.1:8000/api/game/<id>/next-season
curl http://127.0.0.1:8000/api/game/<id>/results
```

### How it works

- **Data:** NASA POWER daily point API (`community=AG`), parameters `T2M`, `PRECTOTCORR`,
  `RH2M`, `WS2M`, `ALLSKY_SFC_SW_DWN`. Daily values are averaged (rain is summed), and
  `-999` fill values are skipped.
- **Seasons:** seasons 1–3 are the three most recent complete growing seasons at the location
  (May–Aug in the northern hemisphere, Nov–Feb in the southern), so data are always complete.
- **Fallback:** if NASA POWER times out or fails, illustrative values from
  `app/data/fallback_conditions.json` are used and marked `is_demo: true`.
- **Rules:** all formulas are in `app/services/game_engine.py`; crop profiles are in
  `app/data/crops.json`.
- **Storage:** games are kept in server memory (MVP) and are lost when the server restarts.

### Data limitations

NASA POWER values are regional grid-cell estimates (tens of kilometres) from satellites and
reanalysis models, not field measurements. A cell that includes mountains can be much cooler
than a nearby city (e.g. the Almaty cell averages ≈12 °C in summer).

## Frontend prototype

Open `farm-navigator.html` in any browser, or serve it locally:

```bash
node -e "require('http').createServer((q,s)=>require('fs').readFile('farm-navigator.html',(e,d)=>{s.writeHead(200,{'Content-Type':'text/html; charset=utf-8'});s.end(d)})).listen(4321)"
```

Then open http://localhost:4321 (this origin is allowed by the backend CORS settings).

Review shortcuts: add `#loading`, `#error`, `#tutorial`, `#drought`, `#overwater`,
`#lownutrients`, `#harvest`, `#failed`, `#report`, `#final-win` or `#final-fail` to the URL.

### Deploy to Vercel

`vercel.json` deploys only the static game: Next.js detection is disabled and the build copies
`farm-navigator.html` to `dist/index.html`. `.vercelignore` keeps `.env` and the Python backend
out of the upload. The FastAPI backend has to be hosted separately.

## Other files

`package.json`, `next.config.mjs`, `jsconfig.json` — unfinished Next.js setup for the
CropCycle NASA project (run `npm install` to restore dependencies).
