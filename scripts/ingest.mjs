import { writeFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs';
import { latLngToCell, cellToBoundary, cellToLatLng, gridDisk } from 'h3-js';
import { encampmentSeverity, recencyWeight, compositionRatio, percentileRanks, confidence, residualByBand, DISORDER_WEIGHTS } from '../src/score.mjs';
import { categoryOf, dedupe, accessFrom, livelinessFrom } from '../src/amenity.mjs';

const RES = 9;
const WINDOW_DAYS = 365;
const HALF_LIFE = 90;
const PAGE = 50000;
const CACHE = new URL('../data/raw/', import.meta.url).pathname;

const ENCAMPMENT = {
  id: 'k7ra-jqqe',
  select: 'createddate,latitude,longitude,aretherepeoplepresent,aretheretentsstructuresortarps,aretherervscarsmiscvehicles,istheencampmentblockingaccess,istheretrashordebris',
};
const DISORDER = { id: '43nw-pkdq', select: 'createddate,latitude,longitude,servicerequesttype' };

const BBOX = [47.48, -122.44, 47.75, -122.22];
const OVERPASS = 'https://overpass-api.de/api/interpreter';
const OVERPASS_QUERY = `[out:json][timeout:180];
(
  nwr["amenity"~"^(cafe|restaurant|fast_food|bar|pub|biergarten|nightclub)$"](${BBOX});
  nwr["shop"="coffee"](${BBOX});
  nwr["leisure"="park"](${BBOX});
);
out center tags;`;

// Ways and relations come back with a computed centre rather than lat/lon.
async function fetchAmenities() {
  mkdirSync(CACHE, { recursive: true });
  const cacheFile = `${CACHE}osm-amenities.json`;
  let elements;
  if (existsSync(cacheFile)) {
    elements = JSON.parse(readFileSync(cacheFile, 'utf8'));
    console.log(`  overpass: ${elements.length} elements (cached)`);
  } else {
    const res = await fetch(OVERPASS, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', 'user-agent': 'sidewalk-map/0.1 (personal apartment search)' },
      body: new URLSearchParams({ data: OVERPASS_QUERY }),
    });
    if (!res.ok) throw new Error(`overpass HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
    elements = (await res.json()).elements;
    writeFileSync(cacheFile, JSON.stringify(elements));
    console.log(`  overpass: ${elements.length} elements`);
  }

  const pois = [];
  for (const el of elements) {
    const category = categoryOf(el.tags);
    if (!category) continue;
    const lat = el.lat ?? el.center?.lat;
    const lng = el.lon ?? el.center?.lon;
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;
    pois.push({ category, lat, lng });
  }
  const unique = dedupe(pois);
  console.log(`  amenities: ${unique.length} venues and parks (${pois.length - unique.length} duplicates dropped)`);
  return unique;
}

const since = new Date(Date.now() - WINDOW_DAYS * 864e5).toISOString().slice(0, 19);

async function fetchAll({ id, select }) {
  mkdirSync(CACHE, { recursive: true });
  const cacheFile = `${CACHE}${id}-${since.slice(0, 10)}.json`;
  if (existsSync(cacheFile)) {
    const rows = JSON.parse(readFileSync(cacheFile, 'utf8'));
    console.log(`  ${id}: ${rows.length} rows (cached)`);
    return rows;
  }
  const all = [];
  for (let offset = 0; ; offset += PAGE) {
    const url = `https://data.seattle.gov/resource/${id}.json`
      + `?$select=${encodeURIComponent(select)}`
      + `&$where=${encodeURIComponent(`createddate > '${since}'`)}`
      + `&$order=createddate&$limit=${PAGE}&$offset=${offset}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`${id} HTTP ${res.status}: ${await res.text()}`);
    const page = await res.json();
    all.push(...page);
    process.stdout.write(`\r  ${id}: ${all.length} rows`);
    if (page.length < PAGE) break;
  }
  console.log();
  writeFileSync(cacheFile, JSON.stringify(all));
  return all;
}

const ageDays = (iso) => (Date.now() - Date.parse(iso)) / 864e5;

function bin(rows, fn) {
  const cells = new Map();
  let skipped = 0;
  for (const r of rows) {
    const lat = Number(r.latitude), lng = Number(r.longitude);
    if (!Number.isFinite(lat) || !Number.isFinite(lng) || (lat === 0 && lng === 0)) { skipped++; continue; }
    const age = ageDays(r.createddate);
    if (!Number.isFinite(age) || age < 0 || age > WINDOW_DAYS + 1) { skipped++; continue; }
    const h3 = latLngToCell(lat, lng, RES);
    if (!cells.has(h3)) cells.set(h3, { h3, count: 0, weighted: 0, types: {} });
    fn(cells.get(h3), r, recencyWeight(age, HALF_LIFE));
  }
  return { cells, skipped };
}

console.log(`Ingesting Seattle, ${WINDOW_DAYS}d window since ${since.slice(0, 10)}`);
const [encRows, disRows, pois] = await Promise.all([fetchAll(ENCAMPMENT), fetchAll(DISORDER), fetchAmenities()]);

const enc = bin(encRows, (c, r, w) => {
  c.count++;
  c.weighted += encampmentSeverity(r) * w;
});
const dis = bin(disRows, (c, r, w) => {
  const t = r.servicerequesttype;
  c.count++;
  c.weighted += (DISORDER_WEIGHTS[t] ?? 0.5) * w;
  c.types[t] = (c.types[t] ?? 0) + 1;
});
console.log(`  binned: ${enc.cells.size} encampment cells (${enc.skipped} rows skipped), ${dis.cells.size} disorder cells (${dis.skipped} skipped)`);

// One row per cell that any source touched. Amenity cells are unioned in so a
// lively block that nobody has ever filed a report about still appears - those
// are exactly the places this map is meant to surface.
const amenityCells = new Set(pois.map((p) => latLngToCell(p.lat, p.lng, RES)));
const keys = [...new Set([...enc.cells.keys(), ...dis.cells.keys(), ...amenityCells])];
const rowFor = (h3) => {
  const e = enc.cells.get(h3) ?? { count: 0, weighted: 0, types: {} };
  const d = dis.cells.get(h3) ?? { count: 0, weighted: 0, types: {} };
  return { h3, encCount: e.count, encWeighted: e.weighted, disCount: d.count, disWeighted: d.weighted, types: d.types };
};
let rows = keys.map(rowFor);

// Smooth with immediate neighbours before ranking: a single H3 res-9 cell is
// ~0.1 km2, smaller than the area a person reads as "this block feels bad".
const byKey = new Map(rows.map((r) => [r.h3, r]));
for (const r of rows) {
  const ring = gridDisk(r.h3, 1).filter((k) => k !== r.h3);
  const neighbours = ring.map((k) => byKey.get(k)).filter(Boolean);
  const avg = (f) => neighbours.length ? neighbours.reduce((s, n) => s + n[f], 0) / ring.length : 0;
  r.encSmooth = 0.6 * r.encWeighted + 0.4 * avg('encWeighted');
  r.disSmooth = 0.6 * r.disWeighted + 0.4 * avg('disWeighted');
}

// The engagement correction. A cell's total report volume proxies how readily
// the neighbourhood reports anything; its composition says what is actually
// there. cityShare is the encampment fraction of all reports city-wide.
const cityEnc = rows.reduce((s, r) => s + r.encCount, 0);
const cityAll = rows.reduce((s, r) => s + r.encCount + r.disCount, 0);
const cityShare = cityEnc / cityAll;
for (const r of rows) {
  const total = r.encCount + r.disCount;
  r.total = total;
  r.composition = compositionRatio(r.encCount, total, cityShare);
  r.confidence = confidence(total);
}

const intensityPct = percentileRanks(rows.map((r) => r.encSmooth));
const disorderPct = percentileRanks(rows.map((r) => r.disSmooth));
const compositionPct = percentileRanks(rows.map((r) => r.composition));
rows.forEach((r, i) => {
  r.intensityPct = Math.round(intensityPct[i]);
  r.disorderPct = Math.round(disorderPct[i]);
  r.compositionPct = Math.round(compositionPct[i]);
});

// 5 decimal places is ~1m at this latitude; full float precision triples the
// file for no visible difference.
const round5 = (pair) => [+pair[0].toFixed(5), +pair[1].toFixed(5)];

// Walkable access is measured from each cell's centre out to real venues, not
// by counting what happens to sit inside the cell: a res-9 hexagon is ~330m
// across, so a bar one cell over is still a two-minute walk.
console.log('  scoring walkable amenity access...');
for (const r of rows) {
  const [lat, lng] = cellToLatLng(r.h3);
  r.access = accessFrom(lat, lng, pois);
  r.liveliness = livelinessFrom(r.access);
}
const amenityPct = percentileRanks(rows.map((r) => r.liveliness));
rows.forEach((r, i) => { r.amenityPct = Math.round(amenityPct[i]); });

// What you would actually see underfoot: encampment presence and street grime
// (dumping, graffiti, litter) weigh equally. Both are absolute, and both carry
// the engagement bias - which is the point of the residual below.
const grimePct = percentileRanks(rows.map((r) => r.intensityPct + r.disorderPct));
rows.forEach((r, i) => { r.grimePct = Math.round(grimePct[i]); });

// Calm *for its liveliness*. A negative residual means fewer reports than
// places with a comparable amount going on, so flip the sign: high = calmer.
const residual = residualByBand(rows.map((r) => r.amenityPct), rows.map((r) => r.grimePct), 10);
const calmPct = percentileRanks(residual.map((v) => -v));
rows.forEach((r, i) => { r.calmPct = Math.round(calmPct[i]); r.residual = Math.round(residual[i]); });

const features = rows.map((r) => {
  const [lat, lng] = cellToLatLng(r.h3);
  const ring = cellToBoundary(r.h3, true).map(round5);
  return {
    type: 'Feature',
    geometry: { type: 'Polygon', coordinates: [[...ring, ring[0]]] },
    properties: {
      h3: r.h3,
      lat: +lat.toFixed(5), lng: +lng.toFixed(5),
      enc: r.encCount, dis: r.disCount, total: r.total,
      intensity: r.intensityPct, disorder: r.disorderPct, composition: r.compositionPct,
      amenity: r.amenityPct, grime: r.grimePct, calm: r.calmPct, residual: r.residual,
      liveliness: +r.liveliness.toFixed(2),
      access: Object.fromEntries(Object.entries(r.access).map(([k, v]) => [k, +v.toFixed(2)])),
      ratio: +r.composition.toFixed(3),
      conf: r.confidence,
      types: r.types,
    },
  };
});

const out = {
  type: 'FeatureCollection',
  metadata: {
    generated: new Date().toISOString(),
    windowDays: WINDOW_DAYS, halfLifeDays: HALF_LIFE, resolution: RES,
    cityShare: +cityShare.toFixed(4),
    encampmentReports: cityEnc, disorderReports: cityAll - cityEnc, cells: rows.length,
    amenities: pois.length,
    sources: { encampment: ENCAMPMENT.id, disorder: DISORDER.id, amenities: 'OpenStreetMap via Overpass' },
  },
  features,
};
mkdirSync(new URL('../public/data/', import.meta.url).pathname, { recursive: true });
writeFileSync(new URL('../public/data/cells.geojson', import.meta.url).pathname, JSON.stringify(out));
console.log(`\nWrote ${rows.length} cells -> public/data/cells.geojson`);
console.log(`  city encampment share of all reports: ${(cityShare * 100).toFixed(1)}%`);
