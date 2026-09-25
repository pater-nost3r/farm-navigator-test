"""NASA POWER daily point API client.

Docs: https://power.larc.nasa.gov/docs/services/api/temporal/daily/
NASA POWER is public and does not require an API key, so NASA_API_KEY is
never sent to it. If POWER is unreachable or returns incomplete data, demo
fallback values are returned and clearly marked with is_demo=true.
"""

import json
import logging
from datetime import date
from pathlib import Path
from statistics import mean

import httpx

from app.config import Settings
from app.models.game import ClimateConditions, ClimateReport, Period
from app.services.game_engine import classify_drought_risk

logger = logging.getLogger(__name__)

DATA_DIR = Path(__file__).resolve().parent.parent / "data"

SOURCE_REAL = "NASA POWER"
SOURCE_DEMO = "Demo fallback data (NASA POWER unavailable)"

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

LIMITATIONS_REAL = (
    "NASA POWER represents regional gridded conditions and not an exact field measurement. "
    "Values come from satellite observations and reanalysis models (tens of kilometres per grid cell), "
    "so a cell that includes mountains or water can differ from conditions at a specific farm; "
    "recent days may be provisional near-real-time data."
)
LIMITATIONS_DEMO = (
    "NASA POWER was unavailable ({reason}), so illustrative demo values were used. "
    "They are not tied to this location or period and must not be read as real conditions."
)


class NasaPowerError(Exception):
    pass


class NasaPowerService:
    def __init__(self, settings: Settings, client: httpx.AsyncClient):
        self._settings = settings
        self._client = client
        self._cache: dict[tuple, ClimateReport] = {}
        self._fallback = json.loads((DATA_DIR / "fallback_conditions.json").read_text(encoding="utf-8"))

    async def get_conditions(
        self, latitude: float, longitude: float, start: date, end: date, fallback_profile: str = "default"
    ) -> ClimateReport:
        """Real NASA POWER conditions, or clearly-labelled demo data if POWER fails."""
        key = (round(latitude, 4), round(longitude, 4), start, end)
        if key in self._cache:
            return self._cache[key]
        try:
            daily = await self._fetch_daily(latitude, longitude, start, end)
            report = self._aggregate(daily, start, end)
        except NasaPowerError as exc:
            logger.warning("NASA POWER unavailable, using fallback data: %s", exc)
            return self._demo_report(start, end, fallback_profile, str(exc))
        self._cache[key] = report
        return report

    async def _fetch_daily(self, latitude: float, longitude: float, start: date, end: date) -> dict:
        params = {
            "parameters": ",".join(PARAMETERS),
            "community": "AG",
            "latitude": f"{latitude:.4f}",
            "longitude": f"{longitude:.4f}",
            "start": start.strftime("%Y%m%d"),
            "end": end.strftime("%Y%m%d"),
            "format": "JSON",
        }
        try:
            response = await self._client.get(
                self._settings.nasa_power_base_url, params=params, timeout=self._settings.nasa_timeout_seconds
            )
        except httpx.TimeoutException:
            raise NasaPowerError("request timed out") from None
        except httpx.HTTPError as exc:
            raise NasaPowerError(f"network error: {type(exc).__name__}") from None
        if response.status_code != 200:
            raise NasaPowerError(f"HTTP {response.status_code}")
        try:
            return response.json()["properties"]["parameter"]
        except (ValueError, KeyError, TypeError):
            raise NasaPowerError("unexpected response format") from None

    def _aggregate(self, daily: dict, start: date, end: date) -> ClimateReport:
        values: dict[str, list[float]] = {}
        for power_name in PARAMETERS:
            series = daily.get(power_name) or {}
            valid = [v for v in series.values() if isinstance(v, (int, float)) and v != FILL_VALUE]
            if not series or len(valid) < len(series) * (1 - MAX_MISSING_SHARE):
                raise NasaPowerError(f"too many missing values for {power_name}")
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
