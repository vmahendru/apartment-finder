// Web Mercator projection between a map's lat/lng bounds and its pixel box.
// Shared by the extension overlay and its test fixture; deliberately has no
// dependencies so a content script can load it directly.
(function (root) {
  const RAD = Math.PI / 180;

  // Mercator's y is linear in pixels; latitude is not.
  const mercY = (lat) => Math.log(Math.tan(Math.PI / 4 + (lat * RAD) / 2));

  function projector(bounds, width, height) {
    const { west, east, south, north } = bounds;
    const yN = mercY(north), yS = mercY(south);
    const spanX = east - west, spanY = yN - yS;
    return (lng, lat) => [
      ((lng - west) / spanX) * width,
      ((yN - mercY(lat)) / spanY) * height,
    ];
  }

  // Zillow keeps the visible map rectangle in its own URL. Reading it beats
  // reaching into the page's map object, which is renamed on every redeploy.
  function boundsFromUrl(href) {
    let url;
    try { url = new URL(href); } catch { return null; }
    const raw = url.searchParams.get('searchQueryState');
    if (!raw) return null;
    let state;
    try { state = JSON.parse(raw); } catch { return null; }
    const b = state && state.mapBounds;
    if (!b) return null;
    const nums = [b.west, b.east, b.south, b.north].map(Number);
    if (!nums.every(Number.isFinite)) return null;
    if (nums[0] >= nums[1] || nums[2] >= nums[3]) return null;
    return { west: nums[0], east: nums[1], south: nums[2], north: nums[3], zoom: Number(state.mapZoom) || null };
  }

  // Zillow paints its rental markers purple and its brand furniture blue, so
  // this palette avoids both hues entirely - an overlay must not be mistaken
  // for the thing it sits on top of. Reports run red, liveliness amber, calm
  // green. Every ramp stays monotonic in lightness so it survives greyscale
  // and colour blindness.
  const SEQ = [
    [0, '#1B2430'], [25, '#5E2530'], [50, '#A83A34'], [75, '#E8734A'], [100, '#FFB08A'],
  ];
  const DIV = [[-40, '#46C4C0'], [0, '#2A3644'], [40, '#D94F3D']];

  const hex = (c) => [parseInt(c.slice(1, 3), 16), parseInt(c.slice(3, 5), 16), parseInt(c.slice(5, 7), 16)];

  // Canvas has no equivalent of MapLibre's interpolate expression, so the
  // overlay samples the same stops by hand to get the same colours.
  function sample(ramp, value) {
    if (value <= ramp[0][0]) return ramp[0][1];
    if (value >= ramp[ramp.length - 1][0]) return ramp[ramp.length - 1][1];
    for (let i = 1; i < ramp.length; i++) {
      const [p1, c1] = ramp[i - 1], [p2, c2] = ramp[i];
      if (value <= p2) {
        const t = (value - p1) / (p2 - p1);
        const a = hex(c1), b = hex(c2);
        return `rgb(${a.map((v, k) => Math.round(v + (b[k] - v) * t)).join(',')})`;
      }
    }
    return ramp[ramp.length - 1][1];
  }

  // Amenity access gets its own hue. Reusing the report ramp would say "more
  // is worse", which is backwards for bars and coffee.
  const AMEN = [[0, '#20222A'], [33, '#5A4526'], [66, '#A8792F'], [100, '#F5C46B']];
  // Used when the overlay is asked to pick out the good end rather than the
  // bad one. Same green as the calm axis of the two-dimensional view.
  const GOOD = [[0, '#1F2A26'], [33, '#2A5C48'], [66, '#3E9B72'], [100, '#8FE0B8']];

  // Two axes mixed the way light mixes: magenta for how much is around, cyan
  // for how calm it is given that. Dark = neither, and the places that are
  // both are the brightest thing on the map.
  // Four named corners, bilinearly blended, rather than mixing two inks: it
  // gives direct control over what "both" looks like, which is the only corner
  // anyone is really hunting for.
  //
  // On the dark map brightness carries the meaning - neither is nearly the
  // background, both is the brightest thing on screen. Over Zillow's pale
  // basemap that inverts: neither is white and disappears, both is a deep
  // emerald, the darkest and most visible mark on the page.
  const CORNERS = {
    dark:  { neither: [22, 32, 43],    lively: [200, 134, 42], calm: [53, 147, 122],  both: [127, 239, 196] },
    light: { neither: [255, 255, 255], lively: [232, 163, 61], calm: [127, 198, 164], both: [14, 110, 92] },
  };
  // Both axes are percentile ranks, so they are uniform by construction and a
  // linear blend leaves most of the city in a washed-out middle.
  const BIV_GAMMA = 2;

  function blend(corners, lively, calm) {
    const a = (Math.max(0, Math.min(100, lively)) / 100) ** BIV_GAMMA;
    const s = (Math.max(0, Math.min(100, calm)) / 100) ** BIV_GAMMA;
    return [0, 1, 2].map((i) => Math.round(
      (1 - a) * (1 - s) * corners.neither[i] + a * (1 - s) * corners.lively[i]
      + (1 - a) * s * corners.calm[i] + a * s * corners.both[i]
    ));
  }

  const bivariate = (lively, calm) => blend(CORNERS.dark, lively, calm);
  const bivariateInk = (lively, calm) => blend(CORNERS.light, lively, calm);

  // The map's ramps run dark-to-light for a dark basemap. Over Zillow's pale
  // one that puts the emphasised end at its palest, so the overlay gets its own
  // set running white-to-saturated: the more it matters, the darker the mark.
  const INK = {
    bad:  [[0, '#FFFFFF'], [50, '#E08A6E'], [100, '#A32E1E']],
    good: [[0, '#FFFFFF'], [50, '#7FC6A4'], [100, '#0E6E5C']],
    amen: [[0, '#FFFFFF'], [50, '#E8C07D'], [100, '#B07414']],
    div:  [[-40, '#2E8C86'], [0, '#F2F2F2'], [40, '#A32E1E']],
  };

  // Plain language beats an axis arrow. These are the four corners named.
  const BIV_KEY = [
    ['both', 'Lots to walk to, and calm for it'],
    ['lively', 'Lots to walk to, but rough for it'],
    ['calm', 'Calm, but little to walk to'],
    ['neither', 'Neither'],
  ];

  // goodIsLow says which end of the scale is the desirable one, so the overlay
  // can be asked to pick out good places rather than bad ones.
  const VIEW_META = {
    sweet: { bivariate: true, value: (p) => p.amenity, second: (p) => p.calm },
    walkable: { ramp: AMEN, lo: 'Little in reach', hi: 'Plenty', value: (p) => p.amenity, goodIsLow: false },
    reported: { ramp: SEQ, lo: 'Few reports', hi: 'Many', value: (p) => p.intensity, goodIsLow: true },
    adjusted: { ramp: SEQ, lo: 'Below city mix', hi: 'Above', value: (p) => p.composition, goodIsLow: true },
    gap: { ramp: DIV, lo: 'Count overstates', hi: 'Count understates', value: (p) => p.composition - p.intensity, diverging: true },
  };

  root.Sidewalk = { mercY, projector, boundsFromUrl, SEQ, DIV, AMEN, sample, bivariate, bivariateInk, CORNERS, BIV_GAMMA, BIV_KEY, GOOD, INK, VIEW_META };
})(typeof globalThis !== 'undefined' ? globalThis : window);
