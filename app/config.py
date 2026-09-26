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
    # One attempt; retries use exponential backoff, all inside the overall deadline
    # (Vercel functions stop after 30 s).
    nasa_timeout_seconds: float = 15.0
    nasa_retries: int = 2
    nasa_retry_backoff_seconds: float = 0.8
    nasa_deadline_seconds: float = 24.0
    geocoding_base_url: str = "https://geocoding-api.open-meteo.com/v1/search"
    geocoding_timeout_seconds: float = 8.0
    # Historical POWER data rarely change, so a cached response is used for 30 days;
    # after that it is refreshed, and kept as a fallback if POWER is unavailable.
    cache_ttl_seconds: float = 30 * 24 * 3600
    # None disables the disk cache (memory cache only).
    cache_dir: Path | None = None
    cors_origins: tuple[str, ...] = DEFAULT_CORS_ORIGINS


def _parse_origins(raw: str | None) -> tuple[str, ...]:
    if not raw:
        return DEFAULT_CORS_ORIGINS
    return tuple(origin.strip() for origin in raw.split(",") if origin.strip())


def _cache_dir(raw: str | None) -> Path | None:
    if raw is not None:
        return Path(raw) if raw.strip() else None
    # Serverless functions can only write to /tmp (kept while the instance is warm).
    if os.getenv("VERCEL"):
        return Path("/tmp/farm-navigator-cache")
    return PROJECT_ROOT / ".cache" / "nasa_power"


@lru_cache
def get_settings() -> Settings:
    return Settings(
        nasa_api_key=os.getenv("NASA_API_KEY") or None,
        nasa_power_base_url=os.getenv("NASA_POWER_BASE_URL", Settings.nasa_power_base_url),
        nasa_timeout_seconds=float(os.getenv("NASA_TIMEOUT_SECONDS", Settings.nasa_timeout_seconds)),
        geocoding_base_url=os.getenv("GEOCODING_BASE_URL", Settings.geocoding_base_url),
        nasa_retries=int(os.getenv("NASA_RETRIES", Settings.nasa_retries)),
        nasa_deadline_seconds=float(os.getenv("NASA_DEADLINE_SECONDS", Settings.nasa_deadline_seconds)),
        cache_ttl_seconds=float(os.getenv("CACHE_TTL_SECONDS", Settings.cache_ttl_seconds)),
        cache_dir=_cache_dir(os.getenv("CACHE_DIR")),
        cors_origins=_parse_origins(os.getenv("CORS_ORIGINS")),
    )
