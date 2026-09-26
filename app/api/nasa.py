from datetime import date
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Query, Request, Response

from app.config import get_settings
from app.models.api import DISCLAIMER, MODEL_LIMITATIONS, Farm
from app.services import engine
from app.services.climate import Archive, load_archive, season_report
from app.services.model_config import load_model
from app.services.nasa_power import NasaPowerError, NasaPowerService
from app.services.weather import Window, WindowError

router = APIRouter(prefix="/api/nasa", tags=["NASA data"])

NO_STORE = {"Cache-Control": "no-store"}


def get_nasa_service(request: Request) -> NasaPowerService:
    service = getattr(request.app.state, "nasa_service", None)
    if service is None:
        # Serverless runtimes may skip the lifespan hook: create the service lazily.
        service = NasaPowerService(get_settings())
        request.app.state.nasa_service = service
    return service


def get_today() -> date:
    return date.today()


def parse_window(start_md: str, end_md: str) -> Window:
    cfg = load_model()["data"]
    try:
        window = Window.parse(start_md, end_md)
        window.validate(cfg["min_period_days"], cfg["max_period_days"])
    except WindowError as exc:
        raise HTTPException(422, {"error": "invalid_period", "message": str(exc)}, headers=NO_STORE) from None
    return window


async def archive_for(farm: Farm, nasa: NasaPowerService, today: date) -> Archive:
    window = parse_window(farm.start_md, farm.end_md)
    try:
        return await load_archive(nasa, farm.latitude, farm.longitude, window, load_model(), today, demo=farm.demo)
    except NasaPowerError as exc:
        raise HTTPException(
            504 if exc.kind == "timeout" else 502,
            detail={
                "error": "nasa_power_unavailable",
                "kind": exc.kind,
                "message": str(exc),
                "hint": "Retry later, or start Demo mode explicitly (synthetic weather, clearly labelled).",
            },
            headers=NO_STORE,
        ) from None


def check_years(archive: Archive, year: int, seasons: int) -> None:
    """The level's seasons must exist in the downloaded period and be complete."""
    last = year + seasons - 1
    if year < archive.first_year or last > archive.latest_year:
        suggestion = max(archive.first_year, min(year, archive.latest_year - seasons + 1))
        raise HTTPException(
            422,
            {
                "error": "year_unavailable",
                "first_year": archive.first_year,
                "latest_complete_year": archive.latest_year,
                "suggestion": suggestion,
                "message": f"Seasons {year}–{last} are not all finished and available; "
                f"the latest complete one starts in {archive.latest_year}.",
            },
            headers=NO_STORE,
        )
    incomplete = [y for y in range(year, last + 1) if not archive.seasons[y].complete]
    if incomplete:
        complete = [
            y
            for y in archive.complete_years()
            if y + seasons - 1 <= archive.latest_year
            and all(archive.seasons[z].complete for z in range(y, y + seasons))
        ]
        raise HTTPException(
            409,
            {
                "error": "incomplete_season",
                "years": incomplete,
                "gaps": {y: {p: len(g) for p, g in archive.seasons[y].gaps.items() if g} for y in incomplete},
                "suggestion": max(complete) if complete else None,
                "message": "NASA POWER has too many missing days in this period.",
            },
            headers=NO_STORE,
        )


def reference_rain(archive: Archive, year: int) -> float | None:
    rep = season_report(archive, year, load_model())
    ref = rep["reference"]["rain_total_mm"]
    return (
        ref["mean"]
        if ref and len(rep["reference"]["years"]) >= load_model()["anomaly"]["min_reference_years"]
        else None
    )


def level_fits(archive: Archive) -> dict[int, dict[str, Any]]:
    model = load_model()
    out: dict[int, dict[str, Any]] = {}
    for level in model["levels"]:
        fits = []
        for y in archive.complete_years():
            if y + level["seasons"] - 1 > archive.latest_year:
                continue
            if engine.weather_fit(model, level, archive.seasons, reference_rain(archive, y), y)["ok"]:
                fits.append(y)
        kind = level["weather"]["type"]
        # Mildest qualifying year first: a fair challenge; more extreme years stay selectable.
        ranked = sorted(fits, key=lambda y: (engine.fit_strength(kind, archive.seasons[y].features), -y))
        out[level["id"]] = {
            "type": kind,
            "years": fits,
            "suggestions": (ranked if kind != "any" else sorted(fits, reverse=True))[:5],
        }
    return out


@router.get("/archive", summary="Growing-season weather for one point and window, last 20 complete years")
async def get_archive(
    response: Response,
    latitude: float = Query(ge=-90, le=90, examples=[43.6]),
    longitude: float = Query(ge=-180, le=180, examples=[77.0]),
    start_md: str = Query(pattern=r"^\d{2}-\d{2}$", examples=["04-20"]),
    end_md: str = Query(pattern=r"^\d{2}-\d{2}$", examples=["08-31"]),
    demo: bool = False,
    nasa: NasaPowerService = Depends(get_nasa_service),
    today: date = Depends(get_today),
) -> dict[str, Any]:
    """One NASA POWER Daily Point request (T2M, T2M_MAX, T2M_MIN, PRECTOTCORR, RH2M, WS2M, ALLSKY_SFC_SW_DWN;
    community=AG; time-standard=LST) for the window in each of the last 20 complete years.

    Returns data provenance (status live/cached/demo, request URL, units, time standard, fetch time),
    per-year features with gaps, the comparison with the other years of the same point and window,
    and which years fit each level's weather situation.
    """
    farm = Farm(latitude=latitude, longitude=longitude, start_md=start_md, end_md=end_md, demo=demo)
    archive = await archive_for(farm, nasa, today)
    model = load_model()
    response.headers["Cache-Control"] = "no-store" if archive.stale else "private, max-age=600"
    return {
        "data": archive.provenance(),
        "thresholds": {k: v for k, v in model["weather_thresholds"].items() if not k.startswith("_")},
        "seasons": [season_report(archive, y, model) for y in sorted(archive.seasons)],
        "level_fit": level_fits(archive),
        "disclaimer": DISCLAIMER,
        "limitations": MODEL_LIMITATIONS,
    }
