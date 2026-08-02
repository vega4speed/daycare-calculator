import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  monthlyFromWeekly,
  dhsWeeklyRate,
  qrisBonusFor,
  cellRevenue,
  normalizeBandMix,
  computeRevenue,
} from '../engine/revenue.js';

const { dhsCertificate: DHS } = JSON.parse(
  readFileSync(new URL('../data/tn-childcare.json', import.meta.url), 'utf8'),
);

const near = (a, b, eps = 0.01) =>
  assert.ok(Math.abs(a - b) < eps, `${a} should be within ${eps} of ${b}`);

const GROUPS = [
  { id: 'toddler', dhsBand: 'toddler' },
  { id: 'preschool', dhsBand: 'preschool' },
];
const FULL = { id: 'full', tuitionMultiplier: 1, dhsPartTime: false };
const HALF = { id: 'half', tuitionMultiplier: 0.65, dhsPartTime: true };

// --- rates -------------------------------------------------------------------------------

test('weekly rates convert on 52/12, not 4 weeks per month', () => {
  near(monthlyFromWeekly(208), 901.33);
  near(monthlyFromWeekly(240), 1040);
  // The naive "4 weeks per month" conversion loses four weeks a year -- $69/mo per preschool
  // child, about $30k/yr across a 36-child program.
  near(monthlyFromWeekly(208) - 208 * 4, 69.33);
});

test('Davidson County top-tier center rates match the published chart', () => {
  assert.equal(dhsWeeklyRate(DHS, 'preschool', { tier: 'top' }), 208);
  assert.equal(dhsWeeklyRate(DHS, 'toddler', { tier: 'top' }), 240);
  assert.equal(dhsWeeklyRate(DHS, 'infant', { tier: 'top' }), 260);
  assert.equal(dhsWeeklyRate(DHS, 'preschool', { tier: 'lower' }), 148);
});

test('part-time is half the full rate, rounded UP', () => {
  assert.equal(dhsWeeklyRate(DHS, 'preschool', { partTime: true }), 104);
  assert.equal(dhsWeeklyRate(DHS, 'toddler', { partTime: true }), 120);
  // 79 / 2 = 39.5 -> 40, the rounding-up rule actually biting
  assert.equal(dhsWeeklyRate(DHS, 'schoolIn', { partTime: true }), 40);
});

test('QRIS bonuses reproduce the published bonus columns exactly', () => {
  // This is a check on the data file as much as the code: rounding the state rate by the bonus
  // fraction must land on the chart's own printed figures.
  assert.equal(dhsWeeklyRate(DHS, 'infant', { qrisScore: 85 }), 273);
  assert.equal(dhsWeeklyRate(DHS, 'toddler', { qrisScore: 85 }), 252);
  assert.equal(dhsWeeklyRate(DHS, 'preschool', { qrisScore: 85 }), 218);
  assert.equal(dhsWeeklyRate(DHS, 'infant', { qrisScore: 95 }), 286);
  assert.equal(dhsWeeklyRate(DHS, 'toddler', { qrisScore: 95 }), 264);
  assert.equal(dhsWeeklyRate(DHS, 'preschool', { qrisScore: 95 }), 229);
});

test('a QRIS score below 80 earns nothing', () => {
  assert.equal(qrisBonusFor(DHS, 79), 0);
  assert.equal(qrisBonusFor(DHS, null), 0);
  assert.equal(dhsWeeklyRate(DHS, 'preschool', { qrisScore: 79 }), 208);
});

test('the infant differential is OFF by default', () => {
  // The chart does not say whether its printed infant figure already includes the 15%
  // differential. Defaulting it on would silently inflate infant revenue by 15%.
  assert.equal(dhsWeeklyRate(DHS, 'infant', {}), 260);
  assert.equal(dhsWeeklyRate(DHS, 'infant', { infantDifferential: true }), 299);
});

test('unknown bands and tiers throw', () => {
  assert.throws(() => dhsWeeklyRate(DHS, 'kindergarten'), /Unknown DHS rate band/);
  assert.throws(() => dhsWeeklyRate(DHS, 'preschool', { tier: 'middle' }), /Unknown county tier/);
});

// --- the family gap ----------------------------------------------------------------------

test("the business plan's $100-250 parent gap reproduces from verified rates", () => {
  const preschool = cellRevenue({
    count: 1, monthlyTuition: 1100, dhsShare: 1,
    dhsMonthly: monthlyFromWeekly(dhsWeeklyRate(DHS, 'preschool')),
  });
  const toddler = cellRevenue({
    count: 1, monthlyTuition: 1250, dhsShare: 1,
    dhsMonthly: monthlyFromWeekly(dhsWeeklyRate(DHS, 'toddler')),
  });

  near(preschool.gapPerChild, 198.67);
  near(toddler.gapPerChild, 210);
  // Both inside the plan's stated $100-250 range, arrived at independently.
  for (const g of [preschool.gapPerChild, toddler.gapPerChild]) {
    assert.ok(g >= 100 && g <= 250);
  }
});

test('a DHS child yields the same total as a private child when the gap is charged', () => {
  const dhsMonthly = monthlyFromWeekly(208);
  const subsidized = cellRevenue({ count: 1, monthlyTuition: 1100, dhsShare: 1, dhsMonthly });
  const priv = cellRevenue({ count: 1, monthlyTuition: 1100, dhsShare: 0, dhsMonthly });
  near(subsidized.revenue, priv.revenue);
  near(subsidized.revenue, 1100);
});

test('absorbing the gap costs exactly the gap', () => {
  const dhsMonthly = monthlyFromWeekly(208);
  const absorbed = cellRevenue({
    count: 1, monthlyTuition: 1100, dhsShare: 1, dhsMonthly, gapPolicy: 'absorb',
  });
  near(absorbed.revenue, dhsMonthly);
  assert.equal(absorbed.familyBilled, 0);
});

test('a gap is floored at zero -- providers do not refund the state', () => {
  const r = cellRevenue({ count: 1, monthlyTuition: 800, dhsShare: 1, dhsMonthly: 1040 });
  assert.equal(r.gapPerChild, 0);
  assert.ok(r.gapUncapped < 0, 'but the uncapped figure is surfaced');
  near(r.revenue, 1040, 0.01);
});

// --- THE ASYMMETRY: part-time DHS ---------------------------------------------------------

test('part-time DHS children are systematically less profitable', () => {
  const fullRate = monthlyFromWeekly(dhsWeeklyRate(DHS, 'preschool'));
  const partRate = monthlyFromWeekly(dhsWeeklyRate(DHS, 'preschool', { partTime: true }));

  // DHS pays exactly half...
  near(partRate, fullRate / 2, 0.5);

  // ...but private-pay part-time is priced ABOVE pro-rata, because a seat's cost is not linear
  // in hours. So the family gap on a part-time subsidized child is disproportionately large.
  const full = cellRevenue({ count: 1, monthlyTuition: 1100, dhsShare: 1, dhsMonthly: fullRate });
  const part = cellRevenue({
    count: 1, monthlyTuition: 1100, tuitionMultiplier: 0.65, dhsShare: 1, dhsMonthly: partRate,
  });

  near(full.gapPerChild, 198.67);
  near(part.gapPerChild, 264.33, 0.01);
  assert.ok(part.gapPerChild > full.gapPerChild,
    'the part-time family owes MORE than the full-time family, on half the care');
});

// --- collections -------------------------------------------------------------------------

test('collections loss applies only to the family-billed portion', () => {
  const dhsMonthly = monthlyFromWeekly(208);
  // A fully subsidized child with the gap absorbed carries no collections risk at all.
  const noRisk = cellRevenue({
    count: 1, monthlyTuition: 1100, dhsShare: 1, dhsMonthly,
    gapPolicy: 'absorb', collectionsLoss: 0.5,
  });
  assert.equal(noRisk.collectionsLoss, 0);

  // A private-pay child carries it on the whole amount.
  const fullRisk = cellRevenue({
    count: 1, monthlyTuition: 1100, dhsShare: 0, dhsMonthly, collectionsLoss: 0.05,
  });
  near(fullRisk.collectionsLoss, 55);
  near(fullRisk.revenue, 1045);
});

// --- band mix ----------------------------------------------------------------------------

test('normalizeBandMix normalizes, drops zeroes, and falls back', () => {
  assert.deepEqual(normalizeBandMix({ toddler: 1, preschool: 1 }), { toddler: 0.5, preschool: 0.5 });
  assert.deepEqual(normalizeBandMix({ toddler: 3, preschool: 1 }), { toddler: 0.75, preschool: 0.25 });
  assert.deepEqual(normalizeBandMix({ toddler: 1, preschool: 0 }), { toddler: 1 });
  assert.deepEqual(normalizeBandMix(null, 'preschool'), { preschool: 1 });
  assert.deepEqual(normalizeBandMix({}, 'toddler'), { toddler: 1 });
  assert.deepEqual(normalizeBandMix({ a: 0 }, 'toddler'), { toddler: 1 });
});

test('the 31-month DHS boundary splits a toddler room mid-way', () => {
  // Same room, same tuition, different reimbursement -- PLAN.md 4.7.
  const groups = [{ id: 'toddler', dhsBand: 'toddler', dhsBandMix: { toddler: 0.5, preschool: 0.5 } }];
  const split = computeRevenue({
    enrollment: { toddler: { full: 12 } },
    scheduleTypes: [FULL], groups,
    tuitionFor: () => 1250, dhsShareFor: () => 1,
    dhsTables: DHS,
  });
  const allToddler = computeRevenue({
    enrollment: { toddler: { full: 12 } },
    scheduleTypes: [FULL], groups: [{ id: 'toddler', dhsBand: 'toddler' }],
    tuitionFor: () => 1250, dhsShareFor: () => 1,
    dhsTables: DHS,
  });

  // Revenue is identical (the family covers the gap) but the DHS/family split moves by $139/child.
  near(split.revenue, allToddler.revenue);
  near((allToddler.dhsEarned - split.dhsEarned) / 12, 69.33, 0.01);
  assert.ok(split.familyBilled > allToddler.familyBilled,
    'more of the bill lands on families once children cross 31 months');
});

// --- whole-month revenue, against the business plan's own figures -------------------------

test("reproduces the plan's Scenario B blended revenue at 36 children: $41,400", () => {
  // PLAN doc section 7: 12 toddlers at $1,250 + 24 preschoolers at $1,100.
  const r = computeRevenue({
    enrollment: { toddler: { full: 12 }, preschool: { full: 24 } },
    scheduleTypes: [FULL], groups: GROUPS,
    tuitionFor: (id) => (id === 'toddler' ? 1250 : 1100),
    dhsShareFor: () => 0,
    dhsTables: DHS,
  });
  near(r.revenue, 41400);
  assert.equal(r.children, 36);
});

test("reproduces the plan's all-Pre-K illustration at 36 children: $39,600", () => {
  // PLAN doc section 13 states this separately, and explains the difference from section 7.
  const r = computeRevenue({
    enrollment: { preschool: { full: 36 } },
    scheduleTypes: [FULL], groups: GROUPS,
    tuitionFor: () => 1100, dhsShareFor: () => 0, dhsTables: DHS,
  });
  near(r.revenue, 39600);
});

test('a DHS-heavy mix earns the same gross but shifts who pays', () => {
  const base = {
    enrollment: { preschool: { full: 24 } },
    scheduleTypes: [FULL], groups: GROUPS,
    tuitionFor: () => 1100, dhsTables: DHS,
  };
  const noDhs = computeRevenue({ ...base, dhsShareFor: () => 0 });
  const halfDhs = computeRevenue({ ...base, dhsShareFor: () => 0.5 });

  near(noDhs.revenue, halfDhs.revenue, 0.01);
  assert.equal(noDhs.fromDhs, 0);
  near(halfDhs.fromDhs, 12 * monthlyFromWeekly(208));
  assert.equal(halfDhs.dhsChildren, 12);
});

test('the payer split is what the cash lag will act on', () => {
  const r = computeRevenue({
    enrollment: { preschool: { full: 20 } },
    scheduleTypes: [FULL], groups: GROUPS,
    tuitionFor: () => 1100, dhsShareFor: () => 0.6, dhsTables: DHS,
  });
  near(r.fromDhs + r.fromFamilies, r.revenue);
  assert.ok(r.fromDhs > 0 && r.fromFamilies > 0);
});

test('mixed schedules are billed on their own multipliers', () => {
  const r = computeRevenue({
    enrollment: { preschool: { full: 10, half: 10 } },
    scheduleTypes: [FULL, HALF], groups: GROUPS,
    tuitionFor: () => 1100, dhsShareFor: () => 0, dhsTables: DHS,
  });
  near(r.byScheduleType.full.revenue, 11000);
  near(r.byScheduleType.half.revenue, 7150, 0.01); // 10 * 1100 * 0.65
  assert.equal(r.children, 20);
});

test('unknown groups and schedule types throw', () => {
  const base = {
    scheduleTypes: [FULL], groups: GROUPS,
    tuitionFor: () => 1100, dhsShareFor: () => 0, dhsTables: DHS,
  };
  assert.throws(
    () => computeRevenue({ ...base, enrollment: { infant: { full: 1 } } }),
    /Unknown group: infant/,
  );
  assert.throws(
    () => computeRevenue({ ...base, enrollment: { preschool: { nope: 1 } } }),
    /Unknown schedule type: nope/,
  );
});

test('an empty program earns nothing without dividing by zero', () => {
  const r = computeRevenue({
    enrollment: {}, scheduleTypes: [FULL], groups: GROUPS,
    tuitionFor: () => 1100, dhsShareFor: () => 0, dhsTables: DHS,
  });
  assert.equal(r.revenue, 0);
  assert.equal(r.revenuePerChild, 0);
});
