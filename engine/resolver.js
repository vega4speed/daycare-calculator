// resolver.js — the general→granular override resolver, month-axis edition.
//
// Adapted from the retirement calculator's resolver, with one substantive change: month keys
// resolve as a STEP FUNCTION, not by exact match. See "Sticky keys" below.
//
// Every adjustable knob is stored as a `setting`:
//   { default, byGroup?, byMonth?, byGroupMonth? }
// resolved most-specific-first:
//   byGroupMonth → byMonth → byGroup → default
//
// Pure. No I/O, no DOM.
//
// ---------------------------------------------------------------------------------------------
// The month axis
// ---------------------------------------------------------------------------------------------
// Months are SIGNED INTEGER OFFSETS from opening:
//   -2, -1  pre-open (licensing, deposits, signage, pre-launch ads, staff hired early)
//    0      the opening month
//    1..M   operating months
// The plan's real calendar start date is stored once, elsewhere, so slipping the open date shifts
// the whole plan without re-keying a single override.
//
// ---------------------------------------------------------------------------------------------
// Sticky keys
// ---------------------------------------------------------------------------------------------
// The retirement calculator's `byYear` is a strict exact match: every changed period needs its own
// entry. That's fine for 40 sparse years and miserable for 60 months, where an assumption
// typically changes a handful of times and then holds.
//
// So a month key carries an explicit suffix:
//
//   "6+": 4200   STEP  — applies from month 6 onward, until a later step key supersedes it
//   "6":  4200   SPIKE — that single month only
//
// Resolution for month m, most specific first:
//   1. exact spike key "m"
//   2. the LARGEST step key "k+" where k <= m
//   3. (next level down: byGroup, then default)
//
// Spikes punch one-month holes in the step function. Both live in one map, so the saved JSON
// reads as a timeline. Real spike cases: the $879 licensing fee, an insurance binder, a signage buy.
//
// Note a step key at month k does NOT imply anything about months before k — if no step key
// covers month m, resolution falls through to byGroup/default. So `{default: 1100, byMonth: {"13+": 1175}}`
// reads exactly as you'd hope: $1,100 from the beginning, $1,175 from month 13 on.

const has = (obj, key) =>
  obj != null && Object.prototype.hasOwnProperty.call(obj, key);

/** True for a valid month offset: any integer, including negatives and 0. */
export function isMonth(m) {
  return typeof m === 'number' && Number.isInteger(m);
}

/**
 * Parse a byMonth key into {month, sticky}. Returns null if it isn't a valid key.
 *   "6"  -> { month: 6, sticky: false }
 *   "6+" -> { month: 6, sticky: true }
 *   "-2" -> { month: -2, sticky: false }
 */
export function parseMonthKey(key) {
  const s = String(key);
  const sticky = s.endsWith('+');
  const body = sticky ? s.slice(0, -1) : s;
  if (!/^-?\d+$/.test(body)) return null;
  return { month: Number(body), sticky };
}

/** Build a byMonth key. `sticky` defaults to true — the common case. */
export function monthKey(month, sticky = true) {
  return sticky ? `${month}+` : String(month);
}

/**
 * Resolve a month map (the `byMonth` or a group's slice of `byGroupMonth`) for month `m`.
 * Exact spike wins; otherwise the latest step key at or before m.
 * @returns {{value:*, key:string, sticky:boolean}|null} null when nothing applies.
 */
function resolveMonthMap(map, m) {
  if (map == null) return null;

  // 1. An exact spike for this month wins outright.
  const exact = String(m);
  if (has(map, exact)) return { value: map[exact], key: exact, sticky: false };

  // 2. Otherwise the largest step key at or before m.
  let best = null;
  for (const key of Object.keys(map)) {
    const parsed = parseMonthKey(key);
    if (parsed === null || !parsed.sticky) continue;
    if (parsed.month > m) continue;
    if (best === null || parsed.month > best.month) {
      best = { month: parsed.month, key };
    }
  }
  if (best !== null) return { value: map[best.key], key: best.key, sticky: true };

  return null;
}

/**
 * Resolve a setting AND report which override level supplied the value — for the UI (showing
 * whether a cell is inherited or overridden) and for tests.
 * @param {*} setting a setting object, or any literal value (returned as-is).
 * @param {{month?:number, groupId?:string}} [context]
 * @returns {{value:*, level:'byGroupMonth'|'byMonth'|'byGroup'|'default'|'literal'|'unset',
 *            key:(string|null), sticky?:boolean}}
 */
export function explainResolve(setting, context = {}) {
  // A bare value (not a setting object) is treated as a literal.
  if (setting === null || typeof setting !== 'object' || Array.isArray(setting)) {
    return { value: setting, level: 'literal', key: null };
  }

  const groupId =
    context.groupId != null && context.groupId !== '' ? String(context.groupId) : undefined;
  const month = isMonth(context.month) ? context.month : undefined;

  if (groupId !== undefined && month !== undefined && setting.byGroupMonth != null) {
    // byGroupMonth keys are "<groupId>|<monthKey>". Slice out this group's own month map,
    // then run the same step resolution over it.
    const slice = {};
    const prefix = `${groupId}|`;
    for (const key of Object.keys(setting.byGroupMonth)) {
      if (key.startsWith(prefix)) slice[key.slice(prefix.length)] = setting.byGroupMonth[key];
    }
    const hit = resolveMonthMap(slice, month);
    if (hit) {
      return {
        value: hit.value,
        level: 'byGroupMonth',
        key: `${groupId}|${hit.key}`,
        sticky: hit.sticky,
      };
    }
  }

  if (month !== undefined) {
    const hit = resolveMonthMap(setting.byMonth, month);
    if (hit) return { value: hit.value, level: 'byMonth', key: hit.key, sticky: hit.sticky };
  }

  if (groupId !== undefined && has(setting.byGroup, groupId)) {
    return { value: setting.byGroup[groupId], level: 'byGroup', key: groupId };
  }

  if (has(setting, 'default')) {
    return { value: setting.default, level: 'default', key: null };
  }

  return { value: undefined, level: 'unset', key: null };
}

/**
 * Resolve a setting's effective value for a given context.
 * Note: falsy values (0, false, "") are valid results and are returned, not skipped —
 * presence is checked with hasOwnProperty, never truthiness. A $0 month is a real override.
 * @param {*} setting
 * @param {{month?:number, groupId?:string}} [context]
 */
export function resolve(setting, context = {}) {
  return explainResolve(setting, context).value;
}

/** True if `v` looks like a setting object (has an own `default`). */
export function isSetting(v) {
  return v != null && typeof v === 'object' && !Array.isArray(v) && has(v, 'default');
}

/** Build a fresh setting from a simple-mode value. */
export function makeSetting(defaultValue) {
  return { default: defaultValue };
}

/**
 * Classify an override target into its level + storage key.
 * Both group and month → byGroupMonth; month only → byMonth; group only → byGroup;
 * neither → default. `sticky` (default true) selects step vs spike for month-bearing targets.
 */
export function overrideKeyLevel({ groupId, month, sticky = true } = {}) {
  const g = groupId != null && groupId !== '';
  const m = isMonth(month);
  if (g && m) return { level: 'byGroupMonth', key: `${groupId}|${monthKey(month, sticky)}` };
  if (m) return { level: 'byMonth', key: monthKey(month, sticky) };
  if (g) return { level: 'byGroup', key: String(groupId) };
  return { level: 'default', key: null };
}

/**
 * Set an override on a setting (mutates and returns it). Target {groupId?, month?, sticky?}
 * selects the level; empty target sets the default.
 *
 * Setting a step and a spike for the same month are DIFFERENT keys ("6+" vs "6") and can
 * coexist — the spike wins for month 6, the step governs 7 onward. That's deliberate: "raise
 * tuition from month 6, but waive it entirely in month 6" is a coherent thing to express.
 */
export function setOverride(setting, target, value) {
  const { level, key } = overrideKeyLevel(target);
  if (level === 'default') {
    setting.default = value;
    return setting;
  }
  if (!setting[level]) setting[level] = {};
  setting[level][key] = value;
  return setting;
}

/**
 * Remove an override (mutates and returns it). Pruning empty override maps keeps saved JSON
 * clean. Clearing the "default" target is a no-op (a setting must keep its default).
 */
export function clearOverride(setting, target) {
  const { level, key } = overrideKeyLevel(target);
  if (level === 'default') return setting;
  if (setting[level]) {
    delete setting[level][key];
    if (Object.keys(setting[level]).length === 0) delete setting[level];
  }
  return setting;
}

/**
 * List every override on a setting as flat rows — for rendering an overrides table or the
 * timeline strip. Sorted by month where there is one, so the result reads as a timeline.
 */
export function listOverrides(setting) {
  const rows = [];
  if (!isSetting(setting)) return rows;

  for (const level of ['byGroup', 'byMonth', 'byGroupMonth']) {
    const map = setting[level];
    if (!map) continue;
    for (const key of Object.keys(map)) {
      let groupId = null;
      let monthPart = null;
      if (level === 'byGroup') {
        groupId = key;
      } else if (level === 'byMonth') {
        monthPart = key;
      } else {
        const idx = key.indexOf('|');
        groupId = key.slice(0, idx);
        monthPart = key.slice(idx + 1);
      }
      const parsed = monthPart === null ? null : parseMonthKey(monthPart);
      rows.push({
        level,
        key,
        groupId,
        month: parsed ? parsed.month : null,
        sticky: parsed ? parsed.sticky : null,
        value: map[key],
      });
    }
  }

  rows.sort((a, b) => {
    if (a.month === null && b.month === null) return 0;
    if (a.month === null) return -1;
    if (b.month === null) return 1;
    return a.month - b.month;
  });
  return rows;
}

/**
 * Materialize a setting across a month range — what the timeline strip renders, and the
 * shape most engine loops actually want.
 * @returns {Array<{month:number, value:*, level:string, key:string|null, sticky?:boolean}>}
 */
export function timeline(setting, fromMonth, toMonth, context = {}) {
  const out = [];
  for (let m = fromMonth; m <= toMonth; m++) {
    out.push({ month: m, ...explainResolve(setting, { ...context, month: m }) });
  }
  return out;
}
