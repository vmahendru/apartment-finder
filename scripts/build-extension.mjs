// The extension ships its own copy of the shared module and the cell data so
// it works offline and never depends on a server being up.
import { copyFileSync, mkdirSync } from 'node:fs';
const at = (p) => new URL(p, import.meta.url).pathname;
mkdirSync(at('../extension/data'), { recursive: true });
copyFileSync(at('../public/shared.js'), at('../extension/shared.js'));
copyFileSync(at('../public/data/cells.geojson'), at('../extension/data/cells.geojson'));
console.log('extension/ updated: shared.js, data/cells.geojson');
