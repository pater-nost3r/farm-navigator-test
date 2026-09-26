"""Loads the game model configuration (app/data/game_model.json).

The same file is served to the browser (GET /api/game/config), so the UI and the
server engine always use identical rules and coefficients.
"""

import json
from functools import lru_cache
from pathlib import Path
from typing import Any

MODEL_PATH = Path(__file__).resolve().parent.parent / "data" / "game_model.json"

REQUIRED_SECTIONS = (
    "data",
    "weather_thresholds",
    "anomaly",
    "farm",
    "soils",
    "crops",
    "irrigation_methods",
    "irrigation_intensity",
    "soil_care",
    "yield_model",
    "soil_model",
    "scoring",
    "what_if",
    "levels",
    "presets",
)


def options(section: dict[str, Any]) -> dict[str, Any]:
    """A config section without its documentation keys (those starting with "_")."""
    return {k: v for k, v in section.items() if not k.startswith("_")}


@lru_cache
def load_model() -> dict[str, Any]:
    model = json.loads(MODEL_PATH.read_text(encoding="utf-8"))
    missing = [s for s in REQUIRED_SECTIONS if s not in model]
    if missing:
        raise RuntimeError(f"game_model.json is missing sections: {missing}")
    ids = [level["id"] for level in model["levels"]]
    if ids != list(range(1, len(ids) + 1)):
        raise RuntimeError("level ids must be 1..N in order")
    return model
