import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createClient, DataError, validCoordinates, FRESH_MS } = require('../js/nasa-client.js');
const FIXTURES = require('./fixtures/power-seasons.json');

const KANSAS = FIXTURES['Salina, Kansas, USA'];
const LOC = { latitude: KANSAS.latitude, longitude: KANSAS.longitude };

function memoryStorage() {
  const m = new Map();
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k), map: m };
}
const json = (body, status = 200) => ({ ok: status >= 200 && status < 300, status, headers: { get: () => 'application/json' },
  json: async () => body });

function setup({ responses = [], online = true, apiBase = '', startTime = 1_000_000 } = {}) {
  const calls = [];
  let time = startTime;
  const storage = memoryStorage();
  const fetch = async (url) => {
    calls.push(url);
    const next = responses.shift();
    if (next instanceof Error) throw next;
    return next;
  };
  const client = createClient({ fetch, storage, apiBase, now: () => time, isOnline: () => online });
  return { client, calls, storage, advance: (ms) => { time += ms; } };
}

test('live from the server, then served from the browser cache', async () => {
  const { client, calls, advance } = setup({ responses: [json({ ...KANSAS, status: 'live' })] });
  const first = await client.loadClimate(LOC);
  assert.equal(first.status, 'live');
  assert.match(calls[0], /\/api\/nasa\/climate\?latitude=38\.84&longitude=-97\.61$/);
  advance(1000);
  const second = await client.loadClimate(LOC);
  assert.equal(second.status, 'cached');
  assert.equal(second.origin, 'browser');
  assert.equal(calls.length, 1);
});

test('server-side cache hits are reported as cached', async () => {
  const { client } = setup({ responses: [json({ ...KANSAS, status: 'cached' })] });
  assert.equal((await client.loadClimate(LOC)).status, 'cached');
});

test('old copies are refreshed; if the refresh fails the stale copy is used', async () => {
  const { client, calls, advance } = setup({ responses: [json({ ...KANSAS, status: 'live' }), json({ detail: {} }, 504)] });
  await client.loadClimate(LOC);
  advance(FRESH_MS + 1);
  const res = await client.loadClimate(LOC);
  assert.equal(calls.length, 2);
  assert.equal(res.status, 'cached');
  assert.equal(res.stale, true);
  assert.equal(res.error.kind, 'timeout');
});

test('errors are typed: timeout, NASA failure, missing backend, offline', async () => {
  const cases = [
    [Object.assign(new Error('aborted'), { name: 'AbortError' }), 'timeout'],
    [json({}, 504), 'timeout'],
    [json({}, 502), 'nasa'],
    [json({}, 404), 'no-backend'],
    [json({}, 500), 'server'],
    [{ ok: true, status: 200, headers: { get: () => 'text/html' }, json: async () => ({}) }, 'no-backend'],
    [json({ seasons: [] }), 'invalid'],
  ];
  for (const [response, kind] of cases) {
    const { client } = setup({ responses: [response] });
    await assert.rejects(client.loadClimate(LOC), (e) => e instanceof DataError && e.kind === kind, kind);
  }
  const offline = setup({ online: false });
  await assert.rejects(offline.client.loadClimate(LOC), (e) => e.kind === 'offline');
  assert.equal(offline.calls.length, 0);
  const file = setup({ apiBase: null });
  await assert.rejects(file.client.loadClimate(LOC), (e) => e.kind === 'no-backend');
});

test('offline with a saved copy still plays, marked as cached', async () => {
  const { client, storage } = setup({ online: false });
  client.writeCache(LOC.latitude, LOC.longitude, { ...KANSAS, status: 'live' });
  const res = await client.loadClimate(LOC, { force: true });
  assert.equal(res.status, 'cached');
  assert.equal(res.stale, true);
  assert.ok(storage.map.size === 1);
});

test('corrupted cache entries are removed', async () => {
  const { client, storage } = setup({ online: false });
  storage.setItem(client.cacheKey(LOC.latitude, LOC.longitude), '{"savedAt":1,"data":{"seasons":"nope"}}');
  await assert.rejects(client.loadClimate(LOC), (e) => e.kind === 'offline');
  assert.equal(storage.map.size, 0);
});

test('geocoding goes through the backend', async () => {
  const { client, calls } = setup({ responses: [json({ results: [{ name: 'Almaty', latitude: 43.25, longitude: 76.91 }, { name: 'bad' }] })] });
  const places = await client.geocode('Алматы', 'ru');
  assert.equal(places.length, 1);
  assert.match(calls[0], /\/api\/geocode\?q=%D0%90.+&lang=ru$/);
});

test('coordinate validation', () => {
  assert.ok(validCoordinates('43.2', '76.9'));
  assert.ok(!validCoordinates('', '76.9'));
  assert.ok(!validCoordinates('91', '0'));
  assert.ok(!validCoordinates('10', '181'));
  assert.ok(!validCoordinates('abc', '1'));
});
