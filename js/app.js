/* =========================================================
   Farm Navigator — UI controller
   The game is simulated on the server (FastAPI, app/services/engine.py)
   from NASA POWER daily data. This file renders what the server returns,
   checks the plan with the same rules before sending it (js/rules.js),
   and wires up the controls. Language/theme: the inline FarmPrefs.
   ========================================================= */
(function () {
'use strict';

const R = FarmRules;
const client = FarmData.createClient();

/* =========================================================
   I18N
   ========================================================= */
const I18N = {
  en: JSON.parse(document.getElementById('i18n-en').textContent),
  ru: JSON.parse(document.getElementById('i18n-ru').textContent),
};
let LANG = FarmPrefs.get().resolvedLanguage;
function t(key, vars){
  let s = I18N[LANG] && I18N[LANG][key];
  if(s == null){ s = I18N.en[key]; console.warn(`[i18n] missing "${key}" for "${LANG}"`); }
  if(s == null){ console.error(`[i18n] unknown key "${key}"`); return key; }
  return vars ? s.replace(/\{\{(\w+)\}\}/g, (m,k)=> k in vars ? vars[k] : m) : s;
}
const has = key => I18N.en[key] != null;
const locale = ()=> LANG==='ru' ? 'ru-RU' : 'en-US';
const num = (n, d=0) => Number(n).toLocaleString(locale(), { minimumFractionDigits:d, maximumFractionDigits:d });
const dec = (n, d=2) => num(n, d);
const dec1 = n => Number(n).toLocaleString(locale(), { maximumFractionDigits:1 });
const signed = (n, f=num) => n>0 ? '+'+f(n) : n<0 ? '−'+f(Math.abs(n)) : '±0';
function applyStaticI18n(root=document){
  root.querySelectorAll('[data-i18n]').forEach(n=>{ n.textContent = t(n.dataset.i18n); });
  // Only for our own translation strings that contain <strong>/<br> markup
  root.querySelectorAll('[data-i18n-html]').forEach(n=>{ n.innerHTML = t(n.dataset.i18nHtml); });
  root.querySelectorAll('[data-i18n-attr]').forEach(n=>{
    n.dataset.i18nAttr.split(';').forEach(pair=>{ const [attr,key]=pair.split(':'); n.setAttribute(attr.trim(), t(key.trim())); });
  });
  if(root===document){
    document.title = t('meta.title');
    document.querySelector('meta[name="description"]').setAttribute('content', t('meta.description'));
  }
}
function esc(s){ return String(s).replace(/[&<>"']/g, c=>({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c])); }
function fmtDate(iso, withYear=true){
  if(!iso) return '';
  const d = new Date(iso.length<=10 ? iso+'T00:00:00' : iso);
  return isNaN(d.getTime()) ? iso : d.toLocaleDateString(locale(), withYear ? { day:'numeric', month:'short', year:'numeric' } : { day:'numeric', month:'short' });
}
function fmtDateTime(iso){
  const d = new Date(iso);
  return isNaN(d.getTime()) ? String(iso) : d.toLocaleString(locale(), { day:'numeric', month:'short', year:'numeric', hour:'2-digit', minute:'2-digit' });
}

/* =========================================================
   SAVED STATE (localStorage, all access guarded)
   ========================================================= */
const KEYS = { progress:'farm-navigator.progress.v2', farm:'farm-navigator.farm.v2', tutorial:'farm-navigator.tutorial.v1' };
function readJSON(key){ try{ const v = localStorage.getItem(key); return v ? JSON.parse(v) : null; }catch(e){ return null; } }
function writeJSON(key, v){ try{ localStorage.setItem(key, JSON.stringify(v)); }catch(e){ /* private mode or full */ } }
const SOILS = ['sandy','loam','clay'];
function readFarm(){
  const f = readJSON(KEYS.farm);
  if(!f || !FarmData.validCoordinates(f.latitude, f.longitude) || !SOILS.includes(f.soil)) return null;
  if(FarmData.dayOfYear(f.start_md)===null || FarmData.dayOfYear(f.end_md)===null) return null;
  return f;
}

/* =========================================================
   ICONS
   ========================================================= */
const P = (d, extra='') => `<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" ${extra}>${d}</svg>`;
const IC = {
  check: P('<path d="M5 12.5l4.5 4.5L19 7.5"/>'),
  help: P('<circle cx="12" cy="12" r="9"/><path d="M9.5 9.3a2.6 2.6 0 015 1c0 1.8-2.5 2.2-2.5 3.7"/><circle cx="12" cy="17.2" r=".6" fill="currentColor"/>'),
  pause: P('<rect x="6.5" y="5" width="3.6" height="14" rx="1.2"/><rect x="13.9" y="5" width="3.6" height="14" rx="1.2"/>'),
  play: P('<path d="M8 5.5v13l10.5-6.5z" fill="currentColor"/>'),
  refresh: P('<path d="M20 11a8 8 0 00-14.3-4.6L4 8"/><path d="M4 4v4h4"/><path d="M4 13a8 8 0 0014.3 4.6L20 16"/><path d="M20 20v-4h-4"/>'),
  map: P('<path d="M9 4L3 6.5v13L9 17l6 2.5 6-2.5v-13L15 6.5z"/><path d="M9 4v13M15 6.5v13"/>'),
  flag: P('<path d="M5 21V4"/><path d="M5 4h11l-2 4 2 4H5" fill="currentColor"/>'),
  sprout: P('<path d="M12 21v-9"/><path d="M12 12c0-4 3-6.5 7.5-6.5 0 4.2-3 6.5-7.5 6.5z"/><path d="M12 14.5C12 11 9.5 9 5 9c0 3.6 2.6 5.5 7 5.5z"/>'),
  leaf: P('<path d="M5 19c0-8 5-13.5 15-14-0.5 10-6 15-14 15"/><path d="M5 19l7-7"/>'),
  soil: P('<path d="M3 9h18M3 14h18M3 19h18"/><path d="M8 9V5M12 9V3.5M16 9V5"/>'),
  drop: P('<path d="M12 3.5s6.5 7 6.5 11.2A6.5 6.5 0 015.5 14.7C5.5 10.5 12 3.5 12 3.5z"/>'),
  dropFill: '<svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M12 2.5s7 7.4 7 12a7 7 0 01-14 0c0-4.6 7-12 7-12z"/></svg>',
  coin: P('<circle cx="12" cy="12" r="8.5"/><path d="M14.8 9.2c-.5-.9-1.6-1.4-2.8-1.4-1.6 0-2.8.8-2.8 2.1 0 2.9 5.8 1.6 5.8 4.3 0 1.3-1.3 2.1-3 2.1-1.3 0-2.4-.5-2.9-1.5M12 6.3v1.5M12 16.3v1.4"/>'),
  globe: P('<circle cx="12" cy="12" r="8.5"/><path d="M3.5 12h17M12 3.5c2.6 2.7 3.6 5.5 3.6 8.5s-1 5.8-3.6 8.5c-2.6-2.7-3.6-5.5-3.6-8.5s1-5.8 3.6-8.5z"/>'),
  recycle: P('<path d="M7.5 10.5L5 15h6"/><path d="M9.5 6.8l2-3.3 3.6 6"/><path d="M16 16.8h4.6l-3.1-5.4"/><path d="M5 15l2.6 4.5h5.2M11.5 3.5L9 7.8M20.6 16.8l-2.5 2.7"/>'),
  thermo: P('<path d="M14 14.8V5a2 2 0 00-4 0v9.8a4 4 0 104 0z"/><path d="M12 9v7.5"/>'),
  rain: P('<path d="M7 15a4.5 4.5 0 01.6-9A5.5 5.5 0 0118 7.5a3.8 3.8 0 01-.5 7.5H7z"/><path d="M8.5 18l-1 2.5M12.5 18l-1 2.5M16.5 18l-1 2.5"/>'),
  sun: P('<circle cx="12" cy="12" r="4.2"/><path d="M12 2.5v2.2M12 19.3v2.2M2.5 12h2.2M19.3 12h2.2M5.3 5.3l1.6 1.6M17.1 17.1l1.6 1.6M5.3 18.7l1.6-1.6M17.1 6.9l1.6-1.6"/>'),
  moon: P('<path d="M19.5 14.5A8 8 0 019.5 4.5a8 8 0 1010 10z"/>'),
  monitor: P('<rect x="3" y="4" width="18" height="12.5" rx="2"/><path d="M8.5 20.5h7M12 16.5v4"/>'),
  chevron: P('<path d="M6.5 9.5l5.5 5.5 5.5-5.5"/>'),
  menu: P('<path d="M4.5 7h15M4.5 12h15M4.5 17h15"/>'),
  cloud: P('<path d="M7 18a4.5 4.5 0 01.6-9A5.5 5.5 0 0118 10.5a3.8 3.8 0 01-.5 7.5H7z"/>'),
  heat: P('<circle cx="12" cy="9" r="3.6"/><path d="M12 2.5v1.6M5.8 5l1.1 1.1M18.2 5l-1.1 1.1M3.5 11h1.6M18.9 11h1.6"/><path d="M4 16c1.5-1.2 3-1.2 4.5 0s3 1.2 4.5 0 3-1.2 4.5 0M4 20c1.5-1.2 3-1.2 4.5 0s3 1.2 4.5 0 3-1.2 4.5 0"/>'),
  ndvi: P('<rect x="3.5" y="3.5" width="7" height="7" rx="1.5"/><rect x="13.5" y="3.5" width="7" height="7" rx="1.5" fill="currentColor"/><rect x="3.5" y="13.5" width="7" height="7" rx="1.5" fill="currentColor"/><rect x="13.5" y="13.5" width="7" height="7" rx="1.5"/>'),
  satellite: P('<rect x="9.2" y="9.2" width="5.6" height="5.6" rx="1" transform="rotate(45 12 12)"/><path d="M6.5 6.5L3.5 3.5M4 9l5-5M17.5 17.5l3 3M15 20l5-5"/><path d="M15.5 8.5l2-2"/>'),
  'satellite-white': '<svg viewBox="0 0 40 40" width="36" height="36" aria-hidden="true"><circle cx="20" cy="20" r="19" fill="rgba(255,255,255,.14)"/><g transform="rotate(-30 20 20)"><rect x="16" y="15" width="8" height="10" rx="2" fill="#fff"/><rect x="5" y="16.5" width="9" height="7" rx="1" fill="#8FC1FF"/><rect x="26" y="16.5" width="9" height="7" rx="1" fill="#8FC1FF"/><path d="M14 20h2M24 20h2" stroke="#fff" stroke-width="1.6"/><path d="M20 25v4" stroke="#fff" stroke-width="1.6"/><circle cx="20" cy="30" r="1.8" fill="#FFD35C"/></g></svg>',
  'satellite-color': '<svg viewBox="0 0 40 40" aria-hidden="true"><g transform="rotate(20 20 20)"><rect x="15.5" y="14" width="9" height="12" rx="2.2" fill="#0B3D91"/><rect x="3" y="16" width="11" height="8" rx="1.2" fill="#1E6FD9"/><path d="M6.5 16v8M10 16v8" stroke="#8FC1FF" stroke-width="1"/><rect x="26" y="16" width="11" height="8" rx="1.2" fill="#1E6FD9"/><path d="M29.5 16v8M33 16v8" stroke="#8FC1FF" stroke-width="1"/><path d="M14 20h1.5M24.5 20h1.5" stroke="#0B3D91" stroke-width="2"/><circle cx="20" cy="29" r="2.2" fill="#FFD35C"/></g></svg>',
  logo: '<svg viewBox="0 0 32 32" width="30" height="30" aria-hidden="true"><circle cx="16" cy="16" r="12.5" fill="none" stroke="#9FD39A" stroke-width="2.4"/><path d="M16 6.5l3.2 9.5L16 25.5 12.8 16z" fill="#fff"/><path d="M16 6.5l3.2 9.5H12.8z" fill="#FFD35C"/><path d="M16 21c0-3.2 2.2-5.2 5.6-5.2 0 3.2-2.3 5.2-5.6 5.2z" fill="#9FD39A"/></svg>',
  alert: P('<path d="M12 3.5L2.8 19.5h18.4z"/><path d="M12 10v4.5"/><circle cx="12" cy="17" r=".6" fill="currentColor"/>'),
  flask: P('<path d="M9.5 3.5h5M10.5 3.5v5.5L5 19a1.5 1.5 0 001.3 2h11.4a1.5 1.5 0 001.3-2l-5.5-10V3.5"/><path d="M7.5 15h9"/>'),
  compost: P('<path d="M4 20c1-5 4-7.5 8-7.5s7 2.5 8 7.5z"/><path d="M9 12.8c.5-3 2-5 5-6.3M12 8.5c-1.5-1.3-3.5-1.6-5.5-1"/>'),
  none: P('<circle cx="12" cy="12" r="8.5"/><path d="M6 18L18 6"/>'),
  legume: P('<path d="M6 17c-1.8-4.5 1-10 7-11.5 3.5-.8 5.5.5 5 2.5-.6 2.2-4.3 1.8-6.5 4.5S9.5 19.5 6 17z"/><circle cx="10.2" cy="13" r="1" fill="currentColor"/><circle cx="13" cy="10" r="1" fill="currentColor"/>'),
  star: P('<path d="M12 3.5l2.6 5.4 5.9.8-4.3 4.1 1 5.8L12 16.9l-5.2 2.7 1-5.8-4.3-4.1 5.9-.8z"/>'),
  trophy: P('<path d="M8 4h8v5a4 4 0 01-8 0z"/><path d="M8 6H4.5c0 3 1.5 4.5 3.7 4.8M16 6h3.5c0 3-1.5 4.5-3.7 4.8M12 13v4M8.5 20.5h7M9.5 17h5v3.5h-5z"/>'),
  x: P('<path d="M6 6l12 12M18 6L6 18"/>'),
  arrow: P('<path d="M5 12h14M13 6l6 6-6 6"/>'),
  grid: P('<rect x="4" y="4" width="6.5" height="6.5" rx="1.5"/><rect x="13.5" y="4" width="6.5" height="6.5" rx="1.5"/><rect x="4" y="13.5" width="6.5" height="6.5" rx="1.5"/><rect x="13.5" y="13.5" width="6.5" height="6.5" rx="1.5"/>'),
  bulb: P('<path d="M9 18h6M10 21h4M12 3a6 6 0 00-3.5 10.9c.6.5 1 1.2 1 2.1h5c0-.9.4-1.6 1-2.1A6 6 0 0012 3z"/>'),
  atom: P('<circle cx="12" cy="12" r="1.6" fill="currentColor"/><ellipse cx="12" cy="12" rx="9" ry="3.8"/><ellipse cx="12" cy="12" rx="9" ry="3.8" transform="rotate(60 12 12)"/><ellipse cx="12" cy="12" rx="9" ry="3.8" transform="rotate(-60 12 12)"/>'),
  farmer: P('<circle cx="12" cy="9" r="3.5"/><path d="M6.5 7.5h11M8 7.5c.4-2.3 2-3.8 4-3.8s3.6 1.5 4 3.8"/><path d="M5 20.5c.8-3.8 3.6-5.8 7-5.8s6.2 2 7 5.8"/>'),
  basket: P('<path d="M3.5 10h17l-2 9.5h-13z"/><path d="M8 10l3-5.5M16 10l-3-5.5M9 13.5v3M12 13.5v3M15 13.5v3"/>'),
};
function hydrateIcons(root=document){ root.querySelectorAll('[data-ic]').forEach(n=>{ if(!n.dataset.done){ n.insertAdjacentHTML('afterbegin', IC[n.dataset.ic]||''); n.dataset.done=1; } }); }
Object.assign(IC, {
  pin: P('<path d="M12 21s-6.5-6.2-6.5-11a6.5 6.5 0 0113 0c0 4.8-6.5 11-6.5 11z"/><circle cx="12" cy="10" r="2.4"/>'),
  search: P('<circle cx="10.5" cy="10.5" r="6"/><path d="M15 15l5 5"/>'),
  lock: P('<rect x="5" y="10.5" width="14" height="10" rx="2"/><path d="M8.5 10.5V7.5a3.5 3.5 0 017 0v3"/>'),
  compare: P('<path d="M7 4v16M17 4v16"/><path d="M3.5 8.5L7 5l3.5 3.5M13.5 15.5L17 19l3.5-3.5"/>'),
  wind: P('<path d="M3 9h11a3 3 0 10-3-3"/><path d="M3 14h15a3 3 0 11-3 3"/>'),
  humid: P('<path d="M8 3.5s4.5 5 4.5 8a4.5 4.5 0 01-9 0c0-3 4.5-8 4.5-8z"/><path d="M17 9s3 3.3 3 5.3a3 3 0 01-6 0c0-2 3-5.3 3-5.3z"/>'),
  shield: P('<path d="M12 3.5l7 3v5.5c0 4.2-3 7.4-7 8.5-4-1.1-7-4.3-7-8.5V6.5z"/><path d="M9 12l2 2 4-4"/>'),
  mulch: P('<path d="M3 18h18"/><path d="M5 18c1-2.5 2.5-3.5 4-3.5M10 18c.8-3 2.5-4.5 4.5-4.5M15 18c.6-2 1.8-3 3.5-3"/><path d="M7 11l2-2M12 10l1.5-2.5M17 11l1.5-1.5"/>'),
});
Object.assign(IC, {
  frost: P('<path d="M12 3v18M4.2 7.5l15.6 9M4.2 16.5l15.6-9"/><path d="M9.5 4.5L12 7l2.5-2.5M9.5 19.5L12 17l2.5 2.5"/>'),
  clock: P('<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/>'),
  flood: P('<path d="M3 14c1.5-1.2 3-1.2 4.5 0s3 1.2 4.5 0 3-1.2 4.5 0 3 1.2 4.5 0M3 18.5c1.5-1.2 3-1.2 4.5 0s3 1.2 4.5 0 3-1.2 4.5 0 3 1.2 4.5 0"/><path d="M12 3.5v6M9.5 7L12 9.5 14.5 7"/>'),
  sprinkler: P('<path d="M12 21v-7"/><path d="M9 14h6"/><path d="M12 10.5c-3-3-6.5-3.5-9-2.5M12 10.5c3-3 6.5-3.5 9-2.5M12 10.5V4"/>'),
  drain: P('<path d="M3 8h18"/><path d="M6 8v5a6 6 0 0012 0V8"/><path d="M12 13v7M9.5 17.5L12 20l2.5-2.5"/>'),
  download: P('<path d="M12 4v11M7.5 10.5L12 15l4.5-4.5"/><path d="M5 19.5h14"/>'),
});
const $ = id => document.getElementById(id);
const fmt$ = n => (n<0?'−$':'$') + num(Math.abs(Math.round(n)));
const clamp = (v,a,b)=>Math.max(a,Math.min(b,v));

/* =========================================================
   CROP ART (SVG, base at 0,0)
   ========================================================= */
const PLANT = {
  wheat:`<ellipse cx="0" cy="1" rx="8" ry="3" fill="rgba(0,0,0,.14)"/>
    <path class="st" d="M0 0C-1-12-3-21-6.5-30"/><path class="st" d="M0 0C0-13 0-24 0-35"/><path class="st" d="M0 0C1-12 3-21 6.5-29"/>
    <path class="lf" d="M0-7Q-10-13-13-7Q-6-8 0-4.5Z"/><path class="lf" d="M0-12Q9-18 12-12Q6-13 0-9.5Z"/>
    <ellipse class="hd" cx="-7.5" cy="-34" rx="2.8" ry="6.2" transform="rotate(-14 -7.5 -34)"/>
    <ellipse class="hd" cx="0" cy="-39.5" rx="3" ry="6.8"/>
    <ellipse class="hd" cx="7.5" cy="-33" rx="2.8" ry="6.2" transform="rotate(14 7.5 -33)"/>`,
  maize:`<ellipse cx="0" cy="1" rx="9" ry="3.2" fill="rgba(0,0,0,.14)"/>
    <rect class="ld" x="-1.8" y="-48" width="3.6" height="48" rx="1.6"/>
    <path class="lf" d="M0-10Q-15-17-19-7Q-10-11 0-7Z"/><path class="lf" d="M0-20Q15-29 20-18Q10-23 0-17Z"/>
    <path class="lf" d="M0-31Q-13-40-17-31Q-8-34 0-28Z"/><path class="lf" d="M0-40Q10-48 14-42Q7-43 0-37Z"/>
    <ellipse class="hd" cx="4" cy="-25" rx="2.8" ry="6.5" transform="rotate(10 4 -25)"/>
    <path d="M0-48l-3.5-6M0-48v-7.5M0-48l3.5-6" stroke="var(--head)" stroke-width="1.6" stroke-linecap="round"/>`,
  sorghum:`<ellipse cx="0" cy="1" rx="8" ry="3" fill="rgba(0,0,0,.14)"/>
    <rect class="ld" x="-1.5" y="-36" width="3" height="36" rx="1.4"/>
    <path class="lf" d="M0-9Q-13-15-16-6Q-8-10 0-6Z"/><path class="lf" d="M0-18Q13-25 16-16Q8-20 0-15Z"/><path class="lf" d="M0-27Q-10-33-13-26Q-6-28 0-24Z"/>
    <ellipse class="hd2" cx="0" cy="-42" rx="5.4" ry="8.4"/>
    <circle cx="-2" cy="-45" r="1.3" fill="rgba(255,255,255,.35)"/><circle cx="2" cy="-40" r="1.3" fill="rgba(255,255,255,.3)"/>`,
  chickpea:`<ellipse cx="0" cy="1" rx="11" ry="3.6" fill="rgba(0,0,0,.14)"/>
    <path class="st" d="M0 0V-9"/>
    <circle class="ld" cx="-7.5" cy="-9" r="7"/><circle class="ld" cx="7" cy="-8" r="6.5"/>
    <circle class="lf" cx="5.5" cy="-12" r="7.5"/><circle class="lf" cx="-4" cy="-14" r="7"/><circle class="lf" cx="1" cy="-19" r="7.2"/>
    <ellipse class="hd" cx="4.5" cy="-14" rx="2.3" ry="1.6"/><ellipse class="hd" cx="-5" cy="-11" rx="2.3" ry="1.6"/><ellipse class="hd" cx="0" cy="-21" rx="2.3" ry="1.6"/>`,
};
function cropIcon(id){
  return `<svg class="art" viewBox="-26 -60 52 64" aria-hidden="true" style="--leaf:#3FA24F;--leaf-dark:#277A38;--head:#D9BE52;--head2:#B8533A">
    <g class="fieldsvg-mini">${PLANT[id].replace(/class="lf"/g,'fill="var(--leaf)"').replace(/class="ld"/g,'fill="var(--leaf-dark)"').replace(/class="hd2"/g,'fill="var(--head2)"').replace(/class="hd"/g,'fill="var(--head)"').replace(/class="st"/g,'stroke="var(--leaf-dark)" fill="none" stroke-width="2" stroke-linecap="round"')}</g></svg>`;
}

/* =========================================================
   FIELD RENDER
   ========================================================= */
const N=6, TW=80, TH=40, OX=300, OY=112;
const tileXY = (i,j)=>[OX+(i-j)*TW/2, OY+(i+j)*TH/2];
let rand = (s=>()=>{s=(s*16807)%2147483647;return s/2147483647})(42);
const tileNoise = [];
function buildField(){
  const svg = $('field');
  let g = '';
  // meadow
  const gT=[300,64], gR=[592,210], gB=[300,356], gL=[8,210];
  g += `<polygon class="grass-side" points="${gL} ${gB} ${gB[0]},${gB[1]+20} ${gL[0]},${gL[1]+20}"/>`;
  g += `<polygon class="grass-side" points="${gB} ${gR} ${gR[0]},${gR[1]+20} ${gB[0]},${gB[1]+20}" style="filter:brightness(.88)"/>`;
  g += `<polygon class="grass" points="${gT} ${gR} ${gB} ${gL}"/>`;
  // decor behind field
  g += barn(470,166) + tank(128,168);
  // tiles
  let tiles='', ndvi='', furrows='', puddles='', cracks='';
  for(let i=0;i<N;i++)for(let j=0;j<N;j++){
    const [x,y]=tileXY(i,j);
    const pts=`${x},${y-TH/2} ${x+TW/2},${y} ${x},${y+TH/2} ${x-TW/2},${y}`;
    tiles += `<polygon class="tile" points="${pts}"/>`;
    const nz = rand()*2-1; tileNoise.push(nz);
    ndvi += `<polygon class="ndvi-tile" data-n="${nz.toFixed(3)}" points="${pts}"/>`;
    furrows += `<path class="furrow" d="M${x-26},${y-5} L${x-2},${y-17} M${x-14},${y+7} L${x+14},${y-7} M${x+2},${y+17} L${x+26},${y+5}"/>`;
    if(rand()<.38){ puddles += `<ellipse class="puddle" cx="${x+rand()*16-8}" cy="${y+rand()*6-3}" rx="${14+rand()*8}" ry="${5+rand()*2.5}"/><ellipse class="puddle-hl" cx="${x-4}" cy="${y-1}" rx="5" ry="1.6"/>`; }
    if(rand()<.55){ const cx=x+rand()*20-10, cy=y+rand()*8-4; cracks += `<path class="crack" d="M${cx-12},${cy} l6,-2 l4,3 l6,-3 l5,2 M${cx-2},${cy+1} l-2,5 M${cx+8},${cy-2} l3,-5"/>`; }
  }
  g += `<g>${tiles}</g><g>${furrows}</g><g>${cracks}</g><g>${puddles}</g><g>${ndvi}</g><g class="plants" id="plants"></g>`;
  // decor in front
  g += tree(78,246) + tree(532,262,.85) + fence();
  // sparkles
  let sp=''; for(let k=0;k<16;k++){ const [x,y]=tileXY(rand()*N,rand()*N); sp += `<path class="spark" style="--d:${(rand()*1.6).toFixed(2)}s" d="M${x},${y-60} l2.5,6 6,2.5 -6,2.5 -2.5,6 -2.5,-6 -6,-2.5 6,-2.5z"/>`; }
  g += `<g>${sp}</g>`;
  svg.innerHTML = g;
  renderPlants();
}
function barn(x,y){
  return `<g transform="translate(${x},${y})">
    <ellipse cx="0" cy="2" rx="34" ry="9" fill="rgba(0,0,0,.12)"/>
    <polygon points="-30,-2 0,12 0,-24 -30,-38" fill="#B5412F"/><polygon points="0,12 26,-1 26,-37 0,-24" fill="#94321F"/>
    <polygon points="-30,-38 -15,-58 12,-45 0,-24" fill="#5A3A2A"/><polygon points="0,-24 12,-45 26,-37" fill="#452C20"/>
    <polygon points="-20,-4 -8,2 -8,-18 -20,-24" fill="#fff" opacity=".9"/><path d="M-20,-24 L-8,2 M-8,-18 L-20,-4" stroke="#B5412F" stroke-width="2"/>
  </g>`;
}
function tank(x,y){
  return `<g transform="translate(${x},${y})" data-i18n-attr="aria-label:field.tank" aria-label="${t('field.tank')}">
    <ellipse cx="0" cy="2" rx="20" ry="6" fill="rgba(0,0,0,.12)"/>
    <rect x="-16" y="-46" width="32" height="46" rx="4" fill="#DCE6EE"/>
    <clipPath id="tclip"><rect x="-13" y="-43" width="26" height="40" rx="3"/></clipPath>
    <rect x="-13" y="-43" width="26" height="40" rx="3" fill="#B9C8D4"/>
    <rect class="tank-water" id="tank-water" clip-path="url(#tclip)" x="-13" y="-43" width="26" height="40" fill="#3B8EDB"/>
    <ellipse cx="0" cy="-46" rx="16" ry="4.5" fill="#EEF3F7"/>
    <path d="M-16,-30h32M-16,-15h32" stroke="#AEBBC6" stroke-width="1.5"/>
  </g>`;
}
function tree(x,y,s=1){
  return `<g transform="translate(${x},${y}) scale(${s})"><ellipse cx="0" cy="2" rx="18" ry="5" fill="rgba(0,0,0,.14)"/><rect x="-3" y="-20" width="6" height="22" rx="2" fill="#6B4428"/>
    <circle cx="-8" cy="-26" r="12" class="ld"/><circle cx="8" cy="-28" r="12" class="ld"/><circle cx="0" cy="-38" r="14" class="lf"/></g>`;
}
function fence(){
  // posts along the front-right edge of the meadow
  let s=''; for(let k=0;k<7;k++){ const t=k/6; const x=320+t*250, y=346-t*125; s+=`<rect x="${x-2}" y="${y-16}" width="4" height="16" rx="1" fill="#A07A52"/>`; }
  return `<g>${s}<path d="M320,338 L570,213 M320,344 L570,219" stroke="#C49A6C" stroke-width="2.5"/></g>`;
}
/** The crop drawn on the field: the one being planned, growing, or last harvested. */
function plantedCrop(){
  if(pending) return pending.outcome.decision.crop;
  if(phase==='plan') return decision.crop;
  if(game && game.results.length) return game.results[game.results.length-1].decision.crop;
  return null;
}
function renderPlants(){
  const crop = plantedCrop();
  if(!crop){ $('plants').innerHTML = ''; return; }
  const pts=[];
  for(let i=0;i<N;i++)for(let j=0;j<N;j++){
    const [x,y]=tileXY(i,j);
    pts.push([x-15,y-6.5],[x+13,y+6.5]);
  }
  pts.sort((a,b)=>a[1]-b[1]);
  let r2 = (s=>()=>{s=(s*16807)%2147483647;return s/2147483647})(7);
  const art = PLANT[crop];
  $('plants').innerHTML = pts.map(([x,y])=>`<g transform="translate(${x.toFixed(1)},${y.toFixed(1)})"><g class="pl" style="--j:${(0.86+r2()*0.26).toFixed(2)}"><g class="sway" style="--d:${(-r2()*4).toFixed(2)}s">${art}</g></g></g>`).join('');
}
function paintNDVI(v){
  document.querySelectorAll('.ndvi-tile').forEach(t=>{
    const n = clamp(v + parseFloat(t.dataset.n)*0.07, 0.05, 0.92);
    t.style.fill = ndviColor(n);
  });
}
function ndviColor(v){
  const stops=[[0.1,[166,115,46]],[0.3,[217,194,87]],[0.5,[156,203,91]],[0.7,[46,139,62]],[0.9,[15,90,42]]];
  if(v<=stops[0][0]) return `rgb(${stops[0][1]})`;
  for(let k=1;k<stops.length;k++){ if(v<=stops[k][0]){ const [a,ca]=stops[k-1],[b,cb]=stops[k]; const t=(v-a)/(b-a); return `rgb(${ca.map((c,i)=>Math.round(c+(cb[i]-c)*t))})`; } }
  return `rgb(${stops[4][1]})`;
}
function setTank(pct){
  const h = 40*pct/100; const w=$('tank-water'); if(!w) return;
  w.setAttribute('y', (-3-h).toFixed(1)); w.setAttribute('height', h.toFixed(1));
}


/* =========================================================
   STATE
   ========================================================= */
const LEVEL_COLORS = ['#3E9B4F','#1E6FD9','#8C5E3C','#D0632A','#2A8FA8','#C9971B','#7A5AA6'];
const LEVEL_ICONS = ['sprout','drop','soil','heat','rain','coin','globe'];
const STATES = {
  planning:     { color:'#6D8A5E', ic:'sprout' },
  growing:      { color:'#3E9B4F', ic:'sprout' },
  healthy:      { color:'#3E9B4F', ic:'leaf' },
  drought:      { color:'#D07A1E', ic:'heat' },
  heatstress:   { color:'#D0632A', ic:'thermo' },
  overwater:    { color:'#1E6FD9', ic:'rain' },
  frost:        { color:'#5A7D8C', ic:'frost' },
  immature:     { color:'#8A9A5B', ic:'clock' },
  lownutrients: { color:'#7A5AA6', ic:'soil' },
  disease:      { color:'#8A6D3B', ic:'alert' },
  harvest:      { color:'#C9971B', ic:'basket' },
  failed:       { color:'#8E2A1F', ic:'x' },
};
const WEATHER_IC = { showers:'rain', heat:'heat', rain:'rain', clear:'sun', cloudy:'cloud' };
const METHOD_UI = { flood:{ ic:'flood', bg:'#6B8FB5' }, sprinkler:{ ic:'sprinkler', bg:'#1E6FD9' }, drip:{ ic:'drop', bg:'#2A8FA8' } };
const CARE_UI = { none:{ ic:'none', bg:'#B7A68A' }, mulch:{ ic:'mulch', bg:'#A07A52' }, cover_crop:{ ic:'legume', bg:'#3E9B4F' },
  min_till:{ ic:'shield', bg:'#6D8A5E' }, drainage:{ ic:'drain', bg:'#5A7D8C' } };
const CATEGORY_ORDER = ['nasa','player','computed','assumption'];

let model = null;         // game rules from GET /api/game/config
let progress = R.emptyProgress();
let farm = readFarm();    // { latitude, longitude, start_md, end_md, soil, place:{...} }
let draft = null;         // farm being edited on the setup screen
let demoMode = false;
let archive = null;       // GET /api/nasa/archive response
let game = null;          // { level, year, decisions, run, season, results, fit, data }
let decision = emptyDecision();
let phase = 'idle';       // plan | growing | report | done
let pending = null;       // POST /api/game/turn response while it is animated and reported
let lastEval = null;      // { ev, game } on the level result screen
let brief = null;         // { levelId, year, error }
let whatIf = null;        // { season, field, value, result, error, busy }
let paused = false;
let gameToken = 0;        // invalidates animations when the player leaves a level
let searchResults = null;
let searchState = { key:'', vars:null, err:false };
let lastError = null;
let bootStage = 'config'; // which request the error screen retries: config | archive

function emptyDecision(prev){
  // The irrigation system usually stays the same between seasons; everything else is chosen again.
  return { crop:null, method: prev ? prev.method : null, intensity:null, care:null };
}

/* =========================================================
   LABELS
   ========================================================= */
const cropName = id => t(`crops.${id}.name`);
const levelName = level => t(`levels.${level.key}.name`);
const soilName = id => t(`soils.${id}.name`);
const coordsLabel = p => `${dec(Math.abs(p.latitude))}° ${t(p.latitude>=0?'dir.N':'dir.S')}, ${dec(Math.abs(p.longitude))}° ${t(p.longitude>=0?'dir.E':'dir.W')}`;
function placeLabel(f){
  if(!f) return '';
  const p = f.place || {};
  if(p.preset) return t(`places.${p.preset}`);
  if(p.name) return [p.name, p.admin1, p.country].filter((x,i,a)=>x && a.indexOf(x)===i).join(', ');
  return t('location.custom', { coords: coordsLabel(f) });
}
function mdLabel(md){ const [m,d] = md.split('-').map(Number); return new Date(2001, m-1, d).toLocaleDateString(locale(), { day:'numeric', month:'short' }); }
const windowLabel = f => `${mdLabel(f.start_md)} – ${mdLabel(f.end_md)}`;
const isDemo = () => !!(archive && archive.data.status==='demo');
function seasonTitle(s){
  if(!s) return '';
  const name = s.season_name==='tropical' ? t('seasonName.tropical') : t(`seasonName.${s.season_name}`);
  return `${name} ${yearLabel(s.year, s.start, s.end)}`;
}
function yearLabel(year, start, end){
  if(isDemo()) return t('period.demoYear', { n:year });
  return start && end && start.slice(0,4)!==end.slice(0,4) ? `${start.slice(0,4)}/${end.slice(2,4)}` : String(year);
}
const periodLabel = s => `${fmtDate(s.start)} – ${fmtDate(s.end)}`;
const decisionPart = (field, v) => v ? t(`${{ crop:'crops', method:'methods', intensity:'intensity', care:'care' }[field]}.${v}.name`) : '—';
function describeDecision(d){
  const irr = d.intensity==='off' ? t('describe.noIrrigation') : `${decisionPart('intensity', d.intensity)} · ${decisionPart('method', d.method)}`;
  return [cropName(d.crop), irr, decisionPart('care', d.care)].join(' · ');
}
function goalValue(metric, v){
  switch(metric){
    case 'avg_yield': case 'min_yield': return `${num(v)}%`;
    case 'reserve_end': return t('units.mm', { n:num(v) });
    case 'fertility_delta': case 'erosion_delta': return signed(v, dec1);
    case 'n_leached': return t('units.kgN', { n:dec1(v) });
    case 'final_budget': return fmt$(v);
    default: return num(v);
  }
}
const goalText = g => t(`goal.${g.metric}`, { op: g.op==='>=' ? '≥' : g.op==='<=' ? '≤' : g.op, value: goalValue(g.metric, g.value) });
function statusBadge(data){
  if(!data) return '';
  const s = data.status;
  const label = s==='cached' && data.stale ? t('status.stale') : t(`status.${s}`);
  const hint = s==='demo' ? t('status.demoHint') : t(`status.${s}Hint`, { time: fmtDateTime(data.fetched_at) });
  return `<span class="status ${s}${data.stale?' stale':''}" title="${esc(hint)}"><i></i>${esc(label)}</span>`;
}
function starsSvg(n, total=3){
  const star = on => `<svg viewBox="0 0 24 24" aria-hidden="true"><path class="${on?'star-on':'star-off'}" stroke-width="1.4" stroke-linejoin="round" d="M12 2.8l2.8 5.8 6.3.9-4.6 4.4 1.1 6.3L12 17.2l-5.6 3 1.1-6.3-4.6-4.4 6.3-.9z"/></svg>`;
  return Array.from({ length:total }, (_,k)=>star(k<n)).join('');
}
function toast(msg, ms=3800){
  const el = $('toast'); el.innerHTML = msg; el.classList.add('show');
  clearTimeout(toast.timer); toast.timer = setTimeout(()=>el.classList.remove('show'), ms);
}
/** Like setTimeout, but the clock stops while the game is paused. */
function wait(ms){
  return new Promise(resolve=>{
    let left = ms, last = Date.now();
    const tick = ()=>{ const now = Date.now(); if(!paused) left -= now-last; last = now; if(left<=0) resolve(); else setTimeout(tick, 40); };
    setTimeout(tick, 40);
  });
}
function errorKey(e){ return e && e.kind ? e.kind : 'server'; }

/* =========================================================
   SCREENS AND OVERLAYS
   ========================================================= */
const SCREENS = ['loading','error','location','levels','game','final','farm'];
let screen = null;
function show(name){
  screen = name;
  SCREENS.forEach(n=>$('scr-'+n).classList.toggle('active', n===name));
}
const returnFocus = {};
function openOv(id){
  returnFocus[id] = document.activeElement;
  $(id).classList.add('show');
  const f = $(id).querySelector('[data-autofocus]') || $(id).querySelector('button, select');
  if(f) f.focus();
}
function closeOv(id){
  if(!ovOpen(id)) return;
  $(id).classList.remove('show');
  const back = returnFocus[id];
  if(back && document.contains(back) && typeof back.focus==='function') back.focus();
}
const ovOpen = id => $(id).classList.contains('show');
function closeAllOv(){ document.querySelectorAll('.overlay').forEach(o=>o.classList.remove('show')); $('banner').classList.remove('show'); }
function scrollTop(){ try{ window.scrollTo(0,0); }catch(e){ /* not supported */ } }

/* =========================================================
   BOOT, LOADING AND ERRORS
   ========================================================= */
let loadToken = 0;
function loadingSteps(active){
  const lis = [...$('boot-steps').children]; let k = 0;
  const paint = ()=>{ lis.forEach((li,i)=>{ li.className = i<k?'done':i===k?'now':''; }); $('boot-bar').style.width = (k/lis.length*100)+'%'; };
  paint();
  const timer = active ? setInterval(()=>{ if(k < lis.length-1){ k++; paint(); } }, 500) : null;
  return ()=>{ clearInterval(timer); k = lis.length; paint(); };
}
async function boot(){
  const token = ++loadToken;
  bootStage = 'config';
  show('loading');
  $('loading-title').textContent = t('loading.connect');
  $('loading-text').textContent = t('loading.connectText');
  const done = loadingSteps(false);
  try{
    const cfg = await client.getConfig();
    if(token!==loadToken) return;
    model = cfg;
    progress = R.sanitizeProgress(readJSON(KEYS.progress), model.levels.map(l=>l.id));
    done();
    if(farm) loadArchive(); else showLocation();
  }catch(e){
    if(token===loadToken) showError(e);
  }
}
async function loadArchive(){
  if(!farm){ showLocation(); return; }
  const token = ++loadToken;
  bootStage = 'archive';
  show('loading');
  $('loading-title').textContent = t(demoMode ? 'loading.demoTitle' : 'loading.title');
  $('loading-text').textContent = t(demoMode ? 'loading.demoText' : 'loading.text', { place: placeLabel(farm), period: windowLabel(farm) });
  const done = loadingSteps(true);
  try{
    const res = await client.loadArchive({ ...farm, demo: demoMode });
    if(token!==loadToken) return;
    archive = res;
    done();
    if(res.data.stale) toast(IC.alert + esc(t('toast.staleCache', { time: fmtDateTime(res.data.fetched_at) })), 7000);
    showLevels();
    maybeFirstTutorial();
  }catch(e){
    if(token!==loadToken) return;
    done();
    if(e.kind==='rejected' && e.detail && e.detail.error==='invalid_period'){ showLocation(t('location.periodServer', { message:e.detail.message })); return; }
    showError(e);
  }
}
function showError(e){ lastError = e; renderError(); show('error'); }
function renderError(){
  const kind = errorKey(lastError);
  $('err-title').textContent = t(`error.${kind}.title`);
  $('err-text').textContent = t(`error.${kind}.text`);
  $('err-code').textContent = t('error.code', { kind, status: lastError && lastError.status ? `HTTP ${lastError.status}` : '—' });
  // Demo is offered only when our server works but NASA POWER does not (the game needs the server either way).
  $('btn-demo').hidden = !(bootStage==='archive' && ['nasa','timeout'].includes(kind));
  $('btn-err-location').hidden = bootStage!=='archive';
}
function useDemo(){ demoMode = true; archive = null; loadArchive(); }

/* =========================================================
   FARM SETUP SCREEN
   ========================================================= */
function showLocation(message){
  draft = farm ? { ...farm, place:{ ...farm.place } } : { latitude:null, longitude:null, start_md:null, end_md:null, soil:null, place:null };
  draft.message = message || '';
  renderLocation(); show('location'); scrollTop();
}
function presetById(id){ return model.presets.find(p=>p.id===id); }
function renderLocation(){
  $('loc-presets').innerHTML = model.presets.map(p=>`
    <button class="place${draft.place && draft.place.preset===p.id?' current':''}" type="button" data-preset="${p.id}">
      <span class="pic">${IC.pin}</span><span><b>${esc(t(`places.${p.id}`))}</b><small>${esc(t(`places.${p.id}.note`))} · ${coordsLabel(p)}</small></span>
    </button>`).join('');
  $('loc-results').innerHTML = (searchResults||[]).map((p,i)=>`
    <button class="place" type="button" data-result="${i}">
      <span class="pic">${IC.pin}</span><span><b>${esc(p.name)}</b><small>${esc([p.admin1,p.country].filter(Boolean).join(', '))} · ${coordsLabel(p)}</small></span>
    </button>`).join('');
  const msg = $('loc-msg');
  msg.textContent = searchState.key ? t(searchState.key, searchState.vars) : '';
  msg.classList.toggle('err', searchState.err);
  const hasPlace = FarmData.validCoordinates(draft.latitude, draft.longitude);
  $('loc-current').innerHTML = hasPlace ? `<div class="place current" style="cursor:default"><span class="pic">${IC.check}</span>
      <span><b>${esc(placeLabel(draft))}</b><small>${coordsLabel(draft)} · ${esc(t(draft.latitude>=0?'hemisphere.north':'hemisphere.south'))}${Math.abs(draft.latitude)<23.44?' · '+esc(t('hemisphere.tropics')):''}</small></span></div>`
    : `<p class="msg">${esc(t('location.noPlace'))}</p>`;
  renderPeriod();
  renderSoilPick();
  renderSetupCheck();
}
const MONTHS = [1,2,3,4,5,6,7,8,9,10,11,12];
function mdParts(md){ return md ? md.split('-').map(Number) : [null,null]; }
function renderPeriod(){
  const month = m => new Date(2001, m-1, 1).toLocaleDateString(locale(), { month:'long' });
  ['start','end'].forEach(which=>{
    const [m,d] = mdParts(draft[`${which}_md`]);
    $(`per-${which}-m`).innerHTML = `<option value="">—</option>` + MONTHS.map(k=>`<option value="${k}"${k===m?' selected':''}>${esc(month(k))}</option>`).join('');
    $(`per-${which}-d`).value = d || '';
  });
}
function readPeriodInputs(){
  ['start','end'].forEach(which=>{
    const m = Number($(`per-${which}-m`).value), d = Number($(`per-${which}-d`).value);
    draft[`${which}_md`] = m && d ? `${String(m).padStart(2,'0')}-${String(d).padStart(2,'0')}` : null;
  });
}
function renderSoilPick(){
  const soils = R.options(model.soils), root = model.farm.root_zone_m;
  const maxTaw = Math.max(...Object.values(soils).map(s=>s.awc_mm_per_m*root));
  const bar = (label, v, good) => `<div class="srow"><span>${esc(label)}</span><div class="bar"><i style="width:${Math.round(v*100)}%;background:${good?'var(--green-500)':'var(--amber-500)'}"></i></div></div>`;
  $('soil-pick').innerHTML = SOILS.map(id=>{
    const s = soils[id];
    return `<button class="soil-opt" type="button" data-soil="${id}" aria-pressed="${draft.soil===id}">
      <span class="soil-top"><span class="soil-sw soil-${id}" aria-hidden="true"></span><b>${esc(soilName(id))}</b></span>
      <small>${esc(t(`soils.${id}.desc`))}</small>
      ${bar(t('soilProps.holding', { mm:num(s.awc_mm_per_m*root) }), s.awc_mm_per_m*root/maxTaw, true)}
      ${bar(t('soilProps.drainage'), s.drainage_rate, s.drainage_rate<0.8)}
      ${bar(t('soilProps.infiltration'), s.infiltration_mm_day/60, true)}
      ${bar(t('soilProps.erosion'), Math.max(s.water_erodibility, s.wind_erodibility), false)}
    </button>`;
  }).join('');
}
function setupCheck(){
  const cfg = model.data;
  const problems = [];
  if(!FarmData.validCoordinates(draft.latitude, draft.longitude)) problems.push(t('location.needPlace'));
  const per = draft.start_md && draft.end_md ? FarmData.checkPeriod(draft.start_md, draft.end_md, cfg.min_period_days, cfg.max_period_days) : { ok:false, reason:'missing', days:0 };
  if(!per.ok) problems.push(t(`location.period.${per.reason}`, { days:per.days, min:cfg.min_period_days, max:cfg.max_period_days }));
  if(!draft.soil) problems.push(t('location.needSoil'));
  return { ok: !problems.length, problems, period: per };
}
function renderSetupCheck(){
  const c = setupCheck();
  const per = c.period;
  $('per-info').textContent = per.days ? t(per.crossesYear ? 'location.periodDaysCross' : 'location.periodDays', { days:per.days }) : '';
  const msgs = [draft.message, ...c.problems].filter(Boolean);
  $('setup-msg').textContent = msgs.join(' ');
  $('setup-msg').classList.toggle('show', msgs.length>0);
  $('btn-load').disabled = !c.ok;
}
async function searchPlaces(q){
  q = q.trim();
  if(q.length<2){ searchState = { key:'location.tooShort', vars:null, err:true }; renderLocation(); return; }
  searchState = { key:'location.searching', vars:{ q }, err:false }; searchResults = null; renderLocation();
  try{
    const results = await client.geocode(q, LANG);
    searchResults = results;
    searchState = results.length ? { key:'location.found', vars:{ n:results.length }, err:false } : { key:'location.none', vars:{ q }, err:true };
  }catch(e){
    searchResults = null;
    searchState = { key:`location.err.${errorKey(e)}`, vars:null, err:true };
  }
  renderLocation();
}
function setDraftPlace(p, place){
  draft.latitude = Math.round(Number(p.latitude)*1e4)/1e4;
  draft.longitude = Math.round(Number(p.longitude)*1e4)/1e4;
  draft.place = place;
  draft.message = '';
  renderLocation();
}
function confirmFarm(){
  readPeriodInputs();
  if(!setupCheck().ok){ renderSetupCheck(); return; }
  farm = { latitude:draft.latitude, longitude:draft.longitude, start_md:draft.start_md, end_md:draft.end_md, soil:draft.soil, place:draft.place || {} };
  writeJSON(KEYS.farm, farm);
  demoMode = false; archive = null;
  loadArchive();
}

/* =========================================================
   LEVEL SELECT
   ========================================================= */
function showLevels(){ phase = 'idle'; game = null; pending = null; gameToken++; paused = false; closeAllOv(); renderLevels(); show('levels'); scrollTop(); }
function provenanceHtml(data, compact){
  if(data.status==='demo') return `<p class="provenance">${esc(t('prov.demo'))}</p>`;
  const params = Object.entries(data.parameters).map(([p,i])=>`<span class="chip-s${i.available===false?' off':''}" title="${esc(i.longname||p)}">${esc(p)} · ${esc(i.units)}</span>`).join('');
  return `<div class="prov">
    <p class="provenance">${esc(t('prov.source'))}: ${esc(data.source)} · ${esc(t('prov.community', { c:data.community }))} · ${esc(t('prov.timeStandard', { ts:data.time_standard }))}</p>
    <p class="provenance">${esc(t('prov.point', { coords: coordsLabel(data.location), elev: num(data.location.elevation_m) }))} · ${esc(t('prov.fetched', { time: fmtDateTime(data.fetched_at) }))}${data.stale ? ' · '+esc(t('prov.stale')) : ''}</p>
    ${compact ? '' : `<div class="chips">${params}</div>`}
    <p class="provenance"><a href="${esc(data.request_url)}" target="_blank" rel="noopener noreferrer">${esc(t('prov.request'))}</a> · ${esc(t('prov.years', { from:data.years.first, to:data.years.latest_complete }))}</p>
  </div>`;
}
function fitYears(levelId){ return archive.level_fit[levelId] || { type:'any', years:[], suggestions:[] }; }
function renderLevels(){
  $('lv-place').textContent = isDemo() ? t('levels.demoPlace') : placeLabel(farm);
  $('lv-coords').textContent = `${coordsLabel(farm)} · ${windowLabel(farm)} · ${soilName(farm.soil)}`;
  $('lv-status').innerHTML = statusBadge(archive.data);
  $('btn-refresh').lastElementChild.textContent = t(isDemo() ? 'actions.loadNasa' : 'actions.refresh');
  $('lv-intro').textContent = t('levels.intro', { from:archive.data.years.first, to:archive.data.years.latest_complete });
  $('lv-prov').innerHTML = provenanceHtml(archive.data, false);
  $('level-grid').innerHTML = model.levels.map((level,i)=>{
    const unlocked = R.isUnlocked(progress, level.id);
    const best = progress.best[level.id];
    const fit = fitYears(level.id);
    const fitText = fit.years.length
      ? t(fit.type==='any' ? 'levels.fitAny' : 'levels.fitSome', { n:fit.years.length, years: fit.suggestions.slice(0,3).map(y=>yearLabel(y)).join(', ') })
      : t('levels.fitNone');
    return `<article class="card level${unlocked?'':' locked'}">
      <div class="level-top"><span class="num" style="background:${LEVEL_COLORS[i]}">${IC[LEVEL_ICONS[i]]}</span>
        <div><h3>${level.id}. ${esc(levelName(level))}</h3><span class="best">${esc(t('levels.seasonsCount', { n:level.seasons }))} · ${esc(t(`weatherType.${fit.type}`))}</span></div></div>
      <p>${esc(t(`levels.${level.key}.short`))}</p>
      <div class="chips"><span class="chip-s${fit.years.length?'':' warn'}">${esc(fitText)}</span></div>
      <div class="foot">
        <div><div class="mini-stars" role="img" aria-label="${esc(t('levels.starsAria', { n: best ? best.stars : 0 }))}">${starsSvg(best ? best.stars : 0)}</div>
          ${best ? `<span class="best">${esc(t(best.passed ? 'levels.best' : 'levels.notPassed', { score:best.score }))}</span>` : ''}</div>
        <button class="btn ${unlocked && fit.years.length?'btn-primary':''}" type="button" data-level="${level.id}" ${unlocked && fit.years.length?'':'disabled'}>
          ${unlocked ? (best ? IC.refresh + esc(t('actions.replay')) : IC.play + esc(t('actions.play'))) : IC.lock + esc(t('levels.locked'))}</button>
      </div>
      ${unlocked ? '' : `<p class="best">${esc(t('levels.unlockHint', { n:level.id-1 }))}</p>`}
    </article>`;
  }).join('');
  $('btn-farm-report').disabled = !Object.keys(progress.best).length;
}

/* =========================================================
   LEVEL BRIEF (choose the historical season)
   ========================================================= */
function seasonByYear(y){ return archive.seasons.find(s=>s.year===y); }
function openBrief(id){
  const fit = fitYears(id);
  brief = { levelId:id, year: fit.suggestions[0] ?? fit.years[fit.years.length-1] ?? null, error:null, busy:false };
  renderBrief(); openOv('ov-level');
}
function anomalyChips(s){
  if(!s.anomaly.available) return `<span class="ev calm">${esc(t('anomaly.noReference'))}</span>`;
  return s.anomaly.flags.length
    ? s.anomaly.flags.map(f=>`<span class="ev ${f}">${esc(t(`anomaly.${f}`))}</span>`).join('')
    : `<span class="ev calm">${esc(t('anomaly.typical'))}</span>`;
}
function renderBrief(){
  const level = R.levelById(model, brief.levelId), start = level.start, fit = fitYears(level.id);
  const years = [...new Set([...fit.suggestions, ...fit.years.slice().reverse()])];
  const sel = brief.year !== null ? seasonByYear(brief.year) : null;
  const yearBtn = y => { const s = seasonByYear(y), f = s.features;
    return `<button class="year${y===brief.year?' on':''}" type="button" data-year="${y}" aria-pressed="${y===brief.year}">
      <b>${esc(yearLabel(y, s.start, s.end))}</b><small>${num(f.rain_total_mm)} mm · ${esc(t('brief.hotShort', { n:f.hot_days }))} · ${esc(t('brief.heavyShort', { n:f.heavy_rain_days }))}</small></button>`; };
  const loses = [...level.lose.map(l=>t(`lose.${l.metric}`, { value: goalValue(l.metric, l.value) })), ...(level.seasons>1 ? [t('lose.bankrupt')] : []), t('lose.goals')];
  $('brief').innerHTML = `
    <div class="eyebrow">${esc(t('brief.eyebrow', { n:level.id, total:model.levels.length }))}</div>
    <h2 id="brief-title">${esc(levelName(level))}</h2>
    <p class="story">${esc(t(`levels.${level.key}.story`))}</p>
    <div><h3>${esc(t('brief.goal'))}</h3><ul class="goal-list">${level.goals.map(g=>`<li><span class="gi">${IC.flag}</span>${esc(goalText(g))}</li>`).join('')}</ul></div>
    <div><h3>${esc(t('brief.stars'))}</h3><p class="rules">${esc(t('brief.starsText', { yield:level.stars.yield, water:level.stars.water, soil:signed(level.stars.soil) }))}</p></div>
    <div><h3>${esc(t('brief.weather'))}</h3><p class="rules">${esc(t(`weatherRule.${fit.type}`, weatherRuleVars(level)))}</p>
      <h3 style="margin-top:10px">${esc(t(level.seasons>1 ? 'brief.chooseStart' : 'brief.chooseYear', { n:level.seasons }))}</h3>
      ${years.length ? `<div class="years" role="group">${years.map(yearBtn).join('')}</div>` : `<p class="missing show">${esc(t('brief.noYears'))}</p>`}
    </div>
    ${sel ? `<div class="season-row"><b>${esc(seasonTitle(sel))}</b><span>· ${esc(periodLabel(sel))}${level.seasons>1 ? ' '+esc(t('brief.andNext', { n:level.seasons-1 })) : ''}</span>${anomalyChips(sel)}</div>
      <p class="note-sm">${esc(t('brief.reference', { n:sel.anomaly.reference_years.length, from:archive.data.years.first, to:archive.data.years.latest_complete }))}</p>` : ''}
    <div><h3>${esc(t('brief.start'))}</h3><div class="kv">
      <div><small>${esc(t('meters.budget'))}</small><b>${fmt$(start.budget)}</b></div>
      <div><small>${esc(t('meters.water'))}</small><b>${esc(t('units.mm', { n:num(start.reserve_mm) }))}</b></div>
      <div><small>${esc(t('meters.fertility'))}</small><b>${num(R.fertility(model, start.soil))}</b></div>
      <div><small>${esc(t('soil.n'))}</small><b>${esc(t('units.kgN', { n:num(start.soil.n) }))}</b></div>
      <div><small>${esc(t('soil.om'))}</small><b>${dec1(start.soil.om)}%</b></div>
      <div><small>${esc(t('brief.previous'))}</small><b style="font-size:15px">${esc(start.history.length ? start.history.map(cropName).join(' → ') : '—')}</b></div>
      ${level.economy.price!==1 || level.economy.cost!==1 ? `<div><small>${esc(t('brief.economy'))}</small><b style="font-size:15px">${esc(t('brief.economyText', { price:signed(Math.round((level.economy.price-1)*100)), cost:signed(Math.round((level.economy.cost-1)*100)) }))}</b></div>` : ''}
    </div></div>
    <p class="rules"><b>${esc(t('brief.loseLabel'))}</b> ${esc(loses.join(' · '))}<br><b>${esc(t('brief.soilLabel'))}</b> ${esc(soilName(farm.soil))} — ${esc(t(`soils.${farm.soil}.desc`))}</p>
    ${isDemo() ? `<p class="rules">${esc(t('brief.demo'))}</p>` : ''}
    ${brief.error ? `<p class="missing show" role="alert">${esc(brief.error)}</p>` : ''}
    <div class="brief-foot">
      <button class="btn btn-ghost" type="button" id="brief-cancel">${esc(t('actions.back'))}</button>
      <button class="btn btn-primary btn-lg" type="button" id="brief-start" data-autofocus ${sel && !brief.busy ? '' : 'disabled'}>${IC.play} ${esc(t(brief.busy ? 'actions.loading' : 'actions.startLevel'))}</button>
    </div>`;
  $('brief-cancel').onclick = ()=>closeOv('ov-level');
  $('brief-start').onclick = ()=>startLevel(brief.levelId, brief.year);
}
function weatherRuleVars(level){
  const w = level.weather, th = model.weather_thresholds;
  return { share: Math.round((w.max_rain_share || w.min_rain_share || 0)*100), days: w.min_hot_days || w.min_heavy_rain_days || 0,
    hot: th.hot_day_tmax_c, heavy: th.heavy_rain_day_mm };
}
const gameBody = extra => ({ level_id: game.level.id, year: game.year,
  farm: { latitude:farm.latitude, longitude:farm.longitude, start_md:farm.start_md, end_md:farm.end_md, soil:farm.soil, demo:isDemo() }, ...extra });
function rejectionText(e){
  const d = e.detail || {};
  switch(d.error){
    case 'weather_unfit': return t('reject.weatherUnfit', { years: (d.suggestions||[]).map(y=>yearLabel(y)).join(', ') || '—' });
    case 'year_unavailable': return t('reject.yearUnavailable', { latest:d.latest_complete_year, suggestion:d.suggestion });
    case 'incomplete_season': return t('reject.incomplete', { years:(d.years||[]).join(', '), suggestion: d.suggestion ?? '—' });
    case 'invalid_decision': return t('reject.invalidDecision', { list: [...(d.missing||[]).map(k=>t(`decisions.missing.${k}`)), ...(d.errors||[]).map(k=>has(`decisions.error.${k}`) ? t(`decisions.error.${k}`) : k)].join(', ') });
    default: return t(`error.${errorKey(e)}.short`);
  }
}
async function startLevel(id, year){
  if(year===null || year===undefined) return;
  const level = R.levelById(model, id);
  brief = { ...brief, busy:true, error:null }; renderBrief();
  const token = ++gameToken;
  try{
    game = { level, year, decisions:[], results:[] };
    const res = await client.start(gameBody({ decisions:[] }));
    if(token!==gameToken) return;
    Object.assign(game, { run:res.run, season:res.season, fit:res.fit, data:res.data });
    decision = emptyDecision();
    phase = 'plan'; pending = null; paused = false;
    closeAllOv(); setView(false);
    renderGame();
    setFieldState('planning', weatherFor(game.season));
    show('game'); scrollTop();
  }catch(e){
    if(token!==gameToken) return;
    game = null;
    brief = { ...brief, busy:false, error: rejectionText(e) };
    if(ovOpen('ov-level')) renderBrief();
  }
}

/* =========================================================
   GAME
   ========================================================= */
function renderGame(){
  renderTop(); renderControls(); renderData(); renderSoil(); renderMeters();
  renderPlants(); renderFieldLabels();
}
function renderTop(){
  const r = game.run, level = game.level;
  const idx = Math.min(r.season_index, r.seasons_total-1);
  const s = game.season || game.results[game.results.length-1] && seasonByYear(game.results[game.results.length-1].year);
  $('season-name').textContent = t('game.levelTitle', { n:level.id, name:levelName(level) });
  $('season-count').textContent = t('game.seasonCount', { n:idx+1, total:r.seasons_total, season: s ? seasonTitle(s) : '' });
  $('season-ic').innerHTML = IC[LEVEL_ICONS[level.id-1]];
  $('season-dots').innerHTML = Array.from({ length:r.seasons_total }, (_,k)=>`<i class="${k<r.season_index?'done':k===r.season_index?'now':''}"></i>`).join('');
  $('mission-text').textContent = level.goals.map(goalText).join(' · ');
}
function optionButton(kind, id, ui, name, desc, costText, pressed, locked){
  return `<button class="fert" type="button" data-${kind}="${id}" aria-pressed="${pressed}" ${locked?'disabled':''}>
    <span class="fic" style="background:${ui.bg};color:#fff">${IC[ui.ic]}</span>
    <span><b>${esc(name)}</b><small>${esc(desc)}</small></span><span class="cost">${costText}</span>
  </button>`;
}
function renderControls(){
  const r = game.run, locked = phase!=='plan';
  const prev = r.history[r.history.length-1];
  const crops = R.options(model.crops), mult = game.level.economy.cost;
  // 1. crop
  $('crop-grid').innerHTML = Object.keys(crops).map(id=>{
    const c = crops[id];
    let tag = `<span class="tag ${c.family==='legume'?'leg':c.heat_tmax_c>=36?'tol':''}">${esc(t(`crops.${id}.tag`))}</span>`;
    if(prev===id) tag = `<span class="tag warn">${esc(t('decisions.tagRepeat'))}</span>`;
    else if(prev && crops[prev].family==='legume' && c.family!=='legume') tag = `<span class="tag leg">${esc(t('decisions.tagLegumeCredit'))}</span>`;
    const drops = c.kc[1] >= 1.15 ? 3 : c.kc[1] >= 1.05 ? 2 : 1;
    return `<button class="crop" type="button" data-crop="${id}" aria-pressed="${decision.crop===id}" ${locked?'disabled':''}>
      ${cropIcon(id)}<b>${esc(cropName(id))}</b>
      <span class="meta"><span class="drops" role="img" aria-label="${esc(t('decisions.waterNeed',{ n:drops }))}">${[1,2,3].map(k=>`<span class="${k<=drops?'':'off'}">${IC.dropFill}</span>`).join('')}</span>${fmt$(c.seed_cost*mult)}</span>
      ${tag}
    </button>`;
  }).join('');
  const c = decision.crop && crops[decision.crop];
  $('crop-note').textContent = c ? t('decisions.cropNote', { heat:c.heat_tmax_c, gdd:num(c.gdd_need) }) : prev ? t('decisions.lastCrop', { crop:cropName(prev) }) : '';
  // 2. irrigation system
  const methods = R.options(model.irrigation_methods);
  $('irr-method').innerHTML = Object.keys(methods).map(m=>{
    const x = methods[m];
    return `<button type="button" data-method="${m}" aria-pressed="${decision.method===m}" ${locked?'disabled':''}>${IC[METHOD_UI[m].ic]} ${esc(t(`methods.${m}.name`))}
      <small>${esc(t('methods.meta', { eff:Math.round(x.efficiency*100), cost:fmt$(x.setup_cost*mult) }))}</small></button>`;
  }).join('');
  // 3. water use
  const intens = R.options(model.irrigation_intensity);
  $('irr-seg').innerHTML = Object.keys(intens).map((k,i)=>{
    const dis = locked || (k!=='off' && r.reserve_mm<=0);
    return `<button type="button" data-intensity="${k}" aria-pressed="${decision.intensity===k}" ${dis?'disabled':''}><span class="drops">${i===0?IC.none:Array.from({ length:i },()=>IC.dropFill).join('')}</span>${esc(t(`intensity.${k}.name`))}</button>`;
  }).join('');
  $('reserve-note').textContent = t('decisions.reserve', { mm:num(r.reserve_mm) });
  const it = decision.intensity && intens[decision.intensity];
  if(!decision.intensity) $('irr-hint').innerHTML = esc(t('irrigation.hintChoose'));
  else if(decision.intensity==='off') $('irr-hint').innerHTML = esc(t('irrigation.hintNone'));
  else $('irr-hint').innerHTML = esc(t(`intensity.${decision.intensity}.desc`, { cap:num(Math.min(it.cap_mm, r.reserve_mm)) }))
    + (decision.method ? ' ' + esc(t(`methods.${decision.method}.desc`)) : '');
  // 4. soil care
  const care = R.options(model.soil_care);
  $('care-list').innerHTML = Object.keys(care).map(id=>optionButton('care', id, CARE_UI[id], t(`care.${id}.name`), t(`care.${id}.desc`),
    care[id].cost ? fmt$(care[id].cost*mult) : esc(t('care.free')), decision.care===id, locked)).join('');
  // plan summary (maximum cost: water is reserved at its seasonal limit)
  const cost = R.planCost(model, r, decision);
  const rows = [[t('plan.seeds'), cost.seeds], [t('plan.fixed'), cost.fixed]];
  if(cost.care) rows.push([t('plan.care'), cost.care]);
  if(cost.irrigation_setup) rows.push([t('plan.setup'), cost.irrigation_setup]);
  if(cost.water_max) rows.push([t('plan.water', { mm:num(cost.water_max_mm) }), cost.water_max]);
  $('plan-sum').innerHTML = rows.map(([l,v])=>`<div><span>${esc(l)}</span><span>${fmt$(v)}</span></div>`).join('')
    + `<div class="total"><span>${esc(t('plan.total'))}</span><span>${fmt$(cost.total_max)}</span></div>`
    + `<div><span>${esc(t('plan.budgetLeft'))}</span><span>${fmt$(r.budget - cost.total_max)}</span></div>`;
  const check = R.validateDecision(model, r, decision);
  const msgs = [];
  if(check.missing.length) msgs.push(t('decisions.missing', { list: check.missing.map(k=>t(`decisions.missing.${k}`)).join(', ') }));
  check.errors.forEach(k=>msgs.push(has(`decisions.error.${k}`) ? t(`decisions.error.${k}`) : k));
  if(game.error) msgs.push(game.error);
  $('missing').textContent = msgs.join(' ');
  $('missing').classList.toggle('show', !locked && msgs.length>0);
  $('btn-confirm').disabled = locked || !check.ok;
  const s = game.season;
  $('btn-confirm').innerHTML = IC.check + esc(phase==='plan' ? t('actions.confirmGrow', { season: s ? yearLabel(s.year, s.start, s.end) : '' })
    : phase==='done' ? t('actions.levelOver') : t('actions.inProgress'));
}

function gauge(val, min, max, avg, grad, labels){
  const p = v=>Math.max(0, Math.min(100, (v-min)/(max-min)*100));
  return `<div class="gauge" style="background:${grad}">${avg===null||avg===undefined ? '' : `<span class="avg" style="left:${p(avg)}%" title="${esc(t('data.reference'))}"></span>`}<span class="mk" style="left:${p(val)}%"></span></div>
    <div class="gauge-labels">${labels.map(l=>`<span>${esc(l)}</span>`).join('')}</div>`;
}
/** The season shown in the NASA panel: the one being planned, or the one just played while its report is open. */
function shownSeason(){
  if(pending && pending.outcome) return seasonByYear(pending.outcome.year);
  return game.season || (game.results.length ? seasonByYear(game.results[game.results.length-1].year) : null);
}
function renderData(){
  const s = shownSeason();
  if(!s) return;
  const f = s.features, ref = s.reference, th = model.weather_thresholds;
  $('nasa-sub').textContent = `${seasonTitle(s)} · ${periodLabel(s)}`;
  $('nasa-status').innerHTML = statusBadge(game.data || archive.data);
  $('events').innerHTML = anomalyChips(s);
  const refMean = k => ref[k] ? ref[k].mean : null;
  const vsRef = (v, k, unit) => refMean(k)===null ? t('data.noReference') : t('data.vsReference', { value: `${num(refMean(k), k==='t_mean_c'?1:0)}${unit}` });
  const item = (ic,bg,title,val,unit,note,g,code) => `<div class="datum">
      <div class="datum-top"><span class="dic" style="background:${bg}">${IC[ic]}</span><h3>${esc(title)}</h3></div>
      <div class="datum-val"><b>${val}</b><span>${esc(unit)}</span><em>${esc(note)}</em></div>${g||''}<div class="src">${esc(code)}</div></div>`;
  const rainMax = Math.max(100, Math.ceil(Math.max(f.rain_total_mm, (refMean('rain_total_mm')||0)*1.6)/100)*100);
  const hotMax = Math.max(20, f.days || s.days);
  let html =
    item('rain','#1E6FD9',t('data.rain'),num(f.rain_total_mm),'mm',vsRef(f.rain_total_mm,'rain_total_mm',' mm'),
      gauge(f.rain_total_mm,0,rainMax,refMean('rain_total_mm'),'linear-gradient(90deg,#E9D6B4,#9CC6EE 55%,#1E6FD9)',['0',num(rainMax/2),`${num(rainMax)} mm`]),
      t('data.src.rain', { heavy:th.heavy_rain_day_mm }))+
    item('thermo','#D0632A',t('data.hotDays', { t:th.hot_day_tmax_c }),num(f.hot_days),t('data.unit.days'),vsRef(f.hot_days,'hot_days',''),
      gauge(f.hot_days,0,hotMax,refMean('hot_days'),'linear-gradient(90deg,#9CD58A,#F3C04E 50%,#E0602F)',['0',num(hotMax/2),num(hotMax)]),
      t('data.src.hot', { extreme:th.extreme_heat_tmax_c, n:f.extreme_heat_days }))+
    item('heat','#E09A1B',t('data.dry'),num(f.longest_dry_spell_days),t('data.unit.days'),vsRef(f.longest_dry_spell_days,'longest_dry_spell_days',''),'',
      t('data.src.dry', { mm:th.dry_day_precip_mm }))+
    item('rain','#2A6FB0',t('data.heavy'),num(f.heavy_rain_days),t('data.unit.days'),vsRef(f.heavy_rain_days,'heavy_rain_days',''),'',
      t('data.src.heavy', { mm:th.heavy_rain_day_mm }))+
    item('thermo','#B5412F',t('data.temp'),dec1(f.t_mean_c),'°C',vsRef(f.t_mean_c,'t_mean_c',' °C'),'',
      t('data.src.temp', { max:dec1(f.tmax_mean_c), min:dec1(f.tmin_mean_c), frost:f.frost_days }));
  html += `<div class="datum mini">${[
    ['humid', t('data.rh'), f.rh_mean_pct===null ? t('data.unavailable') : `${num(f.rh_mean_pct)} %`, 'RH2M'],
    ['wind', t('data.wind'), f.ws_mean_m_s===null ? t('data.unavailable') : `${dec1(f.ws_mean_m_s)} m/s · ${t('data.windyDays', { n:f.windy_days })}`, 'WS2M'],
    ['sun', t('data.solar'), f.solar_mean_mj_m2_day===null ? t('data.unavailable') : `${dec1(f.solar_mean_mj_m2_day)} MJ/m²/day`, 'ALLSKY_SFC_SW_DWN'],
    ['drop', t('data.et0'), `${num(f.et0_total_mm)} mm`, t('data.et0Source', { method: s.et0_method })],
  ].map(([ic,l,v,code])=>`<div class="mrow">${IC[ic]}<span>${esc(l)}</span><b>${esc(v)}</b><small>${esc(code)}</small></div>`).join('')}</div>`;
  $('data-list').innerHTML = html;
  const gapCount = Object.values(s.gaps).reduce((a,g)=>a+g.length, 0);
  $('insight').innerHTML = `<b>${IC.bulb} ${esc(t('insight.title'))}</b>${esc(t('insight.thresholds'))}`
    + (gapCount ? `<br>${esc(t('insight.gaps', { n:gapCount, params:Object.keys(s.gaps).join(', ') }))}` : '')
    + (s.unavailable_parameters.length ? `<br>${esc(t('insight.unavailable', { params:s.unavailable_parameters.join(', '), method:s.et0_method }))}` : '');
  $('obs').innerHTML = isDemo() ? esc(t('prov.demo')) : provenanceHtml(game.data || archive.data, true);
}
function renderSoil(){
  const r = pending && pending.run ? pending.run : game.run, soil = r.soil, fert = R.fertility(model, soil);
  const row = (label, pct, text, invert) => `<div class="srow"><span>${esc(label)}</span><div class="bar"><i style="width:${Math.max(0,Math.min(100,pct))}%;background:${barColor(invert ? 100-pct : pct)}"></i></div><span>${esc(text)}</span></div>`;
  const hist = r.history.slice(-4);
  const taw = model.soils[farm.soil].awc_mm_per_m * model.farm.root_zone_m;
  $('soil-card').innerHTML = `<h3>${IC.soil} ${esc(t('soil.title', { soil:soilName(farm.soil) }))}</h3>
    ${row(t('soil.fertility'), fert, num(fert))}
    ${row(t('soil.moisture'), soil.moisture, `${num(soil.moisture)}%`)}
    ${row(t('soil.n'), soil.n/1.2, num(soil.n))}
    ${row(t('soil.om'), (soil.om-0.5)/3*100, `${dec1(soil.om)}%`)}
    ${row(t('soil.erosion'), soil.erosion, num(soil.erosion), true)}
    <p class="note-sm">${esc(t('soil.note', { taw:num(taw) }))}</p>
    <div class="history">${esc(t('soil.history'))} ${hist.length ? hist.map(id=>`<span>${esc(cropName(id))}</span>`).join('→') : esc(t('soil.noHistory'))}</div>`;
}

const METERS = [
  { key:'yield',     ic:'leaf',  bg:'#3E9B4F' },
  { key:'fertility', ic:'soil',  bg:'#8C5E3C' },
  { key:'moisture',  ic:'humid', bg:'#2A8FA8' },
  { key:'water',     ic:'drop',  bg:'#1E6FD9' },
  { key:'budget',    ic:'coin',  bg:'#C9971B' },
];
function barColor(v){ return v>=70?'var(--green-500)':v>=45?'var(--amber-500)':'var(--red-600)'; }
function meterValues(run, results){
  const last = results[results.length-1];
  return { yield: last ? last.yield_pct : null, fertility:R.fertility(model, run.soil), moisture:run.soil.moisture, water:run.reserve_mm, budget:run.budget };
}
function renderMeters(deltas){
  const r = pending && pending.run ? pending.run : game.run;
  const results = pending && pending.results ? pending.results : game.results;
  const vals = meterValues(r, results), cap = model.farm.reserve_cap_mm;
  $('meters').innerHTML = METERS.map(M=>{
    const v = vals[M.key];
    const shown = v===null ? '—' : M.key==='budget' ? fmt$(v) : num(v);
    const unit = { yield:'%', fertility:'/100', moisture:'%', water:' mm', budget:'' }[M.key];
    const pct = M.key==='budget' ? Math.max(0, Math.min(100, v/15000*100)) : M.key==='water' ? v/cap*100 : (v ?? 0);
    const col = M.key==='budget' ? 'var(--amber-500)' : M.key==='water' ? 'var(--nasa-500)' : barColor(v ?? 0);
    const label = t(`meters.${M.key}`);
    return `<div class="meter" data-k="${M.key}">
      <div class="mic" style="background:${M.bg}">${IC[M.ic]}</div>
      <div class="meter-body"><small title="${esc(label)}">${esc(label)}</small>
        <div class="val"><b>${shown}</b>${v!==null && unit ? `<span>${unit}</span>` : ''}</div>
        <div class="bar"><i style="width:${pct}%;background:${col}"></i></div></div>
      <span class="delta"></span></div>`;
  }).join('');
  if(deltas) Object.entries(deltas).forEach(([k,d])=>{
    if(!d) return;
    const el = document.querySelector(`.meter[data-k="${k}"] .delta`); if(!el) return;
    el.textContent = k==='budget' ? (d>0?'+':'')+fmt$(d) : signed(Math.round(d));
    el.className = 'delta '+(d>0?'up':'down');
    requestAnimationFrame(()=>el.classList.add('show'));
    setTimeout(()=>el.classList.remove('show'), 3200);
  });
  setTank(r.reserve_mm / cap * 100);
}

function weatherFor(s, outcome){
  if(!s) return 'clear';
  const f = s.features, flags = s.anomaly.flags || [];
  if((outcome && outcome.state==='overwater') || f.heavy_rain_days>=3 || flags.includes('wet')) return 'rain';
  if((outcome && ['drought','heatstress'].includes(outcome.state)) || f.hot_days>=20 || flags.includes('hot') || flags.includes('dry')) return 'heat';
  if(f.solar_mean_mj_m2_day!==null && f.solar_mean_mj_m2_day < 15) return 'cloudy';
  return f.rain_total_mm / s.days > 1.5 ? 'showers' : 'clear';
}
function setFieldState(state, weather, ndvi){
  const st = $('stage');
  st.dataset.state = state;
  if(weather) st.dataset.weather = weather;
  const S = STATES[state] || STATES.healthy;
  const ic = $('cond-ic'); ic.style.background = S.color; ic.innerHTML = IC[S.ic];
  renderFieldLabels();
  paintNDVI(ndvi ?? (state==='planning' ? 0.2 : state==='failed' ? 0.18 : 0.6));
}
function renderFieldLabels(){
  const st = $('stage');
  $('cond-text').textContent = t(`states.${st.dataset.state}`);
  const w = st.dataset.weather;
  $('wx-chip').innerHTML = IC[WEATHER_IC[w]] + esc(t(`weather.${w}`));
}
function setView(sat){
  $('stage').classList.toggle('ndvi', sat);
  $('view-sat').setAttribute('aria-pressed', sat); $('view-farm').setAttribute('aria-pressed', !sat);
}

/* ---------- Playing a season ---------- */
async function confirmDecision(){
  if(phase!=='plan' || !game) return;
  if(!R.validateDecision(model, game.run, decision).ok){ renderControls(); return; }
  const token = gameToken;
  const played = { ...decision };
  phase = 'growing'; game.error = null;
  renderControls();
  let res;
  try{
    res = await client.turn(gameBody({ decisions:[...game.decisions, played] }));
  }catch(e){
    if(token!==gameToken) return;
    phase = 'plan';
    game.error = e.kind==='rejected' ? rejectionText(e) : t('toast.turnFailed', { reason:t(`error.${errorKey(e)}.short`) });
    renderControls();
    toast(IC.alert + esc(game.error), 6000);
    return;
  }
  if(token!==gameToken) return;
  const before = meterValues(game.run, game.results);
  pending = res;
  await animateSeason(token, res.outcome);
  if(token!==gameToken) return;
  const after = meterValues(res.run, res.results);
  const deltas = {};
  METERS.forEach(M=>{ if(after[M.key]!==null) deltas[M.key] = after[M.key] - (before[M.key] ?? after[M.key]); });
  renderMeters(deltas); renderSoil();
  await wait(700);
  if(token!==gameToken) return;
  phase = 'report';
  renderReport();
  openOv('ov-report');
}
/** Walks through the season's days (from the server's daily trace); the clock stops while paused. */
async function animateSeason(token, o){
  const s = seasonByYear(o.year);
  const days = o.trace.moisture_pct.length, frames = 24;
  const bar = $('grow-bar');
  bar.hidden = false;
  renderPlants(); setView(false);
  setFieldState('growing', weatherFor(s, o), 0.3);
  for(let k=1; k<=frames; k++){
    await wait(110);
    if(token!==gameToken){ bar.hidden = true; return; }
    const i = Math.min(days-1, Math.round(k/frames*(days-1)));
    const d = new Date(s.start+'T00:00:00'); d.setDate(d.getDate()+i);
    bar.querySelector('span').textContent = t('grow.day', { date: fmtDate(d.toISOString().slice(0,10), false), m: o.trace.moisture_pct[i] });
    bar.querySelector('i').style.width = `${k/frames*100}%`;
    if(k===Math.round(frames*0.6)) setFieldState(o.state, weatherFor(s, o), 0.18 + 0.6*o.yield_pct/100);
  }
  await wait(250);
  bar.hidden = true;
}
function reasonVars(r){
  const v = {};
  Object.entries(r.vars || {}).forEach(([k,x])=>{
    if(k==='prev') v[k] = cropName(x);
    else if(k==='soil') v[k] = soilName(x).toLocaleLowerCase(locale());
    else if(typeof x==='number') v[k] = Number.isInteger(x) ? num(x) : dec1(x);
    else v[k] = x;
  });
  return v;
}
const reasonText = r => has(`reason.${r.code}`) ? t(`reason.${r.code}`, reasonVars(r)) : r.code;
function reasonsHtml(reasons){
  const sorted = reasons.slice().sort((a,b)=>CATEGORY_ORDER.indexOf(a.category)-CATEGORY_ORDER.indexOf(b.category) || (b.loss||0)-(a.loss||0));
  return `<ul class="why">${sorted.map(r=>`<li>
    <span class="pb ${r.category}">${esc(t(`category.${r.category}`))}</span>
    <span>${esc(reasonText(r))}</span>
    ${r.loss ? `<span class="imp down">−${dec1(r.loss)} ${esc(t('units.pp'))}</span>` : ''}</li>`).join('')}</ul>`;
}
/** Daily chart: rain and irrigation bars, root-zone water line. */
function seasonChart(o, s){
  const W = 560, H = 150, pad = 26, n = o.trace.moisture_pct.length;
  const rain = o.trace.rain_mm, irr = o.trace.irrigation_mm, moist = o.trace.moisture_pct;
  const maxBar = Math.max(20, ...rain, ...irr);
  const x = i => pad + i*(W-pad*2)/Math.max(1,n-1);
  const bw = Math.max(1.2, (W-pad*2)/n*0.8);
  const bars = rain.map((v,i)=>v>0 ? `<rect x="${(x(i)-bw/2).toFixed(1)}" y="${(H-pad - v/maxBar*(H-pad*2)).toFixed(1)}" width="${bw.toFixed(1)}" height="${(v/maxBar*(H-pad*2)).toFixed(1)}" class="c-rain"/>` : '').join('')
    + irr.map((v,i)=>v>0 ? `<rect x="${(x(i)-bw/2).toFixed(1)}" y="${(H-pad - v/maxBar*(H-pad*2)).toFixed(1)}" width="${bw.toFixed(1)}" height="${(v/maxBar*(H-pad*2)).toFixed(1)}" class="c-irr"/>` : '').join('');
  const line = moist.map((v,i)=>`${i?'L':'M'}${x(i).toFixed(1)},${(H-pad - v/100*(H-pad*2)).toFixed(1)}`).join('');
  const mat = o.crop.maturity_day;
  return `<figure class="chart"><svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(t('chart.aria'))}">
      <line x1="${pad}" y1="${H-pad}" x2="${W-pad}" y2="${H-pad}" class="c-axis"/>
      ${bars}<path d="${line}" class="c-moist"/>
      ${mat!==null && mat!==undefined ? `<line x1="${x(mat)}" y1="${pad-6}" x2="${x(mat)}" y2="${H-pad}" class="c-mat"/><text x="${x(mat)+4}" y="${pad}" class="c-lbl">${esc(t('chart.maturity'))}</text>` : ''}
      <text x="${pad}" y="${H-8}" class="c-lbl">${esc(fmtDate(s.start, false))}</text><text x="${W-pad}" y="${H-8}" class="c-lbl" text-anchor="end">${esc(fmtDate(s.end, false))}</text>
    </svg><figcaption><span class="lg rain"></span>${esc(t('chart.rain'))} <span class="lg irr"></span>${esc(t('chart.irrigation'))} <span class="lg moist"></span>${esc(t('chart.moisture'))}</figcaption></figure>`;
}
function diffChips(diff, compact){
  const items = [
    ['yield_pct', 'whatif.yield', v=>`${signed(v)} ${t('units.pp')}`, 1],
    ['profit', 'whatif.profit', v=>(v>0?'+':v<0?'−':'±')+fmt$(Math.abs(v)).replace('−',''), 1],
    ['pumped_mm', 'whatif.pumped', v=>`${signed(v)} mm`, -1],
    ['useful_mm', 'whatif.useful', v=>`${signed(v)} mm`, 1],
    ['fertility_after', 'whatif.fertility', v=>signed(v), 1],
    ['erosion_event', 'whatif.erosion', v=>signed(v, dec1), -1],
    ['n_leached', 'whatif.leached', v=>`${signed(v, dec1)} kg`, -1],
  ];
  return `<div class="deltas">${items.filter(([k])=>!compact || Math.abs(diff[k])>=0.5).map(([k,l,f,dir])=>{
    const v = diff[k]; const good = v===0 ? null : v*dir>0;
    return `<span class="dchip">${esc(t(l))} <span class="n ${good===null?'':good?'up':'down'}">${esc(f(Math.round(v*10)/10))}</span></span>`;
  }).join('')}</div>`;
}
const changeText = ch => t('whatif.change', { field:t(`decisions.field.${ch.field}`), from:decisionPart(ch.field, ch.from), to:decisionPart(ch.field, ch.to) });
function renderReport(){
  const res = pending, o = res.outcome, s = seasonByYear(o.year);
  const S = STATES[o.state] || STATES.healthy, level = game.level;
  const idx = o.season_index;
  const dSoil = k => o.soil_end[k] - o.soil_before[k];
  const chip = (ic, label, d, goodUp=true, f=signed) => `<span class="dchip">${IC[ic]} ${esc(label)} <span class="n ${d===0?'':(d>0)===goodUp?'up':'down'}">${d===0?'±0':f(d)}</span></span>`;
  const btnLabel = res.run.failed ? t('actions.seeResult') : res.run.finished ? t('actions.finishLevel') : t('actions.nextSeason');
  const f = s.features;
  $('report').innerHTML = `
    <div class="report-head">
      <div class="ric" style="background:${S.color}">${IC[S.ic]}</div>
      <div><div class="eyebrow">${esc(t('report.eyebrow', { n:level.id, season:idx+1, total:res.run.seasons_total, year:seasonTitle(s) }))}</div><h2 id="rep-title">${esc(t(`states.${o.state}`))}</h2></div>
      <div class="field-ndvi"><small>${esc(t('report.yield'))}</small><b>${num(o.yield_pct)}%</b><small>${esc(t('report.harvest', { t:dec1(o.harvest_t) }))}</small></div>
    </div>
    <div class="report-body">
      <p class="note-sm">${esc(periodLabel(s))} · ${statusBadge(res.data)} · ${esc(t('report.modelNote'))}</p>
      <div class="deltas">
        <span class="dchip">${IC.coin} ${esc(t('report.profit'))} <span class="n ${o.economics.profit>=0?'up':'down'}">${o.economics.profit>=0?'+':''}${fmt$(o.economics.profit)}</span></span>
        ${chip('drop', t('meters.water'), o.water.reserve_after_mm - o.water.reserve_before_mm, true, v=>`${signed(v)} mm`)}
        ${chip('soil', t('meters.fertility'), o.fertility_after - o.fertility_before)}
        ${chip('leaf', t('soil.n'), Math.round(dSoil('n')))}
        ${chip('compost', t('soil.om'), Math.round(dSoil('om')*100)/100, true, v=>signed(v, dec))}
        ${chip('alert', t('soil.erosion'), Math.round(dSoil('erosion')*10)/10, false, v=>signed(v, dec1))}
      </div>
      <div class="chain">
        <div class="link data"><h4>${IC.satellite} ${esc(t('report.nasaData'))}</h4>${esc(t('report.dataLine', { rain:num(f.rain_total_mm), hot:f.hot_days, t:model.weather_thresholds.hot_day_tmax_c, dry:f.longest_dry_spell_days, heavy:f.heavy_rain_days, temp:dec1(f.t_mean_c) }))}</div>
        <div class="link dec"><h4>${IC.farmer} ${esc(t('report.decision'))}</h4>${esc(describeDecision(o.decision))}</div>
        <div class="link res ${o.yield_pct>=70?'':o.yield_pct>=45?'warn':'bad'}"><h4>${IC[S.ic]} ${esc(t('report.happened'))}</h4>${esc(t('report.resultLine', { use:num(o.water.crop_use_mm), demand:num(o.water.crop_demand_mm), pumped:num(o.water.pumped_mm), yield:num(o.yield_pct) }))}</div>
      </div>
      ${seasonChart(o, s)}
      <div><p class="section-t">${esc(t('report.why'))}</p>${reasonsHtml(o.reasons)}</div>
      <div class="whatif-auto"><p class="section-t">${IC.compare} ${esc(t('whatif.autoTitle'))}</p>
        <p class="note-sm">${esc(t('whatif.autoNote'))}</p>
        ${res.what_if.length ? res.what_if.map(a=>`<div class="wi-alt">
          <div class="wi-alt-top"><span class="crit">${esc([a.criterion, ...(a.also||[])].map(c=>t(`whatif.criterion.${c}`)).join(' · '))}</span><b>${esc(changeText(a.change))}</b></div>
          ${diffChips(a.diff, true)}
          ${a.drivers.length ? `<p class="note-sm">${esc(t('whatif.drivers', { list:a.drivers.map(d=>t(`factor.${d}`)).join(', ') }))}</p>` : ''}
        </div>`).join('') : `<p class="alt same"><span>${esc(t('whatif.none'))}</span></p>`}
        <p class="note-sm">${esc(t('whatif.noBest'))}</p>
        <button class="btn" type="button" id="btn-whatif">${IC.compare} ${esc(t('actions.whatIf'))}</button>
      </div>
      <p class="note-sm">${esc(t('report.money', { revenue:fmt$(o.economics.revenue), cost:fmt$(o.economics.cost), max:fmt$(o.economics.cost_max) }))}</p>
      <details class="limits"><summary>${esc(t('report.limits'))}</summary><ul>${(res.limitations||[]).map(l=>`<li>${esc(l)}</li>`).join('')}</ul></details>
      <div class="report-foot">
        <small>${esc(t('report.gridNote'))}</small>
        <button class="btn btn-primary btn-lg" type="button" id="btn-next" data-autofocus>${esc(btnLabel)} ${IC.arrow}</button>
      </div>
    </div>`;
  $('btn-next').onclick = afterReport;
  $('btn-whatif').onclick = ()=>openWhatIf(idx);
}
function afterReport(){
  closeOv('ov-whatif'); closeOv('ov-report');
  const res = pending;
  game.decisions = [...game.decisions, res.outcome.decision];
  Object.assign(game, { run:res.run, results:res.results, season:res.season, data:res.data });
  pending = null;
  if(res.evaluation){ finishLevel(res.evaluation); return; }
  phase = 'plan';
  decision = emptyDecision(res.outcome.decision);
  renderGame();
  setFieldState('planning', weatherFor(game.season));
  toast(IC.sprout + esc(t('toast.nextSeason', { n:game.run.season_index+1, season:seasonTitle(game.season) })));
}

/* ---------- Custom What If (server replays the season with ONE change) ---------- */
function openWhatIf(season){
  const base = (pending ? pending.results : game.results)[season].decision;
  const field = base.intensity==='off' ? 'intensity' : 'method';
  whatIf = { season, field, value:null, result:null, error:null, busy:false, base };
  whatIf.value = otherValues(field, base)[0];
  renderWhatIf(); openOv('ov-whatif');
  runWhatIf();
}
function otherValues(field, base){
  const table = { crop:model.crops, method:model.irrigation_methods, intensity:model.irrigation_intensity, care:model.soil_care }[field];
  return Object.keys(R.options(table)).filter(v=>v!==base[field]);
}
async function runWhatIf(){
  const w = whatIf; w.busy = true; w.error = null; renderWhatIf();
  const decisions = pending ? [...game.decisions, pending.outcome.decision] : game.decisions;
  try{
    const res = await client.whatIf(gameBody({ decisions, season:w.season, field:w.field, value:w.value }));
    if(whatIf!==w) return;
    w.result = res.comparison;
  }catch(e){
    if(whatIf!==w) return;
    w.result = null;
    w.error = e.kind==='rejected' ? t('whatif.unaffordable') : t(`error.${errorKey(e)}.short`);
  }
  w.busy = false; renderWhatIf();
}
function renderWhatIf(){
  const w = whatIf, r = w.result;
  const fields = ['crop','method','intensity','care'];
  const rows = r ? [
    [t('whatif.yield'), `${num(r.player.yield_pct)}%`, `${num(r.alternative.yield_pct)}%`, r.diff.yield_pct, 1],
    [t('whatif.profit'), fmt$(r.player.profit), fmt$(r.alternative.profit), r.diff.profit, 1],
    [t('whatif.pumped'), `${num(r.player.pumped_mm)} mm`, `${num(r.alternative.pumped_mm)} mm`, r.diff.pumped_mm, -1],
    [t('whatif.useful'), `${num(r.player.useful_mm)} mm`, `${num(r.alternative.useful_mm)} mm`, r.diff.useful_mm, 1],
    [t('whatif.reserve'), `${num(r.player.reserve_after_mm)} mm`, `${num(r.alternative.reserve_after_mm)} mm`, r.diff.reserve_after_mm, 1],
    [t('whatif.fertility'), num(r.player.fertility_after), num(r.alternative.fertility_after), r.diff.fertility_after, 1],
    [t('whatif.erosion'), dec1(r.player.erosion_event), dec1(r.alternative.erosion_event), r.diff.erosion_event, -1],
    [t('whatif.leached'), `${dec1(r.player.n_leached)} kg`, `${dec1(r.alternative.n_leached)} kg`, r.diff.n_leached, -1],
  ] : [];
  const cls = (d, dir) => !d ? '' : d*dir>0 ? 'better' : 'worse';
  $('whatif').innerHTML = `
    <div class="eyebrow">${esc(t('whatif.eyebrow'))}</div>
    <h2 id="wi-title">${esc(t('whatif.title'))}</h2>
    <p class="note-sm">${esc(t('whatif.rule'))}</p>
    <div class="wi-grid">
      <div class="wi-col"><h3>${esc(t('whatif.yours'))}</h3><p>${esc(describeDecision(w.base))}</p></div>
      <div class="wi-col alt-col"><h3>${esc(t('whatif.alternative'))}</h3>
        <label>${esc(t('whatif.fieldSel'))}<select id="wi-field">${fields.map(f=>`<option value="${f}"${f===w.field?' selected':''}>${esc(t(`decisions.field.${f}`))}</option>`).join('')}</select></label>
        <label>${esc(t('whatif.valueSel'))}<select id="wi-value">${otherValues(w.field, w.base).map(v=>`<option value="${v}"${v===w.value?' selected':''}>${esc(decisionPart(w.field, v))}</option>`).join('')}</select></label>
      </div>
    </div>
    ${w.busy ? `<p class="note-sm">${esc(t('actions.loading'))}</p>` : ''}
    ${w.error ? `<p class="missing show">${esc(w.error)}</p>` : ''}
    ${r ? `<div class="table-wrap"><table class="table">
      <thead><tr><th>${esc(t('whatif.metric'))}</th><th>${esc(t('whatif.yours'))}</th><th>${esc(changeText(r.change))}</th></tr></thead>
      <tbody>${rows.map(([l,a,b,d,dir])=>`<tr><td>${esc(l)}</td><td>${a}</td><td class="${cls(d,dir)}">${b}</td></tr>`).join('')}
        <tr><td>${esc(t('whatif.state'))}</td><td>${esc(t(`states.${r.player.state}`))}</td><td>${esc(t(`states.${r.alternative.state}`))}</td></tr></tbody>
    </table></div>
    ${r.drivers.length ? `<p class="note-sm">${esc(t('whatif.drivers', { list:r.drivers.map(d=>`${t(`factor.${d}`)} (${signed(r.factor_delta_pp[d], dec1)} ${t('units.pp')})`).join(', ') }))}</p>` : ''}` : ''}
    <p class="note-sm">${esc(t('whatif.note'))}</p>
    <div class="brief-foot"><button class="btn btn-primary" type="button" id="wi-close" data-autofocus>${esc(t('actions.backToReport'))}</button></div>`;
  $('wi-field').onchange = e=>{ w.field = e.target.value; w.value = otherValues(w.field, w.base)[0]; runWhatIf(); };
  $('wi-value').onchange = e=>{ w.value = e.target.value; runWhatIf(); };
  $('wi-close').onclick = ()=>closeOv('ov-whatif');
}

/* ---------- End of a level ---------- */
function finishLevel(ev){
  lastEval = { ev, game: { ...game } };
  progress = R.recordResult(progress, ev, { date:new Date().toISOString().slice(0,10), data:game.data.status, year:game.year,
    place: isDemo() ? null : placeLabel(farm), soil:farm.soil });
  writeJSON(KEYS.progress, progress);
  phase = 'done';
  renderControls();
  setFieldState(ev.passed ? 'harvest' : 'failed', ev.passed ? 'clear' : 'cloudy', ev.passed ? 0.7 : 0.18);
  showBanner();
}
function showBanner(){ renderBanner(); $('banner').classList.add('show'); $('btn-final').focus(); }
function renderBanner(){
  const ev = lastEval.ev, passed = ev.passed;
  const text = passed ? t('banner.win.text') : t(`banner.fail.${ev.fail_reason}`);
  $('banner-card').innerHTML = `<div class="big-ic" style="background:${passed?'#C9971B':'#8E2A1F'}">${passed?IC.basket:IC.x}</div>
    <h2>${esc(t(passed ? 'banner.win.title' : 'banner.fail.title'))}</h2><p>${esc(text)}</p>
    <button class="btn ${passed?'btn-primary':''} btn-lg" type="button" id="btn-final">${IC.trophy} ${esc(t('actions.seeResult'))}</button>`;
  $('btn-final').onclick = ()=>{ $('banner').classList.remove('show'); showResult(); };
}
function showResult(){ renderResult(); show('final'); scrollTop(); }
function downloadJSON(name, data){
  const blob = new Blob([JSON.stringify(data, null, 2)], { type:'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = name; document.body.append(a); a.click(); a.remove();
  setTimeout(()=>URL.revokeObjectURL(url), 1000);
}
function exportLevel(){
  const { ev, game:g } = lastEval;
  downloadJSON(`farm-navigator-level${ev.level_id}-${g.year}.json`, {
    exported_at: new Date().toISOString(), game:'Farm Navigator', level:{ id:ev.level_id, key:g.level.key },
    farm:{ ...farm, place_label: placeLabel(farm) }, start_year:g.year, data_provenance:g.data,
    seasons: g.results.map(o=>({ ...seasonByYear(o.year), daily: undefined })),
    decisions:g.decisions, results:g.results.map(o=>({ ...o, trace: undefined })), evaluation:ev,
    model_limitations: model.limitations, disclaimer: model.disclaimer,
  });
}
function renderResult(){
  const { ev, game:g } = lastEval, m = ev.metrics, level = g.level;
  const nextLevel = model.levels.find(l=>l.id===level.id+1);
  const star = (on, cls='') => `<svg class="${cls}" viewBox="0 0 24 24" aria-hidden="true"><path class="${on?'star-on':'star-off'}" stroke-width="1.4" stroke-linejoin="round" d="M12 2.8l2.8 5.8 6.3.9-4.6 4.4 1.1 6.3L12 17.2l-5.6 3 1.1-6.3-4.6-4.4 6.3-.9z"/></svg>`;
  const cat = (key, label, score, extra) => { const c = ev.categories[key]; return `<div class="cat${c.earned && ev.passed?' on':''}">${star(c.earned && ev.passed)}<b>${score}</b><small>${esc(label)}</small><small>${esc(extra)}</small></div>`; };
  const kv = (label, value, cls='') => `<div><small>${esc(label)}</small><b class="${cls}">${value}</b></div>`;
  const dcls = (d, goodUp=true) => d===0 ? '' : (d>0)===goodUp ? 'up' : 'down';
  const failText = ev.passed ? t('result.passedText', { stars:ev.stars }) : t(`result.fail.${ev.fail_reason}`);
  $('final').innerHTML = `
    <div class="final-hero">
      <div class="score-card">
        <div class="stars">${star(ev.stars>=1)}${star(ev.stars>=2,'s2')}${star(ev.stars>=3)}</div>
        <div class="eyebrow" style="color:#BFE3B8">${esc(t('result.eyebrow', { n:level.id }))}</div>
        <h2 style="font-size:24px;margin-top:4px">${esc(levelName(level))}</h2>
        <div class="score-num">${ev.score}<span>/100</span></div>
        <div class="rank">${esc(t(ev.passed ? 'result.passed' : 'result.failed'))}</div>
        <div class="harvest-result ${ev.passed?'ok':'bad'}">
          <span class="hic" style="background:${ev.passed?'#C9971B':'#8E2A1F'}">${ev.passed?IC.basket:IC.x}</span>
          <span>${esc(failText)}</span>
        </div>
      </div>
      <div class="final-side">
        <div class="card"><h3>${IC.flag} ${esc(t('result.goals'))}</h3>
          <ul class="goal-list">${ev.goals.map(gl=>`<li class="${gl.met?'ok':'no'}"><span class="gi">${gl.met?IC.check:IC.x}</span>${esc(goalText(gl))}<em>${esc(goalValue(gl.metric, gl.actual))}</em></li>`).join('')}</ul></div>
        <div class="card"><h3>${IC.star} ${esc(t('result.categories'))}</h3>
          <div class="cats">
            ${cat('yield', t('result.cat.yield'), `${ev.categories.yield.score}%`, t('result.cat.target', { value:`${ev.categories.yield.target}%` }))}
            ${cat('water', t('result.cat.water'), ev.categories.water.score, t('result.cat.target', { value:ev.categories.water.target }))}
            ${cat('soil', t('result.cat.soil'), ev.categories.soil.score, t('result.cat.soilTarget', { value:signed(ev.categories.soil.target), delta:signed(m.fertility_delta) }))}
          </div><p class="note-sm" style="margin-top:8px">${esc(t('result.starsNote'))}</p></div>
      </div>
    </div>
    <div class="final-grid">
      <div class="card"><h3>${IC.coin} ${esc(t('result.totals'))}</h3><div class="kv">
        ${kv(t('result.profit'), `${m.profit>=0?'+':''}${fmt$(m.profit)}`, dcls(m.profit))}
        ${kv(t('result.revenue'), fmt$(m.revenue))}
        ${kv(t('result.finalBudget'), fmt$(m.final_budget))}
        ${kv(t('result.avgYield'), `${num(m.avg_yield)}%`)}
        ${kv(t('result.pumped'), `${num(m.pumped_mm)} mm`)}
        ${kv(t('result.useful'), `${num(m.useful_mm)} mm`)}
        ${kv(t('result.reserveEnd'), `${num(m.reserve_end)} mm`)}
      </div></div>
      <div class="card"><h3>${IC.soil} ${esc(t('result.soil'))}</h3><div class="kv">
        ${kv(t('meters.fertility'), `${num(m.fertility_end)} (${signed(m.fertility_delta)})`, dcls(m.fertility_delta))}
        ${kv(t('soil.n'), signed(m.n_delta, dec1), dcls(m.n_delta))}
        ${kv(t('soil.om'), signed(m.om_delta, dec), dcls(m.om_delta))}
        ${kv(t('soil.erosion'), signed(m.erosion_delta, dec1), dcls(m.erosion_delta, false))}
        ${kv(t('result.leached'), t('units.kgN', { n:dec1(m.n_leached) }), m.n_leached>15?'down':'')}
      </div></div>
    </div>
    <div class="card" style="padding:18px;margin-top:18px"><h3>${IC.map} ${esc(t('result.seasons'))}</h3>
      <div class="timeline">${g.results.map(o=>{ const S = STATES[o.state] || STATES.healthy, s = seasonByYear(o.year); return `
        <div class="tl"><div class="tl-top">${cropIcon(o.decision.crop)}<div><small>${esc(seasonTitle(s))}</small><b>${esc(cropName(o.decision.crop))}</b></div><span class="hp" style="color:${barColor(o.yield_pct)}">${o.yield_pct}%</span></div>
        <span class="state" style="background:${S.color}1f;color:${S.color}">${IC[S.ic]}${esc(t(`states.${o.state}`))}</span>
        <p class="note-sm" style="margin-top:6px">${esc(describeDecision(o.decision))}</p>
        <p class="note-sm">${esc(t('result.seasonLine', { rain:num(s.features.rain_total_mm), hot:s.features.hot_days, pumped:num(o.water.pumped_mm), profit:fmt$(o.economics.profit) }))}</p></div>`; }).join('')}</div></div>
    <div class="final-grid">
      <div class="card"><h3>${IC.bulb} ${esc(t('result.recommendations'))}</h3><ul class="lessons">${(ev.recommendations.length ? ev.recommendations : ['keep']).map(k=>`<li><span class="lic">${IC.check}</span><span>${esc(t(`rec.${k}`))}</span></li>`).join('')}</ul></div>
      <div class="card"><h3>${IC.satellite} ${esc(t('result.data'))}</h3>${provenanceHtml(g.data, false)}
        <details class="limits"><summary>${esc(t('report.limits'))}</summary><ul>${model.limitations.map(l=>`<li>${esc(l)}</li>`).join('')}</ul></details></div>
    </div>
    <div class="final-actions">
      ${ev.passed && nextLevel ? `<button class="btn btn-primary btn-lg" type="button" id="res-next">${IC.play} ${esc(t('actions.nextLevel', { n:nextLevel.id }))}</button>` : ''}
      <button class="btn btn-lg${ev.passed?'':' btn-primary'}" type="button" id="res-retry">${IC.refresh} ${esc(t('actions.replayLevel'))}</button>
      <button class="btn btn-lg" type="button" id="res-levels">${IC.grid} ${esc(t('actions.levels'))}</button>
      <button class="btn btn-lg" type="button" id="res-export">${IC.download} ${esc(t('actions.export'))}</button>
      ${R.farmReport(progress, model.levels).rows.some(r=>r.best) ? `<button class="btn btn-lg btn-nasa" type="button" id="res-farm">${IC.trophy} ${esc(t('farm.open'))}</button>` : ''}
    </div>
    <p class="disclaimer">${esc(model.disclaimer)}</p>`;
  if($('res-next')) $('res-next').onclick = ()=>{ showLevels(); openBrief(nextLevel.id); };
  $('res-retry').onclick = ()=>{ showLevels(); openBrief(level.id); };
  $('res-levels').onclick = showLevels;
  $('res-export').onclick = exportLevel;
  if($('res-farm')) $('res-farm').onclick = showFarm;
}

/* ---------- Farm report (whole game) ---------- */
function showFarm(){ renderFarm(); show('farm'); scrollTop(); }
function renderFarm(){
  const rep = R.farmReport(progress, model.levels);
  const ratio = rep.totalStars / rep.maxStars;
  const rank = t('final.rank.'+(ratio>=0.85?'master':ratio>=0.6?'skilled':ratio>=0.3?'growing':'rookie'));
  $('farm').innerHTML = `
    <div class="final-hero">
      <div class="score-card">
        <div class="eyebrow" style="color:#BFE3B8">${esc(t('farm.eyebrow'))}</div>
        <div class="score-num">${rep.totalStars}<span>/${rep.maxStars}</span></div>
        <div class="rank">${esc(rank)}</div>
        <div class="harvest-result ${rep.allPassed?'ok':'bad'}"><span class="hic" style="background:${rep.allPassed?'#C9971B':'#8C5E3C'}">${IC.trophy}</span>
          <span>${esc(t('farm.completed', { n:rep.completed, total:model.levels.length }))}</span></div>
      </div>
      <div class="final-side">
        <div class="card"><h3>${IC.star} ${esc(t('result.categories'))}</h3><div class="cats">
          <div class="cat"><b>${num(rep.categories.yield)}%</b><small>${esc(t('result.cat.yield'))}</small></div>
          <div class="cat"><b>${num(rep.categories.water)}</b><small>${esc(t('result.cat.water'))}</small></div>
          <div class="cat"><b>${num(rep.categories.soil)}</b><small>${esc(t('result.cat.soil'))}</small></div>
        </div>
        ${rep.weakest ? `<p class="note-sm" style="margin-top:10px">${esc(t(`farm.weak.${rep.weakest}`))}</p>` : ''}</div>
        <div class="card"><h3>${IC.coin} ${esc(t('result.totals'))}</h3><div class="kv">
          <div><small>${esc(t('farm.totalProfit'))}</small><b class="${rep.totalProfit>=0?'up':'down'}">${rep.totalProfit>=0?'+':''}${fmt$(rep.totalProfit)}</b></div>
          <div><small>${esc(t('farm.totalPumped'))}</small><b>${num(rep.totalPumpedMm)} mm</b></div>
        </div></div>
      </div>
    </div>
    <div class="card" style="padding:18px;margin-top:18px"><h3>${IC.grid} ${esc(t('farm.levels'))}</h3>
      <div class="table-wrap"><table class="table">
        <thead><tr><th>${esc(t('farm.level'))}</th><th>${esc(t('farm.stars'))}</th><th>${esc(t('result.cat.yield'))}</th><th>${esc(t('result.cat.water'))}</th><th>${esc(t('result.cat.soil'))}</th><th>${esc(t('result.profit'))}</th><th>${esc(t('farm.data'))}</th></tr></thead>
        <tbody>${rep.rows.map(row=>{ const level = R.levelById(model, row.id), b = row.best; return `<tr>
          <td>${row.id}. ${esc(levelName(level))}${b && b.year ? `<br><small class="note-sm">${esc([b.place, b.year, b.soil && soilName(b.soil)].filter(Boolean).join(' · '))}</small>` : ''}</td>
          <td><span class="mini-stars" style="justify-content:flex-end">${starsSvg(b ? b.stars : 0)}</span></td>
          <td>${b ? `${num(b.yield)}%` : '—'}</td><td>${b ? num(b.water) : '—'}</td><td>${b ? num(b.soil) : '—'}</td>
          <td>${b ? fmt$(b.profit) : '—'}</td><td>${b ? esc(t(`status.${b.data || 'live'}`)) : '—'}</td></tr>`; }).join('')}</tbody>
      </table></div></div>
    <div class="card" style="padding:18px;margin-top:18px"><h3>${IC.satellite} ${esc(t('final.lessons'))}</h3>
      <ul class="lessons">${[1,2,3,4,5].map(k=>`<li><span class="lic">${IC.check}</span><span>${esc(t(`farm.lesson.${k}`))}</span></li>`).join('')}</ul></div>
    <div class="final-actions">
      <button class="btn btn-primary btn-lg" type="button" id="farm-levels">${IC.grid} ${esc(t('actions.levels'))}</button>
      <button class="btn btn-lg" type="button" id="farm-export">${IC.download} ${esc(t('actions.export'))}</button>
      <button class="btn btn-lg btn-ghost" type="button" id="farm-reset">${IC.refresh} ${esc(t('farm.reset'))}</button>
    </div>
    <p class="disclaimer">${esc(model.disclaimer)}</p>`;
  $('farm-levels').onclick = showLevels;
  $('farm-export').onclick = ()=>downloadJSON('farm-navigator-farm-report.json', { exported_at:new Date().toISOString(), game:'Farm Navigator', report:rep,
    model_limitations:model.limitations, disclaimer:model.disclaimer });
  $('farm-reset').onclick = ()=>{
    if(!window.confirm(t('farm.resetConfirm'))) return;
    progress = R.emptyProgress(); writeJSON(KEYS.progress, progress); showLevels();
  };
}

/* =========================================================
   PAUSE
   ========================================================= */
function pauseGame(){ paused = true; $('stage').classList.add('paused'); openOv('ov-pause'); }
function resumeGame(){ paused = false; $('stage').classList.remove('paused'); closeOv('ov-pause'); }
function leaveLevelConfirmed(){
  return !(game && game.decisions.length && phase!=='done') || window.confirm(t('confirm.leave'));
}

/* =========================================================
   TUTORIAL
   ========================================================= */
const TUT = [
  { id:'welcome', art:()=>`<div style="display:flex;gap:10px">${['wheat','maize','sorghum','chickpea'].map(cropIcon).join('')}</div>`, bg:'linear-gradient(180deg,#BFE1F5,#EEF6E6)',
    chips:()=>[t('tut.welcome.chip1'),t('tut.welcome.chip2'),t('tut.welcome.chip3')] },
  { id:'sky', art:()=>`<div style="width:120px;height:120px">${IC['satellite-color']}</div>`, bg:'linear-gradient(180deg,#0B3D91,#1E6FD9)',
    chips:()=>['T2M','T2M_MAX','T2M_MIN','PRECTOTCORR','RH2M','WS2M','ALLSKY_SFC_SW_DWN'] },
  { id:'decide', art:()=>`<div style="display:flex;gap:12px;color:#fff">${['sprout','sprinkler','drop','shield'].map(i=>`<span style="width:60px;height:60px;border-radius:20px;background:rgba(255,255,255,.18);display:grid;place-items:center">${IC[i].replace('class="icon"','class="icon" style="width:32px;height:32px"')}</span>`).join('')}</div>`, bg:'linear-gradient(180deg,#3E9B4F,#23603F)',
    chips:()=>[t('tut.decide.chip1'),t('tut.decide.chip2'),t('tut.decide.chip3'),t('tut.decide.chip4')] },
  { id:'watch', art:()=>`<div style="display:flex;gap:10px">${['healthy','drought','overwater','lownutrients'].map(s=>`<span style="width:54px;height:54px;border-radius:16px;background:${STATES[s].color};color:#fff;display:grid;place-items:center">${IC[STATES[s].ic]}</span>`).join('')}</div>`, bg:'linear-gradient(180deg,#FBF0D6,#F3E8D2)',
    chips:()=>[t('tut.watch.chip1'),t('tut.watch.chip2'),t('tut.watch.chip3')] },
];
let tutStep = 0;
function openTutorial(step=0){ tutStep = step; renderTut(); openOv('ov-tut'); }
function maybeFirstTutorial(){
  if(readJSON(KEYS.tutorial)) return;
  writeJSON(KEYS.tutorial, true);
  openTutorial(0);
}
function renderTut(){
  const T = TUT[tutStep], last = tutStep===TUT.length-1;
  $('tut').innerHTML = `
    <div class="tut-art" style="background:${T.bg}">${T.art()}</div>
    <div class="tut-step">${esc(t('tut.step',{ n:tutStep+1, total:TUT.length }))}</div>
    <h2 id="tut-title">${esc(t(`tut.${T.id}.title`))}</h2><p>${esc(t(`tut.${T.id}.body`))}</p>
    <div class="tut-mini">${T.chips().map(c=>`<span>${esc(c)}</span>`).join('')}</div>
    <div class="tut-nav">
      <button class="btn btn-ghost" type="button" id="tut-skip">${tutStep===0 ? esc(t('actions.skip')) : IC.arrow.replace('<path d="M5 12h14M13 6l6 6-6 6"/>','<path d="M19 12H5M11 6l-6 6 6 6"/>')+esc(t('actions.back'))}</button>
      <div class="dots">${TUT.map((_,k)=>`<i class="${k===tutStep?'on':''}"></i>`).join('')}</div>
      <button class="btn btn-primary" type="button" id="tut-next">${esc(last ? t('actions.startFarming') : t('actions.next'))} ${IC.arrow}</button>
    </div>`;
  $('tut-skip').onclick = ()=>{ if(tutStep===0) closeOv('ov-tut'); else { tutStep--; renderTut(); $('tut-skip').focus(); } };
  $('tut-next').onclick = ()=>{ if(last) closeOv('ov-tut'); else { tutStep++; renderTut(); $('tut-next').focus(); } };
}
/* =========================================================
   PREFERENCE CONTROLS (header dropdowns + mobile menu)
   State lives in FarmPrefs; these controls only render it.
   ========================================================= */
const langName = code => t(code==='ru' ? 'language.russian' : 'language.english');
const PREF_KINDS = {
  language: {
    options: FarmPrefs.LANGUAGE_PREFERENCES,
    current: ()=>FarmPrefs.get().languagePreference,
    set: v=>FarmPrefs.setLanguagePreference(v),
    labelKey: 'language.label',
    buttonKey: 'language.button',
    buttonIcon: ()=>IC.globe,
    optionIcon: v=> v==='system' ? IC.monitor : v.toUpperCase(),
    optionLabel: v=> v==='system' ? t('language.system') : langName(v),
    optionHint: v=> v==='system' ? langName(FarmPrefs.systemLanguage()) : '',
    value: ()=>{ const s=FarmPrefs.get(); return s.languagePreference==='system' ? t('language.systemResolved',{lang:langName(s.resolvedLanguage)}) : langName(s.languagePreference); },
  },
  theme: {
    options: FarmPrefs.THEME_PREFERENCES,
    current: ()=>FarmPrefs.get().themePreference,
    set: v=>FarmPrefs.setThemePreference(v),
    labelKey: 'theme.label',
    buttonKey: 'theme.button',
    buttonIcon: ()=>IC[{system:'monitor',light:'sun',dark:'moon'}[FarmPrefs.get().themePreference]],
    optionIcon: v=>IC[{system:'monitor',light:'sun',dark:'moon'}[v]],
    optionLabel: v=> t('theme.'+v),
    optionHint: v=> v==='system' ? t('theme.'+FarmPrefs.systemTheme()) : '',
    value: ()=>{ const s=FarmPrefs.get(); return s.themePreference==='system' ? t('theme.systemResolved',{theme:t('theme.'+s.resolvedTheme)}) : t('theme.'+s.themePreference); },
  },
};
const prefControls = [];
let openPref = null, prefSeq = 0;

function createPref(kind, block){
  const K = PREF_KINDS[kind], uid = `pref-${kind}-${++prefSeq}`;
  const root = document.createElement('div');
  root.className = 'pref' + (block ? ' block' : '');
  root.innerHTML = `
    <button type="button" class="pref-btn${block?'':' tip'}" id="${uid}-btn" aria-haspopup="listbox" aria-expanded="false" aria-controls="${uid}-list">
      <span class="pref-ic"></span><span class="pref-val"></span><span class="chev">${IC.chevron}</span>
    </button>
    <ul class="pref-list" id="${uid}-list" role="listbox" tabindex="-1" hidden>
      ${K.options.map(v=>`<li class="pref-opt" role="option" id="${uid}-${v}" data-value="${v}"><span class="opt-ic"></span><span class="opt-text"><span class="opt-label"></span><small></small></span><span class="tick">${IC.check}</span></li>`).join('')}
    </ul>`;
  const btn = root.querySelector('.pref-btn'), list = root.querySelector('.pref-list');
  const opts = [...list.children];
  const ctl = { kind, root, btn, list, opts, block, active:0, labelId:null };

  ctl.render = ()=>{
    const cur = K.current(), value = K.value();
    btn.querySelector('.pref-ic').innerHTML = K.buttonIcon();
    btn.querySelector('.pref-val').textContent = value;
    btn.setAttribute('aria-label', t(K.buttonKey,{value}));
    if(!block) btn.dataset.tip = t(K.labelKey);
    if(ctl.labelId) list.setAttribute('aria-labelledby', ctl.labelId); else list.setAttribute('aria-label', t(K.labelKey));
    opts.forEach(o=>{
      const v=o.dataset.value;
      o.setAttribute('aria-selected', v===cur);
      o.querySelector('.opt-ic').innerHTML = K.optionIcon(v);
      o.querySelector('.opt-label').textContent = K.optionLabel(v);
      const hint = K.optionHint(v), sm=o.querySelector('small');
      sm.textContent = hint; sm.hidden = !hint;
    });
  };
  const setActive = i=>{
    ctl.active = (i + opts.length) % opts.length;
    opts.forEach((o,k)=>o.classList.toggle('active', k===ctl.active));
    list.setAttribute('aria-activedescendant', opts[ctl.active].id);
    opts[ctl.active].scrollIntoView({block:'nearest'});
  };
  ctl.open = ()=>{
    if(openPref && openPref!==ctl) openPref.close(false);
    list.hidden = false; btn.setAttribute('aria-expanded','true'); openPref = ctl;
    setActive(Math.max(0, K.options.indexOf(K.current())));
    list.focus({preventScroll:true});
  };
  ctl.close = (refocus=true)=>{
    if(list.hidden) return;
    list.hidden = true; btn.setAttribute('aria-expanded','false');
    list.removeAttribute('aria-activedescendant');
    if(openPref===ctl) openPref = null;
    if(refocus) btn.focus();
  };
  const choose = i=>{ const v=opts[i].dataset.value; ctl.close(true); if(v!==K.current()) K.set(v); };

  btn.addEventListener('click', ()=> list.hidden ? ctl.open() : ctl.close());
  btn.addEventListener('keydown', e=>{
    if(e.key==='ArrowDown' || e.key==='ArrowUp'){ e.preventDefault(); ctl.open(); if(e.key==='ArrowUp') setActive(opts.length-1); }
  });
  list.addEventListener('keydown', e=>{
    switch(e.key){
      case 'ArrowDown': e.preventDefault(); setActive(ctl.active+1); break;
      case 'ArrowUp': e.preventDefault(); setActive(ctl.active-1); break;
      case 'Home': e.preventDefault(); setActive(0); break;
      case 'End': e.preventDefault(); setActive(opts.length-1); break;
      case 'Enter': case ' ': e.preventDefault(); choose(ctl.active); break;
      case 'Escape': e.preventDefault(); e.stopPropagation(); ctl.close(true); break;
      case 'Tab': ctl.close(false); break;
    }
  });
  list.addEventListener('click', e=>{ const o=e.target.closest('.pref-opt'); if(o) choose(opts.indexOf(o)); });
  list.addEventListener('pointermove', e=>{ const o=e.target.closest('.pref-opt'); if(o) setActive(opts.indexOf(o)); });
  root.addEventListener('focusout', e=>{ if(!list.hidden && !root.contains(e.relatedTarget)) ctl.close(false); });

  prefControls.push(ctl);
  ctl.render();
  return ctl;
}
function mountPrefs(){
  document.querySelectorAll('[data-prefs="compact"]').forEach(host=>{
    host.append(createPref('language',false).root, createPref('theme',false).root);
  });
  document.querySelectorAll('[data-prefs="menu"]').forEach(host=>{
    ['language','theme'].forEach(kind=>{
      const field = document.createElement('div'); field.className='menu-field';
      const label = document.createElement('span'); label.className='menu-label'; label.id=`${host.id}-${kind}-label`;
      label.dataset.i18n = PREF_KINDS[kind].labelKey; label.textContent = t(PREF_KINDS[kind].labelKey);
      const ctl = createPref(kind,true); ctl.labelId = label.id; ctl.render();
      field.append(label, ctl.root); host.append(field);
    });
    host.addEventListener('keydown', e=>{
      if(e.key!=='Escape' || openPref) return;
      const btn=document.querySelector(`[data-menu-toggle][aria-controls="${host.id}"]`);
      setMenu(btn,false); btn.focus();
    });
  });
  document.querySelectorAll('[data-menu-toggle]').forEach(btn=>{
    setMenu(btn,false);
    btn.addEventListener('click', ()=>setMenu(btn, btn.getAttribute('aria-expanded')!=='true'));
  });
  document.addEventListener('pointerdown', e=>{ if(openPref && !openPref.root.contains(e.target)) openPref.close(false); });
}
function setMenu(btn, open){
  const menu=$(btn.getAttribute('aria-controls'));
  menu.classList.toggle('open', open);
  btn.setAttribute('aria-expanded', open);
  btn.setAttribute('aria-label', t(open?'menu.close':'menu.open'));
  btn.innerHTML = IC[open?'x':'menu'];
  if(!open && openPref && menu.contains(openPref.root)) openPref.close(false);
}
function renderPrefs(){
  prefControls.forEach(c=>c.render());
  document.querySelectorAll('[data-menu-toggle]').forEach(btn=>btn.setAttribute('aria-label', t(btn.getAttribute('aria-expanded')==='true'?'menu.close':'menu.open')));
}

/* =========================================================
   LANGUAGE CHANGES: re-render everything visible
   ========================================================= */
function applyLanguage(){
  LANG = FarmPrefs.get().resolvedLanguage;
  applyStaticI18n();
  if(screen==='loading') $('loading-title').textContent = t(bootStage==='config' ? 'loading.connect' : 'loading.title');
  if(screen==='location' && draft) renderLocation();
  if(screen==='levels' && archive) renderLevels();
  if(screen==='error') renderError();
  if(screen==='game' && game) renderGame();
  if(ovOpen('ov-level') && brief) renderBrief();
  if(ovOpen('ov-report') && pending) renderReport();
  if(ovOpen('ov-whatif') && whatIf) renderWhatIf();
  if(ovOpen('ov-tut')) renderTut();
  if($('banner').classList.contains('show') && lastEval) renderBanner();
  if(screen==='final' && lastEval) renderResult();
  if(screen==='farm') renderFarm();
  renderPrefs();
}
FarmPrefs.subscribe((state, change)=>{ if(change.language) applyLanguage(); else renderPrefs(); });
// The system theme can change without the preference changing (option hint "System · Dark").
try{ window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', renderPrefs); }catch(e){ /* old browsers */ }
window.addEventListener('languagechange', renderPrefs);

/* =========================================================
   EVENTS
   ========================================================= */
document.addEventListener('click', e=>{
  const b = e.target.closest('button');
  if(!b || b.disabled) return;
  const ds = b.dataset;
  if(phase==='plan' && game && screen==='game'){
    for(const field of R.DECISION_FIELDS){
      if(ds[field]){ decision = { ...decision, [field]:ds[field] }; game.error = null; renderControls(); if(field==='crop') renderPlants(); return; }
    }
  }
  if(screen==='location' && draft){
    if(ds.soil){ draft.soil = ds.soil; draft.message = ''; renderSoilPick(); renderSetupCheck(); return; }
    if(ds.preset){
      const p = presetById(ds.preset);
      draft.start_md = p.start_md; draft.end_md = p.end_md; if(!draft.soil) draft.soil = p.soil;
      setDraftPlace(p, { preset:p.id }); return;
    }
    if(ds.result!==undefined && searchResults){
      const p = searchResults[Number(ds.result)];
      setDraftPlace(p, { name:p.name, admin1:p.admin1 || null, country:p.country || null }); return;
    }
  }
  if(ds.year && brief){ brief = { ...brief, year:Number(ds.year), error:null }; renderBrief(); const y = $('brief').querySelector(`[data-year="${ds.year}"]`); if(y) y.focus(); return; }
  if(ds.level){ openBrief(Number(ds.level)); }
});
['per-start-m','per-start-d','per-end-m','per-end-d'].forEach(id=>$(id).addEventListener('input', ()=>{ if(!draft) return; readPeriodInputs(); draft.message=''; renderSetupCheck(); }));
$('btn-load').onclick = confirmFarm;
$('btn-confirm').onclick = confirmDecision;
$('btn-help').onclick = ()=>openTutorial(0);
$('btn-help-levels').onclick = ()=>openTutorial(0);
$('btn-pause').onclick = pauseGame;
$('btn-resume').onclick = resumeGame;
$('btn-pause-help').onclick = ()=>{ resumeGame(); openTutorial(0); };
$('btn-pause-levels').onclick = ()=>{ if(!leaveLevelConfirmed()) return; showLevels(); };
$('btn-restart').onclick = ()=>{ if(!leaveLevelConfirmed()) return; const id = game.level.id, y = game.year; showLevels(); brief = { levelId:id, year:y, error:null, busy:false }; startLevel(id, y); };
$('btn-retry').onclick = ()=>{ if(bootStage==='config' || !model) boot(); else loadArchive(); };
$('btn-demo').onclick = useDemo;
$('btn-err-location').onclick = ()=>showLocation();
$('btn-refresh').onclick = ()=>{ demoMode = false; loadArchive(); };
$('btn-change-location').onclick = ()=>showLocation();
$('btn-farm-report').onclick = showFarm;
$('view-farm').onclick = ()=>setView(false);
$('view-sat').onclick = ()=>setView(true);
$('loc-search').addEventListener('submit', e=>{ e.preventDefault(); searchPlaces($('loc-q').value); });
$('loc-manual').addEventListener('submit', e=>{
  e.preventDefault();
  const la = $('loc-lat').value.trim().replace(',', '.'), lo = $('loc-lon').value.trim().replace(',', '.');
  const ok = FarmData.validCoordinates(la, lo);
  $('loc-lat').setAttribute('aria-invalid', String(!ok)); $('loc-lon').setAttribute('aria-invalid', String(!ok));
  const msg = $('loc-manual-msg');
  msg.classList.toggle('err', !ok);
  msg.textContent = t(ok ? 'location.manualHint' : 'location.invalid');
  if(ok) setDraftPlace({ latitude:Number(la), longitude:Number(lo) }, {});
});
document.addEventListener('keydown', e=>{
  if(e.key!=='Escape') return;
  if(ovOpen('ov-whatif')) closeOv('ov-whatif');
  else if(ovOpen('ov-tut')) closeOv('ov-tut');
  else if(ovOpen('ov-level')) closeOv('ov-level');
  else if(ovOpen('ov-pause')) resumeGame();
});
window.addEventListener('offline', ()=>toast(IC.alert + esc(t('toast.offline')), 6000));
window.addEventListener('online', ()=>toast(IC.check + esc(t('toast.online'))));

/* =========================================================
   INIT
   ========================================================= */
applyStaticI18n();
hydrateIcons();
mountPrefs();
(function rain(){ let h=''; for(let k=0;k<60;k++) h+=`<span style="left:${(k*37%110)}%;animation-duration:${(.6+(k*13%50)/100).toFixed(2)}s;animation-delay:${(-(k*29%200)/100).toFixed(2)}s"></span>`; $('rain').innerHTML=h; })();
buildField();
boot();

})();
