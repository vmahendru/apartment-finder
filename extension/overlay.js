(function () {
  const { projector, boundsFromUrl, sample, bivariateInk, CORNERS, BIV_KEY, INK, VIEW_META } = globalThis.Sidewalk;

  const VIEW_COPY = {
    sweet: 'Lively & calm',
    walkable: 'Walkable',
    reported: 'Reported',
    adjusted: 'Adjusted',
    gap: 'Disagreement',
  };

  let features = null;
  let container = null;
  let canvas = null;
  let ctx = null;
  let view = 'sweet';
  let visible = true;
  let lastHref = '';
  let emphasis = 'good';   // which end of the scale gets inked

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
      <div class="sidewalk-emphasis">
        <button type="button" data-emph="good" aria-current="true">Highlight good</button>
        <button type="button" data-emph="trouble">Highlight trouble</button>
      </div>
      <div class="sidewalk-ramp"></div>
      <div class="sidewalk-biv" hidden></div>
      <div class="sidewalk-ends"><span></span><span></span></div>
      <dl class="sidewalk-key" hidden></dl>
      <p class="sidewalk-status"></p>`;
    host.appendChild(panel);

    panel.querySelectorAll('[data-view]').forEach((b) => b.addEventListener('click', () => {
      view = b.dataset.view;
      panel.querySelectorAll('[data-view]').forEach((o) => o.removeAttribute('aria-current'));
      b.setAttribute('aria-current', 'true');
      syncLegend(); draw();
    }));
    panel.querySelectorAll('[data-emph]').forEach((b) => b.addEventListener('click', () => {
      emphasis = b.dataset.emph;
      panel.querySelectorAll('[data-emph]').forEach((o) => o.removeAttribute('aria-current'));
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
    const ramp1 = document.querySelector('.sidewalk-ramp');
    const biv = document.querySelector('.sidewalk-biv');
    const key = document.querySelector('.sidewalk-key');
    const ends = document.querySelectorAll('.sidewalk-ends span');
    const emph = document.querySelector('.sidewalk-emphasis');
    if (!ramp1) return;

    // The two-dimensional view already puts its emphasis on the good corner,
    // and the disagreement view has no good end, so the choice only applies
    // to the plain scales.
    emph.hidden = !!(meta.bivariate || meta.diverging);

    ramp1.hidden = !!meta.bivariate;
    biv.hidden = !meta.bivariate;
    key.hidden = !meta.bivariate;
    document.querySelector('.sidewalk-ends').hidden = !!meta.bivariate;

    if (meta.bivariate) {
      if (!biv.childElementCount) {
        for (const calm of [100, 50, 0]) {
          for (const lively of [0, 50, 100]) {
            const i = document.createElement('i');
            i.style.background = `rgb(${bivariateInk(lively, calm).join(',')})`;
            biv.appendChild(i);
          }
        }
        // Four named corners. An axis arrow assumes the reader already knows
        // what the two dimensions are; naming them does not.
        key.innerHTML = BIV_KEY.map(([corner, label]) =>
          `<div><dt style="background:rgb(${CORNERS.light[corner].join(',')})"></dt><dd>${label}</dd></div>`).join('');
      }
      return;
    }

    const ramp = rampFor(meta);
    const lo = ramp[0][0], hi = ramp[ramp.length - 1][0];
    const stops = ramp.map(([p, c]) => `${c} ${(((p - lo) / (hi - lo)) * 100).toFixed(1)}%`);
    ramp1.style.background = `linear-gradient(90deg, ${stops.join(', ')})`;
    const flipped = isFlipped(meta);
    ends[0].textContent = flipped ? meta.hi : meta.lo;
    ends[1].textContent = flipped ? meta.lo : meta.hi;
  }

  // When the inked end is not the view's own high end, the scale is reversed
  // and drawn in green: the mark now means "good here", not "trouble here".
  const isFlipped = (meta) =>
    !meta.bivariate && !meta.diverging && (emphasis === 'good') !== (meta.goodIsLow === false);

  // Which ink, given the view and which end is being emphasised. Amenity
  // access keeps its amber when shown the right way up; everything else is
  // red for trouble, emerald for good.
  function rampFor(meta) {
    if (meta.diverging) return INK.div;
    if (isFlipped(meta)) return meta.goodIsLow === false ? INK.bad : INK.good;
    return meta.goodIsLow === false ? INK.amen : INK.bad;
  }

  const status = (msg) => {
    const el = document.querySelector('.sidewalk-status');
    if (el) el.textContent = msg;
  };

  // Over Zillow's light basemap a dark ramp would paint "few reports" as heavy
  // blotches, which reads backwards. Drive opacity from the value instead, so
  // quiet areas simply show Zillow's own map through.
  function paintFor(props, meta) {
    if (meta.bivariate) {
      const lively = meta.value(props), calm = meta.second(props);
      // Curved rather than linear: Zillow's listings have to stay readable
      // through the middle of the range, so only genuinely good cells tint hard.
      return {
        fill: `rgb(${bivariateInk(lively, calm).join(',')})`,
        alpha: 0.04 + (((lively + calm) / 200) ** 1.6) * 0.44,
      };
    }
    const raw = meta.value(props);
    if (meta.diverging) {
      return { fill: sample(meta.ramp, raw), alpha: Math.min(0.5, (Math.abs(raw) / 40) * 0.5) };
    }
    const value = isFlipped(meta) ? 100 - raw : raw;
    return {
      fill: sample(rampFor(meta), value),
      alpha: 0.04 + ((Math.max(0, Math.min(100, value)) / 100) ** 1.4) * 0.42,
    };
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
      const { fill, alpha } = paintFor(f.props, meta);
      if (alpha < 0.02) continue;

      ctx.beginPath();
      const ring = f.ring;
      for (let i = 0; i < ring.length; i += 2) {
        const [x, y] = project(ring[i], ring[i + 1]);
        if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      }
      ctx.closePath();
      ctx.globalAlpha = alpha;
      ctx.fillStyle = fill;
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
