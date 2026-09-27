import logging
from contextlib import asynccontextmanager

import httpx
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

from app.api import game, geocode, nasa
from app.config import PROJECT_ROOT, get_settings
from app.models.api import DISCLAIMER, HealthResponse
from app.services.geocoding import GeocodingService
from app.services.nasa_power import NasaPowerService

logging.basicConfig(level=logging.INFO, format="%(levelname)s %(name)s: %(message)s")
# httpx logs full request URLs at INFO; keep them out of the logs.
logging.getLogger("httpx").setLevel(logging.WARNING)

settings = get_settings()

FRONTEND_PAGE = PROJECT_ROOT / "farm-navigator.html"
FRONTEND_JS = PROJECT_ROOT / "js"


@asynccontextmanager
async def lifespan(app: FastAPI):
    async with httpx.AsyncClient() as client:
        app.state.nasa_service = NasaPowerService(settings, client)
        app.state.geocoding_service = GeocodingService(settings, client)
        yield


app = FastAPI(
    title="Farm Navigator API",
    version="2.0.0",
    description=(
        "Backend for Farm Navigator, an educational farming game for the NASA Space Apps Challenge. "
        "Climate data come from NASA POWER (historical, not a forecast). " + DISCLAIMER
    ),
    lifespan=lifespan,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=list(settings.cors_origins),
    allow_methods=["GET", "POST"],
    allow_headers=["Content-Type"],
)

app.include_router(nasa.router)
app.include_router(geocode.router)
app.include_router(game.router)


@app.get("/api/health", response_model=HealthResponse, tags=["Health"])
async def health() -> HealthResponse:
    return HealthResponse()


# The game is served from the same origin as the API, locally and on Vercel
# (Vercel promotes the /js mount to its CDN).
if FRONTEND_PAGE.exists():

    @app.get("/", include_in_schema=False)
    async def index() -> FileResponse:
        return FileResponse(FRONTEND_PAGE, media_type="text/html; charset=utf-8")

if FRONTEND_JS.is_dir():
    app.mount("/js", StaticFiles(directory=FRONTEND_JS), name="js")
