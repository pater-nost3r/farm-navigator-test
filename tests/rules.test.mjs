import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const R = require('../js/rules.js');
// The browser receives exactly this file from GET /api/game/config.
const MODEL = JSON.parse(readFileSync(new URL('../app/data/game_model.json', import.meta.url), 'utf8'));
const run = (extra = {}) => ({ level_id: 1, budget: 8000, reserve_mm: 350, finished: false, failed: null, soil: {}, ...extra });
const PLAN = { crop: 'maize', method: 'drip', intensity: 'medium', care: 'mulch' };

test('every decision is required and must be a known option', () => {
  assert.deepEqual(R.validateDecision(MODEL, run(), { crop: 'maize' }).missing, ['method', 'intensity', 'care']);
  assert.deepEqual(R.validateDecision(MODEL, run(), { ...PLAN, crop: 'rice' }).errors, ['unknown_crop']);
  assert.ok(R.validateDecision(MODEL, run(), PLAN).ok);
});

test('plan cost reserves the maximum water bill (same formula as the server)', () => {
  const c = R.planCost(MODEL, run(), PLAN);
  const drip = MODEL.irrigation_methods.drip;
  assert.equal(c.seeds, MODEL.crops.maize.seed_cost);
  assert.equal(c.irrigation_setup, drip.setup_cost);
  assert.equal(c.water_max_mm, MODEL.irrigation_intensity.medium.cap_mm);
  assert.equal(c.water_max, MODEL.irrigation_intensity.medium.cap_mm * drip.cost_per_mm);
  assert.equal(c.total_max, c.seeds + c.fixed + c.care + c.irrigation_setup + c.water_max);
  // A small reserve lowers the maximum water bill; no irrigation costs nothing.
  assert.equal(R.planCost(MODEL, run({ reserve_mm: 40 }), PLAN).water_max_mm, 40);
  const dry = R.planCost(MODEL, run(), { ...PLAN, intensity: 'off' });
  assert.equal(dry.irrigation_setup + dry.water_max, 0);
  // Level 6 costs are 15% higher.
  assert.equal(R.planCost(MODEL, run({ level_id: 6 }), PLAN).seeds, Math.round(MODEL.crops.maize.seed_cost * 1.15));
});

test('budget and water reserve limits are enforced before sending', () => {
  assert.deepEqual(R.validateDecision(MODEL, run({ budget: 3000 }), PLAN).errors, ['budget']);
  assert.deepEqual(R.validateDecision(MODEL, run({ reserve_mm: 0 }), PLAN).errors, ['reserve_empty']);
  assert.ok(R.validateDecision(MODEL, run({ reserve_mm: 0 }), { ...PLAN, intensity: 'off' }).ok);
  assert.deepEqual(R.validateDecision(MODEL, run({ finished: true }), PLAN).errors, ['level_over']);
});

test('fertility matches the server formula', () => {
  assert.equal(R.fertility(MODEL, { n: 70, om: 2.2, erosion: 15 }), 64); // engine.fertility gives the same
  assert.equal(R.fertility(MODEL, { n: 20, om: 1.2, erosion: 35 }), 32);
});

test('progress keeps the best attempt and unlocks the next level', () => {
  const ev = (stars, score, passed) => ({ level_id: 1, passed, stars, score, metrics: { fertility_delta: 0, profit: 100, pumped_mm: 50 },
    categories: { yield: { score: 70 }, water: { score: 80 }, soil: { score: 60 } } });
  let p = R.emptyProgress();
  assert.ok(R.isUnlocked(p, 1) && !R.isUnlocked(p, 2));
  p = R.recordResult(p, ev(0, 40, false));
  assert.ok(!R.isUnlocked(p, 2));
  p = R.recordResult(p, ev(2, 60, true));
  p = R.recordResult(p, ev(1, 90, true));
  assert.equal(p.best[1].stars, 2);
  assert.ok(R.isUnlocked(p, 2));
  assert.deepEqual(R.sanitizeProgress({ version: 1, best: {} }), R.emptyProgress());
  assert.deepEqual(R.sanitizeProgress(JSON.parse(JSON.stringify(p))), p);
  const rep = R.farmReport(p, MODEL.levels);
  assert.equal(rep.completed, 1);
  assert.equal(rep.totalStars, 2);
  assert.equal(rep.maxStars, 21);
});
