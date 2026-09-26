from datetime import UTC, date, datetime, timedelta

import httpx
import pytest

from app.config import Settings
from app.services.climate import load_archive
from app.services.geocoding import GeocodingService
from app.services.model_config import load_model
from app.services.nasa_power import NasaPowerError
from app.services.weather import Window
from app.tests.conftest import TODAY, ok_handler, power_payload

MODEL = load_model()
PARAMS = MODEL["data"]["parameters"]
WINDOW = Window.parse("05-01", "08-31")


async def fetch(service, start=date(2024, 5, 1), end=date(2024, 8, 31)):
    return await service.fetch(43.238949, 76.889709, start, end, PARAMS, "AG", "LST")


async def test_request_uses_documented_parameters_and_time_standard(make_service):
    service, calls = make_service(ok_handler)
    response = await fetch(service)
    q = calls[0].url.params
    assert q["parameters"] == "T2M,T2M_MAX,T2M_MIN,PRECTOTCORR,RH2M,WS2M,ALLSKY_SFC_SW_DWN"
    assert (q["community"], q["format"], q["time-standard"]) == ("AG", "JSON", "LST")
    assert (q["start"], q["end"]) == ("20240501", "20240831")
    assert response.status == "live"
    assert response.request_url.startswith("https://power.larc.nasa.gov/api/temporal/daily/point?parameters=T2M,")
    assert "time-standard=LST" in response.request_url
    assert response.parameter_info["PRECTOTCORR"]["units"] == "mm/day"
    assert response.elevation_m == 420.0


async def test_second_request_reads_the_cache(make_service):
    service, calls = make_service(ok_handler)
    await fetch(service)
    again = await fetch(service)
    assert again.status == "cached" and len(calls) == 1


async def test_disk_cache_survives_a_restart(make_service, tmp_path):
    service, calls = make_service(ok_handler, cache_dir=tmp_path / "c")
    await fetch(service)
    restarted, calls2 = make_service(lambda r: httpx.Response(500), cache_dir=tmp_path / "c")
    response = await fetch(restarted)
    assert response.status == "cached" and not calls2


async def test_retries_transient_errors_then_succeeds(make_service):
    answers = iter([httpx.Response(503), httpx.Response(429)])

    def flaky(request):
        return next(answers, None) or ok_handler(request)

    service, calls = make_service(flaky)
    response = await fetch(service)
    assert response.status == "live" and len(calls) == 3


async def test_does_not_retry_client_errors(make_service):
    service, calls = make_service(lambda r: httpx.Response(422, json={"detail": "bad"}))
    with pytest.raises(NasaPowerError) as exc:
        await fetch(service)
    assert exc.value.kind == "http" and len(calls) == 1


@pytest.mark.parametrize(
    ("handler", "kind"),
    [
        (lambda r: (_ for _ in ()).throw(httpx.ReadTimeout("slow")), "timeout"),
        (lambda r: (_ for _ in ()).throw(httpx.ConnectError("down")), "network"),
        (lambda r: httpx.Response(503, text="busy"), "http"),
        (lambda r: httpx.Response(200, json={"unexpected": True}), "format"),
    ],
)
async def test_errors_are_typed_after_retries(make_service, handler, kind):
    service, calls = make_service(handler)
    with pytest.raises(NasaPowerError) as exc:
        await fetch(service)
    assert exc.value.kind == kind
    assert len(calls) == (1 if kind == "format" else 3)


async def test_expired_cache_is_used_when_power_fails(make_service, tmp_path):
    service, _ = make_service(ok_handler, cache_dir=tmp_path / "c")
    await fetch(service)
    expired, _ = make_service(lambda r: httpx.Response(503), cache_dir=tmp_path / "c", cache_ttl_seconds=0)
    response = await fetch(expired)
    assert response.status == "cached" and response.stale and response.error == "http"


async def test_archive_covers_twenty_complete_years_in_one_request(make_service):
    service, calls = make_service(ok_handler)
    archive = await load_archive(service, 43.6, 77.0, WINDOW, MODEL, TODAY)
    assert len(calls) == 1
    assert (archive.first_year, archive.latest_year) == (2007, 2026)
    assert archive.complete_years() == list(range(2007, 2027))
    p = archive.provenance()
    assert p["status"] == "live" and p["time_standard"] == "LST" and p["request_url"]
    assert p["location"]["elevation_m"] == 420
    assert set(p["parameters"]) == set(PARAMS)
    assert datetime.fromisoformat(p["fetched_at"]) > datetime.now(UTC) - timedelta(minutes=1)


async def test_archive_marks_recent_gaps_and_incomplete_seasons(make_service):
    def tail_missing(request):
        return httpx.Response(200, json=power_payload(request, lambda p, k, v: -999.0 if k >= "20260801" else v))

    service, _ = make_service(tail_missing)
    archive = await load_archive(service, 43.6, 77.0, WINDOW, MODEL, TODAY)
    assert 2026 not in archive.complete_years()
    assert len(archive.season(2026).gaps["T2M_MAX"]) == 31


async def test_wrong_units_disable_optional_parameter(make_service):
    def odd_units(request):
        payload = power_payload(request)
        payload["parameters"]["WS2M"]["units"] = "km/h"
        return httpx.Response(200, json=payload)

    service, _ = make_service(odd_units)
    archive = await load_archive(service, 43.6, 77.0, WINDOW, MODEL, TODAY)
    assert archive.parameter_info["WS2M"]["available"] is False
    assert archive.season(2020).unavailable == ["WS2M"]


async def test_demo_archive_is_labelled_and_needs_no_request(make_service):
    service, calls = make_service(ok_handler)
    archive = await load_archive(service, 43.6, 77.0, WINDOW, MODEL, TODAY, demo=True)
    assert archive.status == "demo" and archive.request_url is None and not calls
    assert "not NASA data" in archive.source


async def test_geocoding_parses_results():
    def handler(request):
        return httpx.Response(
            200, json={"results": [{"name": "Almaty", "country": "KZ", "latitude": 43.25, "longitude": 76.92}]}
        )

    client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    places = await GeocodingService(Settings(), client).search("Almaty")
    assert places[0].name == "Almaty" and places[0].latitude == 43.25
