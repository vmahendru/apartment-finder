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

  // Night-lights ramp: cold empty ground warming to sodium where reports pile
  // up. Monotonic in lightness, so it survives greyscale and colour blindness.
  const SEQ = [
    [0, '#1E3350'], [25, '#38558A'], [50, '#6A5385'], [75, '#C46B58'], [100, '#FFC46B'],
  ];
  // Diverging, teal/rose rather than red/green.
  const DIV = [[-40, '#46C4C0'], [0, '#2A3644'], [40, '#E8637F']];

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

  // Amenity access gets its own hue. Reusing the sodium ramp would say "more
  // is worse", which is backwards for bars and coffee.
  const AMEN = [[0, '#1C1A28'], [33, '#5A2A55'], [66, '#A8417A'], [100, '#F58BB8']];

  // Two axes mixed the way light mixes: magenta for how much is around, cyan
  // for how calm it is given that. Dark = neither, and the places that are
  // both are the brightest thing on the map.
  // Balanced so the two single-axis corners land at similar brightness (~140)
  // and only the both-high corner reaches white. Shared with the map's own
  // colour expression so the two renderers cannot drift apart.
  // gamma: both axes are percentile ranks, so they are uniform by construction
  // and a linear mix leaves most of the city in a washed-out middle. Squaring
  // pushes the mid-range back down so only genuinely high values light up.
  const BIV = { base: [22, 30, 48], lively: [210, 75, 140], calm: [34, 140, 150], gamma: 2 };

  function bivariate(lively, calm) {
    const a = (Math.max(0, Math.min(100, lively)) / 100) ** BIV.gamma;
    const s = (Math.max(0, Math.min(100, calm)) / 100) ** BIV.gamma;
    return BIV.base.map((b, i) => Math.round(Math.min(255, b + a * BIV.lively[i] + s * BIV.calm[i])));
  }

  // The dark map mixes light: both axes high goes to white. Over Zillow's pale
  // basemap that is invisible, so there the same two hues mix as ink on paper
  // and both-high goes to a deep indigo - the most visible thing on the page.
  const INK = { lively: [20, 190, 60], calm: [200, 25, 30], gamma: 2 };

  function bivariateInk(lively, calm) {
    const a = (Math.max(0, Math.min(100, lively)) / 100) ** INK.gamma;
    const s = (Math.max(0, Math.min(100, calm)) / 100) ** INK.gamma;
    return [0, 1, 2].map((i) => Math.round(Math.max(0, 255 - a * INK.lively[i] - s * INK.calm[i])));
  }

  const VIEW_META = {
    reported: { ramp: SEQ, lo: 'Few reports', hi: 'Many', value: (p) => p.intensity },
    adjusted: { ramp: SEQ, lo: 'Below city mix', hi: 'Above', value: (p) => p.composition },
    gap: { ramp: DIV, lo: 'Count overstates', hi: 'Count understates', value: (p) => p.composition - p.intensity },
    walkable: { ramp: AMEN, lo: 'Little in reach', hi: 'Plenty', value: (p) => p.amenity },
    sweet: { bivariate: true, value: (p) => p.amenity, second: (p) => p.calm },
  };

  root.Sidewalk = { mercY, projector, boundsFromUrl, SEQ, DIV, AMEN, sample, bivariate, bivariateInk, BIV, INK, VIEW_META };
})(typeof globalThis !== 'undefined' ? globalThis : window);
