from datetime import date

import pytest

from app.models.game import (
    ClimateConditions,
    ClimateReport,
    Crop,
    Decision,
    Difficulty,
    Fertilizer,
    Irrigation,
    Level,
    Location,
    Period,
)
from app.services import game_engine as ge

PERIOD = Period(start=date(2025, 6, 1), end=date(2025, 6, 30))  # 30 days


def report(temp=20.0, rain=60.0, humidity=55, wind=3.0, solar=20.0) -> ClimateReport:
    return ClimateReport(
        conditions=ClimateConditions(
            average_temperature_c=temp,
            total_rainfall_mm=rain,
            average_humidity_percent=humidity,
            average_wind_speed_m_s=wind,
            solar_radiation=solar,
            drought_risk=ge.classify_drought_risk(rain, PERIOD.days, temp, humidity),
        ),
        source="NASA POWER",
        period=PERIOD,
        is_demo=False,
        limitations="test",
    )


def start(r: ClimateReport, difficulty=Difficulty.NORMAL):
    return ge.new_game(Location(name="Test", latitude=43.24, longitude=76.95), difficulty, r)


def play(r, crop=Crop.WHEAT, irrigation=Irrigation.NONE, fertilizer=Fertilizer.NONE, state=None):
    state = state or start(r)
    return ge.play_season(state, Decision(crop=crop, irrigation=irrigation, fertilizer=fertilizer))


def test_new_game_initial_state():
    state = start(report())
    assert (state.season, state.water, state.budget) == (1, 100, 1000)
    assert (state.soil_health, state.crop_health, state.sustainability_score) == (70, 100, 0)


@pytest.mark.parametrize(
    "rain,temp,humidity,expected",
    [
        (10, 25, 40, Level.HIGH),
        (10, 18, 60, Level.MEDIUM),
        (40, 20, 55, Level.MEDIUM),
        (40, 30, 30, Level.HIGH),
        (80, 20, 55, Level.LOW),
        (80, 30, 30, Level.MEDIUM),
    ],
)
def test_drought_risk_classification(rain, temp, humidity, expected):
    assert ge.classify_drought_risk(rain, 30, temp, humidity) == expected


def test_low_rain_without_irrigation_damages_crop():
    dry = report(rain=10, humidity=40)
    _, no_water = play(dry, irrigation=Irrigation.NONE)
    _, medium = play(dry, irrigation=Irrigation.MEDIUM)
    assert no_water.event.type == "drought"
    assert no_water.crop_health < medium.crop_health
    assert medium.changes.water < 0


def test_drought_tolerant_crop_suffers_less():
    dry = report(rain=10)
    _, wheat = play(dry, crop=Crop.WHEAT)
    _, chickpea = play(dry, crop=Crop.CHICKPEA)
    assert chickpea.crop_health > wheat.crop_health


def test_heat_damages_heat_sensitive_crop():
    hot = report(temp=30, rain=120)
    _, wheat = play(hot, crop=Crop.WHEAT)
    _, corn = play(hot, crop=Crop.CORN)
    assert wheat.crop_health < corn.crop_health
    assert wheat.event.type == "heatwave"
    assert any("heat stress" in line for line in wheat.explanation)


def test_overwatering_wastes_water_and_harms_soil():
    wet = report(rain=90)
    _, none = play(wet, irrigation=Irrigation.NONE)
    _, high = play(wet, irrigation=Irrigation.HIGH)
    assert high.changes.water < none.changes.water
    assert high.changes.soil_health < none.changes.soil_health
    assert high.crop_health < none.crop_health
    assert any("wasted water" in line for line in high.explanation)
    assert not any("not necessary" in line for line in high.explanation)


def test_mineral_faster_organic_better_for_soil():
    r = report()
    _, mineral = play(r, fertilizer=Fertilizer.MINERAL)
    _, organic = play(r, fertilizer=Fertilizer.ORGANIC)
    assert mineral.crop_health > organic.crop_health
    assert organic.changes.soil_health > mineral.changes.soil_health
    assert organic.changes.sustainability_score > mineral.changes.sustainability_score


def test_irrigation_limited_by_water_reserve():
    state = start(report(rain=5)).model_copy(update={"water": 10})
    new_state, record = play(report(rain=5), irrigation=Irrigation.HIGH, state=state)
    assert record.water_balance.irrigation_mm == pytest.approx(70 * 10 / 35, abs=0.1)
    assert new_state.water >= 0


def test_play_is_deterministic():
    r = report(temp=26, rain=20, humidity=38)
    a = play(r, crop=Crop.CORN, irrigation=Irrigation.LOW, fertilizer=Fertilizer.ORGANIC)
    b = play(r, crop=Crop.CORN, irrigation=Irrigation.LOW, fertilizer=Fertilizer.ORGANIC)
    assert a[1].model_dump(exclude={"season"}) == b[1].model_dump(exclude={"season"})


def test_values_stay_in_bounds():
    extreme = report(temp=45, rain=0, humidity=5, wind=12, solar=5)
    state, _ = play(extreme, crop=Crop.CORN)
    assert 0 <= state.crop_health <= 100
    assert 0 <= state.soil_health <= 100
    assert 0 <= state.sustainability_score <= 100


def test_full_game_rotation_and_results():
    r = report()
    state = start(r)
    for season, crop in enumerate([Crop.WHEAT, Crop.CHICKPEA, Crop.CORN], start=1):
        assert state.season == season
        state, _ = ge.play_season(state, Decision(crop=crop, irrigation=Irrigation.LOW, fertilizer=Fertilizer.ORGANIC))
        if season < 3:
            state = ge.advance_season(state, r)
    assert state.finished
    with pytest.raises(ValueError):
        ge.advance_season(state, r)
    results = ge.compute_results(state)
    for key in ("crop_score", "soil_score", "water_score", "budget_score", "sustainability_score"):
        assert 0 <= results[key] <= 100
    assert results["lessons"]


def test_monoculture_hurts_soil_compared_to_rotation():
    r = report()
    base, _ = play(r, crop=Crop.WHEAT)
    base = ge.advance_season(base, r)
    _, same = play(r, crop=Crop.WHEAT, state=base)
    _, rotated = play(r, crop=Crop.CHICKPEA, state=base)
    assert rotated.changes.soil_health > same.changes.soil_health


def test_advance_requires_decision():
    with pytest.raises(ValueError):
        ge.advance_season(start(report()), report())


def test_season_periods_are_past_growing_seasons():
    today = date(2026, 9, 25)
    assert ge.season_period(43.2, 1, today) == (date(2023, 5, 1), date(2023, 8, 31))
    assert ge.season_period(43.2, 3, today) == (date(2025, 5, 1), date(2025, 8, 31))
    assert ge.season_period(-33.9, 3, today) == (date(2024, 11, 1), date(2025, 2, 28))
