// Walkable amenity access. Pure: distances, decay, category mapping.

// Metres per degree at a given latitude. The equatorial constants are wrong
// by ~650 m/deg at Seattle's latitude, which is a 0.5% distance error - enough
// to move a venue in or out of the walk radius.
export function localScale(lat) {
  const p = lat * (Math.PI / 180);
  return {
    lat: 111132.92 - 559.82 * Math.cos(2 * p) + 1.175 * Math.cos(4 * p),
    lng: 111412.84 * Math.cos(p) - 93.5 * Math.cos(3 * p),
  };
}

// Equirectangular. Over city distances it tracks haversine to well under a
// metre, and unlike haversine the scale factors hoist out of the inner loop.
export function metresBetween(lat1, lng1, lat2, lng2) {
  const s = localScale((lat1 + lat2) / 2);
  const dy = (lat2 - lat1) * s.lat;
  const dx = (lng2 - lng1) * s.lng;
  return Math.hypot(dx, dy);
}

export const FULL_CREDIT_M = 400;   // ~5 minutes; you would not think twice
export const MAX_WALK_M = 1200;     // ~15 minutes; past here it stops counting

// Full credit inside five minutes, tapering to nothing at fifteen. Straight
// line, not street network: Seattle's hills, water and the I-5 trench all make
// the real walk longer than this says. See README.
export function walkWeight(metres) {
  if (metres <= FULL_CREDIT_M) return 1;
  if (metres >= MAX_WALK_M) return 0;
  return (MAX_WALK_M - metres) / (MAX_WALK_M - FULL_CREDIT_M);
}

const AMENITY_CATEGORY = {
  cafe: 'coffee',
  restaurant: 'food', fast_food: 'food',
  bar: 'bars', pub: 'bars', biergarten: 'bars', nightclub: 'bars',
};

export function categoryOf(tags) {
  if (!tags) return null;
  if (tags.leisure === 'park') return 'parks';
  if (tags.shop === 'coffee') return 'coffee';
  return AMENITY_CATEGORY[tags.amenity] ?? null;
}

// "Fun and things to do" leads on bars and food. Parks count, but a park is
// not an evening out.
export const CATEGORY_WEIGHTS = { bars: 1.0, food: 1.0, coffee: 0.7, parks: 0.5 };

export const CATEGORY_LABELS = {
  bars: 'Bars and pubs', food: 'Restaurants', coffee: 'Coffee', parks: 'Parks',
};

// OSM often carries a venue twice: once as a node, once as the building way.
// Snapping to a coordinate grid would split any pair that straddles a grid
// line, so compare real distances. Sorting by latitude keeps it near-linear:
// once the latitude gap alone exceeds the threshold, nothing further can match.
export function dedupe(pois, thresholdM = 20) {
  const sorted = [...pois].sort((a, b) => a.lat - b.lat);
  const kept = [];
  for (const p of sorted) {
    let duplicate = false;
    for (let i = kept.length - 1; i >= 0; i--) {
      const q = kept[i];
      if ((p.lat - q.lat) * 111132 > thresholdM) break;
      if (q.category === p.category && metresBetween(p.lat, p.lng, q.lat, q.lng) <= thresholdM) {
        duplicate = true;
        break;
      }
    }
    if (!duplicate) kept.push(p);
  }
  return kept;
}

// Decayed count per category for one point.
export function accessFrom(lat, lng, pois) {
  const out = { bars: 0, food: 0, coffee: 0, parks: 0 };
  const s = localScale(lat);
  const dLat = MAX_WALK_M / s.lat, dLng = MAX_WALK_M / s.lng;
  for (const p of pois) {
    // Cheap rejection before the sqrt: most venues are nowhere near.
    const ay = p.lat - lat; if (ay > dLat || ay < -dLat) continue;
    const ax = p.lng - lng; if (ax > dLng || ax < -dLng) continue;
    const w = walkWeight(Math.hypot(ay * s.lat, ax * s.lng));
    if (w > 0) out[p.category] += w;
  }
  return out;
}

export function livelinessFrom(access) {
  let total = 0;
  for (const [cat, w] of Object.entries(CATEGORY_WEIGHTS)) total += w * (access[cat] ?? 0);
  return total;
}
