import httpx
import pytest
from fastapi.testclient import TestClient

from app.api.geocode import get_geocoding_service
from app.api.nasa import get_nasa_service, get_today
from app.main import app
from app.tests.conftest import TODAY, ok_handler

FARM = {"latitude": 43.6, "longitude": 77.0, "start_md": "05-01", "end_md": "08-31", "soil": "loam"}
Q = {k: FARM[k] for k in ("latitude", "longitude", "start_md", "end_md")}
PLAN = {"crop": "sorghum", "method": "drip", "intensity": "low", "care": "mulch"}


@pytest.fixture
def api(make_service):
    def build(handler=ok_handler):
        service, calls = make_service(handler)
        app.dependency_overrides[get_nasa_service] = lambda: service
        app.dependency_overrides[get_today] = lambda: TODAY
        return TestClient(app), calls

    yield build
    app.dependency_overrides.clear()


def test_health_and_config(api):
    client, _ = api()
    assert client.get("/api/health").json() == {"status": "ok"}
    cfg = client.get("/api/game/config").json()
    assert len(cfg["levels"]) == 7 and set(cfg["soils"]) >= {"sandy", "loam", "clay"}
    assert cfg["data"]["time_standard"] == "LST" and cfg["disclaimer"]


def test_archive_reports_provenance_features_and_level_fit(api):
    client, calls = api()
    body = client.get("/api/nasa/archive", params=Q).json()
    d = body["data"]
    assert d["status"] == "live" and d["time_standard"] == "LST" and "time-standard=LST" in d["request_url"]
    assert d["parameters"]["T2M_MAX"]["units"] == "C" and d["location"]["latitude"] == 43.6
    assert len(body["seasons"]) == 20
    s = body["seasons"][-1]
    assert {"hot_days", "rain_total_mm", "longest_dry_spell_days", "heavy_rain_days", "t_mean_c"} <= set(s["features"])
    assert s["season_name"] == "summer" and s["anomaly"]["available"]
    assert set(body["level_fit"]) == {str(i) for i in range(1, 8)}
    assert body["thresholds"]["hot_day_tmax_c"] == 30
    assert client.get("/api/nasa/archive", params=Q).json()["data"]["status"] == "cached"
    assert len(calls) == 1


def test_invalid_period_and_coordinates(api):
    client, calls = api()
    r = client.get("/api/nasa/archive", params={**Q, "end_md": "05-10"})
    assert r.status_code == 422 and r.json()["detail"]["error"] == "invalid_period"
    assert client.get("/api/nasa/archive", params={**Q, "latitude": 95}).status_code == 422
    assert not calls


def test_nasa_failure_returns_typed_error_without_inventing_data(api):
    client, _ = api(lambda r: httpx.Response(503))
    r = client.get("/api/nasa/archive", params=Q)
    assert r.status_code == 502
    assert r.json()["detail"]["error"] == "nasa_power_unavailable" and r.headers["cache-control"] == "no-store"
    demo = client.get("/api/nasa/archive", params={**Q, "demo": True})
    assert demo.status_code == 200 and demo.json()["data"]["status"] == "demo"


def test_start_checks_years_and_weather_fit(api):
    client, _ = api()
    fits = client.get("/api/nasa/archive", params=Q).json()["level_fit"]
    r = client.post("/api/game/start", json={"level_id": 7, "year": 2025, "farm": FARM})
    assert r.status_code == 422 and r.json()["detail"]["suggestion"] == 2024  # 3 seasons must be complete
    unfit = [y for y in range(2007, 2027) if y not in fits["2"]["years"]]
    r = client.post("/api/game/start", json={"level_id": 2, "year": unfit[0], "farm": FARM})
    assert r.status_code == 409 and r.json()["detail"]["error"] == "weather_unfit"
    assert r.json()["detail"]["suggestions"] == fits["2"]["suggestions"]
    ok = client.post("/api/game/start", json={"level_id": 2, "year": fits["2"]["years"][0], "farm": FARM}).json()
    assert ok["fit"]["ok"] and ok["run"]["reserve_mm"] == 120 and ok["season"]["daily"]["dates"]
    assert ok["data"]["status"] in {"live", "cached"} and ok["limitations"]


def test_turn_requires_every_decision(api):
    client, _ = api()
    r = client.post(
        "/api/game/turn", json={"level_id": 1, "year": 2024, "farm": FARM, "decisions": [{"crop": "wheat"}]}
    )
    assert r.status_code == 422
    assert r.json()["detail"]["missing"] == ["method", "intensity", "care"]
    r = client.post("/api/game/turn", json={"level_id": 1, "year": 2024, "farm": FARM, "decisions": []})
    assert r.status_code == 422


def test_full_three_season_level_is_replayed_on_the_server(api):
    client, _ = api()
    base = {"level_id": 7, "year": 2022, "farm": FARM}
    plans = [{**PLAN, "crop": "chickpea", "care": "cover_crop"}, {**PLAN, "crop": "maize"}, PLAN]
    budgets = []
    for k in range(1, 4):
        body = client.post("/api/game/turn", json={**base, "decisions": plans[:k]}).json()
        o = body["outcome"]
        assert o["year"] == 2021 + k and len(body["results"]) == k
        assert o["decision"] == plans[k - 1]
        assert {r["category"] for r in o["reasons"]} >= {"nasa", "computed", "player"}
        assert body["run"]["budget"] >= 0 and body["run"]["reserve_mm"] >= 0
        budgets.append(body["run"]["budget"])
        if k < 3:
            assert body["evaluation"] is None and body["season"]["year"] == 2022 + k
    assert body["run"]["finished"] and body["evaluation"]["metrics"]["final_budget"] == budgets[-1]
    assert body["season"] is None
    again = client.post("/api/game/turn", json={**base, "decisions": plans}).json()
    assert again["evaluation"] == body["evaluation"]  # deterministic replay


def test_custom_what_if_changes_one_field(api):
    client, _ = api()
    req = {"level_id": 1, "year": 2024, "farm": FARM, "decisions": [PLAN]}
    r = client.post("/api/game/what-if", json={**req, "season": 0, "field": "intensity", "value": "off"}).json()
    c = r["comparison"]
    assert c["change"] == {"field": "intensity", "from": "low", "to": "off"}
    assert c["alternative"]["pumped_mm"] == 0
    bad = client.post("/api/game/what-if", json={**req, "season": 0, "field": "crop", "value": "rice"})
    assert bad.status_code == 422


def test_geocode_endpoint(api):
    client, _ = api()

    class Fake:
        async def search(self, q, lang):
            return []

    app.dependency_overrides[get_geocoding_service] = lambda: Fake()
    r = client.get("/api/geocode", params={"q": "Almaty"})
    assert r.status_code == 200 and r.json()["results"] == []
