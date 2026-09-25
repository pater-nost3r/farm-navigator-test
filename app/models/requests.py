from uuid import UUID

from pydantic import BaseModel

from app.models.game import Crop, Difficulty, Fertilizer, Irrigation, Location


class StartGameRequest(BaseModel):
    location: Location
    difficulty: Difficulty = Difficulty.NORMAL


class DecisionRequest(BaseModel):
    game_id: UUID
    crop: Crop
    irrigation: Irrigation
    fertilizer: Fertilizer
