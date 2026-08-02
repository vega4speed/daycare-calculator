// staffing.js — roles, seats, and what each one is paid.
//
// Pure. No I/O, no DOM.
//
// ---------------------------------------------------------------------------------------------
// Roles, from Jake (PLAN.md §4.8)
// ---------------------------------------------------------------------------------------------
//   Lead teacher  $20-21/hr   roughly one per classroom
//   Teacher       $18/hr      fills whatever coverage the leads don't
//   Floater       $17/hr      NOT one per class — a pool, and the buffer lever
//   Director      $26/hr      one, part-time at launch, full-time by Phase 4
//
// ---------------------------------------------------------------------------------------------
// Why SEATS and not a headcount
// ---------------------------------------------------------------------------------------------
// Jake's early-hire premium — the first couple of teachers paid above the later ones, because at
// lean staffing one departure is catastrophic and a buffer can absorb one — needs a per-position
// wage. A single headcount and a single wage per role cannot express it.
//
// So each required position is a SEAT with its own index within its role, and wage is resolved
// per seat. The premium attaches to the POSITION, not to a person, which is also how it works in
// practice: you don't re-cut everyone's offer letter when someone leaves.
//
// Turnover is handled as an expected COST (see turnover.js) rather than by simulating individuals
// vacating specific seats. Simulating quits would add variance without adding information, and
// would make the model non-reproducible for no gain.
//
// ---------------------------------------------------------------------------------------------
// How demand is derived
// ---------------------------------------------------------------------------------------------
// schedule.js says how many staff-HOURS of ratio coverage the operating day requires. That is the
// constraint. Roles then fill it:
//   1. Leads:    leadsPerRoom x open rooms. Their hours count toward coverage.
//   2. Teachers: enough to cover whatever coverage the leads leave unfilled.
//   3. Floaters: a policy-driven buffer ON TOP of coverage — they exist to absorb breaks,
//      absences, and vacancies while keeping ratios legal. This is the lever §4.8 prices.
//   4. Director: a fixed count, with its own hours (part-time -> full-time).

import { monthlyWage } from './payroll.js';

/**
 * Wage for one seat, including any early-hire premium.
 *
 * Two premium forms, both from §4.8:
 *   - `earlyHirePremium: { count, amount }` — the first N seats in a role get +$amount/hr, held
 *     for as long as the position exists. Predictable, and it's what actually goes in an offer
 *     letter.
 *   - `bufferPremium: { maxAmount, decayAt }` — premium as a function of the coverage buffer,
 *     maximum at zero buffer and decaying to nothing by `decayAt`. This is Jake's reasoning
 *     (pay for fragility) stated as a rule rather than a hardcoded "first two", so it
 *     self-adjusts if the ramp changes.
 *
 * When both are configured the LARGER applies — they express the same intent two ways, and
 * stacking them would double-count the same fragility.
 */
export function seatWage(baseWage, seatIndex, { earlyHirePremium, bufferPremium, bufferRatio } = {}) {
  let premium = 0;

  if (earlyHirePremium && seatIndex < (earlyHirePremium.count ?? 0)) {
    premium = Math.max(premium, earlyHirePremium.amount ?? 0);
  }

  if (bufferPremium && bufferRatio != null) {
    const decayAt = bufferPremium.decayAt ?? 0.5;
    const decayed =
      decayAt <= 0 ? 0 : Math.max(0, 1 - Math.max(0, bufferRatio) / decayAt);
    premium = Math.max(premium, (bufferPremium.maxAmount ?? 0) * decayed);
  }

  return baseWage + premium;
}

/**
 * How many seats of each role a month requires.
 *
 * @param {object} args
 * @param {number} args.coverageHours   weekly ratio-coverage hours from schedule.js
 * @param {number} args.openRoomCount
 * @param {Array} args.roles            each { id, kind, hoursPerWeek, ... }
 * @param {object} args.policy          { leadsPerRoom, floaterPolicy, directorCount }
 * @returns {{byRole, coverageHours, coverageSupplied, coverageShortfall}}
 */
export function roleDemand({
  coverageHours = 0,
  openRoomCount = 0,
  roles = [],
  policy = {},
} = {}) {
  const { leadsPerRoom = 1, directorCount = 1, floaterPolicy = {} } = policy;
  const byKind = (kind) => roles.find((r) => r.kind === kind);

  const lead = byKind('lead');
  const teacher = byKind('teacher');
  const floater = byKind('floater');
  const director = byKind('director');

  const byRole = {};
  let coverageSupplied = 0;

  // 1. Leads — one per open classroom by default. Only rooms that are open need a lead, and
  //    a room with no children still needs none, which falls out of coverageHours being 0.
  if (lead && coverageHours > 0) {
    const count = Math.ceil(leadsPerRoom * openRoomCount);
    byRole[lead.id] = count;
    coverageSupplied += count * (lead.hoursPerWeek ?? 40);
  }

  // 2. Teachers — fill whatever coverage the leads left. Ceil, because you cannot hire 0.3 of a
  //    person; the resulting slack is real slack, and shows up in the coverage buffer.
  if (teacher) {
    const remaining = Math.max(0, coverageHours - coverageSupplied);
    const count = Math.ceil(remaining / (teacher.hoursPerWeek ?? 40));
    byRole[teacher.id] = count;
    coverageSupplied += count * (teacher.hoursPerWeek ?? 40);
  }

  // 3. Floaters — a buffer ON TOP of ratio coverage. Either a flat count, or one per N rooms,
  //    or a fraction of classroom staff, whichever the policy specifies.
  if (floater) {
    const classroomSeats = (byRole[lead?.id] ?? 0) + (byRole[teacher?.id] ?? 0);
    let count = 0;
    if (floaterPolicy.count != null) count = floaterPolicy.count;
    else if (floaterPolicy.perRooms) count = Math.ceil(openRoomCount / floaterPolicy.perRooms);
    else if (floaterPolicy.perClassroomStaff) {
      count = Math.ceil(classroomSeats * floaterPolicy.perClassroomStaff);
    }
    // No floaters before there is anyone to relieve.
    byRole[floater.id] = classroomSeats > 0 ? count : 0;
  }

  // 4. Director — present from before opening (licensing, hiring, enrollment) and not tied to
  //    coverage, which is why it is a flat count rather than derived.
  if (director) byRole[director.id] = directorCount;

  return {
    byRole,
    coverageHours,
    coverageSupplied,
    coverageShortfall: Math.max(0, coverageHours - coverageSupplied),
  };
}

/**
 * Build the month's seats, priced.
 *
 * @param {object} args
 * @param {object} args.demand        byRole counts from roleDemand()
 * @param {Array} args.roles
 * @param {function} args.wageFor     (roleId) -> base hourly wage for this month
 * @param {function} args.hoursFor    (roleId) -> hours/week for this month (director PT -> FT)
 * @param {object} args.premiums      roleId -> { earlyHirePremium?, bufferPremium? }
 * @param {number} args.bufferRatio   coverage buffer, for the derived premium
 */
export function buildSeats({
  demand,
  roles,
  wageFor,
  hoursFor,
  premiums = {},
  bufferRatio = null,
}) {
  const seats = [];
  for (const role of roles) {
    const count = demand.byRole?.[role.id] ?? 0;
    const baseWage = wageFor(role.id);
    const hours = hoursFor(role.id);

    for (let i = 0; i < count; i++) {
      const wage = seatWage(baseWage, i, { ...(premiums[role.id] ?? {}), bufferRatio });
      const monthly = monthlyWage(wage, hours);
      seats.push({
        id: `${role.id}#${i}`,
        roleId: role.id,
        kind: role.kind,
        seatIndex: i,
        baseWage,
        wage,
        premium: wage - baseWage,
        hoursPerWeek: hours,
        monthlyWages: monthly,
        annualWages: monthly * 12,
      });
    }
  }
  return seats;
}

/** Roll seats up per role — for the UI table and for turnover, which is applied per role. */
export function summarizeSeats(seats) {
  const byRole = {};
  let headcount = 0;
  let weeklyHours = 0;
  let monthlyWages = 0;

  for (const s of seats) {
    const r = (byRole[s.roleId] ??= {
      roleId: s.roleId,
      kind: s.kind,
      count: 0,
      weeklyHours: 0,
      monthlyWages: 0,
      averageWage: 0,
      premiumPaid: 0,
    });
    r.count += 1;
    r.weeklyHours += s.hoursPerWeek;
    r.monthlyWages += s.monthlyWages;
    r.premiumPaid += (s.premium * s.hoursPerWeek * 52) / 12;

    headcount += 1;
    weeklyHours += s.hoursPerWeek;
    monthlyWages += s.monthlyWages;
  }

  for (const r of Object.values(byRole)) {
    r.averageWage = r.weeklyHours > 0 ? (r.monthlyWages * 12) / (r.weeklyHours * 52) : 0;
  }

  return {
    byRole,
    headcount,
    weeklyHours,
    monthlyWages,
    fte: weeklyHours / 40,
  };
}
