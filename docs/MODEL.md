# Farm Navigator game model

Every number referred to here lives in [`app/data/game_model.json`](../app/data/game_model.json). The server engine
([`app/services/engine.py`](../app/services/engine.py)) and the browser (`GET /api/game/config`) both read it. The
values are **game coefficients chosen for learning, not universal agronomic norms**. The model is deterministic: the
same inputs always give the same result.

## Four kinds of values

| Kind | Examples | Where it comes from |
|---|---|---|
| **NASA data** | daily T2M, T2M_MAX, T2M_MIN, PRECTOTCORR, RH2M, WS2M, ALLSKY_SFC_SW_DWN; seasonal sums and counts of them | NASA POWER Daily Point API, `community=AG`, `time-standard=LST` |
| **Player inputs** | place, growing window, year, soil type, crop, irrigation system, water use, soil care | the player |
| **Computed** | ET0, crop water use, soil water, drainage, runoff, yield, N, organic matter, erosion, money, reserve | this model |
| **Assumptions** | gap filling, off-season, coefficients below | this document |

The API labels reasons with the same categories: `nasa`, `player`, `computed`, `assumption`.

## Weather features (per season, from daily NASA values)

These features are computed from the measured values only; gaps stay gaps.

**Thresholds** (`weather_thresholds`):
- hot day: T2M_MAX ≥ 30 °C;
- extreme heat: ≥ 35 °C;
- frost: T2M_MIN < 0 °C;
- dry day: PRECTOTCORR < 1 mm;
- downpour: ≥ 20 mm;
- windy day: WS2M ≥ 4 m/s.

**Features:**
- rain total;
- hot / extreme-heat / frost / downpour / windy days;
- longest run of dry days;
- mean T2M, T2M_MAX, T2M_MIN, RH2M, WS2M and radiation;
- reference evapotranspiration ET0.

**Reference and anomalies.**
- The reference is the mean and standard deviation of the same feature in the other complete years of the same point
  and window. The archive covers the last 20 complete years.
- A season is flagged hot, warm, dry or wet only if |z| ≥ 1 and at least 8 reference years exist. Otherwise no anomaly
  is claimed.

**Completeness.**
- A season is complete when each required parameter (T2M, T2M_MAX, T2M_MIN, PRECTOTCORR) misses at most 10 % of days.
- An optional parameter missing more than that, or arriving in unexpected units, is **unavailable**. Then:
  - ET0 uses Hargreaves–Samani (T2M_MAX, T2M_MIN, extraterrestrial radiation) instead of FAO-56 Penman–Monteith;
  - wind erosion, sprinkler wind losses, the humidity disease risk and the light limit are switched off.

**Model inputs.** Small gaps are filled for the simulation only: temperature, humidity, wind and radiation are linearly
interpolated, and missing rain counts as 0 mm. Filled gaps are reported as an assumption.

## Daily water balance (root zone)

**Stores.**
- TAW (total available water) = soil AWC × root zone of 0.8 m.
  - sandy: 70 mm/m → 56 mm;
  - loam: 170 mm/m → 136 mm;
  - clay: 190 mm/m → 152 mm.
- RAW = 0.5 × TAW.
- Water above field capacity is held in a saturated store (sandy 25, loam 40, clay 60 mm).

**Each day, in order:**
1. **Crop stage.** Degree days = clip((T2M_MAX + T2M_MIN)/2, base, upper) − base.
   - Stage = degree days ÷ the crop's need.
   - Kc follows an FAO-56-style curve: initial, then rising, then mid, then late.
   - After maturity the field is fallow (Kc 0.3).
   - Mulch and minimum tillage lower early-season evaporation.
2. **Rain.** Anything above the infiltration capacity runs off. Capacity: sandy 60, loam 35, clay 15 mm/day; mulch
   ×1.4, cover crop ×1.25, minimum tillage ×1.2.
3. **Irrigation.** Only while the crop grows, when depletion exceeds the trigger of the chosen water use (see the
   table under "Player decisions").
   - The pumped amount is limited by the seasonal cap and by the reserve.
   - The share that reaches the roots is the system's efficiency.
     - Flood 0.6, with at least 40 mm per watering. 70 % of its losses drain deep and 30 % run off, adding erosion.
     - Sprinkler 0.8, minus 0.03 per m/s of wind above 3 and 0.01 per °C of T2M_MAX above 30, but not below 0.55.
     - Drip 0.92.
4. **Water above field capacity.** It goes to the saturated store; overflow runs off.
5. **Drainage.** Each day the saturated store drains by a share: sandy 0.9, loam 0.5, clay 0.15; +0.5 with drainage
   care.
   - More than half full while the crop grows = a waterlogged day.
6. **Water use.** ETc = Kc × ET0.
   - The stress factor Ks = 1 while depletion ≤ RAW, and falls linearly to 0 at TAW.
   - ETa = Ks × ETc.
7. **Heat and frost.** Degree-days of T2M_MAX above the crop's heat limit are weighted 1 at flowering (stage 0.45–0.7)
   and 0.1 otherwise. Days below the crop's frost limit are counted.

"Useful irrigation" = crop water use with irrigation − crop water use in the same season without irrigation.

## Yield (relative, 0–100 % of the crop's game potential)

The product of factors; each report attributes the lost points to them in proportion to ln(factor).

| Factor | Formula |
|---|---|
| water | 1 − Ky × (1 − ETa/ETc) (FAO-33; Ky: wheat 1.15, maize 1.25, sorghum 0.9, chickpea 0.85) |
| heat | 1 − 0.008 × weighted heat degree-days (≥ 0.3) |
| frost | 1 − 0.04 × frost days (≥ 0.1) |
| waterlog | 1 − 0.03 × waterlogged days × (1 − wet tolerance) |
| maturity | 1 if the crop reached its degree days, else (stage − 0.5)/0.5 |
| nitrogen | 0.35 + 0.65 × available N / crop need (≤ 1) |
| rotation | 0.9 same crop as last season, 0.8 three times in a row, 0.97 same family |
| disease | 1 − humid_loss × clip((RH − 70)/15), × 0.94 with sprinklers in humid air |
| light | 0.7 + 0.3 × radiation/16 (≤ 1) |
| weeds | 0.97 with minimum tillage |

## Soil state (kept between seasons)

**Nitrogen** (kg N/ha, 0–150).
- Mineralisation = organic matter % × 15 × days/120 × temperature factor (× 0.9 with minimum tillage).
- Leaching = 0.6 × available N × min(0.6, drainage/250 mm).
- The crop takes up to its need × yield.
- Added after the season:
  - legumes: 35 × yield;
  - cereal residue: 5 × yield;
  - cover crop: 20.

**Organic matter** (%, 0.3–5).
- Added: crop residue and care (mulch +0.08, cover crop +0.1, minimum tillage +0.03).
- Lost: decay 0.05 × soil factor × temperature factor × OM/2 (× 0.7 with minimum tillage) and erosion × 0.004.

**Erosion** (index 0–100, higher = more topsoil lost).
- Added: runoff × water erodibility × 0.08, plus flood runoff × 0.02, plus windy dry days × wind erodibility × 0.5.
- All of it is multiplied by (1 − protection): mulch 0.6, cover crop 0.5, minimum tillage 0.4.
- Care then reduces it by: cover crop 2, mulch 1, minimum tillage 1.

**Moisture.** Carried from the end of the season. The off-season is not simulated: moisture moves halfway to 60 %,
cover crop −10, mulch +5 (**assumption**).

**Fertility** (0–100) = 0.3 × N score + 0.45 × organic-matter score + 0.25 × (100 − erosion).

**The same rain differs by soil:**
- sand holds little and drains fast, so more leaching and wind erosion;
- clay takes water in slowly, so more runoff and waterlogging;
- loam is in between.

## Player decisions

| Decision | Options (cost for a 10 ha farm) |
|---|---|
| Crop | wheat $1200, maize $2200, sorghum $900, chickpea (legume) $1600 |
| Irrigation system | flood (kit $200, $1.5/mm), sprinkler ($700, $3/mm), drip ($1300, $2.5/mm) |
| Water use | none; low (≤ 150 mm, water at 75 % depletion, refill to 40 %); medium (≤ 300 mm, at 50 %, refill to field capacity); high (≤ 450 mm, at 30 %, overfill 10 %) |
| Soil care | none; mulch $400; cover crop $450; minimum tillage $150; drainage $700 |

Fixed farm costs are $1500 per season.

**Validation (server and interface).**
- All four decisions are required.
- The maximum cost must fit the budget. It includes the water bill at min(cap, reserve).
- Irrigating with an empty reserve is refused.

The actual cost never exceeds the maximum, so the budget and the reserve cannot go negative.

**Money and water.**
- Revenue = potential t/ha × yield × 10 ha × price × level price factor.
- The reserve refills by 20 % of seasonal rain between seasons, up to 600 mm.

## Levels, win, lose and stars

The levels are listed in [`game_model.json`](../app/data/game_model.json) (`levels`).

**Lose conditions.**
- A season's yield below 10 % (levels 1, 2, 4, 5).
- Bankruptcy: the budget is below the cheapest possible plan before the next season.
- Any goal not met at the end.

**Stars** (only when the level is passed), one per criterion met:
- average yield ≥ target;
- water saving ≥ target, where water saving = 60 × useful ÷ pumped + 40 × share of the starting reserve kept;
- fertility change ≥ target.

**Year fit.** Dry and wet levels compare rain with the same window's reference. The hot level uses an absolute count
of hot days, so it is named "Hot season", not "heatwave". Suggestions start with the mildest year that still fits.

## Known limitations

- POWER is a grid-cell estimate (≈ 0.5° × 0.625°); mountain cells can be much cooler than nearby lowland farms.
- No crop phenology beyond degree days, no pests model, no soil layers, no groundwater.
- Nitrogen has no fertiliser option. Legumes, cover crops and organic matter are the only sources.
- Prices, costs and yields are fixed game values, not market data.
