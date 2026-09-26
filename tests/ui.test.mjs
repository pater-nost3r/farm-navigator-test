// Integration test of the real page: jsdom → the real FastAPI server (spawned from the
// project's Python) → a fake NASA POWER endpoint served here (NASA_POWER_BASE_URL).
// So the whole path UI → API → POWER client → engine → UI runs, without the internet.
// Skipped (with a message) when Python with the backend requirements is not available.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM, VirtualConsole } from 'jsdom';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const read = (p) => readFileSync(join(ROOT, p), 'utf8');
// Inline the external scripts so the page runs from an http origin (localStorage works).
const HTML = read('farm-navigator.html').replace(/<script src="(js\/[\w-]+\.js)"><\/script>/g, (_, src) => `<script>${read(src)}</script>`);

function findPython() {
  const candidates = [join(ROOT, '.venv', 'Scripts', 'python.exe'), join(ROOT, '.venv', 'bin', 'python'), 'python3', 'python'];
  for (const p of candidates) {
    if (p.includes('.venv') && !existsSync(p)) continue;
    const r = spawnSync(p, ['-c', 'import fastapi, uvicorn, httpx'], { encoding: 'utf8' });
    if (r.status === 0) return p;
  }
  return null;
}

/* ---------- Fake NASA POWER (deterministic, POWER-shaped JSON) ---------- */
const powerMode = { fail: false, requests: 0 };
const UNITS = { T2M: 'C', T2M_MAX: 'C', T2M_MIN: 'C', PRECTOTCORR: 'mm/day', RH2M: '%', WS2M: 'm/s', ALLSKY_SFC_SW_DWN: 'MJ/m^2/day' };
const hash = (...k) => { let h = 2166136261; for (const x of k) { h ^= x; h = Math.imul(h, 16777619) >>> 0; } h ^= h >>> 13; return (Math.imul(h, 0x5bd1e995) >>> 0) / 4294967296; };
function powerPayload(q) {
  const params = q.get('parameters').split(',');
  const d0 = new Date(`${q.get('start').slice(0, 4)}-${q.get('start').slice(4, 6)}-${q.get('start').slice(6)}T00:00:00Z`);
  const d1 = new Date(`${q.get('end').slice(0, 4)}-${q.get('end').slice(4, 6)}-${q.get('end').slice(6)}T00:00:00Z`);
  const block = Object.fromEntries(params.map((p) => [p, {}]));
  for (let d = new Date(d0); d <= d1; d.setUTCDate(d.getUTCDate() + 1)) {
    const key = d.toISOString().slice(0, 10).replace(/-/g, '');
    const doy = Math.floor((d - Date.UTC(d.getUTCFullYear(), 0, 1)) / 864e5) + 1;
    const y = d.getUTCFullYear(), n = Math.floor(d / 864e5);
    const season = Math.sin(2 * Math.PI * (doy - 105) / 365);
    const t = 12 + 13 * season + 4 * hash(y, 1) - 1.5 + 2 * (hash(n, 2) - 0.5);
    const wet = hash(n, 3) < 0.22;
    const v = { T2M: t, T2M_MAX: t + 7, T2M_MIN: t - 7, PRECTOTCORR: wet ? -6 * (0.5 + hash(y, 4)) * Math.log(Math.max(1e-6, hash(n, 5))) : 0,
      RH2M: 55, WS2M: 2 + 2 * hash(n, 6), ALLSKY_SFC_SW_DWN: 16 + 8 * season };
    for (const p of params) block[p][key] = Math.round(v[p] * 100) / 100;
  }
  return { type: 'Feature', geometry: { type: 'Point', coordinates: [Number(q.get('longitude')), Number(q.get('latitude')), 500] },
    properties: { parameter: block }, header: { time_standard: q.get('time-standard'), fill_value: -999 }, messages: [],
    parameters: Object.fromEntries(params.map((p) => [p, { units: UNITS[p], longname: p }])) };
}

let python = null, api = null, power = null, apiUrl = '', cacheDir = '';
before(async () => {
  python = findPython();
  if (!python) return;
  power = createServer((req, res) => {
    powerMode.requests++;
    const q = new URL(req.url, 'http://x').searchParams;
    if (powerMode.fail) { res.writeHead(503); res.end('busy'); return; }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(powerPayload(q)));
  });
  await new Promise((r) => power.listen(0, '127.0.0.1', r));
  const port = 18000 + Math.floor(Math.random() * 2000);
  cacheDir = mkdtempSync(join(tmpdir(), 'farm-nav-'));
  api = spawn(python, ['-m', 'uvicorn', 'app.main:app', '--port', String(port), '--log-level', 'warning'], {
    cwd: ROOT, stdio: 'ignore',
    env: { ...process.env, NASA_POWER_BASE_URL: `http://127.0.0.1:${power.address().port}/api/temporal/daily/point`,
      CACHE_DIR: cacheDir, NASA_RETRIES: '0' },
  });
  apiUrl = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 150; i++) {
    try { if ((await fetch(`${apiUrl}/api/health`)).ok) return; } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('the API server did not start');
});
after(() => {
  if (api) api.kill();
  if (power) power.close();
  if (cacheDir) rmSync(cacheDir, { recursive: true, force: true });
});

function makePage({ storage } = {}) {
  const errors = [];
  const vc = new VirtualConsole();
  vc.on('error', (e) => errors.push(String(e)));
  vc.on('jsdomError', (e) => { if (!/Not implemented: (window\.scrollTo|navigation)/.test(e.message)) errors.push(e.message); });
  const calls = [];
  const dom = new JSDOM(HTML, {
    url: 'http://localhost:8000/', runScripts: 'dangerously', pretendToBeVisual: true, virtualConsole: vc,
    beforeParse(window) {
      window.fetch = (url, init = {}) => {
        calls.push(String(url));
        // jsdom's AbortSignal is not Node's, so the signal is not passed on.
        return fetch(apiUrl + url, { method: init.method, headers: init.headers, body: init.body });
      };
      window.confirm = () => true;
      window.scrollTo = () => {};
      window.HTMLElement.prototype.scrollIntoView = () => {};
      window.URL.createObjectURL = () => 'blob:report';
      window.URL.revokeObjectURL = () => {};
      if (storage) for (const [k, v] of Object.entries(storage)) window.localStorage.setItem(k, v);
    },
  });
  const { window } = dom;
  const $ = (id) => window.document.getElementById(id);
  const click = (el) => { assert.ok(el, 'element to click exists'); assert.ok(!el.disabled, `button enabled: ${el.outerHTML.slice(0, 90)}`); el.click(); };
  const active = () => window.document.querySelector('.screen.active, .center-screen.active')?.id;
  const shown = (id) => $(id).classList.contains('show');
  return { dom, window, doc: window.document, $, click, active, shown, errors, calls };
}
async function until(fn, ms = 15000, label = 'condition') {
  const start = Date.now();
  while (Date.now() - start < ms) { if (fn()) return; await new Promise((r) => setTimeout(r, 25)); }
  throw new Error(`timed out waiting for ${label}`);
}
const FARM = JSON.stringify({ latitude: 43.6, longitude: 77, start_md: '05-01', end_md: '08-31', soil: 'sandy', place: { preset: 'almaty' } });
const ALL_UNLOCKED = JSON.stringify({ version: 2, best: Object.fromEntries([1, 2, 3, 4, 5, 6].map((id) => [id, { passed: true, stars: 1, score: 50, yield: 60, water: 60, soil: 60, profit: 0, pumpedMm: 0 }])) });

async function playSeason(page, plan) {
  const { $, doc, click, shown } = page;
  for (const [field, value] of Object.entries(plan)) click(doc.querySelector(`[data-${field}="${value}"]`));
  await until(() => !$('btn-confirm').disabled, 3000, 'confirm enabled');
  click($('btn-confirm'));
  await until(() => shown('ov-report'), 20000, 'season report');
}

test('farm setup → level 1 → season report → What If → result, all through the real API', { timeout: 120000 }, async (t) => {
  if (!python) { t.skip('Python with the backend requirements is not available'); return; }
  const page = makePage();
  const { $, doc, click, active, shown, window } = page;

  await until(() => active() === 'scr-location', 10000, 'farm setup');
  assert.ok($('btn-load').disabled, 'nothing chosen yet');
  click(doc.querySelector('[data-preset="almaty"]'));
  assert.ok(!$('btn-load').disabled, 'preset fills place, period and soil');
  click(doc.querySelector('[data-soil="clay"]'));
  // An empty period is rejected before anything is sent
  $('per-end-m').value = '4'; $('per-end-d').value = '20'; $('per-end-d').dispatchEvent(new window.Event('input'));
  assert.ok($('btn-load').disabled);
  assert.match($('setup-msg').textContent, /empty/);
  $('per-end-m').value = '8'; $('per-end-d').value = '31'; $('per-end-d').dispatchEvent(new window.Event('input'));
  click($('btn-load'));

  await until(() => active() === 'scr-levels', 20000, 'levels');
  assert.ok(page.calls.some((u) => u.startsWith('/api/nasa/archive?latitude=43.6&longitude=77&start_md=04-20&end_md=08-31&demo=false')));
  assert.ok(!page.calls.some((u) => u.includes('power.larc.nasa.gov')), 'the browser never calls NASA directly');
  assert.match($('lv-status').textContent, /Live/);
  assert.match($('lv-prov').innerHTML, /time-standard=LST/);
  assert.ok(shown('ov-tut'), 'first visit shows the tutorial');
  for (let i = 0; i < 4; i++) click($('tut-next'));
  assert.equal(doc.querySelectorAll('[data-level]:not([disabled])').length, 1, 'only level 1 is open');

  click(doc.querySelector('[data-level="1"]'));
  assert.ok(shown('ov-level'));
  const years = doc.querySelectorAll('#brief [data-year]');
  assert.ok(years.length >= 10, 'the player chooses among real years');
  click(years[1]);
  click($('brief-start'));
  await until(() => active() === 'scr-game', 15000, 'game');
  assert.match($('nasa-sub').textContent, /Summer/);
  assert.match($('data-list').textContent, /T2M_MAX/);
  assert.ok($('btn-confirm').disabled, 'no turn without all decisions');
  assert.match($('missing').textContent, /crop.*irrigation system.*water use.*soil care/);

  await playSeason(page, { crop: 'sorghum', method: 'drip', intensity: 'low', care: 'mulch' });
  const report = $('report').textContent;
  for (const label of ['NASA data', 'Your decision', 'Model', 'What If', 'Model limitations']) assert.ok(report.includes(label), label);
  assert.ok($('report').querySelector('.chart svg path.c-moist'), 'daily soil water chart');

  click($('btn-whatif'));
  await until(() => $('whatif').querySelector('table'), 15000, 'custom what-if');
  assert.match($('whatif').textContent, /Irrigation system: Drip →/);
  click($('wi-close'));

  click($('btn-next'));
  await until(() => $('banner').classList.contains('show'), 5000, 'level banner');
  click($('btn-final'));
  assert.equal(active(), 'scr-final');
  assert.match($('final').textContent, /Star criteria/);
  assert.match($('final').textContent, /Data used/);
  click($('res-export'));
  const saved = JSON.parse(window.localStorage.getItem('farm-navigator.progress.v2'));
  assert.ok(saved.best[1], 'best result stored');

  // Language switch re-renders the result screen
  window.FarmPrefs.setLanguagePreference('ru');
  assert.match($('final').textContent, /Итог уровня 1/);
  assert.deepEqual(page.errors, []);
});

test('multi-season level carries the soil over; pause stops the season clock', { timeout: 120000 }, async (t) => {
  if (!python) { t.skip('Python with the backend requirements is not available'); return; }
  const page = makePage({ storage: { 'farm-navigator.farm.v2': FARM, 'farm-navigator.progress.v2': ALL_UNLOCKED, 'farm-navigator.tutorial.v1': 'true' } });
  const { $, doc, click, active, shown } = page;
  await until(() => active() === 'scr-levels', 20000, 'levels');
  click(doc.querySelector('[data-level="3"]'));
  click($('brief-start'));
  await until(() => active() === 'scr-game', 15000, 'game');

  for (const f of Object.entries({ crop: 'chickpea', method: 'drip', intensity: 'off', care: 'cover_crop' })) click(doc.querySelector(`[data-${f[0]}="${f[1]}"]`));
  click($('btn-confirm'));
  await until(() => !$('grow-bar').hidden, 15000, 'season animation');
  click($('btn-pause'));
  assert.ok(shown('ov-pause'));
  const frozen = $('grow-bar').textContent;
  await new Promise((r) => setTimeout(r, 700));
  assert.equal($('grow-bar').textContent, frozen, 'nothing advances while paused');
  assert.ok(!shown('ov-report'));
  click($('btn-resume'));
  await until(() => shown('ov-report'), 20000, 'report after resume');
  click($('btn-next'));
  await until(() => $('season-count').textContent.includes('2 of 2'), 5000, 'season 2');
  assert.match($('crop-grid').textContent, /Nitrogen from legume/, 'rotation credit is shown');
  assert.match($('soil-card').textContent, /Chickpea/);

  await playSeason(page, { crop: 'maize', method: 'drip', intensity: 'medium', care: 'none' });
  assert.ok($('report').textContent.includes('last season left extra nitrogen'), 'legume effect explained');
  click($('btn-next'));
  await until(() => $('banner').classList.contains('show'), 5000, 'banner');
  assert.deepEqual(page.errors, []);
});

test('NASA POWER down: error screen, retry, then an explicit Demo mode', { timeout: 60000 }, async (t) => {
  if (!python) { t.skip('Python with the backend requirements is not available'); return; }
  powerMode.fail = true;
  try {
    const farm = JSON.stringify({ latitude: -35.1, longitude: 147.4, start_md: '05-15', end_md: '11-30', soil: 'loam', place: { preset: 'wagga' } });
    const page = makePage({ storage: { 'farm-navigator.farm.v2': farm, 'farm-navigator.tutorial.v1': 'true' } });
    const { $, click, active } = page;
    await until(() => active() === 'scr-error', 20000, 'error screen');
    assert.match($('err-title').textContent, /NASA POWER/);
    assert.ok(!$('btn-demo').hidden, 'demo is offered only as an explicit choice');
    click($('btn-retry'));
    await until(() => active() === 'scr-error', 20000, 'still failing');
    click($('btn-demo'));
    await until(() => active() === 'scr-levels', 20000, 'demo levels');
    assert.match($('lv-status').textContent, /Demo/);
    assert.match($('lv-place').textContent, /Demo farm/);
  } finally {
    powerMode.fail = false;
  }
});
