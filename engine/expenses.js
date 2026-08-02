// expenses.js — the cost lines, and how they scale.
//
// Pure. No I/O, no DOM.
//
// ---------------------------------------------------------------------------------------------
// How costs scale
// ---------------------------------------------------------------------------------------------
// The business plan's own figures reveal the shape, and it is worth keeping the categories
// distinct rather than lumping them into one monthly number:
//
//   PER-CHILD    supplies: $1,680 at 14 children and $4,320 at 36 — exactly $120/child/mo in
//                both cases. Cleanly linear, so model it that way.
//   SEMI-FIXED   overhead: $2,500 at 14 children, $3,000 at 36. Neither flat nor proportional —
//                a base plus a small per-child component.
//   FIXED        insurance, rent, licensing. Independent of enrollment.
//   ONE-TIME     licensing fees, signage, the insurance binder. These are just month SPIKES on
//                the existing resolver ("-2": 879), so they need no special machinery here.
//
// Escalation runs on separate compounding tracks, the same pattern the retirement calculator uses
// for general inflation vs. medical inflation: insurance in this sector has not tracked CPI, and
// wages are their own problem entirely (see staffing.js).
//
// Payroll is NOT computed here. It comes from seats and schedules (staffing.js + schedule.js) and
// is passed into the month loop, because it depends on ratios and operating hours rather than on
// a cost curve.

/**
 * Compound an escalator over `periods` months.
 * Rates are given as ANNUAL fractions (0.03 = 3%/yr) and compounded monthly, so a mid-year
 * month gets a partial year of escalation rather than a step change every twelve months.
 */
export function cumulativeEscalator(annualRate, months) {
  if (!annualRate) return 1;
  return Math.pow(1 + annualRate, months / 12);
}

/**
 * A semi-fixed line: a base amount plus a per-child amount.
 *
 * Fitting the plan's overhead ($2,500 at 14 children, $3,000 at 36) gives base $2,182 and
 * $22.73/child. `fitSemiFixed` below does that fit, so the UI can offer "derive from two
 * observations" instead of asking the user to solve a line by hand.
 */
export function semiFixed({ base = 0, perChild = 0 }, children) {
  return base + perChild * Math.max(0, children ?? 0);
}

/**
 * Solve a semi-fixed line from two (children, cost) observations.
 * @returns {{base:number, perChild:number}}
 */
export function fitSemiFixed(a, b) {
  const [x1, y1] = a;
  const [x2, y2] = b;
  if (x1 === x2) throw new Error('fitSemiFixed needs two different enrollment levels');
  const perChild = (y2 - y1) / (x2 - x1);
  return { base: y1 - perChild * x1, perChild };
}

/**
 * Expenses for one month.
 *
 * Every amount is in TODAY's dollars and escalated here, so the caller supplies plan assumptions
 * rather than pre-inflated figures.
 *
 * @param {object} args
 * @param {number} args.children         enrolled (or served) children this month
 * @param {number} args.monthsElapsed    months since the plan's base date, for escalation
 * @param {number} args.perChild         e.g. supplies, $/child/mo
 * @param {{base:number, perChild:number}} args.overhead  semi-fixed
 * @param {number} args.insurance        $/mo
 * @param {number} args.rent             $/mo — explicitly modeled even when the church absorbs it
 * @param {number} args.marketing        $/mo ongoing
 * @param {number} args.oneTime          resolved from month spikes by the caller
 * @param {number} args.payroll          from staffing.js — already includes employer taxes
 * @param {object} args.escalators       { general, insurance } annual rates
 * @param {Object<string,number>} args.other  any additional named lines, escalated at `general`
 */
export function computeExpenses({
  children = 0,
  monthsElapsed = 0,
  perChild = 0,
  overhead = { base: 0, perChild: 0 },
  insurance = 0,
  rent = 0,
  marketing = 0,
  oneTime = 0,
  payroll = 0,
  escalators = {},
  other = {},
} = {}) {
  const gen = cumulativeEscalator(escalators.general ?? 0, monthsElapsed);
  const ins = cumulativeEscalator(escalators.insurance ?? escalators.general ?? 0, monthsElapsed);

  const lines = {
    payroll, // already nominal — staffing.js escalates wages on its own track
    supplies: perChild * Math.max(0, children) * gen,
    overhead: semiFixed(overhead, children) * gen,
    insurance: insurance * ins,
    rent: rent * gen,
    marketing: marketing * gen,
    oneTime, // spikes are entered as the actual dollars of that month, not escalated
  };

  for (const [name, amount] of Object.entries(other)) {
    lines[name] = (amount ?? 0) * gen;
  }

  const total = Object.values(lines).reduce((a, b) => a + b, 0);

  return {
    lines,
    total,
    // Cost per child is the number that tells you whether scale is working. Guard the empty case
    // rather than reporting Infinity.
    perChildCost: children > 0 ? total / children : null,
    fixedPortion: total - lines.supplies,
  };
}
