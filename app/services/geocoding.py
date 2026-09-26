"""City name → coordinates via the free Open-Meteo Geocoding API (no key needed).

Docs: https://open-meteo.com/en/docs/geocoding-api
"""

import httpx

from app.config import Settings
from app.models.climate import Place
from app.services.cache import TTLCache

SOURCE = "Open-Meteo Geocoding API (GeoNames)"
MAX_RESULTS = 6


class GeocodingError(Exception):
    def __init__(self, message: str, kind: str = "unavailable"):
        super().__init__(message)
        self.kind = kind


class GeocodingService:
    def __init__(self, settings: Settings, client: httpx.AsyncClient | None = None):
        self._settings = settings
        self._client = client
        self._cache: TTLCache[list[Place]] = TTLCache(settings.cache_ttl_seconds)

    async def search(self, query: str, language: str = "en") -> list[Place]:
        key = (query.strip().lower(), language)
        cached = self._cache.get(key)
        if cached is not None:
            return cached
        params = {"name": query.strip(), "count": str(MAX_RESULTS), "language": language, "format": "json"}
        try:
            if self._client is not None:
                response = await self._client.get(
                    self._settings.geocoding_base_url, params=params, timeout=self._settings.geocoding_timeout_seconds
                )
            else:
                async with httpx.AsyncClient() as client:
                    response = await client.get(
                        self._settings.geocoding_base_url, params=params,
                        timeout=self._settings.geocoding_timeout_seconds,
                    )
        except httpx.TimeoutException:
            raise GeocodingError("geocoding timed out", "timeout") from None
        except httpx.HTTPError as exc:
            raise GeocodingError(f"network error: {type(exc).__name__}", "network") from None
        if response.status_code != 200:
            raise GeocodingError(f"HTTP {response.status_code}", "http")
        try:
            raw = response.json().get("results") or []
            places = [
                Place(
                    name=r["name"],
                    country=r.get("country"),
                    admin1=r.get("admin1"),
                    latitude=round(float(r["latitude"]), 4),
                    longitude=round(float(r["longitude"]), 4),
                )
                for r in raw
            ]
        except (ValueError, KeyError, TypeError, AttributeError):
            raise GeocodingError("unexpected response format", "format") from None
        self._cache.set(key, places)
        return places
