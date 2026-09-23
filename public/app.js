const { SEQ, DIV, AMEN, sample, bivariate, CORNERS, BIV_GAMMA, BIV_KEY, VIEW_META } = globalThis.Sidewalk;

const COPY = {
  reported: 'Raw report density, the way the city\u2019s own data reads it. A neighbourhood that reports more of everything looks worse here.',
  adjusted: 'Encampment reports as a share of all reports from the same area, so how readily a neighbourhood picks up the phone divides out.',
  gap: 'Where the two readings part company. Rose: worse than the raw count suggests. Teal: the raw count is inflated \u2014 usually a neighbourhood that reports everything, loudly.',
  walkable: 'Bars, restaurants, coffee and parks within a walk, measured outward from each cell rather than by what happens to sit inside it.',
  sweet: 'Lively places report more disorder, partly because more people are there to report it. So this asks a fairer question: among places with a comparable amount going on, which stay calmer?',
};

const EXPR = {
  reported: ['get', 'intensity'],
  adjusted: ['get', 'composition'],
  gap: ['-', ['get', 'composition'], ['get', 'intensity']],
  walkable: ['get', 'amenity'],
};
const VIEWS = Object.fromEntries(Object.entries(VIEW_META)
  .map(([k, v]) => [k, { ...v, expr: EXPR[k], explainer: COPY[k] }]));

// Bilinear blend of the same four named corners the canvas overlay uses, so
// the two renderers cannot drift apart.
const bivariateExpr = () => {
  const a = ['^', ['/', ['get', 'amenity'], 100], BIV_GAMMA];
  const s = ['^', ['/', ['get', 'calm'], 100], BIV_GAMMA];
  const C = CORNERS.dark;
  return ['rgb', ...[0, 1, 2].map((i) => ['+',
    ['*', ['-', 1, a], ['-', 1, s], C.neither[i]],
    ['*', a, ['-', 1, s], C.lively[i]],
    ['*', ['-', 1, a], s, C.calm[i]],
    ['*', a, s, C.both[i]],
  ])];
};
const colourExpr = (v) => (v.bivariate
  ? bivariateExpr()
  : ['interpolate', ['linear'], ['to-number', v.expr ?? 0], ...v.ramp.flat()]);
const cssRamp = (ramp) => {
  const lo = ramp[0][0], hi = ramp[ramp.length - 1][0];
  const stops = ramp.map(([p, c]) => `${c} ${(((p - lo) / (hi - lo)) * 100).toFixed(1)}%`);
  return `linear-gradient(90deg, ${stops.join(', ')})`;
};

// Esri's dark canvas serves without an API key; CARTO started requiring one.
// Note the {z}/{y}/{x} order - ArcGIS addresses tiles row-then-column.
const esri = (service) => ({
  type: 'raster', tileSize: 256, maxzoom: 16,
  tiles: [`https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/${service}/MapServer/tile/{z}/{y}/{x}`],
});

const map = new maplibregl.Map({
  container: 'map',
  center: [-122.3321, 47.6162],
  zoom: 11.1,
  minzoom: 9,
  maxzoom: 17,
  attributionControl: false,
  style: {
    version: 8,
    sources: { base: esri('World_Dark_Gray_Base'), labels: esri('World_Dark_Gray_Reference') },
    layers: [
      { id: 'base', type: 'raster', source: 'base', paint: { 'raster-opacity': 1, 'raster-brightness-max': 0.34, 'raster-saturation': -0.25 } },
    ],
  },
});
map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-right');

// Exposed so the screenshot harness (and the console) can drive the camera.
globalThis.Sidewalk.map = map;

const $ = (s) => document.querySelector(s);
let data = null;
let hovered = null;

map.on('load', async () => {
  const res = await fetch('data/cells.geojson');
  data = await res.json();

  map.addSource('cells', { type: 'geojson', data, promoteId: 'h3' });

  // Cells with too little evidence are outlined, never filled: "nobody reports
  // here" must not look the same as "nothing happens here".
  map.addLayer({
    id: 'cells-unknown', type: 'fill', source: 'cells',
    filter: ['==', ['get', 'conf'], 'low'],
    paint: { 'fill-color': '#7E8C99', 'fill-opacity': 0.05, 'fill-outline-color': '#3A4A5A' },
  });
  map.addLayer({
    id: 'cells-fill', type: 'fill', source: 'cells',
    filter: ['!=', ['get', 'conf'], 'low'],
    paint: {
      'fill-color': colourExpr(VIEWS.reported),
      'fill-opacity': ['case', ['boolean', ['feature-state', 'hover'], false], 0.92, 0.74],
    },
  });
  map.addLayer({
    id: 'cells-edge', type: 'line', source: 'cells',
    filter: ['!=', ['get', 'conf'], 'low'],
    paint: {
      'line-color': ['case', ['boolean', ['feature-state', 'hover'], false], '#FFFFFF', '#0E141A'],
      'line-width': ['case', ['boolean', ['feature-state', 'hover'], false], 1.6, 0.35],
    },
  });
  // Street names ride on top of the data so the fills never bury them.
  map.addLayer({ id: 'labels', type: 'raster', source: 'labels', paint: { 'raster-opacity': 0.95 } });

  for (const layer of ['cells-fill', 'cells-unknown']) {
    map.on('mousemove', layer, (e) => setHover(e.features[0]));
    map.on('mouseleave', layer, () => setHover(null));
  }
  map.getCanvas().style.cursor = 'crosshair';

  frameToData();
  renderSummary();
  setView('sweet');
});

// Frame the data rather than a hardcoded centre, leaving room for the rail so
// Seattle sits in the visible half of the viewport.
function frameToData() {
  // A handful of reports geocode to the far side of the Sound; framing on the
  // raw extent buries Seattle in a corner, so frame the middle 96%.
  const lngs = data.features.map((f) => f.properties.lng).sort((a, b) => a - b);
  const lats = data.features.map((f) => f.properties.lat).sort((a, b) => a - b);
  const at = (arr, q) => arr[Math.floor((arr.length - 1) * q)];

  // Seattle is a north-south ribbon, so a wide window fits it by height and
  // leaves half the screen as open water. Reserving space on the right pulls
  // the city back against the rail instead of centring it in the leftover.
  const rail = getComputedStyle(document.documentElement).getPropertyValue('--rail').trim();
  const stacked = rail.endsWith('%');
  const width = map.getContainer().clientWidth;
  const left = stacked ? 24 : parseInt(rail, 10) + 24;
  const right = stacked ? 24 : Math.max(24, Math.round((width - left) * 0.34));

  map.fitBounds(
    [[at(lngs, 0.02), at(lats, 0.02)], [at(lngs, 0.98), at(lats, 0.98)]],
    { padding: { left, right, top: 24, bottom: 24 }, duration: 0 },
  );
}

function setHover(feature) {
  if (hovered && (!feature || feature.properties.h3 !== hovered)) {
    map.setFeatureState({ source: 'cells', id: hovered }, { hover: false });
    hovered = null;
  }
  if (!feature) { renderSummary(); return; }
  hovered = feature.properties.h3;
  map.setFeatureState({ source: 'cells', id: hovered }, { hover: true });
  renderCell(feature.properties);
}

const bar = (pct, colour) => `<div class="meter"><i style="width:${Math.max(2, pct)}%;background:${colour}"></i></div>`;
const rampColour = sample;

function parseTypes(value) {
  if (!value) return {};
  if (typeof value !== 'string') return value;
  try { return JSON.parse(value); } catch { return {}; }
}

function verdictFor(p) {
  if (p.conf === 'low') return 'Too few reports of any kind here to tell a quiet street from an unreported one.';
  if (p.amenity >= 70 && p.calm >= 65) return 'Plenty in reach, and calmer than most places with this much going on.';
  if (p.amenity >= 70 && p.calm < 45) return 'Plenty in reach, and it shows: busier with reports than its peers.';
  if (p.amenity < 40 && p.calm >= 65) return 'Calm, but there is little here to walk to.';
  if (p.amenity < 40) return 'Little in reach, and still more reported than comparable places.';
  return 'Middling on both counts.';
}

function renderCell(p) {
  // MapLibre serialises nested feature properties to JSON strings, so these
  // come back as text rather than the objects the ingest wrote.
  // Types travel as one-letter codes with the mapping carried once in the
  // metadata; at 12k cells the full names would add megabytes.
  const names = data.metadata.typeNames ?? {};
  const types = Object.entries(parseTypes(p.types))
    .map(([code, n]) => [names[code] ?? code, n])
    .sort((a, b) => b[1] - a[1]);
  const access = parseTypes(p.access);
  const bivColour = `rgb(${bivariate(p.amenity, p.calm).join(',')})`;

  $('#cell').innerHTML = `
    <h2>${p.enc.toLocaleString()} encampment ${p.enc === 1 ? 'report' : 'reports'}</h2>
    <p class="sub">${p.lat.toFixed(4)}, ${p.lng.toFixed(4)} \u00b7 within ${data.metadata.localKm2 ?? 0.1} km\u00b2 \u00b7 ${p.conf} confidence</p>
    <dl class="rows">
      <div class="row"><dt>Lively</dt><dd>${p.amenity}<em> / 100</em></dd></div>
      ${bar(p.amenity, rampColour(AMEN, p.amenity))}
      <div class="row"><dt>Calm for that</dt><dd>${p.calm}<em> / 100</em></dd></div>
      ${bar(p.calm, bivColour)}
      <div class="row"><dt>Reported</dt><dd>${p.intensity}<em> / 100</em></dd></div>
      ${bar(p.intensity, rampColour(SEQ, p.intensity))}
      <div class="row"><dt>Adjusted</dt><dd>${p.composition}<em> / 100</em></dd></div>
      ${bar(p.composition, rampColour(SEQ, p.composition))}
    </dl>
    <p class="hint" style="margin-top:14px">${verdictFor(p)}</p>
    <div class="access">
      <p class="hint" style="margin:0 0 10px">Within a walk, fading to nothing at fifteen minutes:</p>
      <dl class="rows">
        ${[['bars', 'Bars and pubs'], ['food', 'Restaurants'], ['coffee', 'Coffee'], ['parks', 'Parks']]
          .map(([k, label]) => `<div class="row"><dt>${label}</dt><dd>${Math.round(access[k] ?? 0)}</dd></div>`).join('')}
      </dl>
    </div>
    ${types.length ? `<div class="types"><dl class="rows">${types.map(([t, n]) =>
      `<div class="row"><dt>${t}</dt><dd>${n.toLocaleString()}</dd></div>`).join('')}</dl></div>` : ''}
  `;
}

function renderSummary() {
  const m = data.metadata;
  $('#cell').innerHTML = `
    <h2>${m.encampmentReports.toLocaleString()} encampment reports</h2>
    <p class="sub">and ${m.disorderReports.toLocaleString()} reports of dumping, graffiti, litter, abandoned vehicles and dark streetlights, against ${m.amenities.toLocaleString()} bars, restaurants, cafes and parks</p>
    <p class="hint">Point at any cell to read it. Recent reports count for more than old ones — encampments move, and the city sweeps them.</p>
  `;
}

function setView(name) {
  const v = VIEWS[name];
  map.setPaintProperty('cells-fill', 'fill-color', colourExpr(v));
  $('#ramp-key').hidden = !!v.bivariate;
  $('#biv-key').hidden = !v.bivariate;
  if (v.bivariate) buildBivKey();
  else {
    $('#ramp').style.background = cssRamp(v.ramp);
    $('#ramp-lo').textContent = v.lo;
    $('#ramp-hi').textContent = v.hi;
  }
  $('#explainer').textContent = v.explainer;
}

// Nine swatches to show the space is continuous, then the four corners named
// outright. An axis arrow assumes the reader already knows what the two
// dimensions are; naming them does not.
function buildBivKey() {
  const grid = $('#biv-grid');
  if (grid.childElementCount) return;
  for (const calm of [100, 50, 0]) {
    for (const lively of [0, 50, 100]) {
      const i = document.createElement('i');
      i.style.background = `rgb(${bivariate(lively, calm).join(',')})`;
      grid.appendChild(i);
    }
  }
  $('#biv-legend').innerHTML = BIV_KEY.map(([corner, label]) =>
    `<div><dt style="background:rgb(${CORNERS.dark[corner].join(',')})"></dt><dd>${label}</dd></div>`).join('');
}

document.querySelectorAll('input[name=view]').forEach((el) => {
  el.addEventListener('change', () => setView(el.value));
});

