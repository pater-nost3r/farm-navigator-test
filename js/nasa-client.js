/* =========================================================
   Farm Navigator API client (browser)
   The game never calls NASA directly: the server (/api/nasa/archive)
   downloads NASA POWER, caches it and labels every response:
     live   — fetched from NASA POWER for this request
     cached — from the server cache (stale = expired copy used because POWER failed)
     demo   — synthetic weather, only when the player chooses Demo
   Every game request is idempotent (the server replays all decisions),
   so a request that failed on the network is retried once.
   ========================================================= */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.FarmData = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const TIMEOUTS = { config: 15000, archive: 45000, game: 45000, geocode: 10000 };
  const RETRY_DELAY_MS = 700;
  /** Where `uvicorn app.main:app` listens in local development. */
  const LOCAL_API_PORT = '8000';

  /** kinds: offline | timeout | nasa | server | no-backend | invalid | rejected */
  class DataError extends Error {
    /** @param {string} kind @param {string} message @param {number} [status] @param {any} [detail] @param {string} [url] */
    constructor(kind, message, status, detail, url) {
      super(message);
      this.name = 'DataError';
      this.kind = kind;
      this.status = status;
      this.detail = detail;
      this.url = url;
    }
  }

  /**
   * @param {{fetch?: typeof fetch, apiBase?: string|null|string[], isOnline?: () => boolean, sleep?: (ms:number)=>Promise<void>}} [options]
   *   apiBase: '' = same origin, null = no backend (page opened from a file),
   *   a list = candidates tried in order until one answers like the game API
   */
  function createClient(options = {}) {
    const fetchFn = options.fetch || (typeof fetch === 'function' ? fetch.bind(globalThis) : null);
    const given = options.apiBase === undefined ? defaultApiBases() : options.apiBase;
    /** @type {string[]} */
    const candidates = given === null ? [] : Array.isArray(given) ? given : [given];
    let apiBase = candidates.length ? candidates[0] : null;
    const isOnline = options.isOnline || (() => typeof navigator === 'undefined' || navigator.onLine !== false);
    const sleep = options.sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));

    async function once(path, init, timeoutMs) {
      if (apiBase === null) throw new DataError('no-backend', 'no backend available');
      if (!fetchFn) throw new DataError('no-backend', 'fetch is not available');
      if (!isOnline()) throw new DataError('offline', 'offline');
      const ctrl = typeof AbortController === 'function' ? new AbortController() : null;
      const timer = setTimeout(() => ctrl && ctrl.abort(), timeoutMs);
      const url = apiBase + path;
      let res;
      try {
        res = await fetchFn(url, { ...init, signal: ctrl ? ctrl.signal : undefined });
      } catch (e) {
        if (e && e.name === 'AbortError') throw new DataError('timeout', 'request timed out', undefined, undefined, url);
        throw new DataError(isOnline() ? 'server' : 'offline', 'network error', undefined, undefined, url);
      } finally {
        clearTimeout(timer);
      }
      const type = (res.headers && res.headers.get && res.headers.get('content-type')) || '';
      let body = null;
      if (type.includes('json')) {
        try { body = await res.json(); } catch (e) { throw new DataError('invalid', 'invalid JSON', res.status); }
      }
      if (!res.ok) {
        const detail = body && body.detail;
        if (detail && typeof detail === 'object' && detail.error === 'nasa_power_unavailable') {
          throw new DataError(res.status === 504 ? 'timeout' : 'nasa', detail.message || `HTTP ${res.status}`, res.status, detail);
        }
        if (res.status >= 400 && res.status < 500 && res.status !== 404 && res.status !== 405) {
          throw new DataError('rejected', `HTTP ${res.status}`, res.status, detail);
        }
        throw new DataError(res.status === 404 || res.status === 405 ? 'no-backend' : 'server', `HTTP ${res.status}`, res.status, detail, url);
      }
      // A static host without the API answers /api/... with an HTML page.
      if (!body) throw new DataError('no-backend', 'the server did not return JSON', res.status, undefined, url);
      return body;
    }

    /** Until one candidate answers like the game API, tries the next one when the current one has no API. */
    let located = candidates.length <= 1;
    async function locate(path, init, timeoutMs) {
      if (located) return once(path, init, timeoutMs);
      /** @type {DataError|null} */
      let first = null;
      for (let i = 0; i < candidates.length; i++) {
        apiBase = candidates[i];
        try {
          const body = await once(path, init, timeoutMs);
          located = true;
          return body;
        } catch (e) {
          const noApi = e instanceof DataError && (e.kind === 'no-backend' || (e.kind === 'server' && !e.status));
          if (!noApi) { located = true; throw e; }
          first = first || e;
        }
      }
      apiBase = candidates[0];
      // No candidate has the API: the game server is not running. Report the first (preferred) address.
      throw new DataError('no-backend', 'the game API is not running', first && first.status, undefined, first ? first.url : undefined);
    }

    async function request(path, init, timeoutMs) {
      try {
        return await locate(path, init, timeoutMs);
      } catch (e) {
        if (!(e instanceof DataError) || e.kind !== 'server' || e.status) throw e;
        await sleep(RETRY_DELAY_MS); // network hiccup: every call is idempotent, try once more
        return once(path, init, timeoutMs);
      }
    }

    const get = (path, t) => request(path, { headers: { Accept: 'application/json' } }, t);
    const post = (path, body, t) => request(path, {
      method: 'POST', headers: { Accept: 'application/json', 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    }, t);

    function query(params) {
      return Object.keys(params).map((k) => `${encodeURIComponent(k)}=${encodeURIComponent(params[k])}`).join('&');
    }

    return {
      get apiBase() { return apiBase; },
      getConfig: () => get('/api/game/config', TIMEOUTS.config),
      /** @param {{latitude:number, longitude:number, start_md:string, end_md:string, demo?:boolean}} farm */
      loadArchive: (farm) => get(`/api/nasa/archive?${query({ latitude: farm.latitude, longitude: farm.longitude,
        start_md: farm.start_md, end_md: farm.end_md, demo: !!farm.demo })}`, TIMEOUTS.archive),
      start: (body) => post('/api/game/start', body, TIMEOUTS.game),
      turn: (body) => post('/api/game/turn', body, TIMEOUTS.game),
      whatIf: (body) => post('/api/game/what-if', body, TIMEOUTS.game),
      geocode: async (q, lang) => {
        const body = await get(`/api/geocode?${query({ q, lang })}`, TIMEOUTS.geocode);
        if (!body || !Array.isArray(body.results)) throw new DataError('invalid', 'unexpected geocoding data');
        return body.results.filter((p) => p && typeof p.latitude === 'number' && typeof p.longitude === 'number');
      },
    };
  }

  /**
   * Where the game API may be, in order:
   * - window.FARM_API_BASE or <meta name="farm-api-base" content="https://…"> when set;
   * - for a page on a local static dev server (VS Code Live Server :5500, Vite :5173…): uvicorn on the same host at
   *   :8000 first, then the page's own origin (in case uvicorn itself serves the page on another port);
   * - otherwise the page's own origin (uvicorn serves the page and the API; on Vercel /api goes to the function).
   * Opened from a file there is no backend.
   * @returns {string[]|null}
   */
  function defaultApiBases() {
    const g = /** @type {any} */ (globalThis);
    const meta = typeof document !== 'undefined' && document.querySelector
      ? document.querySelector('meta[name="farm-api-base"]') : null;
    const configured = typeof g.FARM_API_BASE === 'string' ? g.FARM_API_BASE : meta && meta.getAttribute('content');
    if (configured) return [configured.replace(/\/$/, '')];
    if (typeof location === 'undefined' || location.protocol === 'file:') return null;
    if (/^(localhost|127\.0\.0\.1|\[::1\])$/.test(location.hostname) && location.port !== LOCAL_API_PORT) {
      return [`${location.protocol}//${location.hostname}:${LOCAL_API_PORT}`, ''];
    }
    return [''];
  }

  /** @param {unknown} lat @param {unknown} lon */
  function validCoordinates(lat, lon) {
    const la = Number(lat), lo = Number(lon);
    return lat !== '' && lon !== '' && lat !== null && lon !== null && Number.isFinite(la) && Number.isFinite(lo)
      && la >= -90 && la <= 90 && lo >= -180 && lo <= 180;
  }

  const DAYS_IN_MONTH = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

  /** 'MM-DD' → day of a non-leap year (1–365), or null. 29 February is not allowed (not every year has it). */
  function dayOfYear(md) {
    const m = /^(\d{2})-(\d{2})$/.exec(String(md));
    if (!m) return null;
    const month = Number(m[1]), day = Number(m[2]);
    if (month < 1 || month > 12 || day < 1 || day > DAYS_IN_MONTH[month - 1]) return null;
    return DAYS_IN_MONTH.slice(0, month - 1).reduce((a, b) => a + b, 0) + day;
  }

  /** Same rule as the server: a non-empty window between min and max days; it may cross the new year. */
  function checkPeriod(startMd, endMd, minDays, maxDays) {
    const a = dayOfYear(startMd), b = dayOfYear(endMd);
    if (a === null || b === null) return { ok: false, reason: 'invalid', days: 0 };
    if (a === b) return { ok: false, reason: 'empty', days: 0 };
    const days = b > a ? b - a + 1 : 365 - a + b + 1;
    if (days < minDays) return { ok: false, reason: 'short', days };
    if (days > maxDays) return { ok: false, reason: 'long', days };
    return { ok: true, reason: null, days, crossesYear: b < a };
  }

  return { createClient, DataError, validCoordinates, dayOfYear, checkPeriod, TIMEOUTS };
});
