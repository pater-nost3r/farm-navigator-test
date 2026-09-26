from typing import Literal

from fastapi import APIRouter, Depends, HTTPException, Query, Request, Response

from app.config import get_settings
from app.models.climate import GeocodeResponse
from app.services.geocoding import SOURCE, GeocodingError, GeocodingService

router = APIRouter(prefix="/api", tags=["Location"])


def get_geocoding_service(request: Request) -> GeocodingService:
    service = getattr(request.app.state, "geocoding_service", None)
    if service is None:
        service = GeocodingService(get_settings())
        request.app.state.geocoding_service = service
    return service


@router.get("/geocode", response_model=GeocodeResponse, summary="Find coordinates for a city or place name")
async def geocode(
    response: Response,
    q: str = Query(min_length=2, max_length=80, examples=["Almaty"]),
    lang: Literal["en", "ru"] = "en",
    geo: GeocodingService = Depends(get_geocoding_service),
) -> GeocodeResponse:
    try:
        results = await geo.search(q, lang)
    except GeocodingError as exc:
        raise HTTPException(
            504 if exc.kind == "timeout" else 502,
            detail={"error": "geocoding_unavailable", "kind": exc.kind, "message": str(exc)},
        ) from None
    response.headers["Cache-Control"] = "public, max-age=86400, s-maxage=604800"
    return GeocodeResponse(query=q.strip(), results=results, source=SOURCE)
