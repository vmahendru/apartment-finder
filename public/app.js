const { SEQ, DIV, projector, sample } = globalThis.Sidewalk;

const VIEWS = {
  reported: {
    ramp: SEQ, lo: 'Few reports', hi: 'Many',
    expr: ['get', 'intensity'],
    explainer: 'Raw report density, the way the city’s own data reads it. A neighbourhood that reports more of everything looks worse here.',
  },
  adjusted: {
    ramp: SEQ, lo: 'Below city mix', hi: 'Above',
    expr: ['get', 'composition'],
    explainer: 'Encampment reports as a share of all reports from the same area, so how readily a neighbourhood picks up the phone divides out.',
  },
  gap: {
    ramp: DIV, lo: 'Count overstates', hi: 'Count understates',
    expr: ['-', ['get', 'composition'], ['get', 'intensity']],
    explainer: 'Where the two readings part company. Rose: worse than the raw count suggests. Teal: the raw count is inflated — usually a neighbourhood that reports everything, loudly.',
  },
};

const colourExpr = (v) => ['interpolate', ['linear'], v.expr, ...v.ramp.flat()];
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
  setView('reported');
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

function renderCell(p) {
  const gap = p.composition - p.intensity;
  // MapLibre serialises nested feature properties to JSON strings, so this
  // comes back as text rather than the object the ingest wrote.
  const types = Object.entries(parseTypes(p.types)).sort((a, b) => b[1] - a[1]);
  const verdict = p.conf === 'low'
    ? 'Too few reports of any kind here to tell a quiet street from an unreported one.'
    : gap > 12 ? 'Worse than the raw count suggests — this area reports little else.'
    : gap < -12 ? 'The raw count overstates this. It reports everything, loudly.'
    : 'Both readings agree on this one.';

  $('#cell').innerHTML = `
    <h2>${p.enc.toLocaleString()} encampment ${p.enc === 1 ? 'report' : 'reports'}</h2>
    <p class="sub">${p.lat.toFixed(4)}, ${p.lng.toFixed(4)} · about 0.1 km² · ${p.conf} confidence</p>
    <dl class="rows">
      <div class="row"><dt>Reported</dt><dd>${p.intensity}<em> / 100</em></dd></div>
      ${bar(p.intensity, rampColour(SEQ, p.intensity))}
      <div class="row"><dt>Adjusted</dt><dd>${p.composition}<em> / 100</em></dd></div>
      ${bar(p.composition, rampColour(SEQ, p.composition))}
      <div class="row"><dt>Encampment share</dt><dd>${((p.enc / Math.max(1, p.total)) * 100).toFixed(0)}%<em> of ${p.total.toLocaleString()}</em></dd></div>
      <div class="row"><dt>Versus city mix</dt><dd>${p.ratio.toFixed(2)}×</dd></div>
    </dl>
    <p class="hint" style="margin-top:14px">${verdict}</p>
    ${types.length ? `<div class="types"><dl class="rows">${types.map(([t, n]) =>
      `<div class="row"><dt>${t}</dt><dd>${n.toLocaleString()}</dd></div>`).join('')}</dl></div>` : ''}
  `;
}

function renderSummary() {
  const m = data.metadata;
  $('#cell').innerHTML = `
    <h2>${m.encampmentReports.toLocaleString()} encampment reports</h2>
    <p class="sub">and ${m.disorderReports.toLocaleString()} reports of dumping, graffiti, litter, abandoned vehicles and dark streetlights</p>
    <p class="hint">Point at any cell to read it. Recent reports count for more than old ones — encampments move, and the city sweeps them.</p>
  `;
}

function setView(name) {
  const v = VIEWS[name];
  map.setPaintProperty('cells-fill', 'fill-color', colourExpr(v));
  $('#ramp').style.background = cssRamp(v.ramp);
  $('#ramp-lo').textContent = v.lo;
  $('#ramp-hi').textContent = v.hi;
  $('#explainer').textContent = v.explainer;
}

document.querySelectorAll('input[name=view]').forEach((el) => {
  el.addEventListener('change', () => setView(el.value));
});

