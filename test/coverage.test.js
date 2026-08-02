import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { roomCoverage, planRoomShifts, buildCoveragePlan, shiftsByRole } from '../engine/coverage.js';

const { ratios } = JSON.parse(
  readFileSync(new URL('../data/tn-childcare.json', import.meta.url), 'utf8'),
);

const near = (a, b, eps = 0.01) =>
  assert.ok(Math.abs(a - b) < eps, `${a} should be within ${eps} of ${b}`);

const FULL = { id: 'full', arriveHour: 7.5, departHour: 16.5, daysPerWeek: 5 };
const HOURS = { openHour: 7.5, closeHour: 16.5 };
const byChildren = (room, children) => ({ full: children });

// --- shift planning ------------------------------------------------------------------------

test('a room needing less than one person gets one part-timer, not a full salary', () => {
  // The reason part-time exists: 20 hours of cover is 20 hours of somebody, not a whole hire.
  assert.deepEqual(planRoomShifts(20), [{ role: 'lead', hoursPerWeek: 20, fullTime: false }]);
});

test('full weeks are used while a full week is genuinely needed', () => {
  const shifts = planRoomShifts(90);
  assert.deepEqual(shifts.map((s) => [s.role, s.hoursPerWeek]), [
    ['lead', 40], ['teacher', 40], ['teacher', 10],
  ]);
  assert.equal(shifts.reduce((a, s) => a + s.hoursPerWeek, 0), 90, 'covers exactly, no surplus');
});

test('an exact multiple of full weeks needs no part-timer', () => {
  const shifts = planRoomShifts(80);
  assert.equal(shifts.length, 2);
  assert.ok(shifts.every((s) => s.fullTime));
});

test('a remainder too small to be a job is rounded up to a real shift', () => {
  // Nobody takes a 2-hour-a-week position, so the excess becomes surplus rather than a
  // fictional micro-shift.
  const shifts = planRoomShifts(82, { minShiftHours: 10 });
  assert.deepEqual(shifts.map((s) => s.hoursPerWeek), [40, 40, 10]);
  assert.equal(shifts.reduce((a, s) => a + s.hoursPerWeek, 0), 90, '8 hours of surplus');
});

test('without part-time, a remainder costs a whole extra person', () => {
  const shifts = planRoomShifts(90, { allowPartTime: false });
  assert.deepEqual(shifts.map((s) => s.hoursPerWeek), [40, 40, 40]);
  assert.equal(shifts.reduce((a, s) => a + s.hoursPerWeek, 0), 120, '30 hours paid for nothing');
});

test('a room needing nobody gets nobody', () => {
  assert.deepEqual(planRoomShifts(0), []);
  assert.deepEqual(planRoomShifts(-5), []);
});

test('the first person in a room is its lead, the rest are teachers', () => {
  const shifts = planRoomShifts(200);
  assert.equal(shifts[0].role, 'lead');
  assert.ok(shifts.slice(1).every((s) => s.role === 'teacher'));
  assert.equal(shifts.filter((s) => s.role === 'lead').length, 1, 'exactly one lead per room');
});

// --- per-room coverage ---------------------------------------------------------------------

test('a room reports its own blocks, peak adults, and weekly hours', () => {
  const cov = roomCoverage({
    room: { id: 'r', label: 'Preschool 1', ratioRule: 'm_3_5yr' },
    enrolledByType: { full: 14 },
    hours: HOURS, scheduleTypes: [FULL], ratios,
  });
  assert.equal(cov.children, 14);
  assert.equal(cov.childrenPerAdult, 13);
  assert.equal(cov.peakAdults, 2, 'ceil(14/13), and the more-than-12 floor agrees');
  assert.equal(cov.weeklyAdultHours, 90, '2 adults x 9 hours x 5 days');
  assert.ok(cov.blocks.length > 0);
});

test('an empty room needs nobody', () => {
  const cov = roomCoverage({
    room: { id: 'r', ratioRule: 'm_3_5yr' },
    enrolledByType: { full: 0 },
    hours: HOURS, scheduleTypes: [FULL], ratios,
  });
  assert.equal(cov.weeklyAdultHours, 0);
  assert.equal(cov.peakAdults, 0);
});

// --- THE POOLING FIX -------------------------------------------------------------------------

test('ratios apply per room, not pooled across the building', () => {
  // The bug this module exists to fix. 26 preschoolers pooled at 1:13 is 2 adults. Split 24
  // and 2 across two rooms it is 2 + 1 = 3, because a ratio applies to a group in a room.
  const plan = buildCoveragePlan({
    rooms: [
      { id: 'a', label: 'A', group: 'preschool', ratioRule: 'm_3_5yr' },
      { id: 'b', label: 'B', group: 'preschool', ratioRule: 'm_3_5yr' },
    ],
    childrenByRoom: { a: 24, b: 2 },
    enrolledByTypeFor: byChildren,
    hours: HOURS, scheduleTypes: [FULL], ratios,
  });

  assert.equal(plan.rooms[0].peakAdults, 2, 'ceil(24/13)');
  assert.equal(plan.rooms[1].peakAdults, 1, 'one child still needs an adult');
  assert.equal(plan.totals.peakAdults, 3, 'pooling would have said 2');
  assert.equal(plan.totals.requiredHours, 135, '(2 + 1) adults x 9 hrs x 5 days');
});

test('opening a room ADDS staff rather than reshuffling them', () => {
  // The artifact this replaces: the old facility-wide derivation raised leads and dropped
  // teachers when a room opened, which read as firing someone.
  const build = (rooms, childrenByRoom) => buildCoveragePlan({
    rooms, childrenByRoom, enrolledByTypeFor: byChildren,
    hours: HOURS, scheduleTypes: [FULL], ratios,
  });

  const one = build([{ id: 'a', label: 'A', ratioRule: 'm_3_5yr' }], { a: 14 });
  const two = build(
    [{ id: 'a', label: 'A', ratioRule: 'm_3_5yr' }, { id: 'b', label: 'B', ratioRule: 'm_3_5yr' }],
    { a: 14, b: 12 },
  );

  const teachers = (p) => shiftsByRole(p).teacher?.length ?? 0;
  const leads = (p) => shiftsByRole(p).lead?.length ?? 0;

  assert.equal(leads(one), 1);
  assert.equal(leads(two), 2, 'a lead per room');
  assert.ok(teachers(two) >= teachers(one), 'teachers never DROP when a room opens');
  assert.ok(two.totals.requiredHours > one.totals.requiredHours);
});

test('every shift says which room it covers', () => {
  const plan = buildCoveragePlan({
    rooms: [
      { id: 'a', label: 'Preschool 1', ratioRule: 'm_3_5yr' },
      { id: 'b', label: 'Toddler', ratioRule: 'm_2_3yr' },
    ],
    childrenByRoom: { a: 14, b: 12 },
    enrolledByTypeFor: byChildren,
    hours: HOURS, scheduleTypes: [FULL], ratios,
  });
  const byRole = shiftsByRole(plan);
  for (const shifts of Object.values(byRole)) {
    for (const s of shifts) assert.ok(s.roomId && s.roomLabel, 'a shift knows its room');
  }
  assert.deepEqual(byRole.lead.map((s) => s.roomLabel), ['Preschool 1', 'Toddler']);
});

test('a toddler room is staffed harder than a preschool room of the same size', () => {
  const plan = buildCoveragePlan({
    rooms: [
      { id: 'p', label: 'Preschool', ratioRule: 'm_3_5yr' }, // 1:13
      { id: 't', label: 'Toddler', ratioRule: 'm_2_3yr' },   // 1:8
    ],
    childrenByRoom: { p: 12, t: 12 },
    enrolledByTypeFor: byChildren,
    hours: HOURS, scheduleTypes: [FULL], ratios,
  });
  assert.equal(plan.rooms[0].peakAdults, 1);
  assert.equal(plan.rooms[1].peakAdults, 2, 'ceil(12/8)');
  assert.ok(plan.rooms[1].weeklyAdultHours > plan.rooms[0].weeklyAdultHours);
});

test('totals reconcile with the rooms', () => {
  const plan = buildCoveragePlan({
    rooms: [
      { id: 'a', label: 'A', ratioRule: 'm_3_5yr' },
      { id: 'b', label: 'B', ratioRule: 'm_2_3yr' },
    ],
    childrenByRoom: { a: 20, b: 10 },
    enrolledByTypeFor: byChildren,
    hours: HOURS, scheduleTypes: [FULL], ratios,
  });
  near(plan.totals.requiredHours, plan.rooms.reduce((a, r) => a + r.weeklyAdultHours, 0));
  near(plan.totals.suppliedHours, plan.rooms.reduce((a, r) => a + r.suppliedHours, 0));
  near(plan.totals.surplusHours, plan.totals.suppliedHours - plan.totals.requiredHours);
  assert.equal(plan.totals.people, plan.rooms.reduce((a, r) => a + r.shifts.length, 0));
});

test('an empty facility plans nobody', () => {
  const plan = buildCoveragePlan({
    rooms: [], childrenByRoom: {}, enrolledByTypeFor: () => ({}),
    hours: HOURS, scheduleTypes: [FULL], ratios,
  });
  assert.equal(plan.totals.people, 0);
  assert.equal(plan.totals.requiredHours, 0);
  assert.deepEqual(shiftsByRole(plan), {});
});
