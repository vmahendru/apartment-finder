import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  metresBetween, walkWeight, categoryOf, dedupe, accessFrom, livelinessFrom,
  FULL_CREDIT_M, MAX_WALK_M, CATEGORY_WEIGHTS,
} from '../src/amenity.mjs';

const close = (a, b, eps) => assert.ok(Math.abs(a - b) < eps, `${a} !~= ${b}`);

test('metresBetween agrees with haversine to under a metre across Seattle', () => {
  const hav = (lat1, lng1, lat2, lng2) => {
    const R = 6371008.8, r = Math.PI / 180;
    const dLat = (lat2 - lat1) * r, dLng = (lng2 - lng1) * r;
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * r) * Math.cos(lat2 * r) * Math.sin(dLng / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(h));
  };
  // 15th & Mercer to Volunteer Park, and a long cross-city leg.
  close(metresBetween(47.6255, -122.3121, 47.6304, -122.3157), hav(47.6255, -122.3121, 47.6304, -122.3157), 1);
  // Equirectangular genuinely degrades over a 30 km leg; a few metres is fine.
  close(metresBetween(47.49, -122.44, 47.75, -122.22), hav(47.49, -122.44, 47.75, -122.22), 30);
});

test('one degree of latitude at Seattle is about 111.2 km, not the equatorial 110.5', () => {
  close(metresBetween(47.6, -122.3, 48.6, -122.3), 111190, 60);
});

test('walkWeight: full credit inside five minutes, nothing past fifteen', () => {
  assert.equal(walkWeight(0), 1);
  assert.equal(walkWeight(FULL_CREDIT_M), 1);
  assert.equal(walkWeight(MAX_WALK_M), 0);
  assert.equal(walkWeight(5000), 0);
  // Halfway through the taper: 400 + (1200-400)/2 = 800m -> 0.5
  close(walkWeight(800), 0.5, 1e-12);
});

test('walkWeight never increases with distance', () => {
  let prev = Infinity;
  for (let d = 0; d <= 1500; d += 25) {
    const w = walkWeight(d);
    assert.ok(w <= prev, `weight rose at ${d}m`);
    prev = w;
  }
});

test('categoryOf maps the tags we query and refuses the rest', () => {
  assert.equal(categoryOf({ amenity: 'bar' }), 'bars');
  assert.equal(categoryOf({ amenity: 'pub' }), 'bars');
  assert.equal(categoryOf({ amenity: 'restaurant' }), 'food');
  assert.equal(categoryOf({ amenity: 'fast_food' }), 'food');
  assert.equal(categoryOf({ amenity: 'cafe' }), 'coffee');
  assert.equal(categoryOf({ shop: 'coffee' }), 'coffee');
  assert.equal(categoryOf({ leisure: 'park' }), 'parks');
  assert.equal(categoryOf({ amenity: 'pharmacy' }), null);
  assert.equal(categoryOf(null), null);
});

test('dedupe drops a venue mapped as both node and building', () => {
  const pois = [
    { category: 'bars', lat: 47.62551, lng: -122.31213 },
    { category: 'bars', lat: 47.62554, lng: -122.31215 }, // same place, ~4m, straddles a 4dp grid line
    { category: 'food', lat: 47.62551, lng: -122.31213 }, // different category
    { category: 'bars', lat: 47.63000, lng: -122.31213 }, // genuinely elsewhere
  ];
  assert.equal(dedupe(pois).length, 3);
});

test('accessFrom weights a near venue fully and ignores a far one', () => {
  const here = { lat: 47.6255, lng: -122.3121 };
  const pois = [
    { category: 'bars', lat: 47.6257, lng: -122.3121 },  // ~22m
    { category: 'bars', lat: 47.7400, lng: -122.3121 },  // ~12km
  ];
  const a = accessFrom(here.lat, here.lng, pois);
  close(a.bars, 1, 1e-9);
  assert.equal(a.food, 0);
});

test('liveliness applies the category weights', () => {
  const access = { bars: 2, food: 3, coffee: 1, parks: 4 };
  const expected = 2 * CATEGORY_WEIGHTS.bars + 3 * CATEGORY_WEIGHTS.food
                 + 1 * CATEGORY_WEIGHTS.coffee + 4 * CATEGORY_WEIGHTS.parks;
  close(livelinessFrom(access), expected, 1e-12);   // 2 + 3 + 0.7 + 2 = 7.7
  close(livelinessFrom(access), 7.7, 1e-12);
});

test('liveliness of nowhere is zero', () => {
  close(livelinessFrom({ bars: 0, food: 0, coffee: 0, parks: 0 }), 0, 1e-12);
});
