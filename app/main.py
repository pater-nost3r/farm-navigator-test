import logging
from contextlib import asynccontextmanager

import httpx
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.api import game, nasa
from app.config import get_settings
from app.models.responses import DISCLAIMER, HealthResponse
from app.services.nasa_power import NasaPowerService

logging.basicConfig(level=logging.INFO, format="%(levelname)s %(name)s: %(message)s")
# httpx logs full request URLs at INFO; keep them out of the logs.
logging.getLogger("httpx").setLevel(logging.WARNING)

settings = get_settings()


@asynccontextmanager
async def lifespan(app: FastAPI):
    async with httpx.AsyncClient() as client:
        app.state.nasa_service = NasaPowerService(settings, client)
        yield


app = FastAPI(
    title="Farm Navigator API",
    version="1.0.0",
    description=(
        "Backend for Farm Navigator, an educational farming game for the NASA Space Apps Challenge 2025. "
        "Climate data come from NASA POWER. " + DISCLAIMER
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
app.include_router(game.router)


@app.get("/api/health", response_model=HealthResponse, tags=["Health"])
async def health() -> HealthResponse:
    return HealthResponse()
