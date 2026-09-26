/* =========================================================
   NASA POWER data client (browser)
   The game never calls NASA directly: it asks our backend
   (/api/nasa/climate), which calls NASA POWER and caches results.
   Statuses shown to the player:
     live   — fetched from NASA POWER for this request
     cached — from the server cache or this browser's saved copy
     demo   — illustrative values, chosen by the player when no data is available
   ========================================================= */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.FarmData = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const CACHE_PREFIX = 'farm-navigator.climate.v1:';
  const FRESH_MS = 7 * 24 * 3600 * 1000;   // use the saved copy without asking the server for a week
  const MAX_AGE_MS = 365 * 24 * 3600 * 1000; // older copies are dropped
  const CLIMATE_TIMEOUT_MS = 30000;
  const GEOCODE_TIMEOUT_MS = 10000;

  /** kinds: offline | timeout | nasa | server | no-backend | invalid */
  class DataError extends Error {
    /** @param {string} kind @param {string} message @param {number} [status] */
    constructor(kind, message, status) {
      super(message);
      this.name = 'DataError';
      this.kind = kind;
      this.status = status;
    }
  }

  /** Minimal shape check so a corrupted cache or proxy page never reaches the game. */
  function isClimate(data) {
    if (!data || typeof data !== 'object' || !Array.isArray(data.seasons) || data.seasons.length < 5) return false;
    const numbers = ['temperature_c', 'rainfall_mm', 'humidity_percent', 'wind_speed_m_s', 'solar_radiation_mj_m2_day', 'heavy_rain_days', 'days'];
    const ok = (o, keys) => o && keys.every((k) => typeof o[k] === 'number' && Number.isFinite(o[k]));
    return data.seasons.every((s) => ok(s, numbers) && typeof s.year === 'number')
      && ok(data.baseline, numbers.filter((k) => k !== 'days'));
  }

  /**
   * @param {{fetch?: typeof fetch, storage?: Storage|null, apiBase?: string|null, now?: () => number,
   *   isOnline?: () => boolean}} [options]
   *   apiBase: '' = same origin, null = no backend (page opened from a file)
   */
  function createClient(options = {}) {
    const fetchFn = options.fetch || (typeof fetch === 'function' ? fetch.bind(globalThis) : null);
    const storage = options.storage === undefined ? safeLocalStorage() : options.storage;
    const apiBase = options.apiBase === undefined ? defaultApiBase() : options.apiBase;
    const now = options.now || (() => Date.now());
    const isOnline = options.isOnline || (() => typeof navigator === 'undefined' || navigator.onLine !== false);

    const key = (lat, lon) => `${CACHE_PREFIX}${Number(lat).toFixed(2)},${Number(lon).toFixed(2)}`;

    function readCache(lat, lon) {
      if (!storage) return null;
      try {
        const raw = storage.getItem(key(lat, lon));
        if (!raw) return null;
        const entry = JSON.parse(raw);
        if (!entry || typeof entry.savedAt !== 'number' || !isClimate(entry.data) || now() - entry.savedAt > MAX_AGE_MS) {
          storage.removeItem(key(lat, lon));
          return null;
        }
        return entry;
      } catch (e) {
        return null;
      }
    }

    function writeCache(lat, lon, data) {
      if (!storage) return;
      try { storage.setItem(key(lat, lon), JSON.stringify({ savedAt: now(), data })); } catch (e) { /* storage full or blocked */ }
    }

    async function getJson(url, timeoutMs) {
      if (!fetchFn) throw new DataError('no-backend', 'fetch is not available');
      const ctrl = typeof AbortController === 'function' ? new AbortController() : null;
      const timer = setTimeout(() => ctrl && ctrl.abort(), timeoutMs);
      let res;
      try {
        res = await fetchFn(url, { signal: ctrl ? ctrl.signal : undefined, headers: { Accept: 'application/json' } });
      } catch (e) {
        if (e && e.name === 'AbortError') throw new DataError('timeout', 'request timed out');
        throw new DataError(isOnline() ? 'server' : 'offline', 'network error');
      } finally {
        clearTimeout(timer);
      }
      const type = (res.headers && res.headers.get && res.headers.get('content-type')) || '';
      if (!res.ok) {
        const kind = res.status === 504 ? 'timeout' : res.status === 502 ? 'nasa' : res.status === 404 || res.status === 405 ? 'no-backend' : 'server';
        throw new DataError(kind, `HTTP ${res.status}`, res.status);
      }
      // A static host without the API answers /api/... with an HTML page.
      if (type && !type.includes('json')) throw new DataError('no-backend', 'the server did not return JSON');
      try { return await res.json(); } catch (e) { throw new DataError('invalid', 'invalid JSON'); }
    }

    /**
     * @param {{latitude:number, longitude:number}} loc
     * @param {{force?: boolean}} [opts] force = skip the fresh browser copy and ask the server
     */
    async function loadClimate(loc, opts = {}) {
      const cached = readCache(loc.latitude, loc.longitude);
      if (cached && !opts.force && now() - cached.savedAt < FRESH_MS) {
        return { status: 'cached', origin: 'browser', data: cached.data, savedAt: cached.savedAt, stale: false };
      }
      const fallback = (error) => {
        if (cached) return { status: 'cached', origin: 'browser', data: cached.data, savedAt: cached.savedAt, stale: true, error };
        throw error;
      };
      if (apiBase === null) return fallback(new DataError('no-backend', 'no backend available'));
      if (!isOnline()) return fallback(new DataError('offline', 'offline'));
      try {
        const q = `latitude=${encodeURIComponent(loc.latitude)}&longitude=${encodeURIComponent(loc.longitude)}`;
        const body = await getJson(`${apiBase}/api/nasa/climate?${q}`, CLIMATE_TIMEOUT_MS);
        if (!isClimate(body) || body.is_demo) throw new DataError('invalid', 'unexpected climate data');
        writeCache(loc.latitude, loc.longitude, body);
        return { status: body.status === 'cached' ? 'cached' : 'live', origin: 'server', data: body, savedAt: now(), stale: false };
      } catch (e) {
        return fallback(e instanceof DataError ? e : new DataError('server', String(e)));
      }
    }

    /** @param {string} query @param {string} lang */
    async function geocode(query, lang) {
      if (apiBase === null) throw new DataError('no-backend', 'no backend available');
      if (!isOnline()) throw new DataError('offline', 'offline');
      const body = await getJson(`${apiBase}/api/geocode?q=${encodeURIComponent(query)}&lang=${encodeURIComponent(lang)}`, GEOCODE_TIMEOUT_MS);
      if (!body || !Array.isArray(body.results)) throw new DataError('invalid', 'unexpected geocoding data');
      return body.results.filter((p) => p && typeof p.latitude === 'number' && typeof p.longitude === 'number');
    }

    return { loadClimate, geocode, readCache, writeCache, cacheKey: key, apiBase };
  }

  function safeLocalStorage() {
    try { return typeof localStorage !== 'undefined' ? localStorage : null; } catch (e) { return null; }
  }

  /** Same origin when served over http(s); no backend when opened from a file. Override with window.FARM_API_BASE. */
  function defaultApiBase() {
    const g = /** @type {any} */ (globalThis);
    if (typeof g.FARM_API_BASE === 'string') return g.FARM_API_BASE.replace(/\/$/, '');
    if (typeof location === 'undefined' || location.protocol === 'file:') return null;
    return '';
  }

  /** @param {unknown} lat @param {unknown} lon */
  function validCoordinates(lat, lon) {
    const la = Number(lat), lo = Number(lon);
    return lat !== '' && lon !== '' && lat !== null && lon !== null && Number.isFinite(la) && Number.isFinite(lo)
      && la >= -90 && la <= 90 && lo >= -180 && lo <= 180;
  }

  return { createClient, DataError, isClimate, validCoordinates, CACHE_PREFIX, FRESH_MS };
});
