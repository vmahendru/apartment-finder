// Is the composition correction adding information, or just re-expressing
// "this cell reports a lot"? If it is merely the inverse of volume it is not
// a correction, it is a rename.
import { readFileSync } from 'node:fs';
import { percentileRanks } from '../src/score.mjs';

const gj = JSON.parse(readFileSync(new URL('../public/data/cells.geojson', import.meta.url).pathname, 'utf8'));
const cells = gj.features.map((f) => f.properties).filter((c) => c.conf !== 'low');

const pearson = (x, y) => {
  const n = x.length, mx = x.reduce((a, b) => a + b) / n, my = y.reduce((a, b) => a + b) / n;
  let sxy = 0, sxx = 0, syy = 0;
  for (let i = 0; i < n; i++) { const a = x[i] - mx, b = y[i] - my; sxy += a * b; sxx += a * a; syy += b * b; }
  return sxy / Math.sqrt(sxx * syy);
};
const spearman = (x, y) => pearson(percentileRanks(x), percentileRanks(y));

const intensity = cells.map((c) => c.intensity);
const composition = cells.map((c) => c.composition);
const total = cells.map((c) => c.total);
const share = cells.map((c) => c.enc / Math.max(1, c.total));

console.log(`cells with enough evidence to score: ${cells.length} of ${gj.features.length}\n`);
console.log(`  reported vs adjusted        r = ${pearson(intensity, composition).toFixed(3)}   rho = ${spearman(intensity, composition).toFixed(3)}`);
console.log(`  adjusted vs total volume    r = ${pearson(composition, total).toFixed(3)}   rho = ${spearman(composition, total).toFixed(3)}`);
console.log(`  reported vs total volume    r = ${pearson(intensity, total).toFixed(3)}   rho = ${spearman(intensity, total).toFixed(3)}`);
console.log(`  raw share vs total volume   r = ${pearson(share, total).toFixed(3)}   rho = ${spearman(share, total).toFixed(3)}`);

// If adjusted were just inverse volume, ranking cells by adjusted inside a
// narrow volume band would be meaningless. Check within bands.
const sorted = [...cells].sort((a, b) => a.total - b.total);
const band = Math.floor(sorted.length / 4);
console.log('\n  within volume quartiles (does adjusted still separate cells?):');
for (let q = 0; q < 4; q++) {
  const slice = sorted.slice(q * band, (q + 1) * band);
  const c = slice.map((s) => s.composition);
  const i = slice.map((s) => s.intensity);
  const lo = slice[0].total, hi = slice[slice.length - 1].total;
  console.log(`    Q${q + 1} (${lo}-${hi} reports)  adjusted spread ${Math.min(...c)}-${Math.max(...c)}   rho vs reported ${spearman(i, c).toFixed(3)}`);
}

// total includes encampment reports, so correlating intensity against it is
// partly self-correlation. The honest denominator is everything EXCEPT
// encampments: graffiti, dumping, litter, vehicles, streetlights.
const dis = cells.map((c) => c.dis);
console.log('\n  against the non-encampment denominator only (no self-correlation):');
console.log(`    reported vs other-report volume   r = ${pearson(intensity, dis).toFixed(3)}   rho = ${spearman(intensity, dis).toFixed(3)}`);
console.log(`    adjusted vs other-report volume   r = ${pearson(composition, dis).toFixed(3)}   rho = ${spearman(composition, dis).toFixed(3)}`);
