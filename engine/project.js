// project.js — the month loop. Ties every other engine module together and carries cash forward.
//
// Pure. No I/O, no DOM.
//
// ---------------------------------------------------------------------------------------------
// What this produces
// ---------------------------------------------------------------------------------------------
// One row per month from `months.from` (typically -2, pre-open) through `months.to`, each
// carrying enrollment, capacity, staffing, revenue, expenses, net income, and the running cash
// balance. Plus the headline answers: break-even month, lowest cash point, and the total cash the
// sponsor must front before the program funds itself.
//
// Cash balance is this model's equivalent of the retirement calculator's portfolio balance, and
// "does it run out of cash before it turns profitable" is the equivalent of portfolio survival.
//
// ---------------------------------------------------------------------------------------------
// Accrual vs. cash
// ---------------------------------------------------------------------------------------------
// These differ, and the difference is the point. Revenue is EARNED when care is delivered, but
// DHS reimbursement ARRIVES weeks later. During a ramp that lag is a permanent hole in working
// capital, not a one-month timing quirk: every month you grow, the receivable grows with you.
// It is invisible in a P&L and decisive for how much cash the church must put up. So each row
// reports `net` (accrual) and `cashFlow` (what actually moved) separately.

import { resolve } from './resolver.js';
import { allocate, licensedCapacity, staffingRequirement, coverageBuffer, findRatioRule, openRooms, resolveRoomRules } from './capacity.js';
import { staffingForDay } from './schedule.js';
import { computeRevenue } from './revenue.js';
import { computeExpenses, cumulativeEscalator } from './expenses.js';
import { roleDemand, buildSeats, summarizeSeats } from './staffing.js';
import { buildCoveragePlan, shiftsByRole } from './coverage.js';
import { payrollForSeats, FICA_RATE } from './payroll.js';
import { compaRatio, annualTurnoverRate, expectedDepartures, turnoverCosts } from './turnover.js';

/** 365.25 / 12 — used to convert a hire lead expressed in days onto the monthly grid. */
export const DAYS_PER_MONTH = 365.25 / 12;

/** Resolve a setting for a month (and optionally a group), with a fallback. */
const at = (setting, month, groupId, fallback = 0) => {
  const v = resolve(setting, { month, groupId });
  return v === undefined ? fallback : v;
};

/**
 * Split a group's enrollment target across schedule types.
 * `mix` is a map of scheduleTypeId -> weight; weights are normalized, so {full: 3, halfAM: 1}
 * and {full: 0.75, halfAM: 0.25} mean the same thing.
 *
 * Counts are NOT rounded to whole children. Fractional children are meaningless individually but
 * correct in aggregate over a month, and rounding each cell would make group totals disagree with
 * the target you typed — the same reasoning behind reporting `unserved` instead of silently
 * clamping.
 */
export function splitByScheduleMix(target, mix, scheduleTypes) {
  const ids = scheduleTypes.map((s) => s.id);
  const weights = {};
  let total = 0;
  for (const id of ids) {
    const w = Math.max(0, mix?.[id] ?? 0);
    if (w > 0) {
      weights[id] = w;
      total += w;
    }
  }
  // No mix given ⇒ everyone is on the first schedule type (typically full day).
  if (total <= 0) return ids.length ? { [ids[0]]: target } : {};

  const out = {};
  for (const [id, w] of Object.entries(weights)) out[id] = (target * w) / total;
  return out;
}

/**
 * Project a plan month by month.
 *
 * @param {object} plan
 * @param {{from:number, to:number}} plan.months
 * @param {number} plan.startingCash
 * @param {Array} plan.rooms          see capacity.js
 * @param {Array} plan.groups         { id, ratioRule, fringeRatioRule?, dhsBand, dhsBandMix? }
 * @param {Array} plan.scheduleTypes  { id, arriveHour, departHour, daysPerWeek, tuitionMultiplier?, dhsPartTime? }
 * @param {object} plan.settings      resolver settings, all optional:
 *          enrollmentTarget, scheduleMix, tuition, dhsShare, collectionsLoss, hoursOpen,
 *          hoursClose, perChildCost, overheadBase, overheadPerChild, insurance, rent, marketing,
 *          oneTime, payroll, wagePerHour
 * @param {object} plan.tables        { ratios, dhsCertificate }
 * @param {object} plan.options       { dhsLagMonths, gapPolicy, payrollMode, rateOpts,
 *                                      daysOpen, hoursPerFte, employerTaxRate, escalators }
 */
export function project(plan) {
  const {
    months,
    startingCash = 0,
    rooms: rawRooms = [],
    groups = [],
    roles = [],
    scheduleTypes = [],
    settings = {},
    tables = {},
    options = {},
  } = plan;

  // A room may leave its licensing rule unstated and inherit it from its age group. Resolve that
  // once, here, so every downstream module sees a room that names its own rule.
  const rooms = resolveRoomRules(rawRooms, groups);

  const {
    dhsLagMonths = 0,
    gapPolicy = 'charge',
    payrollMode = 'derived',
    rateOpts = {},
    daysOpen = 5,
    hoursPerFte = 40,
    employerTaxRate = 0.0765,
    escalators = {},
  } = options;

  const rows = [];
  let cash = startingCash;

  // DHS earned in month m is received in m + lag; hold the pipeline by absolute month.
  const dhsPipeline = new Map();
  // Everything earned but not yet collected. This is a BALANCE, not a monthly delta — during a
  // ramp it grows every month rather than washing out, which is the whole point.
  let receivable = 0;

  // --- PASS 1: enrollment and coverage ----------------------------------------------------
  // Enrollment and the staff-hours it requires depend only on the plan, never on cash — so they
  // are computed for every month up front. That is what makes HIRE LEAD TIME possible: staffing
  // in month m can look ahead to the enrollment of month m + lead, which a single forward pass
  // could not do. Everything money-related happens in pass 2.
  const pre = [];
  for (let month = months.from; month <= months.to; month++) {
    const targetByGroup = {};
    const enrollmentByGroup = {};
    for (const g of groups) {
      const target = Math.max(0, at(settings.enrollmentTarget, month, g.id, 0));
      targetByGroup[g.id] = target;
      enrollmentByGroup[g.id] = splitByScheduleMix(
        target,
        at(settings.scheduleMix, month, g.id, null),
        scheduleTypes,
      );
    }

    const allocation = allocate(targetByGroup, rooms, tables.ratios, month);
    const capacity = licensedCapacity(rooms, tables.ratios, month);

    // Scale each group's schedule split down to what capacity actually seated, so revenue is
    // billed for children served rather than children wished for.
    const servedByGroup = {};
    for (const g of groups) {
      const target = targetByGroup[g.id];
      const served = allocation.byGroup[g.id] ?? 0;
      const factor = target > 0 ? served / target : 0;
      const split = enrollmentByGroup[g.id];
      servedByGroup[g.id] = Object.fromEntries(
        Object.entries(split).map(([id, n]) => [id, n * factor]),
      );
    }

    const openHour = at(settings.hoursOpen, month, null, 7.5);
    const closeHour = at(settings.hoursClose, month, null, 16.5);

    let weeklyStaffHours = 0;
    let fte = 0;
    let peakAdults = 0;
    const staffingByGroup = {};

    for (const g of groups) {
      const enrolled = servedByGroup[g.id];
      const anyChildren = Object.values(enrolled).some((n) => n > 0);
      if (!anyChildren || !g.ratioRule) continue;

      const s = staffingForDay({
        hours: { openHour, closeHour },
        scheduleTypes,
        enrolledByType: enrolled,
        coreRule: findRatioRule(tables.ratios, g.ratioRule),
        fringeRule: g.fringeRatioRule ? findRatioRule(tables.ratios, g.fringeRatioRule) : null,
        daysOpen,
        hoursPerFte,
      });
      staffingByGroup[g.id] = s;
      weeklyStaffHours += s.weeklyStaffHours;
      fte += s.fte;
      peakAdults += s.peakAdults;
    }

    // Per-ROOM coverage. Ratios apply to a group in a room, not to a building, so pooling an
    // age group across rooms understates staffing (see coverage.js). This is also what makes
    // "who covers which class" answerable at all.
    const groupById = new Map(groups.map((g) => [g.id, g]));
    const coverage = buildCoveragePlan({
      rooms: openRooms(rooms, month),
      childrenByRoom: allocation.byRoom,
      enrolledByTypeFor: (room, children) =>
        splitByScheduleMix(children, at(settings.scheduleMix, month, room.group, null), scheduleTypes),
      fringeRuleFor: (room) => groupById.get(room.group)?.fringeRatioRule ?? null,
      hours: { openHour, closeHour },
      scheduleTypes,
      ratios: tables.ratios,
      daysOpen,
      shiftOpts: {
        fullTimeHours: at(settings.fullTimeHours, month, null, hoursPerFte),
        allowPartTime: at(settings.allowPartTime, month, null, true),
        minShiftHours: at(settings.minShiftHours, month, null, 10),
      },
    });

    pre.push({
      month,
      allocation,
      capacity,
      servedByGroup,
      coverage,
      weeklyStaffHours,
      fte,
      peakAdults,
      staffingByGroup,
      openRoomCount: openRooms(rooms, month).length,
      // The point-in-time ratio requirement, for comparison against the schedule-aware figure.
      requirement: staffingRequirement(allocation, rooms, tables.ratios),
    });
  }

  /**
   * Peak of a field over the hiring lookahead window. Staff are hired before the enrollment that
   * justifies them, so month m must be staffed for the busiest month in [m, m + lead] — the
   * business plan names "hiring too early" as a top risk, which makes this an explicit lever
   * rather than something buried in an assumption.
   */
  const lookahead = (index, field, leadMonths) => {
    let peak = pre[index][field];
    for (let k = 1; k <= leadMonths && index + k < pre.length; k++) {
      peak = Math.max(peak, pre[index + k][field]);
    }
    return peak;
  };

  // --- PASS 2: money -----------------------------------------------------------------------
  for (let i = 0; i < pre.length; i++) {
    const {
      month, allocation, capacity, servedByGroup, weeklyStaffHours, fte, peakAdults,
      staffingByGroup, openRoomCount: roomsOpenNow, requirement, coverage,
    } = pre[i];
    const monthsElapsed = month - months.from;
    const childrenServed = allocation.served;

    /**
     * Hire lead time, per role, in DAYS.
     *
     * Days rather than months because that is how hiring is actually planned — "post the job six
     * weeks out" — and because roles differ: a director is recruited months ahead, a floater in
     * a fortnight. Resolved per role (`byGroup` keyed on roleId) and per month, like everything
     * else.
     *
     * A lead shorter than a month is a PARTIAL month of overlap, not a whole one. 20 days of
     * lead means the incoming person is on payroll for about two thirds of the preceding month,
     * so that seat is prorated rather than counted whole. Rounding a 20-day lead up to a full
     * month would overstate payroll by a third of a salary in every month the plan grows.
     */
    const leadDaysFor = (roleId) => {
      const days = at(settings.hireLeadDays, month, roleId, null);
      if (days != null) return Math.max(0, days);
      // Back-compat with plans saved before leads were expressed in days.
      return Math.max(0, at(settings.hireLeadMonths, month, roleId, 0)) * DAYS_PER_MONTH;
    };

    const policy = {
      leadsPerRoom: at(settings.leadsPerRoom, month, null, 1),
      directorCount: at(settings.directorCount, month, null, 1),
      floaterPolicy: at(settings.floaterPolicy, month, null, {}),
    };

    /** Whole-count demand for one role at a given whole-month lookahead. */
    const demandAt = (roleId, monthsOut) =>
      roleDemand({
        coverageHours: lookahead(i, 'weeklyStaffHours', monthsOut),
        openRoomCount: lookahead(i, 'openRoomCount', monthsOut),
        roles,
        policy,
      }).byRole[roleId] ?? 0;

    /**
     * This role's staffing for this month: whole seats, plus any seats brought forward for only
     * part of the month by a sub-month lead.
     */
    const specFor = (roleId) => {
      const monthsAhead = leadDaysFor(roleId) / DAYS_PER_MONTH;
      const full = Math.floor(monthsAhead);
      const fraction = monthsAhead - full;
      const count = demandAt(roleId, full);
      if (fraction <= 0) return { count, partial: 0, fraction: 0 };
      const next = demandAt(roleId, full + 1);
      return { count, partial: Math.max(0, next - count), fraction };
    };

    // Reported for the row: the lead the longest-lead role is working to, and the coverage the
    // whole team is staffed against, so "we are ahead of enrollment" stays visible.
    const maxLeadDays = roles.length ? Math.max(...roles.map((r) => leadDaysFor(r.id))) : 0;
    const staffedCoverageHours = lookahead(
      i, 'weeklyStaffHours', Math.floor(maxLeadDays / DAYS_PER_MONTH),
    );

    // --- payroll --------------------------------------------------------------------
    // Three modes, all producing the same row shape:
    //   'roles'   real per-role seats with early-hire premiums — the Phase 3 model
    //   'derived' staff-hours x one blended wage — no roles, no director, no buffer
    //   'setting' a typed monthly figure
    const wageEscalator = cumulativeEscalator(escalators.wage ?? 0, monthsElapsed);

    let seats = [];
    let seatSummary = null;
    let demand = null;
    let payrollDetail = null;

    if (payrollMode === 'roles') {
      // Classroom roles come from the COVERAGE PLAN: real shifts, per room, with their own
      // hours. Floaters and the director are not classroom coverage, so they keep the
      // policy-driven counts and their own hire-lead lookahead.
      const leadRole = roles.find((r) => r.kind === 'lead');
      const teacherRole = roles.find((r) => r.kind === 'teacher');

      // Hire lead pulls the plan of a LATER month forward — staff in place before the children.
      const planFor = (roleId) => {
        const monthsAhead = leadDaysFor(roleId) / DAYS_PER_MONTH;
        const full = Math.floor(monthsAhead);
        const fraction = monthsAhead - full;
        const here = pre[Math.min(i + full, pre.length - 1)].coverage;
        const later = pre[Math.min(i + full + 1, pre.length - 1)].coverage;
        return { here: shiftsByRole(here), later: shiftsByRole(later), fraction };
      };

      const classroomShifts = (role) => {
        if (!role) return null;
        const { here, later, fraction } = planFor(role.id);
        const now = here[role.kind] ?? [];
        const next = later[role.kind] ?? [];
        const out = now.map((sh) => ({ ...sh, monthFraction: 1 }));
        // Anything the later plan adds is brought forward for its share of this month.
        if (fraction > 0 && next.length > now.length) {
          for (const sh of next.slice(now.length)) out.push({ ...sh, monthFraction: fraction });
        }
        return { shifts: out };
      };

      const byRole = {};
      if (leadRole) byRole[leadRole.id] = classroomShifts(leadRole);
      if (teacherRole) byRole[teacherRole.id] = classroomShifts(teacherRole);
      for (const role of roles) {
        if (role.kind === 'lead' || role.kind === 'teacher') continue;
        byRole[role.id] = specFor(role.id);
      }
      demand = { byRole, coverage, coverageHours: weeklyStaffHours, staffedCoverageHours, maxLeadDays };

      // The coverage buffer at this point drives the derived (fragility) premium. Seats are not
      // priced yet, so use the ratio requirement as the reference — the same measure §4.8 keys on.
      const preliminaryBuffer = coverageBuffer(Math.ceil(fte), requirement);

      seats = buildSeats({
        demand,
        roles,
        wageFor: (roleId) => at(settings.wage, month, roleId, 0) * wageEscalator,
        hoursFor: (roleId) =>
          at(settings.roleHours, month, roleId,
            roles.find((r) => r.id === roleId)?.hoursPerWeek ?? 40),
        premiums: options.premiums ?? {},
        bufferRatio: preliminaryBuffer.bufferRatio,
      });
      seatSummary = summarizeSeats(seats);
      payrollDetail = payrollForSeats(seats, options.taxes ?? { ficaRate: employerTaxRate });
    } else {
      const grossWages =
        payrollMode === 'derived'
          ? (staffedCoverageHours * at(settings.wagePerHour, month, null, 0) * wageEscalator * 52) / 12
          : at(settings.payroll, month, null, 0) * wageEscalator;
      const employerTax = grossWages * employerTaxRate;
      payrollDetail = {
        grossWages,
        fica: employerTax,
        futa: 0,
        suta: 0,
        employerTax,
        total: grossWages + employerTax,
        loadFactor: grossWages > 0 ? (grossWages + employerTax) / grossWages : 1,
      };
    }

    const payroll = payrollDetail.total;

    // --- revenue --------------------------------------------------------------------
    const revenue = computeRevenue({
      enrollment: servedByGroup,
      scheduleTypes,
      groups,
      tuitionFor: (id) => at(settings.tuition, month, id, 0),
      dhsShareFor: (id) => at(settings.dhsShare, month, id, 0),
      dhsTables: tables.dhsCertificate,
      rateOpts,
      collectionsLoss: at(settings.collectionsLoss, month, null, 0),
      gapPolicy,
    });

    // --- attrition ------------------------------------------------------------------
    // Enrollment is entered as an absolute target (PLAN.md §4.2), so attrition does NOT reduce
    // it — the target already is what you expect to have. What attrition tells you is how hard
    // you have to work to hold that number: at 3%/mo churn, a 36-child program must enroll
    // roughly one new family every month just to stand still.
    //
    // Reported rather than applied, because it is a marketing and waitlist question, not a
    // revenue adjustment. Silently shrinking a number the user typed is the thing this model
    // deliberately does not do.
    const attritionRate = Math.max(0, at(settings.attrition, month, null, 0));
    const departuresExpected = childrenServed * attritionRate;
    const growth = i > 0 ? childrenServed - pre[i - 1].allocation.served : childrenServed;
    const acquisitionCost = at(settings.acquisitionCost, month, null, 0);
    const attrition = {
      rate: attritionRate,
      departuresExpected,
      // To hold the line AND grow: replace the leavers, then add the increase.
      newEnrollmentsNeeded: departuresExpected + Math.max(0, growth),
      acquisitionCost: (departuresExpected + Math.max(0, growth)) * acquisitionCost,
    };

    // --- turnover -------------------------------------------------------------------
    // Computed after revenue because the enrollment-loss cost needs revenue per child, and
    // before expenses because it lands as an expense line.
    //
    // DOCUMENTED SIMPLIFICATION: lost enrollment is charged as a revenue-EQUIVALENT cost rather
    // than fed back into next month's enrollment. A feedback loop would be more realistic and
    // considerably harder to reason about, and the dollar effect is the same in the month it
    // occurs. The children-lost figure is reported so the size of the effect stays visible.
    let turnover = null;
    if (options.turnover && seatSummary) {
      const cfg = options.turnover;
      const byRole = {};
      let totalCost = 0;
      let departures = 0;
      let childrenLost = 0;

      for (const role of roles) {
        const summary = seatSummary.byRole[role.id];
        if (!summary || summary.count === 0) continue;

        const params = cfg.byRole?.[role.id] ?? cfg.default ?? {};
        const ratio = compaRatio(summary.averageWage, params.midpoint);
        const annual = annualTurnoverRate(params, ratio ?? 1);
        const departed = expectedDepartures(summary.count, annual);

        const costs = turnoverCosts({
          ...params,
          departures: departed,
          weeklyWage: summary.averageWage * (summary.weeklyHours / summary.count),
          revenuePerChild: revenue.revenuePerChild,
        });

        byRole[role.id] = { compaRatio: ratio, annualRate: annual, ...costs };
        totalCost += costs.totalCost;
        departures += departed;
        childrenLost += costs.childrenLost;
      }

      turnover = { byRole, departures, childrenLost, totalCost };
    }

    // --- expenses -------------------------------------------------------------------
    const expenses = computeExpenses({
      children: childrenServed,
      monthsElapsed,
      perChild: at(settings.perChildCost, month, null, 0),
      overhead: {
        base: at(settings.overheadBase, month, null, 0),
        perChild: at(settings.overheadPerChild, month, null, 0),
      },
      insurance: at(settings.insurance, month, null, 0),
      rent: at(settings.rent, month, null, 0),
      marketing: at(settings.marketing, month, null, 0),
      oneTime: at(settings.oneTime, month, null, 0),
      payroll,
      escalators,
      other: {
        ...(turnover ? { turnover: turnover.totalCost } : {}),
        ...(attrition.acquisitionCost > 0 ? { acquisition: attrition.acquisitionCost } : {}),
      },
    });

    // --- cash -----------------------------------------------------------------------
    dhsPipeline.set(month + dhsLagMonths, (dhsPipeline.get(month + dhsLagMonths) ?? 0) + revenue.fromDhs);
    const dhsReceived = dhsPipeline.get(month) ?? 0;
    const receipts = revenue.fromFamilies + dhsReceived;

    const net = revenue.revenue - expenses.total;
    const cashFlow = receipts - expenses.total;
    const openingCash = cash;
    cash += cashFlow;
    receivable += revenue.fromDhs - dhsReceived;

    rows.push({
      month,
      monthsElapsed,
      enrollment: {
        target: allocation.target,
        served: childrenServed,
        unserved: allocation.unserved,
        unservedByGroup: allocation.unservedByGroup,
        byGroup: allocation.byGroup,
        byRoom: allocation.byRoom,
        byScheduleType: servedByGroup,
      },
      capacity,
      staffing: {
        weeklyStaffHours,
        fte,
        peakAdults,
        byGroup: staffingByGroup,
        ratioRequirement: requirement.total,
        // The gap PLAN.md §4.9 is about: employees needed per adult on the floor.
        ftePerPeakAdult: peakAdults > 0 ? fte / peakAdults : 0,
        buffer: coverageBuffer(Math.ceil(fte), requirement),
        demand,
        coverage,
        seats: seatSummary,
        headcount: seatSummary?.headcount ?? null,
        maxLeadDays,
        // Coverage actually staffed for, which exceeds this month's own need when hiring ahead.
        staffedCoverageHours,
        hiringAhead: staffedCoverageHours > weeklyStaffHours,
      },
      attrition,
      payroll: payrollDetail,
      turnover,
      revenue,
      expenses,
      net,
      cashFlow,
      openingCash,
      cash,
      // Earned but not yet collected — the working capital the DHS lag ties up.
      receivable,
      receivableChange: revenue.revenue - receipts,
    });
  }

  return { rows, ...summarize(rows, startingCash) };
}

/** Headline answers derived from the rows. */
export function summarize(rows, startingCash = 0) {
  const operating = rows.filter((r) => r.month >= 0);

  const firstProfitableMonth = operating.find((r) => r.net > 0)?.month ?? null;
  // Sustained profitability: the first month after which it never goes negative again. More
  // honest than the first positive month, which a single good month can trigger.
  let sustainedFrom = null;
  for (let i = operating.length - 1; i >= 0; i--) {
    if (operating[i].net > 0) sustainedFrom = operating[i].month;
    else break;
  }

  const lowest = rows.reduce(
    (min, r) => (min === null || r.cash < min.cash ? r : min),
    null,
  );

  // Half a cent of tolerance. Without it, a plan funded to EXACTLY the solved minimum reports
  // running out of cash, because the accumulated floating-point error on a long chain of monthly
  // flows lands a hair below zero. Found by solve.js asserting that its own answer is sufficient.
  const CASH_EPSILON = 0.005;
  const everNegative = rows.some((r) => r.cash < -CASH_EPSILON);

  return {
    firstProfitableMonth,
    sustainedProfitableFrom: sustainedFrom,
    lowestCash: lowest ? lowest.cash : startingCash,
    lowestCashMonth: lowest ? lowest.month : null,
    // How much MORE cash than was put in would have been needed to never go negative.
    additionalCashNeeded: lowest && lowest.cash < 0 ? -lowest.cash : 0,
    totalCashRequired: lowest ? startingCash + Math.max(0, -lowest.cash) : startingCash,
    runsOutOfCash: everNegative,
    endingCash: rows.length ? rows[rows.length - 1].cash : startingCash,
    peakReceivable: rows.reduce((max, r) => Math.max(max, r.receivable), 0),
  };
}
