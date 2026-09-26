import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
const html = read('farm-navigator.html');
const app = read('js/app.js');
const engine = read('app/services/engine.py');
const MODEL = JSON.parse(read('app/data/game_model.json'));
const block = (lang) => JSON.parse(html.match(new RegExp(`<script type="application/json" id="i18n-${lang}">([\\s\\S]*?)</script>`))[1]);
const en = block('en');
const ru = block('ru');
const opts = (section) => Object.keys(section).filter((k) => !k.startsWith('_'));

test('English and Russian have exactly the same keys and placeholders', () => {
  assert.deepEqual(Object.keys(ru).sort(), Object.keys(en).sort());
  const vars = (s) => [...s.matchAll(/\{\{(\w+)\}\}/g)].map((m) => m[1]).sort();
  for (const key of Object.keys(en)) assert.deepEqual(vars(ru[key]), vars(en[key]), key);
});

test('every literal key used in the UI exists', () => {
  const literals = new Set([
    ...[...app.matchAll(/\bt\(\s*'([a-zA-Z][\w-]*(?:\.[\w-]+)+)'/g)].map((m) => m[1]),
    ...[...app.matchAll(/has\(\s*'([\w.-]+)'/g)].map((m) => m[1]),
    ...[...html.matchAll(/data-i18n(?:-html)?="([^"]+)"/g)].map((m) => m[1]),
    ...[...html.matchAll(/data-i18n-attr="([^"]+)"/g)].flatMap((m) => m[1].split(';').map((p) => p.split(':')[1])),
  ]);
  const missing = [...literals].filter((k) => !(k in en));
  assert.deepEqual(missing, []);
});

test('every key family built from the model or the server engine is translated', () => {
  const need = [];
  for (const id of opts(MODEL.crops)) need.push(`crops.${id}.name`, `crops.${id}.tag`);
  for (const id of opts(MODEL.soils)) need.push(`soils.${id}.name`, `soils.${id}.desc`);
  for (const id of opts(MODEL.irrigation_methods)) need.push(`methods.${id}.name`, `methods.${id}.desc`);
  for (const id of opts(MODEL.irrigation_intensity)) need.push(`intensity.${id}.name`, `intensity.${id}.desc`);
  for (const id of opts(MODEL.soil_care)) need.push(`care.${id}.name`, `care.${id}.desc`);
  for (const p of MODEL.presets) need.push(`places.${p.id}`, `places.${p.id}.note`);
  for (const l of MODEL.levels) {
    need.push(`levels.${l.key}.name`, `levels.${l.key}.short`, `levels.${l.key}.story`, `weatherType.${l.weather.type}`, `weatherRule.${l.weather.type}`);
    for (const g of l.goals) need.push(`goal.${g.metric}`);
    for (const g of l.lose) need.push(`lose.${g.metric}`);
  }
  for (const k of ['offline', 'timeout', 'nasa', 'server', 'no-backend', 'invalid', 'rejected']) need.push(`error.${k}.title`, `error.${k}.text`, `error.${k}.short`, `location.err.${k}`);
  for (const k of ['invalid', 'empty', 'short', 'long', 'missing']) need.push(`location.period.${k}`);
  for (const k of ['live', 'cached', 'demo']) need.push(`status.${k}`, `status.${k}Hint`);
  for (const k of ['nasa', 'player', 'computed', 'assumption']) need.push(`category.${k}`);
  for (const k of ['spring', 'summer', 'autumn', 'winter', 'tropical']) need.push(`seasonName.${k}`);
  for (const k of ['hot', 'warm', 'dry', 'wet']) need.push(`anomaly.${k}`);
  for (const k of ['goals', 'bankrupt', 'crop_failure']) need.push(`banner.fail.${k}`, `result.fail.${k}`);
  for (const k of ['crop', 'method', 'intensity', 'care']) need.push(`decisions.missing.${k}`, `decisions.field.${k}`);
  // Everything the server engine can produce
  const engineStrings = (re) => [...engine.matchAll(re)].map((m) => m[1]);
  for (const code of engineStrings(/"code": "([a-z_.]+)"/g)) need.push(`reason.${code}`);
  for (const id of opts(MODEL.soil_care).filter((c) => c !== 'none')) need.push(`reason.care.${id}`);
  for (const rec of engineStrings(/recs\.append\("(\w+)"\)/g)) need.push(`rec.${rec}`);
  for (const s of engineStrings(/state = "(\w+)"/g)) need.push(`states.${s}`);
  const factorsBlock = engine.slice(engine.indexOf('factors = {'), engine.indexOf('rel = clamp(math.prod'));
  for (const f of [...factorsBlock.matchAll(/^\s+"(\w+)":/gm)].map((m) => m[1])) need.push(`factor.${f}`);
  for (const c of engineStrings(/\("(\w+)", (?:min|max)\(/g)) need.push(`whatif.criterion.${c}`);
  for (const k of ['planning', 'growing', 'harvest', 'failed']) need.push(`states.${k}`);
  for (const k of ['showers', 'heat', 'rain', 'clear', 'cloudy']) need.push(`weather.${k}`);
  const missing = [...new Set(need)].filter((k) => !(k in en));
  assert.deepEqual(missing, []);
  assert.ok(need.filter((k) => k.startsWith('reason.')).length >= 25, 'reason codes were found in engine.py');
  assert.ok(need.filter((k) => k.startsWith('factor.')).length >= 8, 'yield factors were found in engine.py');
});

test('no leftover Design States dock and no fake-data wording', () => {
  assert.ok(!/id="dock"|Design states|data-go=/.test(html));
  assert.ok(!/forecast/i.test(en['report.modelNote'].replace('not a yield forecast', '')));
});
