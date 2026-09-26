"""Request and response models of the public API."""

from typing import Any, Literal

from pydantic import BaseModel, Field

DISCLAIMER = (
    "Farm Navigator is an educational game with a simplified, deterministic crop model. "
    "Weather comes from NASA POWER (historical, gridded); soil, costs, prices and yields are game-model values. "
    "It is not a yield forecast or farming advice."
)

MODEL_LIMITATIONS = [
    "NASA POWER values are regional grid-cell estimates (about 0.5° × 0.625°), not measurements at a field.",
    "Soil type, nitrogen, organic matter, erosion, prices, costs and yields are game-model values chosen by the "
    "player or the level, not data from NASA POWER.",
    "The crop model is simplified (daily water balance, degree days, fixed coefficients). It is not a yield forecast.",
    "Small data gaps are filled for the model (interpolation; missing rain counts as 0 mm) and reported.",
    "The off-season between two seasons is not simulated: soil moisture moves halfway to a typical level.",
]


class HealthResponse(BaseModel):
    status: Literal["ok"] = "ok"


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


MD_PATTERN = r"^\d{2}-\d{2}$"


class Farm(BaseModel):
    """Player inputs: where and when (weather series) plus the virtual farm's soil (a game-model choice)."""

    latitude: float = Field(ge=-90, le=90, examples=[43.6])
    longitude: float = Field(ge=-180, le=180, examples=[77.0])
    start_md: str = Field(pattern=MD_PATTERN, examples=["04-20"], description="Growing period start, MM-DD")
    end_md: str = Field(pattern=MD_PATTERN, examples=["08-31"], description="Growing period end, MM-DD")
    soil: Literal["sandy", "loam", "clay"] = "loam"
    demo: bool = Field(False, description="Explicitly play with synthetic demo weather instead of NASA POWER")


class Decision(BaseModel):
    """All four fields are required to play a season; missing ones are reported, not guessed."""

    crop: str | None = Field(None, examples=["sorghum"])
    method: str | None = Field(None, examples=["drip"])
    intensity: str | None = Field(None, examples=["low"])
    care: str | None = Field(None, examples=["mulch"])


class GameRequest(BaseModel):
    level_id: int = Field(ge=1, le=7)
    year: int = Field(ge=1981, le=2100, description="Year the first season of the level starts in")
    farm: Farm
    decisions: list[Decision] = Field(
        default_factory=list,
        max_length=3,
        description="Decisions for seasons 1..k; the server replays them from the level start",
    )


class WhatIfRequest(GameRequest):
    season: int = Field(ge=0, le=2, description="Index of the played season to compare")
    field: Literal["crop", "method", "intensity", "care"]
    value: str


class ApiResponse(BaseModel):
    """Loose envelope: engine outputs are plain JSON documented in docs/MODEL.md."""

    model_config = {"extra": "allow"}

    data: dict[str, Any]
    disclaimer: str = DISCLAIMER
    limitations: list[str] = Field(default_factory=lambda: list(MODEL_LIMITATIONS))
