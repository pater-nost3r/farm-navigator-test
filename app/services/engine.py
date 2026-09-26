"""Farm Navigator game engine (authoritative, server side).

Deterministic: the same level, soil type, NASA POWER seasons and decisions always give
the same result. No randomness, no clock. Every coefficient comes from game_model.json.

A season is simulated day by day:
  NASA POWER daily data → reference evapotranspiration (FAO-56) → crop water use
  (Kc curve driven by growing degree days) → root-zone water balance for the chosen
  soil (infiltration, runoff, drainage, waterlogging) with the player's irrigation →
  relative yield (FAO-33 water response × heat × frost × nitrogen × maturity × …)
  → soil state (N, organic matter, erosion, moisture), money and water reserve.

Values in the output are labelled by origin: "nasa" (measured), "player" (decisions),
"computed" (this model) and "assumption" (simplifications of this model).
"""

import math
from copy import deepcopy
from typing import Any

from app.services.model_config import options
from app.services.weather import Season

DECISION_FIELDS = ("crop", "method", "intensity", "care")


class DecisionError(ValueError):
    def __init__(self, missing: list[str], errors: list[str]):
        super().__init__(f"invalid decision: {', '.join(missing + errors)}")
        self.missing = missing
        self.errors = errors


def clamp(v: float, lo: float = 0.0, hi: float = 100.0) -> float:
    return max(lo, min(hi, v))


def level_by_id(model: dict[str, Any], level_id: int) -> dict[str, Any]:
    for level in model["levels"]:
        if level["id"] == level_id:
            return level
    raise KeyError(level_id)


def fertility(model: dict[str, Any], soil: dict[str, float]) -> int:
    sm = model["soil_model"]
    w = sm["fertility_weights"]
    lo, hi = sm["fertility_om_range"]
    n_score = clamp(soil["n"] / sm["fertility_n_full"] * 100)
    om_score = clamp((soil["om"] - lo) / (hi - lo) * 100)
    return round(w["n"] * n_score + w["om"] * om_score + w["erosion"] * (100 - soil["erosion"]))


def taw_mm(model: dict[str, Any], soil_type: str) -> float:
    return model["soils"][soil_type]["awc_mm_per_m"] * model["farm"]["root_zone_m"]


# ---------- Runs ----------


def new_run(model: dict[str, Any], level_id: int, soil_type: str) -> dict[str, Any]:
    level = level_by_id(model, level_id)
    start = level["start"]
    soil = {k: float(v) for k, v in start["soil"].items()}
    return {
        "level_id": level_id,
        "soil_type": soil_type,
        "season_index": 0,
        "seasons_total": level["seasons"],
        "budget": float(start["budget"]),
        "reserve_mm": float(start["reserve_mm"]),
        "soil": soil,
        "history": list(start["history"]),
        "results": [],
        "finished": False,
        "failed": None,
        "start_budget": float(start["budget"]),
        "start_reserve_mm": float(start["reserve_mm"]),
        "start_soil": dict(soil),
    }


def normalize_decision(d: dict[str, Any]) -> dict[str, Any]:
    return {k: d.get(k) for k in DECISION_FIELDS}


def plan_cost(model: dict[str, Any], run: dict[str, Any], d: dict[str, Any]) -> dict[str, float]:
    """Costs known before the season. Water is paid per pumped mm, so its maximum is reserved up front:
    the budget can never go negative whatever the weather."""
    level = level_by_id(model, run["level_id"])
    mult = level["economy"]["cost"]
    crop = model["crops"].get(d.get("crop") or "", {})
    care = model["soil_care"].get(d.get("care") or "", {})
    method = model["irrigation_methods"].get(d.get("method") or "", {})
    intensity = model["irrigation_intensity"].get(d.get("intensity") or "", {})
    irrigating = bool(intensity) and intensity["cap_mm"] > 0 and bool(method)
    max_water = min(intensity["cap_mm"], run["reserve_mm"]) if irrigating else 0.0
    parts = {
        "seeds": crop.get("seed_cost", 0) * mult,
        "fixed": model["farm"]["fixed_costs"] * mult,
        "care": care.get("cost", 0) * mult,
        "irrigation_setup": method["setup_cost"] * mult if irrigating else 0.0,
        "water_max": max_water * method["cost_per_mm"] * mult if irrigating else 0.0,
    }
    parts["total_max"] = sum(parts.values())
    return {k: round(v) for k, v in parts.items()}


def min_plan_cost(model: dict[str, Any], run: dict[str, Any]) -> float:
    cheapest = min(c["seed_cost"] for c in options(model["crops"]).values())
    mult = level_by_id(model, run["level_id"])["economy"]["cost"]
    return (cheapest + model["farm"]["fixed_costs"]) * mult


def validate_decision(model: dict[str, Any], run: dict[str, Any], d: dict[str, Any]) -> dict[str, Any]:
    """Every decision is required; values must exist; the plan must fit the budget and the reserve."""
    tables = {
        "crop": options(model["crops"]),
        "method": options(model["irrigation_methods"]),
        "intensity": options(model["irrigation_intensity"]),
        "care": options(model["soil_care"]),
    }
    missing = [f for f in DECISION_FIELDS if d.get(f) in (None, "")]
    errors = [f"unknown_{f}" for f in DECISION_FIELDS if f not in missing and d.get(f) not in tables[f]]
    if run["finished"] or run["failed"]:
        errors.append("level_over")
    if not missing and not errors:
        if plan_cost(model, run, d)["total_max"] > run["budget"]:
            errors.append("budget")
        if d["intensity"] != "off" and run["reserve_mm"] <= 0:
            errors.append("reserve_empty")
    return {"ok": not missing and not errors, "missing": missing, "errors": errors}


# ---------- Daily water balance ----------


def _kc(kc: list[float], frac: float) -> float:
    ini, mid, end = kc
    if frac < 0.2:
        return ini
    if frac < 0.45:
        return ini + (mid - ini) * (frac - 0.2) / 0.25
    if frac < 0.8:
        return mid
    return mid + (end - mid) * min(1.0, (frac - 0.8) / 0.2)


def water_balance(
    model: dict[str, Any],
    soil_type: str,
    season: Season,
    d: dict[str, Any],
    moisture_pct: float,
    reserve_mm: float,
    irrigate: bool = True,
) -> dict[str, Any]:
    farm, ym, th = model["farm"], model["yield_model"], model["weather_thresholds"]
    soil = model["soils"][soil_type]
    crop = model["crops"][d["crop"]]
    care = model["soil_care"][d["care"]]
    method = model["irrigation_methods"][d["method"]]
    intensity = model["irrigation_intensity"][d["intensity"] if irrigate else "off"]
    m = season.model
    taw = taw_mm(model, soil_type)
    p = farm["depletion_fraction_p"]
    raw = p * taw
    dr = taw * (1 - clamp(moisture_pct) / 100)
    excess = 0.0
    sat = soil["saturation_extra_mm"]
    drain_rate = min(0.95, soil["drainage_rate"] + care["drainage_add"])
    infil_cap = soil["infiltration_mm_day"] * care["infiltration"]
    wind_on = "WS2M" not in season.unavailable
    reserve = reserve_mm
    cap = intensity["cap_mm"]
    flo_lo, flo_hi = ym["flowering_window"]

    t = {
        k: 0.0
        for k in ("gdd", "etc", "eta", "pumped", "net_irr", "loss", "runoff", "irr_runoff", "drain", "heat_dd", "rain")
    }
    frost_days = waterlog_days = wind_days = irrigation_events = stress_days = 0
    reserve_out_day: int | None = None
    trace_moisture: list[int] = []
    trace_irr: list[float] = []
    maturity_day: int | None = None

    for i in range(season.days):
        tmax, tmin, rain, et0 = m["tmax"][i], m["tmin"][i], m["rain"][i], m["et0"][i]
        frac = t["gdd"] / crop["gdd_need"]
        growing = frac < 1
        if growing:
            tavg = clamp((tmax + tmin) / 2, crop["gdd_base"], crop["gdd_upper"])
            t["gdd"] += tavg - crop["gdd_base"]
            if t["gdd"] >= crop["gdd_need"] and maturity_day is None:
                maturity_day = i
            kc = _kc(crop["kc"], frac) * (care["evaporation"] if frac < 0.2 else 1.0)
        else:
            kc = farm["fallow_kc"] * care["evaporation"]

        runoff = max(0.0, rain - infil_cap)
        infiltrated = rain - runoff
        t["rain"] += rain

        net_today = 0.0
        if growing and cap > 0 and dr > intensity["trigger"] * taw and t["pumped"] < cap:
            if reserve <= 0:
                reserve_out_day = reserve_out_day if reserve_out_day is not None else i
            else:
                eff = method["efficiency"]
                if "wind_loss_per_m_s" in method:
                    wind = m["ws"][i] if wind_on else 0.0
                    eff = max(
                        method["min_efficiency"],
                        eff
                        - method["wind_loss_per_m_s"] * max(0.0, wind - 3)
                        - method["heat_loss_per_c"] * max(0.0, tmax - 30),
                    )
                net = max(dr - intensity["target"] * taw, method["min_net_mm"])
                gross = min(net / eff, reserve, cap - t["pumped"])
                net_today = gross * eff
                loss = gross - net_today
                t["pumped"] += gross
                reserve -= gross
                t["net_irr"] += net_today
                t["loss"] += loss
                t["drain"] += loss * method["loss_to_drainage"]
                if d["method"] == "flood":
                    t["irr_runoff"] += loss * (1 - method["loss_to_drainage"])
                irrigation_events += 1
                if reserve <= 0 and reserve_out_day is None:
                    reserve_out_day = i
        infiltrated += net_today

        dr -= infiltrated
        if dr < 0:
            excess += -dr
            dr = 0.0
        if excess > sat:
            runoff += excess - sat
            excess = sat
        t["runoff"] += runoff
        drained = excess * drain_rate
        excess -= drained
        t["drain"] += drained
        if growing and excess > farm["waterlog_share"] * sat:
            waterlog_days += 1

        etc = kc * et0
        ks = 1.0 if dr <= raw else max(0.0, (taw - dr) / ((1 - p) * taw))
        eta = etc * ks
        from_excess = min(excess, eta)
        excess -= from_excess
        dr = min(taw, dr + eta - from_excess)
        if growing:
            t["etc"] += etc
            t["eta"] += eta
            if ks < 0.8:
                stress_days += 1
            weight = ym["flowering_heat_weight"] if flo_lo <= frac < flo_hi else ym["other_heat_weight"]
            if tmax > crop["heat_tmax_c"]:
                t["heat_dd"] += (tmax - crop["heat_tmax_c"]) * weight
            if tmin < crop["frost_tmin_c"]:
                frost_days += 1
        if wind_on and m["ws"][i] >= th["windy_day_ws2m_m_s"] and dr > 0.7 * taw:
            wind_days += 1
        trace_moisture.append(round(100 * (1 - dr / taw)))
        trace_irr.append(round(net_today, 1))

    return {
        "taw_mm": round(taw),
        "gdd": t["gdd"],
        "gdd_need": crop["gdd_need"],
        "maturity_day": maturity_day,
        "etc_mm": t["etc"],
        "eta_mm": t["eta"],
        "pumped_mm": t["pumped"],
        "net_irrigation_mm": t["net_irr"],
        "loss_mm": t["loss"],
        "runoff_mm": t["runoff"],
        "irrigation_runoff_mm": t["irr_runoff"],
        "drainage_mm": t["drain"],
        "heat_degree_days": t["heat_dd"],
        "frost_days": frost_days,
        "waterlog_days": waterlog_days,
        "wind_erosion_days": wind_days,
        "stress_days": stress_days,
        "irrigation_events": irrigation_events,
        "reserve_out_day": reserve_out_day,
        "rain_mm": t["rain"],
        "end_moisture_pct": round(100 * (1 - dr / taw)),
        "reserve_left_mm": reserve,
        "trace": {"moisture_pct": trace_moisture, "irrigation_mm": trace_irr},
    }


# ---------- One season ----------


def _loss_shares(factors: dict[str, float], total_loss: float) -> dict[str, float]:
    logs = {k: -math.log(max(f, 1e-4)) for k, f in factors.items() if f < 0.9995}
    s = sum(logs.values())
    return {k: round(total_loss * v / s, 1) for k, v in logs.items()} if s > 0 else {}


def simulate(model: dict[str, Any], run: dict[str, Any], season: Season, decision: dict[str, Any]) -> dict[str, Any]:
    """Simulate the current season for a decision without changing the run."""
    d = normalize_decision(decision)
    level = level_by_id(model, run["level_id"])
    ym, sm, farm = model["yield_model"], model["soil_model"], model["farm"]
    soil_type = run["soil_type"]
    soil_cfg = model["soils"][soil_type]
    crop = model["crops"][d["crop"]]
    care = model["soil_care"][d["care"]]
    f = season.features
    soil = run["soil"]
    history = run["history"]
    prev = history[-1] if history else None
    prev2 = history[-2] if len(history) > 1 else None

    wb = water_balance(model, soil_type, season, d, soil["moisture"], run["reserve_mm"])
    dry = (
        water_balance(model, soil_type, season, d, soil["moisture"], run["reserve_mm"], irrigate=False)
        if d["intensity"] != "off"
        else wb
    )
    useful_mm = max(0.0, wb["eta_mm"] - dry["eta_mm"])

    # Nitrogen available this season
    temp_f = clamp(((f["t_mean_c"] or 15) - 5) / 15, 0.2, 1.3)
    mineral = (
        soil["om"] * sm["mineralization_per_om"] * season.days / sm["reference_days"] * temp_f * care["mineralization"]
    )
    n_pre = soil["n"] + mineral
    leach_share = min(sm["max_leach_share"], wb["drainage_mm"] / sm["leach_drainage_mm"])
    leached = n_pre * sm["leachable_share"] * leach_share
    n_avail = n_pre - leached

    # Yield factors (1 = no loss)
    ratio = wb["eta_mm"] / wb["etc_mm"] if wb["etc_mm"] > 0 else 1.0
    frac = wb["gdd"] / wb["gdd_need"]
    rh_ok = f.get("rh_mean_pct") is not None
    solar = f.get("solar_mean_mj_m2_day")
    rotation = 1.0
    if prev == d["crop"]:
        rotation = ym["rotation_same_crop_twice"] if prev2 == d["crop"] else ym["rotation_same_crop"]
    elif prev and model["crops"][prev]["family"] == crop["family"]:
        rotation = ym["rotation_same_family"]
    humid = (
        clamp((f["rh_mean_pct"] - ym["humid_disease_rh"]) / (ym["humid_full_rh"] - ym["humid_disease_rh"]), 0, 1)
        if rh_ok
        else 0.0
    )
    sprinkler_wet = d["intensity"] != "off" and d["method"] == "sprinkler" and humid > 0
    disease = (1 - crop["humid_loss"] * humid) * (ym["humid_sprinkler_factor"] if sprinkler_wet else 1.0)
    factors = {
        "water": max(0.0, 1 - crop["ky"] * (1 - ratio)),
        "heat": max(ym["min_heat_factor"], 1 - ym["heat_loss_per_degree_day"] * wb["heat_degree_days"]),
        "frost": max(ym["min_frost_factor"], 1 - ym["frost_loss_per_day"] * wb["frost_days"]),
        "waterlog": max(0.0, 1 - ym["waterlog_loss_per_day"] * wb["waterlog_days"] * (1 - crop["wet_tolerance"])),
        "maturity": 1.0 if frac >= 1 else max(0.0, (frac - ym["min_maturity_share"]) / (1 - ym["min_maturity_share"])),
        "nitrogen": min(1.0, ym["n_base_share"] + (1 - ym["n_base_share"]) * n_avail / crop["n_need"]),
        "rotation": rotation,
        "disease": disease,
        "light": min(1.0, 1 - ym["light_weight"] + ym["light_weight"] * solar / ym["light_reference_mj"])
        if solar
        else 1.0,
        "weeds": care["yield"],
    }
    rel = clamp(math.prod(factors.values()), 0, 1)
    yield_pct = round(rel * 100)
    losses = _loss_shares(factors, 100 - rel * 100)

    # Soil after the season
    uptake = min(n_avail, crop["n_need"] * rel)
    residue_n = sm["cereal_residue_n"] * rel if crop["family"] == "cereal" else 0.0
    fixed = crop["n_residual"] * rel
    erosion_event = (
        wb["runoff_mm"] * soil_cfg["water_erodibility"] * sm["water_erosion_per_mm"]
        + wb["irrigation_runoff_mm"] * soil_cfg["water_erodibility"] * sm["flood_erosion_per_mm"]
        + wb["wind_erosion_days"] * soil_cfg["wind_erodibility"] * sm["wind_erosion_per_day"]
    ) * (1 - care["protection"])
    decay = sm["om_decay_rate"] * soil_cfg["om_decay"] * temp_f * care["decay"] * (soil["om"] / 2)
    om_lo, om_hi = sm["om_range"]
    soil_end = {
        "moisture": float(wb["end_moisture_pct"]),
        "n": round(clamp(n_avail - uptake + fixed + residue_n + care["n"], 0, sm["n_max"]), 1),
        "om": round(
            clamp(
                soil["om"] + crop["residue_om"] * rel + care["om"] - decay - erosion_event * sm["om_erosion_loss"],
                om_lo,
                om_hi,
            ),
            2,
        ),
        "erosion": round(clamp(soil["erosion"] + erosion_event - care["recovery"]), 1),
    }
    # Off-season (not simulated): moisture moves towards a typical level; practices shift it.
    next_moisture = clamp(
        soil_end["moisture"]
        + (farm["offseason_moisture_target"] - soil_end["moisture"]) * farm["offseason_mix"]
        + care["next_moisture"],
        5,
        95,
    )
    soil_next = {**soil_end, "moisture": round(next_moisture)}

    # Money and water
    econ = level["economy"]
    costs = plan_cost(model, run, d)
    method = model["irrigation_methods"][d["method"]]
    water_cost = round(wb["pumped_mm"] * method["cost_per_mm"] * econ["cost"])
    cost = costs["seeds"] + costs["fixed"] + costs["care"] + costs["irrigation_setup"] + water_cost
    revenue = round(crop["potential_t_ha"] * rel * farm["area_ha"] * crop["price_per_t"] * econ["price"])
    refill = min(farm["reserve_cap_mm"] - wb["reserve_left_mm"], farm["reserve_refill_share"] * f["rain_total_mm"])
    reserve_after = clamp(wb["reserve_left_mm"] + max(0.0, refill), 0, farm["reserve_cap_mm"])

    state = "healthy"
    if factors["water"] < 0.75:
        state = "drought"
    elif factors["waterlog"] < 0.85 or (leach_share > 0.45 and factors["nitrogen"] < 0.9):
        state = "overwater"
    elif factors["heat"] < 0.8:
        state = "heatstress"
    elif factors["frost"] < 0.8:
        state = "frost"
    elif factors["maturity"] < 0.9:
        state = "immature"
    elif factors["nitrogen"] < 0.8:
        state = "lownutrients"
    elif factors["rotation"] < 1 or factors["disease"] < 1:
        state = "disease"

    outcome = {
        "season_index": run["season_index"],
        "year": season.year,
        "decision": d,
        "state": state,
        "yield_pct": yield_pct,
        "harvest_t": round(crop["potential_t_ha"] * rel * farm["area_ha"], 1),
        "factors": {k: round(v, 3) for k, v in factors.items()},
        "losses_pp": losses,
        "water": {
            "taw_mm": wb["taw_mm"],
            "crop_demand_mm": round(wb["etc_mm"]),
            "crop_use_mm": round(wb["eta_mm"]),
            "ratio": round(ratio, 2),
            "rain_mm": round(wb["rain_mm"]),
            "runoff_mm": round(wb["runoff_mm"]),
            "drainage_mm": round(wb["drainage_mm"]),
            "pumped_mm": round(wb["pumped_mm"]),
            "net_irrigation_mm": round(wb["net_irrigation_mm"]),
            "loss_mm": round(wb["loss_mm"]),
            "useful_mm": round(useful_mm),
            "irrigation_events": wb["irrigation_events"],
            "reserve_before_mm": round(run["reserve_mm"]),
            "reserve_left_mm": round(wb["reserve_left_mm"]),
            "refill_mm": round(max(0.0, refill)),
            "reserve_after_mm": round(reserve_after),
            "reserve_out_day": wb["reserve_out_day"],
            "waterlog_days": wb["waterlog_days"],
            "stress_days": wb["stress_days"],
        },
        "crop": {
            "gdd": round(wb["gdd"]),
            "gdd_need": wb["gdd_need"],
            "maturity_day": wb["maturity_day"],
            "heat_degree_days": round(wb["heat_degree_days"], 1),
            "frost_days": wb["frost_days"],
        },
        "nitrogen": {
            "start": round(soil["n"], 1),
            "mineralized": round(mineral, 1),
            "leached": round(leached, 1),
            "available": round(n_avail, 1),
            "need": crop["n_need"],
            "uptake": round(uptake, 1),
            "fixed": round(fixed, 1),
            "residue": round(residue_n, 1),
            "care": care["n"],
        },
        "erosion_event": round(erosion_event, 1),
        "soil_before": {k: round(v, 2) for k, v in soil.items()},
        "soil_end": soil_end,
        "soil_next": soil_next,
        "fertility_before": fertility(model, soil),
        "fertility_after": fertility(model, soil_end),
        "economics": {
            "costs": {**{k: v for k, v in costs.items() if k not in ("water_max", "total_max")}, "water": water_cost},
            "cost": cost,
            "cost_max": costs["total_max"],
            "revenue": revenue,
            "profit": revenue - cost,
            "budget_before": round(run["budget"]),
            "budget_after": round(run["budget"] - cost + revenue),
        },
        "trace": {**wb["trace"], "rain_mm": [round(x, 1) for x in season.model["rain"]]},
    }
    outcome["reasons"] = explain(model, run, season, d, outcome, wb)
    return outcome


def explain(
    model: dict[str, Any], run: dict[str, Any], season: Season, d: dict[str, Any], o: dict[str, Any], wb: dict[str, Any]
) -> list[dict[str, Any]]:
    """Reasons for the result. category: nasa | player | computed | assumption. loss = yield points lost."""
    f, th, crop = season.features, model["weather_thresholds"], model["crops"][d["crop"]]
    loss = o["losses_pp"]
    w = o["water"]
    r: list[dict[str, Any]] = [
        {
            "code": "data.rain",
            "category": "nasa",
            "vars": {
                "rain": f["rain_total_mm"],
                "heavy": f["heavy_rain_days"],
                "dry_spell": f["longest_dry_spell_days"],
                "days": season.days,
            },
        },
        {
            "code": "data.heat",
            "category": "nasa",
            "vars": {"hot_days": f["hot_days"], "threshold": th["hot_day_tmax_c"], "tmax": f["tmax_mean_c"]},
        },
        {
            "code": "model.demand",
            "category": "computed",
            "vars": {"et0": f["et0_total_mm"], "demand": w["crop_demand_mm"], "method": season.et0_method},
        },
    ]
    if "water" in loss:
        r.append(
            {
                "code": "yield.water",
                "category": "computed",
                "loss": loss["water"],
                "vars": {
                    "use": w["crop_use_mm"],
                    "demand": w["crop_demand_mm"],
                    "pct": round(100 * w["ratio"]),
                    "taw": w["taw_mm"],
                    "soil": run["soil_type"],
                },
            }
        )
    if "heat" in loss:
        r.append(
            {
                "code": "yield.heat",
                "category": "computed",
                "loss": loss["heat"],
                "vars": {"threshold": crop["heat_tmax_c"], "dd": o["crop"]["heat_degree_days"]},
            }
        )
    if "frost" in loss:
        r.append(
            {
                "code": "yield.frost",
                "category": "computed",
                "loss": loss["frost"],
                "vars": {"days": o["crop"]["frost_days"], "threshold": crop["frost_tmin_c"]},
            }
        )
    if "waterlog" in loss:
        r.append(
            {
                "code": "yield.waterlog",
                "category": "computed",
                "loss": loss["waterlog"],
                "vars": {"days": w["waterlog_days"], "soil": run["soil_type"]},
            }
        )
    if "maturity" in loss:
        r.append(
            {
                "code": "yield.maturity",
                "category": "computed",
                "loss": loss["maturity"],
                "vars": {"gdd": o["crop"]["gdd"], "need": o["crop"]["gdd_need"]},
            }
        )
    if "nitrogen" in loss:
        r.append(
            {
                "code": "yield.nitrogen",
                "category": "computed",
                "loss": loss["nitrogen"],
                "vars": {
                    "available": o["nitrogen"]["available"],
                    "need": o["nitrogen"]["need"],
                    "leached": o["nitrogen"]["leached"],
                },
            }
        )
    if "rotation" in loss:
        r.append(
            {
                "code": "yield.rotation",
                "category": "player",
                "loss": loss["rotation"],
                "vars": {"prev": run["history"][-1] if run["history"] else ""},
            }
        )
    if "disease" in loss:
        r.append(
            {"code": "yield.disease", "category": "computed", "loss": loss["disease"], "vars": {"rh": f["rh_mean_pct"]}}
        )
    if "light" in loss:
        r.append(
            {
                "code": "yield.light",
                "category": "computed",
                "loss": loss["light"],
                "vars": {"solar": f["solar_mean_mj_m2_day"]},
            }
        )
    if "weeds" in loss:
        r.append({"code": "yield.weeds", "category": "assumption", "loss": loss["weeds"], "vars": {}})
    prev = run["history"][-1] if run["history"] else None
    if prev and model["crops"][prev]["family"] == "legume" and crop["family"] != "legume":
        r.append({"code": "soil.legume_before", "category": "player", "vars": {"prev": prev}})
    if d["intensity"] != "off":
        r.append(
            {
                "code": "irrigation.summary",
                "category": "player",
                "vars": {
                    "pumped": w["pumped_mm"],
                    "net": w["net_irrigation_mm"],
                    "useful": w["useful_mm"],
                    "events": w["irrigation_events"],
                },
            }
        )
        if w["pumped_mm"] > 0 and w["useful_mm"] < 0.5 * w["pumped_mm"]:
            r.append(
                {
                    "code": "irrigation.wasted",
                    "category": "computed",
                    "vars": {"wasted": w["pumped_mm"] - w["useful_mm"], "pumped": w["pumped_mm"]},
                }
            )
        if w["reserve_out_day"] is not None:
            r.append(
                {"code": "irrigation.reserve_out", "category": "computed", "vars": {"day": w["reserve_out_day"] + 1}}
            )
    elif o["factors"]["water"] < 0.9:
        r.append({"code": "irrigation.none_dry", "category": "player", "vars": {}})
    if w["runoff_mm"] >= 10:
        r.append(
            {"code": "soil.runoff", "category": "computed", "vars": {"mm": w["runoff_mm"], "soil": run["soil_type"]}}
        )
    if o["nitrogen"]["leached"] >= 3:
        r.append(
            {
                "code": "soil.leached",
                "category": "computed",
                "vars": {"kg": o["nitrogen"]["leached"], "drain": w["drainage_mm"]},
            }
        )
    if o["erosion_event"] >= 1:
        r.append({"code": "soil.erosion", "category": "computed", "vars": {"value": o["erosion_event"]}})
    if o["nitrogen"]["fixed"] > 0:
        r.append({"code": "soil.fixation", "category": "computed", "vars": {"kg": o["nitrogen"]["fixed"]}})
    if d["care"] != "none":
        r.append({"code": f"care.{d['care']}", "category": "player", "vars": {}})
    gaps = sum(len(g) for g in season.gaps.values())
    if gaps:
        r.append({"code": "assume.gaps", "category": "assumption", "vars": {"count": gaps}})
    if season.unavailable:
        r.append(
            {
                "code": "assume.unavailable",
                "category": "assumption",
                "vars": {"params": ", ".join(season.unavailable), "method": season.et0_method},
            }
        )
    return r


# ---------- Playing a level ----------


def play(
    model: dict[str, Any], run: dict[str, Any], season: Season, decision: dict[str, Any]
) -> tuple[dict[str, Any], dict[str, Any]]:
    """Play the current season. Returns (new run, outcome); the given run is not modified."""
    d = normalize_decision(decision)
    check = validate_decision(model, run, d)
    if not check["ok"]:
        raise DecisionError(check["missing"], check["errors"])
    outcome = simulate(model, run, season, d)
    nxt = deepcopy(run)
    nxt["season_index"] += 1
    nxt["budget"] = float(outcome["economics"]["budget_after"])
    nxt["reserve_mm"] = float(outcome["water"]["reserve_after_mm"])
    nxt["soil"] = {k: float(v) for k, v in outcome["soil_next"].items()}
    nxt["history"].append(d["crop"])
    nxt["results"].append(outcome)
    nxt["finished"] = nxt["season_index"] >= nxt["seasons_total"]
    level = level_by_id(model, run["level_id"])
    for cond in level["lose"]:
        if cond["metric"] == "min_yield" and outcome["yield_pct"] < cond["value"]:
            nxt["failed"] = "crop_failure"
    if not nxt["failed"] and not nxt["finished"] and nxt["budget"] < min_plan_cost(model, nxt):
        nxt["failed"] = "bankrupt"
    if nxt["failed"]:
        nxt["finished"] = True
    return nxt, outcome


def replay(
    model: dict[str, Any], level_id: int, soil_type: str, seasons: list[Season], decisions: list[dict[str, Any]]
) -> tuple[dict[str, Any], list[dict[str, Any]]]:
    """Rebuild a run from the level start. Returns (run, runs_before_each_season)."""
    run = new_run(model, level_id, soil_type)
    before: list[dict[str, Any]] = []
    for i, d in enumerate(decisions):
        if run["finished"]:
            raise DecisionError([], ["level_over"])
        before.append(run)
        try:
            run, _ = play(model, run, seasons[i], d)
        except DecisionError as exc:
            exc.args = (f"season {i + 1}: {exc}",)
            raise
    return run, before


# ---------- Evaluation ----------


def metrics(model: dict[str, Any], run: dict[str, Any]) -> dict[str, Any]:
    r = run["results"]
    pumped = sum(o["water"]["pumped_mm"] for o in r)
    useful = sum(o["water"]["useful_mm"] for o in r)
    f_start, f_end = fertility(model, run["start_soil"]), fertility(model, run["soil"])
    return {
        "avg_yield": round(sum(o["yield_pct"] for o in r) / len(r)) if r else 0,
        "min_yield": min((o["yield_pct"] for o in r), default=0),
        "reserve_end": round(run["reserve_mm"]),
        "pumped_mm": round(pumped),
        "useful_mm": round(useful),
        "fertility_start": f_start,
        "fertility_end": f_end,
        "fertility_delta": f_end - f_start,
        "erosion_delta": round(run["soil"]["erosion"] - run["start_soil"]["erosion"], 1),
        "n_delta": round(run["soil"]["n"] - run["start_soil"]["n"], 1),
        "om_delta": round(run["soil"]["om"] - run["start_soil"]["om"], 2),
        "n_leached": round(sum(o["nitrogen"]["leached"] for o in r), 1),
        "final_budget": round(run["budget"]),
        "profit": round(run["budget"] - run["start_budget"]),
        "revenue": sum(o["economics"]["revenue"] for o in r),
    }


def water_score(model: dict[str, Any], run: dict[str, Any], m: dict[str, Any]) -> int:
    sc = model["scoring"]
    efficiency = m["useful_mm"] / m["pumped_mm"] if m["pumped_mm"] > 0 else 1.0
    kept = 1 - min(1.0, m["pumped_mm"] / run["start_reserve_mm"]) if run["start_reserve_mm"] > 0 else 1.0
    return round(sc["water_efficiency_weight"] * min(1.0, efficiency) + sc["water_reserve_weight"] * kept)


def _cmp(value: float, op: str, target: float) -> bool:
    return {">=": value >= target, "<=": value <= target, ">": value > target, "<": value < target}[op]


def recommendations(model: dict[str, Any], run: dict[str, Any], m: dict[str, Any]) -> list[str]:
    recs: list[str] = []
    r = run["results"]
    if any(o["factors"]["water"] < 0.75 for o in r):
        recs.append("drought")
    if m["pumped_mm"] > 0 and m["useful_mm"] < 0.6 * m["pumped_mm"]:
        recs.append("irrigationWaste")
    if any(o["decision"]["method"] == "flood" and o["water"]["pumped_mm"] > 0 for o in r):
        recs.append("flood")
    if m["n_leached"] > 15:
        recs.append("leaching")
    if m["erosion_delta"] > 2:
        recs.append("erosion")
    if any(o["factors"]["rotation"] < 1 for o in r):
        recs.append("rotation")
    if any(o["factors"]["nitrogen"] < 0.8 for o in r):
        recs.append("nitrogen")
    if any(o["factors"]["heat"] < 0.85 for o in r):
        recs.append("heat")
    if any(o["factors"]["waterlog"] < 0.9 for o in r):
        recs.append("waterlog")
    if any(o["factors"]["maturity"] < 0.95 for o in r):
        recs.append("maturity")
    if m["profit"] < 0:
        recs.append("costs")
    return recs[:5]


def evaluate(model: dict[str, Any], run: dict[str, Any]) -> dict[str, Any]:
    level = level_by_id(model, run["level_id"])
    m = metrics(model, run)
    goals = [
        {
            **g,
            "actual": m[g["metric"]],
            "met": run["finished"] and not run["failed"] and _cmp(m[g["metric"]], g["op"], g["value"]),
        }
        for g in level["goals"]
    ]
    passed = run["finished"] and not run["failed"] and all(g["met"] for g in goals)
    ws = water_score(model, run, m)
    stars_cfg = level["stars"]
    categories = {
        "yield": {
            "score": m["avg_yield"],
            "target": stars_cfg["yield"],
            "earned": m["avg_yield"] >= stars_cfg["yield"],
        },
        "water": {"score": ws, "target": stars_cfg["water"], "earned": ws >= stars_cfg["water"]},
        "soil": {
            "score": m["fertility_end"],
            "delta": m["fertility_delta"],
            "target": stars_cfg["soil"],
            "earned": m["fertility_delta"] >= stars_cfg["soil"],
        },
    }
    stars = sum(1 for c in categories.values() if c["earned"]) if passed else 0
    score = round(0.4 * m["avg_yield"] + 0.3 * ws + 0.3 * m["fertility_end"])
    return {
        "level_id": run["level_id"],
        "passed": passed,
        "fail_reason": run["failed"] or (None if passed else "goals"),
        "goals": goals,
        "stars": stars,
        "score": score,
        "categories": categories,
        "metrics": m,
        "recommendations": recommendations(model, run, m),
    }


# ---------- Level weather fit ----------


def weather_fit(
    model: dict[str, Any], level: dict[str, Any], seasons: dict[int, Season], ref_rain: float | None, year: int
) -> dict[str, Any]:
    """Does the season starting in `year` fit the level's weather situation? Pure data checks, no randomness."""
    years = [year + k for k in range(level["seasons"])]
    missing = [y for y in years if y not in seasons or not seasons[y].complete]
    if missing:
        return {"ok": False, "reason": "incomplete", "years": years, "missing": missing}
    f = seasons[year].features
    w = level["weather"]
    kind = w["type"]
    values: dict[str, Any] = {}
    ok = True
    if kind == "dry":
        share = f["rain_total_mm"] / ref_rain if ref_rain else None
        values = {
            "rain": f["rain_total_mm"],
            "reference_rain": ref_rain,
            "share": None if share is None else round(share, 2),
            "max_share": w["max_rain_share"],
        }
        ok = share is not None and share <= w["max_rain_share"]
    elif kind == "hot":
        values = {
            "hot_days": f["hot_days"],
            "min_hot_days": w["min_hot_days"],
            "threshold": model["weather_thresholds"]["hot_day_tmax_c"],
        }
        ok = f["hot_days"] >= w["min_hot_days"]
    elif kind == "wet":
        share = f["rain_total_mm"] / ref_rain if ref_rain else None
        values = {
            "heavy_days": f["heavy_rain_days"],
            "min_heavy_days": w["min_heavy_rain_days"],
            "share": None if share is None else round(share, 2),
            "min_share": w["min_rain_share"],
        }
        ok = f["heavy_rain_days"] >= w["min_heavy_rain_days"] or (share is not None and share >= w["min_rain_share"])
    return {"ok": ok, "reason": None if ok else kind, "years": years, "type": kind, "values": values}


def fit_strength(kind: str, f: dict[str, Any]) -> float:
    return {
        "dry": -f["rain_total_mm"],
        "hot": f["hot_days"],
        "wet": f["heavy_rain_days"] * 50 + f["rain_total_mm"],
    }.get(kind, 0)


# ---------- What If ----------


def _summary(o: dict[str, Any]) -> dict[str, Any]:
    return {
        "yield_pct": o["yield_pct"],
        "profit": o["economics"]["profit"],
        "pumped_mm": o["water"]["pumped_mm"],
        "useful_mm": o["water"]["useful_mm"],
        "reserve_after_mm": o["water"]["reserve_after_mm"],
        "fertility_after": o["fertility_after"],
        "erosion_event": o["erosion_event"],
        "n_leached": o["nitrogen"]["leached"],
        "n_after": o["soil_end"]["n"],
        "state": o["state"],
    }


def compare(
    model: dict[str, Any],
    run: dict[str, Any],
    season: Season,
    base: dict[str, Any],
    field: str,
    value: str,
    criterion: str = "custom",
) -> dict[str, Any]:
    """Same field state, same NASA weather; only `field` changes."""
    if field not in DECISION_FIELDS:
        raise DecisionError([], [f"unknown_field_{field}"])
    alt_decision = {**normalize_decision(base["decision"]), field: value}
    check = validate_decision(model, {**run, "finished": False, "failed": None}, alt_decision)
    if not check["ok"]:
        raise DecisionError(check["missing"], check["errors"])
    alt = simulate(model, run, season, alt_decision)
    a, b = _summary(base), _summary(alt)
    diff = {k: round(b[k] - a[k], 2) for k in a if isinstance(a[k], (int, float))}
    factor_delta = {k: round(100 * (alt["factors"][k] - base["factors"][k]), 1) for k in base["factors"]}
    drivers = sorted((k for k, v in factor_delta.items() if abs(v) >= 1), key=lambda k: -abs(factor_delta[k]))[:3]
    return {
        "criterion": criterion,
        "change": {"field": field, "from": base["decision"][field], "to": value},
        "decision": alt_decision,
        "player": a,
        "alternative": b,
        "diff": diff,
        "factor_delta_pp": factor_delta,
        "drivers": drivers,
        "water": {k: alt["water"][k] for k in ("crop_use_mm", "drainage_mm", "runoff_mm", "waterlog_days")},
    }


def what_if(model: dict[str, Any], run: dict[str, Any], season: Season, base: dict[str, Any]) -> list[dict[str, Any]]:
    """Automatic alternatives, each changing ONE decision, with its selection criterion stated."""
    cfg = model["what_if"]
    tables = {
        "crop": model["crops"],
        "method": model["irrigation_methods"],
        "intensity": model["irrigation_intensity"],
        "care": model["soil_care"],
    }
    candidates: list[dict[str, Any]] = []
    for field in DECISION_FIELDS:
        if field == "method" and base["decision"]["intensity"] == "off":
            continue  # the method does not matter when nothing is pumped
        for value in options(tables[field]):
            if value == base["decision"][field]:
                continue
            try:
                candidates.append(compare(model, run, season, base, field, value))
            except DecisionError:
                continue  # not affordable or no water in the reserve
    y0 = base["yield_pct"]
    picks: list[tuple[str, dict[str, Any] | None]] = []

    saver = [
        c
        for c in candidates
        if c["alternative"]["pumped_mm"] < c["player"]["pumped_mm"] - 5
        and c["alternative"]["yield_pct"] >= y0 - cfg["acceptable_yield_drop_pp"]
    ]
    picks.append(
        (
            "water_saver",
            min(saver, key=lambda c: (c["alternative"]["pumped_mm"], -c["alternative"]["yield_pct"]), default=None),
        )
    )
    efficient = [
        c
        for c in candidates
        if c["change"]["field"] in ("method", "intensity")
        and c["alternative"]["pumped_mm"] <= c["player"]["pumped_mm"]
        and c["diff"]["useful_mm"] >= cfg["min_useful_gain_mm"]
        and c["alternative"]["yield_pct"] >= y0 - cfg["acceptable_yield_drop_pp"]
    ]
    picks.append(("water_efficiency", max(efficient, key=lambda c: c["diff"]["useful_mm"], default=None)))
    gain = [c for c in candidates if c["diff"]["yield_pct"] >= cfg["min_yield_gain_pp"]]
    picks.append(("yield_gain", max(gain, key=lambda c: (c["diff"]["yield_pct"], c["diff"]["profit"]), default=None)))
    soil = [
        c
        for c in candidates
        if c["diff"]["fertility_after"] >= cfg["min_fertility_gain"]
        and c["alternative"]["yield_pct"] >= y0 - cfg["soil_yield_drop_pp"]
    ]
    picks.append(
        (
            "soil_gain",
            max(soil, key=lambda c: (c["diff"]["fertility_after"], -c["diff"]["erosion_event"]), default=None),
        )
    )
    money = [c for c in candidates if c["diff"]["profit"] >= cfg["min_profit_gain"]]
    picks.append(("profit_gain", max(money, key=lambda c: c["diff"]["profit"], default=None)))

    out: list[dict[str, Any]] = []
    seen: set[tuple[str, str]] = set()
    for criterion, c in picks:
        if c is None:
            continue
        key = (c["change"]["field"], c["change"]["to"])
        if key in seen:
            for prev in out:
                if (prev["change"]["field"], prev["change"]["to"]) == key:
                    prev["also"] = [*prev.get("also", []), criterion]
            continue
        seen.add(key)
        out.append({**c, "criterion": criterion})
    return out
