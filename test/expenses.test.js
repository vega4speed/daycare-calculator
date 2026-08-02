import test from 'node:test';
import assert from 'node:assert/strict';
import {
  cumulativeEscalator,
  semiFixed,
  fitSemiFixed,
  computeExpenses,
} from '../engine/expenses.js';

const near = (a, b, eps = 0.01) =>
  assert.ok(Math.abs(a - b) < eps, `${a} should be within ${eps} of ${b}`);

test('escalators compound monthly from an annual rate', () => {
  assert.equal(cumulativeEscalator(0, 24), 1);
  assert.equal(cumulativeEscalator(undefined, 24), 1);
  near(cumulativeEscalator(0.03, 12), 1.03);
  near(cumulativeEscalator(0.03, 24), 1.0609);
  // A mid-year month gets a partial year, not a step change every twelve months.
  near(cumulativeEscalator(0.03, 6), 1.0149, 0.0001);
});

test("the plan's supplies line is cleanly per-child at $120", () => {
  // $1,680 at 14 children and $4,320 at 36 -- both exactly $120/child/mo.
  near(1680 / 14, 120);
  near(4320 / 36, 120);
  const e = computeExpenses({ children: 14, perChild: 120 });
  near(e.lines.supplies, 1680);
  near(computeExpenses({ children: 36, perChild: 120 }).lines.supplies, 4320);
});

test("the plan's overhead line is semi-fixed, and fitSemiFixed recovers it", () => {
  // $2,500 at 14 children, $3,000 at 36 -- neither flat nor proportional.
  const fit = fitSemiFixed([14, 2500], [36, 3000]);
  near(fit.perChild, 22.727, 0.001);
  near(fit.base, 2181.82, 0.01);

  // And the fit reproduces both observations.
  near(semiFixed(fit, 14), 2500);
  near(semiFixed(fit, 36), 3000);
});

test('fitSemiFixed rejects two observations at the same enrollment', () => {
  assert.throws(() => fitSemiFixed([14, 2500], [14, 3000]), /two different enrollment levels/);
});

test('semiFixed floors negative enrollment at zero', () => {
  assert.equal(semiFixed({ base: 1000, perChild: 10 }, -5), 1000);
  assert.equal(semiFixed({ base: 1000, perChild: 10 }, undefined), 1000);
});

test('insurance escalates on its own track, separate from general inflation', () => {
  // Healthcare and liability insurance have not tracked CPI -- the same reason the retirement
  // calculator gives medical inflation its own accumulator.
  const e = computeExpenses({
    insurance: 1000, rent: 1000, monthsElapsed: 12,
    escalators: { general: 0.03, insurance: 0.10 },
  });
  near(e.lines.insurance, 1100);
  near(e.lines.rent, 1030);
});

test('insurance falls back to the general escalator when it has none of its own', () => {
  const e = computeExpenses({ insurance: 1000, monthsElapsed: 12, escalators: { general: 0.03 } });
  near(e.lines.insurance, 1030);
});

test('one-time costs are taken as entered, not escalated', () => {
  // Month spikes are actual dollars of that month -- the $879 licensing fee is $879.
  const e = computeExpenses({ oneTime: 879, monthsElapsed: 24, escalators: { general: 0.10 } });
  near(e.lines.oneTime, 879);
});

test('payroll passes through unescalated -- wages have their own track', () => {
  const e = computeExpenses({ payroll: 10000, monthsElapsed: 24, escalators: { general: 0.10 } });
  near(e.lines.payroll, 10000);
});

test('named other lines are included and escalated generally', () => {
  const e = computeExpenses({
    monthsElapsed: 12, escalators: { general: 0.02 },
    other: { food: 500, curriculum: 100 },
  });
  near(e.lines.food, 510);
  near(e.lines.curriculum, 102);
  near(e.total, 612);
});

test("reproduces the plan's launch expense total at 14 children", () => {
  // Plan section 7: payroll 9,300 + supplies 1,680 + overhead 2,500 + insurance ~650 = ~14,000.
  const e = computeExpenses({
    children: 14,
    payroll: 9300,
    perChild: 120,
    overhead: fitSemiFixed([14, 2500], [36, 3000]),
    insurance: 650,
  });
  near(e.total, 14130, 1);
  assert.ok(Math.abs(e.total - 14000) < 200, "within rounding of the plan's ~$14,000");
});

test("reproduces the plan's stable expense total at 36 children", () => {
  // Plan section 7: payroll 22,000 + supplies 4,320 + overhead 3,000 + insurance ~650 = ~30,000.
  const e = computeExpenses({
    children: 36,
    payroll: 22000,
    perChild: 120,
    overhead: fitSemiFixed([14, 2500], [36, 3000]),
    insurance: 650,
  });
  near(e.total, 29970, 1);
  assert.ok(Math.abs(e.total - 30000) < 200, "within rounding of the plan's ~$30,000");
});

test('cost per child falls with scale -- the whole thesis of the phased plan', () => {
  const overhead = fitSemiFixed([14, 2500], [36, 3000]);
  const small = computeExpenses({ children: 14, payroll: 9300, perChild: 120, overhead, insurance: 650 });
  const large = computeExpenses({ children: 36, payroll: 22000, perChild: 120, overhead, insurance: 650 });
  near(small.perChildCost, 1009.29, 0.01);
  near(large.perChildCost, 832.5, 0.01);
  assert.ok(large.perChildCost < small.perChildCost);
});

test('an empty program reports no cost-per-child rather than Infinity', () => {
  const e = computeExpenses({ children: 0, overhead: { base: 2000, perChild: 20 } });
  assert.equal(e.perChildCost, null);
  near(e.total, 2000);
});

test('computeExpenses works with no arguments at all', () => {
  const e = computeExpenses();
  assert.equal(e.total, 0);
  assert.equal(e.perChildCost, null);
});
