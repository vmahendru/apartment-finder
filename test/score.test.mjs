import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  hasToken, encampmentSeverity, recencyWeight, shrunkShare,
  compositionRatio, percentileRanks, confidence, SEVERITY_FLOOR, residualByBand,
} from '../src/score.mjs';

const close = (a, b, eps = 1e-9) =>
  assert.ok(Math.abs(a - b) < eps, `${a} !~= ${b}`);

test('hasToken survives the comma inside "Hazardous materials (e.g., propane tanks)"', () => {
  const field = 'Garbage/Loose litter,Hazardous materials (e.g., propane tanks)';
  assert.equal(hasToken(field, 'Hazardous materials'), true);
  assert.equal(hasToken(field, 'Needles/Sharps'), false);
  assert.equal(hasToken(undefined, 'Sidewalk'), false);
});

test('severity: tents (1.0) + loose litter (0.3) = 1.3', () => {
  close(encampmentSeverity({
    aretheretentsstructuresortarps: 'Yes',
    istheretrashordebris: 'Garbage/Loose litter',
  }), 1.3);
});

test('severity: a report with no observations still counts at the floor', () => {
  assert.equal(encampmentSeverity({}), SEVERITY_FLOOR);
  assert.equal(encampmentSeverity({ aretheretentsstructuresortarps: 'Unknown' }), SEVERITY_FLOOR);
});

test('severity: explicit "None"/"No blockage" add nothing', () => {
  // tents 1.0 only; the None and No blockage answers must not fall through
  // to the token loops.
  close(encampmentSeverity({
    aretheretentsstructuresortarps: 'Yes',
    istheretrashordebris: 'None',
    istheencampmentblockingaccess: 'No blockage',
  }), 1.0);
});

test('severity: stray vehicle colours count as a vehicle, "No"/"Unknown" do not', () => {
  close(encampmentSeverity({ aretherervscarsmiscvehicles: 'White' }), 0.5); // 0.3 -> floor 0.5
  close(encampmentSeverity({
    aretheretentsstructuresortarps: 'Yes',
    aretherervscarsmiscvehicles: 'White',
  }), 1.3); // 1.0 + 0.3
  close(encampmentSeverity({
    aretheretentsstructuresortarps: 'Yes',
    aretherervscarsmiscvehicles: 'No',
  }), 1.0);
});

test('severity: sidewalk blockage outweighs a construction project', () => {
  const side = encampmentSeverity({ istheencampmentblockingaccess: 'Sidewalk' });
  const cons = encampmentSeverity({ istheencampmentblockingaccess: 'Construction project' });
  assert.ok(side > cons, `${side} should exceed ${cons}`);
});

test('recencyWeight halves every half-life', () => {
  close(recencyWeight(0, 90), 1);
  close(recencyWeight(90, 90), 0.5);
  close(recencyWeight(180, 90), 0.25);
});

test('shrunkShare: (10 + 20*0.5) / (10 + 20) = 0.6667', () => {
  close(shrunkShare(10, 10, 0.5, 20), 20 / 30);
});

test('shrunkShare: a cell with no reports sits exactly at the city share', () => {
  close(shrunkShare(0, 0, 0.42, 20), 0.42);
});

test('compositionRatio: 1.0 means indistinguishable from the city', () => {
  // A cell whose mix matches the city exactly: n/total == cityShare.
  close(compositionRatio(50, 100, 0.5, 20), 1);
});

test('compositionRatio: shrinkage pulls a thin extreme cell toward 1', () => {
  // 2 of 2 reports in-category against a city share of 0.5. Raw share would
  // be 1.0 (ratio 2.0); shrunk: (2 + 10) / (2 + 20) = 0.5454 -> 1.09.
  close(compositionRatio(2, 2, 0.5, 20), (12 / 22) / 0.5);
  const thin = compositionRatio(2, 2, 0.5, 20);
  const thick = compositionRatio(200, 200, 0.5, 20);
  assert.ok(thin < thick, 'thin cells must be pulled further toward the mean');
});

test('percentileRanks spans 0..100 and averages ties', () => {
  assert.deepEqual(percentileRanks([1, 2, 3]), [0, 50, 100]);
  assert.deepEqual(percentileRanks([5, 5, 5]), [50, 50, 50]);
  assert.deepEqual(percentileRanks([]), []);
  assert.deepEqual(percentileRanks([7]), [50]);
});

test('percentileRanks is order-independent of input position', () => {
  assert.deepEqual(percentileRanks([3, 1, 2]), [100, 0, 50]);
});

test('confidence degrades with thin evidence', () => {
  assert.equal(confidence(30), 'high');
  assert.equal(confidence(8), 'medium');
  assert.equal(confidence(0), 'low');
});

test('residualByBand strips a monotone relationship out', () => {
  // Two bands: {10,20} median 15, {30,40} median 35.
  assert.deepEqual(residualByBand([1, 2, 3, 4], [10, 20, 30, 40], 2), [-5, 5, -5, 5]);
});

test('residualByBand finds the cell that is calm for its band', () => {
  // Four lively cells; the third is much quieter than its peers.
  const amenity = [10, 20, 90, 91, 92, 93];
  const grime = [5, 6, 80, 82, 20, 84];
  const r = residualByBand(amenity, grime, 2);
  const quietest = r.indexOf(Math.min(...r));
  assert.equal(quietest, 4, 'the cell with grime 20 among lively peers should stand out');
  assert.ok(r[4] < -50, `expected a large negative residual, got ${r[4]}`);
});

test('residualByBand is flat when y does not depend on x', () => {
  const xs = [1, 2, 3, 4, 5, 6, 7, 8];
  const ys = [50, 50, 50, 50, 50, 50, 50, 50];
  assert.deepEqual(residualByBand(xs, ys, 4), [0, 0, 0, 0, 0, 0, 0, 0]);
});

test('residualByBand handles an empty input', () => {
  assert.deepEqual(residualByBand([], [], 5), []);
});
