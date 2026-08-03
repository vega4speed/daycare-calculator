import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { findRatioRule } from '../engine/capacity.js';
import {
  overlapHours,
  dayBlocks,
  occupancy,
  staffingByBlock,
  weeklyStaffing,
  staffingForDay,
  compareOperatingHours,
  seatUtilization,
} from '../engine/schedule.js';

const { ratios } = JSON.parse(
  readFileSync(new URL('../data/tn-childcare.json', import.meta.url), 'utf8'),
);

const PRESCHOOL = findRatioRule(ratios, 'm_3_5yr'); // 1:13, max group 24
// Chart 3, allowed for the first/last hour and a half only: 2.5-5 years at 1:11.
const FRINGE = { id: 'chart3_2h_5yr', childrenPerAdult: 11, maxGroupSize: 20 };

const FULL = { id: 'full', label: 'Full day', arriveHour: 7.5, departHour: 16.5, daysPerWeek: 5 };
const HALF_AM = { id: 'halfAM', label: 'Half day AM', arriveHour: 7.5, departHour: 12, daysPerWeek: 5 };
const HALF_PM = { id: 'halfPM', label: 'Half day PM', arriveHour: 12, departHour: 16.5, daysPerWeek: 5 };
const MWF = { id: 'mwf', label: 'Full day, MWF', arriveHour: 7.5, departHour: 16.5, daysPerWeek: 3 };

const LICENSED = { openHour: 6, closeHour: 18 }; // the full 6am-6pm license

// --- primitives --------------------------------------------------------------------------

test('overlapHours measures intersection, not adjacency', () => {
  assert.equal(overlapHours(7.5, 16.5, 6, 7.5), 0, 'touching endpoints do not overlap');
  assert.equal(overlapHours(7.5, 16.5, 7.5, 9), 1.5);
  assert.equal(overlapHours(7.5, 12, 9, 16.5), 3);
  assert.equal(overlapHours(6, 18, 7, 8), 1, 'fully contained');
  assert.equal(overlapHours(6, 7, 10, 11), 0, 'disjoint');
});

// --- blocks ------------------------------------------------------------------------------

test('the day is cut at the fringe boundaries and every schedule boundary', () => {
  const blocks = dayBlocks(LICENSED, [FULL, HALF_AM]);
  assert.deepEqual(
    blocks.map((b) => [b.start, b.end]),
    [[6, 7.5], [7.5, 12], [12, 16.5], [16.5, 18]],
  );
  // 6-7.5 and 16.5-18 are exactly the licensed fringe windows
  assert.deepEqual(blocks.map((b) => b.fringe), [true, false, false, true]);
  assert.equal(blocks.reduce((s, b) => s + b.hours, 0), 12, 'blocks tile the whole day');
});

test('a day with no schedule boundaries still splits at the fringes', () => {
  const blocks = dayBlocks(LICENSED, []);
  assert.deepEqual(blocks.map((b) => [b.start, b.end]), [[6, 7.5], [7.5, 16.5], [16.5, 18]]);
});

test('a short day is entirely fringe and gets no invented interior blocks', () => {
  const blocks = dayBlocks({ openHour: 9, closeHour: 12 }, []);
  assert.deepEqual(blocks.map((b) => [b.start, b.end]), [[9, 12]]);
  assert.equal(blocks[0].fringe, true);
});

test('schedule boundaries outside operating hours are ignored', () => {
  const blocks = dayBlocks({ openHour: 8, closeHour: 17 }, [
    { arriveHour: 6, departHour: 20 }, // a schedule wider than the day
  ]);
  assert.deepEqual(blocks.map((b) => [b.start, b.end]), [[8, 9.5], [9.5, 15.5], [15.5, 17]]);
});

test('a closing time at or before opening is rejected', () => {
  assert.throws(() => dayBlocks({ openHour: 10, closeHour: 10 }, []), /closeHour must be after/);
});

// --- occupancy ---------------------------------------------------------------------------

test('children count in every block their schedule overlaps', () => {
  const blocks = dayBlocks(LICENSED, [FULL, HALF_AM]);
  const occ = occupancy({ full: 10, halfAM: 4 }, blocks, [FULL, HALF_AM]);

  assert.deepEqual(occ.map((b) => b.peak), [
    0,  // 6-7.5   nobody has arrived
    14, // 7.5-12  everyone
    10, // 12-16.5 the half-day children have gone
    0,  // 16.5-18 nobody left
  ]);
});

test('peak ignores days-per-week; average weights by it', () => {
  const blocks = dayBlocks(LICENSED, [FULL, MWF]);
  const occ = occupancy({ full: 10, mwf: 5 }, blocks, [FULL, MWF]);
  const core = occ.find((b) => b.start === 7.5);

  assert.equal(core.peak, 15, 'staff for the busiest day');
  assert.equal(core.average, 13, '10 + 5 * (3/5)');
});

test('an unknown schedule type throws rather than being silently dropped', () => {
  const blocks = dayBlocks(LICENSED, [FULL]);
  assert.throws(
    () => occupancy({ nope: 5 }, blocks, [FULL]),
    /Unknown schedule type: nope/,
  );
});

test('zero and missing enrollment are handled', () => {
  const blocks = dayBlocks(LICENSED, [FULL]);
  assert.equal(occupancy({ full: 0 }, blocks, [FULL])[1].peak, 0);
  assert.equal(occupancy(undefined, blocks, [FULL])[1].peak, 0);
});

// --- arrival/departure ramps --------------------------------------------------------------

test('an arrival window ramps presence up instead of switching on at an instant', () => {
  // Families trickle in between 7 and 9. LICENSED's own fringe boundary (openHour + 1.5 = 7.5)
  // falls inside that ramp and splits it in two, with no second schedule type needed.
  const flexFull = {
    id: 'full', arriveHour: 7, arriveByHour: 9, departFromHour: 15, departHour: 17, daysPerWeek: 5,
  };
  const blocks = dayBlocks(LICENSED, [flexFull]);
  const occ = occupancy({ full: 20 }, blocks, [flexFull]);

  assert.equal(occ.find((b) => b.start === 6).peak, 0, 'before anyone arrives');
  assert.equal(occ.find((b) => b.start === 7 && b.end === 7.5).peak, 5, '1/4 of the way through the 2-hour ramp');
  assert.equal(occ.find((b) => b.start === 7.5 && b.end === 9).peak, 20, 'ramp completes by the end of this block');
  assert.equal(occ.find((b) => b.start === 9).peak, 20, 'full core-of-day presence');
});

test('a departure window ramps presence down the same way, symmetrically', () => {
  // LICENSED's closing fringe boundary (closeHour - 1.5 = 16.5) falls inside the 15-17 ramp.
  const flexFull = {
    id: 'full', arriveHour: 7, arriveByHour: 7, departFromHour: 15, departHour: 17, daysPerWeek: 5,
  };
  const blocks = dayBlocks(LICENSED, [flexFull]);
  const occ = occupancy({ full: 20 }, blocks, [flexFull]);

  assert.equal(occ.find((b) => b.start === 15 && b.end === 16.5).peak, 20, 'ramp has barely started');
  assert.equal(occ.find((b) => b.start === 16.5 && b.end === 17).peak, 5, '3/4 of the way through the 2-hour ramp');
  assert.equal(occ.find((b) => b.start === 17).peak, 0, 'after everyone has left');
});

test('an unset arrival/departure window is a zero-width ramp -- identical to the old exact-time model', () => {
  // No arriveByHour/departFromHour set, same as every other test in this file.
  const blocks = dayBlocks(LICENSED, [FULL, HALF_AM]);
  const occ = occupancy({ full: 10, halfAM: 4 }, blocks, [FULL, HALF_AM]);
  assert.deepEqual(occ.map((b) => b.peak), [0, 14, 10, 0]);
});

test('a ramp block needs fewer adults than a fully-occupied one, ratio-wise', () => {
  const flexFull = {
    id: 'full', arriveHour: 7, arriveByHour: 10, departFromHour: 15, departHour: 17, daysPerWeek: 5,
  };
  const hours = { openHour: 7, closeHour: 17 };
  const blocks = dayBlocks(hours, [flexFull]);
  const staffed = staffingByBlock(occupancy({ full: 20 }, blocks, [flexFull]), () => PRESCHOOL);

  const rampStart = staffed.find((b) => b.start === 7);
  const core = staffed.find((b) => b.start === 10);
  assert.equal(core.adults, 2, 'ceil(20/13), and the >12 floor also demands 2');
  assert.equal(rampStart.adults, 1, 'only half the ramp has arrived by 8.5: ceil(10/13)');
  assert.ok(rampStart.adults < core.adults, 'fewer families have arrived yet');
});

// --- staffing per block ------------------------------------------------------------------

test('ratio is evaluated per block, and empty blocks need nobody', () => {
  const blocks = dayBlocks(LICENSED, [FULL, HALF_AM]);
  const occ = occupancy({ full: 10, halfAM: 4 }, blocks, [FULL, HALF_AM]);
  const staffed = staffingByBlock(occ, (b) => (b.fringe ? FRINGE : PRESCHOOL));

  assert.deepEqual(staffed.map((b) => b.adults), [
    0, // nobody present
    2, // ceil(14/13), and the >12 floor also demands 2
    1, // ceil(10/13)
    0,
  ]);
});

test('the more permissive fringe rule is applied only on the fringes', () => {
  // 11 children present at 6am: Chart 3 allows 1 adult at 1:11; the core rule would too (1:13).
  // Use 12 to separate them from the facility floor and check the rule id that was applied.
  const hours = { openHour: 6, closeHour: 18 };
  const early = { id: 'early', arriveHour: 6, departHour: 16.5, daysPerWeek: 5 };
  const blocks = dayBlocks(hours, [early]);
  const occ = occupancy({ early: 12 }, blocks, [early]);
  const staffed = staffingByBlock(occ, (b) => (b.fringe ? FRINGE : PRESCHOOL));

  assert.equal(staffed[0].fringe, true);
  assert.equal(staffed[0].rule, 'chart3_2h_5yr');
  assert.equal(staffed[1].rule, 'm_3_5yr');
});

test('Chart 3 is an allowance, so a STRICTER fringe rule is simply not used', () => {
  // Chart 3's 2.5-5yr combined grouping is 1:11 -- stricter than a 3-5yr room's own 1:13.
  // A provider would decline to combine and keep its own ratio. Applying the fringe rule
  // unconditionally would invent a teacher the law does not require.
  const hours = { openHour: 6, closeHour: 18 };
  const allDay = { id: 'allDay', arriveHour: 6, departHour: 18, daysPerWeek: 5 };
  const blocks = dayBlocks(hours, [allDay]);
  const occ = occupancy({ allDay: 12 }, blocks, [allDay]);

  const staffed = staffingByBlock(occ, (b) => (b.fringe ? [PRESCHOOL, FRINGE] : PRESCHOOL));
  const fringeBlock = staffed.find((b) => b.fringe);

  assert.equal(fringeBlock.adults, 1, 'ceil(12/13) under the core rule, not ceil(12/11)');
  assert.equal(fringeBlock.rule, 'm_3_5yr', 'the core rule won because it needs fewer adults');
});

test('Chart 3 IS used when it genuinely helps', () => {
  // A 2-3yr room is 1:8. Chart 3 lets 2.5-5 year olds combine at 1:11 on the fringes.
  const TODDLER = findRatioRule(ratios, 'm_2_3yr'); // 1:8
  const hours = { openHour: 6, closeHour: 18 };
  const allDay = { id: 'allDay', arriveHour: 6, departHour: 18, daysPerWeek: 5 };
  const blocks = dayBlocks(hours, [allDay]);
  const occ = occupancy({ allDay: 11 }, blocks, [allDay]);

  const staffed = staffingByBlock(occ, (b) => (b.fringe ? [TODDLER, FRINGE] : TODDLER));
  assert.equal(staffed.find((b) => b.fringe).adults, 1, 'ceil(11/11) beats ceil(11/8)');
  assert.equal(staffed.find((b) => b.fringe).rule, 'chart3_2h_5yr');
  assert.equal(staffed.find((b) => !b.fringe).adults, 2, 'the core of the day still needs 2');
});

test('a block with no applicable rule throws rather than staffing nobody', () => {
  const blocks = dayBlocks({ openHour: 8, closeHour: 17 }, []);
  assert.throws(
    () => staffingByBlock(occupancy({}, blocks, []), () => null),
    /No ratio rule for block/,
  );
});

test('the more-than-12 floor binds per block', () => {
  const hours = { openHour: 8, closeHour: 17 };
  const s = { id: 's', arriveHour: 8, departHour: 17, daysPerWeek: 5 };
  const blocks = dayBlocks(hours, [s]);
  const staffed = staffingByBlock(
    occupancy({ s: 13 }, blocks, [s]),
    () => ({ id: 'r', childrenPerAdult: 16 }),
  );
  const core = staffed.find((b) => !b.fringe);
  assert.equal(core.byRatio, 1, 'ceil(13/16)');
  assert.equal(core.floor, 2);
  assert.equal(core.adults, 2);
  assert.equal(core.floorBinds, true);
});

// --- THE FINDING: ratio slots are not FTE ------------------------------------------------

test("the plan's Phase 1 needs more than the 2 teachers it budgets", () => {
  // 14 children, all full-day, in the plan's own launch configuration.
  // Two adults satisfy the 1:13 ratio at any instant -- but not across a whole day.
  const r = staffingForDay({
    hours: { openHour: 7.5, closeHour: 16.5 }, // a conservative 9-hour day, not the full license
    scheduleTypes: [FULL],
    enrolledByType: { full: 14 },
    coreRule: PRESCHOOL,
    fringeRule: FRINGE,
  });

  assert.equal(r.peakAdults, 2, 'ratio at a moment: 2 adults, exactly what the plan says');
  assert.equal(r.weeklyStaffHours, 90, '2 adults x 9 hours x 5 days');
  assert.equal(r.fte, 2.25, 'but 2.25 people at 40 hours each');
  assert.equal(r.ftePerPeakAdult, 1.125);
});

test('the full 6am-6pm license costs materially more than a 9-hour day', () => {
  const common = {
    scheduleTypes: [FULL],
    enrolledByType: { full: 14 },
    coreRule: PRESCHOOL,
    fringeRule: FRINGE,
  };

  const short = staffingForDay({ ...common, hours: { openHour: 7.5, closeHour: 16.5 } });
  // Nobody is enrolled outside 7.5-16.5, so simply opening the doors longer costs nothing --
  // the cost arrives with the children who use the extra hours, which is the point.
  const long = staffingForDay({ ...common, hours: LICENSED });
  assert.equal(long.weeklyStaffHours, short.weeklyStaffHours, 'empty hours are free');

  // Now give four of them a 6am-6pm schedule and the fringe has to be staffed.
  const early = { id: 'early', arriveHour: 6, departHour: 18, daysPerWeek: 5 };
  const withFringe = staffingForDay({
    ...common,
    hours: LICENSED,
    scheduleTypes: [FULL, early],
    enrolledByType: { full: 10, early: 4 },
  });
  assert.equal(withFringe.weeklyStaffHours, 105, '+15 hrs/wk of fringe coverage');
  assert.equal(withFringe.fte, 2.625);
});

test('compareOperatingHours prices a change in the operating day', () => {
  const early = { id: 'early', arriveHour: 6, departHour: 18, daysPerWeek: 5 };
  const args = {
    hours: { openHour: 7.5, closeHour: 16.5 },
    scheduleTypes: [FULL, early],
    enrolledByType: { full: 10, early: 4 },
    coreRule: PRESCHOOL,
    fringeRule: FRINGE,
  };

  const cmp = compareOperatingHours(args, LICENSED, { wagePerHour: 18 });
  assert.equal(cmp.deltaWeeklyStaffHours, 15, '1 adult over the two 1.5-hour fringes, 5 days');
  assert.equal(cmp.deltaFte, 0.375);
  assert.equal(Math.round(cmp.deltaMonthlyCost), 1170, '$18/hr -> ~$1,170/mo');
});

// --- part-time and seat sharing ------------------------------------------------------------

test('complementary half-day schedules share a seat', () => {
  const hours = { openHour: 7.5, closeHour: 16.5 };
  const types = [HALF_AM, HALF_PM];
  const blocks = dayBlocks(hours, types);
  const occ = occupancy({ halfAM: 12, halfPM: 12 }, blocks, types);
  const u = seatUtilization(occ, { halfAM: 12, halfPM: 12 });

  assert.equal(u.enrolled, 24);
  assert.equal(u.peakOccupancy, 12, 'never more than 12 children on site at once');
  assert.equal(u.enrolledPerSeat, 2, 'two enrolled children per physical seat');
  assert.equal(u.seatFillRate, 1, 'and the seats are full all day');
});

test('non-complementary part-time schedules do NOT share a seat', () => {
  // Two AM-only cohorts leave the afternoon empty -- the trap the sharing story hides.
  const hours = { openHour: 7.5, closeHour: 16.5 };
  const types = [HALF_AM];
  const blocks = dayBlocks(hours, types);
  const occ = occupancy({ halfAM: 12 }, blocks, types);
  const u = seatUtilization(occ, { halfAM: 12 });

  assert.equal(u.enrolledPerSeat, 1, 'no sharing at all');
  assert.equal(u.seatFillRate, 0.5, 'and the seats sit empty half the day');
});

test('full-day enrollment is one child per seat, all day', () => {
  const hours = { openHour: 7.5, closeHour: 16.5 };
  const blocks = dayBlocks(hours, [FULL]);
  const occ = occupancy({ full: 20 }, blocks, [FULL]);
  const u = seatUtilization(occ, { full: 20 });
  assert.equal(u.enrolledPerSeat, 1);
  assert.equal(u.seatFillRate, 1);
});

test('seatUtilization handles an empty program without dividing by zero', () => {
  const blocks = dayBlocks({ openHour: 8, closeHour: 17 }, [FULL]);
  const u = seatUtilization(occupancy({}, blocks, [FULL]), {});
  assert.equal(u.peakOccupancy, 0);
  assert.equal(u.enrolledPerSeat, 0);
  assert.equal(u.seatFillRate, 0);
});

test('half-day children need the same adults as full-day ones while present', () => {
  // The cost asymmetry behind part-time pricing: 14 children present is 2 adults whether they
  // are there for 4 hours or 9. DHS pays exactly half for the half-day child; staffing does not
  // halve. See PLAN.md 4.9.
  const hours = { openHour: 7.5, closeHour: 16.5 };
  const types = [HALF_AM];
  const blocks = dayBlocks(hours, types);
  const staffed = staffingByBlock(occupancy({ halfAM: 14 }, blocks, types), () => PRESCHOOL);
  const morning = staffed.find((b) => b.start === 7.5);
  assert.equal(morning.adults, 2, 'same 2 adults as 14 full-day children');
});

// --- weeklyStaffing ----------------------------------------------------------------------

test('weeklyStaffing scales by days open and FTE definition', () => {
  const staffed = [{ hours: 9, adults: 2, staffHours: 18 }];
  assert.equal(weeklyStaffing(staffed, { daysOpen: 5 }).weeklyStaffHours, 90);
  assert.equal(weeklyStaffing(staffed, { daysOpen: 4 }).weeklyStaffHours, 72);

  // A 37.5-hour effective-coverage FTE (breaks excluded) needs more people for the same hours.
  assert.equal(weeklyStaffing(staffed, { hoursPerFte: 40 }).fte, 2.25);
  assert.equal(weeklyStaffing(staffed, { hoursPerFte: 37.5 }).fte, 2.4);
});

test('an empty program requires nobody', () => {
  const r = staffingForDay({
    hours: LICENSED,
    scheduleTypes: [FULL],
    enrolledByType: { full: 0 },
    coreRule: PRESCHOOL,
  });
  assert.equal(r.weeklyStaffHours, 0);
  assert.equal(r.fte, 0);
  assert.equal(r.ftePerPeakAdult, 0);
});
