from datetime import date, timedelta

from fastapi import APIRouter, Depends, HTTPException, Query, Request

from app.models.game import Coordinates
from app.models.responses import ConditionsResponse
from app.services.nasa_power import NasaPowerService

router = APIRouter(prefix="/api/nasa", tags=["NASA data"])

POWER_FIRST_DATE = date(1981, 1, 1)
MAX_PERIOD_DAYS = 366


def get_nasa_service(request: Request) -> NasaPowerService:
    return request.app.state.nasa_service


def validate_period(start: date, end: date) -> None:
    if start > end:
        raise HTTPException(422, "start_date must be on or before end_date.")
    if start < POWER_FIRST_DATE:
        raise HTTPException(422, "NASA POWER daily data start on 1981-01-01.")
    if end >= date.today():
        raise HTTPException(422, "end_date must be in the past (NASA POWER has no forecasts).")
    if (end - start) > timedelta(days=MAX_PERIOD_DAYS - 1):
        raise HTTPException(422, f"The period can be at most {MAX_PERIOD_DAYS} days.")


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
