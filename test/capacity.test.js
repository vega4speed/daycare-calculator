import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  findRatioRule,
  withVariance,
  roomCapacity,
  openRooms,
  licensedCapacity,
  allocate,
  staffingRequirement,
  coverageBuffer,
} from '../engine/capacity.js';

// The real verified tables — these tests double as a check that the data file still says what
// the engine assumes it says.
const { ratios } = JSON.parse(
  readFileSync(new URL('../data/tn-childcare.json', import.meta.url), 'utf8'),
);

// The business plan's Year 1 layout: one toddler room of 12 (ages 2-3) and preschool seating 24
// (ages 3-5), opening across the phases.
const planRooms = [
  { id: 'ps-1', label: 'Preschool 1', group: 'preschool', ratioRule: 'm_3_5yr', seats: 12, openMonth: 0 },
  { id: 'ps-2', label: 'Preschool 2', group: 'preschool', ratioRule: 'm_3_5yr', seats: 12, openMonth: 4 },
  { id: 'tod-1', label: 'Toddler', group: 'toddler', ratioRule: 'm_2_3yr', seats: 12, openMonth: 8 },
];

// --- the verified tables -----------------------------------------------------------------

test('the data file still carries the ratios the engine assumes', () => {
  const ratioOf = (id) => {
    const r = findRatioRule(ratios, id);
    return [r.childrenPerAdult, r.maxGroupSize];
  };
  assert.deepEqual(ratioOf('age2'), [7, 14], 'Chart 1: two year olds');
  assert.deepEqual(ratioOf('age3'), [9, 18], 'Chart 1: three year olds');
  assert.equal(findRatioRule(ratios, 'm_2_3yr').childrenPerAdult, 8);
  assert.equal(findRatioRule(ratios, 'm_2_3yr').maxGroupSize, 16);
  assert.equal(findRatioRule(ratios, 'm_3_5yr').childrenPerAdult, 13);
  assert.equal(findRatioRule(ratios, 'm_3_5yr').maxGroupSize, 24);
  assert.equal(findRatioRule(ratios, 'infant').childrenPerAdult, 4);
  assert.equal(findRatioRule(ratios, 'infant').maxGroupSize, 8);
});

test('an unknown rule id throws rather than defaulting', () => {
  // A typo'd rule id silently resolving to something would produce plausible-looking wrong
  // staffing, which is the worst possible failure mode for this module.
  assert.throws(() => findRatioRule(ratios, 'nope'), /Unknown ratio rule: nope/);
});

// --- room capacity -----------------------------------------------------------------------

test('capacity is the smaller of physical seats and max group size', () => {
  const bySeats = roomCapacity(
    { group: 'preschool', ratioRule: 'm_3_5yr', seats: 12 }, ratios,
  );
  assert.equal(bySeats.capacity, 12);
  assert.equal(bySeats.limitedBy, 'seats');

  // 30 seats in a 2-3yr room, but only 16 children may be grouped together
  const byGroupSize = roomCapacity(
    { group: 'toddler', ratioRule: 'm_2_3yr', seats: 30 }, ratios,
  );
  assert.equal(byGroupSize.capacity, 16);
  assert.equal(byGroupSize.limitedBy, 'groupSize');

  const both = roomCapacity({ group: 'toddler', ratioRule: 'm_2_3yr', seats: 16 }, ratios);
  assert.equal(both.capacity, 16);
  assert.equal(both.limitedBy, 'both');
});

test('a rule with no max group size is limited only by seats', () => {
  const r = roomCapacity({ group: 'school', ratioRule: 'schoolAge', seats: 40 }, ratios);
  assert.equal(r.maxGroupSize, null);
  assert.equal(r.capacity, 40);
  assert.equal(r.limitedBy, 'seats');
});

test("the plan's long-range 21-seat rooms are legal for 3-5 year olds", () => {
  // PLAN doc section 12: 6 classrooms at 21 children each. Max group for 3-5 is 24, so 21 is
  // seat-limited, not group-limited -- the layout is fine.
  const r = roomCapacity({ group: 'preschool', ratioRule: 'm_3_5yr', seats: 21 }, ratios);
  assert.equal(r.capacity, 21);
  assert.equal(r.limitedBy, 'seats');
});

test('the 10% variance is off by default and opt-in only', () => {
  const rule = findRatioRule(ratios, 'm_3_5yr'); // 1:13, max 24
  assert.equal(withVariance(rule), rule, 'returns the rule untouched by default');

  const varied = withVariance(rule, { allowVariance: true });
  assert.equal(varied.childrenPerAdult, 14); // round(13 * 1.1) = round(14.3)
  assert.equal(varied.maxGroupSize, 26); // round(24 * 1.1) = round(26.4)
  assert.equal(varied.varianceApplied, true);
});

// --- opening schedule --------------------------------------------------------------------

test('rooms open on their openMonth and stay open', () => {
  assert.deepEqual(openRooms(planRooms, -1).map((r) => r.id), []);
  assert.deepEqual(openRooms(planRooms, 0).map((r) => r.id), ['ps-1']);
  assert.deepEqual(openRooms(planRooms, 4).map((r) => r.id), ['ps-1', 'ps-2']);
  assert.deepEqual(openRooms(planRooms, 8).map((r) => r.id), ['ps-1', 'ps-2', 'tod-1']);
  assert.deepEqual(openRooms(planRooms, 99).map((r) => r.id), ['ps-1', 'ps-2', 'tod-1']);
});

test('a room with no openMonth never opens', () => {
  const rooms = [{ id: 'future', group: 'infant', ratioRule: 'infant', seats: 8, openMonth: null }];
  assert.deepEqual(openRooms(rooms, 500), []);
});

test('licensed capacity tracks the opening schedule', () => {
  assert.equal(licensedCapacity(planRooms, ratios, -1).total, 0);
  assert.equal(licensedCapacity(planRooms, ratios, 0).total, 12);
  assert.equal(licensedCapacity(planRooms, ratios, 4).total, 24);

  const full = licensedCapacity(planRooms, ratios, 8);
  assert.equal(full.total, 36, "the plan's Year 1 capacity");
  assert.deepEqual(full.byGroup, { preschool: 24, toddler: 12 });
  assert.deepEqual(full.byRoom, { 'ps-1': 12, 'ps-2': 12, 'tod-1': 12 });
});

// --- allocation and the unserved surface --------------------------------------------------

test('a target within capacity is fully served', () => {
  const a = allocate({ preschool: 10 }, planRooms, ratios, 0);
  assert.equal(a.served, 10);
  assert.equal(a.unserved, 0);
  assert.deepEqual(a.byRoom, { 'ps-1': 10 });
});

test('a target above capacity is clamped, and the shortfall is reported not hidden', () => {
  // The whole point of the "absolute target" design decision: your number stays visible.
  const a = allocate({ preschool: 30 }, planRooms, ratios, 0);
  assert.equal(a.target, 30);
  assert.equal(a.served, 12);
  assert.equal(a.unserved, 18);
  assert.deepEqual(a.unservedByGroup, { preschool: 18 });
});

test('children spill into rooms in array order', () => {
  const a = allocate({ preschool: 20 }, planRooms, ratios, 4);
  assert.deepEqual(a.byRoom, { 'ps-1': 12, 'ps-2': 8 });
  assert.equal(a.unserved, 0);
});

test('a group with no open room is entirely unserved', () => {
  const a = allocate({ preschool: 8, toddler: 6 }, planRooms, ratios, 0);
  assert.deepEqual(a.byGroup, { preschool: 8, toddler: 0 });
  assert.deepEqual(a.unservedByGroup, { toddler: 6 });
  assert.equal(a.unserved, 6);
});

test('open rooms with nobody in them still report zero', () => {
  const a = allocate({ preschool: 5 }, planRooms, ratios, 8);
  assert.deepEqual(a.byRoom, { 'ps-1': 5, 'ps-2': 0, 'tod-1': 0 });
});

test('an empty or missing target is handled', () => {
  assert.equal(allocate({}, planRooms, ratios, 0).served, 0);
  assert.equal(allocate(undefined, planRooms, ratios, 0).served, 0);
  assert.equal(allocate({ preschool: 0 }, planRooms, ratios, 0).served, 0);
  assert.equal(allocate({ preschool: -5 }, planRooms, ratios, 0).unserved, 0, 'negatives floor at 0');
});

// --- staffing: the golden numbers from the business plan ----------------------------------

test('Phase 1 -- 14 children in one preschool room needs 2 adults', () => {
  const rooms = [{ id: 'ps-1', group: 'preschool', ratioRule: 'm_3_5yr', seats: 14, openMonth: 0 }];
  const a = allocate({ preschool: 14 }, rooms, ratios, 0);
  const s = staffingRequirement(a, rooms, ratios);

  assert.equal(s.ratioRequired, 2, 'ceil(14 / 13)');
  assert.equal(s.facilityFloor, 2, 'more than 12 children present');
  assert.equal(s.total, 2);
  // The plan budgets 2 teachers here -- exactly the legal minimum.
});

test('Phase 4 -- 36 children across 3 rooms needs 4 adults; the plan budgets 5', () => {
  const a = allocate({ preschool: 24, toddler: 12 }, planRooms, ratios, 8);
  const s = staffingRequirement(a, planRooms, ratios);

  assert.deepEqual(s.byRoom, {
    'ps-1': 1, // ceil(12 / 13)
    'ps-2': 1, // ceil(12 / 13)
    'tod-1': 2, // ceil(12 / 8)
  });
  assert.equal(s.ratioRequired, 4);
  assert.equal(s.total, 4);
  assert.equal(s.childrenPresent, 36);

  // PLAN.md section 4.7: the plan budgets 5 teachers plus a full-time director, i.e. one above
  // the legal minimum. That buffer is a lever, not an error -- see coverageBuffer below.
  assert.equal(coverageBuffer(5, s).buffer, 1);
});

test('the second-adult rule binds independently of ratio', () => {
  // 13 four-to-five year olds is 1 adult by ratio (1:16) but 2 by Rule .22(1)(b)2.
  const rooms = [{ id: 'r', group: 'preschool', ratioRule: 'm_4_5yr', seats: 20, openMonth: 0 }];
  const a = allocate({ preschool: 13 }, rooms, ratios, 0);
  const s = staffingRequirement(a, rooms, ratios);

  assert.equal(s.ratioRequired, 1, 'ceil(13 / 16)');
  assert.equal(s.facilityFloor, 2);
  assert.equal(s.floorBinds, true);
  assert.equal(s.total, 2);
});

test('exactly 12 children does not trigger the second-adult rule', () => {
  // The rule says MORE THAN twelve. An off-by-one here would add a teacher's salary for nothing.
  const rooms = [{ id: 'r', group: 'preschool', ratioRule: 'm_4_5yr', seats: 20, openMonth: 0 }];
  const twelve = staffingRequirement(allocate({ preschool: 12 }, rooms, ratios, 0), rooms, ratios);
  assert.equal(twelve.facilityFloor, 1);
  assert.equal(twelve.total, 1);

  const thirteen = staffingRequirement(allocate({ preschool: 13 }, rooms, ratios, 0), rooms, ratios);
  assert.equal(thirteen.facilityFloor, 2);
  assert.equal(thirteen.total, 2);
});

test('a director on the premises can satisfy the second-adult floor', () => {
  const rooms = [{ id: 'r', group: 'preschool', ratioRule: 'm_4_5yr', seats: 20, openMonth: 0 }];
  const a = allocate({ preschool: 13 }, rooms, ratios, 0);

  assert.equal(staffingRequirement(a, rooms, ratios).total, 2);
  assert.equal(
    staffingRequirement(a, rooms, ratios, { directorCounts: true }).total, 1,
    'the director is the second adult, so only 1 teacher is required',
  );
});

test('the director never reduces staffing below the ratio requirement', () => {
  const a = allocate({ preschool: 24, toddler: 12 }, planRooms, ratios, 8);
  const s = staffingRequirement(a, planRooms, ratios, { directorCounts: true });
  assert.equal(s.total, 4, 'ratio still governs; the floor is far below it here');
  assert.equal(s.floorBinds, false);
});

test('no children means no required staff', () => {
  const a = allocate({ preschool: 0 }, planRooms, ratios, 0);
  const s = staffingRequirement(a, planRooms, ratios);
  assert.equal(s.total, 0);
  assert.equal(s.facilityFloor, 0);
});

test('infant rooms are staff-expensive -- the tradeoff the later phase has to weigh', () => {
  // 8 infants (a full group at max size) need 2 adults; 8 preschoolers need 1.
  const inf = [{ id: 'i', group: 'infant', ratioRule: 'infant', seats: 8, openMonth: 0 }];
  const pre = [{ id: 'p', group: 'preschool', ratioRule: 'm_3_5yr', seats: 8, openMonth: 0 }];
  assert.equal(staffingRequirement(allocate({ infant: 8 }, inf, ratios, 0), inf, ratios).ratioRequired, 2);
  assert.equal(staffingRequirement(allocate({ preschool: 8 }, pre, ratios, 0), pre, ratios).ratioRequired, 1);
});

// --- coverage buffer ---------------------------------------------------------------------

test('coverageBuffer measures fragility against the legal minimum', () => {
  const rooms = [{ id: 'r', group: 'preschool', ratioRule: 'm_3_5yr', seats: 24, openMonth: 0 }];
  const s = staffingRequirement(allocate({ preschool: 24 }, rooms, ratios, 0), rooms, ratios);
  assert.equal(s.total, 2);

  const bare = coverageBuffer(2, s);
  assert.equal(bare.buffer, 0);
  assert.equal(bare.bufferRatio, 0);
  assert.equal(bare.outOfRatio, false, 'legal, but one absence away from not being');

  const cushioned = coverageBuffer(3, s);
  assert.equal(cushioned.buffer, 1);
  assert.equal(cushioned.bufferRatio, 0.5);

  const short = coverageBuffer(1, s);
  assert.equal(short.buffer, -1);
  assert.equal(short.outOfRatio, true);
});

test('coverageBuffer reports no ratio when nothing is required', () => {
  const empty = coverageBuffer(0, { total: 0 });
  assert.equal(empty.bufferRatio, null, 'no division by zero');
  assert.equal(empty.outOfRatio, false);
});
