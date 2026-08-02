// project-adapter.js — the ONE place the app's state becomes engine calls.
//
// Same role as the retirement calculator's adapter of the same name: every consumer (the live
// editor, and later scenario comparison) goes through here, so they can never drift into
// projecting the same plan two different ways.
//
// The state shape already matches project()'s plan shape (see state.js), so this mostly attaches
// the rate tables and runs the solvers whose answers the headline tiles need.

import { project } from '../engine/project.js';
import {
  solveMinimumStartupCapital,
  solveBreakEvenEnrollment,
  solveRequiredTuition,
} from '../engine/solve.js';

let TABLES = null;

/** Load the verified TN figures once. Returns null on failure rather than throwing. */
export async function loadTables() {
  if (TABLES) return TABLES;
  try {
    const res = await fetch(new URL('../data/tn-childcare.json', import.meta.url));
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    TABLES = await res.json();
    return TABLES;
  } catch {
    return null;
  }
}

export const tables = () => TABLES;

/** The plan object the engine wants, from app state. */
export function planFor(state) {
  return { ...state, tables: TABLES ?? {} };
}

/**
 * Project, and run the solvers behind the headline answers.
 *
 * `cashFloor` is the operating buffer the sponsor wants to keep on hand — the difference between
 * "never technically overdrawn" and "never white-knuckled", which is a real distinction when the
 * answer is going to a church board.
 */
export function projectFor(state, { cashFloor = 10000 } = {}) {
  if (!TABLES) return null;
  const plan = planFor(state);

  const result = project(plan);
  const lastMonth = result.rows.at(-1)?.month ?? 0;

  // Break-even is asked at the launch month and at the fully-open month, because those are the
  // two the business plan itself makes claims about, and they disagree.
  const firstOperating = 0;
  const capital = solveMinimumStartupCapital(plan, { floor: cashFloor });

  let breakEvenLaunch = null;
  let breakEvenStable = null;
  let requiredTuitionLaunch = null;
  try {
    breakEvenLaunch = solveBreakEvenEnrollment(plan, { atMonth: firstOperating });
    breakEvenStable = solveBreakEvenEnrollment(plan, { atMonth: lastMonth });
    if (breakEvenLaunch && !breakEvenLaunch.achievable) {
      requiredTuitionLaunch = solveRequiredTuition(plan, { atMonth: firstOperating });
    }
  } catch (err) {
    // A solver failing must not take the whole projection down with it.
    console.warn('solver failed', err);
  }

  return {
    ...result,
    solved: { capital, breakEvenLaunch, breakEvenStable, requiredTuitionLaunch, cashFloor },
  };
}

/**
 * Plain-language narration of what changes in a given month.
 *
 * Same idea as the retirement calculator's transitionsFor(): every check uses only this row's own
 * data plus the previous row, so it never needs a lookahead or a second pass. These are the
 * things a reader would otherwise have to spot by comparing numbers across rows.
 */
export function transitionsFor(row, prev, state) {
  const out = [];
  if (!row) return out;

  if (row.month === 0) out.push({ kind: 'info', text: 'Program opens' });

  // Rooms opening
  for (const room of state.rooms ?? []) {
    if (room.openMonth === row.month) {
      out.push({ kind: 'info', text: `${room.label ?? room.id} opens (${room.seats} seats)` });
    }
  }

  if (prev) {
    const before = prev.staffing?.seats?.headcount ?? 0;
    const now = row.staffing?.seats?.headcount ?? 0;
    if (now > before) out.push({ kind: 'info', text: `Staff grows to ${now} (from ${before})` });
    if (now < before) out.push({ kind: 'info', text: `Staff falls to ${now} (from ${before})` });

    if (prev.net < 0 && row.net >= 0) out.push({ kind: 'good', text: 'First profitable month' });
    if (prev.net >= 0 && row.net < 0) out.push({ kind: 'warn', text: 'Back into monthly loss' });
    if (prev.cash >= 0 && row.cash < 0) out.push({ kind: 'bad', text: 'Cash goes negative' });
    if (prev.cash < 0 && row.cash >= 0) out.push({ kind: 'good', text: 'Cash recovers' });
  }

  if (row.staffing?.hiringAhead) {
    out.push({ kind: 'warn', text: 'Staffed ahead of enrollment (hire lead time)' });
  }
  if (row.enrollment?.unserved > 0) {
    const parts = Object.entries(row.enrollment.unservedByGroup ?? {})
      .map(([g, n]) => `${Math.round(n)} ${g}`)
      .join(', ');
    out.push({
      kind: 'warn',
      text: `${Math.round(row.enrollment.unserved)} children over capacity and unserved (${parts})`,
    });
  }
  if (row.staffing?.buffer?.outOfRatio) {
    out.push({ kind: 'bad', text: 'Staffing is below the licensed ratio requirement' });
  }

  return out;
}
