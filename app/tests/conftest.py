from collections.abc import Callable
from datetime import date

import httpx
import pytest

from app.config import Settings
from app.services import climate
from app.services.nasa_power import NasaPowerService
from app.services.weather import PARAM_UNITS_FALLBACK, demo_series

TODAY = date(2026, 9, 27)


def power_payload(request: httpx.Request, overrides: Callable[[str, str, float], float] | None = None) -> dict:
    """A response shaped like NASA POWER's daily point JSON, filled with deterministic synthetic values."""
    q = request.url.params
    params = q["parameters"].split(",")
    start = date(int(q["start"][:4]), int(q["start"][4:6]), int(q["start"][6:]))
    end = date(int(q["end"][:4]), int(q["end"][4:6]), int(q["end"][6:]))
    series = demo_series(params, start, end, float(q["latitude"]))
    block: dict[str, dict[str, float]] = {}
    for p in params:
        block[p] = {}
        for d, v in zip(series.dates, series.values[p], strict=True):
            key = d.strftime("%Y%m%d")
            value = float(v) if v is not None else -999.0
            block[p][key] = overrides(p, key, value) if overrides else value
    return {
        "type": "Feature",
        "geometry": {"type": "Point", "coordinates": [float(q["longitude"]), float(q["latitude"]), 420.0]},
        "properties": {"parameter": block},
        "header": {"fill_value": -999.0, "time_standard": q["time-standard"], "start": q["start"], "end": q["end"]},
        "messages": [],
        "parameters": {p: {"units": PARAM_UNITS_FALLBACK[p], "longname": p} for p in params},
    }


def ok_handler(request: httpx.Request) -> httpx.Response:
    return httpx.Response(200, json=power_payload(request))


@pytest.fixture(autouse=True)
def fresh_archives():
    climate._ARCHIVES.clear()
    yield
    climate._ARCHIVES.clear()


@pytest.fixture
def make_service(tmp_path):
    def factory(handler, **settings) -> tuple[NasaPowerService, list[httpx.Request]]:
        calls: list[httpx.Request] = []

        def recorder(request: httpx.Request) -> httpx.Response:
            calls.append(request)
            return handler(request)

        async def no_sleep(_seconds: float) -> None:
            return None

        client = httpx.AsyncClient(transport=httpx.MockTransport(recorder))
        cfg = Settings(cache_dir=settings.pop("cache_dir", tmp_path / "cache"), **settings)
        return NasaPowerService(cfg, client, sleep=no_sleep), calls

    return factory
