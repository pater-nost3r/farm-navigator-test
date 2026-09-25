"""Core domain models shared by the NASA service, the game engine and the API."""

from datetime import date
from enum import Enum
from typing import Literal

from pydantic import BaseModel, Field


class Crop(str, Enum):
    WHEAT = "wheat"
    CORN = "corn"
    CHICKPEA = "chickpea"


class Irrigation(str, Enum):
    NONE = "none"
    LOW = "low"
    MEDIUM = "medium"
    HIGH = "high"


class Fertilizer(str, Enum):
    NONE = "none"
    ORGANIC = "organic"
    MINERAL = "mineral"


class Difficulty(str, Enum):
    EASY = "easy"
    NORMAL = "normal"
    HARD = "hard"


class Level(str, Enum):
    LOW = "low"
    MEDIUM = "medium"
    HIGH = "high"


class Location(BaseModel):
    name: str = Field(default="Custom location", max_length=100, examples=["Almaty"])
    latitude: float = Field(ge=-90, le=90, examples=[43.24])
    longitude: float = Field(ge=-180, le=180, examples=[76.95])


class Coordinates(BaseModel):
    latitude: float
    longitude: float


class Period(BaseModel):
    start: date
    end: date

    @property
    def days(self) -> int:
        return (self.end - self.start).days + 1


class ClimateConditions(BaseModel):
    average_temperature_c: float
    total_rainfall_mm: float
    average_humidity_percent: int
    average_wind_speed_m_s: float
    solar_radiation: float = Field(description="All-sky surface shortwave radiation, MJ/m²/day")
    drought_risk: Level


class ClimateReport(BaseModel):
    """Climate conditions plus the provenance every response must carry."""

    conditions: ClimateConditions
    source: str
    period: Period
    is_demo: bool
    limitations: str
    units: dict[str, str] = {
        "average_temperature_c": "°C",
        "total_rainfall_mm": "mm",
        "average_humidity_percent": "%",
        "average_wind_speed_m_s": "m/s",
        "solar_radiation": "MJ/m²/day",
    }


class Decision(BaseModel):
    crop: Crop
    irrigation: Irrigation
    fertilizer: Fertilizer


class Changes(BaseModel):
    water: int
    budget: int
    soil_health: int
    crop_health: int
    sustainability_score: int


class Event(BaseModel):
    type: Literal["none", "drought", "heatwave", "cold_stress", "heavy_rain"]
    severity: Level


class Economics(BaseModel):
    expenses: int
    revenue: int


class WaterBalance(BaseModel):
    """All values are per 30 days so seasons of different length are comparable."""

    crop_need_mm: float
    rainfall_mm: float
    irrigation_mm: float
    coverage_percent: int


class SeasonRecord(BaseModel):
    season: int
    decision: Decision
    nasa_conditions: ClimateReport
    changes: Changes
    event: Event
    explanation: list[str]
    economics: Economics
    water_balance: WaterBalance
    crop_health: int


class GameState(BaseModel):
    game_id: str
    location: Location
    difficulty: Difficulty
    season: int
    max_seasons: int
    water: int
    budget: int
    soil_health: int
    crop_health: int
    sustainability_score: int
    starting_water: int
    starting_budget: int
    season_decided: bool = False
    finished: bool = False
    nasa_conditions: ClimateReport
    history: list[SeasonRecord] = []
