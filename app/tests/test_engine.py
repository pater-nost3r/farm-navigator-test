from datetime import date

import pytest

from app.services import engine, weather
from app.services.model_config import load_model
from app.services.weather import Window

MODEL = load_model()
WINDOW = Window.parse("05-01", "08-31")
D = {"crop": "wheat", "method": "drip", "intensity": "off", "care": "none"}


def season(year=2020, rain=None, tmax=None, tmin=None, **const):
    start, end = WINDOW.dates(year)
    s = weather.demo_series(MODEL["data"]["parameters"], start, end, 45.0)
    n = len(s.dates)
    for p, v in {"PRECTOTCORR": rain, "T2M_MAX": tmax, "T2M_MIN": tmin, **const}.items():
        if v is not None:
            s.values[p] = [v(i) if callable(v) else v for i in range(n)]
    return weather.build_season(s, year, WINDOW, 45.0, 300, MODEL)


# Two heavy storms a month on otherwise dry days, moderate heat.
STORMY = season(rain=lambda i: 45.0 if i % 15 == 0 else 0.5, tmax=27.0, tmin=13.0)


def test_simulation_is_deterministic():
    run = engine.new_run(MODEL, 1, "loam")
    assert engine.simulate(MODEL, run, STORMY, D) == engine.simulate(MODEL, run, STORMY, D)


def test_same_rain_acts_differently_on_sand_and_clay():
    out = {s: engine.simulate(MODEL, engine.new_run(MODEL, 1, s), STORMY, D) for s in ("sandy", "loam", "clay")}
    assert (
        out["sandy"]["water"]["drainage_mm"] > out["loam"]["water"]["drainage_mm"] > out["clay"]["water"]["drainage_mm"]
    )
    assert out["clay"]["water"]["runoff_mm"] > out["sandy"]["water"]["runoff_mm"]
    assert out["sandy"]["water"]["taw_mm"] < out["clay"]["water"]["taw_mm"]
    assert out["sandy"]["nitrogen"]["leached"] > out["clay"]["nitrogen"]["leached"]
    assert len({o["yield_pct"] for o in out.values()}) > 1


def test_mulch_reduces_runoff_and_erosion():
    run = engine.new_run(MODEL, 1, "clay")
    bare = engine.simulate(MODEL, run, STORMY, D)
    mulch = engine.simulate(MODEL, run, STORMY, {**D, "care": "mulch"})
    assert mulch["water"]["runoff_mm"] < bare["water"]["runoff_mm"]
    assert mulch["erosion_event"] < bare["erosion_event"]


def test_drainage_reduces_waterlogging_on_clay():
    wet = season(rain=lambda i: 30.0 if i % 3 == 0 else 5.0, tmax=24.0, tmin=12.0)
    run = engine.new_run(MODEL, 1, "clay")
    plain = engine.simulate(MODEL, run, wet, D)
    drained = engine.simulate(MODEL, run, wet, {**D, "care": "drainage"})
    assert drained["water"]["waterlog_days"] < plain["water"]["waterlog_days"]


def test_irrigation_helps_in_drought_and_drip_wastes_less_than_flood():
    dry = season(rain=0.0, tmax=33.0, tmin=17.0)
    run = engine.new_run(MODEL, 1, "loam")
    none = engine.simulate(MODEL, run, dry, {**D, "crop": "maize"})
    drip = engine.simulate(MODEL, run, dry, {**D, "crop": "maize", "intensity": "medium"})
    flood = engine.simulate(MODEL, run, dry, {**D, "crop": "maize", "intensity": "medium", "method": "flood"})
    assert drip["yield_pct"] > none["yield_pct"]
    assert (
        drip["water"]["useful_mm"] / drip["water"]["pumped_mm"]
        > flood["water"]["useful_mm"] / flood["water"]["pumped_mm"]
    )


def test_heat_hurts_sensitive_crops_more():
    hot = season(tmax=37.0, tmin=22.0, rain=lambda i: 8.0 if i % 4 == 0 else 0.0)
    run = engine.new_run(MODEL, 1, "loam")
    wheat = engine.simulate(MODEL, run, hot, D)
    sorghum = engine.simulate(MODEL, run, hot, {**D, "crop": "sorghum"})
    assert wheat["factors"]["heat"] < sorghum["factors"]["heat"]


def test_legume_leaves_nitrogen_and_repeating_a_crop_is_penalised():
    s = season(rain=lambda i: 6.0 if i % 3 == 0 else 0.0, tmax=26.0, tmin=12.0)
    run = engine.new_run(MODEL, 7, "loam")  # history: wheat
    after_chickpea, _ = engine.play(MODEL, run, s, {**D, "crop": "chickpea"})
    after_wheat, _ = engine.play(MODEL, run, s, D)
    assert after_chickpea["soil"]["n"] > after_wheat["soil"]["n"]
    repeat = engine.simulate(MODEL, run, s, D)  # wheat after wheat
    rotate = engine.simulate(MODEL, run, s, {**D, "crop": "chickpea"})
    assert repeat["factors"]["rotation"] < 1 and rotate["factors"]["rotation"] == 1
    assert any(r["code"] == "yield.rotation" for r in repeat["reasons"])


def test_every_decision_is_required():
    run = engine.new_run(MODEL, 1, "loam")
    check = engine.validate_decision(MODEL, run, {"crop": "wheat"})
    assert not check["ok"] and check["missing"] == ["method", "intensity", "care"]
    with pytest.raises(engine.DecisionError):
        engine.play(MODEL, run, STORMY, {"crop": "wheat", "method": "drip", "intensity": "off"})
    assert engine.validate_decision(MODEL, run, {**D, "crop": "rice"})["errors"] == ["unknown_crop"]


def test_budget_and_reserve_can_never_go_negative():
    run = engine.new_run(MODEL, 1, "sandy")
    poor = {**run, "budget": 3000.0}
    expensive = {"crop": "maize", "method": "drip", "intensity": "high", "care": "drainage"}
    assert "budget" in engine.validate_decision(MODEL, poor, expensive)["errors"]
    dry = season(rain=0.0, tmax=34.0, tmin=18.0)
    thirsty = {**run, "reserve_mm": 40.0}
    nxt, o = engine.play(MODEL, thirsty, dry, {**expensive, "care": "none"})
    assert o["water"]["pumped_mm"] <= 40 and o["water"]["reserve_left_mm"] >= 0
    assert nxt["reserve_mm"] >= 0 and nxt["budget"] >= 0
    assert o["economics"]["cost"] <= o["economics"]["cost_max"]
    assert any(r["code"] == "irrigation.reserve_out" for r in o["reasons"])
    empty = {**run, "reserve_mm": 0.0}
    assert "reserve_empty" in engine.validate_decision(MODEL, empty, {**D, "intensity": "low"})["errors"]


def test_bankruptcy_ends_a_multi_season_level():
    run = {**engine.new_run(MODEL, 6, "loam"), "budget": 4400.0}
    dry = season(rain=0.0, tmax=36.0, tmin=20.0)
    nxt, _ = engine.play(MODEL, run, dry, {"crop": "maize", "method": "drip", "intensity": "off", "care": "none"})
    assert nxt["failed"] == "bankrupt" and nxt["finished"]
    ev = engine.evaluate(MODEL, nxt)
    assert not ev["passed"] and ev["fail_reason"] == "bankrupt" and ev["stars"] == 0


def test_level_evaluation_goals_and_stars():
    good = season(rain=lambda i: 9.0 if i % 3 == 0 else 0.0, tmax=26.0, tmin=12.0)
    run, _ = engine.play(MODEL, engine.new_run(MODEL, 1, "loam"), good, {**D, "crop": "sorghum", "care": "mulch"})
    ev = engine.evaluate(MODEL, run)
    assert run["finished"] and ev["passed"]
    assert 1 <= ev["stars"] <= 3
    assert set(ev["categories"]) == {"yield", "water", "soil"}
    assert ev["goals"][0]["metric"] == "avg_yield" and ev["goals"][0]["met"]


def test_replay_rebuilds_the_same_state_and_rejects_extra_seasons():
    s1, s2 = season(2020), season(2021)
    decisions = [{**D, "crop": "chickpea", "care": "cover_crop"}, {**D, "crop": "maize"}]
    run, before = engine.replay(MODEL, 3, "loam", [s1, s2], decisions)
    manual, _ = engine.play(MODEL, engine.new_run(MODEL, 3, "loam"), s1, decisions[0])
    assert before[1]["soil"] == manual["soil"]
    assert run["finished"] and len(run["results"]) == 2
    with pytest.raises(engine.DecisionError):
        engine.replay(MODEL, 3, "loam", [s1, s2], [*decisions, D])


def test_what_if_changes_exactly_one_decision_on_the_same_state():
    dry = season(rain=lambda i: 4.0 if i % 6 == 0 else 0.0, tmax=31.0, tmin=16.0)
    run = engine.new_run(MODEL, 1, "sandy")
    base = engine.simulate(MODEL, run, dry, {"crop": "maize", "method": "flood", "intensity": "high", "care": "none"})
    alts = engine.what_if(MODEL, run, dry, base)
    assert alts, "a wasteful plan in a dry season should have alternatives"
    for a in alts:
        changed = [k for k in engine.DECISION_FIELDS if a["decision"][k] != base["decision"][k]]
        assert changed == [a["change"]["field"]]
        assert a["criterion"] in {"water_saver", "water_efficiency", "yield_gain", "soil_gain", "profit_gain"}
        assert a["player"]["yield_pct"] == base["yield_pct"]
    one = engine.compare(MODEL, run, dry, base, "method", "drip")
    assert one["diff"]["useful_mm"] >= 0 and one["change"] == {"field": "method", "from": "flood", "to": "drip"}


def test_weather_fit_for_dry_hot_and_wet_levels():
    levels = {level["key"]: level for level in MODEL["levels"]}
    dry = season(2020, rain=0.5)
    hot = season(2021, tmax=33.0, tmin=18.0)
    wet = season(2022, rain=lambda i: 25.0 if i % 10 == 0 else 3.0)
    seasons = {2020: dry, 2021: hot, 2022: wet}
    assert engine.weather_fit(MODEL, levels["waterShortage"], seasons, 200.0, 2020)["ok"]
    assert not engine.weather_fit(MODEL, levels["waterShortage"], seasons, 50.0, 2020)["ok"]
    assert not engine.weather_fit(MODEL, levels["waterShortage"], seasons, None, 2020)["ok"]  # no reference, no claim
    assert engine.weather_fit(MODEL, levels["hotSeason"], seasons, 200.0, 2021)["ok"]
    assert engine.weather_fit(MODEL, levels["rainySeason"], seasons, 200.0, 2022)["ok"]
    fit = engine.weather_fit(MODEL, levels["depletedSoil"], seasons, 200.0, 2022)
    assert not fit["ok"] and fit["reason"] == "incomplete"  # needs 2022 and 2023


def test_model_config_is_complete():
    assert [lvl["key"] for lvl in MODEL["levels"]] == [
        "firstHarvest",
        "waterShortage",
        "depletedSoil",
        "hotSeason",
        "rainySeason",
        "economicCrisis",
        "climateChallenge",
    ]
    for level in MODEL["levels"]:
        assert set(level["stars"]) == {"yield", "water", "soil"}
        assert level["goals"]
    assert set(engine.options(MODEL["soils"])) == {"sandy", "loam", "clay"}
    assert set(engine.options(MODEL["irrigation_methods"])) == {"flood", "sprinkler", "drip"}
    assert date(2001, 1, 1)  # keeps the import used for type clarity
