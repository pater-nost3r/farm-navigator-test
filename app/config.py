"""Application settings loaded from environment variables (and an optional .env file).

The NASA API key is read from NASA_API_KEY only. It is never sent to the
frontend, never included in responses and never logged.
"""

import os
from dataclasses import dataclass, field
from functools import lru_cache
from pathlib import Path

from dotenv import load_dotenv

PROJECT_ROOT = Path(__file__).resolve().parent.parent

load_dotenv(PROJECT_ROOT / ".env")

DEFAULT_CORS_ORIGINS = (
    "http://localhost:3000",
    "http://127.0.0.1:3000",
    "http://localhost:4321",
    "http://127.0.0.1:4321",
    "http://localhost:5173",
    "http://127.0.0.1:5173",
    "http://localhost:8000",
    "http://127.0.0.1:8000",
)


@dataclass(frozen=True)
class Settings:
    # repr=False keeps the key out of tracebacks and debug output.
    nasa_api_key: str | None = field(default=None, repr=False)
    nasa_power_base_url: str = "https://power.larc.nasa.gov/api/temporal/daily/point"
    nasa_timeout_seconds: float = 20.0
    geocoding_base_url: str = "https://geocoding-api.open-meteo.com/v1/search"
    geocoding_timeout_seconds: float = 8.0
    # Historical NASA POWER seasons do not change, so results can be cached for a day.
    cache_ttl_seconds: float = 24 * 3600
    cors_origins: tuple[str, ...] = DEFAULT_CORS_ORIGINS


def _parse_origins(raw: str | None) -> tuple[str, ...]:
    if not raw:
        return DEFAULT_CORS_ORIGINS
    return tuple(origin.strip() for origin in raw.split(",") if origin.strip())


@lru_cache
def get_settings() -> Settings:
    return Settings(
        nasa_api_key=os.getenv("NASA_API_KEY") or None,
        nasa_power_base_url=os.getenv("NASA_POWER_BASE_URL", Settings.nasa_power_base_url),
        nasa_timeout_seconds=float(os.getenv("NASA_TIMEOUT_SECONDS", Settings.nasa_timeout_seconds)),
        geocoding_base_url=os.getenv("GEOCODING_BASE_URL", Settings.geocoding_base_url),
        cache_ttl_seconds=float(os.getenv("CACHE_TTL_SECONDS", Settings.cache_ttl_seconds)),
        cors_origins=_parse_origins(os.getenv("CORS_ORIGINS")),
    )
