"""NASA POWER Daily Point API client with retry and a two-level cache.

Docs: https://power.larc.nasa.gov/docs/services/api/temporal/daily/
POWER is public and needs no API key, so NASA_API_KEY is never sent to it.

Order of sources (the status the game shows):
1. fresh server cache (memory, then disk)      → "cached"
2. NASA POWER, with timeout and retries          → "live" (then cached)
3. an expired cache entry, if POWER fails        → "cached" + stale=True
4. nothing                                       → NasaPowerError; the player may choose Demo explicitly
"""

import asyncio
import hashlib
import json
import logging
import time
from dataclasses import dataclass
from datetime import UTC, date, datetime
from pathlib import Path
from typing import Any
from urllib.parse import urlencode

import httpx

from app.config import Settings

logger = logging.getLogger(__name__)

SOURCE = "NASA POWER Daily Point API (power.larc.nasa.gov)"
RETRY_STATUSES = {429, 500, 502, 503, 504}


class NasaPowerError(Exception):
    def __init__(self, message: str, kind: str = "unavailable"):
        super().__init__(message)
        self.kind = kind  # timeout | network | http | format | incomplete


@dataclass
class PowerResponse:
    parameter: dict[str, Any]
    parameter_info: dict[str, dict[str, Any]]
    elevation_m: float | None
    messages: list[str]
    request_url: str
    fetched_at: datetime
    status: str  # live | cached
    stale: bool = False
    error: str | None = None  # why a stale copy was used


class DiskCache:
    """Raw POWER responses as JSON files. Historical data do not change, so old files stay useful as a fallback."""

    def __init__(self, directory: Path | None):
        self._dir = directory
        if directory is not None:
            try:
                directory.mkdir(parents=True, exist_ok=True)
            except OSError:
                logger.warning("cache directory %s is not writable; disk cache disabled", directory)
                self._dir = None

    def _path(self, key: str) -> Path | None:
        return None if self._dir is None else self._dir / f"{key}.json"

    def get(self, key: str) -> dict[str, Any] | None:
        path = self._path(key)
        if path is None or not path.exists():
            return None
        try:
            entry = json.loads(path.read_text(encoding="utf-8"))
            return entry if isinstance(entry, dict) and "payload" in entry and "fetched_at" in entry else None
        except (OSError, ValueError):
            return None

    def set(self, key: str, entry: dict[str, Any]) -> None:
        path = self._path(key)
        if path is None:
            return
        try:
            tmp = path.with_suffix(".tmp")
            tmp.write_text(json.dumps(entry), encoding="utf-8")
            tmp.replace(path)
        except OSError as exc:
            logger.warning("could not write cache file: %s", exc)


class NasaPowerService:
    def __init__(
        self,
        settings: Settings,
        client: httpx.AsyncClient | None = None,
        sleep: Any = asyncio.sleep,
        clock: Any = time.monotonic,
    ):
        self._settings = settings
        self._client = client  # None = a short-lived client per request (serverless-safe)
        self._memory: dict[str, dict[str, Any]] = {}
        self._disk = DiskCache(settings.cache_dir)
        self._sleep = sleep
        self._clock = clock
        self.requests_made = 0

    def request_params(
        self,
        latitude: float,
        longitude: float,
        start: date,
        end: date,
        parameters: list[str],
        community: str,
        time_standard: str,
    ) -> dict[str, str]:
        return {
            "parameters": ",".join(parameters),
            "community": community,
            "latitude": f"{latitude:.4f}",
            "longitude": f"{longitude:.4f}",
            "start": start.strftime("%Y%m%d"),
            "end": end.strftime("%Y%m%d"),
            "format": "JSON",
            "time-standard": time_standard,
        }

    def request_url(self, params: dict[str, str]) -> str:
        return f"{self._settings.nasa_power_base_url}?{urlencode(params, safe=',')}"

    async def fetch(
        self,
        latitude: float,
        longitude: float,
        start: date,
        end: date,
        parameters: list[str],
        community: str,
        time_standard: str,
    ) -> PowerResponse:
        params = self.request_params(latitude, longitude, start, end, parameters, community, time_standard)
        url = self.request_url(params)
        key = hashlib.sha1(url.encode()).hexdigest()
        entry = self._memory.get(key) or self._disk.get(key)
        if entry is not None:
            self._memory[key] = entry
            age = (datetime.now(UTC) - datetime.fromisoformat(entry["fetched_at"])).total_seconds()
            if age <= self._settings.cache_ttl_seconds:
                return self._parse(entry["payload"], url, entry["fetched_at"], "cached")
        try:
            payload = await self._download(params)
            response = self._parse(payload, url, datetime.now(UTC).isoformat(timespec="seconds"), "live")
        except NasaPowerError as exc:
            if entry is None:
                raise
            logger.warning("NASA POWER failed (%s); using an expired cached copy", exc)
            stale = self._parse(entry["payload"], url, entry["fetched_at"], "cached")
            stale.stale, stale.error = True, exc.kind
            return stale
        entry = {"payload": payload, "fetched_at": response.fetched_at.isoformat()}
        self._memory[key] = entry
        self._disk.set(key, entry)
        return response

    async def _get(self, params: dict[str, str], seconds: float) -> httpx.Response:
        url = self._settings.nasa_power_base_url
        if self._client is not None:
            return await self._client.get(url, params=params, timeout=seconds)
        async with httpx.AsyncClient() as client:
            return await client.get(url, params=params, timeout=seconds)

    async def _download(self, params: dict[str, str]) -> dict[str, Any]:
        s = self._settings
        deadline = self._clock() + s.nasa_deadline_seconds
        last = NasaPowerError("no attempt made", "network")
        for attempt in range(s.nasa_retries + 1):
            remaining = deadline - self._clock()
            if remaining <= 1:
                break
            self.requests_made += 1
            try:
                response = await self._get(params, min(s.nasa_timeout_seconds, remaining))
            except httpx.TimeoutException:
                last = NasaPowerError("request timed out", "timeout")
            except httpx.HTTPError as exc:
                last = NasaPowerError(f"network error: {type(exc).__name__}", "network")
            else:
                if response.status_code == 200:
                    try:
                        payload = response.json()
                    except ValueError:
                        raise NasaPowerError("response is not JSON", "format") from None
                    if not isinstance(payload, dict):
                        raise NasaPowerError("unexpected response format", "format")
                    return payload
                if response.status_code not in RETRY_STATUSES:
                    raise NasaPowerError(f"HTTP {response.status_code}", "http")
                last = NasaPowerError(f"HTTP {response.status_code}", "http")
            if attempt < s.nasa_retries:
                await self._sleep(s.nasa_retry_backoff_seconds * (2**attempt))
        raise last

    @staticmethod
    def _parse(payload: dict[str, Any], url: str, fetched_at: str, status: str) -> PowerResponse:
        try:
            parameter = payload["properties"]["parameter"]
            if not isinstance(parameter, dict) or not parameter:
                raise TypeError
        except (KeyError, TypeError):
            raise NasaPowerError("unexpected response format", "format") from None
        info_raw: dict[str, Any] = payload["parameters"] if isinstance(payload.get("parameters"), dict) else {}
        info = {
            p: {
                "units": str((info_raw.get(p) or {}).get("units", "")),
                "longname": str((info_raw.get(p) or {}).get("longname", "")),
            }
            for p in parameter
        }
        coords = (payload.get("geometry") or {}).get("coordinates") or []
        elevation = float(coords[2]) if len(coords) >= 3 and isinstance(coords[2], (int, float)) else None
        messages = [str(m) for m in payload.get("messages") or []]
        return PowerResponse(parameter, info, elevation, messages, url, datetime.fromisoformat(fetched_at), status)
