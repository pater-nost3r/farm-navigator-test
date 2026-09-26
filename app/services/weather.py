"""Daily NASA POWER series → growing-season records the game can use.

Three kinds of values are kept apart (and labelled in the API):
- measured: NASA POWER daily values exactly as received (gaps stay gaps);
- features: counts and sums computed from those values with the game thresholds
  in game_model.json (weather_thresholds), e.g. days with T2M_MAX ≥ 30 °C;
- model inputs: the same series with small gaps filled (temperature/humidity/wind/
  radiation interpolated, missing rain = 0 mm), plus reference evapotranspiration.
  Gap filling is a game-model assumption and is reported per season.
"""

import math
from collections.abc import Sequence
from dataclasses import dataclass, field
from datetime import date, timedelta
from statistics import mean, pstdev
from typing import Any

FILL_VALUE = -999.0
TROPIC_LAT = 23.44
PARAM_UNITS_FALLBACK = {
    "T2M": "C",
    "T2M_MAX": "C",
    "T2M_MIN": "C",
    "PRECTOTCORR": "mm/day",
    "RH2M": "%",
    "WS2M": "m/s",
    "ALLSKY_SFC_SW_DWN": "MJ/m^2/day",
}


class WindowError(ValueError):
    pass


def parse_md(text: str) -> tuple[int, int]:
    """'MM-DD' → (month, day). 29 February is rejected so every year has the same window."""
    try:
        month_s, day_s = text.split("-")
        month, day = int(month_s), int(day_s)
        date(2001, month, day)  # non-leap year validates the day
    except (ValueError, AttributeError):
        raise WindowError(f"'{text}' is not a valid MM-DD date (29 Feb is not allowed)") from None
    return month, day


@dataclass(frozen=True)
class Window:
    """A calendar growing window, e.g. 05-01 → 08-31, or 11-01 → 03-31 (crosses the new year)."""

    start_md: tuple[int, int]
    end_md: tuple[int, int]

    @classmethod
    def parse(cls, start: str, end: str) -> "Window":
        return cls(parse_md(start), parse_md(end))

    @property
    def crosses_year(self) -> bool:
        return self.end_md < self.start_md

    def dates(self, year: int) -> tuple[date, date]:
        """Season that STARTS in `year`."""
        start = date(year, *self.start_md)
        end = date(year + 1 if self.crosses_year else year, *self.end_md)
        return start, end

    def days(self, year: int = 2001) -> int:
        start, end = self.dates(year)
        return (end - start).days + 1

    def label(self) -> str:
        return f"{self.start_md[0]:02d}-{self.start_md[1]:02d}/{self.end_md[0]:02d}-{self.end_md[1]:02d}"

    def validate(self, min_days: int, max_days: int) -> None:
        if self.start_md == self.end_md:
            raise WindowError("the growing period is empty: start and end are the same day")
        days = self.days()
        if days < min_days:
            raise WindowError(f"the growing period is {days} days; the game needs at least {min_days}")
        if days > max_days:
            raise WindowError(f"the growing period is {days} days; the game allows at most {max_days}")


def latest_complete_year(window: Window, today: date, lag_days: int) -> int:
    """Latest start year whose whole window ended at least `lag_days` before today."""
    year = today.year
    while window.dates(year)[1] > today - timedelta(days=lag_days):
        year -= 1
    return year


@dataclass
class DailySeries:
    dates: list[date]
    values: dict[str, list[float | None]]

    def slice(self, start: date, end: date) -> "DailySeries":
        if not self.dates or start < self.dates[0] or end > self.dates[-1]:
            raise KeyError(f"{start}–{end} is outside the downloaded series")
        i = (start - self.dates[0]).days
        j = (end - self.dates[0]).days + 1
        return DailySeries(self.dates[i:j], {p: v[i:j] for p, v in self.values.items()})


def normalize_power(parameter_block: dict[str, Any], params: Sequence[str], start: date, end: date) -> DailySeries:
    """POWER `properties.parameter` ({PARAM: {YYYYMMDD: value}}) → aligned daily lists; -999 and absent days → None."""
    days = (end - start).days + 1
    dates = [start + timedelta(days=i) for i in range(days)]
    keys = [d.strftime("%Y%m%d") for d in dates]
    values: dict[str, list[float | None]] = {}
    for p in params:
        raw = parameter_block.get(p) or {}
        column: list[float | None] = []
        for k in keys:
            v = raw.get(k)
            if isinstance(v, (int, float)) and not isinstance(v, bool) and v != FILL_VALUE and math.isfinite(v):
                column.append(float(v))
            else:
                column.append(None)
        values[p] = column
    return DailySeries(dates, values)


def _interpolate(column: list[float | None]) -> list[float]:
    known = [i for i, v in enumerate(column) if v is not None]
    if not known:
        return [0.0] * len(column)
    out: list[float] = []
    for i, v in enumerate(column):
        if v is not None:
            out.append(v)
            continue
        left = max((k for k in known if k < i), default=None)
        right = min((k for k in known if k > i), default=None)
        if left is None:
            out.append(column[right])  # type: ignore[index,arg-type]
        elif right is None:
            out.append(column[left])  # type: ignore[arg-type]
        else:
            lv, rv = column[left], column[right]
            out.append(lv + (rv - lv) * (i - left) / (right - left))  # type: ignore[operator]
    return out


# ---------- Reference evapotranspiration ----------


def _e0(t: float) -> float:
    return 0.6108 * math.exp(17.27 * t / (t + 237.3))


def extraterrestrial_radiation(lat_deg: float, doy: int) -> float:
    """Ra, MJ/m²/day (FAO-56 eq. 21)."""
    phi = math.radians(lat_deg)
    dr = 1 + 0.033 * math.cos(2 * math.pi * doy / 365)
    delta = 0.409 * math.sin(2 * math.pi * doy / 365 - 1.39)
    ws = math.acos(max(-1.0, min(1.0, -math.tan(phi) * math.tan(delta))))
    return max(
        0.0,
        24
        * 60
        / math.pi
        * 0.0820
        * dr
        * (ws * math.sin(phi) * math.sin(delta) + math.cos(phi) * math.cos(delta) * math.sin(ws)),
    )


def et0_penman_monteith(
    tmax: float, tmin: float, rh: float, u2: float, rs: float, lat: float, doy: int, elevation_m: float
) -> float:
    """FAO-56 Penman–Monteith daily reference evapotranspiration, mm/day."""
    tmean = (tmax + tmin) / 2
    pressure = 101.3 * ((293 - 0.0065 * elevation_m) / 293) ** 5.26
    gamma = 0.000665 * pressure
    es = (_e0(tmax) + _e0(tmin)) / 2
    ea = max(0.0, min(1.0, rh / 100)) * es
    slope = 4098 * _e0(tmean) / (tmean + 237.3) ** 2
    ra = extraterrestrial_radiation(lat, doy)
    rso = (0.75 + 2e-5 * elevation_m) * ra
    rel = min(1.0, rs / rso) if rso > 0 else 0.5
    rnl = (
        4.903e-9
        * ((tmax + 273.16) ** 4 + (tmin + 273.16) ** 4)
        / 2
        * (0.34 - 0.14 * math.sqrt(ea))
        * (1.35 * rel - 0.35)
    )
    rn = 0.77 * rs - rnl
    et0 = (0.408 * slope * rn + gamma * 900 / (tmean + 273) * u2 * (es - ea)) / (slope + gamma * (1 + 0.34 * u2))
    return max(0.0, et0)


def et0_hargreaves(tmax: float, tmin: float, lat: float, doy: int) -> float:
    """Hargreaves–Samani, mm/day: used only when humidity, wind or radiation are unavailable."""
    tmean = (tmax + tmin) / 2
    ra = extraterrestrial_radiation(lat, doy)
    return max(0.0, 0.0023 * (tmean + 17.8) * math.sqrt(max(0.0, tmax - tmin)) * ra * 0.408)


# ---------- Seasons ----------


@dataclass
class Season:
    year: int
    start: date
    end: date
    measured: DailySeries
    complete: bool
    gaps: dict[str, list[str]]
    unavailable: list[str]
    features: dict[str, Any]
    model: dict[str, list[float]] = field(repr=False)
    et0_method: str = "FAO-56 Penman-Monteith"

    @property
    def days(self) -> int:
        return len(self.measured.dates)

    def summary(self) -> dict[str, Any]:
        return {
            "year": self.year,
            "start": self.start.isoformat(),
            "end": self.end.isoformat(),
            "days": self.days,
            "complete": self.complete,
            "gaps": {p: g for p, g in self.gaps.items() if g},
            "unavailable_parameters": self.unavailable,
            "features": self.features,
            "et0_method": self.et0_method,
        }

    def daily(self) -> dict[str, Any]:
        """Measured values (None = gap) for charts and reports."""
        return {
            "dates": [d.isoformat() for d in self.measured.dates],
            **{p: [None if v is None else round(v, 2) for v in col] for p, col in self.measured.values.items()},
        }


def _longest_run(flags: Sequence[bool]) -> int:
    best = run = 0
    for f in flags:
        run = run + 1 if f else 0
        best = max(best, run)
    return best


def build_season(
    series: DailySeries, year: int, window: Window, latitude: float, elevation_m: float, model: dict[str, Any]
) -> Season:
    data_cfg, th = model["data"], model["weather_thresholds"]
    start, end = window.dates(year)
    s = series.slice(start, end)
    n = len(s.dates)
    max_missing = data_cfg["max_missing_share"]
    gaps = {p: [d.isoformat() for d, v in zip(s.dates, col, strict=True) if v is None] for p, col in s.values.items()}
    share = {p: len(g) / n for p, g in gaps.items()}
    complete = all(share.get(p, 1.0) <= max_missing for p in data_cfg["required_parameters"])
    unavailable = [
        p
        for p in data_cfg["parameters"]
        if p not in data_cfg["required_parameters"] and share.get(p, 1.0) > max_missing
    ]

    v = s.values

    def present(p: str) -> list[float]:
        return [x for x in v.get(p, []) if x is not None]

    rain, tmax, tmin, t2m = present("PRECTOTCORR"), present("T2M_MAX"), present("T2M_MIN"), present("T2M")

    def avg(xs: list[float], d: int = 1) -> float | None:
        return round(mean(xs), d) if xs else None

    filled = {p: (_interpolate(v[p]) if p != "PRECTOTCORR" else [x if x is not None else 0.0 for x in v[p]]) for p in v}
    use_pm = not unavailable
    et0: list[float] = []
    for i, d in enumerate(s.dates):
        doy = d.timetuple().tm_yday
        if use_pm:
            et0.append(
                et0_penman_monteith(
                    filled["T2M_MAX"][i],
                    filled["T2M_MIN"][i],
                    filled["RH2M"][i],
                    filled["WS2M"][i],
                    filled["ALLSKY_SFC_SW_DWN"][i],
                    latitude,
                    doy,
                    elevation_m,
                )
            )
        else:
            et0.append(et0_hargreaves(filled["T2M_MAX"][i], filled["T2M_MIN"][i], latitude, doy))

    rain_col = v["PRECTOTCORR"]
    ws = present("WS2M") if "WS2M" not in unavailable else []
    features: dict[str, Any] = {
        "rain_total_mm": round(sum(rain), 1),
        "rain_missing_days": len(gaps["PRECTOTCORR"]),
        "t_mean_c": avg(t2m) if t2m else avg([(a + b) / 2 for a, b in zip(tmax, tmin, strict=False)]),
        "tmax_mean_c": avg(tmax),
        "tmin_mean_c": avg(tmin),
        "hot_days": sum(1 for x in tmax if x >= th["hot_day_tmax_c"]),
        "extreme_heat_days": sum(1 for x in tmax if x >= th["extreme_heat_tmax_c"]),
        "frost_days": sum(1 for x in tmin if x < th["frost_tmin_c"]),
        "heavy_rain_days": sum(1 for x in rain if x >= th["heavy_rain_day_mm"]),
        "longest_dry_spell_days": _longest_run([x is not None and x < th["dry_day_precip_mm"] for x in rain_col]),
        "rh_mean_pct": None if "RH2M" in unavailable else avg(present("RH2M")),
        "ws_mean_m_s": None if "WS2M" in unavailable else avg(ws, 2),
        "windy_days": None if "WS2M" in unavailable else sum(1 for x in ws if x >= th["windy_day_ws2m_m_s"]),
        "solar_mean_mj_m2_day": None if "ALLSKY_SFC_SW_DWN" in unavailable else avg(present("ALLSKY_SFC_SW_DWN")),
        "et0_total_mm": round(sum(et0), 0),
    }
    model_inputs = {
        "tmax": filled["T2M_MAX"],
        "tmin": filled["T2M_MIN"],
        "rain": filled["PRECTOTCORR"],
        "et0": et0,
        "ws": filled.get("WS2M", [0.0] * n),
        "rh": filled.get("RH2M", [0.0] * n),
    }
    return Season(
        year,
        start,
        end,
        s,
        complete,
        gaps,
        unavailable,
        features,
        model_inputs,
        "FAO-56 Penman-Monteith" if use_pm else "Hargreaves-Samani (fallback)",
    )


# ---------- Reference period and anomalies ----------

REFERENCE_FEATURES = ("rain_total_mm", "hot_days", "t_mean_c", "heavy_rain_days", "longest_dry_spell_days")


def reference_stats(seasons: Sequence[Season], exclude_year: int | None = None) -> dict[str, Any]:
    pool = [s for s in seasons if s.complete and s.year != exclude_year]
    stats: dict[str, Any] = {"years": [s.year for s in pool]}
    for f in REFERENCE_FEATURES:
        xs = [s.features[f] for s in pool if s.features[f] is not None]
        stats[f] = {"mean": round(mean(xs), 1), "sd": round(pstdev(xs), 2)} if xs else None
    return stats


def anomalies(season: Season, ref: dict[str, Any], min_years: int, z_threshold: float) -> dict[str, Any]:
    """Compare a season with the other years of the same point and window. No reference → no claims."""
    if len(ref["years"]) < min_years:
        return {"available": False, "reference_years": ref["years"], "flags": [], "z": {}}
    z: dict[str, float] = {}
    for f in REFERENCE_FEATURES:
        st = ref.get(f)
        x = season.features.get(f)
        if st and x is not None and st["sd"] > 0:
            z[f] = round((x - st["mean"]) / st["sd"], 2)
    flags = []
    if z.get("hot_days", 0) >= z_threshold and season.features["hot_days"] > 0:
        flags.append("hot")
    if z.get("t_mean_c", 0) >= z_threshold:
        flags.append("warm")
    if z.get("rain_total_mm", 0) <= -z_threshold:
        flags.append("dry")
    if z.get("rain_total_mm", 0) >= z_threshold or z.get("heavy_rain_days", 0) >= z_threshold:
        flags.append("wet")
    return {"available": True, "reference_years": ref["years"], "flags": flags, "z": z}


def season_name(latitude: float, start: date, end: date) -> str:
    """Temperate season of the window's midpoint, hemisphere-aware; 'tropical' near the equator."""
    if abs(latitude) < TROPIC_LAT:
        return "tropical"
    mid = start + (end - start) / 2
    names = {
        12: "winter",
        1: "winter",
        2: "winter",
        3: "spring",
        4: "spring",
        5: "spring",
        6: "summer",
        7: "summer",
        8: "summer",
        9: "autumn",
        10: "autumn",
        11: "autumn",
    }
    month = mid.month if latitude >= 0 else (mid.month + 5) % 12 + 1
    return names[month]


# ---------- Demo data ----------


def demo_series(params: Sequence[str], start: date, end: date, latitude: float) -> DailySeries:
    """Deterministic synthetic 'semi-arid steppe' weather. NOT a record of any real place or year:
    always labelled Demo. Southern-hemisphere requests get the seasonal cycle shifted by half a year."""
    days = (end - start).days + 1
    dates = [start + timedelta(days=i) for i in range(days)]
    cols: dict[str, list[float | None]] = {p: [] for p in params}

    def rnd(*key: int) -> float:
        h = 2166136261
        for k in key:
            h = ((h ^ (k & 0xFFFFFFFF)) * 16777619) & 0xFFFFFFFF
        h ^= h >> 13
        h = (h * 0x5BD1E995) & 0xFFFFFFFF
        h ^= h >> 15
        return (h & 0xFFFFFF) / 0x1000000

    for d in dates:
        shifted = d + timedelta(days=182) if latitude < 0 else d
        doy = shifted.timetuple().tm_yday
        y = shifted.year
        rain_mult = 0.45 + 1.2 * rnd(y, 1)
        heat = -1.5 + 4.0 * rnd(y, 2)
        season = math.sin(2 * math.pi * (doy - 105) / 365)
        tmean = 11 + 14 * season + heat + 3 * (rnd(d.toordinal(), 3) - 0.5)
        tmax, tmin = tmean + 7, tmean - 7
        wet_day = rnd(d.toordinal(), 4) < 0.2 + 0.08 * math.cos(2 * math.pi * (doy - 130) / 365)
        amount = -6.5 * rain_mult * math.log(max(1e-6, rnd(d.toordinal(), 5))) if wet_day else 0.0
        values = {
            "T2M": tmean,
            "T2M_MAX": tmax,
            "T2M_MIN": tmin,
            "PRECTOTCORR": amount,
            "RH2M": max(20.0, min(95.0, 58 - 1.1 * (tmean - 15) + (18 if wet_day else 0))),
            "WS2M": 2.2 + 2.4 * rnd(d.toordinal(), 6),
            "ALLSKY_SFC_SW_DWN": max(3.0, 15 + 10 * season - (7 if wet_day else 0)),
        }
        for p in params:
            cols[p].append(round(values[p], 2))
    return DailySeries(dates, cols)
