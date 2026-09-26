import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const E = require('../js/engine.js');
const html = readFileSync(new URL('../farm-navigator.html', import.meta.url), 'utf8');
const app = readFileSync(new URL('../js/app.js', import.meta.url), 'utf8');
const block = (lang) => JSON.parse(html.match(new RegExp(`<script type="application/json" id="i18n-${lang}">([\\s\\S]*?)</script>`))[1]);
const en = block('en');
const ru = block('ru');

test('English and Russian have exactly the same keys and placeholders', () => {
  assert.deepEqual(Object.keys(ru).sort(), Object.keys(en).sort());
  const vars = (s) => [...s.matchAll(/\{\{(\w+)\}\}/g)].map((m) => m[1]).sort();
  for (const key of Object.keys(en)) assert.deepEqual(vars(ru[key]), vars(en[key]), key);
});

test('every literal key used in the UI exists', () => {
  const literals = new Set([
    ...[...app.matchAll(/'([a-z][a-zA-Z]*(?:\.[a-zA-Z0-9-]+)+)'/g)].map((m) => m[1]),
    ...[...html.matchAll(/data-i18n(?:-html)?="([^"]+)"/g)].map((m) => m[1]),
    ...[...html.matchAll(/data-i18n-attr="([^"]+)"/g)].flatMap((m) => m[1].split(';').map((p) => p.split(':')[1])),
  ]);
  const missing = [...literals].filter((k) => !k.endsWith('.') && !(k in en) && !/^(farm-navigator|text\/|application\/)/.test(k));
  assert.deepEqual(missing, []);
});

test('every dynamic key family is translated', () => {
  const need = [];
  for (const id of E.CROP_IDS) need.push(`crops.${id}.name`, `crops.${id}.tag`);
  for (const l of E.LEVELS) {
    need.push(`levels.${l.key}.name`, `levels.${l.key}.short`, `levels.${l.key}.story`);
    for (const g of l.goals) need.push(`goal.${g.metric}`);
    for (const s of l.seasons) need.push(`pick.${s}`);
  }
  for (const o of E.IRRIGATION) need.push(`irrigation.${o.id}`);
  for (const m of Object.keys(E.METHODS)) need.push(`methods.${m}.name`, `methods.${m}.desc`);
  for (const f of Object.keys(E.FERTILIZERS)) need.push(`fertilizers.${f}.name`, `fertilizers.${f}.desc`);
  for (const p of Object.keys(E.PROTECTION)) need.push(`protection.${p}.name`, `protection.${p}.desc`);
  for (const k of ['offline', 'timeout', 'nasa', 'server', 'no-backend', 'invalid']) need.push(`error.${k}.title`, `error.${k}.text`, `error.${k}.short`, `location.err.${k}`);
  for (const k of ['drought', 'heat', 'downpour', 'waterDeficit']) need.push(`events.${k}`, `insight.${k}`);
  for (const k of ['planning', 'healthy', 'drought', 'heatstress', 'overwater', 'lownutrients', 'disease', 'harvest', 'failed']) need.push(`states.${k}`);
  for (const k of ['drought', 'excess', 'heat', 'cold', 'nitrogen', 'disease', 'erosion', 'healthy']) need.push(`science.${k}`);
  for (const k of ['live', 'cached', 'demo']) need.push(`status.${k}`, `status.${k}Hint`);
  for (const k of ['T2M', 'PRECTOTCORR', 'RH2M', 'WS2M', 'ALLSKY_SFC_SW_DWN']) need.push(`param.${k}`);
  // Every reason and recommendation code the engine can produce
  const codes = new Set([...readFileSync(new URL('../js/engine.js', import.meta.url), 'utf8').matchAll(/code: '([a-zA-Z.]+)'/g)].map((m) => m[1]));
  // codes built from templates or ternaries
  ['protection.mulch', 'protection.cover', 'soil.fertile', 'soil.poor'].forEach((c) => codes.add(c));
  for (const c of codes) need.push(`reason.${c}`);
  for (const rec of ['droughtCrop', 'checkRain', 'slowFertilizer', 'protectSoil', 'rotate', 'addNitrogen', 'heatCrop', 'costs', 'drip', 'buildSoil', 'gridNote']) need.push(`rec.${rec}`);
  const missing = need.filter((k) => !(k in en));
  assert.deepEqual(missing, []);
});
