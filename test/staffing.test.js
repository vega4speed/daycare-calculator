import test from 'node:test';
import assert from 'node:assert/strict';
import { seatWage, roleDemand, buildSeats, summarizeSeats } from '../engine/staffing.js';
import { employerTaxesForSeat, payrollForSeats, monthlyWage, FICA_RATE } from '../engine/payroll.js';

const near = (a, b, eps = 0.01) =>
  assert.ok(Math.abs(a - b) < eps, `${a} should be within ${eps} of ${b}`);

// Jake's roles and rates, PLAN.md section 4.8.
const ROLES = [
  { id: 'lead', kind: 'lead', hoursPerWeek: 40 },
  { id: 'teacher', kind: 'teacher', hoursPerWeek: 40 },
  { id: 'floater', kind: 'floater', hoursPerWeek: 40 },
  { id: 'director', kind: 'director', hoursPerWeek: 40 },
];
const WAGES = { lead: 20.5, teacher: 18, floater: 17, director: 26 };

const seatArgs = (demand, over = {}) => ({
  demand,
  roles: ROLES,
  wageFor: (id) => WAGES[id],
  hoursFor: (id) => ROLES.find((r) => r.id === id).hoursPerWeek,
  ...over,
});

// --- the early-hire premium ---------------------------------------------------------------

test('the early-hire premium applies to the first N positions only', () => {
  const opts = { earlyHirePremium: { count: 2, amount: 1.5 } };
  assert.equal(seatWage(18, 0, opts), 19.5);
  assert.equal(seatWage(18, 1, opts), 19.5);
  assert.equal(seatWage(18, 2, opts), 18, 'the third hire is at base');
  assert.equal(seatWage(18, 9, opts), 18);
});

test('no premium configured means base wage', () => {
  assert.equal(seatWage(18, 0), 18);
  assert.equal(seatWage(18, 0, {}), 18);
});

test('the buffer premium pays for fragility and decays as slack builds', () => {
  // Jake's reasoning stated as a rule: maximum at zero buffer, gone by decayAt.
  const opts = { bufferPremium: { maxAmount: 2, decayAt: 0.5 } };
  assert.equal(seatWage(18, 0, { ...opts, bufferRatio: 0 }), 20, 'no slack -> full premium');
  assert.equal(seatWage(18, 0, { ...opts, bufferRatio: 0.25 }), 19, 'half decayed');
  assert.equal(seatWage(18, 0, { ...opts, bufferRatio: 0.5 }), 18, 'fully decayed');
  assert.equal(seatWage(18, 0, { ...opts, bufferRatio: 1 }), 18, 'and stays there');
});

test('the buffer premium is inert without a buffer reading', () => {
  assert.equal(seatWage(18, 0, { bufferPremium: { maxAmount: 2, decayAt: 0.5 } }), 18);
});

test('the two premium forms do not stack -- the larger wins', () => {
  // They express the same fragility two ways; stacking would double-count it.
  const both = {
    earlyHirePremium: { count: 2, amount: 1.5 },
    bufferPremium: { maxAmount: 2, decayAt: 0.5 },
    bufferRatio: 0,
  };
  assert.equal(seatWage(18, 0, both), 20, 'buffer premium is larger here');
  assert.equal(seatWage(18, 5, both), 20, 'and still applies past the early-hire count');

  const earlyBigger = { ...both, bufferPremium: { maxAmount: 0.5, decayAt: 0.5 } };
  assert.equal(seatWage(18, 0, earlyBigger), 19.5);
});

// --- role demand ---------------------------------------------------------------------------

test('leads are one per open room, teachers fill the remaining coverage', () => {
  // 3 rooms, 135 weekly coverage hours. 3 leads supply 120; 15 remain -> 1 teacher.
  const d = roleDemand({ coverageHours: 135, openRoomCount: 3, roles: ROLES });
  assert.equal(d.byRole.lead, 3);
  assert.equal(d.byRole.teacher, 1);
  assert.equal(d.coverageSupplied, 160);
  assert.equal(d.coverageShortfall, 0);
});

test('teachers round up, and the slack shows as coverage supplied above required', () => {
  const d = roleDemand({ coverageHours: 90, openRoomCount: 1, roles: ROLES });
  assert.equal(d.byRole.lead, 1);
  assert.equal(d.byRole.teacher, 2, 'ceil((90 - 40) / 40)');
  assert.equal(d.coverageSupplied, 120);
});

test('no coverage required means no classroom staff -- but still a director', () => {
  const d = roleDemand({ coverageHours: 0, openRoomCount: 0, roles: ROLES });
  assert.equal(d.byRole.lead, undefined);
  assert.equal(d.byRole.teacher, 0);
  assert.equal(d.byRole.floater, 0);
  assert.equal(d.byRole.director, 1, 'the director works before the doors open');
});

test('floater policies: flat count, per rooms, and per classroom staff', () => {
  const base = { coverageHours: 135, openRoomCount: 3, roles: ROLES };

  assert.equal(roleDemand({ ...base, policy: { floaterPolicy: { count: 2 } } }).byRole.floater, 2);
  assert.equal(roleDemand({ ...base, policy: { floaterPolicy: { perRooms: 2 } } }).byRole.floater, 2);
  assert.equal(
    roleDemand({ ...base, policy: { floaterPolicy: { perClassroomStaff: 0.25 } } }).byRole.floater,
    1, 'ceil(4 * 0.25)',
  );
  assert.equal(roleDemand({ ...base }).byRole.floater, 0, 'no policy -> no floaters');
});

test('floaters need someone to relieve', () => {
  const d = roleDemand({
    coverageHours: 0, openRoomCount: 0, roles: ROLES,
    policy: { floaterPolicy: { count: 3 } },
  });
  assert.equal(d.byRole.floater, 0);
});

test('leadsPerRoom below 1 shares a lead across rooms', () => {
  const d = roleDemand({
    coverageHours: 160, openRoomCount: 4, roles: ROLES, policy: { leadsPerRoom: 0.5 },
  });
  assert.equal(d.byRole.lead, 2);
});

// --- seats ------------------------------------------------------------------------------

test('seats are built per role with their own wages and hours', () => {
  const demand = roleDemand({ coverageHours: 135, openRoomCount: 3, roles: ROLES });
  const seats = buildSeats(seatArgs(demand));

  assert.equal(seats.length, 5, '3 leads + 1 teacher + 1 director');
  assert.equal(seats.filter((s) => s.roleId === 'lead').length, 3);
  near(seats.find((s) => s.roleId === 'lead').monthlyWages, monthlyWage(20.5, 40));
  near(seats.find((s) => s.roleId === 'director').monthlyWages, monthlyWage(26, 40));
});

test('a part-time director costs proportionally less', () => {
  const demand = roleDemand({ coverageHours: 0, openRoomCount: 0, roles: ROLES });
  const pt = buildSeats(seatArgs(demand, { hoursFor: () => 20 }));
  near(pt[0].monthlyWages, monthlyWage(26, 20));
  near(pt[0].monthlyWages, 2253.33);
});

test('the premium is applied per seat and reported', () => {
  const demand = roleDemand({ coverageHours: 200, openRoomCount: 1, roles: ROLES });
  const seats = buildSeats(seatArgs(demand, {
    premiums: { teacher: { earlyHirePremium: { count: 2, amount: 1.5 } } },
  }));
  const teachers = seats.filter((s) => s.roleId === 'teacher');
  assert.ok(teachers.length >= 3);
  assert.equal(teachers[0].wage, 19.5);
  assert.equal(teachers[0].premium, 1.5);
  assert.equal(teachers[1].wage, 19.5);
  assert.equal(teachers[2].wage, 18);
  assert.equal(teachers[2].premium, 0);
});

test('summarizeSeats rolls up headcount, wages, and the premium actually paid', () => {
  const demand = roleDemand({ coverageHours: 200, openRoomCount: 1, roles: ROLES });
  const seats = buildSeats(seatArgs(demand, {
    premiums: { teacher: { earlyHirePremium: { count: 2, amount: 1.5 } } },
  }));
  const s = summarizeSeats(seats);

  assert.equal(s.headcount, seats.length);
  near(s.monthlyWages, seats.reduce((a, x) => a + x.monthlyWages, 0));
  assert.equal(s.fte, s.weeklyHours / 40);
  // Two teachers at +$1.50/hr for 40 hrs/wk.
  near(s.byRole.teacher.premiumPaid, (2 * 1.5 * 40 * 52) / 12);
  assert.ok(s.byRole.teacher.averageWage > 18 && s.byRole.teacher.averageWage < 19.5);
});

test('summarizeSeats handles an empty roster', () => {
  const s = summarizeSeats([]);
  assert.equal(s.headcount, 0);
  assert.equal(s.monthlyWages, 0);
  assert.equal(s.fte, 0);
});

// --- payroll taxes -------------------------------------------------------------------------

test('FICA is the solid default at 7.65%', () => {
  const t = employerTaxesForSeat({ monthlyWages: 3000 });
  near(t.fica, 229.5);
  assert.equal(t.futa, 0);
  assert.equal(t.suta, 0);
  near(t.total, 229.5);
});

test('unemployment taxes default OFF -- a church/nonprofit question, not a guess', () => {
  // Defaulting them ON would overstate cost; defaulting OFF understates it if covered.
  // Zero-plus-a-loud-note cannot be mistaken for a researched answer. See payroll.js header.
  const off = employerTaxesForSeat({ monthlyWages: 3000, annualWages: 36000 });
  assert.equal(off.futa, 0);
  assert.equal(off.suta, 0);

  const on = employerTaxesForSeat({
    monthlyWages: 3000, annualWages: 36000,
    futaRate: 0.006, futaWageBase: 7000, sutaRate: 0.027, sutaWageBase: 7000,
  });
  near(on.futa, (7000 * 0.006) / 12);
  near(on.suta, (7000 * 0.027) / 12);
});

test('unemployment wage bases cap the annual amount, not the monthly one', () => {
  const low = employerTaxesForSeat({ monthlyWages: 400, annualWages: 4800, sutaRate: 0.027 });
  near(low.suta, (4800 * 0.027) / 12, 0.01, 'under the base, taxed on all wages');

  const high = employerTaxesForSeat({ monthlyWages: 4000, annualWages: 48000, sutaRate: 0.027 });
  near(high.suta, (7000 * 0.027) / 12, 0.01, 'over the base, capped');
});

test("payrollForSeats reports the load factor the business plan omitted", () => {
  const seats = [{ monthlyWages: 5000 }, { monthlyWages: 3000 }];
  const p = payrollForSeats(seats);
  near(p.grossWages, 8000);
  near(p.employerTax, 8000 * FICA_RATE);
  near(p.total, 8612);
  near(p.loadFactor, 1.0765);
});

test('an empty payroll reports a load factor of 1 rather than NaN', () => {
  const p = payrollForSeats([]);
  assert.equal(p.total, 0);
  assert.equal(p.loadFactor, 1);
});

// --- reconciling against the business plan --------------------------------------------------

test("Jake's rates reproduce the plan's Phase 1 payroll as GROSS wages", () => {
  // PLAN.md 4.8: 1 lead + 1 teacher + a part-time director.
  const seats = [
    { monthlyWages: monthlyWage(20.5, 40) },
    { monthlyWages: monthlyWage(18, 40) },
    { monthlyWages: monthlyWage(26, 20) },
  ];
  const p = payrollForSeats(seats);
  near(p.grossWages, 8926.67, 0.5);
  near(p.total, 9609.55, 0.5);
  // The plan says $9,300 -- between the two, much nearer gross.
  assert.ok(p.grossWages < 9300 && 9300 < p.total);
});

test("Jake's rates reproduce the plan's Phase 4 payroll as GROSS wages", () => {
  const seats = [
    ...Array(3).fill({ monthlyWages: monthlyWage(20.5, 40) }),
    ...Array(2).fill({ monthlyWages: monthlyWage(18, 40) }),
    { monthlyWages: monthlyWage(26, 40) },
  ];
  const p = payrollForSeats(seats);
  near(p.grossWages, 21406.67, 0.5);
  near(p.total, 23044.28, 0.5);
  assert.ok(p.grossWages < 22000 && 22000 < p.total, 'the plan says $22,000');
});
