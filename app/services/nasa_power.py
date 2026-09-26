"""NASA POWER daily point API client.

Docs: https://power.larc.nasa.gov/docs/services/api/temporal/daily/
NASA POWER is public and does not require an API key, so NASA_API_KEY is
never sent to it.

Two views of the same data:
- get_conditions: one period, aggregated (used by the /api/game flow). Falls
  back to clearly-labelled demo values if POWER is unavailable.
- get_climate_history: the last N complete growing seasons in ONE request,
  aggregated per season (used by the level-based game). Raises
  NasaPowerError instead of inventing data; the frontend decides whether to
  use its browser cache or clearly-labelled demo data.
"""

import json
import logging
from datetime import UTC, date, datetime, timedelta
from pathlib import Path
from statistics import mean

import httpx

from app.config import Settings
from app.models.climate import ClimateBaseline, ClimateHistory, SeasonClimate
from app.models.game import ClimateConditions, ClimateReport, Period
from app.services.cache import TTLCache
from app.services.game_engine import classify_drought_risk

logger = logging.getLogger(__name__)

DATA_DIR = Path(__file__).resolve().parent.parent / "data"

SOURCE_REAL = "NASA POWER"
SOURCE_DEMO = "Demo fallback data (NASA POWER unavailable)"
COMMUNITY = "AG"

# Real, documented POWER parameters (community AG).
PARAMETERS = {
    "T2M": "average_temperature_c",           # Temperature at 2 m, °C
    "PRECTOTCORR": "total_rainfall_mm",       # Precipitation corrected, mm/day
    "RH2M": "average_humidity_percent",       # Relative humidity at 2 m, %
    "WS2M": "average_wind_speed_m_s",         # Wind speed at 2 m, m/s
    "ALLSKY_SFC_SW_DWN": "solar_radiation",   # All-sky surface shortwave downward irradiance, MJ/m²/day
}
FILL_VALUE = -999.0
MAX_MISSING_SHARE = 0.2

# Growing-season history
HISTORY_YEARS = 10
MIN_HISTORY_SEASONS = 5
# POWER publishes daily values a few days late; only use seasons that ended at least this long ago.
DATA_LAG_DAYS = 14
HEAVY_RAIN_MM = 20.0
HOT_DAY_C = 25.0
DRY_DAY_MM = 1.0

LIMITATIONS_REAL = (
    "NASA POWER represents regional gridded conditions and not an exact field measurement. "
    "Values come from satellite observations and reanalysis models (tens of kilometres per grid cell), "
    "so a cell that includes mountains or water can differ from conditions at a specific farm; "
    "recent days may be provisional near-real-time data."
)
LIMITATIONS_HISTORY = (
    LIMITATIONS_REAL
    + " These are historical records of past seasons, not a weather forecast."
)
LIMITATIONS_DEMO = (
    "NASA POWER was unavailable ({reason}), so illustrative demo values were used. "
    "They are not tied to this location or period and must not be read as real conditions."
)


class NasaPowerError(Exception):
    def __init__(self, message: str, kind: str = "unavailable"):
        super().__init__(message)
        self.kind = kind  # timeout | network | http | format | incomplete


def growing_season(latitude: float, year: int) -> tuple[date, date]:
    """Growing season that ends in `year`: May–Aug (north) or Nov–Feb (south)."""
    if latitude >= 0:
        return date(year, 5, 1), date(year, 8, 31)
    return date(year - 1, 11, 1), date(year, 3, 1) - timedelta(days=1)


def recent_season_years(latitude: float, today: date, count: int = HISTORY_YEARS) -> list[int]:
    """The `count` most recent growing seasons whose data are complete, oldest first."""
    year = today.year
    while growing_season(latitude, year)[1] > today - timedelta(days=DATA_LAG_DAYS):
        year -= 1
    return list(range(year - count + 1, year + 1))


def _valid(value: object) -> bool:
    return isinstance(value, (int, float)) and value != FILL_VALUE


def aggregate_season(daily: dict, start: date, end: date, year: int) -> SeasonClimate:
    """Aggregate POWER daily series (keys YYYYMMDD) for one season."""
    days = (end - start).days + 1
    keys = [(start + timedelta(days=i)).strftime("%Y%m%d") for i in range(days)]
    series: dict[str, list[float]] = {}
    missing = 0
    for name in PARAMETERS:
        raw = daily.get(name) or {}
        values = [float(raw[k]) for k in keys if _valid(raw.get(k))]
        if len(values) < days * (1 - MAX_MISSING_SHARE):
            raise NasaPowerError(f"too many missing values for {name} in {year}", "incomplete")
        missing += days - len(values)
        series[name] = values

    rain_raw = daily.get("PRECTOTCORR") or {}
    rain_days = [float(rain_raw[k]) for k in keys if _valid(rain_raw.get(k))]
    longest = run = 0
    for k in keys:
        v = rain_raw.get(k)
        dry = isinstance(v, (int, float)) and v != FILL_VALUE and v < DRY_DAY_MM
        run = run + 1 if dry else 0
        longest = max(longest, run)

    # Scale rainfall up if a few days are missing so totals stay comparable.
    rainfall = sum(series["PRECTOTCORR"]) * days / len(series["PRECTOTCORR"])
    return SeasonClimate(
        year=year,
        start=start,
        end=end,
        days=days,
        temperature_c=round(mean(series["T2M"]), 1),
        rainfall_mm=round(rainfall, 1),
        humidity_percent=round(mean(series["RH2M"]), 1),
        wind_speed_m_s=round(mean(series["WS2M"]), 2),
        solar_radiation_mj_m2_day=round(mean(series["ALLSKY_SFC_SW_DWN"]), 1),
        heavy_rain_days=sum(1 for v in rain_days if v >= HEAVY_RAIN_MM),
        hot_days=sum(1 for v in series["T2M"] if v >= HOT_DAY_C),
        longest_dry_spell_days=longest,
        missing_share=round(missing / (days * len(PARAMETERS)), 3),
    )


def baseline_of(seasons: list[SeasonClimate]) -> ClimateBaseline:
    return ClimateBaseline(
        temperature_c=round(mean(s.temperature_c for s in seasons), 1),
        rainfall_mm=round(mean(s.rainfall_mm for s in seasons), 1),
        humidity_percent=round(mean(s.humidity_percent for s in seasons), 1),
        wind_speed_m_s=round(mean(s.wind_speed_m_s for s in seasons), 2),
        solar_radiation_mj_m2_day=round(mean(s.solar_radiation_mj_m2_day for s in seasons), 1),
        heavy_rain_days=round(mean(s.heavy_rain_days for s in seasons), 1),
    )


class NasaPowerService:
    def __init__(self, settings: Settings, client: httpx.AsyncClient | None = None):
        self._settings = settings
        # None = open a short-lived client per request (safe on serverless runtimes).
        self._client = client
        self._cache: TTLCache[ClimateReport] = TTLCache(settings.cache_ttl_seconds)
        self._history_cache: TTLCache[ClimateHistory] = TTLCache(settings.cache_ttl_seconds)
        self._fallback = json.loads((DATA_DIR / "fallback_conditions.json").read_text(encoding="utf-8"))

    async def get_conditions(
        self, latitude: float, longitude: float, start: date, end: date, fallback_profile: str = "default"
    ) -> ClimateReport:
        """Real NASA POWER conditions, or clearly-labelled demo data if POWER fails."""
        key = (round(latitude, 4), round(longitude, 4), start, end)
        cached = self._cache.get(key)
        if cached is not None:
            return cached
        try:
            daily = await self._fetch_daily(latitude, longitude, start, end)
            report = self._aggregate(daily, start, end)
        except NasaPowerError as exc:
            logger.warning("NASA POWER unavailable, using fallback data: %s", exc)
            return self._demo_report(start, end, fallback_profile, str(exc))
        self._cache.set(key, report)
        return report

    async def get_climate_history(
        self, latitude: float, longitude: float, today: date | None = None, years: int = HISTORY_YEARS
    ) -> tuple[ClimateHistory, bool]:
        """Last `years` growing seasons at a location. Returns (history, served_from_cache)."""
        season_years = recent_season_years(latitude, today or date.today(), years)
        # POWER cells are 0.5° × 0.625°, so 0.01° rounding never merges different cells' data by mistake.
        key = (round(latitude, 2), round(longitude, 2), tuple(season_years))
        cached = self._history_cache.get(key)
        if cached is not None:
            return cached, True

        start = growing_season(latitude, season_years[0])[0]
        end = growing_season(latitude, season_years[-1])[1]
        daily = await self._fetch_daily(latitude, longitude, start, end)
        seasons: list[SeasonClimate] = []
        for year in season_years:
            s_start, s_end = growing_season(latitude, year)
            try:
                seasons.append(aggregate_season(daily, s_start, s_end, year))
            except NasaPowerError as exc:
                logger.info("Skipping incomplete season: %s", exc)
        if len(seasons) < MIN_HISTORY_SEASONS:
            raise NasaPowerError(f"only {len(seasons)} complete seasons available", "incomplete")

        north = latitude >= 0
        history = ClimateHistory(
            hemisphere="north" if north else "south",
            season_months="May–Aug" if north else "Nov–Feb",
            seasons=seasons,
            baseline=baseline_of(seasons),
            source=SOURCE_REAL,
            parameters=list(PARAMETERS),
            community=COMMUNITY,
            fetched_at=datetime.now(UTC).replace(microsecond=0),
            is_demo=False,
            limitations=LIMITATIONS_HISTORY,
        )
        self._history_cache.set(key, history)
        return history, False

    async def _get(self, params: dict[str, str]) -> httpx.Response:
        url = self._settings.nasa_power_base_url
        timeout = self._settings.nasa_timeout_seconds
        if self._client is not None:
            return await self._client.get(url, params=params, timeout=timeout)
        async with httpx.AsyncClient() as client:
            return await client.get(url, params=params, timeout=timeout)

    async def _fetch_daily(self, latitude: float, longitude: float, start: date, end: date) -> dict:
        params = {
            "parameters": ",".join(PARAMETERS),
            "community": COMMUNITY,
            "latitude": f"{latitude:.4f}",
            "longitude": f"{longitude:.4f}",
            "start": start.strftime("%Y%m%d"),
            "end": end.strftime("%Y%m%d"),
            "format": "JSON",
        }
        try:
            response = await self._get(params)
        except httpx.TimeoutException:
            raise NasaPowerError("request timed out", "timeout") from None
        except httpx.HTTPError as exc:
            raise NasaPowerError(f"network error: {type(exc).__name__}", "network") from None
        if response.status_code != 200:
            raise NasaPowerError(f"HTTP {response.status_code}", "http")
        try:
            parameter = response.json()["properties"]["parameter"]
        except (ValueError, KeyError, TypeError):
            raise NasaPowerError("unexpected response format", "format") from None
        if not isinstance(parameter, dict):
            raise NasaPowerError("unexpected response format", "format")
        return parameter

    def _aggregate(self, daily: dict, start: date, end: date) -> ClimateReport:
        values: dict[str, list[float]] = {}
        for power_name in PARAMETERS:
            series = daily.get(power_name) or {}
            valid = [v for v in series.values() if isinstance(v, (int, float)) and v != FILL_VALUE]
            if not series or len(valid) < len(series) * (1 - MAX_MISSING_SHARE):
                raise NasaPowerError(f"too many missing values for {power_name}", "incomplete")
            values[power_name] = valid

        days = (end - start).days + 1
        temperature = mean(values["T2M"])
        humidity = mean(values["RH2M"])
        # Scale rainfall up if a few days are missing so totals stay comparable.
        rainfall = sum(values["PRECTOTCORR"]) * days / len(values["PRECTOTCORR"])
        conditions = ClimateConditions(
            average_temperature_c=round(temperature, 1),
            total_rainfall_mm=round(rainfall, 1),
            average_humidity_percent=round(humidity),
            average_wind_speed_m_s=round(mean(values["WS2M"]), 1),
            solar_radiation=round(mean(values["ALLSKY_SFC_SW_DWN"]), 1),
            drought_risk=classify_drought_risk(rainfall, days, temperature, humidity),
        )
        return ClimateReport(
            conditions=conditions,
            source=SOURCE_REAL,
            period=Period(start=start, end=end),
            is_demo=False,
            limitations=LIMITATIONS_REAL,
        )

    def _demo_report(self, start: date, end: date, profile: str, reason: str) -> ClimateReport:
        profiles = self._fallback["profiles"]
        p = profiles.get(profile, profiles["default"])
        days = (end - start).days + 1
        rainfall = p["rainfall_mm_per_30_days"] * days / 30
        conditions = ClimateConditions(
            average_temperature_c=p["average_temperature_c"],
            total_rainfall_mm=round(rainfall, 1),
            average_humidity_percent=p["average_humidity_percent"],
            average_wind_speed_m_s=p["average_wind_speed_m_s"],
            solar_radiation=p["solar_radiation"],
            drought_risk=classify_drought_risk(
                rainfall, days, p["average_temperature_c"], p["average_humidity_percent"]
            ),
        )
        return ClimateReport(
            conditions=conditions,
            source=SOURCE_DEMO,
            period=Period(start=start, end=end),
            is_demo=True,
            limitations=LIMITATIONS_DEMO.format(reason=reason),
        )
