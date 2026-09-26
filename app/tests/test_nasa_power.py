from datetime import date, timedelta

import httpx
import pytest
from fastapi.testclient import TestClient

from app.api.geocode import get_geocoding_service
from app.api.nasa import get_nasa_service
from app.config import Settings
from app.main import app
from app.services.cache import TTLCache
from app.services.geocoding import GeocodingService
from app.services.nasa_power import (
    FILL_VALUE,
    NasaPowerError,
    NasaPowerService,
    aggregate_season,
    growing_season,
    recent_season_years,
)

TODAY = date(2026, 9, 26)


def daily_payload(start: date, end: date, rain=2.0, temp=22.0, fill_every=0) -> dict:
    series: dict[str, dict[str, float]] = {p: {} for p in ("T2M", "PRECTOTCORR", "RH2M", "WS2M", "ALLSKY_SFC_SW_DWN")}
    day = start
    i = 0
    while day <= end:
        key = day.strftime("%Y%m%d")
        # Heavy rain on the 1st of each month; hotter in the last season year.
        r = 25.0 if day.day == 1 else rain
        t = temp + (4 if day.year == end.year else 0)
        series["T2M"][key] = t
        series["PRECTOTCORR"][key] = r
        series["RH2M"][key] = 55.0
        series["WS2M"][key] = 3.0
        series["ALLSKY_SFC_SW_DWN"][key] = FILL_VALUE if fill_every and i % fill_every == 0 else 21.0
        day += timedelta(days=1)
        i += 1
    return {"properties": {"parameter": series}}


def make_service(handler) -> tuple[NasaPowerService, list[httpx.Request]]:
    calls: list[httpx.Request] = []

    def recorder(request: httpx.Request) -> httpx.Response:
        calls.append(request)
        return handler(request)

    client = httpx.AsyncClient(transport=httpx.MockTransport(recorder))
    return NasaPowerService(Settings(), client), calls


def ok_handler(request: httpx.Request) -> httpx.Response:
    q = request.url.params
    start = date(int(q["start"][:4]), int(q["start"][4:6]), int(q["start"][6:]))
    end = date(int(q["end"][:4]), int(q["end"][4:6]), int(q["end"][6:]))
    return httpx.Response(200, json=daily_payload(start, end))


def test_growing_season_windows():
    assert growing_season(43.2, 2025) == (date(2025, 5, 1), date(2025, 8, 31))
    assert growing_season(-33.9, 2024) == (date(2023, 11, 1), date(2024, 2, 29))  # leap year


def test_recent_seasons_respect_data_lag():
    assert recent_season_years(43.2, TODAY, 3) == [2024, 2025, 2026]
    # Only 5 days after the season ended: the 2026 season is not complete in POWER yet.
    assert recent_season_years(43.2, date(2026, 9, 5), 3) == [2023, 2024, 2025]
    assert recent_season_years(-33.9, TODAY, 2) == [2025, 2026]


def test_aggregate_season_counts_events_and_skips_fill_values():
    start, end = date(2025, 5, 1), date(2025, 8, 31)
    daily = daily_payload(start, end, rain=0.5, fill_every=10)["properties"]["parameter"]
    s = aggregate_season(daily, start, end, 2025)
    assert s.days == 123
    assert s.heavy_rain_days == 4  # the 1st of May, Jun, Jul, Aug
    assert s.rainfall_mm == pytest.approx(4 * 25 + 119 * 0.5, abs=0.1)
    assert s.solar_radiation_mj_m2_day == 21.0  # fill values ignored
    assert s.missing_share > 0
    assert s.longest_dry_spell_days == 30  # June 2–July 1 (July 1 is heavy) … longest run between the 1sts
    assert s.hot_days == 123  # 26 °C in the last year


def test_aggregate_season_rejects_mostly_missing_data():
    start, end = date(2025, 5, 1), date(2025, 8, 31)
    daily = daily_payload(start, end, fill_every=2)["properties"]["parameter"]
    with pytest.raises(NasaPowerError) as exc:
        aggregate_season(daily, start, end, 2025)
    assert exc.value.kind == "incomplete"


async def test_history_uses_one_request_and_caches():
    service, calls = make_service(ok_handler)
    history, cached = await service.get_climate_history(38.84, -97.61, today=TODAY)
    assert not cached
    assert len(calls) == 1
    params = calls[0].url.params
    assert params["parameters"] == "T2M,PRECTOTCORR,RH2M,WS2M,ALLSKY_SFC_SW_DWN"
    assert params["community"] == "AG"
    assert (params["start"], params["end"]) == ("20170501", "20260831")
    assert [s.year for s in history.seasons] == list(range(2017, 2027))
    assert history.baseline.temperature_c == pytest.approx(22.4, abs=0.05)
    assert not history.is_demo and history.source == "NASA POWER"

    again, cached = await service.get_climate_history(38.84, -97.61, today=TODAY)
    assert cached and len(calls) == 1 and again == history


@pytest.mark.parametrize(
    "handler,kind",
    [
        (lambda r: (_ for _ in ()).throw(httpx.ReadTimeout("slow")), "timeout"),
        (lambda r: (_ for _ in ()).throw(httpx.ConnectError("down")), "network"),
        (lambda r: httpx.Response(503, text="busy"), "http"),
        (lambda r: httpx.Response(200, json={"unexpected": True}), "format"),
    ],
)
async def test_history_errors_are_typed(handler, kind):
    service, _ = make_service(handler)
    with pytest.raises(NasaPowerError) as exc:
        await service.get_climate_history(38.84, -97.61, today=TODAY)
    assert exc.value.kind == kind


async def test_conditions_fall_back_to_labelled_demo():
    service, _ = make_service(lambda r: httpx.Response(500))
    report = await service.get_conditions(43.2, 76.9, date(2025, 6, 1), date(2025, 6, 30))
    assert report.is_demo and "unavailable" in report.limitations


def test_ttl_cache_expires_and_evicts():
    now = [0.0]
    cache: TTLCache[int] = TTLCache(10, max_items=2, clock=lambda: now[0])
    cache.set("a", 1)
    cache.set("b", 2)
    cache.set("c", 3)
    assert cache.get("a") is None and cache.get("c") == 3
    now[0] = 11
    assert cache.get("c") is None


@pytest.fixture
def api_client():
    def use(handler):
        service, calls = make_service(handler)
        app.dependency_overrides[get_nasa_service] = lambda: service
        return TestClient(app), calls

    yield use
    app.dependency_overrides.clear()


def test_climate_endpoint_live_then_cached(api_client):
    client, calls = api_client(ok_handler)
    first = client.get("/api/nasa/climate", params={"latitude": 38.84, "longitude": -97.61})
    assert first.status_code == 200
    body = first.json()
    assert body["status"] == "live" and len(body["seasons"]) == 10
    assert "s-maxage" in first.headers["cache-control"]
    second = client.get("/api/nasa/climate", params={"latitude": 38.84, "longitude": -97.61})
    assert second.json()["status"] == "cached" and len(calls) == 1


def test_climate_endpoint_reports_timeout(api_client):
    client, _ = api_client(lambda r: (_ for _ in ()).throw(httpx.ReadTimeout("slow")))
    res = client.get("/api/nasa/climate", params={"latitude": 1, "longitude": 2})
    assert res.status_code == 504
    assert res.json()["detail"]["kind"] == "timeout"
    assert res.headers["cache-control"] == "no-store"


def test_climate_endpoint_validates_coordinates(api_client):
    client, _ = api_client(ok_handler)
    assert client.get("/api/nasa/climate", params={"latitude": 95, "longitude": 0}).status_code == 422


def test_geocode_endpoint():
    def handler(request: httpx.Request) -> httpx.Response:
        assert request.url.params["name"] == "Almaty"
        return httpx.Response(200, json={"results": [
            {"name": "Almaty", "country": "Kazakhstan", "admin1": "Almaty", "latitude": 43.25249, "longitude": 76.9115}
        ]})

    service = GeocodingService(Settings(), httpx.AsyncClient(transport=httpx.MockTransport(handler)))
    app.dependency_overrides[get_geocoding_service] = lambda: service
    try:
        res = TestClient(app).get("/api/geocode", params={"q": "Almaty"})
    finally:
        app.dependency_overrides.clear()
    assert res.status_code == 200
    assert res.json()["results"][0] == {
        "name": "Almaty", "country": "Kazakhstan", "admin1": "Almaty", "latitude": 43.2525, "longitude": 76.9115
    }


def test_index_serves_the_game():
    res = TestClient(app).get("/")
    assert res.status_code == 200 and "Farm Navigator" in res.text
