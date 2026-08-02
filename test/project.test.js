import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { project, summarize, splitByScheduleMix } from '../engine/project.js';
import { monthlyFromWeekly } from '../engine/revenue.js';

const TABLES = JSON.parse(
  readFileSync(new URL('../data/tn-childcare.json', import.meta.url), 'utf8'),
);

const near = (a, b, eps = 0.01) =>
  assert.ok(Math.abs(a - b) < eps, `${a} should be within ${eps} of ${b}`);

const FULL = { id: 'full', arriveHour: 7.5, departHour: 16.5, daysPerWeek: 5, tuitionMultiplier: 1 };
const HALF = {
  id: 'half', arriveHour: 7.5, departHour: 12, daysPerWeek: 5,
  tuitionMultiplier: 0.65, dhsPartTime: true,
};

const ROOMS = [
  { id: 'ps-1', group: 'preschool', ratioRule: 'm_3_5yr', seats: 12, openMonth: 0 },
  { id: 'ps-2', group: 'preschool', ratioRule: 'm_3_5yr', seats: 12, openMonth: 4 },
  { id: 'tod-1', group: 'toddler', ratioRule: 'm_2_3yr', seats: 12, openMonth: 8 },
];

const GROUPS = [
  { id: 'preschool', ratioRule: 'm_3_5yr', fringeRatioRule: 'm_2h_5yr', dhsBand: 'preschool' },
  { id: 'toddler', ratioRule: 'm_2_3yr', dhsBand: 'toddler' },
];

/** A minimal but complete plan; individual tests override pieces of it. */
const basePlan = (over = {}) => ({
  months: { from: -2, to: 12 },
  startingCash: 50000,
  rooms: ROOMS,
  groups: GROUPS,
  scheduleTypes: [FULL, HALF],
  tables: TABLES,
  settings: {
    enrollmentTarget: { default: 0, byGroupMonth: { 'preschool|0+': 12 } },
    tuition: { default: 1100, byGroup: { toddler: 1250 } },
    dhsShare: { default: 0 },
    perChildCost: { default: 120 },
    overheadBase: { default: 2181.82 },
    overheadPerChild: { default: 22.727 },
    insurance: { default: 650 },
    wagePerHour: { default: 18 },
    oneTime: { default: 0, byMonth: { '-2': 879 } },
    hoursOpen: { default: 7.5 },
    hoursClose: { default: 16.5 },
  },
  options: { payrollMode: 'derived' },
  ...over,
});

// --- schedule mix ------------------------------------------------------------------------

test('splitByScheduleMix normalizes weights', () => {
  const types = [FULL, HALF];
  assert.deepEqual(splitByScheduleMix(20, { full: 3, half: 1 }, types), { full: 15, half: 5 });
  assert.deepEqual(splitByScheduleMix(20, { full: 0.75, half: 0.25 }, types), { full: 15, half: 5 });
  assert.deepEqual(splitByScheduleMix(20, { full: 1 }, types), { full: 20 });
});

test('no mix means everyone is on the first schedule type', () => {
  assert.deepEqual(splitByScheduleMix(10, null, [FULL, HALF]), { full: 10 });
  assert.deepEqual(splitByScheduleMix(10, {}, [FULL, HALF]), { full: 10 });
  assert.deepEqual(splitByScheduleMix(10, { half: 0 }, [FULL, HALF]), { full: 10 });
  assert.deepEqual(splitByScheduleMix(10, null, []), {});
});

// --- the month loop ----------------------------------------------------------------------

test('rows span the requested months, including pre-open ones', () => {
  const r = project(basePlan());
  assert.equal(r.rows.length, 15);
  assert.equal(r.rows[0].month, -2);
  assert.equal(r.rows.at(-1).month, 12);
});

test('pre-open months have no enrollment but do have costs', () => {
  const r = project(basePlan());
  const m = r.rows.find((x) => x.month === -2);
  assert.equal(m.enrollment.served, 0);
  assert.equal(m.revenue.revenue, 0);
  near(m.expenses.lines.oneTime, 879); // the licensing fee lands as a month spike
  assert.ok(m.expenses.total > 0);
  assert.ok(m.net < 0, 'pre-open months burn cash by construction');
});

test('cash carries forward and matches the sum of cash flows', () => {
  const r = project(basePlan());
  let running = 50000;
  for (const row of r.rows) {
    running += row.cashFlow;
    near(row.cash, running, 0.01);
    near(row.openingCash, running - row.cashFlow, 0.01);
  }
  near(r.endingCash, running, 0.01);
});

test('enrollment is capacity-clamped, and the shortfall stays visible', () => {
  const plan = basePlan();
  plan.settings.enrollmentTarget = { default: 0, byGroupMonth: { 'preschool|0+': 30 } };
  const r = project(plan);

  const m0 = r.rows.find((x) => x.month === 0);
  assert.equal(m0.enrollment.target, 30);
  assert.equal(m0.enrollment.served, 12, 'only one 12-seat room is open in month 0');
  assert.equal(m0.enrollment.unserved, 18);

  const m4 = r.rows.find((x) => x.month === 4);
  assert.equal(m4.enrollment.served, 24, 'the second room opens in month 4');
  assert.equal(m4.enrollment.unserved, 6);
});

test('revenue is billed on children served, not children targeted', () => {
  const plan = basePlan();
  plan.settings.enrollmentTarget = { default: 0, byGroupMonth: { 'preschool|0+': 30 } };
  const r = project(plan);
  const m0 = r.rows.find((x) => x.month === 0);
  near(m0.revenue.revenue, 12 * 1100, 0.01);
});

// --- the accrual/cash split ---------------------------------------------------------------

test('with no DHS children, accrual and cash are identical', () => {
  const r = project(basePlan());
  for (const row of r.rows) near(row.net, row.cashFlow, 0.01);
  assert.equal(r.peakReceivable, 0);
});

test('a DHS lag delays cash without changing accrual revenue', () => {
  const withLag = basePlan();
  withLag.settings.dhsShare = { default: 1 };
  withLag.options = { ...withLag.options, dhsLagMonths: 1 };

  const noLag = basePlan();
  noLag.settings.dhsShare = { default: 1 };

  const a = project(withLag);
  const b = project(noLag);

  // Same P&L...
  for (let i = 0; i < a.rows.length; i++) near(a.rows[i].net, b.rows[i].net, 0.01);

  // ...but the first operating month collects only the family's share.
  const m0 = a.rows.find((x) => x.month === 0);
  near(m0.cashFlow, m0.net - m0.revenue.fromDhs, 0.01);
  assert.ok(a.rows.find((x) => x.month === 0).cash < b.rows.find((x) => x.month === 0).cash);
});

test('the DHS lag ties up working capital permanently during a ramp', () => {
  // Not a one-month timing quirk: every month you grow, the receivable grows with you.
  const plan = basePlan();
  plan.settings.dhsShare = { default: 1 };
  plan.settings.enrollmentTarget = {
    default: 0,
    byGroupMonth: { 'preschool|0+': 6, 'preschool|4+': 18, 'preschool|8+': 24 },
  };
  plan.options = { ...plan.options, dhsLagMonths: 1 };
  const r = project(plan);

  const rec = (m) => r.rows.find((x) => x.month === m).receivable;
  assert.ok(rec(0) > 0);
  assert.ok(rec(4) > rec(0), 'the hole gets bigger as enrollment grows');
  assert.ok(rec(8) > rec(4));
  near(r.peakReceivable, rec(8), 0.01);
});

test('a lag of zero collects everything in the month it is earned', () => {
  const plan = basePlan();
  plan.settings.dhsShare = { default: 1 };
  const r = project(plan);
  for (const row of r.rows) near(row.receivable, 0, 0.01);
});

// --- staffing and payroll ------------------------------------------------------------------

test('payroll derives from staff-hours, so it reflects operating hours', () => {
  const short = project(basePlan());
  const long = basePlan();
  long.settings.hoursOpen = { default: 6 };
  long.settings.hoursClose = { default: 18 };
  // Give the children a schedule that actually uses the longer day.
  long.scheduleTypes = [{ ...FULL, arriveHour: 6, departHour: 18 }, HALF];

  const m = (r) => r.rows.find((x) => x.month === 0);
  assert.ok(
    m(project(long)).payroll.total > m(short).payroll.total,
    'a 12-hour day costs more payroll than a 9-hour day at the same enrollment',
  );
});

test('employer payroll tax is computed explicitly, not folded into wages', () => {
  const r = project(basePlan());
  const m = r.rows.find((x) => x.month === 0);
  near(m.payroll.employerTax, m.payroll.grossWages * 0.0765, 0.01);
  near(m.payroll.total, m.payroll.grossWages + m.payroll.employerTax, 0.01);
  assert.ok(m.payroll.employerTax > 0, 'the gap the business plan omits');
});

test('the FTE-per-adult gap is reported', () => {
  const r = project(basePlan());
  const m = r.rows.find((x) => x.month === 0);
  // 12 children, 9-hour day: 1 adult on the floor, but 1.125 employees to cover the day.
  assert.equal(m.staffing.peakAdults, 1);
  near(m.staffing.ftePerPeakAdult, 1.125);
});

test('payrollMode "setting" takes a typed figure instead of deriving one', () => {
  const plan = basePlan({ options: { payrollMode: 'setting' } });
  plan.settings.payroll = { default: 9300 };
  const r = project(plan);
  const m = r.rows.find((x) => x.month === 0);
  near(m.payroll.grossWages, 9300);
  near(m.payroll.total, 9300 * 1.0765, 0.01);
});

test('wages escalate on their own track', () => {
  const plan = basePlan({ options: { payrollMode: 'setting', escalators: { wage: 0.04 } } });
  plan.settings.payroll = { default: 10000 };
  const r = project(plan);
  const start = r.rows.find((x) => x.month === -2).payroll.grossWages;
  const later = r.rows.find((x) => x.month === 10).payroll.grossWages;
  near(start, 10000);
  near(later, 10000 * Math.pow(1.04, 1), 0.01, '12 months later');
});

// --- summary answers -----------------------------------------------------------------------

test('summarize finds the break-even and lowest-cash points', () => {
  const rows = [
    { month: -1, net: -5000, cash: 45000, receivable: 0 },
    { month: 0, net: -3000, cash: 42000, receivable: 0 },
    { month: 1, net: -1000, cash: 41000, receivable: 0 },
    { month: 2, net: 500, cash: 41500, receivable: 0 },
    { month: 3, net: 2000, cash: 43500, receivable: 0 },
  ];
  const s = summarize(rows, 50000);
  assert.equal(s.firstProfitableMonth, 2);
  assert.equal(s.sustainedProfitableFrom, 2);
  assert.equal(s.lowestCash, 41000);
  assert.equal(s.lowestCashMonth, 1);
  assert.equal(s.runsOutOfCash, false);
  assert.equal(s.additionalCashNeeded, 0);
  assert.equal(s.endingCash, 43500);
});

test('sustained profitability ignores a single lucky month', () => {
  const rows = [
    { month: 0, net: 100, cash: 100, receivable: 0 },   // one good month...
    { month: 1, net: -500, cash: -400, receivable: 0 }, // ...then back under
    { month: 2, net: 300, cash: -100, receivable: 0 },
    { month: 3, net: 400, cash: 300, receivable: 0 },
  ];
  const s = summarize(rows, 0);
  assert.equal(s.firstProfitableMonth, 0, 'the naive answer');
  assert.equal(s.sustainedProfitableFrom, 2, 'the honest one');
});

test('running out of cash is detected and quantified', () => {
  const rows = [
    { month: 0, net: -30000, cash: -5000, receivable: 0 },
    { month: 1, net: -10000, cash: -15000, receivable: 0 },
    { month: 2, net: 5000, cash: -10000, receivable: 0 },
  ];
  const s = summarize(rows, 25000);
  assert.equal(s.runsOutOfCash, true);
  assert.equal(s.lowestCash, -15000);
  assert.equal(s.additionalCashNeeded, 15000);
  assert.equal(s.totalCashRequired, 40000, 'what the sponsor actually has to front');
});

test('a plan that never turns a profit reports null rather than guessing', () => {
  const s = summarize([{ month: 0, net: -1000, cash: -1000, receivable: 0 }], 0);
  assert.equal(s.firstProfitableMonth, null);
  assert.equal(s.sustainedProfitableFrom, null);
});

test('summarize handles no rows', () => {
  const s = summarize([], 1000);
  assert.equal(s.endingCash, 1000);
  assert.equal(s.lowestCash, 1000);
  assert.equal(s.lowestCashMonth, null);
});

// --- an end-to-end sanity check --------------------------------------------------------------

test('a full 36-child plan reaches profitability and reports coherent totals', () => {
  const plan = basePlan({ months: { from: -2, to: 24 } });
  plan.settings.enrollmentTarget = {
    default: 0,
    byGroupMonth: {
      'preschool|0+': 12, 'preschool|4+': 24,
      'toddler|8+': 12,
    },
  };
  const r = project(plan);

  const stable = r.rows.find((x) => x.month === 12);
  assert.equal(stable.enrollment.served, 36);
  near(stable.revenue.revenue, 12 * 1250 + 24 * 1100, 1, "the plan's blended $41,400");
  assert.ok(stable.net > 0, 'profitable at full Year 1 enrollment');
  assert.ok(r.sustainedProfitableFrom !== null);

  // Every row's arithmetic ties out.
  for (const row of r.rows) {
    near(row.net, row.revenue.revenue - row.expenses.total, 0.01);
    near(row.cash, row.openingCash + row.cashFlow, 0.01);
    near(row.expenses.lines.payroll, row.payroll.total, 0.01);
  }
});

test('the toddler room revenue reflects its own tuition', () => {
  const plan = basePlan({ months: { from: 8, to: 8 } });
  plan.settings.enrollmentTarget = { default: 0, byGroupMonth: { 'toddler|8+': 12 } };
  const r = project(plan);
  near(r.rows[0].revenue.revenue, 12 * 1250, 0.01);
});

test('a DHS-subsidized child still totals list tuition when the gap is charged', () => {
  const plan = basePlan({ months: { from: 0, to: 0 } });
  plan.settings.dhsShare = { default: 1 };
  const r = project(plan);
  near(r.rows[0].revenue.revenue, 12 * 1100, 0.01);
  near(r.rows[0].revenue.fromDhs, 12 * monthlyFromWeekly(208), 0.01);
});
