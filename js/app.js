/* =========================================================
   Farm Navigator — UI controller
   Game rules live in js/engine.js (FarmEngine), NASA data loading in
   js/nasa-client.js (FarmData), language/theme in the inline FarmPrefs.
   This file only renders state and wires up the controls.
   ========================================================= */
(function () {
'use strict';

const E = FarmEngine;
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
  if(s == null){ console.error(`[i18n] unknown key "${key}"`); return ''; }
  return vars ? s.replace(/\{\{(\w+)\}\}/g, (m,k)=> k in vars ? vars[k] : m) : s;
}
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
function fmtDate(iso){
  if(!iso) return '';
  const d = new Date(iso.length<=10 ? iso+'T00:00:00' : iso);
  return isNaN(d.getTime()) ? iso : d.toLocaleDateString(locale(), { day:'numeric', month:'short', year:'numeric' });
}

/* =========================================================
   SAVED STATE (localStorage, all access guarded)
   ========================================================= */
const KEYS = { progress:'farm-navigator.progress.v1', place:'farm-navigator.location.v1', tutorial:'farm-navigator.tutorial.v1' };
function readJSON(key){ try{ const v = localStorage.getItem(key); return v ? JSON.parse(v) : null; }catch(e){ return null; } }
function writeJSON(key, v){ try{ localStorage.setItem(key, JSON.stringify(v)); }catch(e){ /* private mode or full */ } }
function readPlace(){
  const p = readJSON(KEYS.place);
  return p && FarmData.validCoordinates(p.latitude, p.longitude) ? p : null;
}
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
  if(run && run.results.length) return run.results[run.results.length-1].decision.crop;
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
const PRESETS = [
  { preset:'kansas', latitude:38.84, longitude:-97.61 },
  { preset:'almaty', latitude:43.25, longitude:76.91 },
  { preset:'kyiv', latitude:50.45, longitude:30.52 },
  { preset:'delhi', latitude:28.61, longitude:77.21 },
  { preset:'nairobi', latitude:-1.29, longitude:36.82 },
  { preset:'pergamino', latitude:-33.89, longitude:-60.57 },
];
const LEVEL_COLORS = ['#3E9B4F','#1E6FD9','#8C5E3C','#D0632A','#2A8FA8','#C9971B','#7A5AA6'];
const LEVEL_ICONS = ['sprout','drop','soil','heat','rain','coin','globe'];
const STATES = {
  planning:     { color:'#6D8A5E', ic:'sprout' },
  healthy:      { color:'#3E9B4F', ic:'leaf' },
  drought:      { color:'#D07A1E', ic:'heat' },
  heatstress:   { color:'#D0632A', ic:'thermo' },
  overwater:    { color:'#1E6FD9', ic:'rain' },
  lownutrients: { color:'#7A5AA6', ic:'soil' },
  disease:      { color:'#8A6D3B', ic:'alert' },
  harvest:      { color:'#C9971B', ic:'basket' },
  failed:       { color:'#8E2A1F', ic:'x' },
};
const WEATHER_IC = { showers:'rain', heat:'heat', rain:'rain', clear:'sun', cloudy:'cloud' };
const FERT_UI = { none:{ ic:'none', bg:'#B7A68A' }, compost:{ ic:'compost', bg:'#8C5E3C' }, synthetic:{ ic:'flask', bg:'#7A5AA6' }, green:{ ic:'legume', bg:'#3E9B4F' } };
const PROT_UI = { none:{ ic:'none', bg:'#B7A68A' }, mulch:{ ic:'mulch', bg:'#A07A52' }, cover:{ ic:'shield', bg:'#2E8B3E' } };

let progress = E.sanitizeProgress(readJSON(KEYS.progress));
let place = readPlace();
let climate = null;      // { status: live|cached|demo, origin, data, savedAt, stale }
let run = null;          // engine state of the level being played
let decision = emptyDecision();
let phase = 'idle';      // plan | growing | report | done
let pending = null;      // { prevRun, next, outcome, best } while a season report is shown
let lastEval = null;     // evaluation shown on the level result screen
let briefLevel = null;
let whatIf = null;
let paused = false;
let gameToken = 0;       // invalidates animations when the player leaves a level
let searchResults = null;
let searchState = { key:'', vars:null, err:false };

function emptyDecision(prev){
  return { crop:null, irrigation:null, method: prev && prev.method || 'sprinkler', fertilizer:null, protection:'none' };
}

/* =========================================================
   LABELS
   ========================================================= */
const cropName = id => t(`crops.${id}.name`);
const levelName = level => t(`levels.${level.key}.name`);
const irrName = k => t(`irrigation.${E.IRRIGATION[k].id}`);
const coordsLabel = p => `${dec(Math.abs(p.latitude))}° ${t(p.latitude>=0?'dir.N':'dir.S')}, ${dec(Math.abs(p.longitude))}° ${t(p.longitude>=0?'dir.E':'dir.W')}`;
function placeLabel(p){
  if(!p) return '';
  if(p.preset) return t(`places.${p.preset}`);
  if(p.custom) return t('location.custom', { coords: coordsLabel(p) });
  const parts = [p.name, p.admin1, p.country].filter((x,i,a)=>x && a.indexOf(x)===i);
  return parts.join(', ');
}
const isDemo = () => !climate || climate.status==='demo';
function seasonLabel(s){ return isDemo() ? t('period.demoShort', { n:s.year }) : String(s.year); }
function periodLabel(s){ return isDemo() ? t('period.demo', { n:s.year }) : `${fmtDate(s.start)} – ${fmtDate(s.end)}`; }
function describeDecision(d){
  const parts = [cropName(d.crop)];
  parts.push(d.irrigation ? `${t('describe.irrigation',{ level:irrName(d.irrigation) })} (${t(`methods.${d.method}.name`)})` : t('describe.noIrrigation'));
  parts.push(d.fertilizer==='none' ? t('describe.noFertilizer') : t(`fertilizers.${d.fertilizer}.name`));
  if(d.protection && d.protection!=='none') parts.push(t(`protection.${d.protection}.name`));
  return parts.join(' · ');
}
function goalValue(metric, v){
  switch(metric){
    case 'avgYield': case 'minYield': return `${num(v)}%`;
    case 'reserveEnd': return t('units.points', { n:num(v) });
    case 'fertilityDelta': case 'erosionDelta': return signed(v);
    case 'nLeached': return t('units.kgN', { n:num(v) });
    case 'finalBudget': return fmt$(v);
    default: return num(v);
  }
}
const goalText = g => t(`goal.${g.metric}`, { value: goalValue(g.metric, g.value) });
function statusBadge(){
  if(!climate) return '';
  let label;
  if(climate.status==='live') label = t('status.live');
  else if(climate.status==='demo') label = t('status.demo');
  else label = t(climate.stale ? 'status.stale' : 'status.cached', { date: climate.savedAt ? fmtDate(new Date(climate.savedAt).toISOString()) : '' });
  return `<span class="status ${climate.status}" title="${esc(t(`status.${climate.status}Hint`))}"><i></i>${esc(label)}</span>`;
}
function starsSvg(n, total=3){
  const star = on => `<svg viewBox="0 0 24 24" aria-hidden="true"><path class="${on?'star-on':'star-off'}" stroke-width="1.4" stroke-linejoin="round" d="M12 2.8l2.8 5.8 6.3.9-4.6 4.4 1.1 6.3L12 17.2l-5.6 3 1.1-6.3-4.6-4.4 6.3-.9z"/></svg>`;
  return Array.from({ length:total }, (_,k)=>star(k<n)).join('');
}
function toast(msg, ms=3800){
  const el = $('toast'); el.innerHTML = msg; el.classList.add('show');
  clearTimeout(toast.timer); toast.timer = setTimeout(()=>el.classList.remove('show'), ms);
}
const sleep = ms => new Promise(r=>setTimeout(r, ms));
/** Like sleep, but the clock stops while the game is paused. */
function wait(ms){
  return new Promise(resolve=>{
    let left = ms, last = Date.now();
    const tick = ()=>{ const now = Date.now(); if(!paused) left -= now-last; last = now; if(left<=0) resolve(); else setTimeout(tick, 50); };
    setTimeout(tick, 50);
  });
}

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
   LOADING NASA POWER DATA
   ========================================================= */
let loadToken = 0;
async function loadClimate(force=false){
  if(!place){ showLocation(); return; }
  const token = ++loadToken;
  show('loading');
  $('loading-text').textContent = t('loading.text', { place: placeLabel(place) });
  const lis = [...$('boot-steps').children]; let k = 0;
  const paint = ()=>{ lis.forEach((li,i)=>{ li.className = i<k?'done':i===k?'now':''; }); $('boot-bar').style.width = (k/lis.length*100)+'%'; };
  paint();
  const timer = setInterval(()=>{ if(k < lis.length-1){ k++; paint(); } }, 450);
  try{
    const res = await client.loadClimate(place, { force });
    if(token!==loadToken) return;
    climate = res;
    k = lis.length; paint();
    await sleep(300);
    if(token!==loadToken) return;
    if(res.stale) toast(t('toast.staleCache', { reason: t(`error.${res.error && res.error.kind || 'server'}.short`) }), 6000);
    showLevels();
    maybeFirstTutorial();
  }catch(e){
    if(token!==loadToken) return;
    showError(e);
  }finally{
    clearInterval(timer);
  }
}
let lastError = null;
function showError(e){
  lastError = e;
  renderError();
  show('error');
}
function renderError(){
  const kind = lastError && lastError.kind || 'server';
  $('err-title').textContent = t(`error.${kind}.title`);
  $('err-text').textContent = t(`error.${kind}.text`);
  $('err-code').textContent = t('error.code', { kind, status: lastError && lastError.status ? `HTTP ${lastError.status}` : '—' });
}
function useDemo(){
  climate = { status:'demo', origin:'demo', data:E.demoClimate(), savedAt:null, stale:false };
  showLevels();
  maybeFirstTutorial();
}

/* =========================================================
   LOCATION SCREEN
   ========================================================= */
function showLocation(){ renderLocation(); show('location'); scrollTop(); }
function renderLocation(){
  $('loc-presets').innerHTML = PRESETS.map((p,i)=>`
    <button class="place${place && place.preset===p.preset?' current':''}" type="button" data-preset="${i}">
      <span class="pic">${IC.pin}</span><span><b>${esc(t(`places.${p.preset}`))}</b><small>${esc(t(`places.${p.preset}.note`))} · ${coordsLabel(p)}</small></span>
    </button>`).join('');
  $('loc-results').innerHTML = (searchResults||[]).map((p,i)=>`
    <button class="place" type="button" data-result="${i}">
      <span class="pic">${IC.pin}</span><span><b>${esc(p.name)}</b><small>${esc([p.admin1,p.country].filter(Boolean).join(', '))} · ${coordsLabel(p)}</small></span>
    </button>`).join('');
  const msg = $('loc-msg');
  msg.textContent = searchState.key ? t(searchState.key, searchState.vars) : '';
  msg.classList.toggle('err', searchState.err);
  $('loc-current').innerHTML = place ? `
    <div class="place current" style="cursor:default"><span class="pic">${IC.check}</span>
      <span><b>${esc(t('location.current'))}: ${esc(placeLabel(place))}</b><small>${coordsLabel(place)}</small></span></div>
    <div class="boot-actions" style="justify-content:flex-start;margin-top:10px">
      <button class="btn btn-primary" type="button" id="btn-loc-continue">${IC.arrow} ${esc(t('actions.continue'))}</button></div>` : '';
  if(place) $('btn-loc-continue').onclick = ()=> climate && climate.status!=='demo' ? showLevels() : loadClimate(false);
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
    searchState = { key:`location.err.${e.kind || 'server'}`, vars:null, err:true };
  }
  renderLocation();
}
function choosePlace(p){
  place = p; writeJSON(KEYS.place, p);
  climate = null; run = null;
  loadClimate(false);
}

/* =========================================================
   LEVEL SELECT
   ========================================================= */
function showLevels(){ phase = 'idle'; run = null; pending = null; gameToken++; closeAllOv(); renderLevels(); show('levels'); scrollTop(); }
function renderLevels(){
  const demo = isDemo();
  const seasons = climate.data.seasons;
  $('lv-place').textContent = demo ? t('levels.demoPlace') : placeLabel(place);
  $('lv-coords').textContent = demo ? t('levels.demoNote')
    : `${coordsLabel(place)} · ${t('levels.seasons', { months: t(`months.${climate.data.hemisphere || 'north'}`), from: seasons[0].year, to: seasons[seasons.length-1].year })}`;
  $('lv-status').innerHTML = statusBadge();
  $('btn-refresh').hidden = !place;
  $('btn-refresh').lastElementChild.textContent = t(demo ? 'actions.loadNasa' : 'actions.refresh');
  $('lv-intro').textContent = t('levels.intro');
  $('level-grid').innerHTML = E.LEVELS.map((level,i)=>{
    const unlocked = E.isUnlocked(progress, level.id);
    const best = progress.best[level.id];
    const picked = E.pickSeasons(climate.data, level);
    return `<article class="card level${unlocked?'':' locked'}">
      <div class="level-top"><span class="num" style="background:${LEVEL_COLORS[i]}">${level.id}</span>
        <div><h3>${esc(levelName(level))}</h3><span class="best">${esc(t('levels.difficulty', { n:level.id }))}</span></div></div>
      <p>${esc(t(`levels.${level.key}.short`))}</p>
      <div class="chips">${picked.map(p=>`<span class="chip-s">${esc(seasonLabel(p.season))} · ${esc(t(`pick.${p.pickedAs}`))}</span>`).join('')}</div>
      <div class="foot">
        <div><div class="mini-stars" role="img" aria-label="${esc(t('levels.starsAria', { n: best ? best.stars : 0 }))}">${starsSvg(best ? best.stars : 0)}</div>
          ${best ? `<span class="best">${esc(t(best.passed ? 'levels.best' : 'levels.notPassed', { score:best.score }))}</span>` : ''}</div>
        <button class="btn ${unlocked?'btn-primary':''}" type="button" data-level="${level.id}" ${unlocked?'':'disabled'}>
          ${unlocked ? (best ? IC.refresh + esc(t('actions.replay')) : IC.play + esc(t('actions.play'))) : IC.lock + esc(t('levels.locked'))}</button>
      </div>
      ${unlocked ? '' : `<p class="best">${esc(t('levels.unlockHint', { n:level.id-1 }))}</p>`}
    </article>`;
  }).join('');
  $('btn-farm-report').disabled = !Object.keys(progress.best).length;
}

/* =========================================================
   LEVEL BRIEF
   ========================================================= */
function openBrief(id){ briefLevel = id; renderBrief(); openOv('ov-level'); }
function renderBrief(){
  const level = E.levelById(briefLevel), start = level.start;
  const picked = E.pickSeasons(climate.data, level);
  const b = climate.data.baseline;
  $('brief').innerHTML = `
    <div class="eyebrow">${esc(t('brief.eyebrow', { n:level.id, total:E.LEVELS.length }))}</div>
    <h2 id="brief-title">${esc(levelName(level))}</h2>
    <p class="story">${esc(t(`levels.${level.key}.story`))}</p>
    <div><h3>${esc(t('brief.goal'))}</h3><ul class="goal-list">${level.goals.map(g=>`<li><span class="gi">${IC.flag}</span>${esc(goalText(g))}</li>`).join('')}</ul></div>
    <div><h3>${esc(t('brief.seasons', { n:picked.length }))}</h3><div class="season-rows">${picked.map(p=>{
      const s = p.season, ev = E.seasonEvents(s, b);
      return `<div class="season-row"><b>${esc(periodLabel(s))}</b><span>· ${esc(t(`pick.${p.pickedAs}`))}</span>
        <span>· ${dec1(s.temperature_c)} °C · ${num(s.rainfall_mm)} mm</span>${ev.map(e=>`<span class="ev ${e.type}">${esc(t(`events.${e.type}`))}</span>`).join('')}</div>`;
    }).join('')}</div></div>
    <div><h3>${esc(t('brief.start'))}</h3><div class="kv">
      <div><small>${esc(t('meters.budget'))}</small><b>${fmt$(start.budget)}</b></div>
      <div><small>${esc(t('meters.water'))}</small><b>${num(start.reserve)}%</b></div>
      <div><small>${esc(t('meters.fertility'))}</small><b>${num(E.fertility(start.soil))}</b></div>
      <div><small>${esc(t('soil.n'))}</small><b>${num(start.soil.n)}</b></div>
      <div><small>${esc(t('brief.previous'))}</small><b style="font-size:15px">${esc(start.history.length ? start.history.map(cropName).join(' → ') : '—')}</b></div>
    </div></div>
    <p class="rules"><b>${esc(t('brief.winLabel'))}</b> ${esc(t('brief.win'))}<br><b>${esc(t('brief.loseLabel'))}</b> ${esc(t('brief.lose', { min: fmt$(E.MODEL.MIN_SEED_COST) }))}</p>
    ${isDemo() ? `<p class="rules">${esc(t('brief.demo'))}</p>` : ''}
    <div class="brief-foot">
      <button class="btn btn-ghost" type="button" id="brief-cancel">${esc(t('actions.back'))}</button>
      <button class="btn btn-primary btn-lg" type="button" id="brief-start" data-autofocus>${IC.play} ${esc(t('actions.startLevel'))}</button>
    </div>`;
  $('brief-cancel').onclick = ()=>closeOv('ov-level');
  $('brief-start').onclick = ()=>{ closeOv('ov-level'); startLevel(briefLevel); };
}

/* =========================================================
   GAME
   ========================================================= */
function startLevel(id){
  gameToken++;
  run = E.createRun(id, climate.data);
  decision = emptyDecision();
  phase = 'plan'; pending = null; paused = false;
  closeAllOv(); setView(false);
  renderGame();
  setFieldState('planning', weatherFor(currentSeason()));
  show('game'); scrollTop();
}
const currentSeason = () => run.seasons[Math.min(run.seasonIndex, run.seasons.length-1)];
/** While a season report is open, panels still describe the season that was just played. */
const shownRun = () => pending ? pending.prevRun : run;

function renderGame(){
  renderTop(); renderControls(); renderData(); renderSoil(pending ? pending.next : run); renderMeters(pending ? pending.next : run);
  renderPlants(); renderFieldLabels();
}
function renderTop(){
  const r = shownRun(), level = E.levelById(r.levelId), idx = Math.min(r.seasonIndex, r.seasons.length-1);
  $('season-name').textContent = t('game.levelTitle', { n:level.id, name:levelName(level) });
  $('season-count').textContent = t('game.seasonCount', { n:idx+1, total:r.seasons.length, season:seasonLabel(r.seasons[idx]) });
  $('season-ic').innerHTML = IC[LEVEL_ICONS[level.id-1]];
  $('season-dots').innerHTML = r.seasons.map((_,k)=>`<i class="${k<r.seasonIndex?'done':k===r.seasonIndex?'now':''}"></i>`).join('');
  $('mission-text').textContent = level.goals.map(goalText).join(' · ');
}

function renderControls(){
  const r = shownRun(), s = r.seasons[Math.min(r.seasonIndex, r.seasons.length-1)];
  const locked = phase!=='plan';
  const prev = r.cropHistory[r.cropHistory.length-1];
  // 1. crops
  $('crop-grid').innerHTML = E.CROP_IDS.map(id=>{
    const c = E.CROPS[id];
    let tag = `<span class="tag ${c.legume?'leg':c.droughtTolerant?'tol':''}">${esc(t(`crops.${id}.tag`))}</span>`;
    if(prev===id) tag = `<span class="tag warn">${esc(t('decisions.tagRepeat'))}</span>`;
    else if(prev && E.CROPS[prev].legume && !c.legume) tag = `<span class="tag leg">${esc(t('decisions.tagLegumeCredit'))}</span>`;
    return `<button class="crop" type="button" data-crop="${id}" aria-pressed="${decision.crop===id}" ${locked?'disabled':''}>
      ${cropIcon(id)}<b>${esc(cropName(id))}</b>
      <span class="meta"><span class="drops" role="img" aria-label="${esc(t('decisions.waterNeed',{ n:c.drops }))}">${[1,2,3].map(k=>`<span class="${k<=c.drops?'':'off'}">${IC.dropFill}</span>`).join('')}</span>${fmt$(c.seed)}</span>
      ${tag}
    </button>`;
  }).join('');
  const c = decision.crop && E.CROPS[decision.crop];
  $('crop-note').textContent = c ? t('decisions.likes', { min:c.temp[0], max:c.temp[1] }) : prev ? t('decisions.lastCrop', { crop:cropName(prev) }) : '';
  // 2. irrigation
  const method = decision.method || 'sprinkler';
  $('irr-seg').innerHTML = E.IRRIGATION.map((o,k)=>{
    const need = E.reserveNeed({ crop:'wheat', irrigation:k, method, fertilizer:'none' });
    const dis = locked || need > r.reserve;
    return `<button type="button" data-irr="${k}" aria-pressed="${decision.irrigation===k}" ${dis?'disabled':''}><span class="drops">${k===0?IC.none:Array.from({ length:k },()=>IC.dropFill).join('')}</span>${esc(t(`irrigation.${o.id}`))}</button>`;
  }).join('');
  $('irr-method').innerHTML = Object.keys(E.METHODS).map(m=>{
    const need = E.reserveNeed({ crop:'wheat', irrigation:decision.irrigation || 0, method:m, fertilizer:'none' });
    const dis = locked || !decision.irrigation || need > r.reserve;
    return `<button type="button" data-method="${m}" aria-pressed="${method===m}" ${dis?'disabled':''}>${esc(t(`methods.${m}.name`))}<small>${esc(t(`methods.${m}.desc`, { cost:fmt$(E.METHODS.drip.extraCost) }))}</small></button>`;
  }).join('');
  $('reserve-note').textContent = t('decisions.reserve', { pct:r.reserve });
  if(decision.irrigation===null) $('irr-hint').innerHTML = esc(t('irrigation.hintChoose'));
  else if(decision.irrigation===0) $('irr-hint').innerHTML = t('irrigation.hintNone');
  else {
    const o = E.IRRIGATION[decision.irrigation];
    const loss = method==='drip' ? E.METHODS.drip.loss : E.sprinklerLoss(s);
    $('irr-hint').innerHTML = t('irrigation.hintAdds', { mm:num(o.mm*(1-loss)), pts:E.reserveNeed(decision), loss:num(loss*100) });
  }
  // 3. fertilizer, 4. soil protection
  $('fert-list').innerHTML = Object.entries(E.FERTILIZERS).map(([id,f])=>optionButton('fert', id, FERT_UI[id], t(`fertilizers.${id}.name`), t(`fertilizers.${id}.desc`), f.cost, decision.fertilizer===id, locked)).join('');
  $('prot-list').innerHTML = Object.entries(E.PROTECTION).map(([id,p])=>optionButton('prot', id, PROT_UI[id], t(`protection.${id}.name`), t(`protection.${id}.desc`), p.cost, decision.protection===id, locked)).join('');
  // summary
  const rows = [];
  if(c) rows.push([t('plan.seeds', { crop:cropName(decision.crop) }), c.seed]);
  if(decision.irrigation) rows.push([t('plan.irrigation', { level:irrName(decision.irrigation) }), E.IRRIGATION[decision.irrigation].cost + (method==='drip' ? E.METHODS.drip.extraCost : 0)]);
  if(decision.fertilizer && decision.fertilizer!=='none') rows.push([t('plan.fertilizer', { name:t(`fertilizers.${decision.fertilizer}.name`) }), E.FERTILIZERS[decision.fertilizer].cost]);
  if(decision.protection!=='none') rows.push([t('plan.protection', { name:t(`protection.${decision.protection}.name`) }), E.PROTECTION[decision.protection].cost]);
  const cost = E.planCost(decision);
  $('plan-sum').innerHTML = rows.map(([l,v])=>`<div><span>${esc(l)}</span><span>${fmt$(v)}</span></div>`).join('')
    + `<div class="total"><span>${esc(t('plan.total'))}</span><span>${fmt$(cost)}</span></div>`
    + `<div><span>${esc(t('plan.budgetLeft'))}</span><span>${fmt$(r.budget - cost)}</span></div>`;
  // validation
  const check = E.validateDecision(r, decision);
  const msgs = [];
  if(check.missing.length) msgs.push(t('decisions.missing', { list: check.missing.map(k=>t(`decisions.missing.${k}`)).join(', ') }));
  if(check.errors.includes('budget')) msgs.push(t('plan.noBudget'));
  if(check.errors.includes('reserve')) msgs.push(t('plan.noReserve'));
  $('missing').textContent = msgs.join(' ');
  $('missing').classList.toggle('show', !locked && msgs.length>0);
  $('btn-confirm').disabled = locked || !check.ok;
  $('btn-confirm').innerHTML = IC.check + esc(phase==='plan' ? t('actions.confirmGrow', { season:seasonLabel(s) }) : phase==='done' ? t('actions.levelOver') : t('actions.inProgress'));
}
function optionButton(kind, id, ui, name, desc, cost, pressed, locked){
  return `<button class="fert" type="button" data-${kind}="${id}" aria-pressed="${pressed}" ${locked?'disabled':''}>
    <span class="fic" style="background:${ui.bg};color:#fff">${IC[ui.ic]}</span>
    <span><b>${esc(name)}</b><small>${esc(desc)}</small></span><span class="cost">${cost?fmt$(cost):esc(t('fertilizers.free'))}</span>
  </button>`;
}

function gauge(val,min,max,avg,grad,labels){
  const p = v=>Math.max(0, Math.min(100, (v-min)/(max-min)*100));
  return `<div class="gauge" style="background:${grad}"><span class="avg" style="left:${p(avg)}%" title="${esc(t('data.average10'))}"></span><span class="mk" style="left:${p(val)}%"></span></div>
    <div class="gauge-labels">${labels.map(l=>`<span>${esc(l)}</span>`).join('')}</div>`;
}
function renderData(){
  const r = shownRun(), s = r.seasons[Math.min(r.seasonIndex, r.seasons.length-1)], b = r.baseline;
  const picked = r.pickedAs[Math.min(r.seasonIndex, r.seasons.length-1)];
  $('nasa-sub').textContent = periodLabel(s);
  $('nasa-status').innerHTML = statusBadge();
  const events = E.seasonEvents(s, b, r.reserve);
  $('events').innerHTML = events.length
    ? events.map(e=>`<span class="ev ${e.type}">${IC[{ drought:'heat', heat:'thermo', downpour:'rain', waterDeficit:'drop' }[e.type]]}${esc(t(`events.${e.type}`))} · ${esc(t(`severity.${e.severity}`))}</span>`).join('')
    : `<span class="ev calm">${IC.check}${esc(t('events.none'))}</span>`;
  const chip = (cls,key)=>[cls, t('data.chip.'+key)];
  const dT = s.temperature_c - b.temperature_c;
  const rP = b.rainfall_mm ? Math.round((s.rainfall_mm - b.rainfall_mm)/b.rainfall_mm*100) : 0;
  const dH = s.humidity_percent - b.humidity_percent, dW = s.wind_speed_m_s - b.wind_speed_m_s, dS = s.solar_radiation_mj_m2_day - b.solar_radiation_mj_m2_day;
  const tChip = dT>1?chip('hot','hot'):dT>0.5?chip('warm','warm'):dT<-1?chip('cool','cool'):chip('ok','normal');
  const rChip = rP<-30?chip('dry','veryDry'):rP<-10?chip('warm','belowNormal'):rP>30?chip('wet','wet'):rP>10?chip('wet','aboveNormal'):chip('ok','normal');
  const hChip = s.humidity_percent<40?chip('dry','dryAir'):s.humidity_percent>70?chip('wet','humid'):chip('ok','normal');
  const wChip = s.wind_speed_m_s>4?chip('warm','windy'):chip('ok','calm');
  const sChip = s.solar_radiation_mj_m2_day<15?chip('cool','cloudy'):s.solar_radiation_mj_m2_day>24?chip('warm','sunny'):chip('ok','normal');
  const item=(ic,bg,title,ch,val,unit,anom,g,code,src)=>`<div class="datum">
      <div class="datum-top"><span class="dic" style="background:${bg}">${IC[ic]}</span><h3>${esc(title)}</h3><span class="chip ${ch[0]}">${esc(ch[1])}</span></div>
      <div class="datum-val"><b>${val}</b><span>${esc(unit)}</span><em>${esc(anom)}</em></div>${g}<div class="src">${code} · ${esc(src)}</div></div>`;
  const rainMax = Math.max(200, Math.ceil(b.rainfall_mm*2/100)*100);
  $('data-list').innerHTML =
    item('thermo','#D0632A',t('data.temperature'),tChip,dec1(s.temperature_c),'°C',t('data.vsNormal',{ value:`${signed(+dT.toFixed(1), dec1)} °C` }),
      gauge(s.temperature_c,0,40,b.temperature_c,'linear-gradient(90deg,#7DB6F0,#9CD58A 45%,#F3C04E 70%,#E0602F)',['0°','20°','40 °C']),'T2M',t('data.src.temperature'))+
    item('rain','#1E6FD9',t('data.rainfall'),rChip,num(s.rainfall_mm),t('data.unit.rain'),t('data.vsNormal',{ value:`${signed(rP)}%` }),
      gauge(s.rainfall_mm,0,rainMax,b.rainfall_mm,'linear-gradient(90deg,#E9D6B4,#9CC6EE 55%,#1E6FD9)',['0',num(rainMax/2),`${num(rainMax)} mm`]),'PRECTOTCORR',t('data.src.rainfall'))+
    item('humid','#2A8FA8',t('data.humidity'),hChip,num(s.humidity_percent),'%',t('data.vsNormal',{ value:`${signed(Math.round(dH))} pp` }),
      gauge(s.humidity_percent,0,100,b.humidity_percent,'linear-gradient(90deg,#E9C98E,#9CD58A 50%,#6FB4E8)',['0','50','100 %']),'RH2M',t('data.src.humidity'))+
    item('wind','#5A7D8C',t('data.wind'),wChip,dec1(s.wind_speed_m_s),t('data.unit.wind'),t('data.vsNormal',{ value:signed(+dW.toFixed(1), dec1) }),
      gauge(s.wind_speed_m_s,0,8,b.wind_speed_m_s,'linear-gradient(90deg,#CFE6D2,#9CC6EE 50%,#5A7D8C)',['0','4','8 m/s']),'WS2M',t('data.src.wind'))+
    item('sun','#E09A1B',t('data.solar'),sChip,dec1(s.solar_radiation_mj_m2_day),t('data.unit.solar'),t('data.vsNormal',{ value:signed(+dS.toFixed(1), dec1) }),
      gauge(s.solar_radiation_mj_m2_day,5,30,b.solar_radiation_mj_m2_day,'linear-gradient(90deg,#8E9CA8,#F3E08E 60%,#F9B233)',['5','17','30']),'ALLSKY_SFC_SW_DWN',t('data.src.solar'));
  const df = E.demandFactor(s);
  const lines = [t('insight.picked', { what:t(`pick.${picked}`) })];
  lines.push(t(df.factor>=1 ? 'insight.demandUp' : 'insight.demandDown', { pct:num(Math.abs(Math.round((df.factor-1)*100))) }));
  events.forEach(e=>lines.push(t(`insight.${e.type}`)));
  if(!events.length) lines.push(t('insight.calm'));
  $('insight').innerHTML = `<b>${IC.bulb} ${esc(t('insight.title'))}</b>${lines.map(esc).join(' ')}`;
  $('obs').innerHTML = isDemo() ? esc(t('obs.demo'))
    : `<strong>${esc(t('obs.place'))}</strong> ${esc(placeLabel(place))} · ${coordsLabel(place)}<br><strong>${esc(t('obs.period'))}</strong> ${esc(periodLabel(s))}<br>${esc(t('obs.note'))}`;
}
function renderSoil(r){
  const soil = r.soil, fert = E.fertility(soil);
  const row = (label, v, invert) => {
    const good = invert ? 100-v : v;
    return `<div class="srow"><span>${esc(label)}</span><div class="bar"><i style="width:${v}%;background:${barColor(good)}"></i></div><span>${num(v)}</span></div>`;
  };
  const hist = r.cropHistory.slice(-4);
  $('soil-card').innerHTML = `<h3>${IC.soil} ${esc(t('soil.title'))}</h3>
    ${row(t('soil.fertility'), fert)}${row(t('soil.moisture'), soil.moisture)}${row(t('soil.n'), soil.n)}${row(t('soil.om'), soil.om)}${row(t('soil.erosion'), soil.erosion, true)}
    <div class="history">${esc(t('soil.history'))} ${hist.length ? hist.map(id=>`<span>${esc(cropName(id))}</span>`).join('→') : esc(t('soil.noHistory'))}</div>`;
}

const METERS = [
  { key:'yield',     ic:'leaf',  bg:'#3E9B4F', unit:'%' },
  { key:'fertility', ic:'soil',  bg:'#8C5E3C', unit:'/100' },
  { key:'moisture',  ic:'humid', bg:'#2A8FA8', unit:'%' },
  { key:'water',     ic:'drop',  bg:'#1E6FD9', unit:'%' },
  { key:'budget',    ic:'coin',  bg:'#C9971B', unit:'' },
];
function barColor(v){ return v>=70?'var(--green-500)':v>=45?'var(--amber-500)':'var(--red-600)'; }
function meterValues(r){
  const last = r.results[r.results.length-1];
  return { yield: last ? last.yield : null, fertility:E.fertility(r.soil), moisture:r.soil.moisture, water:r.reserve, budget:r.budget };
}
function renderMeters(r, deltas){
  const vals = meterValues(r);
  $('meters').innerHTML = METERS.map(M=>{
    const v = vals[M.key];
    const shown = v===null ? '—' : M.key==='budget' ? fmt$(v) : num(v);
    const pct = M.key==='budget' ? Math.max(0, Math.min(100, v/12000*100)) : (v ?? 0);
    const col = M.key==='budget' ? 'var(--amber-500)' : barColor(v ?? 0);
    const label = t(`meters.${M.key}`);
    return `<div class="meter" data-k="${M.key}">
      <div class="mic" style="background:${M.bg}">${IC[M.ic]}</div>
      <div class="meter-body"><small title="${esc(label)}">${esc(label)}</small>
        <div class="val"><b>${shown}</b>${v!==null && M.unit ? `<span>${M.unit}</span>` : ''}</div>
        <div class="bar"><i style="width:${pct}%;background:${col}"></i></div></div>
      <span class="delta"></span></div>`;
  }).join('');
  if(deltas) Object.entries(deltas).forEach(([k,d])=>{
    if(!d) return;
    const el = document.querySelector(`.meter[data-k="${k}"] .delta`); if(!el) return;
    el.textContent = k==='budget' ? (d>0?'+':'')+fmt$(d) : signed(d);
    el.className = 'delta '+(d>0?'up':'down');
    requestAnimationFrame(()=>el.classList.add('show'));
    setTimeout(()=>el.classList.remove('show'), 3200);
  });
  setTank(r.reserve);
}

function weatherFor(s, outcome){
  const ev = E.seasonEvents(s, (pending ? pending.prevRun : run).baseline).map(e=>e.type);
  if((outcome && outcome.state==='overwater') || ev.includes('downpour')) return 'rain';
  if((outcome && (outcome.state==='drought' || outcome.state==='heatstress')) || ev.includes('heat') || ev.includes('drought')) return 'heat';
  if(s.solar_radiation_mj_m2_day < 17) return 'cloudy';
  return s.rainfall_mm*30/s.days > 45 ? 'showers' : 'clear';
}
function setFieldState(state, weather){
  const st = $('stage');
  st.dataset.state = state;
  if(weather) st.dataset.weather = weather;
  const S = STATES[state];
  const ic = $('cond-ic'); ic.style.background = S.color; ic.innerHTML = IC[S.ic];
  renderFieldLabels();
  const last = run && run.results.length ? run.results[run.results.length-1] : pending && pending.outcome;
  const ndvi = state==='planning' ? 0.2 : state==='failed' ? 0.18 : last ? 0.18 + 0.6*last.yield/100 : 0.6;
  paintNDVI(ndvi);
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
  if(phase!=='plan' || !run) return;
  if(!E.validateDecision(run, decision).ok){ renderControls(); return; }
  const token = gameToken;
  const prevRun = run;
  const { run: next, outcome } = E.playSeason(run, decision);
  pending = { prevRun, next, outcome, best:undefined };
  phase = 'growing';
  renderControls(); renderPlants(); setView(false);
  setFieldState(outcome.state, weatherFor(outcome.season, outcome));
  paintNDVI(0.18 + 0.6*outcome.yield/100);
  await wait(600);
  if(token!==gameToken) return;
  const before = meterValues(prevRun), after = meterValues(next);
  const deltas = {};
  METERS.forEach(M=>{ if(after[M.key]!==null) deltas[M.key] = after[M.key] - (before[M.key] ?? 0); });
  if(before.yield===null) deltas.yield = 0;
  renderMeters(next, deltas); renderSoil(next);
  await wait(1100);
  if(token!==gameToken) return;
  phase = 'report';
  renderReport();
  openOv('ov-report');
}
function bestFor(p){
  if(p.best===undefined) p.best = E.bestDecision(p.prevRun);
  return p.best;
}
function sameOrBetter(o, best){
  if(!best) return true;
  if(JSON.stringify(E.normalizeDecision(o.decision))===JSON.stringify(E.normalizeDecision(best.decision))) return true;
  return best.outcome.yield <= o.yield && best.outcome.economics.profit <= o.economics.profit
    && E.seasonWaterScore(best.outcome) <= E.seasonWaterScore(o) && best.outcome.fertilityAfter <= o.fertilityAfter;
}
function reasonText(r){
  const v = {};
  Object.entries(r.vars || {}).forEach(([k,x])=>{
    if(k==='prev') v[k] = cropName(x);
    else if(k==='drivers') v[k] = String(x).split(', ').filter(p=>p && p!=='—').map(p=>t(`param.${p}`)).join(', ') || t('param.none');
    else if(k==='temp') v[k] = dec1(x);
    else if(k==='value' && typeof x==='number' && !Number.isInteger(x)) v[k] = dec1(x);
    else v[k] = typeof x==='number' ? num(x) : x;
  });
  return t(`reason.${r.code}`, v);
}
function renderReport(){
  const { prevRun, next, outcome:o } = pending;
  const best = bestFor(pending);
  const S = STATES[o.state], level = E.levelById(prevRun.levelId), s = o.season;
  const idx = prevRun.seasonIndex;
  const dSoil = k => o.soilAfter[k] - o.soilBefore[k];
  const chip = (ic, label, d, goodUp=true, f=signed) => `<span class="dchip">${IC[ic]} ${esc(label)} <span class="n ${(d>=0)===goodUp?'up':'down'}">${d===0?'±0':f(d)}</span></span>`;
  const events = E.seasonEvents(s, prevRun.baseline, prevRun.reserve);
  const same = sameOrBetter(o, best);
  const btnLabel = next.failed ? t('actions.seeResult') : next.finished ? t('actions.finishLevel') : t('actions.nextSeason');
  $('report').innerHTML = `
    <div class="report-head">
      <div class="ric" style="background:${S.color}">${IC[S.ic]}</div>
      <div><div class="eyebrow">${esc(t('report.eyebrow', { n:level.id, season:idx+1, total:prevRun.seasons.length, year:seasonLabel(s) }))}</div><h2 id="rep-title">${esc(t(`states.${o.state}`))}</h2></div>
      <div class="field-ndvi"><small>${esc(t('report.yield'))}</small><b>${num(o.yield)}%</b></div>
    </div>
    <div class="report-body">
      <div class="deltas">
        <span class="dchip">${IC.coin} ${esc(t('report.profit'))} <span class="n ${o.economics.profit>=0?'up':'down'}">${o.economics.profit>=0?'+':''}${fmt$(o.economics.profit)}</span></span>
        ${chip('drop', t('meters.water'), o.water.reserveAfter - o.water.reserveBefore)}
        ${chip('soil', t('meters.fertility'), o.fertilityAfter - o.fertilityBefore)}
        ${chip('leaf', t('soil.n'), dSoil('n'))}
        ${chip('compost', t('soil.om'), dSoil('om'))}
        ${chip('alert', t('soil.erosion'), dSoil('erosion'), false)}
        ${chip('humid', t('soil.moisture'), dSoil('moisture'))}
      </div>
      <div class="chain">
        <div class="link data"><h4>${IC.satellite} ${esc(t('report.nasaData'))}</h4>${esc(t('report.dataLine', { temp:dec1(s.temperature_c), rain:num(s.rainfall_mm), rh:num(s.humidity_percent), ws:dec1(s.wind_speed_m_s), sw:dec1(s.solar_radiation_mj_m2_day) }))}
          ${events.length ? `<br>${events.map(e=>esc(t(`events.${e.type}`))).join(', ')}` : ''}</div>
        <div class="link dec"><h4>${IC.farmer} ${esc(t('report.decision'))}</h4>${esc(describeDecision(o.decision))}</div>
        <div class="link res ${o.yield>=70?'':o.yield>=45?'warn':'bad'}"><h4>${IC[S.ic]} ${esc(t('report.happened'))}</h4>${esc(t('report.resultLine', { yield:num(o.yield), demand:num(o.water.demand), supply:num(o.water.supply) }))}</div>
      </div>
      <div><p class="section-t">${esc(t('report.why'))}</p><ul class="why">${o.reasons.slice(0,8).map(r=>`<li>
        <span class="pb${r.param?'':' dec'}">${esc(r.param ? (r.param==='reserve' ? t('param.reserve') : r.param) : t('report.badgeFarm'))}</span>
        <span>${esc(reasonText(r))}</span>
        ${Math.round(r.impact) ? `<span class="imp ${r.impact>0?'up':'down'}">${signed(Math.round(r.impact))}</span>` : ''}</li>`).join('')}</ul></div>
      <div class="note sci"><span class="nic">${IC.atom}</span><span><b>${esc(t('report.science'))}</b>${esc(t(`science.${o.science}`))}</span></div>
      <div class="alt${same?' same':''}"><span>${same ? esc(t('report.bestSame'))
        : `<b>${esc(t('report.bestLabel'))}</b> ${esc(describeDecision(best.decision))} — ${esc(t('report.bestNumbers', { yield:num(best.outcome.yield), profit:fmt$(best.outcome.economics.profit), water:num(E.seasonWaterScore(best.outcome)) }))}`}</span>
        <button class="btn" type="button" id="btn-whatif">${IC.compare} ${esc(t('actions.whatIf'))}</button></div>
      <div class="report-foot">
        <small>${esc(t('report.money', { revenue:fmt$(o.economics.revenue), cost:fmt$(o.economics.cost) }))}</small>
        <button class="btn btn-primary btn-lg" type="button" id="btn-next" data-autofocus>${esc(btnLabel)} ${IC.arrow}</button>
      </div>
    </div>`;
  $('btn-next').onclick = afterReport;
  $('btn-whatif').onclick = openWhatIf;
}
function afterReport(){
  closeOv('ov-whatif'); closeOv('ov-report');
  run = pending.next;
  const lastDecision = pending.outcome.decision;
  pending = null;
  if(run.finished || run.failed){ finishLevel(); return; }
  phase = 'plan';
  decision = emptyDecision(lastDecision);
  renderGame();
  setFieldState('planning', weatherFor(currentSeason()));
  toast(t('toast.nextSeason', { n:run.seasonIndex+1, season:seasonLabel(currentSeason()) }));
}

/* ---------- What If ---------- */
function openWhatIf(){
  const best = bestFor(pending);
  whatIf = { run:pending.prevRun, player:pending.outcome.decision, alt:{ ...(best ? best.decision : pending.outcome.decision) } };
  renderWhatIf();
  openOv('ov-whatif');
}
function renderWhatIf(focusId){
  const cmp = E.compare(whatIf.run, whatIf.player, whatIf.alt);
  const a = cmp.player.outcome, b = cmp.alternative.outcome;
  const sel = (id, label, options, value) => `<label>${esc(label)}<select id="${id}">${options.map(([v,l])=>`<option value="${v}"${String(v)===String(value)?' selected':''}>${esc(l)}</option>`).join('')}</select></label>`;
  const alt = whatIf.alt;
  const rows = [
    [t('whatif.yield'), a.yield, b.yield, v=>`${num(v)}%`, 1],
    [t('whatif.profit'), a.economics.profit, b.economics.profit, fmt$, 1],
    [t('whatif.irrigation'), a.water.irrigationMm, b.water.irrigationMm, v=>`${num(v)} mm`, 0],
    [t('whatif.reserveUsed'), a.water.reserveUsed, b.water.reserveUsed, v=>num(v), -1],
    [t('whatif.waterScore'), cmp.player.water, cmp.alternative.water, v=>num(v), 1],
    [t('whatif.fertility'), a.fertilityAfter - a.fertilityBefore, b.fertilityAfter - b.fertilityBefore, v=>signed(v), 1],
    [t('whatif.erosion'), Math.round(a.erosionEvent), Math.round(b.erosionEvent), v=>num(v), -1],
    [t('whatif.leached'), Math.round(a.nitrogen.leached), Math.round(b.nitrogen.leached), v=>num(v), -1],
  ];
  const cls = (x, y, dir) => !dir || x===y ? '' : (y-x)*dir > 0 ? 'better' : 'worse';
  $('whatif').innerHTML = `
    <div class="eyebrow">${esc(t('whatif.eyebrow', { season:seasonLabel(a.season) }))}</div>
    <h2 id="wi-title">${esc(t('whatif.title'))}</h2>
    <div class="wi-grid">
      <div class="wi-col"><h3>${esc(t('whatif.yours'))}</h3><p>${esc(describeDecision(whatIf.player))}</p></div>
      <div class="wi-col alt-col"><h3>${esc(t('whatif.alternative'))}</h3>
        ${sel('wi-crop', t('whatif.crop'), E.CROP_IDS.map(id=>[id, cropName(id)]), alt.crop)}
        ${sel('wi-irr', t('whatif.irrigationSel'), E.IRRIGATION.map((o,k)=>[k, irrName(k)]), alt.irrigation)}
        ${sel('wi-method', t('whatif.method'), Object.keys(E.METHODS).map(m=>[m, t(`methods.${m}.name`)]), alt.method || 'sprinkler')}
        ${sel('wi-fert', t('whatif.fertilizer'), Object.keys(E.FERTILIZERS).map(f=>[f, t(`fertilizers.${f}.name`)]), alt.fertilizer)}
        ${sel('wi-prot', t('whatif.protection'), Object.keys(E.PROTECTION).map(p=>[p, t(`protection.${p}.name`)]), alt.protection || 'none')}
        <button class="btn" type="button" id="wi-best">${IC.star} ${esc(t('whatif.useBest'))}</button>
      </div>
    </div>
    ${cmp.alternative.affordable ? '' : `<p class="missing show">${esc(t('whatif.unaffordable'))}</p>`}
    <div class="table-wrap"><table class="table">
      <thead><tr><th>${esc(t('whatif.metric'))}</th><th>${esc(t('whatif.yours'))}</th><th>${esc(t('whatif.alternative'))}</th></tr></thead>
      <tbody>${rows.map(([l,x,y,f,dir])=>`<tr><td>${esc(l)}</td><td>${f(x)}</td><td class="${cls(x,y,dir)}">${f(y)}</td></tr>`).join('')}
        <tr><td>${esc(t('whatif.state'))}</td><td>${esc(t(`states.${a.state}`))}</td><td>${esc(t(`states.${b.state}`))}</td></tr></tbody>
    </table></div>
    <p class="note-sm">${esc(t('whatif.note'))}</p>
    <div class="brief-foot"><button class="btn btn-primary" type="button" id="wi-close" data-autofocus>${esc(t('actions.backToReport'))}</button></div>`;
  const bind = (id, key, parse=v=>v) => { $(id).onchange = e=>{ whatIf.alt = { ...whatIf.alt, [key]:parse(e.target.value) }; renderWhatIf(id); }; };
  bind('wi-crop','crop'); bind('wi-irr','irrigation',Number); bind('wi-method','method'); bind('wi-fert','fertilizer'); bind('wi-prot','protection');
  $('wi-best').onclick = ()=>{ const best = bestFor(pending); if(best){ whatIf.alt = { ...best.decision }; renderWhatIf('wi-best'); } };
  $('wi-close').onclick = ()=>closeOv('ov-whatif');
  if(focusId && $(focusId)) $(focusId).focus();
}

/* ---------- End of a level ---------- */
function finishLevel(){
  const ev = E.evaluateLevel(run);
  lastEval = { ev, run, bestPlan: undefined };
  progress = E.recordResult(progress, ev, { date:new Date().toISOString().slice(0,10), data:climate.status, place: isDemo() ? null : placeLabel(place) });
  writeJSON(KEYS.progress, progress);
  phase = 'done';
  renderControls();
  setFieldState(ev.passed ? 'harvest' : 'failed', ev.passed ? 'clear' : 'cloudy');
  showBanner();
}
function showBanner(){ renderBanner(); $('banner').classList.add('show'); $('btn-final').focus(); }
function renderBanner(){
  const passed = lastEval.ev.passed;
  $('banner-card').innerHTML = passed
    ? `<div class="big-ic" style="background:#C9971B">${IC.basket}</div><h2>${esc(t('banner.win.title'))}</h2><p>${esc(t('banner.win.text'))}</p><button class="btn btn-primary btn-lg" type="button" id="btn-final">${IC.trophy} ${esc(t('actions.seeResult'))}</button>`
    : `<div class="big-ic" style="background:#8E2A1F">${IC.x}</div><h2>${esc(t('banner.fail.title'))}</h2><p>${esc(t(lastEval.ev.failReason==='bankrupt' ? 'banner.fail.bankrupt' : 'banner.fail.text'))}</p><button class="btn btn-lg" type="button" id="btn-final">${IC.trophy} ${esc(t('actions.seeResult'))}</button>`;
  $('btn-final').onclick = ()=>{ $('banner').classList.remove('show'); showResult(); };
}
function showResult(){ renderResult(); show('final'); scrollTop(); }
function renderResult(){
  const { ev, run:r } = lastEval, m = ev.metrics, level = E.levelById(ev.levelId);
  if(lastEval.bestPlan===undefined) lastEval.bestPlan = E.bestPlan(E.createRun(level.id, climate.data));
  const plan = lastEval.bestPlan, planEval = plan ? E.evaluateLevel(plan.run) : null;
  const nextLevel = E.LEVELS.find(l=>l.id===level.id+1);
  const star = (on, cls='') => `<svg class="${cls}" viewBox="0 0 24 24" aria-hidden="true"><path class="${on?'star-on':'star-off'}" stroke-width="1.4" stroke-linejoin="round" d="M12 2.8l2.8 5.8 6.3.9-4.6 4.4 1.1 6.3L12 17.2l-5.6 3 1.1-6.3-4.6-4.4 6.3-.9z"/></svg>`;
  const cat = (key, label, score, extra) => { const c = ev.categories[key]; return `<div class="cat${c.earned && ev.passed?' on':''}">${star(c.earned && ev.passed)}<b>${score}</b><small>${esc(label)}</small><small>${esc(extra)}</small></div>`; };
  const kv = (label, value, cls='') => `<div><small>${esc(label)}</small><b class="${cls}">${value}</b></div>`;
  const dcls = (d, goodUp=true) => d===0 ? '' : (d>0)===goodUp ? 'up' : 'down';
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
          <span>${esc(ev.passed ? t('result.passedText', { stars:ev.stars }) : ev.failReason==='bankrupt' ? t('result.bankrupt', { min:fmt$(E.MODEL.MIN_SEED_COST) }) : t('result.failedText'))}</span>
        </div>
      </div>
      <div class="final-side">
        <div class="card"><h3>${IC.flag} ${esc(t('result.goals'))}</h3>
          <ul class="goal-list">${ev.goals.map(g=>`<li class="${g.met?'ok':'no'}"><span class="gi">${g.met?IC.check:IC.x}</span>${esc(goalText(g))}<em>${esc(goalValue(g.metric, g.actual))}</em></li>`).join('')}</ul></div>
        <div class="card"><h3>${IC.star} ${esc(t('result.categories'))}</h3>
          <div class="cats">
            ${cat('yield', t('result.cat.yield'), `${ev.categories.yield.score}%`, t('result.cat.target', { value:`${ev.categories.yield.target}%` }))}
            ${cat('water', t('result.cat.water'), ev.categories.water.score, t('result.cat.target', { value:ev.categories.water.target }))}
            ${cat('soil', t('result.cat.soil'), ev.categories.soil.score, t('result.cat.soilTarget', { value:signed(ev.categories.soil.target), delta:signed(m.fertilityDelta) }))}
          </div></div>
      </div>
    </div>
    <div class="final-grid">
      <div class="card"><h3>${IC.coin} ${esc(t('result.totals'))}</h3><div class="kv">
        ${kv(t('result.profit'), `${m.profit>=0?'+':''}${fmt$(m.profit)}`, dcls(m.profit))}
        ${kv(t('result.revenue'), fmt$(m.revenue))}
        ${kv(t('result.avgYield'), `${num(m.avgYield)}%`)}
        ${kv(t('result.irrigation'), `${num(m.irrigationMm)} mm`)}
        ${kv(t('result.wasted'), `${num(m.wastedMm)} mm`, m.wastedMm>0?'down':'')}
        ${kv(t('result.reserveUsed'), num(m.reserveUsed))}
        ${kv(t('result.reserveEnd'), `${num(m.reserveEnd)}%`)}
      </div></div>
      <div class="card"><h3>${IC.soil} ${esc(t('result.soil'))}</h3><div class="kv">
        ${kv(t('meters.fertility'), `${num(m.fertilityEnd)} (${signed(m.fertilityDelta)})`, dcls(m.fertilityDelta))}
        ${kv(t('soil.n'), signed(m.nDelta), dcls(m.nDelta))}
        ${kv(t('soil.om'), signed(m.omDelta), dcls(m.omDelta))}
        ${kv(t('soil.erosion'), signed(m.erosionDelta), dcls(m.erosionDelta, false))}
        ${kv(t('soil.moisture'), signed(m.moistureDelta), dcls(m.moistureDelta))}
        ${kv(t('result.leached'), `${num(m.nLeached)} kg N`, m.nLeached>10?'down':'')}
      </div></div>
    </div>
    <div class="card" style="padding:18px;margin-top:18px"><h3>${IC.map} ${esc(t('result.seasons'))}</h3>
      <div class="timeline">${r.results.map(o=>{ const S = STATES[o.state]; return `
        <div class="tl"><div class="tl-top">${cropIcon(o.decision.crop)}<div><small>${esc(seasonLabel(o.season))}</small><b>${esc(cropName(o.decision.crop))}</b></div><span class="hp" style="color:${barColor(o.yield)}">${o.yield}%</span></div>
        <span class="state" style="background:${S.color}1f;color:${S.color}">${IC[S.ic]}${esc(t(`states.${o.state}`))}</span>
        <p class="note-sm" style="margin-top:6px">${esc(describeDecision(o.decision))}</p></div>`; }).join('')}</div></div>
    <div class="final-grid">
      <div class="card"><h3>${IC.bulb} ${esc(t('result.recommendations'))}</h3><ul class="lessons">${ev.recommendations.map(k=>`<li><span class="lic">${IC.check}</span><span>${esc(t(`rec.${k}`))}</span></li>`).join('')}</ul></div>
      <div class="card"><h3>${IC.star} ${esc(t('result.bestPlan'))}</h3>
        ${plan ? `<ul class="lessons">${plan.path.map((d,i)=>`<li><span class="lic" style="background:var(--green-500)">${i+1}</span><span><b>${esc(seasonLabel(plan.outcomes[i].season))}:</b> ${esc(describeDecision(d))} — ${num(plan.outcomes[i].yield)}%</span></li>`).join('')}</ul>
          <p class="note-sm" style="margin-top:10px">${esc(t('result.bestPlanScore', { stars:planEval.stars, score:planEval.score, profit:fmt$(planEval.metrics.profit) }))}</p>` : `<p class="note-sm">${esc(t('result.noPlan'))}</p>`}
      </div>
    </div>
    <div class="final-actions">
      ${ev.passed && nextLevel ? `<button class="btn btn-primary btn-lg" type="button" id="res-next">${IC.play} ${esc(t('actions.nextLevel', { n:nextLevel.id }))}</button>` : ''}
      <button class="btn btn-lg${ev.passed?'':' btn-primary'}" type="button" id="res-retry">${IC.refresh} ${esc(t('actions.retry'))}</button>
      <button class="btn btn-lg" type="button" id="res-levels">${IC.grid} ${esc(t('actions.levels'))}</button>
      ${E.farmReport(progress).allPassed ? `<button class="btn btn-lg btn-nasa" type="button" id="res-farm">${IC.trophy} ${esc(t('farm.open'))}</button>` : ''}
    </div>
    <p class="disclaimer">${esc(t('result.provenance', { source: t(`status.${climate.status}`), place: isDemo() ? t('levels.demoPlace') : placeLabel(place) }))}<br>${esc(t('final.disclaimer'))}</p>`;
  if($('res-next')) $('res-next').onclick = ()=>openBrief(nextLevel.id);
  $('res-retry').onclick = ()=>openBrief(level.id);
  $('res-levels').onclick = showLevels;
  if($('res-farm')) $('res-farm').onclick = showFarm;
}

/* ---------- Farm report ---------- */
function showFarm(){ renderFarm(); show('farm'); scrollTop(); }
function renderFarm(){
  const rep = E.farmReport(progress);
  const ratio = rep.totalStars / rep.maxStars;
  const rank = t('final.rank.'+(ratio>=0.85?'master':ratio>=0.6?'skilled':ratio>=0.3?'growing':'rookie'));
  $('farm').innerHTML = `
    <div class="final-hero">
      <div class="score-card">
        <div class="eyebrow" style="color:#BFE3B8">${esc(t('farm.eyebrow'))}</div>
        <div class="score-num">${rep.totalStars}<span>/${rep.maxStars}</span></div>
        <div class="rank">${esc(rank)}</div>
        <div class="harvest-result ${rep.allPassed?'ok':'bad'}"><span class="hic" style="background:${rep.allPassed?'#C9971B':'#8C5E3C'}">${IC.trophy}</span>
          <span>${esc(t('farm.completed', { n:rep.completed, total:E.LEVELS.length }))}</span></div>
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
          <div><small>${esc(t('farm.totalIrrigation'))}</small><b>${num(rep.totalIrrigationMm)} mm</b></div>
        </div></div>
      </div>
    </div>
    <div class="card" style="padding:18px;margin-top:18px"><h3>${IC.grid} ${esc(t('farm.levels'))}</h3>
      <div class="table-wrap"><table class="table">
        <thead><tr><th>${esc(t('farm.level'))}</th><th>${esc(t('farm.stars'))}</th><th>${esc(t('result.cat.yield'))}</th><th>${esc(t('result.cat.water'))}</th><th>${esc(t('result.cat.soil'))}</th><th>${esc(t('result.profit'))}</th><th>${esc(t('farm.data'))}</th></tr></thead>
        <tbody>${rep.rows.map(row=>{ const level = E.levelById(row.id), b = row.best; return `<tr>
          <td>${row.id}. ${esc(levelName(level))}</td>
          <td><span class="mini-stars" style="justify-content:flex-end">${starsSvg(b ? b.stars : 0)}</span></td>
          <td>${b ? `${num(b.yield)}%` : '—'}</td><td>${b ? num(b.water) : '—'}</td><td>${b ? num(b.soil) : '—'}</td>
          <td>${b ? fmt$(b.profit) : '—'}</td><td>${b ? esc(t(`status.${b.data || 'live'}`)) : '—'}</td></tr>`; }).join('')}</tbody>
      </table></div></div>
    <div class="card" style="padding:18px;margin-top:18px"><h3>${IC.satellite} ${esc(t('final.lessons'))}</h3>
      <ul class="lessons">${[1,2,3,4,5].map(k=>`<li><span class="lic">${IC.check}</span><span>${esc(t(`farm.lesson.${k}`))}</span></li>`).join('')}</ul></div>
    <div class="final-actions">
      <button class="btn btn-primary btn-lg" type="button" id="farm-levels">${IC.grid} ${esc(t('actions.levels'))}</button>
      <button class="btn btn-lg btn-ghost" type="button" id="farm-reset">${IC.refresh} ${esc(t('farm.reset'))}</button>
    </div>
    <p class="disclaimer">${esc(t('final.disclaimer'))}</p>`;
  $('farm-levels').onclick = showLevels;
  $('farm-reset').onclick = ()=>{
    if(!window.confirm(t('farm.resetConfirm'))) return;
    progress = E.emptyProgress(); writeJSON(KEYS.progress, progress); showLevels();
  };
}

/* =========================================================
   PAUSE
   ========================================================= */
function pauseGame(){ paused = true; openOv('ov-pause'); }
function resumeGame(){ paused = false; closeOv('ov-pause'); }
function leaveLevelConfirmed(){
  return !(run && run.results.length && !run.finished && !run.failed) || window.confirm(t('confirm.leave'));
}

/* =========================================================
   TUTORIAL
   ========================================================= */
const TUT = [
  { id:'welcome', art:()=>`<div style="display:flex;gap:10px">${E.CROP_IDS.map(cropIcon).join('')}</div>`, bg:'linear-gradient(180deg,#BFE1F5,#EEF6E6)',
    chips:()=>[t('tut.welcome.chip1'),t('tut.welcome.chip2'),t('tut.welcome.chip3')] },
  { id:'sky', art:()=>`<div style="width:120px;height:120px">${IC['satellite-color']}</div>`, bg:'linear-gradient(180deg,#0B3D91,#1E6FD9)',
    chips:()=>['T2M','PRECTOTCORR','RH2M','WS2M','ALLSKY_SFC_SW_DWN'] },
  { id:'decide', art:()=>`<div style="display:flex;gap:12px;color:#fff">${['sprout','drop','flask','shield'].map(i=>`<span style="width:60px;height:60px;border-radius:20px;background:rgba(255,255,255,.18);display:grid;place-items:center">${IC[i].replace('class="icon"','class="icon" style="width:32px;height:32px"')}</span>`).join('')}</div>`, bg:'linear-gradient(180deg,#3E9B4F,#23603F)',
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
  if(screen==='location') renderLocation();
  if(screen==='levels' && climate) renderLevels();
  if(screen==='error') renderError();
  if(screen==='loading' && place) $('loading-text').textContent = t('loading.text', { place: placeLabel(place) });
  if(screen==='game' && run) renderGame();
  if(ovOpen('ov-level') && briefLevel) renderBrief();
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
  if(phase==='plan' && run){
    if(ds.crop){ decision = { ...decision, crop:ds.crop }; renderControls(); renderPlants(); return; }
    if(ds.irr!==undefined){ decision = { ...decision, irrigation:Number(ds.irr) }; renderControls(); return; }
    if(ds.method){ decision = { ...decision, method:ds.method }; renderControls(); return; }
    if(ds.fert){ decision = { ...decision, fertilizer:ds.fert }; renderControls(); return; }
    if(ds.prot){ decision = { ...decision, protection:ds.prot }; renderControls(); return; }
  }
  if(ds.level){ openBrief(Number(ds.level)); return; }
  if(ds.preset!==undefined){ choosePlace({ ...PRESETS[Number(ds.preset)] }); return; }
  if(ds.result!==undefined && searchResults){
    const p = searchResults[Number(ds.result)];
    choosePlace({ name:p.name, admin1:p.admin1 || null, country:p.country || null, latitude:p.latitude, longitude:p.longitude });
  }
});
$('btn-confirm').onclick = confirmDecision;
$('btn-help').onclick = ()=>openTutorial(0);
$('btn-help-levels').onclick = ()=>openTutorial(0);
$('btn-pause').onclick = pauseGame;
$('btn-resume').onclick = resumeGame;
$('btn-pause-help').onclick = ()=>{ resumeGame(); openTutorial(0); };
$('btn-pause-levels').onclick = ()=>{ if(!leaveLevelConfirmed()) return; paused = false; showLevels(); };
$('btn-restart').onclick = ()=>{ if(!leaveLevelConfirmed()) return; paused = false; startLevel(run.levelId); };
$('btn-retry').onclick = ()=>loadClimate(true);
$('btn-demo').onclick = useDemo;
$('btn-err-location').onclick = showLocation;
$('btn-refresh').onclick = ()=>loadClimate(true);
$('btn-change-location').onclick = showLocation;
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
  if(ok) choosePlace({ custom:true, latitude:Math.round(Number(la)*1e4)/1e4, longitude:Math.round(Number(lo)*1e4)/1e4 });
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
if(place) loadClimate(false); else showLocation();

})();
