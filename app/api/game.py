from datetime import date
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException

from app.api.nasa import get_nasa_service
from app.models.game import ClimateReport, Decision, GameState
from app.models.requests import DecisionRequest, StartGameRequest
from app.models.responses import DecisionResponse, GameStateResponse, ResultsResponse, provenance
from app.services import game_engine
from app.services.nasa_power import NasaPowerService

router = APIRouter(prefix="/api/game", tags=["Game"])

# MVP storage: games live in server memory and are lost on restart.
GAMES: dict[str, GameState] = {}


def get_game(game_id: UUID | str) -> GameState:
    game = GAMES.get(str(game_id))
    if game is None:
        raise HTTPException(404, "Game not found. Start a new game with POST /api/game/start.")
    return game


def state_response(state: GameState) -> GameStateResponse:
    return GameStateResponse(**state.model_dump(), **provenance(state.nasa_conditions))


async def season_conditions(nasa: NasaPowerService, state_location, season: int) -> ClimateReport:
    start, end = game_engine.season_period(state_location.latitude, season, date.today())
    return await nasa.get_conditions(
        state_location.latitude, state_location.longitude, start, end, fallback_profile=f"season_{season}"
    )


@router.post("/start", response_model=GameStateResponse, summary="Start a new 3-season game")
async def start_game(
    body: StartGameRequest, nasa: NasaPowerService = Depends(get_nasa_service)
) -> GameStateResponse:
    """Creates a game and loads NASA POWER conditions for season 1.

    Seasons 1–3 use the three most recent complete growing seasons at the location
    (May–Aug in the northern hemisphere, Nov–Feb in the southern hemisphere).
    """
    report = await season_conditions(nasa, body.location, 1)
    state = game_engine.new_game(body.location, body.difficulty, report)
    GAMES[state.game_id] = state
    return state_response(state)


@router.post("/decision", response_model=DecisionResponse, summary="Choose crop, irrigation and fertilizer")
async def make_decision(body: DecisionRequest) -> DecisionResponse:
    state = get_game(body.game_id)
    if state.season_decided:
        detail = "The game is finished. Check the results." if state.finished else (
            "A decision was already made this season. Call next-season to continue."
        )
        raise HTTPException(409, detail)
    decision = Decision(crop=body.crop, irrigation=body.irrigation, fertilizer=body.fertilizer)
    new_state, record = game_engine.play_season(state, decision)
    GAMES[new_state.game_id] = new_state
    return DecisionResponse(
        season=record.season,
        decision=record.decision,
        changes=record.changes,
        event=record.event,
        explanation=record.explanation,
        economics=record.economics,
        water_balance=record.water_balance,
        state=state_response(new_state),
        **provenance(record.nasa_conditions),
    )


@router.get("/{game_id}", response_model=GameStateResponse, summary="Full game state")
async def read_game(game_id: UUID) -> GameStateResponse:
    return state_response(get_game(game_id))


@router.post("/{game_id}/next-season", response_model=GameStateResponse, summary="Advance to the next season")
async def next_season(game_id: UUID, nasa: NasaPowerService = Depends(get_nasa_service)) -> GameStateResponse:
    state = get_game(game_id)
    if state.finished:
        raise HTTPException(409, "The game is finished. Check the results.")
    if not state.season_decided:
        raise HTTPException(409, "Make a decision for the current season first.")
    report = await season_conditions(nasa, state.location, state.season + 1)
    new_state = game_engine.advance_season(state, report)
    GAMES[new_state.game_id] = new_state
    return state_response(new_state)


@router.get("/{game_id}/results", response_model=ResultsResponse, summary="Final scores and lessons")
async def results(game_id: UUID) -> ResultsResponse:
    state = get_game(game_id)
    try:
        scores = game_engine.compute_results(state)
    except ValueError as exc:
        raise HTTPException(409, str(exc)) from None
    reports = [r.nasa_conditions for r in state.history]
    any_demo = any(r.is_demo for r in reports)
    return ResultsResponse(
        game_id=state.game_id,
        completed=state.finished,
        seasons_played=len(state.history),
        data_sources=sorted({r.source for r in reports}),
        periods=[r.period for r in reports],
        is_demo=any_demo,
        limitations=" ".join(dict.fromkeys(r.limitations for r in reports)),
        **scores,
    )
