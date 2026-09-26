from datetime import date

import pytest

from app.services import weather
from app.services.model_config import load_model
from app.services.weather import Window, WindowError

MODEL = load_model()


def test_window_parsing_and_year_crossing():
    w = Window.parse("11-01", "03-31")
    assert w.crosses_year
    assert w.dates(2024) == (date(2024, 11, 1), date(2025, 3, 31))
    assert Window.parse("05-01", "08-31").days() == 123
    with pytest.raises(WindowError):
        Window.parse("02-29", "06-30")  # not every year has it
    with pytest.raises(WindowError):
        Window.parse("13-01", "06-30")


@pytest.mark.parametrize(("start", "end"), [("05-01", "05-01"), ("05-01", "05-20"), ("01-01", "12-31")])
def test_window_rejects_empty_short_and_long_periods(start, end):
    with pytest.raises(WindowError):
        Window.parse(start, end).validate(60, 240)


def test_latest_complete_year_respects_data_lag():
    w = Window.parse("05-01", "08-31")
    assert weather.latest_complete_year(w, date(2026, 9, 27), 7) == 2026
    assert weather.latest_complete_year(w, date(2026, 9, 3), 7) == 2025  # ended only 3 days ago
    south = Window.parse("11-01", "03-31")
    assert weather.latest_complete_year(south, date(2026, 9, 27), 7) == 2025  # Nov 2025 – Mar 2026


def test_normalize_keeps_gaps_as_none():
    block = {"T2M": {"20250501": 10.0, "20250502": -999.0}, "PRECTOTCORR": {"20250501": 1.5}}
    s = weather.normalize_power(block, ["T2M", "PRECTOTCORR", "RH2M"], date(2025, 5, 1), date(2025, 5, 3))
    assert s.values["T2M"] == [10.0, None, None]
    assert s.values["PRECTOTCORR"] == [1.5, None, None]
    assert s.values["RH2M"] == [None, None, None]


def _series(start, end, **const):
    params = MODEL["data"]["parameters"]
    s = weather.demo_series(params, start, end, 45.0)
    for p, v in const.items():
        s.values[p] = [v] * len(s.dates) if not callable(v) else [v(i) for i in range(len(s.dates))]
    return s


def test_features_use_configured_thresholds():
    start, end = date(2025, 5, 1), date(2025, 6, 29)  # 60 days
    s = _series(
        start,
        end,
        T2M_MAX=lambda i: 31.0 if i < 10 else 25.0,
        T2M_MIN=lambda i: -1.0 if i < 3 else 12.0,
        PRECTOTCORR=lambda i: 25.0 if i in (20, 40) else (0.0 if 21 <= i <= 35 else 2.0),
    )
    season = weather.build_season(s, 2025, Window.parse("05-01", "06-29"), 45.0, 300, MODEL)
    f = season.features
    assert season.complete and not season.unavailable
    assert f["hot_days"] == 10  # T2M_MAX ≥ 30 °C
    assert f["frost_days"] == 3  # T2M_MIN < 0 °C
    assert f["heavy_rain_days"] == 2  # ≥ 20 mm
    assert f["longest_dry_spell_days"] == 15  # days 21–35 below 1 mm
    assert f["rain_total_mm"] == pytest.approx(50 + 2 * 43, abs=0.1)
    assert season.et0_method.startswith("FAO-56")


def test_missing_optional_parameter_switches_to_labelled_fallback():
    start, end = date(2025, 5, 1), date(2025, 6, 29)
    s = _series(start, end)
    s.values["WS2M"] = [None] * len(s.dates)
    season = weather.build_season(s, 2025, Window.parse("05-01", "06-29"), 45.0, 300, MODEL)
    assert season.complete
    assert season.unavailable == ["WS2M"]
    assert season.features["ws_mean_m_s"] is None and season.features["windy_days"] is None
    assert "Hargreaves" in season.et0_method


def test_too_many_gaps_in_required_parameter_make_season_incomplete():
    start, end = date(2025, 5, 1), date(2025, 6, 29)
    s = _series(start, end)
    s.values["PRECTOTCORR"] = [None if i % 5 == 0 else 1.0 for i in range(len(s.dates))]  # 20 % missing
    season = weather.build_season(s, 2025, Window.parse("05-01", "06-29"), 45.0, 300, MODEL)
    assert not season.complete
    assert len(season.gaps["PRECTOTCORR"]) == 12


def test_et0_is_physically_plausible():
    hot_dry = weather.et0_penman_monteith(35, 20, 25, 3, 28, 40, 190, 300)
    cool_humid = weather.et0_penman_monteith(18, 10, 85, 1, 12, 40, 190, 300)
    assert 7 < hot_dry < 12
    assert 1 < cool_humid < 3.5


@pytest.mark.parametrize(
    ("lat", "start", "end", "name"),
    [
        (45, date(2025, 6, 1), date(2025, 8, 31), "summer"),
        (-35, date(2025, 6, 1), date(2025, 8, 31), "winter"),
        (-35, date(2025, 11, 15), date(2026, 2, 28), "summer"),
        (45, date(2025, 3, 1), date(2025, 5, 31), "spring"),
        (5, date(2025, 6, 1), date(2025, 8, 31), "tropical"),
    ],
)
def test_season_names_follow_hemisphere(lat, start, end, name):
    assert weather.season_name(lat, start, end) == name


def test_anomaly_needs_enough_reference_years():
    seasons = []
    for year in range(2010, 2020):
        s = _series(
            date(year, 5, 1),
            date(year, 6, 29),
            T2M_MAX=lambda i, y=year: 32.0 if i < (40 if y == 2019 else y - 2010) else 25.0,
        )
        seasons.append(weather.build_season(s, year, Window.parse("05-01", "06-29"), 45.0, 300, MODEL))
    target = seasons[-1]
    ref = weather.reference_stats(seasons, exclude_year=2019)
    assert ref["years"] == list(range(2010, 2019))
    result = weather.anomalies(target, ref, min_years=8, z_threshold=1.0)
    assert result["available"] and "hot" in result["flags"]
    too_short = weather.anomalies(target, weather.reference_stats(seasons[-3:], 2019), min_years=8, z_threshold=1.0)
    assert not too_short["available"] and too_short["flags"] == []
