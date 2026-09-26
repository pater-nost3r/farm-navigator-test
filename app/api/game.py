"""Level-based game API. Stateless: every request carries the farm, the start year and all
decisions so far; the server replays them from the level start with the same NASA data, so
budget, water reserve and soil can only change through the published rules."""

from datetime import date
from typing import Any

from fastapi import APIRouter, Depends, HTTPException

from app.api.nasa import (
    NO_STORE,
    archive_for,
    check_years,
    get_nasa_service,
    get_today,
    level_fits,
    reference_rain,
)
from app.models.api import DISCLAIMER, MODEL_LIMITATIONS, GameRequest, WhatIfRequest
from app.services import engine
from app.services.climate import Archive, season_report
from app.services.model_config import load_model
from app.services.nasa_power import NasaPowerService

router = APIRouter(prefix="/api/game", tags=["Game"])


@router.get("/config", summary="Game rules and coefficients (the same file the server engine uses)")
async def get_config() -> dict[str, Any]:
    return {**load_model(), "disclaimer": DISCLAIMER, "limitations": MODEL_LIMITATIONS}


def public_run(run: dict[str, Any]) -> dict[str, Any]:
    return {k: v for k, v in run.items() if k != "results"}


async def prepare(
    body: GameRequest, nasa: NasaPowerService, today: date
) -> tuple[dict[str, Any], Archive, dict[str, Any]]:
    model = load_model()
    level = engine.level_by_id(model, body.level_id)
    archive = await archive_for(body.farm, nasa, today)
    check_years(archive, body.year, level["seasons"])
    fit = engine.weather_fit(model, level, archive.seasons, reference_rain(archive, body.year), body.year)
    if not fit["ok"]:
        raise HTTPException(
            409,
            {
                "error": "weather_unfit",
                "fit": fit,
                "suggestions": level_fits(archive)[level["id"]]["suggestions"],
                "message": "This season does not match the level's weather situation.",
            },
            headers=NO_STORE,
        )
    return level, archive, fit


def replay_or_422(body: GameRequest, archive: Archive, level: dict[str, Any]):
    model = load_model()
    if len(body.decisions) > level["seasons"]:
        raise HTTPException(422, {"error": "too_many_decisions", "seasons": level["seasons"]}, headers=NO_STORE)
    seasons = [archive.season(body.year + k) for k in range(level["seasons"])]
    try:
        run, before = engine.replay(
            model, body.level_id, body.farm.soil, seasons, [d.model_dump() for d in body.decisions]
        )
    except engine.DecisionError as exc:
        raise HTTPException(
            422,
            {"error": "invalid_decision", "message": str(exc), "missing": exc.missing, "errors": exc.errors},
            headers=NO_STORE,
        ) from None
    return run, before, seasons


def envelope(archive: Archive, **payload: Any) -> dict[str, Any]:
    return {**payload, "data": archive.provenance(), "disclaimer": DISCLAIMER, "limitations": MODEL_LIMITATIONS}


@router.post("/start", summary="Check a level against the chosen season and return its starting state")
async def start(
    body: GameRequest, nasa: NasaPowerService = Depends(get_nasa_service), today: date = Depends(get_today)
) -> dict[str, Any]:
    level, archive, fit = await prepare(body, nasa, today)
    run = engine.new_run(load_model(), body.level_id, body.farm.soil)
    return envelope(
        archive,
        level=level,
        year=body.year,
        fit=fit,
        run=public_run(run),
        season=season_report(archive, body.year, load_model(), with_daily=True),
    )


@router.post("/turn", summary="Play the next season (all decisions so far are replayed and validated)")
async def turn(
    body: GameRequest, nasa: NasaPowerService = Depends(get_nasa_service), today: date = Depends(get_today)
) -> dict[str, Any]:
    if not body.decisions:
        raise HTTPException(
            422,
            {
                "error": "invalid_decision",
                "missing": ["crop", "method", "intensity", "care"],
                "errors": [],
                "message": "no decision for the season",
            },
            headers=NO_STORE,
        )
    model = load_model()
    level, archive, fit = await prepare(body, nasa, today)
    run, before, seasons = replay_or_422(body, archive, level)
    idx = len(body.decisions) - 1
    outcome = run["results"][idx]
    payload: dict[str, Any] = {
        "level": level,
        "year": body.year,
        "fit": fit,
        "run": public_run(run),
        "outcome": outcome,
        "results": run["results"],
        "what_if": engine.what_if(model, before[idx], seasons[idx], outcome),
        "evaluation": engine.evaluate(model, run) if run["finished"] else None,
        "season": None
        if run["finished"]
        else season_report(archive, body.year + run["season_index"], model, with_daily=True),
    }
    return envelope(archive, **payload)


@router.post("/what-if", summary="Replay one played season with ONE decision changed")
async def custom_what_if(
    body: WhatIfRequest, nasa: NasaPowerService = Depends(get_nasa_service), today: date = Depends(get_today)
) -> dict[str, Any]:
    model = load_model()
    level, archive, _ = await prepare(body, nasa, today)
    if body.season >= len(body.decisions):
        raise HTTPException(422, {"error": "season_not_played"}, headers=NO_STORE)
    run, before, seasons = replay_or_422(body, archive, level)
    try:
        result = engine.compare(
            model, before[body.season], seasons[body.season], run["results"][body.season], body.field, body.value
        )
    except engine.DecisionError as exc:
        raise HTTPException(
            422, {"error": "invalid_alternative", "missing": exc.missing, "errors": exc.errors}, headers=NO_STORE
        ) from None
    return envelope(archive, comparison=result)
