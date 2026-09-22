import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

new Function(readFileSync(new URL('../public/shared.js', import.meta.url).pathname, 'utf8'))();
const { mercY, projector, boundsFromUrl } = globalThis.Sidewalk;
const close = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) < eps, `${a} !~= ${b}`);

test('mercY is 0 at the equator and antisymmetric', () => {
  close(mercY(0), 0);
  close(mercY(30) + mercY(-30), 0);
});

test('corners land exactly on the pixel box', () => {
  const b = { west: -122.44, east: -122.22, south: 47.49, north: 47.74 };
  const p = projector(b, 1000, 800);
  const nw = p(b.west, b.north), se = p(b.east, b.south);
  close(nw[0], 0); close(nw[1], 0);
  close(se[0], 1000, 1e-9); close(se[1], 800, 1e-9);
});

test('longitude is linear across the box', () => {
  const p = projector({ west: -122.4, east: -122.2, south: 47.5, north: 47.7 }, 1000, 1000);
  close(p(-122.3, 47.6)[0], 500);
});

test('a latitude-symmetric box puts the equator at half height', () => {
  const p = projector({ west: -10, east: 10, south: -45, north: 45 }, 100, 1000);
  close(p(0, 0)[1], 500, 1e-9);
});

test('latitude is NOT linear: Seattle sits below the midpoint of its own box', () => {
  // The whole point of using Mercator rather than a linear lerp. At 47.6N the
  // projection pushes a mid-latitude point measurably off centre.
  const b = { west: -122.44, east: -122.22, south: 47.49, north: 47.74 };
  const mid = (b.south + b.north) / 2;
  const y = projector(b, 1000, 1000)(-122.33, mid)[1];
  assert.ok(Math.abs(y - 500) > 0.05, `expected Mercator offset, got y=${y}`);
  assert.ok(y > 500, 'a Mercator midpoint falls south of the linear midpoint');
});

test('boundsFromUrl reads Zillow searchQueryState', () => {
  const state = { pagination: {}, mapBounds: { west: -122.44, east: -122.22, south: 47.49, north: 47.74 }, mapZoom: 12 };
  const href = 'https://www.zillow.com/seattle-wa/rentals/?searchQueryState=' + encodeURIComponent(JSON.stringify(state));
  assert.deepEqual(boundsFromUrl(href), { west: -122.44, east: -122.22, south: 47.49, north: 47.74, zoom: 12 });
});

test('boundsFromUrl refuses junk rather than drawing in the wrong place', () => {
  assert.equal(boundsFromUrl('https://www.zillow.com/seattle-wa/rentals/'), null);
  assert.equal(boundsFromUrl('https://www.zillow.com/?searchQueryState=not-json'), null);
  assert.equal(boundsFromUrl('https://www.zillow.com/?searchQueryState=' + encodeURIComponent('{"mapBounds":{"west":1,"east":0,"south":0,"north":1}}')), null);
  assert.equal(boundsFromUrl('not a url'), null);
});
