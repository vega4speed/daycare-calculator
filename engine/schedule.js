// schedule.js — operating hours, enrollment schedules, and what they cost in staff-hours.
//
// Pure. No I/O, no DOM.
//
// ---------------------------------------------------------------------------------------------
// Why this module exists
// ---------------------------------------------------------------------------------------------
// engine/capacity.js answers "how many adults do N children require" — a ratio at a MOMENT.
// That is not what you pay for. You pay for adults present across the whole operating day, and
// a teacher covering a 9-hour day at 40 hours/week is 2.25 FTE per ratio slot, not 1.
//
// This is the gap in the business plan's payroll: "2 teachers for 14 children" satisfies the 1:13
// ratio at any instant, but two 40-hour teachers cannot keep two adults on the floor for a
// 9-hour day, let alone the licensed 6am-6pm span. See PLAN.md §4.9.
//
// Two things drive the real number, and they pull in opposite directions:
//   - Longer hours cost more staff-hours, even at low occupancy, because ratio never rounds
//     below one adult while any child is present.
//   - Ratio scales with children PRESENT, so the early-morning and late-afternoon fringes are
//     much cheaper than the core of the day — few children, one adult.
// So the honest answer needs intra-day occupancy, not a single daily headcount.
//
// ---------------------------------------------------------------------------------------------
// The block model
// ---------------------------------------------------------------------------------------------
// The day is cut into blocks at every boundary that matters: opening, closing, the Chart 3
// fringe boundaries, and every schedule type's arrival and departure. Within a block the set of
// children present is constant, so ratio can be evaluated exactly once per block.
//
// TN Rule 1240-04-01-.22(1)(c)3 supplies the fringe boundary for free: combined grouping at a
// more permissive ratio is allowed for "the first/last hour and a half of each day only." That
// is precisely the accommodation for extended hours, so the model uses it where it applies.
//
// Hours are decimal (7.5 = 7:30am, 16.5 = 4:30pm, 18 = 6pm).

const FRINGE_HOURS = 1.5; // Rule .22(1)(c)3: "first/last hour and one-half of each day only"

/** Overlap in hours between two intervals; 0 if they don't overlap. */
export function overlapHours(aStart, aEnd, bStart, bEnd) {
  return Math.max(0, Math.min(aEnd, bEnd) - Math.max(aStart, bStart));
}

/**
 * Cut the operating day into blocks at every boundary that changes who is present or which
 * ratio rule applies.
 *
 * @param {{openHour:number, closeHour:number}} hours
 * @param {Array<{arriveHour:number, departHour:number}>} scheduleTypes
 * @returns {Array<{start, end, hours, fringe:boolean}>}
 */
export function dayBlocks({ openHour, closeHour }, scheduleTypes = []) {
  if (!(closeHour > openHour)) throw new Error('closeHour must be after openHour');

  const cuts = new Set([openHour, closeHour]);

  // Fringe boundaries — only if the day is long enough to have a distinct middle. A day of 3
  // hours or less is entirely fringe, and adding interior cuts would invent blocks.
  if (closeHour - openHour > 2 * FRINGE_HOURS) {
    cuts.add(openHour + FRINGE_HOURS);
    cuts.add(closeHour - FRINGE_HOURS);
  }

  for (const s of scheduleTypes) {
    for (const h of [s.arriveHour, s.departHour]) {
      if (h > openHour && h < closeHour) cuts.add(h);
    }
  }

  // On a day of 2 x 1.5 hours or less, the opening and closing windows meet or overlap, so they
  // cover the whole day and every block is fringe-eligible. (A 3-hour half-day preschool program
  // is a real configuration, not just an edge case.)
  const whollyFringe = closeHour - openHour <= 2 * FRINGE_HOURS;

  const sorted = [...cuts].sort((a, b) => a - b);
  const blocks = [];
  for (let i = 0; i < sorted.length - 1; i++) {
    const start = sorted[i];
    const end = sorted[i + 1];
    blocks.push({
      start,
      end,
      hours: end - start,
      // A block is fringe if it lies wholly within the first or the last hour and a half.
      fringe:
        whollyFringe || end <= openHour + FRINGE_HOURS || start >= closeHour - FRINGE_HOURS,
    });
  }
  return blocks;
}

/**
 * Children present in each block.
 *
 * `peak` counts every child enrolled in a schedule that overlaps the block, ignoring
 * days-per-week: ratio must hold on the busiest day, and you staff for that.
 * `average` weights by daysPerWeek/daysOpen — the utilization figure, useful for revenue and for
 * seeing how much of a seat a part-time child actually consumes.
 *
 * KNOWN SIMPLIFICATION: part-week schedules (MWF vs T/Th) are averaged, not laid out on a real
 * weekly calendar. Two complementary part-week groups may in reality peak on different days,
 * which `peak` will overstate. Modeling the actual weekly grid is a later refinement; overstating
 * required staff is the safe direction to be wrong in for a licensing constraint.
 *
 * @param {Object<string,number>} enrolledByType e.g. { full: 10, halfAM: 4 }
 */
export function occupancy(enrolledByType, blocks, scheduleTypes, { daysOpen = 5 } = {}) {
  const byType = new Map(scheduleTypes.map((s) => [s.id, s]));

  return blocks.map((block) => {
    let peak = 0;
    let average = 0;
    const present = {};

    for (const [typeId, count] of Object.entries(enrolledByType ?? {})) {
      const n = Math.max(0, count ?? 0);
      if (n === 0) continue;
      const s = byType.get(typeId);
      if (!s) throw new Error(`Unknown schedule type: ${typeId}`);

      // Present for ANY part of the block ⇒ present for ratio purposes during that block.
      if (overlapHours(s.arriveHour, s.departHour, block.start, block.end) > 0) {
        peak += n;
        present[typeId] = n;
        average += n * Math.min(1, (s.daysPerWeek ?? daysOpen) / daysOpen);
      }
    }

    return { ...block, peak, average, present };
  });
}

/**
 * Adults required in each block, and the staff-hours that implies.
 *
 * `ruleFor(block)` supplies the ratio rule, or an ARRAY of rules the block may legally use.
 *
 * When several apply, the one requiring the fewest adults wins. Chart 3's combined grouping is an
 * ALLOWANCE, not a requirement — a provider uses it only when it helps. This matters because
 * Chart 3 is not uniformly more permissive: 2½–5 years at 1:11 is *stricter* than 3–5 years at
 * 1:13, so a preschool room would simply decline to combine and keep its own ratio. Picking the
 * fringe rule unconditionally would invent staff the law does not require.
 *
 * The facility floor from Rule .22(1)(b)2 (more than 12 children present ⇒ a second adult) is
 * applied per block, because it is a rule about children *present*, which is exactly what a
 * block measures.
 */
export function staffingByBlock(occupied, ruleFor) {
  return occupied.map((block) => {
    const candidates = [ruleFor(block)].flat().filter(Boolean);
    if (candidates.length === 0) throw new Error(`No ratio rule for block ${block.start}-${block.end}`);

    const adultsUnder = (r) => (block.peak <= 0 ? 0 : Math.ceil(block.peak / r.childrenPerAdult));
    const rule = candidates.reduce((best, r) => (adultsUnder(r) < adultsUnder(best) ? r : best));
    const byRatio = adultsUnder(rule);
    const floor = block.peak > 12 ? 2 : block.peak > 0 ? 1 : 0;
    const adults = Math.max(byRatio, floor);
    return {
      ...block,
      rule: rule.id,
      byRatio,
      floor,
      adults,
      floorBinds: floor > byRatio,
      staffHours: adults * block.hours,
    };
  });
}

/**
 * Weekly staff-hours and FTE to cover a full operating week.
 *
 * `hoursPerFte` is SCHEDULED COVERAGE hours, not payroll hours. A 40-hour teacher does not
 * provide 40 hours of floor coverage once breaks are counted — which is one of the things the
 * floater pool exists to absorb (PLAN.md §4.8). Callers modeling breaks should pass the lower
 * effective figure.
 */
export function weeklyStaffing(staffed, { daysOpen = 5, hoursPerFte = 40 } = {}) {
  const dailyHours = staffed.reduce((sum, b) => sum + b.staffHours, 0);
  const weeklyHours = dailyHours * daysOpen;
  const peakAdults = staffed.reduce((max, b) => Math.max(max, b.adults), 0);

  return {
    dailyStaffHours: dailyHours,
    weeklyStaffHours: weeklyHours,
    fte: weeklyHours / hoursPerFte,
    peakAdults,
    // The gap between "adults on the floor at once" and "people you must employ" — the number
    // the business plan's phase table is missing.
    ftePerPeakAdult: peakAdults > 0 ? weeklyHours / hoursPerFte / peakAdults : 0,
  };
}

/**
 * End-to-end: operating hours + enrollment mix -> what it costs in staff.
 * The one call the projection loop makes.
 */
export function staffingForDay({
  hours,
  scheduleTypes,
  enrolledByType,
  coreRule,
  fringeRule,
  daysOpen = 5,
  hoursPerFte = 40,
}) {
  const blocks = dayBlocks(hours, scheduleTypes);
  const occupied = occupancy(enrolledByType, blocks, scheduleTypes, { daysOpen });
  // On the fringes BOTH rules are available; staffingByBlock takes whichever needs fewer adults.
  const ruleFor = (b) => (b.fringe && fringeRule ? [coreRule, fringeRule] : coreRule);
  const staffed = staffingByBlock(occupied, ruleFor);
  return { blocks: staffed, ...weeklyStaffing(staffed, { daysOpen, hoursPerFte }) };
}

/**
 * What does widening (or narrowing) the operating day cost?
 *
 * The question Jake asked: longer hours widen the applicant pool, but they are not free. This
 * isolates the staffing cost of the change so it can be weighed against the enrollment benefit —
 * which stays an assumption, because no model can tell you how many more families apply.
 *
 * @returns {{base, alt, deltaWeeklyStaffHours, deltaFte, deltaMonthlyCost}}
 */
export function compareOperatingHours(baseArgs, altHours, { wagePerHour } = {}) {
  const base = staffingForDay(baseArgs);
  const alt = staffingForDay({ ...baseArgs, hours: altHours });
  const deltaHours = alt.weeklyStaffHours - base.weeklyStaffHours;
  return {
    base,
    alt,
    deltaWeeklyStaffHours: deltaHours,
    deltaFte: alt.fte - base.fte,
    deltaMonthlyCost: wagePerHour == null ? null : (deltaHours * wagePerHour * 52) / 12,
  };
}

/**
 * Seat utilization: how much of a seat each enrolled child actually consumes.
 *
 * This is where part-time enrollment earns its keep — two complementary half-day children share
 * one seat, so enrollment can exceed physical capacity. But only if the schedules actually tile:
 * two AM-only children do not share a seat, they leave it empty every afternoon. The ratio of
 * enrolled children to peak occupancy is the honest measure of whether the mix is tiling.
 */
export function seatUtilization(occupied, enrolledByType) {
  const enrolled = Object.values(enrolledByType ?? {}).reduce((a, b) => a + Math.max(0, b ?? 0), 0);
  const peakOccupancy = occupied.reduce((max, b) => Math.max(max, b.peak), 0);
  const openHours = occupied.reduce((sum, b) => sum + b.hours, 0);

  // Child-hours actually consumed vs. what peak occupancy holds open all day.
  const childHours = occupied.reduce((sum, b) => sum + b.peak * b.hours, 0);

  return {
    enrolled,
    peakOccupancy,
    // >1 means part-time schedules are sharing seats; 1 means every child holds a seat all day.
    enrolledPerSeat: peakOccupancy > 0 ? enrolled / peakOccupancy : 0,
    // How full the seats you're holding open actually are, across the day.
    seatFillRate: peakOccupancy > 0 && openHours > 0 ? childHours / (peakOccupancy * openHours) : 0,
  };
}
