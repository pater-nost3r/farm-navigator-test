from typing import Literal

from pydantic import BaseModel

from app.models.game import (
    Changes,
    ClimateConditions,
    ClimateReport,
    Coordinates,
    Decision,
    Difficulty,
    Economics,
    Event,
    Location,
    Period,
    SeasonRecord,
    WaterBalance,
)

DISCLAIMER = (
    "Farm Navigator is an educational game with a simplified crop model. "
    "It is not an agronomic forecast or farming advice."
)


class HealthResponse(BaseModel):
    status: Literal["ok"] = "ok"


class DataProvenance(BaseModel):
    """Fields included in every data-bearing response."""

    data_source: str
    period: Period
    is_demo: bool
    limitations: str
    disclaimer: str = DISCLAIMER


def provenance(report: ClimateReport) -> dict:
    return {
        "data_source": report.source,
        "period": report.period,
        "is_demo": report.is_demo,
        "limitations": report.limitations,
    }


class ConditionsResponse(BaseModel):
    location: Coordinates
    conditions: ClimateConditions
    source: str
    period: Period
    is_demo: bool
    limitations: str
    units: dict[str, str]


class GameStateResponse(DataProvenance):
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
    season_decided: bool
    finished: bool
    nasa_conditions: ClimateReport
    history: list[SeasonRecord]


class DecisionResponse(DataProvenance):
    season: int
    decision: Decision
    changes: Changes
    event: Event
    explanation: list[str]
    economics: Economics
    water_balance: WaterBalance
    state: GameStateResponse


class ResultsResponse(BaseModel):
    game_id: str
    completed: bool
    seasons_played: int
    crop_score: int
    soil_score: int
    water_score: int
    budget_score: int
    sustainability_score: int
    overall_score: int
    lessons: list[str]
    data_sources: list[str]
    periods: list[Period]
    is_demo: bool
    limitations: str
    disclaimer: str = DISCLAIMER
