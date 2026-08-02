import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { project } from '../engine/project.js';
import {
  solveMinimumStartupCapital,
  solveBreakEvenEnrollment,
  solveRequiredTuition,
  solveStaffingOptimum,
} from '../engine/solve.js';

const TABLES = JSON.parse(
  readFileSync(new URL('../data/tn-childcare.json', import.meta.url), 'utf8'),
);

const near = (a, b, eps = 0.01) =>
  assert.ok(Math.abs(a - b) < eps, `${a} should be within ${eps} of ${b}`);

const FULL = { id: 'full', arriveHour: 7.5, departHour: 16.5, daysPerWeek: 5, tuitionMultiplier: 1 };

const ROOMS = [
  { id: 'ps-1', group: 'preschool', ratioRule: 'm_3_5yr', seats: 12, openMonth: 0 },
  { id: 'ps-2', group: 'preschool', ratioRule: 'm_3_5yr', seats: 12, openMonth: 4 },
  { id: 'tod-1', group: 'toddler', ratioRule: 'm_2_3yr', seats: 12, openMonth: 8 },
];
const GROUPS = [
  { id: 'preschool', ratioRule: 'm_3_5yr', fringeRatioRule: 'm_2h_5yr', dhsBand: 'preschool' },
  { id: 'toddler', ratioRule: 'm_2_3yr', dhsBand: 'toddler' },
];
const ROLES = [
  { id: 'lead', kind: 'lead', hoursPerWeek: 40 },
  { id: 'teacher', kind: 'teacher', hoursPerWeek: 40 },
  { id: 'floater', kind: 'floater', hoursPerWeek: 40 },
  { id: 'director', kind: 'director', hoursPerWeek: 40 },
];

const plan = (over = {}) => ({
  months: { from: -2, to: 12 },
  startingCash: 25000,
  rooms: ROOMS,
  groups: GROUPS,
  roles: ROLES,
  scheduleTypes: [FULL],
  tables: TABLES,
  settings: {
    enrollmentTarget: {
      default: 0,
      byGroupMonth: { 'preschool|0+': 12, 'preschool|4+': 24, 'toddler|8+': 12 },
    },
    tuition: { default: 1100, byGroup: { toddler: 1250 } },
    dhsShare: { default: 0 },
    perChildCost: { default: 120 },
    overheadBase: { default: 2181.82 },
    overheadPerChild: { default: 22.727 },
    insurance: { default: 650 },
    wage: { default: 18, byGroup: { lead: 20.5, floater: 17, director: 26 } },
    roleHours: { default: 40, byGroupMonth: { 'director|-2+': 20, 'director|8+': 40 } },
    oneTime: { default: 0, byMonth: { '-2': 879 } },
    hoursOpen: { default: 7.5 },
    hoursClose: { default: 16.5 },
  },
  options: { payrollMode: 'roles' },
  ...over,
});

// --- minimum startup capital ---------------------------------------------------------------

test('minimum startup capital comes straight from the deepest cash point', () => {
  const s = solveMinimumStartupCapital(plan());
  assert.ok(s.required > 0);
  assert.equal(s.deepestPoint, -s.required);
  assert.ok(s.deepestMonth !== null);
});

test('the solved capital is exactly enough, and a dollar less is not', () => {
  const p = plan();
  const s = solveMinimumStartupCapital(p);

  const exact = project({ ...p, startingCash: s.required });
  assert.equal(exact.runsOutOfCash, false);
  near(exact.lowestCash, 0, 0.01);

  const short = project({ ...p, startingCash: s.required - 1 });
  assert.equal(short.runsOutOfCash, true);
});

test('a cash floor raises the requirement by exactly the floor', () => {
  const p = plan();
  const zero = solveMinimumStartupCapital(p);
  const buffered = solveMinimumStartupCapital(p, { floor: 10000 });
  near(buffered.required, zero.required + 10000, 0.01);
});

test('it reports whether the plan already provides enough', () => {
  const s = solveMinimumStartupCapital(plan({ startingCash: 5000 }));
  assert.equal(s.provided, 5000);
  assert.equal(s.sufficient, false);
  near(s.shortfall, s.required - 5000, 0.01);

  const plenty = solveMinimumStartupCapital(plan({ startingCash: 500000 }));
  assert.equal(plenty.sufficient, true);
  assert.equal(plenty.shortfall, 0);
});

test('a plan that never goes negative needs nothing', () => {
  const p = plan();
  p.settings.enrollmentTarget = { default: 0, byGroupMonth: { 'preschool|0+': 12 } };
  p.months = { from: 0, to: 2 };
  p.settings.overheadBase = { default: 0 };
  p.settings.insurance = { default: 0 };
  p.settings.perChildCost = { default: 0 };
  const s = solveMinimumStartupCapital(p);
  assert.equal(s.required, 0);
});

// --- break-even enrollment -------------------------------------------------------------------

test('break-even enrollment finds the lowest count with non-negative net', () => {
  const s = solveBreakEvenEnrollment(plan(), { atMonth: 12 });
  assert.equal(s.achievable, true);
  assert.ok(s.enrollment > 0);
  assert.ok(s.net >= 0);
});

test('one child fewer than the solved figure loses money', () => {
  // The staircase check: the scan must return the LOWEST feasible count, not merely a feasible
  // one, which is exactly what binary search on a step function can get wrong.
  const p = plan();
  const s = solveBreakEvenEnrollment(p, { atMonth: 12 });

  const probeAt = (n) => {
    const q = structuredClone(p);
    q.months = { from: 12, to: 12 };
    q.settings.enrollmentTarget = { default: 0, byGroup: {} };
    for (const [g, share] of Object.entries(s.proportions)) {
      q.settings.enrollmentTarget.byGroup[g] = n * share;
    }
    return project(q).rows[0].net;
  };

  assert.ok(probeAt(s.enrollment) >= 0);
  assert.ok(probeAt(s.enrollment - 1) < 0, 'one fewer child must not break even');
});

test('break-even holds the group mix the plan already uses', () => {
  const s = solveBreakEvenEnrollment(plan(), { atMonth: 12 });
  // Month 12 is 24 preschool + 12 toddler.
  near(s.proportions.preschool, 24 / 36, 0.001);
  near(s.proportions.toddler, 12 / 36, 0.001);
});

test('an unachievable break-even says so instead of returning a number', () => {
  const p = plan();
  p.settings.tuition = { default: 100 }; // nowhere near enough at any enrollment
  const s = solveBreakEvenEnrollment(p, { atMonth: 12 });
  assert.equal(s.achievable, false);
  assert.equal(s.enrollment, null);
  assert.ok(s.reason.includes('more children will not fix it'));
});

test('a month with no capacity is reported, not solved', () => {
  const s = solveBreakEvenEnrollment(plan(), { atMonth: -1 });
  assert.equal(s.enrollment, null);
  assert.ok(s.reason.includes('No capacity'));
});

test('a month outside the projection is reported', () => {
  const s = solveBreakEvenEnrollment(plan(), { atMonth: 999 });
  assert.equal(s.enrollment, null);
  assert.ok(s.reason.includes('No row'));
});

// --- required tuition --------------------------------------------------------------------------

test('an already-profitable month needs no increase', () => {
  const s = solveRequiredTuition(plan(), { atMonth: 12 });
  assert.equal(s.alreadyProfitable, true);
  assert.equal(s.increaseNeeded, 0);
});

test('required tuition solves the factor that brings net to zero', () => {
  const p = plan();
  p.settings.tuition = { default: 700, byGroup: { toddler: 800 } };
  const s = solveRequiredTuition(p, { atMonth: 12 });

  assert.equal(s.alreadyProfitable, false);
  assert.ok(s.factor > 1);
  near(s.net, 0, 1, 'lands within a dollar of break-even');
});

test('the solved tuition actually breaks even when applied', () => {
  const p = plan();
  p.settings.tuition = { default: 700, byGroup: { toddler: 800 } };
  const s = solveRequiredTuition(p, { atMonth: 12 });

  const applied = structuredClone(p);
  applied.months = { from: 12, to: 12 };
  applied.settings.tuition = {
    default: 700 * s.factor,
    byGroup: { toddler: 800 * s.factor },
  };
  near(project(applied).rows[0].net, 0, 1);
});

test('raising tuition does not raise DHS, so a subsidized program needs a bigger increase', () => {
  // The interaction worth seeing: DHS pays a published rate regardless of list price, so a
  // tuition increase only widens the family gap.
  const privatePay = plan();
  privatePay.settings.tuition = { default: 700, byGroup: { toddler: 800 } };
  privatePay.settings.overheadBase = { default: 12000 }; // deep enough that DHS alone cannot cover it

  const subsidized = structuredClone(privatePay);
  subsidized.settings.dhsShare = { default: 1 };
  subsidized.options = { ...subsidized.options, gapPolicy: 'absorb' };

  const a = solveRequiredTuition(privatePay, { atMonth: 12 });
  const b = solveRequiredTuition(subsidized, { atMonth: 12 });

  // With the gap absorbed, tuition barely moves revenue at all -- so no factor can fix it.
  assert.ok(a.factor !== null);
  assert.equal(b.factor, null);
  assert.ok(b.reason.includes('not a pricing problem'));
});

test('an impossible shortfall is reported rather than searched forever', () => {
  const p = plan();
  p.settings.tuition = { default: 1 };
  p.settings.overheadBase = { default: 500000 };
  const s = solveRequiredTuition(p, { atMonth: 12 });
  assert.equal(s.factor, null);
  assert.ok(s.reason.includes('Not achievable'));
});

// --- the staffing optimum -----------------------------------------------------------------------

test('the staffing grid explores both levers and picks a winner', () => {
  const p = plan({
    options: {
      payrollMode: 'roles',
      turnover: {
        default: {
          midpoint: 18, baseAtMid: 0.35, sensitivity: 1.5, floor: 0.1,
          recruitingCost: 800, onboardingCost: 400,
          vacancyWeeks: 4, coverageCostPerWeek: 700,
          enrollmentLossProb: 0.3, childrenLostPerEvent: 1.5, monthsToRefill: 2,
        },
      },
    },
  });

  const s = solveStaffingOptimum(p, {
    atMonth: 12,
    floaterCounts: [0, 1, 2],
    compaRatios: [1.0, 1.1],
  });

  assert.equal(s.grid.length, 6);
  assert.ok(s.best.net >= Math.max(...s.grid.map((g) => g.net)) - 0.01);
  for (const cell of s.grid) {
    assert.ok(typeof cell.payroll === 'number' && cell.payroll > 0);
    assert.ok(typeof cell.turnoverCost === 'number');
  }
});

test('more floaters and higher pay both cost money -- net falls without a big enough offset', () => {
  // At a plausible sensitivity the turnover savings do not cover the raise (PLAN.md 4.11), so
  // the grid should prefer the cheap corner. This encodes that finding as a regression test.
  const p = plan({
    options: {
      payrollMode: 'roles',
      turnover: {
        default: {
          midpoint: 18, baseAtMid: 0.35, sensitivity: 1.5, floor: 0.1,
          recruitingCost: 800, onboardingCost: 400,
          vacancyWeeks: 4, coverageCostPerWeek: 700,
          enrollmentLossProb: 0.3, childrenLostPerEvent: 1.5, monthsToRefill: 2,
        },
      },
    },
  });
  const s = solveStaffingOptimum(p, { atMonth: 12, floaterCounts: [0, 2], compaRatios: [1.0, 1.15] });
  assert.equal(s.best.floaters, 0);
  assert.equal(s.best.compaRatio, 1.0);
});

test('the grid reports whether the choice is decisive at all', () => {
  const s = solveStaffingOptimum(plan(), {
    atMonth: 12, floaterCounts: [0], compaRatios: [1.0],
  });
  assert.equal(s.grid.length, 1);
  assert.equal(s.spread, 0);
  assert.equal(s.decisive, false, 'a single-cell grid decides nothing');
});
