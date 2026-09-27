// Static bundle of the game (no bundler needed: plain HTML + JS). Also checks script references and translations.
// dist/index.html  ← farm-navigator.html
// dist/js/*.js     ← js/*.js
// Vercel does not use dist/: it deploys app/main.py (FastAPI), which serves the page and the API itself.
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const dist = join(root, 'dist');
const page = readFileSync(join(root, 'farm-navigator.html'), 'utf8');

// Fail the build on broken references or translation blocks instead of shipping a blank page.
const scripts = [...page.matchAll(/<script src="([^"]+)"><\/script>/g)].map((m) => m[1]);
for (const src of scripts) {
  if (!existsSync(join(root, src))) throw new Error(`farm-navigator.html references missing ${src}`);
}
for (const lang of ['en', 'ru']) {
  const m = page.match(new RegExp(`<script type="application/json" id="i18n-${lang}">([\\s\\S]*?)</script>`));
  if (!m) throw new Error(`missing i18n-${lang} block`);
  JSON.parse(m[1]);
}

rmSync(dist, { recursive: true, force: true });
mkdirSync(join(dist, 'js'), { recursive: true });
writeFileSync(join(dist, 'index.html'), page);
for (const file of readdirSync(join(root, 'js'))) {
  if (file.endsWith('.js')) cpSync(join(root, 'js', file), join(dist, 'js', file));
}
console.log(`Built dist/ (index.html + ${scripts.length} scripts)`);
