// Read the map at one address. Geocodes exactly, then scores the point rather
// than whichever hexagon it happens to land in.
//   npm run look-up -- "15th Ave E & E Mercer St, Seattle, WA"
import { readFileSync } from 'node:fs';
import { accessFrom, livelinessFrom, metresBetween, categoryOf, dedupe, CATEGORY_LABELS } from '../src/amenity.mjs';

const query = process.argv.slice(2).join(' ').trim();
if (!query) {
  console.error('usage: npm run look-up -- "<address>"');
  process.exit(1);
}

const root = (p) => new URL(p, import.meta.url).pathname;
const gj = JSON.parse(readFileSync(root('../public/data/cells.geojson'), 'utf8'));
const cells = gj.features.map((f) => f.properties);
const elements = JSON.parse(readFileSync(root('../data/raw/osm-amenities.json'), 'utf8'));
const pois = dedupe(elements.flatMap((el) => {
  const category = categoryOf(el.tags);
  const lat = el.lat ?? el.center?.lat, lng = el.lon ?? el.center?.lon;
  return category && Number.isFinite(lat) && Number.isFinite(lng) ? [{ category, lat, lng }] : [];
}));

const url = new URL('https://nominatim.openstreetmap.org/search');
url.searchParams.set('q', query);
url.searchParams.set('format', 'json');
url.searchParams.set('limit', '1');
const hit = (await (await fetch(url, { headers: { 'user-agent': 'sidewalk-map/0.1 (personal apartment search)' } })).json())[0];
if (!hit) { console.error(`Could not find "${query}".`); process.exit(1); }
const lat = +hit.lat, lng = +hit.lon;

const access = accessFrom(lat, lng, pois);
const liveliness = livelinessFrom(access);
const sorted = cells.map((c) => c.liveliness ?? 0).sort((a, b) => a - b);
let lo = 0, hi = sorted.length;
while (lo < hi) { const m = (lo + hi) >> 1; if (sorted[m] < liveliness) lo = m + 1; else hi = m; }
const lively = (lo / sorted.length) * 100;

// Tight radius and unsmoothed values. Encampment reports cluster sharply, so
// a wide blend answers "how is this neighbourhood" when the question asked was
// "how is this address".
const RADIUS_M = 250;
let wsum = 0;
const acc = { grimeLocal: 0, calmLocal: 0, grime: 0, calm: 0, enc: 0, dis: 0 };
const near = [];
for (const c of cells) {
  const d = metresBetween(lat, lng, c.lat, c.lng);
  if (d > 650) continue;
  near.push({ ...c, d });
  if (d > RADIUS_M) continue;
  const w = 1 / (1 + (d / 120) ** 2);
  wsum += w;
  for (const k of Object.keys(acc)) acc[k] += w * c[k];
}
for (const k of Object.keys(acc)) acc[k] /= wsum || 1;

const bar = (v) => '█'.repeat(Math.round(v / 5)).padEnd(20, '·');
console.log(`\n${hit.display_name}`);
console.log(`${lat.toFixed(5)}, ${lng.toFixed(5)}\n`);
console.log(`  Lively            ${String(Math.round(lively)).padStart(3)}  ${bar(lively)}`);
console.log(`  Calm (this block) ${String(Math.round(acc.calmLocal)).padStart(3)}  ${bar(acc.calmLocal)}`);
console.log(`  Calm (the area)   ${String(Math.round(acc.calm)).padStart(3)}  ${bar(acc.calm)}`);
console.log(`\n  Within a walk (fading to nothing at fifteen minutes):`);
for (const [k, label] of Object.entries(CATEGORY_LABELS)) {
  console.log(`    ${label.padEnd(16)} ${String(Math.round(access[k])).padStart(3)}`);
}
// Which way is it rough? A single number hides the thing that matters most
// when a street is a boundary, which in Seattle they often are.
const DIRS = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
const sectors = DIRS.map(() => ({ enc: 0, dis: 0, n: 0 }));
for (const c of near) {
  if (c.d < 80) continue;
  const brg = (Math.atan2((c.lng - lng) * Math.cos(lat * Math.PI / 180), c.lat - lat) * 180 / Math.PI + 360) % 360;
  const s = sectors[Math.round(brg / 45) % 8];
  s.enc += c.enc; s.dis += c.dis; s.n++;
}
console.log(`\n  Encampment reports by direction, out to 650m:`);
const peak = Math.max(1, ...sectors.map((s) => s.enc));
DIRS.forEach((d, i) => {
  const s = sectors[i];
  if (!s.n) return;
  console.log(`    ${d.padEnd(3)} ${String(s.enc).padStart(5)}  ${'█'.repeat(Math.round((s.enc / peak) * 28))}`);
});

const best = DIRS[sectors.reduce((b, s, i) => (s.n && s.enc < sectors[b].enc ? i : b), sectors.findIndex((s) => s.n))];
const worst = DIRS[sectors.reduce((b, s, i) => (s.enc > sectors[b].enc ? i : b), 0)];
console.log(`\n  Quietest side: ${best}.  Roughest: ${worst}.`);
console.log(`  Within ${RADIUS_M}m, distance-weighted: ${Math.round(acc.enc)} encampment, ${Math.round(acc.dis)} other reports.`);
