// state.js — the app's plan state, its defaults, and localStorage persistence.
//
// The state shape IS project()'s plan shape, deliberately. The retirement calculator needed a
// translation layer because its UI state evolved away from its engine's inputs; starting fresh,
// there is no reason to introduce that seam. `ui/project-adapter.js` only attaches the rate
// tables and picks the solvers to run.
//
// No real financial data ships in this repo. Defaults below are the business plan's own published
// figures, which are already public.

const KEY = 'daycare-calc:plan:v1';

/** The business plan's Year 1 configuration, as a starting point. */
export function defaultState() {
  return {
    meta: {
      name: 'Year 1 plan',
      // Month 0 is opening month; this is only used to label the table.
      openDate: '2027-08',
    },
    months: { from: -2, to: 24 },
    startingCash: 25000,

    rooms: [
      { id: 'ps-1', label: 'Preschool 1', group: 'preschool', ratioRule: 'm_3_5yr', seats: 14, openMonth: 0 },
      { id: 'ps-2', label: 'Preschool 2', group: 'preschool', ratioRule: 'm_3_5yr', seats: 12, openMonth: 4 },
      { id: 'tod-1', label: 'Toddler', group: 'toddler', ratioRule: 'm_2_3yr', seats: 12, openMonth: 8 },
    ],

    groups: [
      {
        id: 'preschool', label: 'Preschool (3–5)',
        ratioRule: 'm_3_5yr', fringeRatioRule: 'm_2h_5yr', dhsBand: 'preschool',
      },
      {
        id: 'toddler', label: 'Toddler (2–3)',
        ratioRule: 'm_2_3yr', fringeRatioRule: 'm_2h_5yr', dhsBand: 'toddler',
        // A 2–3 year old room straddles the DHS toddler/preschool rate boundary at 31 months.
        dhsBandMix: { toddler: 0.5, preschool: 0.5 },
      },
    ],

    roles: [
      { id: 'lead', label: 'Lead teacher', kind: 'lead', hoursPerWeek: 40 },
      { id: 'teacher', label: 'Teacher', kind: 'teacher', hoursPerWeek: 40 },
      { id: 'floater', label: 'Floater', kind: 'floater', hoursPerWeek: 40 },
      { id: 'director', label: 'Director', kind: 'director', hoursPerWeek: 40 },
    ],

    scheduleTypes: [
      { id: 'full', label: 'Full day', arriveHour: 7.5, departHour: 16.5, daysPerWeek: 5, tuitionMultiplier: 1 },
      {
        id: 'half', label: 'Half day (AM)', arriveHour: 7.5, departHour: 12, daysPerWeek: 5,
        // Private part-time is normally priced above pro-rata; DHS pays exactly half.
        tuitionMultiplier: 0.65, dhsPartTime: true,
      },
    ],

    settings: {
      enrollmentTarget: {
        default: 0,
        byGroupMonth: { 'preschool|0+': 14, 'preschool|4+': 26, 'toddler|8+': 12 },
      },
      scheduleMix: { default: { full: 1 } },
      tuition: { default: 1100, byGroup: { toddler: 1250 } },
      dhsShare: { default: 0.5 },
      collectionsLoss: { default: 0.02 },
      attrition: { default: 0.03 },
      acquisitionCost: { default: 200 },

      hoursOpen: { default: 7 },
      hoursClose: { default: 17.5 },

      wage: { default: 18, byGroup: { lead: 20.5, floater: 17, director: 26 } },
      roleHours: { default: 40, byGroupMonth: { 'director|-2+': 20, 'director|8+': 40 } },
      leadsPerRoom: { default: 1 },
      directorCount: { default: 1 },
      floaterPolicy: { default: {}, byMonth: { '8+': { count: 1 } } },
      hireLeadMonths: { default: 1 },

      perChildCost: { default: 120 },
      overheadBase: { default: 2181.82 },
      overheadPerChild: { default: 22.727 },
      insurance: { default: 650 },
      rent: { default: 0 },
      marketing: { default: 0, byMonth: { '-2+': 400, '0+': 150 } },
      oneTime: { default: 0, byMonth: { '-2': 879, '-1': 1400 } },
    },

    options: {
      payrollMode: 'roles',
      dhsLagMonths: 1,
      gapPolicy: 'charge',
      daysOpen: 5,
      hoursPerFte: 40,
      escalators: { general: 0.03, insurance: 0.08, wage: 0.04 },
      rateOpts: { tier: 'top', qrisScore: null },
      premiums: {},
      turnover: null,
    },
  };
}

export function loadState() {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return defaultState();
    const parsed = JSON.parse(raw);
    // Shallow-merge over defaults so a stored plan from an older version still opens.
    return { ...defaultState(), ...parsed };
  } catch {
    return defaultState();
  }
}

export function saveState(state) {
  try {
    localStorage.setItem(KEY, JSON.stringify(state));
  } catch {
    // Private browsing, quota, etc. Losing persistence is not worth breaking the app over.
  }
}

export function clearState() {
  try {
    localStorage.removeItem(KEY);
  } catch { /* see above */ }
}

/** Month offset -> "Aug 2027", for table labels. */
export function monthLabel(openDate, offset) {
  if (!openDate) return null;
  const [y, m] = openDate.split('-').map(Number);
  if (!y || !m) return null;
  const d = new Date(y, m - 1 + offset, 1);
  return d.toLocaleDateString('en-US', { month: 'short', year: 'numeric' });
}
