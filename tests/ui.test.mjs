// End-to-end smoke test of the real page in jsdom: the backend is stubbed with real
// NASA POWER fixture data, and every level is played by clicking the actual controls.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { JSDOM, VirtualConsole } from 'jsdom';

const require = createRequire(import.meta.url);
const E = require('../js/engine.js');
const FIXTURES = require('./fixtures/power-seasons.json');
const KANSAS = FIXTURES['Salina, Kansas, USA'];

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
// Inline the external scripts so the page runs from an http origin (localStorage works).
const HTML = read('farm-navigator.html').replace(/<script src="(js\/[\w-]+\.js)"><\/script>/g, (_, src) => `<script>${read(src)}</script>`);

const jsonResponse = (body, status = 200) => ({ ok: status < 400, status, headers: { get: () => 'application/json' }, json: async () => body });

function makePage({ fetchImpl, online = true, storage } = {}) {
  const errors = [];
  const vc = new VirtualConsole();
  vc.on('error', (e) => errors.push(String(e)));
  vc.on('warn', (e) => errors.push(String(e)));
  vc.on('jsdomError', (e) => { if (!/Not implemented: window\.scrollTo/.test(e.message)) errors.push(e.message); });
  const calls = [];
  const dom = new JSDOM(HTML, {
    url: 'http://localhost:8000/',
    runScripts: 'dangerously',
    pretendToBeVisual: true,
    virtualConsole: vc,
    beforeParse(window) {
      window.fetch = async (url) => { calls.push(String(url)); return fetchImpl(String(url)); };
      window.confirm = () => true;
      window.scrollTo = () => {};
      window.HTMLElement.prototype.scrollIntoView = () => {};
      if (!online) Object.defineProperty(window.navigator, 'onLine', { get: () => false });
      if (storage) for (const [k, v] of Object.entries(storage)) window.localStorage.setItem(k, v);
    },
  });
  const { window } = dom;
  const $ = (id) => window.document.getElementById(id);
  const click = (el) => { assert.ok(el, 'element to click exists'); assert.ok(!el.disabled, `button enabled: ${el.outerHTML.slice(0, 80)}`); el.click(); };
  const active = () => window.document.querySelector('.screen.active, .center-screen.active')?.id;
  return { dom, window, $, click, active, errors, calls };
}
async function until(fn, ms = 8000, label = 'condition') {
  const start = Date.now();
  while (Date.now() - start < ms) { if (fn()) return; await new Promise((r) => setTimeout(r, 20)); }
  throw new Error(`timed out waiting for ${label}`);
}

test('plays all seven levels with real Kansas NASA POWER data', { timeout: 180000 }, async () => {
  const page = makePage({
    fetchImpl: (url) => url.includes('/api/nasa/climate') ? jsonResponse({ ...KANSAS, status: 'live' })
      : url.includes('/api/geocode') ? jsonResponse({ results: [{ name: 'Salina', country: 'United States', latitude: 38.84, longitude: -97.61 }] })
        : jsonResponse({}, 404),
  });
  const { window, $, click, active } = page;
  const doc = window.document;

  // Location screen first; city search goes through the backend
  await until(() => active() === 'scr-location', 3000, 'location screen');
  $('loc-q').value = 'Salina';
  $('loc-search').dispatchEvent(new window.Event('submit', { cancelable: true }));
  await until(() => doc.querySelector('[data-result="0"]'), 3000, 'search results');
  click(doc.querySelector('[data-result="0"]'));
  await until(() => active() === 'scr-levels', 5000, 'levels screen');
  assert.ok(page.calls.some((u) => u.startsWith('/api/nasa/climate?latitude=38.84&longitude=-97.61')), 'frontend calls our backend, not NASA');
  assert.ok(!page.calls.some((u) => u.includes('power.larc.nasa.gov')));
  assert.match($('lv-status').textContent, /Live/);
  // First visit opens the tutorial
  assert.ok($('ov-tut').classList.contains('show'));
  for (let i = 0; i < 4; i++) click($('tut-next'));
  assert.ok(!$('ov-tut').classList.contains('show'));
  // Only level 1 is unlocked
  assert.equal(doc.querySelectorAll('[data-level]:not([disabled])').length, 1);

  for (const level of E.LEVELS) {
    click(doc.querySelector(`[data-level="${level.id}"]`));
    assert.ok($('ov-level').classList.contains('show'), 'level brief opens');
    assert.ok($('brief').textContent.length > 100);
    click($('brief-start'));
    assert.equal(active(), 'scr-game');

    const plan = E.bestPlan(E.createRun(level.id, KANSAS));
    for (const [i, d] of plan.path.entries()) {
      // Required decisions: cannot confirm before choosing crop, irrigation and fertilizer
      assert.ok($('btn-confirm').disabled, 'confirm disabled before choosing');
      assert.ok($('missing').classList.contains('show'));
      click(doc.querySelector(`[data-crop="${d.crop}"]`));
      click(doc.querySelector(`[data-irr="${d.irrigation}"]`));
      if (d.irrigation) click(doc.querySelector(`[data-method="${d.method}"]`));
      assert.ok($('btn-confirm').disabled, 'still disabled without fertilizer');
      click(doc.querySelector(`[data-fert="${d.fertilizer}"]`));
      click(doc.querySelector(`[data-prot="${d.protection}"]`));
      assert.ok(!$('btn-confirm').disabled, `level ${level.id} season ${i + 1} confirm enabled`);
      click($('btn-confirm'));
      await until(() => $('ov-report').classList.contains('show'), 6000, 'season report');
      assert.ok(doc.querySelectorAll('#report .why li').length >= 3, 'reasons listed');
      assert.match($('report').textContent, /NASA POWER/);
      if (level.id === 1) {
        // What If never changes progress
        click($('btn-whatif'));
        assert.ok($('ov-whatif').classList.contains('show'));
        const sel = $('wi-crop');
        sel.value = 'maize';
        sel.dispatchEvent(new window.Event('change'));
        assert.equal($('wi-crop').value, 'maize');
        assert.equal(doc.querySelectorAll('#whatif tbody tr').length, 9);
        click($('wi-close'));
      }
      click($('btn-next'));
    }
    await until(() => $('banner').classList.contains('show'), 3000, 'banner');
    click($('btn-final'));
    assert.equal(active(), 'scr-final');
    assert.match($('final').textContent, /Level passed/);
    const saved = JSON.parse(window.localStorage.getItem('farm-navigator.progress.v1'));
    assert.ok(saved.best[level.id].passed && saved.best[level.id].stars >= 1, `level ${level.id} saved`);
    click($('res-levels'));
    if (level.id < 7) assert.ok(!doc.querySelector(`[data-level="${level.id + 1}"]`).disabled, `level ${level.id + 1} unlocked`);
  }

  // Whole-farm report
  click($('btn-farm-report'));
  assert.equal(active(), 'scr-farm');
  assert.equal(doc.querySelectorAll('#farm tbody tr').length, 7);
  assert.match($('farm').textContent, /7 of 7 levels passed/);

  // Language switch re-renders the visible screen
  window.FarmPrefs.setLanguagePreference('ru');
  assert.match($('farm').textContent, /Пройдено уровней: 7 из 7/);
  window.FarmPrefs.setLanguagePreference('en');
  assert.deepEqual(page.errors, []);
  page.window.close();
});

test('pause stops the season clock and blocks input until resumed', { timeout: 30000 }, async () => {
  const page = makePage({ fetchImpl: () => jsonResponse({ ...KANSAS, status: 'live' }),
    storage: { 'farm-navigator.location.v1': JSON.stringify({ preset: 'kansas', latitude: 38.84, longitude: -97.61 }), 'farm-navigator.tutorial.v1': 'true' } });
  const { $, click, active, window } = page;
  await until(() => active() === 'scr-levels', 5000, 'levels');
  click(window.document.querySelector('[data-level="1"]'));
  click($('brief-start'));
  for (const sel of ['[data-crop="wheat"]', '[data-irr="0"]', '[data-fert="compost"]']) click(window.document.querySelector(sel));
  click($('btn-confirm'));
  click($('btn-pause'));
  assert.ok($('ov-pause').classList.contains('show'));
  await new Promise((r) => setTimeout(r, 2200));
  assert.ok(!$('ov-report').classList.contains('show'), 'no report while paused');
  click($('btn-resume'));
  await until(() => $('ov-report').classList.contains('show'), 4000, 'report after resume');
  assert.deepEqual(page.errors, []);
  page.window.close();
});

test('NASA errors show the error screen with retry and an honest demo mode', { timeout: 30000 }, async () => {
  let fail = true;
  const page = makePage({ fetchImpl: () => (fail ? jsonResponse({ detail: { kind: 'timeout' } }, 504) : jsonResponse({ ...KANSAS, status: 'cached' })),
    storage: { 'farm-navigator.location.v1': JSON.stringify({ preset: 'kansas', latitude: 38.84, longitude: -97.61 }), 'farm-navigator.tutorial.v1': 'true' } });
  const { $, click, active } = page;
  await until(() => active() === 'scr-error', 5000, 'error screen');
  assert.match($('err-title').textContent, /taking too long/);
  // Retry succeeds (server cache) → Cached status
  fail = false;
  click($('btn-retry'));
  await until(() => active() === 'scr-levels', 5000, 'levels after retry');
  assert.match($('lv-status').textContent, /Cached/);
  page.window.close();

  const offline = makePage({ online: false, fetchImpl: () => { throw new Error('should not fetch while offline'); },
    storage: { 'farm-navigator.location.v1': JSON.stringify({ preset: 'kansas', latitude: 38.84, longitude: -97.61 }), 'farm-navigator.tutorial.v1': 'true' } });
  await until(() => offline.active() === 'scr-error', 5000, 'offline error');
  assert.match(offline.$('err-title').textContent, /offline/);
  offline.click(offline.$('btn-demo'));
  assert.equal(offline.active(), 'scr-levels');
  assert.match(offline.$('lv-status').textContent, /Demo data/);
  assert.match(offline.$('lv-place').textContent, /Demo farm/);
  assert.deepEqual(offline.errors, []);
  offline.window.close();
});

test('saved browser copy is used offline and labelled as cached', { timeout: 30000 }, async () => {
  const key = 'farm-navigator.climate.v1:38.84,-97.61';
  const page = makePage({ online: false, fetchImpl: () => { throw new Error('no network'); },
    storage: { 'farm-navigator.location.v1': JSON.stringify({ preset: 'kansas', latitude: 38.84, longitude: -97.61 }), 'farm-navigator.tutorial.v1': 'true',
      [key]: JSON.stringify({ savedAt: Date.now() - 30 * 24 * 3600 * 1000, data: { ...KANSAS, status: 'live' } }) } });
  await until(() => page.active() === 'scr-levels', 5000, 'levels from cache');
  assert.match(page.$('lv-status').textContent, /Cached copy/);
  assert.deepEqual(page.errors, []);
  page.window.close();
});
