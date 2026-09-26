/* =========================================================
   Farm Navigator game engine
   Pure and deterministic: the same level, NASA POWER season data and
   decisions always give the same result. No DOM, no randomness, no clock.
   Used by the browser (window.FarmEngine) and by the Node tests.
   Every number that changes a result is listed in MODEL below.
   ========================================================= */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.FarmEngine = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /**
   * @typedef {{year:number, start:string, end:string, days:number, temperature_c:number, rainfall_mm:number,
   *   humidity_percent:number, wind_speed_m_s:number, solar_radiation_mj_m2_day:number, heavy_rain_days:number,
   *   hot_days:number, longest_dry_spell_days:number}} Season
   * @typedef {{temperature_c:number, rainfall_mm:number, humidity_percent:number, wind_speed_m_s:number,
   *   solar_radiation_mj_m2_day:number, heavy_rain_days:number}} Baseline
   * @typedef {{seasons:Season[], baseline:Baseline, is_demo:boolean, source:string, hemisphere?:string,
   *   season_months?:string}} Climate
   * @typedef {{moisture:number, n:number, om:number, erosion:number}} Soil
   * @typedef {{crop:string|null, irrigation:number|null, method?:string, fertilizer:string|null,
   *   protection?:string}} Decision
   * @typedef {{season:Season, pickedAs:string}} PickedSeason
   * @typedef {{code:string, impact:number, param?:string, vars?:Object<string, number|string>}} Reason
   * @typedef {{type:string, severity:string, param:string, value:number, normal:number}} ClimateEvent
   */

  /* ---------- Model parameters ---------- */
  const MODEL = {
    REF_DAYS: 123,              // crop water needs below are for a 123-day (May–Aug) season
    STORAGE_MM: 120,            // plant-available water in the root zone at 100 % soil moisture
    RUNOFF_PER_HEAVY_DAY: 10,   // mm lost as runoff per day with ≥ 20 mm of rain (unprotected soil)
    RUNOFF_CAP: 0.4,            // runoff never exceeds 40 % of seasonal rain
    WATER_OK: [0.95, 1.45],     // supply ÷ demand range with no water stress
    DROUGHT_TOLERANCE_K: [180, 120], // water score lost per unit of deficit: 180 − 120 × tolerance
    SOIL_N_AVAILABLE: 0.6,      // share of the soil nitrogen pool plants can take up in one season
    YIELD_WEIGHTS: { water: 0.45, nutrients: 0.25, temperature: 0.2, solar: 0.1 },
    HEAT_PENALTY: 8,            // score points per °C above the crop's range
    COLD_PENALTY: 6,            // score points per °C below the crop's range
    LOW_SOLAR: 15,              // MJ/m²/day; below this photosynthesis is light-limited
    REFILL_DIVISOR: 12,         // reserve refill = seasonal rain ÷ 12 (max 35 points)
    REFILL_MAX: 35,
    MIN_SEED_COST: 800,         // below this budget no crop can be planted → bankrupt
  };

  /* ---------- Game options ---------- */
  const CROPS = {
    wheat:    { water: 380, temp: [10, 23], nNeed: 50, seed: 900,  price: 2900, drops: 2, tol: 0.3, wetTol: 0.5, cover: 0.8,  residue: 1, family: 'cereal' },
    maize:    { water: 500, temp: [18, 30], nNeed: 70, seed: 1400, price: 4200, drops: 3, tol: 0.2, wetTol: 0.5, cover: 1.0,  residue: 1, family: 'cereal' },
    sorghum:  { water: 340, temp: [21, 35], nNeed: 45, seed: 800,  price: 2400, drops: 1, tol: 0.7, wetTol: 0.5, cover: 1.0,  residue: 1, family: 'cereal', droughtTolerant: true },
    chickpea: { water: 340, temp: [15, 26], nNeed: 15, seed: 900,  price: 1900, drops: 1, tol: 0.5, wetTol: 0.2, cover: 1.15, residue: 0, family: 'legume', legume: true, fix: 30 },
  };
  const CROP_IDS = Object.keys(CROPS);

  const IRRIGATION = [
    { id: 'off', mm: 0, reserve: 0, cost: 0 },
    { id: 'low', mm: 70, reserve: 20, cost: 250 },
    { id: 'medium', mm: 140, reserve: 40, cost: 500 },
    { id: 'high', mm: 210, reserve: 60, cost: 750 },
  ];
  const METHODS = {
    sprinkler: { reserveMul: 1, extraCost: 0 },
    drip: { reserveMul: 0.65, extraCost: 350, loss: 0.05 },
  };
  const FERTILIZERS = {
    none:      { n: 0,  fast: 0,   om: 0,  cost: 0 },
    compost:   { n: 18, fast: 0.2, om: 6,  cost: 600 },
    synthetic: { n: 40, fast: 1,   om: -1, cost: 500 },
    green:     { n: 16, fast: 0.3, om: 4,  cost: 450 },
  };
  const PROTECTION = {
    none:  { runoff: 0,    erosion: 0,   recovery: 0, om: 0, demand: 1,    moisture: 0, cost: 0 },
    mulch: { runoff: 0.35, erosion: 0.4, recovery: 1, om: 2, demand: 0.92, moisture: 5, cost: 300 },
    cover: { runoff: 0.6,  erosion: 0.7, recovery: 3, om: 3, demand: 1.03, moisture: 0, cost: 400 },
  };

  /* ---------- Levels ---------- */
  // seasons: which historical seasons of the last 10 at the chosen location are replayed.
  // goals: all must be met to pass. stars: thresholds for the 3 scoring categories.
  // focus: extra weights the "best alternative" search uses for this level's objective.
  const LEVELS = [
    { id: 1, key: 'firstHarvest', seasons: ['typical'],
      start: { budget: 6000, reserve: 100, soil: { moisture: 50, n: 55, om: 55, erosion: 15 }, history: [] },
      goals: [{ metric: 'avgYield', op: '>=', value: 60 }],
      stars: { yield: 80, water: 70, soil: 0 }, focus: {} },
    { id: 2, key: 'waterShortage', seasons: ['driest'],
      start: { budget: 6000, reserve: 35, soil: { moisture: 35, n: 55, om: 50, erosion: 20 }, history: ['wheat'] },
      goals: [{ metric: 'avgYield', op: '>=', value: 50 }, { metric: 'reserveEnd', op: '>=', value: 5 }],
      stars: { yield: 70, water: 70, soil: 0 }, focus: { reserve: 1 } },
    { id: 3, key: 'depletedSoil', seasons: ['recent', 'recent'],
      start: { budget: 7000, reserve: 80, soil: { moisture: 50, n: 15, om: 30, erosion: 30 }, history: ['wheat', 'wheat'] },
      goals: [{ metric: 'fertilityDelta', op: '>=', value: 10 }, { metric: 'avgYield', op: '>=', value: 45 }],
      stars: { yield: 65, water: 70, soil: 15 }, focus: { fertility: 3 } },
    { id: 4, key: 'heatwave', seasons: ['hottest'],
      start: { budget: 6000, reserve: 70, soil: { moisture: 45, n: 50, om: 50, erosion: 20 }, history: ['chickpea'] },
      goals: [{ metric: 'avgYield', op: '>=', value: 60 }],
      stars: { yield: 75, water: 70, soil: 0 }, focus: {} },
    { id: 5, key: 'rainySeason', seasons: ['wettest'],
      start: { budget: 6000, reserve: 80, soil: { moisture: 65, n: 50, om: 45, erosion: 25 }, history: ['maize'] },
      goals: [{ metric: 'avgYield', op: '>=', value: 55 }, { metric: 'erosionDelta', op: '<=', value: 5 },
        { metric: 'nLeached', op: '<=', value: 10 }],
      stars: { yield: 75, water: 70, soil: 0 }, focus: { erosion: 3, leach: 1.5 } },
    { id: 6, key: 'economicCrisis', seasons: ['recent', 'recent'],
      start: { budget: 2200, reserve: 70, soil: { moisture: 50, n: 45, om: 45, erosion: 20 }, history: ['sorghum'] },
      goals: [{ metric: 'finalBudget', op: '>=', value: 3000 }],
      stars: { yield: 70, water: 70, soil: 0 }, focus: { profit: 3 } },
    { id: 7, key: 'climateChallenge', seasons: ['driest', 'hottest', 'wettest'],
      start: { budget: 5000, reserve: 60, soil: { moisture: 40, n: 40, om: 45, erosion: 25 }, history: ['wheat'] },
      goals: [{ metric: 'avgYield', op: '>=', value: 55 }, { metric: 'minYield', op: '>=', value: 30 },
        { metric: 'fertilityDelta', op: '>=', value: 0 }, { metric: 'finalBudget', op: '>=', value: 5000 }],
      stars: { yield: 70, water: 65, soil: 5 }, focus: { fertility: 2, profit: 2 } },
  ];

  /* ---------- Demo data ----------
     Illustrative "semi-arid steppe" seasons for playing without NASA POWER.
     Always shown with a Demo label; not a record of any real place or year. */
  const DEMO_ROWS = [
    // T °C, rain mm, RH %, wind m/s, solar, heavy-rain days, hot days, longest dry spell
    [21.8, 240, 55, 3.1, 22.0, 3, 30, 18],
    [22.5, 185, 50, 3.4, 22.8, 2, 38, 24],
    [23.1, 150, 45, 3.6, 23.5, 1, 45, 31],
    [21.2, 330, 66, 2.8, 20.1, 8, 22, 12],
    [24.9, 130, 38, 3.9, 24.6, 1, 70, 40],
    [22.0, 260, 57, 3.0, 21.8, 3, 33, 17],
    [23.6, 95, 36, 4.2, 24.9, 0, 58, 46],
    [20.9, 290, 62, 2.7, 20.6, 6, 18, 14],
    [22.8, 210, 52, 3.3, 22.5, 2, 40, 21],
    [23.4, 175, 48, 3.5, 23.2, 2, 48, 27],
  ];
  /** @returns {Climate} */
  function demoClimate() {
    const seasons = DEMO_ROWS.map((r, i) => ({
      year: i + 1, start: '', end: '', days: 123,
      temperature_c: r[0], rainfall_mm: r[1], humidity_percent: r[2], wind_speed_m_s: r[3],
      solar_radiation_mj_m2_day: r[4], heavy_rain_days: r[5], hot_days: r[6], longest_dry_spell_days: r[7],
    }));
    return { seasons, baseline: baselineOf(seasons), is_demo: true, source: 'demo', season_months: 'May–Aug' };
  }

  /* ---------- Helpers ---------- */
  const clamp = (v, lo = 0, hi = 100) => Math.max(lo, Math.min(hi, v));
  const round = (v, d = 0) => { const k = 10 ** d; return Math.round(v * k) / k; };
  const mean = (xs) => xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;

  /** @param {Season[]} seasons @returns {Baseline} */
  function baselineOf(seasons) {
    return {
      temperature_c: round(mean(seasons.map((s) => s.temperature_c)), 1),
      rainfall_mm: round(mean(seasons.map((s) => s.rainfall_mm)), 1),
      humidity_percent: round(mean(seasons.map((s) => s.humidity_percent)), 1),
      wind_speed_m_s: round(mean(seasons.map((s) => s.wind_speed_m_s)), 2),
      solar_radiation_mj_m2_day: round(mean(seasons.map((s) => s.solar_radiation_mj_m2_day)), 1),
      heavy_rain_days: round(mean(seasons.map((s) => s.heavy_rain_days)), 1),
    };
  }

  /** Overall soil fertility: nitrogen 40 %, organic matter 35 %, protection from erosion 25 %.
   * @param {Soil} soil */
  function fertility(soil) {
    return Math.round(0.4 * soil.n + 0.35 * soil.om + 0.25 * (100 - soil.erosion));
  }

  /** How much more (or less) water crops need than in reference weather (20 °C, 60 % RH, 2 m/s, 20 MJ).
   * @param {Season} s */
  function demandFactor(s) {
    const parts = {
      T2M: 0.025 * (s.temperature_c - 20),
      RH2M: 0.004 * (60 - s.humidity_percent),
      WS2M: 0.04 * (s.wind_speed_m_s - 2),
      ALLSKY_SFC_SW_DWN: 0.01 * (s.solar_radiation_mj_m2_day - 20),
    };
    const factor = clamp(1 + parts.T2M + parts.RH2M + parts.WS2M + parts.ALLSKY_SFC_SW_DWN, 0.7, 1.6);
    return { factor, parts };
  }

  /** Share of sprinkler water lost to evaporation and wind drift (hot, windy seasons lose more). @param {Season} s */
  function sprinklerLoss(s) {
    return clamp(0.08 + 0.012 * Math.max(0, s.temperature_c - 22) + 0.03 * Math.max(0, s.wind_speed_m_s - 3), 0.08, 0.3);
  }

  /** Weather events recorded in the season's data, compared with the 10-season normal.
   * @param {Season} s @param {Baseline} b @param {number} [reserve] @returns {ClimateEvent[]} */
  function seasonEvents(s, b, reserve) {
    /** @type {ClimateEvent[]} */
    const events = [];
    const rainShare = b.rainfall_mm > 0 ? s.rainfall_mm / b.rainfall_mm : 1;
    const rain30 = s.rainfall_mm * 30 / s.days;
    const drought = rainShare <= 0.7 || rain30 < 25;
    if (drought) {
      events.push({ type: 'drought', severity: rainShare <= 0.5 || rain30 < 15 ? 'high' : 'medium',
        param: 'PRECTOTCORR', value: s.rainfall_mm, normal: b.rainfall_mm });
    }
    const hot = s.temperature_c - b.temperature_c >= 1 || s.temperature_c >= 28;
    if (hot) {
      events.push({ type: 'heat', severity: s.temperature_c - b.temperature_c >= 2 || s.temperature_c >= 31 ? 'high' : 'medium',
        param: 'T2M', value: s.temperature_c, normal: b.temperature_c });
    }
    if (s.heavy_rain_days >= 5 || rainShare >= 1.35) {
      events.push({ type: 'downpour', severity: s.heavy_rain_days >= 8 || rainShare >= 1.6 ? 'high' : 'medium',
        param: 'PRECTOTCORR', value: s.heavy_rain_days, normal: b.heavy_rain_days });
    }
    if (reserve !== undefined && reserve < 40 && (drought || hot)) {
      events.push({ type: 'waterDeficit', severity: reserve < 20 ? 'high' : 'medium', param: 'reserve', value: reserve, normal: 40 });
    }
    return events;
  }

  /* ---------- Season selection ---------- */
  /** Rank the historical seasons for a selector. @param {Season[]} seasons @param {Baseline} b @param {string} selector */
  function rankSeasons(seasons, b, selector) {
    const list = seasons.slice();
    const sdT = Math.sqrt(mean(list.map((s) => (s.temperature_c - b.temperature_c) ** 2))) || 1;
    const sdR = Math.sqrt(mean(list.map((s) => (s.rainfall_mm - b.rainfall_mm) ** 2))) || 1;
    const typicality = (s) => Math.abs(s.temperature_c - b.temperature_c) / sdT + Math.abs(s.rainfall_mm - b.rainfall_mm) / sdR;
    const by = {
      typical: (x, y) => typicality(x) - typicality(y) || y.year - x.year,
      driest: (x, y) => x.rainfall_mm - y.rainfall_mm || y.temperature_c - x.temperature_c,
      hottest: (x, y) => y.temperature_c - x.temperature_c || x.rainfall_mm - y.rainfall_mm,
      wettest: (x, y) => y.rainfall_mm - x.rainfall_mm || y.heavy_rain_days - x.heavy_rain_days,
      recent: (x, y) => y.year - x.year,
    }[selector];
    if (!by) throw new Error(`unknown season selector "${selector}"`);
    return list.sort(by);
  }

  /** Pick distinct seasons for a level, in chronological order. @param {Climate} climate @param {object} level @returns {PickedSeason[]} */
  function pickSeasons(climate, level) {
    const used = new Set();
    /** @type {PickedSeason[]} */
    const picked = [];
    for (const selector of level.seasons) {
      const season = rankSeasons(climate.seasons, climate.baseline, selector).find((s) => !used.has(s.year));
      if (!season) break;
      used.add(season.year);
      picked.push({ season, pickedAs: selector });
    }
    return picked.sort((a, b) => a.season.year - b.season.year);
  }

  /* ---------- Level runs ---------- */
  function levelById(id) {
    const level = LEVELS.find((l) => l.id === id);
    if (!level) throw new Error(`unknown level ${id}`);
    return level;
  }

  /** Fresh, serialisable state for playing a level. @param {number} levelId @param {Climate} climate */
  function createRun(levelId, climate) {
    const level = levelById(levelId);
    const picked = pickSeasons(climate, level);
    return {
      levelId,
      seasonIndex: 0,
      seasons: picked.map((p) => p.season),
      pickedAs: picked.map((p) => p.pickedAs),
      baseline: climate.baseline,
      isDemo: !!climate.is_demo,
      budget: level.start.budget,
      reserve: level.start.reserve,
      soil: { ...level.start.soil },
      cropHistory: level.start.history.slice(),
      startBudget: level.start.budget,
      startReserve: level.start.reserve,
      startSoil: { ...level.start.soil },
      results: [],
      finished: false,
      failed: null,
    };
  }

  /** @param {Decision} d */
  function normalizeDecision(d) {
    return { crop: d.crop, irrigation: d.irrigation, method: d.method || 'sprinkler', fertilizer: d.fertilizer, protection: d.protection || 'none' };
  }

  /** @param {Decision} d */
  function planCost(d) {
    const n = normalizeDecision(d);
    const irr = IRRIGATION[n.irrigation ?? 0];
    const cost = (n.crop ? CROPS[n.crop].seed : 0) + irr.cost + (irr.mm > 0 ? METHODS[n.method].extraCost : 0)
      + (n.fertilizer ? FERTILIZERS[n.fertilizer].cost : 0) + PROTECTION[n.protection].cost;
    return cost;
  }

  /** Water reserve points a decision uses. @param {Decision} d */
  function reserveNeed(d) {
    const n = normalizeDecision(d);
    const irr = IRRIGATION[n.irrigation ?? 0];
    return irr.mm > 0 ? Math.round(irr.reserve * METHODS[n.method].reserveMul) : 0;
  }

  /** Everything the player must choose, plus budget and reserve limits. @param {object} run @param {Decision} d */
  function validateDecision(run, d) {
    const missing = [];
    if (!d.crop || !CROPS[d.crop]) missing.push('crop');
    if (d.irrigation === null || d.irrigation === undefined || !IRRIGATION[d.irrigation]) missing.push('irrigation');
    if (!d.fertilizer || !FERTILIZERS[d.fertilizer]) missing.push('fertilizer');
    const errors = [];
    if (d.method && !METHODS[d.method]) errors.push('method');
    if (d.protection && !PROTECTION[d.protection]) errors.push('protection');
    if (run.finished || run.failed) errors.push('finished');
    if (!missing.length && !errors.length) {
      if (planCost(d) > run.budget) errors.push('budget');
      if (reserveNeed(d) > run.reserve) errors.push('reserve');
    }
    return { ok: !missing.length && !errors.length, missing, errors };
  }

  /** Simulate the current season for a decision without changing the run.
   * @param {object} run @param {Decision} decision */
  function simulate(run, decision) {
    const d = normalizeDecision(decision);
    const s = run.seasons[run.seasonIndex];
    const soil = run.soil;
    const c = CROPS[d.crop], irr = IRRIGATION[d.irrigation], m = METHODS[d.method];
    const f = FERTILIZERS[d.fertilizer], p = PROTECTION[d.protection];
    const prev = run.cropHistory[run.cropHistory.length - 1];
    const prev2 = run.cropHistory[run.cropHistory.length - 2];
    /** @type {Reason[]} */
    const reasons = [];

    // 1. Water demand (T2M, RH2M, WS2M, ALLSKY_SFC_SW_DWN)
    const df = demandFactor(s);
    const demand = c.water * df.factor * (s.days / MODEL.REF_DAYS) * p.demand;

    // 2. Water supply (PRECTOTCORR + stored soil water + irrigation)
    const storage = soil.moisture / 100 * MODEL.STORAGE_MM;
    const runoff = Math.min(s.heavy_rain_days * MODEL.RUNOFF_PER_HEAVY_DAY * (1 - p.runoff), MODEL.RUNOFF_CAP * s.rainfall_mm);
    const effectiveRain = s.rainfall_mm - runoff;
    const supplyNoIrr = effectiveRain + storage;
    const loss = irr.mm > 0 ? (d.method === 'drip' ? METHODS.drip.loss : sprinklerLoss(s)) : 0;
    const irrigationMm = irr.mm * (1 - loss);
    const supply = supplyNoIrr + irrigationMm;
    const ratio = supply / demand;
    const reserveUsed = reserveNeed(d);
    const usefulMm = clamp(demand * 1.05 - supplyNoIrr, 0, irrigationMm);

    const [okLo, okHi] = MODEL.WATER_OK;
    const deficitK = MODEL.DROUGHT_TOLERANCE_K[0] - MODEL.DROUGHT_TOLERANCE_K[1] * c.tol;
    const excessK = 60 + 120 * (1 - c.wetTol);
    const waterScore = ratio < okLo ? clamp(100 - (okLo - ratio) * deficitK)
      : ratio > okHi ? clamp(100 - (ratio - okHi) * excessK) : 100;

    // 3. Nitrogen
    const leachFrac = clamp(0.04 * s.heavy_rain_days + Math.max(0, ratio - 1.2) * 0.5, 0, 0.6);
    const leached = f.n * f.fast * leachFrac + soil.n * leachFrac * 0.2;
    const availableN = Math.max(0, MODEL.SOIL_N_AVAILABLE * soil.n + f.n - leached);
    const nutrientScore = clamp(availableN / c.nNeed * 100);

    // 4. Temperature (T2M) and light (ALLSKY_SFC_SW_DWN)
    const heat = Math.max(0, s.temperature_c - c.temp[1]);
    const cold = Math.max(0, c.temp[0] - s.temperature_c);
    const tempScore = clamp(100 - MODEL.HEAT_PENALTY * heat - MODEL.COLD_PENALTY * cold);
    const solarScore = s.solar_radiation_mj_m2_day < MODEL.LOW_SOLAR
      ? clamp(100 - 5 * (MODEL.LOW_SOLAR - s.solar_radiation_mj_m2_day)) : 100;

    // 5. Rotation and disease (crop history, RH2M, T2M)
    const sameCrop = prev === d.crop;
    const sameFamily = !!prev && !sameCrop && CROPS[prev].family === c.family;
    const legumeBefore = !!prev && !!CROPS[prev].legume && !c.legume;
    const rotationBonus = !prev || sameCrop ? 0 : legumeBefore ? 6 : 2;
    const humidWarm = s.humidity_percent > 70 && s.temperature_c > 18;
    // Legumes share root diseases (e.g. Ascochyta blight in chickpea), so legume after legume adds risk.
    const diseaseRisk = 8 + (sameCrop ? 25 : 0) + (sameCrop && prev2 === d.crop ? 10 : 0) + (sameFamily ? 8 : 0)
      + (sameCrop && c.legume ? 10 : 0) + (c.legume && s.humidity_percent > 65 ? 12 : 0)
      + (humidWarm ? 15 : 0) + (ratio > okHi ? 10 : 0);
    const diseaseLoss = Math.max(0, diseaseRisk - 20) * 0.5;

    // 6. Soil fertility before planting
    const fertilityBefore = fertility(soil);
    const fertilityMod = (fertilityBefore - 50) / 5;

    // 7. Yield (crop health, % of potential)
    const w = MODEL.YIELD_WEIGHTS;
    const base = w.water * waterScore + w.nutrients * nutrientScore + w.temperature * tempScore + w.solar * solarScore;
    const yieldPct = Math.round(clamp(base + rotationBonus - diseaseLoss + fertilityMod));

    // 8. Soil after the season
    const uptake = Math.min(availableN, c.nNeed * yieldPct / 100);
    const fixed = c.legume ? c.fix * yieldPct / 100 : 0;
    const moistureTarget = clamp(55 * ratio, 5, 95) + p.moisture;
    const windErosion = Math.max(0, s.wind_speed_m_s - 3) * 6 * (1 - p.erosion) * (moistureTarget < 35 ? 1 : 0.3);
    const erosionEvent = s.heavy_rain_days * 2.2 * c.cover * (1 - p.erosion) + windErosion;
    const soilAfter = {
      moisture: Math.round(clamp(0.3 * soil.moisture + 0.7 * moistureTarget)),
      n: Math.round(clamp(soil.n + f.n - leached - uptake + fixed + soil.om / 20 - (sameCrop ? 3 : 0))),
      om: Math.round(clamp(soil.om + f.om + p.om + c.residue - 2 - (s.temperature_c > 25 ? 1 : 0) - erosionEvent / 4)),
      erosion: Math.round(clamp(soil.erosion + erosionEvent - p.recovery - (d.fertilizer === 'green' ? 1 : 0))),
    };

    // 9. Money and water reserve
    const cost = planCost(d);
    const revenue = Math.round(c.price * yieldPct / 100 / 10) * 10;
    const refill = Math.round(Math.min(MODEL.REFILL_MAX, s.rainfall_mm / MODEL.REFILL_DIVISOR));
    const reserveAfter = Math.round(clamp(run.reserve - reserveUsed + refill));

    // Field state shown on the farm (the most limiting factor)
    let state = 'healthy';
    if (waterScore < 70 && ratio < 1) state = 'drought';
    else if (waterScore < 70) state = 'overwater';
    else if (tempScore < 70) state = 'heatstress';
    else if (nutrientScore < 70) state = 'lownutrients';
    else if (diseaseLoss >= 5) state = 'disease';

    // Reasons, each tied to the NASA POWER parameter or decision that caused it
    const drivers = Object.entries(df.parts).filter(([, v]) => v > 0.02).sort((a, b) => b[1] - a[1]).map(([k]) => k);
    reasons.push({ code: 'demand', impact: 0, param: drivers[0] || 'T2M',
      vars: { demand: Math.round(demand), pct: Math.round((df.factor - 1) * 100), drivers: drivers.join(', ') || '—' } });
    const waterImpact = -(100 - waterScore) * w.water;
    if (ratio < okLo) reasons.push({ code: 'water.short', impact: waterImpact, param: 'PRECTOTCORR',
      vars: { pct: Math.round(ratio * 100), rain: Math.round(s.rainfall_mm), supply: Math.round(supply), demand: Math.round(demand) } });
    else if (ratio > okHi) reasons.push({ code: 'water.excess', impact: waterImpact, param: 'PRECTOTCORR',
      vars: { pct: Math.round(ratio * 100), rain: Math.round(s.rainfall_mm) } });
    else reasons.push({ code: 'water.ok', impact: 0, param: 'PRECTOTCORR', vars: { pct: Math.round(ratio * 100), rain: Math.round(s.rainfall_mm) } });
    if (irr.mm > 0 && usefulMm < irrigationMm * 0.5) {
      reasons.push({ code: 'irrigation.wasted', impact: 0, vars: { mm: Math.round(irrigationMm - usefulMm), total: Math.round(irrigationMm) } });
    } else if (usefulMm > 0) {
      reasons.push({ code: 'irrigation.helped', impact: 0, vars: { mm: Math.round(usefulMm) } });
    }
    if (irr.mm > 0 && d.method === 'sprinkler' && loss >= 0.14) {
      reasons.push({ code: 'irrigation.evaporation', impact: 0, param: 'T2M', vars: { pct: Math.round(loss * 100) } });
    }
    if (runoff >= 15) reasons.push({ code: 'runoff', impact: 0, param: 'PRECTOTCORR', vars: { mm: Math.round(runoff), days: s.heavy_rain_days } });
    if (heat > 0) reasons.push({ code: 'temp.heat', impact: -(100 - tempScore) * w.temperature, param: 'T2M',
      vars: { temp: s.temperature_c, max: c.temp[1] } });
    else if (cold > 0) reasons.push({ code: 'temp.cold', impact: -(100 - tempScore) * w.temperature, param: 'T2M',
      vars: { temp: s.temperature_c, min: c.temp[0] } });
    else reasons.push({ code: 'temp.ok', impact: 0, param: 'T2M', vars: { temp: s.temperature_c, min: c.temp[0], max: c.temp[1] } });
    if (solarScore < 100) reasons.push({ code: 'solar.low', impact: -(100 - solarScore) * w.solar, param: 'ALLSKY_SFC_SW_DWN',
      vars: { value: s.solar_radiation_mj_m2_day } });
    if (Math.round(nutrientScore) < 100) reasons.push({ code: 'nitrogen.short', impact: -(100 - nutrientScore) * w.nutrients,
      vars: { pct: Math.round(nutrientScore) } });
    if (leached >= 3) reasons.push({ code: 'nitrogen.leached', impact: 0, param: 'PRECTOTCORR', vars: { kg: Math.round(leached) } });
    if (legumeBefore) reasons.push({ code: 'rotation.legume', impact: rotationBonus, vars: { prev } });
    else if (rotationBonus > 0) reasons.push({ code: 'rotation.ok', impact: rotationBonus, vars: { prev } });
    if (sameCrop) reasons.push({ code: 'rotation.monoculture', impact: -diseaseLoss, vars: { prev } });
    if (humidWarm && diseaseLoss > 0) reasons.push({ code: 'disease.humid', impact: sameCrop ? 0 : -diseaseLoss, param: 'RH2M',
      vars: { rh: Math.round(s.humidity_percent) } });
    if (Math.abs(fertilityMod) >= 2) reasons.push({ code: fertilityMod > 0 ? 'soil.fertile' : 'soil.poor', impact: fertilityMod,
      vars: { value: fertilityBefore } });
    if (erosionEvent >= 3) reasons.push({ code: 'erosion', impact: 0, param: s.heavy_rain_days ? 'PRECTOTCORR' : 'WS2M',
      vars: { value: Math.round(erosionEvent), days: s.heavy_rain_days } });
    if (d.protection !== 'none') reasons.push({ code: `protection.${d.protection}`, impact: 0 });
    if (c.legume) reasons.push({ code: 'legume.fix', impact: 0, vars: { n: Math.round(fixed) } });

    // Dominant limiting factor → science note
    const limits = [
      ['drought', ratio < okLo ? 100 - waterScore : 0], ['excess', ratio > okHi ? 100 - waterScore : 0],
      ['heat', heat > 0 ? (100 - tempScore) * 0.44 : 0], ['cold', cold > 0 ? (100 - tempScore) * 0.44 : 0],
      ['nitrogen', (100 - nutrientScore) * 0.56], ['disease', diseaseLoss * 2.2], ['erosion', erosionEvent >= 8 ? erosionEvent : 0],
    ].sort((a, b) => Number(b[1]) - Number(a[1]));
    const science = Number(limits[0][1]) >= 8 ? limits[0][0] : 'healthy';

    return {
      decision: d,
      season: s,
      state,
      yield: yieldPct,
      science,
      // demand first, then the biggest yield losses, then neutral and positive factors (stable sort)
      reasons: reasons.sort((a, b) => (a.code === 'demand' ? -1 : b.code === 'demand' ? 1 : a.impact - b.impact)),
      scores: { water: Math.round(waterScore), nutrients: Math.round(nutrientScore), temperature: Math.round(tempScore),
        solar: Math.round(solarScore), disease: Math.round(diseaseLoss), rotation: rotationBonus, fertilityMod: round(fertilityMod, 1) },
      water: { demand: Math.round(demand), factor: round(df.factor, 2), storage: Math.round(storage), runoff: Math.round(runoff),
        effectiveRain: Math.round(effectiveRain), irrigationMm: Math.round(irrigationMm), usefulMm: Math.round(usefulMm),
        wastedMm: Math.round(irrigationMm - usefulMm), supply: Math.round(supply), ratio: round(ratio, 2),
        reserveUsed, refill, reserveBefore: run.reserve, reserveAfter, loss: round(loss, 2) },
      nitrogen: { available: round(availableN, 1), leached: round(leached, 1), uptake: round(uptake, 1), fixed: round(fixed, 1) },
      disease: { risk: diseaseRisk },
      soilBefore: { ...soil },
      soilAfter,
      fertilityBefore,
      fertilityAfter: fertility(soilAfter),
      erosionEvent: round(erosionEvent, 1),
      economics: { cost, revenue, profit: revenue - cost, budgetBefore: run.budget, budgetAfter: run.budget - cost + revenue },
    };
  }

  /** Water-saving score for one season (0–100): 70 % "was the irrigation needed?", 30 % "reserve kept". */
  function seasonWaterScore(outcome) {
    const w = outcome.water;
    const useful = w.irrigationMm > 0 ? w.usefulMm / w.irrigationMm : 1;
    const kept = w.reserveBefore > 0 ? 1 - Math.min(1, w.reserveUsed / w.reserveBefore) : 1;
    return Math.round(70 * useful + 30 * kept);
  }

  /** Play the current season. Returns a new run (the old one is not modified) and the outcome. */
  function playSeason(run, decision) {
    const check = validateDecision(run, decision);
    if (!check.ok) throw new Error(`invalid decision: ${[...check.missing, ...check.errors].join(', ')}`);
    const outcome = simulate(run, decision);
    const next = {
      ...run,
      seasonIndex: run.seasonIndex + 1,
      budget: outcome.economics.budgetAfter,
      reserve: outcome.water.reserveAfter,
      soil: outcome.soilAfter,
      cropHistory: [...run.cropHistory, outcome.decision.crop],
      results: [...run.results, outcome],
    };
    next.finished = next.seasonIndex >= next.seasons.length;
    next.failed = !next.finished && next.budget < MODEL.MIN_SEED_COST ? 'bankrupt' : null;
    return { run: next, outcome };
  }

  /* ---------- Alternatives and What If ---------- */
  function allDecisions() {
    const out = [];
    for (const crop of CROP_IDS) {
      for (let irrigation = 0; irrigation < IRRIGATION.length; irrigation++) {
        for (const method of irrigation === 0 ? ['sprinkler'] : Object.keys(METHODS)) {
          for (const fertilizer of Object.keys(FERTILIZERS)) {
            for (const protection of Object.keys(PROTECTION)) out.push({ crop, irrigation, method, fertilizer, protection });
          }
        }
      }
    }
    return out;
  }

  /** How good an outcome is for a level's goals (used to find the best alternative). */
  function objective(level, outcome) {
    const f = { fertility: 0.5, erosion: 0.5, leach: 0.3, profit: 0.6, reserve: 0.2, ...level.focus };
    return outcome.yield
      + 0.25 * seasonWaterScore(outcome)
      + f.fertility * (outcome.fertilityAfter - outcome.fertilityBefore)
      - f.erosion * outcome.erosionEvent
      - f.leach * outcome.nitrogen.leached
      + f.profit * outcome.economics.profit / 100
      - f.reserve * outcome.water.reserveUsed;
  }

  /** Rank a (possibly unfinished) run by the level's own rules: goals met, then stars, then score. */
  function planValue(run, objectiveSum) {
    const ev = evaluateLevel({ ...run, finished: true });
    return ev.goals.filter((g) => g.met).length * 1000 + (ev.passed ? 500 : 0) + ev.stars * 50 + ev.score
      + ev.metrics.profit / 50 + objectiveSum / 100;
  }

  /** Best plan for the remaining seasons: a beam search (width `width`) over all affordable decisions.
   * Deterministic: stable sorting keeps the earlier option on ties. Returns null when nothing is affordable. */
  function bestPlan(run, width = 12) {
    const level = levelById(run.levelId);
    let beam = [{ run, path: [], outcomes: [], objectiveSum: 0, value: 0 }];
    while (beam.some((b) => !b.run.finished && !b.run.failed)) {
      const next = [];
      for (const b of beam) {
        if (b.run.finished || b.run.failed) { next.push(b); continue; }
        for (const d of allDecisions()) {
          if (!validateDecision(b.run, d).ok) continue;
          const played = playSeason(b.run, d);
          const objectiveSum = b.objectiveSum + objective(level, played.outcome);
          next.push({ run: played.run, path: [...b.path, d], outcomes: [...b.outcomes, played.outcome], objectiveSum,
            value: planValue(played.run, objectiveSum) });
        }
      }
      if (!next.length) return null;
      next.sort((a, b) => b.value - a.value);
      beam = next.slice(0, width);
    }
    return beam[0].path.length ? beam[0] : null;
  }

  /** Best decision for the current season, chosen with the remaining seasons in mind. */
  function bestDecision(run) {
    const plan = bestPlan(run);
    if (!plan) return null;
    return { decision: plan.path[0], outcome: plan.outcomes[0], plan: plan.path, evaluation: evaluateLevel(plan.run) };
  }

  /** Compare the player's decision with an alternative for the same season. Progress is not changed. */
  function compare(run, playerDecision, altDecision) {
    const level = levelById(run.levelId);
    const a = simulate(run, playerDecision), b = simulate(run, altDecision);
    return {
      player: { outcome: a, water: seasonWaterScore(a), objective: objective(level, a) },
      alternative: { outcome: b, water: seasonWaterScore(b), objective: objective(level, b), affordable: validateDecision(run, altDecision).ok },
    };
  }

  /* ---------- Level evaluation ---------- */
  function metricsOf(run) {
    const r = run.results;
    const irrigated = r.reduce((a, o) => a + o.water.irrigationMm, 0);
    const useful = r.reduce((a, o) => a + o.water.usefulMm, 0);
    const reserveUsed = r.reduce((a, o) => a + o.water.reserveUsed, 0);
    return {
      avgYield: Math.round(mean(r.map((o) => o.yield))),
      minYield: r.length ? Math.min(...r.map((o) => o.yield)) : 0,
      reserveEnd: run.reserve,
      fertilityStart: fertility(run.startSoil),
      fertilityEnd: fertility(run.soil),
      fertilityDelta: fertility(run.soil) - fertility(run.startSoil),
      erosionDelta: run.soil.erosion - run.startSoil.erosion,
      nDelta: run.soil.n - run.startSoil.n,
      omDelta: run.soil.om - run.startSoil.om,
      moistureDelta: run.soil.moisture - run.startSoil.moisture,
      nLeached: Math.round(r.reduce((a, o) => a + o.nitrogen.leached, 0)),
      finalBudget: run.budget,
      profit: run.budget - run.startBudget,
      revenue: r.reduce((a, o) => a + o.economics.revenue, 0),
      irrigationMm: Math.round(irrigated),
      wastedMm: Math.round(irrigated - useful),
      reserveUsed,
      usefulShare: irrigated > 0 ? useful / irrigated : 1,
    };
  }

  function recommendationsFor(run, m) {
    const recs = [];
    const r = run.results;
    if (r.some((o) => o.state === 'drought' && !CROPS[o.decision.crop].droughtTolerant)) recs.push('droughtCrop');
    if (m.irrigationMm > 0 && m.wastedMm / m.irrigationMm > 0.3) recs.push('checkRain');
    if (m.nLeached > 10) recs.push('slowFertilizer');
    if (m.erosionDelta > 3) recs.push('protectSoil');
    if (r.some((o) => o.reasons.some((x) => x.code === 'rotation.monoculture'))) recs.push('rotate');
    if (r.some((o) => o.scores.nutrients < 70)) recs.push('addNitrogen');
    if (r.some((o) => o.scores.temperature < 70)) recs.push('heatCrop');
    if (m.profit < 0) recs.push('costs');
    if (m.reserveUsed > 0 && r.some((o) => o.decision.method === 'sprinkler' && o.water.loss >= 0.14)) recs.push('drip');
    if (m.fertilityDelta < 0) recs.push('buildSoil');
    return [...recs.slice(0, 4), 'gridNote'];
  }

  /** Goals, stars and totals for a finished (or failed) level run. */
  function evaluateLevel(run) {
    const level = levelById(run.levelId);
    const m = metricsOf(run);
    const goals = level.goals.map((g) => {
      const value = m[g.metric];
      return { ...g, actual: value, met: run.finished && (g.op === '>=' ? value >= g.value : value <= g.value) };
    });
    const passed = run.finished && !run.failed && goals.every((g) => g.met);
    const categories = {
      yield: { score: m.avgYield, target: level.stars.yield, earned: m.avgYield >= level.stars.yield },
      water: { score: Math.round(70 * m.usefulShare + 30 * (run.startReserve > 0 ? 1 - Math.min(1, m.reserveUsed / run.startReserve) : 1)),
        target: 70, earned: false },
      soil: { score: m.fertilityEnd, delta: m.fertilityDelta, target: level.stars.soil, earned: m.fertilityDelta >= level.stars.soil },
    };
    categories.water.earned = categories.water.score >= level.stars.water;
    const earned = ['yield', 'water', 'soil'].filter((k) => categories[k].earned).length;
    const stars = passed ? Math.max(1, earned) : 0;
    const score = Math.round(0.4 * categories.yield.score + 0.3 * categories.water.score + 0.3 * categories.soil.score);
    return { levelId: run.levelId, passed, failReason: run.failed || (passed ? null : 'goals'), goals, stars, score, categories, metrics: m,
      recommendations: recommendationsFor(run, m) };
  }

  /* ---------- Progress (stored by the UI in localStorage) ---------- */
  const PROGRESS_VERSION = 1;
  function emptyProgress() { return { version: PROGRESS_VERSION, best: {} }; }

  /** Accept only well-formed saved progress; anything else starts fresh. */
  function sanitizeProgress(raw) {
    const out = emptyProgress();
    if (!raw || typeof raw !== 'object' || raw.version !== PROGRESS_VERSION || typeof raw.best !== 'object' || !raw.best) return out;
    for (const level of LEVELS) {
      const b = raw.best[level.id];
      if (b && typeof b === 'object' && typeof b.stars === 'number' && b.stars >= 0 && b.stars <= 3 && typeof b.passed === 'boolean') {
        out.best[level.id] = { ...b };
      }
    }
    return out;
  }

  function isUnlocked(progress, levelId) {
    if (levelId === 1) return true;
    const prev = progress.best[levelId - 1];
    return !!(prev && prev.passed);
  }

  /** Keep the best attempt per level: passed beats failed, then more stars, then higher score. */
  function recordResult(progress, evaluation, meta = {}) {
    const old = progress.best[evaluation.levelId];
    const entry = {
      passed: evaluation.passed, stars: evaluation.stars, score: evaluation.score,
      yield: evaluation.categories.yield.score, water: evaluation.categories.water.score, soil: evaluation.categories.soil.score,
      fertilityDelta: evaluation.metrics.fertilityDelta, profit: evaluation.metrics.profit,
      irrigationMm: evaluation.metrics.irrigationMm, ...meta,
    };
    const better = !old || (entry.passed && !old.passed)
      || (entry.passed === old.passed && (entry.stars > old.stars || (entry.stars === old.stars && entry.score > old.score)));
    return { version: PROGRESS_VERSION, best: { ...progress.best, ...(better ? { [evaluation.levelId]: entry } : {}) } };
  }

  /** Whole-farm summary across all levels. */
  function farmReport(progress) {
    const rows = LEVELS.map((l) => ({ id: l.id, key: l.key, best: progress.best[l.id] || null }));
    const played = rows.filter((r) => r.best);
    const avg = (k) => Math.round(mean(played.map((r) => r.best[k])));
    const categories = { yield: avg('yield'), water: avg('water'), soil: avg('soil') };
    const weakest = played.length ? Object.entries(categories).sort((a, b) => a[1] - b[1])[0][0] : null;
    return {
      rows,
      completed: rows.filter((r) => r.best && r.best.passed).length,
      totalStars: rows.reduce((a, r) => a + (r.best ? r.best.stars : 0), 0),
      maxStars: LEVELS.length * 3,
      categories,
      weakest,
      totalProfit: played.reduce((a, r) => a + (r.best.profit || 0), 0),
      totalIrrigationMm: played.reduce((a, r) => a + (r.best.irrigationMm || 0), 0),
      allPassed: rows.every((r) => r.best && r.best.passed),
    };
  }

  return {
    MODEL, CROPS, CROP_IDS, IRRIGATION, METHODS, FERTILIZERS, PROTECTION, LEVELS,
    demoClimate, baselineOf, fertility, demandFactor, sprinklerLoss, seasonEvents, rankSeasons, pickSeasons,
    levelById, createRun, normalizeDecision, planCost, reserveNeed, validateDecision, simulate, seasonWaterScore, playSeason,
    allDecisions, objective, bestPlan, bestDecision, compare, evaluateLevel,
    emptyProgress, sanitizeProgress, isUnlocked, recordResult, farmReport,
  };
});
