// Pure scoring. No network, no clock, no filesystem: every function takes what
// it needs as an argument so the tests can assert hand-computed values.

// Seattle's intake fields are multi-select strings joined with commas, but at
// least one option contains a comma of its own ("Hazardous materials (e.g.,
// propane tanks)"). Splitting on "," shreds it, so match known tokens instead.
export function hasToken(value, token) {
  return typeof value === 'string' && value.includes(token);
}

// Weights answer "how much would this change how the street feels to walk
// down", not "how bad is it" in any other sense.
const TRASH_WEIGHTS = [
  ['Needles/Sharps', 1.0],
  ['Human waste', 1.0],
  ['Hazardous materials', 0.8],
  ['Bulky items', 0.4],
  ['Garbage/Loose litter', 0.3],
];

const BLOCKING_WEIGHTS = [
  ['Sidewalk', 0.9],
  ['Bike lane', 0.6],
  ['Entrance to residence', 0.6],
  ['Entrance to business', 0.5],
  ['Recreation amenity', 0.4],
  ['Construction project', 0.1],
];

export const SEVERITY_FLOOR = 0.5;

// A report that someone bothered to file is worth at least SEVERITY_FLOOR even
// when every observation field is blank (~10% of rows carry no answers).
export function encampmentSeverity(row) {
  let score = 0;

  if (hasToken(row.aretheretentsstructuresortarps, 'Yes')) score += 1.0;
  // The vehicle field collects stray free text ("White", "Red") where a
  // yes/no was expected; anything that isn't No/Unknown describes a vehicle.
  const veh = row.aretherervscarsmiscvehicles;
  if (typeof veh === 'string' && veh !== 'No' && veh !== 'Unknown' && veh !== '') score += 0.3;
  if (hasToken(row.aretherepeoplepresent, 'Yes')) score += 0.3;

  if (!hasToken(row.istheretrashordebris, 'None')) {
    for (const [token, w] of TRASH_WEIGHTS) {
      if (hasToken(row.istheretrashordebris, token)) score += w;
    }
  }
  if (!hasToken(row.istheencampmentblockingaccess, 'No blockage')) {
    for (const [token, w] of BLOCKING_WEIGHTS) {
      if (hasToken(row.istheencampmentblockingaccess, token)) score += w;
    }
  }

  return Math.max(SEVERITY_FLOOR, score);
}

// Encampments move: sweeps, weather, people relocating. A report from last week
// describes the street today; one from last spring may not.
export function recencyWeight(ageDays, halfLifeDays = 90) {
  if (ageDays < 0) return 1;
  return Math.pow(0.5, ageDays / halfLifeDays);
}

// The correction for Peck's caveat: neighborhoods differ in how readily they
// report anything at all, so compare a cell's MIX of complaints against the
// city's mix rather than its raw volume. alpha is a pseudo-count that pulls
// thin cells toward the city average - a cell with three reports has not
// earned an opinion.
export function shrunkShare(n, total, cityShare, alpha = 20) {
  if (total + alpha === 0) return cityShare;
  return (n + alpha * cityShare) / (total + alpha);
}

// >1 means this cell reports more of the category than the city does, after
// accounting for how much it reports overall. 1.0 means indistinguishable.
export function compositionRatio(n, total, cityShare, alpha = 20) {
  if (cityShare === 0) return 1;
  return shrunkShare(n, total, cityShare, alpha) / cityShare;
}

// Average percentile for ties, so a run of equal values does not create a
// fake ordering between cells that are genuinely the same.
export function percentileRanks(values) {
  const n = values.length;
  if (n === 0) return [];
  if (n === 1) return [50];
  const idx = values.map((v, i) => [v, i]).sort((a, b) => a[0] - b[0]);
  const out = new Array(n);
  let i = 0;
  while (i < n) {
    let j = i;
    while (j + 1 < n && idx[j + 1][0] === idx[i][0]) j++;
    const rank = (i + j) / 2;
    const pct = (rank / (n - 1)) * 100;
    for (let k = i; k <= j; k++) out[idx[k][1]] = pct;
    i = j + 1;
  }
  return out;
}

// A cell nobody reports is unknown, not clean. The spec's rule: never silently
// fill missing data with zeros.
export function confidence(totalReports) {
  if (totalReports >= 30) return 'high';
  if (totalReports >= 8) return 'medium';
  return 'low';
}

// How much each 311 complaint type says about what a street looks like.
// Streetlight Repair is the weakest: it is as much a report about municipal
// maintenance backlog as about the street.
export const DISORDER_WEIGHTS = {
  'Illegal Dumping': 1.0,
  'Public Place Litter & Recycling': 0.8,
  'Graffiti Report': 0.6,
  'Abandoned Vehicle': 0.5,
  'Streetlight Repair': 0.3,
};
