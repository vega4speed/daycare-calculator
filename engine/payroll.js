// payroll.js — wages to total employer cost.
//
// Pure. No I/O, no DOM.
//
// ---------------------------------------------------------------------------------------------
// Why this is its own module
// ---------------------------------------------------------------------------------------------
// The business plan's payroll figures are gross wages and exclude the employer's share entirely
// (PLAN.md §4.8 — Jake's per-role rates reproduce both $9,300 and $22,000 as gross). Employer
// FICA alone is ~$680/mo at launch, about a third of the stated launch net income. Burying that
// in a wage number is exactly how it went missing in the first place, so it is computed here and
// reported as its own line.
//
// ---------------------------------------------------------------------------------------------
// A caveat that matters for THIS employer
// ---------------------------------------------------------------------------------------------
// This is a church-operated program, and nonprofit/church status materially changes unemployment
// tax:
//   - FICA (Social Security + Medicare) applies normally to employees of a church-operated
//     childcare program. This is the solid default and it is on by default.
//   - FUTA: 501(c)(3) organizations are exempt from federal unemployment tax, and services
//     performed for a church are generally excluded as well.
//   - State unemployment: nonprofits may often elect REIMBURSABLE status — paying actual claims
//     rather than a payroll-tax rate — and church employment may be excluded from coverage
//     entirely.
//
// Whether this specific program's employees are covered is a real legal question that depends on
// how the childcare operation is organized relative to the church, and it is NOT something this
// model should answer. So `futaRate` and `sutaRate` default to 0 with `exemptFuta`/`exemptSuta`
// documented, and the UI should carry a visible "confirm with your accountant" note. Defaulting
// them ON would silently overstate costs; defaulting them OFF understates them if the program is
// covered. Zero-plus-a-loud-note is the honest choice, because it cannot be mistaken for a
// researched answer.
//
// KNOWN SIMPLIFICATIONS: the Social Security wage base cap (~$176k) is not modeled — no role here
// approaches it. Additional Medicare Tax (0.9% above $200k) likewise. Unemployment wage bases are
// applied to each seat's ANNUAL wages and spread evenly across twelve months; real FUTA/SUTA is
// front-loaded into the early months of a calendar year, so the annual total is right but the
// month-to-month timing is smoothed.

/** Employer share: 6.2% Social Security + 1.45% Medicare. */
export const FICA_RATE = 0.0765;

/**
 * Employer taxes on one seat's wages for one month.
 *
 * @param {object} args
 * @param {number} args.monthlyWages
 * @param {number} args.annualWages    used only for the unemployment wage bases
 * @param {number} args.ficaRate
 * @param {number} args.futaRate       0 unless the program is confirmed FUTA-covered
 * @param {number} args.futaWageBase   per employee per year
 * @param {number} args.sutaRate       0 unless confirmed SUTA-covered and not reimbursable
 * @param {number} args.sutaWageBase
 */
export function employerTaxesForSeat({
  monthlyWages,
  annualWages,
  ficaRate = FICA_RATE,
  futaRate = 0,
  futaWageBase = 7000,
  sutaRate = 0,
  sutaWageBase = 7000,
} = {}) {
  const wages = Math.max(0, monthlyWages ?? 0);
  const annual = Math.max(0, annualWages ?? wages * 12);

  const fica = wages * ficaRate;
  // Wage-base-capped taxes are annual by nature; spread the annual figure evenly.
  const futa = (Math.min(annual, futaWageBase) * futaRate) / 12;
  const suta = (Math.min(annual, sutaWageBase) * sutaRate) / 12;

  return { fica, futa, suta, total: fica + futa + suta };
}

/**
 * Roll seats up into a month's total employer cost.
 * @param {Array<{monthlyWages:number, annualWages?:number}>} seats
 */
export function payrollForSeats(seats, taxOpts = {}) {
  let grossWages = 0;
  let fica = 0;
  let futa = 0;
  let suta = 0;

  for (const seat of seats) {
    const t = employerTaxesForSeat({
      monthlyWages: seat.monthlyWages,
      annualWages: seat.annualWages,
      ...taxOpts,
    });
    grossWages += Math.max(0, seat.monthlyWages ?? 0);
    fica += t.fica;
    futa += t.futa;
    suta += t.suta;
  }

  const employerTax = fica + futa + suta;
  return {
    grossWages,
    fica,
    futa,
    suta,
    employerTax,
    total: grossWages + employerTax,
    // What every extra dollar of wages actually costs — the multiplier the plan omitted.
    loadFactor: grossWages > 0 ? (grossWages + employerTax) / grossWages : 1,
  };
}

/** Hourly wage -> monthly cost, on 52 weeks over 12 months. */
export const monthlyWage = (hourlyRate, hoursPerWeek) => (hourlyRate * hoursPerWeek * 52) / 12;
