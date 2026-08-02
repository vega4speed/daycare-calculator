// turnover.js — compensation position, turnover, and what turnover costs.
//
// Pure. No I/O, no DOM.
//
// ---------------------------------------------------------------------------------------------
// READ THIS BEFORE TRUSTING A NUMBER OUT OF THIS MODULE
// ---------------------------------------------------------------------------------------------
// The strategic premise (PLAN.md §4.8) is to pay above the midpoint of the market range to reduce
// turnover. Modeling that requires a relationship between comp position and turnover rate.
//
// **No credible published elasticity exists for this.** That childcare turnover is high, and that
// low wages drive it, are both well documented. "One percent above midpoint buys X% less
// turnover" is not, and this module does not pretend otherwise. `sensitivity` is a USER
// ASSUMPTION with a labeled default, not a researched constant.
//
// So the honest use of this module is inverted. Rather than "here is what the raise saves,"
// ask: **how strong would the relationship have to be for the raise to pay for itself?** That is
// a question the model can answer rigorously, and it tells you what you would have to believe
// instead of telling you what to believe. `breakEvenSensitivity()` at the bottom computes it.
//
// ---------------------------------------------------------------------------------------------
// Why turnover is a REVENUE problem, not a payroll problem
// ---------------------------------------------------------------------------------------------
// Four costs follow a departure, and the fourth dominates:
//   1. Vacancy coverage — NOT optional. Ratios are a licensing requirement, so an empty seat is
//      covered by a substitute, overtime, or a floater, or the room closes. Running short is not
//      a legal option.
//   2. Recruiting — advertising, TN-required background checks, onboarding admin.
//   3. Ramp — a new hire is not immediately at full effectiveness.
//   4. Enrollment loss — families leave when their child's teacher leaves. This is what turns
//      turnover from a payroll line into a revenue line, and it is where the payoff for paying
//      above midpoint actually comes from.

/**
 * Compa-ratio: paid wage over the market midpoint. Jake's "over mid" is a compa-ratio above 1.0.
 * Returns null when there is no midpoint to compare against, rather than a misleading 0 or 1.
 */
export function compaRatio(paidWage, midpoint) {
  if (!midpoint || midpoint <= 0) return null;
  return paidWage / midpoint;
}

/** Where a wage sits in a min..max range, 0..1. Useful for the UI; not used by the rate model. */
export function rangePenetration(paidWage, { min, max }) {
  if (min == null || max == null || max <= min) return null;
  return Math.min(1, Math.max(0, (paidWage - min) / (max - min)));
}

/**
 * Annual turnover as a function of comp position.
 *
 *   annual = clamp(baseAtMid * (1 - sensitivity * (compaRatio - 1)), floor, ceiling)
 *
 * Linear rather than exponential, deliberately: it is legible ("10% above mid cuts turnover by
 * `sensitivity` × 10%"), and given that the parameter is a guess anyway, a more elaborate curve
 * would add false sophistication rather than accuracy. The floor keeps it honest — some turnover
 * is unavoidable at any wage, and a model that lets turnover reach zero would make arbitrarily
 * large raises look arbitrarily good.
 *
 * @param {object} params
 * @param {number} params.baseAtMid    annual turnover when paid exactly at midpoint
 * @param {number} params.sensitivity  ASSUMPTION — see the module header
 * @param {number} params.floor        the turnover no wage can eliminate
 * @param {number} params.ceiling
 */
export function annualTurnoverRate(
  { baseAtMid = 0.35, sensitivity = 1.5, floor = 0.10, ceiling = 1.0 } = {},
  ratio = 1,
) {
  const r = ratio == null ? 1 : ratio;
  const raw = baseAtMid * (1 - sensitivity * (r - 1));
  return Math.min(ceiling, Math.max(floor, raw));
}

/**
 * Convert an annual turnover rate to the equivalent monthly rate.
 * Compounding, not division: a 36%/yr rate is not 3%/mo, because survivors compound.
 */
export function monthlyTurnoverRate(annualRate) {
  const a = Math.min(0.999999, Math.max(0, annualRate ?? 0));
  return 1 - Math.pow(1 - a, 1 / 12);
}

/**
 * Expected departures in a month. Deterministic (expected value), not simulated.
 *
 * A financial model should be reproducible, and simulating individual quits would add variance
 * without adding information — the fractional figure is the right answer for a monthly cost line
 * even though no one ever quits 0.4 of a job.
 */
export function expectedDepartures(headcount, annualRate) {
  return Math.max(0, headcount ?? 0) * monthlyTurnoverRate(annualRate);
}

/**
 * What those departures cost.
 *
 * @param {object} args
 * @param {number} args.departures            expected departures this month
 * @param {number} args.recruitingCost        per hire: ads, background checks, admin
 * @param {number} args.onboardingCost        per hire: training, paperwork, orientation
 * @param {number} args.vacancyWeeks          how long a seat sits empty before it is filled
 * @param {number} args.coverageCostPerWeek   substitute/overtime cost to hold ratio meanwhile
 * @param {number} args.rampWeeks             weeks at reduced effectiveness after hire
 * @param {number} args.rampProductivity      effectiveness during ramp, 0..1
 * @param {number} args.weeklyWage            the seat's weekly wage, for the ramp cost
 * @param {number} args.enrollmentLossProb    probability a departure costs enrollment
 * @param {number} args.childrenLostPerEvent  children lost when it does
 * @param {number} args.revenuePerChild       monthly revenue per child
 * @param {number} args.monthsToRefill        how long a lost child's seat stays empty
 */
export function turnoverCosts({
  departures = 0,
  recruitingCost = 0,
  onboardingCost = 0,
  vacancyWeeks = 0,
  coverageCostPerWeek = 0,
  rampWeeks = 0,
  rampProductivity = 1,
  weeklyWage = 0,
  enrollmentLossProb = 0,
  childrenLostPerEvent = 0,
  revenuePerChild = 0,
  monthsToRefill = 1,
} = {}) {
  const d = Math.max(0, departures);

  const recruiting = d * recruitingCost;
  const onboarding = d * onboardingCost;
  // Vacancy coverage is mandatory, not discretionary — see the module header.
  const vacancy = d * vacancyWeeks * coverageCostPerWeek;
  // Ramp: you pay a full wage for partial effectiveness.
  const ramp = d * rampWeeks * weeklyWage * (1 - Math.min(1, Math.max(0, rampProductivity)));

  const childrenLost = d * enrollmentLossProb * childrenLostPerEvent;
  const revenueLost = childrenLost * revenuePerChild * monthsToRefill;

  return {
    departures: d,
    recruiting,
    onboarding,
    vacancy,
    ramp,
    directCost: recruiting + onboarding + vacancy + ramp,
    childrenLost,
    revenueLost,
    // The number that actually matters: payroll-side cost plus foregone revenue.
    totalCost: recruiting + onboarding + vacancy + ramp + revenueLost,
  };
}

/**
 * The inverted question, and the honest way to use this module.
 *
 * Given a raise from `fromWage` to `toWage`, how sensitive would turnover have to be to comp
 * position for the raise to pay for itself?
 *
 * Returns the `sensitivity` at which annual raise cost equals annual turnover savings. Compare it
 * to what you believe: if the answer is 0.3, the raise is easy to justify; if it is 8, it is not.
 *
 * @returns {{required:number|null, annualRaiseCost:number, note:string}}
 */
export function breakEvenSensitivity({
  headcount,
  fromWage,
  toWage,
  midpoint,
  hoursPerWeek = 40,
  loadFactor = 1.0765,
  turnoverParams = {},
  costPerDeparture = 0,
}) {
  const n = Math.max(0, headcount ?? 0);
  const annualRaiseCost = n * (toWage - fromWage) * hoursPerWeek * 52 * loadFactor;

  const fromRatio = compaRatio(fromWage, midpoint);
  const toRatio = compaRatio(toWage, midpoint);
  if (fromRatio == null || toRatio == null || toRatio === fromRatio || costPerDeparture <= 0) {
    return {
      required: null,
      annualRaiseCost,
      note: 'Needs a market midpoint, a wage change, and a cost per departure.',
    };
  }

  // Departures saved per unit of sensitivity, ignoring the floor/ceiling clamp:
  //   rate(s) = base * (1 - s * (ratio - 1))
  //   saved   = n * base * s * (toRatio - fromRatio)
  // Solve n * base * s * delta * costPerDeparture = annualRaiseCost.
  const base = turnoverParams.baseAtMid ?? 0.35;
  const delta = toRatio - fromRatio;
  const savingsPerSensitivity = n * base * delta * costPerDeparture;

  if (savingsPerSensitivity <= 0) {
    return { required: null, annualRaiseCost, note: 'A pay cut cannot pay for itself this way.' };
  }

  return {
    required: annualRaiseCost / savingsPerSensitivity,
    annualRaiseCost,
    note:
      'Sensitivity at which the raise breaks even. Compare against what you actually believe — ' +
      'the clamp at the turnover floor is ignored, so treat this as a lower bound on what is required.',
  };
}

/**
 * The same question in dollars, which is easier to judge than a unitless sensitivity.
 *
 * There is a small algebraic surprise worth knowing here. Writing out breakEvenSensitivity:
 *
 *   raiseCost = n · Δw · hours · 52 · load
 *   savings   = n · base · sensitivity · (Δw / midpoint) · costPerDeparture
 *
 * Both Δw and n cancel. **Whether an above-midpoint raise pays for itself does not depend on how
 * big the raise is, or on how many people get it** — a larger raise costs proportionally more AND
 * moves compa-ratio proportionally further. What remains is:
 *
 *   costPerDeparture = (hours · 52 · load · midpoint) / (base · sensitivity)
 *
 * That is the cost a single departure would have to carry for the raise to break even on turnover
 * savings alone. At Jake's numbers — an $18 midpoint, 40 hours, 35% baseline turnover, and a
 * generous sensitivity of 1.5 — it comes to roughly **$77,000 per departure**, far above typical
 * direct replacement cost.
 *
 * The honest conclusion is that **paying above midpoint probably cannot be justified on turnover
 * cost savings alone**, and the real case for it lies elsewhere: at lean staffing a single
 * departure can put the program out of ratio and force a room to close, which is a licensing
 * event rather than an incremental cost. That is a fragility argument, not an expected-value one —
 * which is exactly why the early-hire premium is keyed to the coverage buffer (staffing.js).
 */
export function requiredCostPerDeparture({
  midpoint,
  hoursPerWeek = 40,
  loadFactor = 1.0765,
  sensitivity = 1.5,
  turnoverParams = {},
}) {
  const base = turnoverParams.baseAtMid ?? 0.35;
  if (!midpoint || base <= 0 || sensitivity <= 0) return null;
  return (hoursPerWeek * 52 * loadFactor * midpoint) / (base * sensitivity);
}
