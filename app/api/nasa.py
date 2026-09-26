from datetime import date, timedelta

from fastapi import APIRouter, Depends, HTTPException, Query, Request, Response

from app.config import get_settings
from app.models.climate import ClimateHistoryResponse
from app.models.game import Coordinates
from app.models.responses import ConditionsResponse
from app.services.nasa_power import NasaPowerError, NasaPowerService

router = APIRouter(prefix="/api/nasa", tags=["NASA data"])

POWER_FIRST_DATE = date(1981, 1, 1)
MAX_PERIOD_DAYS = 366
# Past seasons never change: let the browser keep them 1 h and the CDN (Vercel) 1 day.
CACHE_CONTROL_HISTORY = "public, max-age=3600, s-maxage=86400, stale-while-revalidate=604800"


def get_nasa_service(request: Request) -> NasaPowerService:
    service = getattr(request.app.state, "nasa_service", None)
    if service is None:
        # Serverless runtimes may skip the lifespan hook: create the service lazily.
        service = NasaPowerService(get_settings())
        request.app.state.nasa_service = service
    return service


def validate_period(start: date, end: date) -> None:
    if start > end:
        raise HTTPException(422, "start_date must be on or before end_date.")
    if start < POWER_FIRST_DATE:
        raise HTTPException(422, "NASA POWER daily data start on 1981-01-01.")
    if end >= date.today():
        raise HTTPException(422, "end_date must be in the past (NASA POWER has no forecasts).")
    if (end - start) > timedelta(days=MAX_PERIOD_DAYS - 1):
        raise HTTPException(422, f"The period can be at most {MAX_PERIOD_DAYS} days.")


def unavailable(exc: NasaPowerError) -> HTTPException:
    return HTTPException(
        504 if exc.kind == "timeout" else 502,
        detail={"error": "nasa_power_unavailable", "kind": exc.kind, "message": str(exc)},
        headers={"Cache-Control": "no-store"},
    )


@router.get("/conditions", response_model=ConditionsResponse, summary="Climate conditions for a location and period")
async def get_conditions(
    latitude: float = Query(ge=-90, le=90, examples=[43.24]),
    longitude: float = Query(ge=-180, le=180, examples=[76.95]),
    start_date: date = Query(examples=["2025-06-01"]),
    end_date: date = Query(examples=["2025-06-30"]),
    nasa: NasaPowerService = Depends(get_nasa_service),
) -> ConditionsResponse:
    """Daily NASA POWER data aggregated into simple game-ready values.

    Falls back to clearly-labelled demo data (`is_demo: true`) if NASA POWER is unavailable.
    """
    validate_period(start_date, end_date)
    report = await nasa.get_conditions(latitude, longitude, start_date, end_date)
    return ConditionsResponse(
        location=Coordinates(latitude=latitude, longitude=longitude),
        **report.model_dump(),
    )


@router.get(
    "/climate",
    response_model=ClimateHistoryResponse,
    summary="Last 10 growing seasons at a location (historical NASA POWER data)",
    responses={502: {"description": "NASA POWER unavailable"}, 504: {"description": "NASA POWER timed out"}},
)
async def get_climate_history(
    response: Response,
    latitude: float = Query(ge=-90, le=90, examples=[38.84]),
    longitude: float = Query(ge=-180, le=180, examples=[-97.61]),
    nasa: NasaPowerService = Depends(get_nasa_service),
) -> ClimateHistoryResponse:
    """One NASA POWER request (T2M, PRECTOTCORR, RH2M, WS2M, ALLSKY_SFC_SW_DWN; community AG)
    covering the 10 most recent complete growing seasons (May–Aug north, Nov–Feb south),
    aggregated per season plus the 10-season mean used as "normal".

    No demo data are invented here: on failure the endpoint returns 502/504 and the
    client decides whether to use its own cache or clearly-labelled demo data.
    """
    try:
        history, from_cache = await nasa.get_climate_history(latitude, longitude)
    except NasaPowerError as exc:
        raise unavailable(exc) from None
    response.headers["Cache-Control"] = CACHE_CONTROL_HISTORY
    return ClimateHistoryResponse(
        location=Coordinates(latitude=round(latitude, 4), longitude=round(longitude, 4)),
        status="cached" if from_cache else "live",
        **history.model_dump(),
    )
