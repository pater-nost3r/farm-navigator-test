import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const E = require('../js/engine.js');
// Real NASA POWER growing-season aggregates (10 seasons each), saved from /api/nasa/climate.
const FIXTURES = require('./fixtures/power-seasons.json');
const CLIMATES = { Demo: E.demoClimate(), ...FIXTURES };

const season = (over = {}) => ({
  year: 2024, start: '2024-05-01', end: '2024-08-31', days: 123, temperature_c: 20, rainfall_mm: 350,
  humidity_percent: 60, wind_speed_m_s: 2, solar_radiation_mj_m2_day: 20, heavy_rain_days: 2, hot_days: 20,
  longest_dry_spell_days: 12, ...over,
});
const climateOf = (seasons) => ({ seasons, baseline: E.baselineOf(seasons), is_demo: false, source: 'NASA POWER' });
/** A one-season run of level 1 with a custom season and optional overrides. */
const runWith = (s, over = {}) => ({ ...E.createRun(1, climateOf([s, season({ year: 1 }), season({ year: 2 }), season({ year: 3 }), season({ year: 4 })])),
  seasons: [s], ...over });
const d = (crop, irrigation = 0, fertilizer = 'none', extra = {}) => ({ crop, irrigation, fertilizer, ...extra });

test('simulation is deterministic and does not mutate the run', () => {
  const run = E.createRun(7, CLIMATES['Almaty, Kazakhstan']);
  const copy = JSON.parse(JSON.stringify(run));
  const a = E.simulate(run, d('sorghum', 2, 'compost', { method: 'drip', protection: 'mulch' }));
  const b = E.simulate(run, d('sorghum', 2, 'compost', { method: 'drip', protection: 'mulch' }));
  assert.deepEqual(a, b);
  assert.deepEqual(run, copy);
});

test('fertility formula: 40 % N, 35 % organic matter, 25 % erosion protection', () => {
  assert.equal(E.fertility({ moisture: 50, n: 50, om: 40, erosion: 20 }), Math.round(20 + 14 + 20));
});

test('decisions must include crop, irrigation and fertilizer', () => {
  const run = runWith(season());
  assert.deepEqual(E.validateDecision(run, { crop: null, irrigation: null, fertilizer: null }).missing, ['crop', 'irrigation', 'fertilizer']);
  assert.deepEqual(E.validateDecision(run, { crop: 'wheat', irrigation: 0, fertilizer: null }).missing, ['fertilizer']);
  assert.ok(E.validateDecision(run, d('wheat', 0, 'none')).ok);
  assert.throws(() => E.playSeason(run, { crop: 'wheat', irrigation: null, fertilizer: 'none' }));
});

test('plans over budget or over the water reserve are rejected', () => {
  const poor = runWith(season(), { budget: 1000 });
  assert.deepEqual(E.validateDecision(poor, d('maize')).errors, ['budget']);
  const dry = runWith(season(), { reserve: 30 });
  assert.deepEqual(E.validateDecision(dry, d('wheat', 2)).errors, ['reserve']);
  assert.ok(E.validateDecision(dry, d('wheat', 2, 'none', { method: 'drip' })).ok, 'drip uses 26 of 30 points');
});

test('water reserve and budget never go negative for any affordable decision', () => {
  for (const [name, climate] of Object.entries(CLIMATES)) {
    const run = E.createRun(2, climate);
    for (const decision of E.allDecisions()) {
      if (!E.validateDecision(run, decision).ok) continue;
      const { run: next } = E.playSeason(run, decision);
      assert.ok(next.reserve >= 0 && next.reserve <= 100, `${name} reserve ${next.reserve}`);
      assert.ok(next.budget >= 0, `${name} budget ${next.budget}`);
      for (const v of Object.values(next.soil)) assert.ok(v >= 0 && v <= 100);
    }
  }
});

test('less rain lowers yield; irrigation helps in a dry season; drip saves reserve', () => {
  const wet = E.simulate(runWith(season({ rainfall_mm: 400 })), d('wheat', 0, 'compost'));
  const dry = E.simulate(runWith(season({ rainfall_mm: 90 })), d('wheat', 0, 'compost'));
  const dryIrrigated = E.simulate(runWith(season({ rainfall_mm: 90 })), d('wheat', 3, 'compost'));
  assert.ok(dry.yield < wet.yield);
  assert.equal(dry.state, 'drought');
  assert.ok(dryIrrigated.yield > dry.yield);
  const drip = E.simulate(runWith(season({ rainfall_mm: 90 })), d('wheat', 3, 'compost', { method: 'drip' }));
  assert.ok(drip.water.reserveUsed < dryIrrigated.water.reserveUsed);
  assert.ok(drip.water.irrigationMm >= dryIrrigated.water.irrigationMm);
});

test('irrigating a wet season is reported as wasted water', () => {
  const o = E.simulate(runWith(season({ rainfall_mm: 500 })), d('wheat', 3, 'none'));
  assert.ok(o.water.wastedMm > o.water.usefulMm);
  assert.ok(o.reasons.some((r) => r.code === 'irrigation.wasted'));
  assert.ok(E.seasonWaterScore(o) < 50);
});

test('heat, humidity, wind and solar radiation all change the result', () => {
  const base = E.simulate(runWith(season({ rainfall_mm: 250 })), d('wheat', 0, 'compost'));
  const hot = E.simulate(runWith(season({ rainfall_mm: 250, temperature_c: 29 })), d('wheat', 0, 'compost'));
  const dryAir = E.simulate(runWith(season({ rainfall_mm: 250, humidity_percent: 30 })), d('wheat', 0, 'compost'));
  const windy = E.simulate(runWith(season({ rainfall_mm: 250, wind_speed_m_s: 5 })), d('wheat', 0, 'compost'));
  // Low light also lowers water demand, so compare in a well-watered season
  const poorSoil = { soil: { moisture: 50, n: 40, om: 30, erosion: 40 } }; // keeps yield below the 100 % cap
  const bright = E.simulate(runWith(season({ rainfall_mm: 420 }), poorSoil), d('wheat', 0, 'compost'));
  const dark = E.simulate(runWith(season({ rainfall_mm: 420, solar_radiation_mj_m2_day: 11 }), poorSoil), d('wheat', 0, 'compost'));
  assert.ok(hot.yield < base.yield && hot.reasons.some((r) => r.code === 'temp.heat'));
  assert.ok(dryAir.water.demand > base.water.demand);
  assert.ok(windy.water.demand > base.water.demand);
  assert.ok(dark.yield < bright.yield && dark.reasons.some((r) => r.code === 'solar.low'));
  // A heat-tolerant crop copes with the same heat better
  const sorghum = E.simulate(runWith(season({ rainfall_mm: 250, temperature_c: 29 })), d('sorghum', 0, 'compost'));
  assert.ok(sorghum.scores.temperature > hot.scores.temperature);
});

test('crop rotation: monoculture raises disease, legumes leave nitrogen for the next crop', () => {
  const s = season({ rainfall_mm: 350 });
  const mono = E.simulate(runWith(s, { cropHistory: ['wheat', 'wheat'] }), d('wheat', 0, 'compost'));
  const afterLegume = E.simulate(runWith(s, { cropHistory: ['chickpea'] }), d('wheat', 0, 'compost'));
  assert.ok(mono.disease.risk > afterLegume.disease.risk);
  assert.ok(mono.reasons.some((r) => r.code === 'rotation.monoculture'));
  assert.ok(afterLegume.reasons.some((r) => r.code === 'rotation.legume'));
  assert.ok(afterLegume.yield > mono.yield);
  const chickpea = E.simulate(runWith(s), d('chickpea', 0, 'none'));
  assert.ok(chickpea.soilAfter.n > chickpea.soilBefore.n, 'legume fixes nitrogen');
  const wheat = E.simulate(runWith(s), d('wheat', 0, 'none'));
  assert.ok(wheat.soilAfter.n < wheat.soilBefore.n, 'cereal uses nitrogen');
});

test('heavy rain leaches fast fertilizer and erodes unprotected soil', () => {
  const s = season({ rainfall_mm: 600, heavy_rain_days: 9, humidity_percent: 72 });
  const synthetic = E.simulate(runWith(s), d('maize', 0, 'synthetic'));
  const compost = E.simulate(runWith(s), d('maize', 0, 'compost'));
  assert.ok(synthetic.nitrogen.leached > compost.nitrogen.leached * 2);
  const bare = E.simulate(runWith(s), d('maize', 0, 'compost'));
  const cover = E.simulate(runWith(s), d('maize', 0, 'compost', { protection: 'cover' }));
  const mulch = E.simulate(runWith(s), d('maize', 0, 'compost', { protection: 'mulch' }));
  assert.ok(cover.soilAfter.erosion < mulch.soilAfter.erosion && mulch.soilAfter.erosion < bare.soilAfter.erosion);
  assert.ok(cover.water.runoff < bare.water.runoff);
});

test('weather events come from the data compared with the 10-season normal', () => {
  const b = E.baselineOf([season({ temperature_c: 22, rainfall_mm: 300 })]);
  const types = (s, reserve) => E.seasonEvents(season(s), b, reserve).map((e) => e.type);
  assert.deepEqual(types({ temperature_c: 22, rainfall_mm: 300 }), []);
  assert.deepEqual(types({ temperature_c: 22, rainfall_mm: 150 }), ['drought']);
  assert.deepEqual(types({ temperature_c: 24, rainfall_mm: 300 }), ['heat']);
  assert.deepEqual(types({ temperature_c: 22, rainfall_mm: 450, heavy_rain_days: 7 }), ['downpour']);
  assert.deepEqual(types({ temperature_c: 24, rainfall_mm: 150 }, 20), ['drought', 'heat', 'waterDeficit']);
});

test('levels replay the driest, hottest and wettest real seasons, distinct and in order', () => {
  const kansas = CLIMATES['Salina, Kansas, USA'];
  const years = (id) => E.createRun(id, kansas).seasons.map((s) => s.year);
  const byRain = [...kansas.seasons].sort((a, b) => a.rainfall_mm - b.rainfall_mm);
  const byTemp = [...kansas.seasons].sort((a, b) => b.temperature_c - a.temperature_c);
  assert.deepEqual(years(2), [byRain[0].year]);
  assert.deepEqual(years(4), [byTemp[0].year]);
  assert.deepEqual(years(5), [byRain[byRain.length - 1].year]);
  const seven = years(7);
  assert.equal(new Set(seven).size, 3);
  assert.deepEqual(seven, [...seven].sort((a, b) => a - b));
  assert.deepEqual(years(3), [2025, 2026]);
});

test('every level can be won at every location, and careless play fails harder levels', () => {
  const careless = { crop: 'maize', irrigation: 0, fertilizer: 'none' };
  let carelessFails = 0;
  for (const [name, climate] of Object.entries(CLIMATES)) {
    for (const level of E.LEVELS) {
      const plan = E.bestPlan(E.createRun(level.id, climate));
      assert.ok(plan, `${name} L${level.id} has a plan`);
      const ev = E.evaluateLevel(plan.run);
      assert.ok(ev.passed, `${name} level ${level.id} should be winnable: ${JSON.stringify(ev.goals)}`);
      assert.ok(ev.stars >= 1 && ev.stars <= 3);
      let run = E.createRun(level.id, climate);
      while (!run.finished && !run.failed) run = E.playSeason(run, careless).run;
      if (!E.evaluateLevel(run).passed) carelessFails++;
    }
  }
  assert.ok(carelessFails >= 30, `careless play failed only ${carelessFails} of 49 level/location pairs`);
});

test('failing a goal gives zero stars; categories drive 1–3 stars', () => {
  const climate = CLIMATES['Almaty, Kazakhstan'];
  let run = E.createRun(2, climate);
  run = E.playSeason(run, d('maize', 0, 'none')).run;
  const failed = E.evaluateLevel(run);
  assert.equal(failed.passed, false);
  assert.equal(failed.stars, 0);
  assert.ok(failed.goals.some((g) => !g.met));
  assert.ok(failed.recommendations.includes('droughtCrop'));
});

test('running out of money ends the level as bankrupt', () => {
  const scorching = season({ temperature_c: 45, rainfall_mm: 0, humidity_percent: 10, wind_speed_m_s: 8 });
  const run = { ...E.createRun(6, CLIMATES.Demo), seasons: [scorching, scorching], budget: 900 };
  const { run: next, outcome } = E.playSeason(run, d('chickpea', 0, 'none'));
  assert.ok(next.budget >= 0 && next.budget < E.MODEL.MIN_SEED_COST, `budget ${next.budget}, yield ${outcome.yield}`);
  assert.equal(next.failed, 'bankrupt');
  const ev = E.evaluateLevel(next);
  assert.equal(ev.passed, false);
  assert.equal(ev.failReason, 'bankrupt');
});

test('What If compares two decisions without changing the run', () => {
  const run = E.createRun(4, CLIMATES['Delhi, India']);
  const before = JSON.stringify(run);
  const best = E.bestDecision(run);
  const cmp = E.compare(run, d('wheat', 0, 'none'), best.decision);
  assert.equal(JSON.stringify(run), before);
  assert.ok(cmp.alternative.outcome.yield > cmp.player.outcome.yield);
  assert.ok(cmp.alternative.affordable);
});

test('progress unlocks levels in order and keeps the best result', () => {
  let p = E.emptyProgress();
  assert.ok(E.isUnlocked(p, 1));
  assert.ok(!E.isUnlocked(p, 2));
  const ev = (passed, stars, score) => ({ levelId: 1, passed, stars, score, categories: { yield: { score }, water: { score }, soil: { score } },
    metrics: { fertilityDelta: 0, profit: 100, irrigationMm: 0 } });
  p = E.recordResult(p, ev(false, 0, 40));
  assert.ok(!E.isUnlocked(p, 2));
  p = E.recordResult(p, ev(true, 2, 70));
  assert.ok(E.isUnlocked(p, 2));
  p = E.recordResult(p, ev(true, 1, 99));
  assert.equal(p.best[1].stars, 2, 'fewer stars never replace a better result');
  p = E.recordResult(p, ev(false, 0, 10));
  assert.ok(p.best[1].passed, 'a later failure never relocks a level');
  assert.deepEqual(E.sanitizeProgress({ version: 1, best: { 1: { stars: 9, passed: true } } }), E.emptyProgress());
  assert.deepEqual(E.sanitizeProgress('garbage'), E.emptyProgress());
  const report = E.farmReport(p);
  assert.equal(report.totalStars, 2);
  assert.equal(report.completed, 1);
  assert.equal(report.allPassed, false);
});
