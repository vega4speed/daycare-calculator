// coverage.js — who covers which room, for which hours, and how the shifts add up.
//
// Pure. No I/O, no DOM.
//
// ---------------------------------------------------------------------------------------------
// Why this replaces the old staffing derivation
// ---------------------------------------------------------------------------------------------
// Staffing used to be computed FACILITY-WIDE per age group: pool every preschooler together,
// divide by the ratio, fill the resulting hours with leads and teachers. That was wrong in two
// ways and unexplainable in a third.
//
//   1. It UNDERSTATED staffing. Ratios apply to a group in a room, not to a building. 26
//      preschoolers pooled at 1:13 is 2 adults; split 24 and 2 across two rooms it is 2 + 1 = 3.
//      Pooling quietly produced the smaller number.
//   2. It made staff look like they were being fired. Because counts were recomputed from
//      scratch each month with leads pinned to rooms, opening a second classroom raised leads
//      from 1 to 2 and dropped teachers from 2 to 1 — the same three people, reported as a
//      layoff and a hire.
//   3. It could not answer "who is covering which class". There were no rooms in the answer,
//      only a total.
//
// So coverage is now computed PER ROOM and expressed as SHIFTS. Each room's open hours are
// tiled by real people with real weekly hours, and the plan says which room each shift is for.
//
// ---------------------------------------------------------------------------------------------
// The unit: adult-hours per week, per room
// ---------------------------------------------------------------------------------------------
// A room open 9 hours a day, 5 days a week, needing 2 adults present, is 90 adult-hours a week.
// Two 40-hour employees cover 80 of those. The remaining 10 do not need a third full-time
// person — they need 10 hours of somebody. That is what part-time staff are for, and modeling
// everyone as full-time forced a whole extra salary to cover a sliver.

import { staffingForDay } from './schedule.js';
import { findRatioRule } from './capacity.js';

/** Round to cents-ish precision so float noise never shows up as a 0.0000001-hour shift. */
const r2 = (n) => Math.round(n * 100) / 100;

/**
 * One room's coverage requirement, block by block.
 *
 * Reuses schedule.js — the same intra-day block model — but scoped to a single room rather than
 * a whole age group, which is the fix for the pooling error above.
 */
export function roomCoverage({
  room,
  enrolledByType,
  hours,
  scheduleTypes,
  ratios,
  fringeRatioRule = null,
  daysOpen = 5,
}) {
  const coreRule = findRatioRule(ratios, room.ratioRule);
  const fringeRule = fringeRatioRule ? findRatioRule(ratios, fringeRatioRule) : null;

  const s = staffingForDay({
    hours, scheduleTypes, enrolledByType, coreRule, fringeRule, daysOpen,
  });

  return {
    roomId: room.id,
    label: room.label ?? room.id,
    ratioRule: coreRule.id,
    childrenPerAdult: coreRule.childrenPerAdult,
    children: Object.values(enrolledByType ?? {}).reduce((a, b) => a + Math.max(0, b ?? 0), 0),
    blocks: s.blocks.map((b) => ({
      start: b.start,
      end: b.end,
      hours: b.hours,
      children: b.peak,
      adults: b.adults,
      rule: b.rule,
      floorBinds: b.floorBinds,
    })),
    peakAdults: s.peakAdults,
    weeklyAdultHours: r2(s.weeklyStaffHours),
  };
}

/**
 * Tile a room's required adult-hours with actual people.
 *
 * The first person in a room is its LEAD; anyone after is a TEACHER. That is a staffing
 * convention, not a licensing rule — a room needs adults, and which of them is designated lead
 * is the program's choice — but it matches how the business plan describes the rooms.
 *
 * `minShiftHours` exists because you cannot hire someone for two hours a week. A remainder below
 * it is rounded UP to a real shift, and the excess is reported as surplus rather than hidden.
 *
 * @returns {Array<{role, hoursPerWeek, fullTime}>}
 */
export function planRoomShifts(weeklyAdultHours, {
  fullTimeHours = 40,
  allowPartTime = true,
  minShiftHours = 10,
} = {}) {
  const need = Math.max(0, weeklyAdultHours ?? 0);
  if (need <= 0) return [];

  const shifts = [];
  let remaining = need;

  // The lead takes a full week, or the whole requirement if the room needs less than one person.
  const leadHours = Math.min(fullTimeHours, remaining);
  shifts.push({ role: 'lead', hoursPerWeek: r2(leadHours), fullTime: leadHours >= fullTimeHours });
  remaining = r2(remaining - leadHours);

  // Then full weeks for as long as a full week is genuinely needed.
  while (remaining >= fullTimeHours) {
    shifts.push({ role: 'teacher', hoursPerWeek: fullTimeHours, fullTime: true });
    remaining = r2(remaining - fullTimeHours);
  }

  if (remaining > 0) {
    if (allowPartTime) {
      // A shift shorter than minShiftHours is not a job anyone would take; round it up.
      const h = Math.max(minShiftHours, remaining);
      shifts.push({ role: 'teacher', hoursPerWeek: r2(h), fullTime: false });
    } else {
      shifts.push({ role: 'teacher', hoursPerWeek: fullTimeHours, fullTime: true });
    }
  }

  return shifts;
}

/**
 * The whole facility's coverage plan for one month.
 *
 * @param {object} args
 * @param {Array} args.rooms              open rooms, each already carrying a ratioRule
 * @param {Object<string,number>} args.childrenByRoom
 * @param {function} args.enrolledByTypeFor  (room, children) -> {scheduleTypeId: count}
 * @param {function} args.fringeRuleFor      (room) -> ratio rule id or null
 * @returns {{rooms, totals}}
 */
export function buildCoveragePlan({
  rooms = [],
  childrenByRoom = {},
  enrolledByTypeFor,
  fringeRuleFor = () => null,
  hours,
  scheduleTypes,
  ratios,
  daysOpen = 5,
  shiftOpts = {},
}) {
  const planned = [];
  let requiredHours = 0;
  let suppliedHours = 0;
  let peakAdults = 0;

  for (const room of rooms) {
    const children = childrenByRoom[room.id] ?? 0;
    const cov = roomCoverage({
      room,
      enrolledByType: enrolledByTypeFor(room, children),
      hours,
      scheduleTypes,
      ratios,
      fringeRatioRule: fringeRuleFor(room),
      daysOpen,
    });

    const shifts = planRoomShifts(cov.weeklyAdultHours, shiftOpts);
    const supplied = r2(shifts.reduce((a, s) => a + s.hoursPerWeek, 0));

    planned.push({
      ...cov,
      shifts,
      suppliedHours: supplied,
      // Slack above the legal minimum: cover for breaks, absences, and transitions. Negative is
      // impossible by construction here, but reported so the field means the same thing always.
      surplusHours: r2(supplied - cov.weeklyAdultHours),
    });

    requiredHours += cov.weeklyAdultHours;
    suppliedHours += supplied;
    peakAdults += cov.peakAdults;
  }

  return {
    rooms: planned,
    totals: {
      requiredHours: r2(requiredHours),
      suppliedHours: r2(suppliedHours),
      surplusHours: r2(suppliedHours - requiredHours),
      peakAdults,
      // Everyone who holds a shift, whatever its length.
      people: planned.reduce((a, r) => a + r.shifts.length, 0),
      fte: r2(suppliedHours / (shiftOpts.fullTimeHours ?? 40)),
    },
  };
}

/** Roll a coverage plan up into per-role shift lists, which is what seats are built from. */
export function shiftsByRole(plan) {
  const byRole = {};
  for (const room of plan.rooms) {
    for (const shift of room.shifts) {
      (byRole[shift.role] ??= []).push({
        hoursPerWeek: shift.hoursPerWeek,
        roomId: room.roomId,
        roomLabel: room.label,
        fullTime: shift.fullTime,
      });
    }
  }
  return byRole;
}
