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
import { allocate, licensedCapacity, staffingRequirement, coverageBuffer, findRatioRule } from './capacity.js';
import { staffingForDay } from './schedule.js';
import { computeRevenue } from './revenue.js';
import { computeExpenses, cumulativeEscalator } from './expenses.js';

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
    rooms = [],
    groups = [],
    scheduleTypes = [],
    settings = {},
    tables = {},
    options = {},
  } = plan;

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

  for (let month = months.from; month <= months.to; month++) {
    const monthsElapsed = month - months.from;

    // --- enrollment -----------------------------------------------------------------
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

    const childrenServed = allocation.served;

    // --- staffing -------------------------------------------------------------------
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

    // The point-in-time ratio requirement, for comparison against the schedule-aware figure.
    const requirement = staffingRequirement(allocation, rooms, tables.ratios);

    // --- payroll --------------------------------------------------------------------
    // 'derived' turns staff-hours into dollars, so payroll automatically reflects operating
    // hours and occupancy (PLAN.md §4.9). 'setting' takes a typed monthly figure instead.
    // Phase 3 replaces both with real per-seat wages; the row shape does not change.
    const wagePerHour = at(settings.wagePerHour, month, null, 0);
    const wageEscalator = cumulativeEscalator(escalators.wage ?? 0, monthsElapsed);
    const grossWages =
      payrollMode === 'derived'
        ? (weeklyStaffHours * wagePerHour * wageEscalator * 52) / 12
        : at(settings.payroll, month, null, 0) * wageEscalator;

    // Employer payroll taxes, which the business plan's own figures exclude (PLAN.md §4.8).
    const employerTax = grossWages * employerTaxRate;
    const payroll = grossWages + employerTax;

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
      },
      payroll: { grossWages, employerTax, total: payroll },
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

  const everNegative = rows.some((r) => r.cash < 0);

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
