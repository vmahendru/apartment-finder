import { writeFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs';
import { latLngToCell, cellToBoundary, cellToLatLng, gridDisk } from 'h3-js';
import { encampmentSeverity, recencyWeight, compositionRatio, percentileRanks, confidence, DISORDER_WEIGHTS } from '../src/score.mjs';

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
const [encRows, disRows] = await Promise.all([fetchAll(ENCAMPMENT), fetchAll(DISORDER)]);

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

// One row per cell that either dataset touched.
const keys = [...new Set([...enc.cells.keys(), ...dis.cells.keys()])];
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
    sources: { encampment: ENCAMPMENT.id, disorder: DISORDER.id },
  },
  features,
};
mkdirSync(new URL('../public/data/', import.meta.url).pathname, { recursive: true });
writeFileSync(new URL('../public/data/cells.geojson', import.meta.url).pathname, JSON.stringify(out));
console.log(`\nWrote ${rows.length} cells -> public/data/cells.geojson`);
console.log(`  city encampment share of all reports: ${(cityShare * 100).toFixed(1)}%`);
