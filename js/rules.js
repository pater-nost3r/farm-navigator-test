/* =========================================================
   Farm Navigator rules for the interface
   The game itself is simulated on the server (app/services/engine.py).
   This file only mirrors the parts the interface needs BEFORE a season
   is played: which decisions are missing, what the plan may cost and
   whether it fits the budget and the water reserve. It reads the same
   configuration the server uses (GET /api/game/config), and the server
   checks everything again.
   It also keeps the player's best result per level (localStorage).
   ========================================================= */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.FarmRules = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const DECISION_FIELDS = ['crop', 'method', 'intensity', 'care'];

  /** A config section without its documentation keys ("_about"). */
  function options(section) {
    const out = {};
    Object.keys(section || {}).forEach((k) => { if (k.charAt(0) !== '_') out[k] = section[k]; });
    return out;
  }

  function levelById(model, id) {
    const level = model.levels.find((l) => l.id === id);
    if (!level) throw new Error(`unknown level ${id}`);
    return level;
  }

  const clamp = (v, lo = 0, hi = 100) => Math.max(lo, Math.min(hi, v));

  /** Same formula as engine.fertility on the server. */
  function fertility(model, soil) {
    const sm = model.soil_model, w = sm.fertility_weights;
    const [lo, hi] = sm.fertility_om_range;
    const n = clamp(soil.n / sm.fertility_n_full * 100);
    const om = clamp((soil.om - lo) / (hi - lo) * 100);
    return Math.round(w.n * n + w.om * om + w.erosion * (100 - soil.erosion));
  }

  /** Costs known before the season; water is reserved at its maximum so the budget can never go negative. */
  function planCost(model, run, d) {
    const mult = levelById(model, run.level_id).economy.cost;
    const crop = model.crops[d.crop] || {};
    const care = model.soil_care[d.care] || {};
    const method = model.irrigation_methods[d.method];
    const intensity = model.irrigation_intensity[d.intensity];
    const irrigating = !!(method && intensity && intensity.cap_mm > 0);
    const maxWater = irrigating ? Math.min(intensity.cap_mm, run.reserve_mm) : 0;
    const parts = {
      seeds: (crop.seed_cost || 0) * mult,
      fixed: model.farm.fixed_costs * mult,
      care: (care.cost || 0) * mult,
      irrigation_setup: irrigating ? method.setup_cost * mult : 0,
      water_max: irrigating ? maxWater * method.cost_per_mm * mult : 0,
    };
    const out = {};
    Object.keys(parts).forEach((k) => { out[k] = Math.round(parts[k]); });
    out.total_max = Object.keys(out).reduce((a, k) => a + out[k], 0);
    out.water_max_mm = Math.round(maxWater);
    return out;
  }

  /** Mirror of engine.validate_decision: every decision required, known values, budget and reserve. */
  function validateDecision(model, run, d) {
    const tables = { crop: options(model.crops), method: options(model.irrigation_methods),
      intensity: options(model.irrigation_intensity), care: options(model.soil_care) };
    const missing = DECISION_FIELDS.filter((f) => d[f] === null || d[f] === undefined || d[f] === '');
    const errors = DECISION_FIELDS.filter((f) => !missing.includes(f) && !tables[f][d[f]]).map((f) => `unknown_${f}`);
    if (run.finished || run.failed) errors.push('level_over');
    if (!missing.length && !errors.length) {
      if (planCost(model, run, d).total_max > run.budget) errors.push('budget');
      if (d.intensity !== 'off' && run.reserve_mm <= 0) errors.push('reserve_empty');
    }
    return { ok: !missing.length && !errors.length, missing, errors };
  }

  /* ---------- Progress (localStorage) ---------- */
  const PROGRESS_VERSION = 2;
  function emptyProgress() { return { version: PROGRESS_VERSION, best: {} }; }

  /** Accept only well-formed saved progress; anything else starts fresh. */
  function sanitizeProgress(raw, levelIds) {
    const out = emptyProgress();
    if (!raw || typeof raw !== 'object' || raw.version !== PROGRESS_VERSION || !raw.best || typeof raw.best !== 'object') return out;
    (levelIds || [1, 2, 3, 4, 5, 6, 7]).forEach((id) => {
      const b = raw.best[id];
      if (b && typeof b === 'object' && typeof b.stars === 'number' && b.stars >= 0 && b.stars <= 3
        && typeof b.passed === 'boolean' && typeof b.score === 'number') out.best[id] = { ...b };
    });
    return out;
  }

  function isUnlocked(progress, levelId) {
    if (levelId === 1) return true;
    const prev = progress.best[levelId - 1];
    return !!(prev && prev.passed);
  }

  /** Keep the best attempt per level: passed beats failed, then more stars, then a higher score. */
  function recordResult(progress, evaluation, meta) {
    const old = progress.best[evaluation.level_id];
    const m = evaluation.metrics, c = evaluation.categories;
    const entry = { passed: evaluation.passed, stars: evaluation.stars, score: evaluation.score,
      yield: c.yield.score, water: c.water.score, soil: c.soil.score, fertilityDelta: m.fertility_delta,
      profit: m.profit, pumpedMm: m.pumped_mm, ...(meta || {}) };
    const better = !old || (entry.passed && !old.passed)
      || (entry.passed === old.passed && (entry.stars > old.stars || (entry.stars === old.stars && entry.score > old.score)));
    const best = { ...progress.best };
    if (better) best[evaluation.level_id] = entry;
    return { version: PROGRESS_VERSION, best };
  }

  function farmReport(progress, levels) {
    const rows = levels.map((l) => ({ id: l.id, key: l.key, best: progress.best[l.id] || null }));
    const played = rows.filter((r) => r.best);
    const avg = (k) => (played.length ? Math.round(played.reduce((a, r) => a + r.best[k], 0) / played.length) : 0);
    const categories = { yield: avg('yield'), water: avg('water'), soil: avg('soil') };
    const weakest = played.length ? Object.keys(categories).sort((a, b) => categories[a] - categories[b])[0] : null;
    return {
      rows, categories, weakest,
      completed: rows.filter((r) => r.best && r.best.passed).length,
      totalStars: rows.reduce((a, r) => a + (r.best ? r.best.stars : 0), 0),
      maxStars: levels.length * 3,
      totalProfit: played.reduce((a, r) => a + (r.best.profit || 0), 0),
      totalPumpedMm: played.reduce((a, r) => a + (r.best.pumpedMm || 0), 0),
      allPassed: rows.every((r) => r.best && r.best.passed),
    };
  }

  return { DECISION_FIELDS, options, levelById, fertility, planCost, validateDecision,
    PROGRESS_VERSION, emptyProgress, sanitizeProgress, isUnlocked, recordResult, farmReport };
});
