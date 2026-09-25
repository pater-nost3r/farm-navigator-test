"""Farm Navigator game formulas.

Every rule here is simple, deterministic and explainable: the same state,
decision and climate data always give the same result. This is an
educational model, not an agronomic forecast.

Water values are normalised to "mm per 30 days" so that seasons of any
length can be compared with a crop's water need.
"""

import json
import uuid
from dataclasses import dataclass
from datetime import date
from pathlib import Path
from statistics import mean

from app.models.game import (
    Changes,
    ClimateConditions,
    ClimateReport,
    Crop,
    Decision,
    Difficulty,
    Economics,
    Event,
    Fertilizer,
    GameState,
    Irrigation,
    Level,
    Location,
    SeasonRecord,
    WaterBalance,
)

DATA_DIR = Path(__file__).resolve().parent.parent / "data"

MAX_SEASONS = 3
STARTING_SOIL_HEALTH = 70
STARTING_CROP_HEALTH = 100
# Crop health before fertilizer bonus, so fertilizer can still matter in a perfect season.
BASE_CROP_HEALTH = 90

# Northern hemisphere growing window (May–Aug); southern uses Nov–Feb.
NORTH_SEASON = ((5, 1), (8, 31))
SOUTH_SEASON = ((11, 1), (2, 28))


# --- Game parameters -------------------------------------------------------


@dataclass(frozen=True)
class CropProfile:
    display_name: str
    optimal_temp_c: tuple[float, float]
    water_need_mm_per_30_days: float
    drought_tolerance: float  # 0 = very sensitive, 1 = very tolerant
    soil_effect: int
    seed_cost: int
    revenue_at_full_health: int


@dataclass(frozen=True)
class IrrigationOption:
    mm_per_30_days: float
    water_use: int  # points taken from the farm's water reserve
    cost: int


@dataclass(frozen=True)
class FertilizerOption:
    crop_bonus: int
    soil_change: int
    cost: int
    sustainability: int


@dataclass(frozen=True)
class DifficultySettings:
    water: int
    budget: int
    damage_multiplier: float


def load_crops() -> dict[Crop, CropProfile]:
    raw = json.loads((DATA_DIR / "crops.json").read_text(encoding="utf-8"))
    return {
        Crop(key): CropProfile(
            display_name=v["display_name"],
            optimal_temp_c=tuple(v["optimal_temp_c"]),
            water_need_mm_per_30_days=v["water_need_mm_per_30_days"],
            drought_tolerance=v["drought_tolerance"],
            soil_effect=v["soil_effect"],
            seed_cost=v["seed_cost"],
            revenue_at_full_health=v["revenue_at_full_health"],
        )
        for key, v in raw.items()
    }


CROPS = load_crops()

IRRIGATION = {
    Irrigation.NONE: IrrigationOption(mm_per_30_days=0, water_use=0, cost=0),
    Irrigation.LOW: IrrigationOption(mm_per_30_days=20, water_use=10, cost=20),
    Irrigation.MEDIUM: IrrigationOption(mm_per_30_days=40, water_use=20, cost=45),
    Irrigation.HIGH: IrrigationOption(mm_per_30_days=70, water_use=35, cost=80),
}

FERTILIZER = {
    Fertilizer.NONE: FertilizerOption(crop_bonus=0, soil_change=-2, cost=0, sustainability=0),
    Fertilizer.ORGANIC: FertilizerOption(crop_bonus=4, soil_change=6, cost=60, sustainability=8),
    Fertilizer.MINERAL: FertilizerOption(crop_bonus=10, soil_change=-3, cost=50, sustainability=-4),
}

DIFFICULTY = {
    Difficulty.EASY: DifficultySettings(water=120, budget=1200, damage_multiplier=0.8),
    Difficulty.NORMAL: DifficultySettings(water=100, budget=1000, damage_multiplier=1.0),
    Difficulty.HARD: DifficultySettings(water=80, budget=800, damage_multiplier=1.2),
}

# Water-balance thresholds (ratio of water received to water needed).
OVERWATER_RATIO = 1.5
WELL_MATCHED_RATIO = (0.9, 1.3)
MAX_DROUGHT_DAMAGE = 60
HEAT_DAMAGE_PER_DEGREE = 4
COLD_DAMAGE_PER_DEGREE = 3
LOW_SOLAR_THRESHOLD = 12.0
LOW_SOLAR_DAMAGE = 5
OVERWATER_CROP_DAMAGE = 5
OVERWATER_SOIL_DAMAGE = 4
MONOCULTURE_SOIL_DAMAGE = 3
MAX_RECHARGE = 30
RECHARGE_SHARE_OF_RAIN = 0.25


# --- Small helpers ---------------------------------------------------------


def clamp(value: float, low: int = 0, high: int = 100) -> int:
    return int(max(low, min(high, round(value))))


def rain_per_30_days(total_rainfall_mm: float, days: int) -> float:
    return total_rainfall_mm * 30 / days if days > 0 else 0.0


def season_period(latitude: float, season: int, today: date) -> tuple[date, date]:
    """Real past growing season used for game season N.

    Season 1..3 map to the three most recent complete growing seasons, so
    NASA POWER always has full data for them.
    """
    year = today.year - 1 - (MAX_SEASONS - season)
    if latitude >= 0:
        (sm, sd), (em, ed) = NORTH_SEASON
        return date(year, sm, sd), date(year, em, ed)
    (sm, sd), (em, ed) = SOUTH_SEASON
    return date(year - 1, sm, sd), date(year, em, ed)


def classify_drought_risk(
    total_rainfall_mm: float, days: int, average_temperature_c: float, humidity_percent: float
) -> Level:
    """Rainfall per 30 days sets the base risk; heat and dry air raise it."""
    rain = rain_per_30_days(total_rainfall_mm, days)
    if rain < 25:
        return Level.HIGH if average_temperature_c >= 22 or humidity_percent < 45 else Level.MEDIUM
    if rain < 50:
        return Level.HIGH if average_temperature_c >= 27 and humidity_percent < 40 else Level.MEDIUM
    if average_temperature_c >= 28 and humidity_percent < 35:
        return Level.MEDIUM
    return Level.LOW


def crop_water_need(crop: CropProfile, conditions: ClimateConditions) -> tuple[float, list[str]]:
    """Crop water need (mm per 30 days), increased by hot, dry or windy air."""
    factor = 1.0
    reasons = []
    if conditions.average_temperature_c > 28:
        factor += 0.10
        reasons.append("high temperature")
    if conditions.average_humidity_percent < 40:
        factor += 0.15
        reasons.append("dry air")
    if conditions.average_wind_speed_m_s > 5:
        factor += 0.10
        reasons.append("strong wind")
    return crop.water_need_mm_per_30_days * factor, reasons


def pick_event(
    drought_risk: Level, heat_excess_c: float, cold_deficit_c: float, rain_30: float
) -> Event:
    """Most severe climate event of the season (first match wins among equals)."""
    candidates: list[Event] = []
    if drought_risk != Level.LOW:
        candidates.append(Event(type="drought", severity=drought_risk))
    if heat_excess_c >= 2:
        candidates.append(Event(type="heatwave", severity=Level.HIGH if heat_excess_c >= 5 else Level.MEDIUM))
    if cold_deficit_c >= 2:
        candidates.append(Event(type="cold_stress", severity=Level.HIGH if cold_deficit_c >= 5 else Level.MEDIUM))
    if rain_30 > 120:
        candidates.append(Event(type="heavy_rain", severity=Level.HIGH if rain_30 > 200 else Level.MEDIUM))
    if not candidates:
        return Event(type="none", severity=Level.LOW)
    rank = {Level.LOW: 0, Level.MEDIUM: 1, Level.HIGH: 2}
    return max(candidates, key=lambda e: rank[e.severity])


# --- Game flow -------------------------------------------------------------


def new_game(location: Location, difficulty: Difficulty, report: ClimateReport) -> GameState:
    settings = DIFFICULTY[difficulty]
    return GameState(
        game_id=str(uuid.uuid4()),
        location=location,
        difficulty=difficulty,
        season=1,
        max_seasons=MAX_SEASONS,
        water=settings.water,
        budget=settings.budget,
        soil_health=STARTING_SOIL_HEALTH,
        crop_health=STARTING_CROP_HEALTH,
        sustainability_score=0,
        starting_water=settings.water,
        starting_budget=settings.budget,
        nasa_conditions=report,
    )


def play_season(state: GameState, decision: Decision) -> tuple[GameState, SeasonRecord]:
    """Apply a decision to the current season. Returns the new state and a season record."""
    report = state.nasa_conditions
    c = report.conditions
    crop = CROPS[decision.crop]
    irrigation = IRRIGATION[decision.irrigation]
    fertilizer = FERTILIZER[decision.fertilizer]
    settings = DIFFICULTY[state.difficulty]
    damage_k = settings.damage_multiplier
    source = "Demo fallback data" if report.is_demo else "NASA POWER data"
    previous_crop = state.history[-1].decision.crop if state.history else None
    explanation: list[str] = []

    # Water balance
    rain_30 = rain_per_30_days(c.total_rainfall_mm, report.period.days)
    need, need_reasons = crop_water_need(crop, c)
    applied_share = 1.0
    if irrigation.water_use > 0 and state.water < irrigation.water_use:
        applied_share = max(state.water, 0) / irrigation.water_use
    irrigation_mm = irrigation.mm_per_30_days * applied_share
    water_used = round(irrigation.water_use * applied_share)
    received = rain_30 + irrigation_mm
    coverage = received / need
    deficit = max(0.0, 1 - coverage)
    overwatered = decision.irrigation != Irrigation.NONE and coverage > OVERWATER_RATIO

    explanation.append(
        f"{source} showed {rain_30:.0f} mm of rain per 30 days (drought risk: {c.drought_risk.value}); "
        f"{crop.display_name.lower()} needed about {need:.0f} mm."
    )
    if need_reasons:
        explanation.append(f"The crop needed extra water because of {' and '.join(need_reasons)}.")
    if applied_share < 1:
        explanation.append(
            f"The water reserve was too low for {decision.irrigation.value} irrigation, "
            f"so only {applied_share:.0%} of it could be applied."
        )

    drought_damage = deficit * MAX_DROUGHT_DAMAGE * (1 - crop.drought_tolerance / 2) * damage_k
    if deficit > 0.05:
        if decision.irrigation == Irrigation.NONE:
            explanation.append(
                f"Without irrigation the crop received only {coverage:.0%} of the water it needed, "
                f"causing drought damage (-{round(drought_damage)} crop health)."
            )
        else:
            explanation.append(
                f"{decision.irrigation.value.capitalize()} irrigation reduced drought damage, but the crop "
                f"still received only {coverage:.0%} of its water need (-{round(drought_damage)} crop health)."
            )
        if crop.drought_tolerance >= 0.6:
            explanation.append(f"{crop.display_name} is drought-tolerant, which limited the damage.")
    elif decision.irrigation == Irrigation.NONE:
        explanation.append("Rainfall covered the crop's water need, so skipping irrigation saved water.")
    elif overwatered:
        explanation.append(
            f"The crop received {coverage:.0%} of its water need: extra irrigation wasted water, "
            "and waterlogging harmed roots and soil."
        )
    elif rain_30 >= need:
        explanation.append("Rainfall alone already covered the crop's water need, so irrigation was not necessary.")
    else:
        explanation.append(f"{decision.irrigation.value.capitalize()} irrigation closed the gap between rainfall and crop need.")
    overwater_damage = OVERWATER_CROP_DAMAGE if overwatered else 0

    # Temperature and sunlight
    low_t, high_t = crop.optimal_temp_c
    heat_excess = max(0.0, c.average_temperature_c - high_t)
    cold_deficit = max(0.0, low_t - c.average_temperature_c)
    heat_damage = heat_excess * HEAT_DAMAGE_PER_DEGREE * damage_k
    cold_damage = cold_deficit * COLD_DAMAGE_PER_DEGREE * damage_k
    if heat_excess > 0:
        explanation.append(
            f"Average temperature {c.average_temperature_c:.1f}°C was above {crop.display_name.lower()}'s "
            f"comfortable range ({low_t:g}–{high_t:g}°C), causing heat stress (-{round(heat_damage)} crop health)."
        )
    elif cold_deficit > 0:
        explanation.append(
            f"Average temperature {c.average_temperature_c:.1f}°C was below {crop.display_name.lower()}'s "
            f"comfortable range ({low_t:g}–{high_t:g}°C), slowing growth (-{round(cold_damage)} crop health)."
        )
    else:
        explanation.append(
            f"Average temperature {c.average_temperature_c:.1f}°C was within {crop.display_name.lower()}'s "
            f"comfortable range ({low_t:g}–{high_t:g}°C)."
        )
    solar_damage = 0
    if c.solar_radiation < LOW_SOLAR_THRESHOLD:
        solar_damage = LOW_SOLAR_DAMAGE
        explanation.append("Low solar radiation (cloudy season) limited photosynthesis.")

    # Soil
    soil_modifier = round((state.soil_health - 70) / 4)
    if soil_modifier > 0:
        explanation.append(f"Healthy soil supported the crop (+{soil_modifier} crop health).")
    elif soil_modifier < 0:
        explanation.append(f"Degraded soil held the crop back ({soil_modifier} crop health).")

    soil_change = fertilizer.soil_change + crop.soil_effect
    sustainability = fertilizer.sustainability
    if decision.fertilizer == Fertilizer.ORGANIC:
        explanation.append("Organic fertilizer gave a slower, smaller boost but improved soil health.")
    elif decision.fertilizer == Fertilizer.MINERAL:
        explanation.append("Mineral fertilizer gave the fastest crop boost but did not build long-term soil health.")
    else:
        explanation.append("Without fertilizer the crop drew nutrients from the soil, slowly depleting it.")
    if crop.soil_effect > 0:
        explanation.append(f"{crop.display_name} is a legume that fixes nitrogen and improved the soil.")
    elif crop.soil_effect <= -3:
        explanation.append(f"{crop.display_name} is a heavy feeder and depleted soil nutrients.")

    if previous_crop is not None:
        if previous_crop == decision.crop:
            soil_change -= MONOCULTURE_SOIL_DAMAGE
            sustainability -= 3
            explanation.append("Planting the same crop again (monoculture) wore out the soil.")
        else:
            sustainability += 4
            explanation.append("Rotating crops helped break pest cycles and balance soil nutrients.")

    if overwatered:
        soil_change -= OVERWATER_SOIL_DAMAGE
        sustainability -= 8
    elif decision.irrigation == Irrigation.NONE and deficit <= 0.05:
        sustainability += 3
    elif WELL_MATCHED_RATIO[0] <= coverage <= WELL_MATCHED_RATIO[1] and decision.irrigation != Irrigation.NONE:
        sustainability += 4

    new_crop_health = clamp(
        BASE_CROP_HEALTH
        - drought_damage
        - overwater_damage
        - heat_damage
        - cold_damage
        - solar_damage
        + fertilizer.crop_bonus
        + soil_modifier
    )

    # Economics and water reserve
    expenses = crop.seed_cost + round(irrigation.cost * applied_share) + fertilizer.cost
    revenue = round(crop.revenue_at_full_health * new_crop_health / 100)
    recharge = round(min(MAX_RECHARGE, rain_30 * RECHARGE_SHARE_OF_RAIN))
    new_water = clamp(state.water - water_used + recharge, 0, max(settings.water, state.water))
    explanation.append(f"Harvest earned ${revenue}; seeds, irrigation and fertilizer cost ${expenses}.")
    if recharge > 0:
        explanation.append(f"Rainfall refilled the water reserve by {recharge} points.")

    new_soil = clamp(state.soil_health + soil_change)
    new_sustainability = clamp(state.sustainability_score + sustainability)

    changes = Changes(
        water=new_water - state.water,
        budget=revenue - expenses,
        soil_health=new_soil - state.soil_health,
        crop_health=new_crop_health - state.crop_health,
        sustainability_score=new_sustainability - state.sustainability_score,
    )
    record = SeasonRecord(
        season=state.season,
        decision=decision,
        nasa_conditions=report,
        changes=changes,
        event=pick_event(c.drought_risk, heat_excess, cold_deficit, rain_30),
        explanation=explanation,
        economics=Economics(expenses=expenses, revenue=revenue),
        water_balance=WaterBalance(
            crop_need_mm=round(need, 1),
            rainfall_mm=round(rain_30, 1),
            irrigation_mm=round(irrigation_mm, 1),
            coverage_percent=round(coverage * 100),
        ),
        crop_health=new_crop_health,
    )
    new_state = state.model_copy(
        update={
            "water": new_water,
            "budget": state.budget + changes.budget,
            "soil_health": new_soil,
            "crop_health": new_crop_health,
            "sustainability_score": new_sustainability,
            "season_decided": True,
            "finished": state.season >= state.max_seasons,
            "history": [*state.history, record],
        }
    )
    return new_state, record


def advance_season(state: GameState, report: ClimateReport) -> GameState:
    if not state.season_decided:
        raise ValueError("Make a decision for the current season first.")
    if state.finished:
        raise ValueError("The game is finished. Check the results.")
    return state.model_copy(
        update={"season": state.season + 1, "season_decided": False, "nasa_conditions": report}
    )


# --- Final results ---------------------------------------------------------


def water_fit(coverage_percent: int) -> float:
    """100 when the crop got exactly what it needed, lower for shortage or waste."""
    return max(0.0, 100 - abs(100 - coverage_percent))


def compute_results(state: GameState) -> dict:
    history = state.history
    if not history:
        raise ValueError("Play at least one season before requesting results.")

    crop_score = clamp(mean(r.crop_health for r in history))
    soil_score = clamp(state.soil_health)
    reserve_score = min(100.0, state.water / state.starting_water * 100)
    water_score = clamp(0.7 * mean(water_fit(r.water_balance.coverage_percent) for r in history) + 0.3 * reserve_score)
    budget_score = clamp(50 + (state.budget - state.starting_budget) / state.starting_budget * 100)
    sustainability_score = clamp(state.sustainability_score)
    overall = clamp(mean([crop_score, soil_score, water_score, budget_score, sustainability_score]))

    return {
        "crop_score": crop_score,
        "soil_score": soil_score,
        "water_score": water_score,
        "budget_score": budget_score,
        "sustainability_score": sustainability_score,
        "overall_score": overall,
        "lessons": build_lessons(state),
    }


def build_lessons(state: GameState) -> list[str]:
    lessons: list[str] = []
    history = state.history

    def any_record(predicate) -> bool:
        return any(predicate(r) for r in history)

    if any_record(lambda r: r.event.type == "drought" and r.decision.irrigation == Irrigation.NONE and r.water_balance.coverage_percent < 90):
        lessons.append("When NASA rainfall data show a drought risk, some irrigation protects the crop.")
    if any_record(lambda r: r.water_balance.coverage_percent > OVERWATER_RATIO * 100 and r.decision.irrigation != Irrigation.NONE):
        lessons.append("Check rainfall before irrigating: more water than the crop needs is wasted and harms soil.")
    if any_record(lambda r: r.event.type in ("heatwave", "cold_stress")):
        lessons.append("Match crops to the season's temperature: each crop has a comfortable range.")
    if any_record(lambda r: r.decision.fertilizer == Fertilizer.MINERAL):
        lessons.append("Mineral fertilizer boosts yields fast, but organic fertilizer builds soil health over time.")
    if any_record(lambda r: r.decision.fertilizer == Fertilizer.ORGANIC):
        lessons.append("Organic fertilizer works slowly but keeps the soil productive for future seasons.")
    crops = [r.decision.crop for r in history]
    if len(crops) > 1 and len(set(crops)) == 1:
        lessons.append("Rotating crops (for example adding chickpea) keeps soil healthier than monoculture.")
    elif Crop.CHICKPEA in crops:
        lessons.append("Legumes like chickpea fix nitrogen and are a good rotation crop in dry climates.")
    if state.budget < state.starting_budget:
        lessons.append("Inputs cost money: balance spending on water and fertilizer against expected harvest.")
    lessons.append(
        "NASA POWER data describe regional climate, not your exact field: farmers combine satellite data with local observations."
    )
    return lessons
