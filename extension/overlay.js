(function () {
  const { projector, boundsFromUrl, sample, VIEW_META } = globalThis.Sidewalk;

  const VIEW_COPY = {
    reported: 'Reported',
    adjusted: 'Adjusted',
    gap: 'Disagreement',
  };

  let features = null;
  let container = null;
  let canvas = null;
  let ctx = null;
  let view = 'adjusted';
  let visible = true;
  let lastHref = '';

  // Zillow renames its classes constantly, so try the stable-ish hooks first
  // and fall back to "the biggest thing on the page that behaves like a map".
  const SELECTORS = [
    '#search-page-map',
    '[data-testid="search-page-map"]',
    '[data-testid="map"]',
    '.search-page-react-map',
    'div[class*="map-container"]',
  ];

  function findMap() {
    if (globalThis.SIDEWALK_CONTAINER) return document.querySelector(globalThis.SIDEWALK_CONTAINER);
    for (const sel of SELECTORS) {
      const el = document.querySelector(sel);
      if (el && el.clientWidth > 200 && el.clientHeight > 200) return el;
    }
    let best = null, bestArea = 0;
    for (const el of document.querySelectorAll('div')) {
      const r = el.getBoundingClientRect();
      const area = r.width * r.height;
      const looksLikeMap = el.querySelector('canvas, img[src*="tile"], img[src*="maps"]');
      if (looksLikeMap && area > bestArea && area > innerWidth * innerHeight * 0.15) {
        best = el; bestArea = area;
      }
    }
    return best;
  }

  function attach(el) {
    container = el;
    canvas = document.createElement('canvas');
    canvas.className = 'sidewalk-overlay';
    ctx = canvas.getContext('2d');
    const host = getComputedStyle(el).position === 'static' ? el.parentElement || el : el;
    if (getComputedStyle(host).position === 'static') host.style.position = 'relative';
    host.appendChild(canvas);
    new ResizeObserver(draw).observe(el);
    buildPanel(host);
  }

  function buildPanel(host) {
    const panel = document.createElement('div');
    panel.className = 'sidewalk-panel';
    panel.innerHTML = `
      <div class="sidewalk-head">
        <strong>Sidewalk</strong>
        <button type="button" class="sidewalk-toggle" aria-pressed="true">Hide</button>
      </div>
      <div class="sidewalk-views">
        ${Object.entries(VIEW_COPY).map(([k, label]) =>
          `<button type="button" data-view="${k}"${k === view ? ' aria-current="true"' : ''}>${label}</button>`).join('')}
      </div>
      <div class="sidewalk-ramp"></div>
      <div class="sidewalk-ends"><span></span><span></span></div>
      <p class="sidewalk-status"></p>`;
    host.appendChild(panel);

    panel.querySelectorAll('[data-view]').forEach((b) => b.addEventListener('click', () => {
      view = b.dataset.view;
      panel.querySelectorAll('[data-view]').forEach((o) => o.removeAttribute('aria-current'));
      b.setAttribute('aria-current', 'true');
      syncLegend(); draw();
    }));
    const toggle = panel.querySelector('.sidewalk-toggle');
    toggle.addEventListener('click', () => {
      visible = !visible;
      toggle.textContent = visible ? 'Hide' : 'Show';
      toggle.setAttribute('aria-pressed', String(visible));
      canvas.style.display = visible ? '' : 'none';
    });
    syncLegend();
  }

  function syncLegend() {
    const meta = VIEW_META[view];
    const ramp = meta.ramp;
    const lo = ramp[0][0], hi = ramp[ramp.length - 1][0];
    const stops = ramp.map(([p, c]) => `${c} ${(((p - lo) / (hi - lo)) * 100).toFixed(1)}%`);
    const el = document.querySelector('.sidewalk-ramp');
    if (!el) return;
    el.style.background = `linear-gradient(90deg, ${stops.join(', ')})`;
    const ends = document.querySelectorAll('.sidewalk-ends span');
    ends[0].textContent = meta.lo;
    ends[1].textContent = meta.hi;
  }

  const status = (msg) => {
    const el = document.querySelector('.sidewalk-status');
    if (el) el.textContent = msg;
  };

  // Over Zillow's light basemap a dark ramp would paint "few reports" as heavy
  // blotches, which reads backwards. Drive opacity from the value instead, so
  // quiet areas simply show Zillow's own map through.
  function alphaFor(value) {
    if (view === 'gap') return Math.min(0.55, Math.abs(value) / 40 * 0.55);
    return 0.06 + (Math.max(0, Math.min(100, value)) / 100) * 0.46;
  }

  function draw() {
    if (!features || !container || !visible) return;
    const bounds = boundsFromUrl(location.href);
    const rect = container.getBoundingClientRect();
    if (!rect.width || !rect.height) return;

    const dpr = Math.min(2, devicePixelRatio || 1);
    canvas.width = Math.round(rect.width * dpr);
    canvas.height = Math.round(rect.height * dpr);
    canvas.style.width = `${rect.width}px`;
    canvas.style.height = `${rect.height}px`;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, rect.width, rect.height);

    if (!bounds) {
      status('Pan or zoom the map once so Zillow writes its position into the address bar.');
      return;
    }

    const project = projector(bounds, rect.width, rect.height);
    const meta = VIEW_META[view];
    let drawn = 0;

    for (const f of features) {
      const [w, s, e, n] = f.bbox;
      if (e < bounds.west || w > bounds.east || n < bounds.south || s > bounds.north) continue;
      const value = meta.value(f.props);
      const alpha = alphaFor(value);
      if (alpha < 0.02) continue;

      ctx.beginPath();
      const ring = f.ring;
      for (let i = 0; i < ring.length; i += 2) {
        const [x, y] = project(ring[i], ring[i + 1]);
        if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      }
      ctx.closePath();
      ctx.globalAlpha = alpha;
      ctx.fillStyle = sample(meta.ramp, value);
      ctx.fill();
      drawn++;
    }
    ctx.globalAlpha = 1;
    status(`${drawn.toLocaleString()} cells in view · Seattle reports, last 365 days`);
  }

  function watchUrl() {
    setInterval(() => {
      if (location.href !== lastHref) { lastHref = location.href; draw(); }
    }, 250);
    addEventListener('resize', draw);
  }

  async function dataUrl() {
    if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.getURL) {
      return chrome.runtime.getURL('data/cells.geojson');
    }
    return 'data/cells.geojson';
  }

  async function start() {
    const el = findMap();
    if (!el) { console.warn('[Sidewalk] no map container found on this page'); return; }
    attach(el);
    const res = await fetch(await dataUrl());
    const gj = await res.json();
    // Flatten once: canvas redraws on every pan, so per-frame work must be
    // arithmetic only, not object walking.
    features = gj.features.map((f) => {
      const coords = f.geometry.coordinates[0];
      const ring = new Float64Array(coords.length * 2);
      let w = 180, s = 90, e = -180, n = -90;
      coords.forEach(([lng, lat], i) => {
        ring[i * 2] = lng; ring[i * 2 + 1] = lat;
        if (lng < w) w = lng; if (lng > e) e = lng;
        if (lat < s) s = lat; if (lat > n) n = lat;
      });
      return { ring, bbox: [w, s, e, n], props: f.properties };
    });
    lastHref = location.href;
    draw();
    watchUrl();
  }

  globalThis.SidewalkOverlay = { draw, start, setView: (v) => { view = v; syncLegend(); draw(); } };

  if (document.readyState === 'loading') addEventListener('DOMContentLoaded', start);
  else start();
})();
