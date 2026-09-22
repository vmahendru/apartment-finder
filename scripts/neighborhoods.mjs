// Rolls the H3 cells up to named neighbourhoods so the score can be compared
// against someone's lived opinion of the same places.
import { readFileSync } from 'node:fs';
import { percentileRanks } from '../src/score.mjs';

const HOODS = [
  ['Ballard', 47.6685, -122.3843], ['Fremont', 47.6510, -122.3500],
  ['Wallingford', 47.6615, -122.3341], ['Capitol Hill', 47.6229, -122.3212],
  ['Volunteer Park', 47.6304, -122.3157], ['Queen Anne (upper)', 47.6370, -122.3570],
  ['Belltown', 47.6145, -122.3460], ['Pioneer Square', 47.6015, -122.3343],
  ['SODO', 47.5800, -122.3340], ['University District', 47.6600, -122.3130],
  ['Green Lake', 47.6800, -122.3280], ['West Seattle Junction', 47.5610, -122.3870],
  ['Columbia City', 47.5600, -122.2870], ['Magnolia', 47.6500, -122.4000],
  ['Georgetown', 47.5480, -122.3200], ['Lake City', 47.7200, -122.2970],
  ['North Delridge', 47.5690, -122.3630],
];
const RADIUS_M = 800;

const haversine = (a, b, c, d) => {
  const R = 6371000, r = Math.PI / 180;
  const dLat = (c - a) * r, dLng = (d - b) * r;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a * r) * Math.cos(c * r) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
};

const gj = JSON.parse(readFileSync(new URL('../public/data/cells.geojson', import.meta.url).pathname, 'utf8'));
const cells = gj.features.map((f) => f.properties);

const rolled = HOODS.map(([name, lat, lng]) => {
  const near = cells.filter((c) => haversine(lat, lng, c.lat, c.lng) <= RADIUS_M);
  const enc = near.reduce((s, c) => s + c.enc, 0);
  const dis = near.reduce((s, c) => s + c.dis, 0);
  const total = enc + dis;
  return {
    name, cells: near.length, enc, dis, total,
    density: total / Math.max(1, near.length),
    encDensity: enc / Math.max(1, near.length),
    share: total ? enc / total : 0,
  };
});

const rawRank = percentileRanks(rolled.map((r) => r.encDensity));
const shareRank = percentileRanks(rolled.map((r) => r.share));
const volumeRank = percentileRanks(rolled.map((r) => r.density));
rolled.forEach((r, i) => { r.rawPct = rawRank[i]; r.sharePct = shareRank[i]; r.volPct = volumeRank[i]; });

const pad = (s, n) => String(s).padEnd(n);
const num = (v, n, d = 0) => String(v.toFixed(d)).padStart(n);

console.log('\nSeattle neighbourhoods, last 365d. Higher = more reported disorder.\n');
console.log(pad('neighbourhood', 22) + '  enc/cell  all/cell   enc%    RAW  ADJUSTED   shift');
console.log('-'.repeat(78));
const byRaw = [...rolled].sort((a, b) => b.encDensity - a.encDensity);
for (const r of byRaw) {
  const shift = r.sharePct - r.rawPct;
  const arrow = Math.abs(shift) < 8 ? '   .' : (shift > 0 ? ` +${Math.round(shift)}` : ` ${Math.round(shift)}`);
  console.log(
    pad(r.name, 22) + num(r.encDensity, 9, 1) + num(r.density, 10, 1) +
    num(r.share * 100, 7, 1) + '%' + num(r.rawPct, 7) + num(r.sharePct, 10) + pad(arrow, 7)
  );
}

const ballard = rolled.find((r) => r.name === 'Ballard');
const vpark = rolled.find((r) => r.name === 'Volunteer Park');
console.log('\nThe calibration case from the spec:');
console.log(`  Ballard        raw ${ballard.rawPct.toFixed(0).padStart(3)}  adjusted ${ballard.sharePct.toFixed(0).padStart(3)}   (${ballard.enc} encampment of ${ballard.total} reports)`);
console.log(`  Volunteer Park raw ${vpark.rawPct.toFixed(0).padStart(3)}  adjusted ${vpark.sharePct.toFixed(0).padStart(3)}   (${vpark.enc} encampment of ${vpark.total} reports)`);
console.log(`\n  Spec expects Ballard to score noticeably worse than Volunteer Park.`);
console.log(`  Raw gap: ${(ballard.rawPct - vpark.rawPct).toFixed(0)} pts.  Engagement-adjusted gap: ${(ballard.sharePct - vpark.sharePct).toFixed(0)} pts.`);
