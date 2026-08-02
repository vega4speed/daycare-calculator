import test from 'node:test';
import assert from 'node:assert/strict';
import {
  compaRatio,
  rangePenetration,
  annualTurnoverRate,
  monthlyTurnoverRate,
  expectedDepartures,
  turnoverCosts,
  breakEvenSensitivity,
  requiredCostPerDeparture,
} from '../engine/turnover.js';

const near = (a, b, eps = 0.0001) =>
  assert.ok(Math.abs(a - b) < eps, `${a} should be within ${eps} of ${b}`);

// --- comp position -------------------------------------------------------------------------

test('compa-ratio measures position against the midpoint', () => {
  assert.equal(compaRatio(18, 18), 1, 'at mid');
  near(compaRatio(19.8, 18), 1.1); // Jake's "over mid"
  near(compaRatio(16.2, 18), 0.9);
});

test('compa-ratio returns null without a midpoint rather than a misleading number', () => {
  assert.equal(compaRatio(18, 0), null);
  assert.equal(compaRatio(18, null), null);
  assert.equal(compaRatio(18, undefined), null);
});

test('range penetration places a wage in min..max', () => {
  near(rangePenetration(18, { min: 15, max: 21 }), 0.5);
  assert.equal(rangePenetration(15, { min: 15, max: 21 }), 0);
  assert.equal(rangePenetration(25, { min: 15, max: 21 }), 1, 'clamped');
  assert.equal(rangePenetration(18, { min: 21, max: 15 }), null, 'inverted range');
  assert.equal(rangePenetration(18, {}), null);
});

// --- the rate model ------------------------------------------------------------------------

test('paying at midpoint yields the base turnover rate', () => {
  near(annualTurnoverRate({ baseAtMid: 0.35, sensitivity: 1.5 }, 1), 0.35);
});

test('paying above midpoint reduces turnover, below raises it', () => {
  const p = { baseAtMid: 0.35, sensitivity: 1.5, floor: 0, ceiling: 1 };
  // 10% above mid at sensitivity 1.5 -> 0.35 * (1 - 0.15) = 0.2975
  near(annualTurnoverRate(p, 1.1), 0.2975);
  near(annualTurnoverRate(p, 0.9), 0.4025);
});

test('the floor keeps turnover honest -- no wage eliminates it', () => {
  // Without a floor, arbitrarily large raises would look arbitrarily good.
  const p = { baseAtMid: 0.35, sensitivity: 1.5, floor: 0.10 };
  assert.equal(annualTurnoverRate(p, 3), 0.10);
  assert.equal(annualTurnoverRate(p, 10), 0.10);
});

test('the ceiling clamps a deep pay cut', () => {
  const p = { baseAtMid: 0.35, sensitivity: 1.5, floor: 0.1, ceiling: 0.8 };
  assert.equal(annualTurnoverRate(p, 0.1), 0.8);
});

test('zero sensitivity makes comp position irrelevant', () => {
  const p = { baseAtMid: 0.35, sensitivity: 0, floor: 0, ceiling: 1 };
  near(annualTurnoverRate(p, 1.5), 0.35);
  near(annualTurnoverRate(p, 0.5), 0.35);
});

test('a null compa-ratio is treated as at-midpoint', () => {
  near(annualTurnoverRate({ baseAtMid: 0.35 }, null), 0.35);
});

// --- monthly conversion ---------------------------------------------------------------------

test('annual turnover converts by compounding, and division UNDERSTATES it', () => {
  // 36%/yr is not 3%/mo. Losing 3% a month compounds to only 30.6% a year, so reaching 36%
  // takes a HIGHER monthly rate -- dividing by twelve understates turnover, and therefore its
  // cost. The direction is easy to get backwards.
  const m = monthlyTurnoverRate(0.36);
  near(m, 0.036508, 0.000001);
  assert.ok(m > 0.36 / 12, 'higher than the naive division, not lower');
  near(Math.pow(1 - m, 12), 1 - 0.36);
});

test('monthly rate handles the degenerate ends', () => {
  assert.equal(monthlyTurnoverRate(0), 0);
  assert.equal(monthlyTurnoverRate(undefined), 0);
  assert.ok(monthlyTurnoverRate(1) < 1, 'total turnover does not divide by zero');
});

test('expected departures scale with headcount', () => {
  const one = expectedDepartures(1, 0.36);
  near(expectedDepartures(10, 0.36), one * 10);
  assert.equal(expectedDepartures(0, 0.36), 0);
});

// --- the cost of turnover ---------------------------------------------------------------------

test('all four cost components are counted', () => {
  const c = turnoverCosts({
    departures: 1,
    recruitingCost: 500,
    onboardingCost: 300,
    vacancyWeeks: 4, coverageCostPerWeek: 800,
    rampWeeks: 6, rampProductivity: 0.5, weeklyWage: 720,
    enrollmentLossProb: 0.3, childrenLostPerEvent: 2,
    revenuePerChild: 1100, monthsToRefill: 2,
  });

  near(c.recruiting, 500);
  near(c.onboarding, 300);
  near(c.vacancy, 3200, 0.01);
  near(c.ramp, 2160, 0.01); // 6 weeks x $720 x 50% lost effectiveness
  near(c.directCost, 6160, 0.01);
  near(c.childrenLost, 0.6);
  near(c.revenueLost, 1320, 0.01); // 0.6 children x $1,100 x 2 months
  near(c.totalCost, 7480, 0.01);
});

test('enrollment loss is what makes turnover a revenue problem', () => {
  const base = {
    departures: 1, recruitingCost: 500, onboardingCost: 300,
    vacancyWeeks: 2, coverageCostPerWeek: 800,
  };
  const payrollOnly = turnoverCosts(base);
  const withEnrollment = turnoverCosts({
    ...base,
    enrollmentLossProb: 0.4, childrenLostPerEvent: 2,
    revenuePerChild: 1100, monthsToRefill: 3,
  });

  near(payrollOnly.totalCost, 2400, 0.01);
  near(withEnrollment.totalCost, 5040, 0.01);
  assert.ok(withEnrollment.revenueLost > payrollOnly.totalCost,
    'the foregone revenue can exceed every payroll-side cost combined');
});

test('vacancy coverage is charged because ratios are law, not a choice', () => {
  const c = turnoverCosts({ departures: 2, vacancyWeeks: 3, coverageCostPerWeek: 900 });
  near(c.vacancy, 5400);
});

test('full ramp productivity costs nothing', () => {
  const c = turnoverCosts({ departures: 1, rampWeeks: 8, weeklyWage: 700, rampProductivity: 1 });
  assert.equal(c.ramp, 0);
});

test('no departures means no cost', () => {
  const c = turnoverCosts({
    departures: 0, recruitingCost: 500, vacancyWeeks: 4, coverageCostPerWeek: 800,
    enrollmentLossProb: 1, childrenLostPerEvent: 5, revenuePerChild: 1100,
  });
  assert.equal(c.totalCost, 0);
});

test('turnoverCosts works with no arguments', () => {
  assert.equal(turnoverCosts().totalCost, 0);
});

// --- the inverted question -------------------------------------------------------------------

test('breakEvenSensitivity answers what you would have to believe', () => {
  // 5 teachers, $18 -> $19.80 (10% above an $18 midpoint), each departure costing $6,000.
  const r = breakEvenSensitivity({
    headcount: 5, fromWage: 18, toWage: 19.8, midpoint: 18,
    hoursPerWeek: 40, costPerDeparture: 6000,
    turnoverParams: { baseAtMid: 0.35 },
  });

  // Annual raise cost: 5 x $1.80 x 40 x 52 x 1.0765
  near(r.annualRaiseCost, 20151.36, 1);
  // Savings per unit sensitivity: 5 x 0.35 x 0.1 x 6000 = 1050
  near(r.required, 20151.36 / 1050, 0.01);
  assert.ok(r.required > 19, 'a sensitivity that high is not believable -- so this raise, at this departure cost, does not pay for itself on turnover alone');
});

test('required sensitivity is INVARIANT to raise size and headcount', () => {
  // An algebraic result worth knowing: the (to - from) term cancels, because a bigger raise
  // costs proportionally more AND moves compa-ratio proportionally further. Same for headcount.
  // So "is a raise worth it" does not depend on how big the raise is -- only on the midpoint,
  // baseline turnover, hours, and what a departure actually costs.
  const common = { midpoint: 18, hoursPerWeek: 40, costPerDeparture: 15000,
                   turnoverParams: { baseAtMid: 0.35 } };
  const small = breakEvenSensitivity({ headcount: 5, fromWage: 18, toWage: 18.25, ...common });
  const big = breakEvenSensitivity({ headcount: 5, fromWage: 18, toWage: 21, ...common });
  const fewer = breakEvenSensitivity({ headcount: 2, fromWage: 18, toWage: 18.25, ...common });

  near(small.required, big.required, 0.0001);
  near(small.required, fewer.required, 0.0001);
});

test('requiredCostPerDeparture states the finding in dollars', () => {
  // The same algebra, rearranged into the number a person can actually judge.
  const c = requiredCostPerDeparture({
    midpoint: 18, hoursPerWeek: 40, sensitivity: 1.5, turnoverParams: { baseAtMid: 0.35 },
  });
  near(c, 76769.83, 0.01);
  assert.ok(c > 50000,
    'a departure would have to cost this much for an above-midpoint raise to pay for itself ' +
    'on turnover savings alone -- far above typical direct replacement cost, which is the ' +
    'honest answer the inverted question was built to produce');
});

test('breakEvenSensitivity refuses to answer without the inputs it needs', () => {
  const noMid = breakEvenSensitivity({ headcount: 5, fromWage: 18, toWage: 20, costPerDeparture: 5000 });
  assert.equal(noMid.required, null);
  assert.ok(noMid.note.includes('midpoint'));

  const noCost = breakEvenSensitivity({ headcount: 5, fromWage: 18, toWage: 20, midpoint: 18 });
  assert.equal(noCost.required, null);

  const noChange = breakEvenSensitivity({
    headcount: 5, fromWage: 18, toWage: 18, midpoint: 18, costPerDeparture: 5000,
  });
  assert.equal(noChange.required, null);
});

test('a pay cut cannot pay for itself through turnover', () => {
  const r = breakEvenSensitivity({
    headcount: 5, fromWage: 20, toWage: 18, midpoint: 18, costPerDeparture: 5000,
  });
  assert.equal(r.required, null);
  assert.ok(r.note.includes('pay cut'));
});
