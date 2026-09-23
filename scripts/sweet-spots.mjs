// Ground truth check. The user named three places that feel both lively and
// pleasant; the tool has to agree, and has to separate them from places that
// are lively but rough, and quiet but dull.
import { readFileSync } from 'node:fs';
import { accessFrom, livelinessFrom, metresBetween, categoryOf, dedupe } from '../src/amenity.mjs';

// Geocoded exactly: addresses via Nominatim, intersections via the shared
// Overpass node of two named ways. Guessed coordinates were out by 150-500m,
// which is a whole hexagon.
const ANCHORS = [
  ['15th Ave E & E Mercer',    47.62425, -122.31262, 'good'],
  ['N 36th St & Phinney Ave',  47.65226, -122.35448, 'good'],
  ['Queen Anne Ave & Boston', 47.63839, -122.35692, 'good'],

  ['Pike & 11th',              47.61410, -122.31815, 'rough'],
  ['2nd & Bell (Belltown)',    47.61370, -122.34530, 'rough'],
  ['Ballard Ave & Market',     47.66860, -122.38540, 'rough'],
  ['University Way & NE 45th', 47.66230, -122.31320, 'rough'],

  ['Magnolia Village',         47.63990, -122.40120, 'dull'],
  ['Alki',                     47.57890, -122.41100, 'dull'],
  ['Madison Park',             47.63560, -122.27860, 'dull'],

  ['N 45th & Wallingford',     47.66150, -122.33560, '?'],
  ['Phinney & N 67th',         47.67800, -122.35540, '?'],
  ['California & SW Alaska',   47.56120, -122.38720, '?'],
  ['Rainier & S Edmunds',      47.55880, -122.28570, '?'],
  ['15th NW & NW 65th',        47.67680, -122.37660, '?'],
];

const root = (p) => new URL(p, import.meta.url).pathname;
const gj = JSON.parse(readFileSync(root('../public/data/cells.geojson'), 'utf8'));
const cells = gj.features.map((f) => f.properties);

// Amenity access is computed at the exact point rather than read off a cell:
// a res-9 hexagon is ~330m across, so which cell a corner lands in is close to
// arbitrary at the scale that decides whether a bar is walkable.
const elements = JSON.parse(readFileSync(root('../data/raw/osm-amenities.json'), 'utf8'));
const pois = dedupe(elements.flatMap((el) => {
  const category = categoryOf(el.tags);
  const lat = el.lat ?? el.center?.lat, lng = el.lon ?? el.center?.lon;
  return category && Number.isFinite(lat) && Number.isFinite(lng) ? [{ category, lat, lng }] : [];
}));

const livelinessAll = cells.map((c) => c.amenity);
const pctOf = (value, sorted) => {
  let lo = 0, hi = sorted.length;
  while (lo < hi) { const m = (lo + hi) >> 1; if (sorted[m] < value) lo = m + 1; else hi = m; }
  return (lo / sorted.length) * 100;
};
const livelinessSorted = [...cells.map((c) => c.liveliness ?? 0)].sort((a, b) => a - b);

// Grime and calm are cell-level, so blend nearby cells by distance rather than
// averaging a whole ring flat - a ring mean drags in the next neighbourhood.
function readCells(lat, lng) {
  let wsum = 0, grime = 0, calm = 0, enc = 0, dis = 0;
  for (const c of cells) {
    const d = metresBetween(lat, lng, c.lat, c.lng);
    if (d > 500) continue;
    const w = 1 / (1 + (d / 180) ** 2);
    wsum += w; grime += w * c.grime; calm += w * c.calm; enc += w * c.enc; dis += w * c.dis;
  }
  return wsum ? { grime: grime / wsum, calm: calm / wsum, enc: enc / wsum, dis: dis / wsum } : null;
}

const rows = ANCHORS.map(([name, lat, lng, truth]) => {
  const access = accessFrom(lat, lng, pois);
  const cell = readCells(lat, lng);
  return { name, truth, access, liveliness: livelinessFrom(access), ...cell };
});
const lively = rows.map((r) => pctOf(r.liveliness, livelinessSorted));
rows.forEach((r, i) => { r.lively = lively[i]; });

const pad = (s, n) => String(s).padEnd(n);
const n = (v, w, d = 0) => v.toFixed(d).padStart(w);

console.log('\nlively = walkable access percentile. calm = quiet for that level of liveliness.\n');
console.log(pad('place', 27) + 'truth │ lively  calm │ bars  food  cafe │ enc  dis');
console.log('-'.repeat(84));
for (const r of [...rows].sort((a, b) => (b.lively + b.calm) - (a.lively + a.calm))) {
  console.log(
    pad(r.name, 27) + pad(r.truth, 6) + '│' + n(r.lively, 7) + n(r.calm, 6) + ' │' +
    n(r.access.bars, 5, 1) + n(r.access.food, 6, 1) + n(r.access.coffee, 6, 1) + ' │' +
    n(r.enc, 5) + n(r.dis, 5)
  );
}

const mean = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length;
for (const t of ['good', 'rough', 'dull']) {
  const g = rows.filter((r) => r.truth === t);
  console.log(`\n  ${pad(t, 6)} n=${g.length}  lively ${mean(g.map((r) => r.lively)).toFixed(0).padStart(3)}   calm ${mean(g.map((r) => r.calm)).toFixed(0).padStart(3)}`);
}
