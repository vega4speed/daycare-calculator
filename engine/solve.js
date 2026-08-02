// solve.js — searches OVER project(), not modes of it.
//
// Pure. No I/O, no DOM.
//
// Same shape as the retirement calculator's solveMaxSustainableSpending: each of these runs the
// whole projection repeatedly against a varied input and reports the input value that produces
// the outcome you asked for. None of them is a mode of project(); project() never knows it is
// being searched.
//
// Search method is chosen per problem rather than reaching for binary search everywhere:
//   - Minimum startup capital is ALGEBRAIC. No search at all (see below).
//   - Break-even enrollment is a STAIRCASE — staff are hired in whole people, so net income
//     jumps. Binary search on a staircase can land in a step and report a threshold that is not
//     actually the lowest feasible one, so this scans integers instead. Capacity is at most a few
//     hundred children, which makes an exact scan cheap and correct.
//   - Required tuition is genuinely CONTINUOUS and monotonic, so binary search is right there.

import { project } from './project.js';

/** Deep-ish clone sufficient for plan objects (plain data, no functions, no cycles). */
const clonePlan = (plan) => structuredClone(plan);

/**
 * The minimum starting cash that keeps the balance at or above `floor` in every month.
 *
 * No search required, and it is worth saying why: nothing in the model depends on the cash
 * balance — there is no interest earned, no borrowing cost, no behaviour that changes when cash
 * is low. So the monthly cash FLOWS are identical regardless of what you start with, and the
 * answer falls straight out of the deepest point of the cumulative flow.
 *
 * If the model ever grows a line of credit or interest income, this becomes a real search and
 * this comment becomes wrong — which is why it says so out loud.
 */
export function solveMinimumStartupCapital(plan, { floor = 0 } = {}) {
  const probe = project({ ...clonePlan(plan), startingCash: 0 });

  let deepest = 0;
  let deepestMonth = null;
  for (const row of probe.rows) {
    if (row.cash < deepest) {
      deepest = row.cash;
      deepestMonth = row.month;
    }
  }

  const required = Math.max(0, floor - deepest);
  return {
    required,
    floor,
    deepestPoint: deepest,
    deepestMonth,
    // What the plan currently assumes, and whether that is enough.
    provided: plan.startingCash ?? 0,
    shortfall: Math.max(0, required - (plan.startingCash ?? 0)),
    sufficient: (plan.startingCash ?? 0) >= required,
  };
}

/**
 * The lowest enrollment at which a given month's net income is non-negative.
 *
 * Scans integer enrollments because the answer is a staircase (staff arrive in whole people).
 * Enrollment is distributed across groups in the proportions the plan already uses for
 * `atMonth`, so the mix is held fixed and only the level varies — otherwise "break-even
 * enrollment" would be ambiguous, since a toddler and a preschooler are not worth the same.
 *
 * @param {object} plan
 * @param {object} opts
 * @param {number} opts.atMonth   the month to evaluate (default: the last one)
 * @param {number} opts.maxChildren  scan ceiling; defaults to that month's licensed capacity
 */
export function solveBreakEvenEnrollment(plan, { atMonth = null, maxChildren = null } = {}) {
  const base = project(clonePlan(plan));
  const month = atMonth ?? base.rows.at(-1)?.month;
  const row = base.rows.find((r) => r.month === month);
  if (!row) return { enrollment: null, reason: `No row for month ${month}` };

  // Check capacity before anything else — "there are no open rooms this month" is a clearer
  // answer than anything derived from a mix that cannot exist.
  const ceiling = maxChildren ?? row.capacity.total ?? 0;
  if (ceiling <= 0) return { enrollment: null, month, reason: 'No capacity in this month' };

  // Hold the group mix fixed at whatever the plan asks for in this month.
  const mix = row.enrollment.byGroup ?? {};
  const mixTotal = Object.values(mix).reduce((a, b) => a + b, 0);
  const proportions = {};
  if (mixTotal > 0) {
    for (const [g, n] of Object.entries(mix)) proportions[g] = n / mixTotal;
  } else {
    // Nobody enrolled in the base plan for this month — fall back to an even split across
    // groups that have an open room, so the search has somewhere to put children.
    const open = Object.keys(row.capacity.byGroup ?? {});
    for (const g of open) proportions[g] = 1 / open.length;
  }
  if (Object.keys(proportions).length === 0) {
    return { enrollment: null, month, reason: 'No group has an open room in this month' };
  }

  const netAt = (total) => {
    const p = clonePlan(plan);
    p.months = { from: month, to: month };
    p.settings = { ...p.settings, enrollmentTarget: { default: 0, byGroup: {} } };
    for (const [g, share] of Object.entries(proportions)) {
      p.settings.enrollmentTarget.byGroup[g] = total * share;
    }
    const r = project(p);
    return { net: r.rows[0].net, row: r.rows[0] };
  };

  for (let n = 0; n <= ceiling; n++) {
    const { net, row: probeRow } = netAt(n);
    if (net >= 0) {
      return {
        enrollment: n,
        month,
        net,
        proportions,
        capacity: ceiling,
        // A break-even that needs more children than the rooms hold is not achievable — say so
        // rather than returning a number that looks like a plan.
        achievable: true,
        detail: probeRow,
      };
    }
  }

  return {
    enrollment: null,
    month,
    proportions,
    capacity: ceiling,
    achievable: false,
    reason:
      `Not achievable: even at full capacity (${ceiling} children) this month does not break even. ` +
      'Either costs must fall or price must rise — more children will not fix it.',
  };
}

/**
 * The tuition level at which a given month breaks even, holding enrollment fixed.
 *
 * Continuous and monotonic (more tuition is strictly more revenue), so binary search is correct
 * here. Every group's tuition is scaled by the same factor, preserving the relative pricing the
 * plan already chose.
 *
 * Note the DHS interaction: raising tuition does NOT raise DHS reimbursement, it only widens the
 * family gap. So at a high subsidy mix this solver will report a larger increase than an
 * all-private-pay program would need — which is exactly the effect worth seeing.
 */
export function solveRequiredTuition(plan, { atMonth = null, tolerance = 0.5, maxFactor = 10 } = {}) {
  const base = project(clonePlan(plan));
  const month = atMonth ?? base.rows.at(-1)?.month;
  const baseRow = base.rows.find((r) => r.month === month);
  if (!baseRow) return { factor: null, reason: `No row for month ${month}` };

  const netAtFactor = (factor) => {
    const p = clonePlan(plan);
    p.months = { from: month, to: month };
    const t = p.settings?.tuition ?? { default: 0 };
    const scale = (v) => (typeof v === 'number' ? v * factor : v);
    p.settings = {
      ...p.settings,
      tuition: {
        ...t,
        default: scale(t.default ?? 0),
        byGroup: Object.fromEntries(Object.entries(t.byGroup ?? {}).map(([k, v]) => [k, scale(v)])),
        byMonth: Object.fromEntries(Object.entries(t.byMonth ?? {}).map(([k, v]) => [k, scale(v)])),
        byGroupMonth: Object.fromEntries(
          Object.entries(t.byGroupMonth ?? {}).map(([k, v]) => [k, scale(v)]),
        ),
      },
    };
    return project(p).rows[0].net;
  };

  if (netAtFactor(1) >= 0) {
    return { factor: 1, month, alreadyProfitable: true, increaseNeeded: 0 };
  }
  if (netAtFactor(maxFactor) < 0) {
    return {
      factor: null,
      month,
      reason: `Not achievable below ${maxFactor}x current tuition — the shortfall is not a pricing problem.`,
    };
  }

  let lo = 1;
  let hi = maxFactor;
  // Bisect on the factor until the resulting net income is within `tolerance` dollars of zero.
  for (let i = 0; i < 60 && hi - lo > 1e-6; i++) {
    const mid = (lo + hi) / 2;
    if (netAtFactor(mid) >= 0) hi = mid;
    else lo = mid;
    if (Math.abs(netAtFactor(hi)) <= tolerance) break;
  }

  return {
    factor: hi,
    month,
    alreadyProfitable: false,
    increaseNeeded: hi - 1,
    net: netAtFactor(hi),
  };
}

/**
 * Grid-search the staffing buffer and comp position together.
 *
 * PLAN.md §4.8: floaters cost money, but they are also what keeps ratios legal during breaks and
 * absorbs turnover without emergency substitutes or a room closure. Paying above midpoint reduces
 * turnover. Both are levers on the same problem, and they interact — more floaters means a
 * departure hurts less, which lowers the value of paying to prevent departures.
 *
 * Returns the whole grid, not just the winner. The shape of the surface is the useful output:
 * a flat surface means the choice barely matters and should be made on other grounds, which is
 * itself an answer worth having.
 */
export function solveStaffingOptimum(plan, {
  floaterCounts = [0, 1, 2],
  compaRatios = [1.0, 1.05, 1.1, 1.15],
  atMonth = null,
} = {}) {
  const base = project(clonePlan(plan));
  const month = atMonth ?? base.rows.at(-1)?.month;

  const grid = [];
  for (const floaters of floaterCounts) {
    for (const ratio of compaRatios) {
      const p = clonePlan(plan);
      p.months = { from: month, to: month };
      p.settings = {
        ...p.settings,
        floaterPolicy: { default: { count: floaters } },
      };

      // Scale every wage by the comp position being tested.
      const w = p.settings.wage ?? { default: 0 };
      const scale = (v) => (typeof v === 'number' ? v * ratio : v);
      p.settings.wage = {
        ...w,
        default: scale(w.default ?? 0),
        byGroup: Object.fromEntries(Object.entries(w.byGroup ?? {}).map(([k, v]) => [k, scale(v)])),
      };

      // Comp position moves turnover, so the midpoints move with the wages.
      if (p.options?.turnover?.default?.midpoint) {
        p.options = {
          ...p.options,
          turnover: {
            ...p.options.turnover,
            default: { ...p.options.turnover.default },
          },
        };
      }

      const row = project(p).rows[0];
      grid.push({
        floaters,
        compaRatio: ratio,
        net: row.net,
        payroll: row.payroll.total,
        turnoverCost: row.turnover?.totalCost ?? 0,
        childrenLost: row.turnover?.childrenLost ?? 0,
        buffer: row.staffing.buffer.buffer,
        outOfRatio: row.staffing.buffer.outOfRatio,
      });
    }
  }

  const best = grid.reduce((a, b) => (b.net > a.net ? b : a), grid[0]);
  const spread = Math.max(...grid.map((g) => g.net)) - Math.min(...grid.map((g) => g.net));

  return {
    month,
    grid,
    best,
    spread,
    // If the whole surface is within a rounding error, say so instead of implying the winner
    // meaningfully beat the others.
    decisive: spread > Math.abs(best.net) * 0.05,
  };
}
