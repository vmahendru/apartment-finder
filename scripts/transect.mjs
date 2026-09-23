// Walk west to east through a point and print the profile. If resolution 10
// bought anything, the step at 15th Ave E should be visible rather than
// smeared across 330m.
import { readFileSync } from 'node:fs';
import { latLngToCell } from 'h3-js';
const gj = JSON.parse(readFileSync(new URL('../public/data/cells.geojson', import.meta.url).pathname,'utf8'));
const by = new Map(gj.features.map(f=>[f.properties.h3,f.properties]));
const [latArg, lngArg] = process.argv.slice(2).map(Number);
const LAT = Number.isFinite(latArg) ? latArg : 47.62425;
const CENTRE = Number.isFinite(lngArg) ? lngArg : -122.31262;
console.log(`\nwest -> east transect at latitude ${LAT} (centre ${CENTRE})\n`);
console.log('   lng        offset   enc   dis  grimeL calmL');
for (let lng = CENTRE - 0.0110; lng <= CENTRE + 0.0080; lng += 0.0009) {
  const c = by.get(latLngToCell(LAT, lng, 10));
  const m = Math.round((lng - CENTRE) * 75200);
  const mark = Math.abs(m) < 40 ? '  <- centre' : '';
  if (!c) { console.log(`  ${lng.toFixed(4)}  ${String(m).padStart(6)}m   (no data)${mark}`); continue; }
  const bar = '█'.repeat(Math.round(c.grimeLocal / 4));
  console.log(`  ${lng.toFixed(4)}  ${String(m).padStart(6)}m ${String(c.enc).padStart(5)} ${String(c.dis).padStart(5)}  ${String(c.grimeLocal).padStart(5)} ${String(c.calmLocal).padStart(5)}  ${bar}${mark}`);
}
