import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const D = require('../js/nasa-client.js');

const json = (body, status = 200) => ({ ok: status < 400, status, headers: { get: () => 'application/json' }, json: async () => body });
const html = (status = 200) => ({ ok: status < 400, status, headers: { get: () => 'text/html' }, json: async () => { throw new Error('not json'); } });
const noSleep = async () => {};

function client(handler, extra = {}) {
  const calls = [];
  const c = D.createClient({ apiBase: '', sleep: noSleep, isOnline: () => true, ...extra,
    fetch: async (url, init) => { calls.push({ url, init }); return handler(url, init, calls.length); } });
  return { c, calls };
}

test('archive request goes to our backend with the farm window', async () => {
  const { c, calls } = client(() => json({ data: { status: 'live' }, seasons: [] }));
  const body = await c.loadArchive({ latitude: 43.6, longitude: 77, start_md: '04-20', end_md: '08-31', soil: 'loam' });
  assert.equal(body.data.status, 'live');
  assert.equal(calls[0].url, '/api/nasa/archive?latitude=43.6&longitude=77&start_md=04-20&end_md=08-31&demo=false');
  assert.ok(!calls[0].url.includes('power.larc.nasa.gov'));
});

test('game calls are POSTed as JSON', async () => {
  const { c, calls } = client(() => json({ run: {} }));
  await c.turn({ level_id: 1, year: 2024, decisions: [] });
  assert.equal(calls[0].url, '/api/game/turn');
  assert.equal(calls[0].init.method, 'POST');
  assert.deepEqual(JSON.parse(calls[0].init.body), { level_id: 1, year: 2024, decisions: [] });
});

test('NASA failures, rejections and missing backends get distinct kinds', async () => {
  const cases = [
    [() => json({ detail: { error: 'nasa_power_unavailable', kind: 'http', message: 'HTTP 503' } }, 502), 'nasa'],
    [() => json({ detail: { error: 'nasa_power_unavailable', kind: 'timeout', message: 'slow' } }, 504), 'timeout'],
    [() => json({ detail: { error: 'weather_unfit', suggestions: [2014] } }, 409), 'rejected'],
    [() => json({ detail: 'Not Found' }, 404), 'no-backend'],
    [() => html(200), 'no-backend'],
    [() => json({ detail: 'boom' }, 500), 'server'],
  ];
  for (const [handler, kind] of cases) {
    const { c } = client(handler);
    await assert.rejects(c.getConfig(), (e) => e instanceof D.DataError && e.kind === kind, kind);
  }
  const { c } = client(() => json({ detail: { error: 'weather_unfit', suggestions: [2014] } }, 409));
  await assert.rejects(c.start({}), (e) => e.detail.suggestions[0] === 2014);
});

test('a network error is retried once, then reported', async () => {
  let n = 0;
  const flaky = client(() => { n++; if (n === 1) throw new TypeError('fetch failed'); return json({ ok: 1 }); });
  assert.deepEqual(await flaky.c.getConfig(), { ok: 1 });
  assert.equal(flaky.calls.length, 2);
  const down = client(() => { throw new TypeError('fetch failed'); });
  await assert.rejects(down.c.getConfig(), (e) => e.kind === 'server');
  assert.equal(down.calls.length, 2);
});

test('offline and no-backend are detected before any request', async () => {
  const off = client(() => json({}), { isOnline: () => false });
  await assert.rejects(off.c.getConfig(), (e) => e.kind === 'offline');
  assert.equal(off.calls.length, 0);
  const file = client(() => json({}), { apiBase: null });
  await assert.rejects(file.c.getConfig(), (e) => e.kind === 'no-backend');
});

test('a hanging request times out', async () => {
  const hang = D.createClient({ apiBase: '', sleep: noSleep, isOnline: () => true,
    fetch: (url, init) => new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })))) });
  const original = D.TIMEOUTS.config;
  D.TIMEOUTS.config = 30;
  try { await assert.rejects(hang.getConfig(), (e) => e.kind === 'timeout'); } finally { D.TIMEOUTS.config = original; }
});

test('coordinates and growing periods are validated like on the server', () => {
  assert.ok(D.validCoordinates('43.6', '77'));
  assert.ok(!D.validCoordinates('95', '77'));
  assert.ok(!D.validCoordinates('', '77'));
  assert.deepEqual(D.checkPeriod('05-01', '08-31', 60, 240), { ok: true, reason: null, days: 123, crossesYear: false });
  assert.equal(D.checkPeriod('11-01', '03-31', 60, 240).crossesYear, true);
  assert.equal(D.checkPeriod('11-01', '03-31', 60, 240).days, 151);
  assert.equal(D.checkPeriod('05-01', '05-01', 60, 240).reason, 'empty');
  assert.equal(D.checkPeriod('05-01', '05-20', 60, 240).reason, 'short');
  assert.equal(D.checkPeriod('01-01', '12-31', 60, 240).reason, 'long');
  assert.equal(D.checkPeriod('02-29', '06-30', 60, 240).reason, 'invalid');
});
