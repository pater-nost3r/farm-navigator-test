"""Models for multi-year NASA POWER growing-season history and geocoding."""

from datetime import date, datetime
from typing import Literal

from pydantic import BaseModel, Field

from app.models.game import Coordinates


class SeasonClimate(BaseModel):
    """One historical growing season, aggregated from NASA POWER daily values."""

    year: int = Field(description="Year the growing season ends in")
    start: date
    end: date
    days: int
    temperature_c: float = Field(description="Mean of daily T2M, °C")
    rainfall_mm: float = Field(description="Sum of daily PRECTOTCORR, mm")
    humidity_percent: float = Field(description="Mean of daily RH2M, %")
    wind_speed_m_s: float = Field(description="Mean of daily WS2M, m/s")
    solar_radiation_mj_m2_day: float = Field(description="Mean of daily ALLSKY_SFC_SW_DWN, MJ/m²/day")
    heavy_rain_days: int = Field(description="Days with PRECTOTCORR ≥ 20 mm")
    hot_days: int = Field(description="Days with daily mean T2M ≥ 25 °C")
    longest_dry_spell_days: int = Field(description="Longest run of days with PRECTOTCORR < 1 mm")
    missing_share: float = Field(description="Share of fill values (-999) skipped")


class ClimateBaseline(BaseModel):
    """Mean of the returned seasons: the 'normal' the game compares each season with."""

    temperature_c: float
    rainfall_mm: float
    humidity_percent: float
    wind_speed_m_s: float
    solar_radiation_mj_m2_day: float
    heavy_rain_days: float


class ClimateHistory(BaseModel):
    hemisphere: Literal["north", "south"]
    season_months: str
    seasons: list[SeasonClimate]
    baseline: ClimateBaseline
    source: str
    parameters: list[str]
    community: str
    fetched_at: datetime
    is_demo: bool
    limitations: str


class ClimateHistoryResponse(ClimateHistory):
    location: Coordinates
    status: Literal["live", "cached"] = Field(
        description="live = fetched from NASA POWER for this request; cached = served from the server cache"
    )


class Place(BaseModel):
    name: str
    country: str | None = None
    admin1: str | None = None
    latitude: float
    longitude: float


class GeocodeResponse(BaseModel):
    query: str
    results: list[Place]
    source: str
