// capacity.js — rooms, licensing ratios, and the staff those ratios require.
//
// Pure. No I/O, no DOM. Ratio tables are PASSED IN (the parsed `ratios` block of
// data/tn-childcare.json) rather than imported, so the engine stays state-agnostic and tests can
// feed it fixtures.
//
// ---------------------------------------------------------------------------------------------
// Why this module exists
// ---------------------------------------------------------------------------------------------
// Staffing is the largest expense in a childcare program, and it is not a free choice: TN Rule
// 1240-04-01-.22 fixes the minimum. So headcount should be DERIVED from enrollment and room
// layout, not typed in. The business plan's own phase table (2 -> 3 -> 4 -> 5 teachers) is then
// something the model can check rather than something it has to be told.
//
// Two distinct limits, often confused:
//   - adult:child RATIO      how many adults a given number of children requires
//   - maximum GROUP SIZE     how many children may be in one group at all, regardless of adults
// A room's real capacity is min(its physical seats, its age band's max group size).
//
// ---------------------------------------------------------------------------------------------
// A room
// ---------------------------------------------------------------------------------------------
//   {
//     id: 'preschool-1',
//     label: 'Preschool 1',
//     group: 'preschool',     // which enrollment group it serves
//     ratioRule: 'm_3_5yr',   // id of a row in the ratio tables
//     seats: 24,              // physical/licensed seats for this room
//     openMonth: 0,           // month offset it opens; omit/null = never opens
//   }

/** Ceil that treats 0 (and negatives) as needing nobody. */
const staffFor = (children, childrenPerAdult) =>
  children <= 0 ? 0 : Math.ceil(children / childrenPerAdult);

/**
 * Look up a ratio rule by id across every chart. Chart 1 is single-age, Chart 2 is multi-age;
 * ids are unique across both.
 * @returns {{id, label, childrenPerAdult, maxGroupSize}} — throws if not found, because a typo'd
 *          rule id silently resolving to a default would produce plausible-looking wrong staffing.
 */
export function findRatioRule(ratios, ruleId) {
  // An inline rule object is used as-is. The published charts do not cover every grouping a real
  // program might run — there is a 3–5 and a 4–6 but no 3–6, for instance — and TN's own
  // multi-age provision handles those by the age of the majority rather than by a table lookup.
  // So a caller may supply the ratio directly rather than being forced into a grouping that
  // does not describe their room. It is the caller's job to have confirmed it with licensing;
  // this function only refuses to invent one.
  if (ruleId && typeof ruleId === 'object') {
    if (typeof ruleId.childrenPerAdult !== 'number' || ruleId.childrenPerAdult <= 0) {
      throw new Error('A custom ratio rule needs a positive childrenPerAdult');
    }
    return {
      id: ruleId.id ?? 'custom',
      label: ruleId.label ?? 'Custom',
      maxGroupSize: ruleId.maxGroupSize ?? null,
      ...ruleId,
      custom: true,
    };
  }

  for (const chart of ['chart1_singleAge', 'chart2_multiAge']) {
    const rows = ratios?.[chart];
    if (!Array.isArray(rows)) continue;
    const hit = rows.find((r) => r.id === ruleId);
    if (hit) return hit;
  }
  throw new Error(`Unknown ratio rule: ${ruleId}`);
}

/**
 * Apply the Rule .22(1)(b)1 variance: ratio and group size may be exceeded by up to 10%, rounded
 * to the nearest whole number, no more than 3 days/week — and NEVER for infant or toddler groups.
 *
 * Off by default everywhere. It is an exception granted for occasional days, not a basis for
 * planning staffing or revenue, and using it as one would overstate capacity year-round.
 */
export function withVariance(rule, { allowVariance = false } = {}) {
  if (!allowVariance) return rule;
  return {
    ...rule,
    childrenPerAdult: Math.round(rule.childrenPerAdult * 1.1),
    maxGroupSize: rule.maxGroupSize == null ? null : Math.round(rule.maxGroupSize * 1.1),
    varianceApplied: true,
  };
}

/**
 * A room's effective capacity, and which limit binds.
 * `limitedBy` is worth surfacing in the UI: "you have 24 seats but may only group 16 of these
 * children together" is a very different problem from "you ran out of room."
 * @returns {{capacity:number, seats:number, maxGroupSize:number|null,
 *            limitedBy:'seats'|'groupSize'|'both', rule:object}}
 */
export function roomCapacity(room, ratios, opts = {}) {
  const rule = withVariance(findRatioRule(ratios, room.ratioRule), opts);
  const seats = room.seats ?? 0;
  const maxGroupSize = rule.maxGroupSize ?? null;

  const capacity = maxGroupSize == null ? seats : Math.min(seats, maxGroupSize);
  let limitedBy;
  if (maxGroupSize == null || seats < maxGroupSize) limitedBy = 'seats';
  else if (seats > maxGroupSize) limitedBy = 'groupSize';
  else limitedBy = 'both';

  return { capacity, seats, maxGroupSize, limitedBy, rule };
}

/**
 * Fill in each room's licensing rule from its age group where the room does not state one.
 *
 * A room has two group-ish fields and they answer different questions:
 *   - `group`     which ENROLLMENT group the children belong to — it carries tuition, the DHS
 *                 reimbursement band, and the enrollment target.
 *   - `ratioRule` which LICENSING row governs this room's ratio and maximum group size.
 *
 * Usually the second follows from the first, and restating it on every room is just an
 * opportunity to get them out of step. But they genuinely can differ: one enrollment group can
 * occupy two rooms with different age mixes — a 3-year-old room at 1:9 and a 4–5 room at 1:16 —
 * at the same tuition and the same DHS band. So `ratioRule` is OPTIONAL and inherited, rather
 * than either mandatory (tedious) or removed (loses a real case).
 */
export function resolveRoomRules(rooms = [], groups = []) {
  const byId = new Map(groups.map((g) => [g.id, g]));
  return rooms.map((room) => {
    if (room.ratioRule) return room;
    const rule = byId.get(room.group)?.ratioRule;
    if (!rule) {
      throw new Error(
        `Room "${room.id}" has no ratioRule and its group "${room.group}" does not supply one`,
      );
    }
    return { ...room, ratioRule: rule, ratioRuleInherited: true };
  });
}

/** Rooms open in a given month. A room with no `openMonth` never opens. */
export function openRooms(rooms, month) {
  return rooms.filter((r) => r.openMonth != null && month >= r.openMonth);
}

/**
 * Total licensed capacity across open rooms in a month, with a per-group breakdown.
 * @returns {{total:number, byGroup:Object<string,number>, byRoom:Object<string,number>}}
 */
export function licensedCapacity(rooms, ratios, month, opts = {}) {
  const byGroup = {};
  const byRoom = {};
  let total = 0;
  for (const room of openRooms(rooms, month)) {
    const { capacity } = roomCapacity(room, ratios, opts);
    byRoom[room.id] = capacity;
    byGroup[room.group] = (byGroup[room.group] ?? 0) + capacity;
    total += capacity;
  }
  return { total, byGroup, byRoom };
}

/**
 * Seat an enrollment TARGET into the rooms open this month.
 *
 * Enrollment is entered as an absolute target per month (a deliberate design choice — see
 * PLAN.md §4.2). Capacity still clamps physically, but the shortfall is reported as `unserved`
 * rather than silently lowering the number you typed. An invisible clamp would make the model
 * disagree with its own inputs for reasons you can't see on screen.
 *
 * Rooms are filled in array order within each group, so room ordering is the (documented)
 * tie-breaker — the same flavor of order-dependence the retirement calculator has in its
 * contribution and withdrawal sequencing.
 *
 * @param {Object<string,number>} targetByGroup e.g. { toddler: 12, preschool: 24 }
 * @returns {{byRoom, byGroup, served, target, unservedByGroup, unserved}}
 */
export function allocate(targetByGroup, rooms, ratios, month, opts = {}) {
  const open = openRooms(rooms, month);
  const byRoom = {};
  const byGroup = {};
  const unservedByGroup = {};
  let served = 0;
  let target = 0;
  let unserved = 0;

  for (const [group, wanted] of Object.entries(targetByGroup ?? {})) {
    const want = Math.max(0, wanted ?? 0);
    target += want;

    let remaining = want;
    for (const room of open.filter((r) => r.group === group)) {
      if (remaining <= 0) break;
      const { capacity } = roomCapacity(room, ratios, opts);
      const seated = Math.min(remaining, capacity);
      byRoom[room.id] = seated;
      remaining -= seated;
    }

    const placed = want - remaining;
    byGroup[group] = placed;
    served += placed;
    if (remaining > 0) {
      unservedByGroup[group] = remaining;
      unserved += remaining;
    }
  }

  // Open rooms nobody was placed in still report 0, so the table has a full row.
  for (const room of open) if (byRoom[room.id] === undefined) byRoom[room.id] = 0;

  return { byRoom, byGroup, served, target, unservedByGroup, unserved };
}

/**
 * Adults required by law, given who is actually seated where.
 *
 * Two independent requirements, both of which must hold:
 *   1. Per-room ratio — ceil(children in room / childrenPerAdult), summed.
 *   2. Rule .22(1)(b)2 — when MORE THAN 12 children are present on the premises, a second adult
 *      must be physically available. This is a facility-wide floor, not a per-room one, and it is
 *      exactly why the business plan's 12-14 child launch needs 2 adults even though a single
 *      3-5yr room of 14 satisfies the 1:13 ratio with... 2 adults anyway. It binds independently
 *      at lower counts: 13 children in one room at 1:16 would be 1 adult by ratio, 2 by this rule.
 *
 * The floor may be satisfied by any adult physically available, including the director — it says
 * "available on the premises," not "assigned to a group." Callers that staff a director
 * separately should pass `directorCounts: true` so the floor isn't double-counted into teachers.
 *
 * @returns {{total, byRoom, ratioRequired, facilityFloor, floorBinds, childrenPresent}}
 */
export function staffingRequirement(allocation, rooms, ratios, opts = {}) {
  const { directorCounts = false } = opts;
  const byRoom = {};
  let ratioRequired = 0;
  let childrenPresent = 0;

  for (const room of rooms) {
    const children = allocation.byRoom?.[room.id];
    if (children === undefined) continue;
    const { rule } = roomCapacity(room, ratios, opts);
    const need = staffFor(children, rule.childrenPerAdult);
    byRoom[room.id] = need;
    ratioRequired += need;
    childrenPresent += children;
  }

  // "More than twelve (12)" — 13 triggers it, 12 does not.
  const facilityFloor = childrenPresent > 12 ? 2 : childrenPresent > 0 ? 1 : 0;

  // A director on the premises satisfies one of the required adults, so the floor that teachers
  // themselves must meet drops by one.
  const floorForStaff = directorCounts ? Math.max(0, facilityFloor - 1) : facilityFloor;
  const total = Math.max(ratioRequired, floorForStaff);
  const floorBinds = floorForStaff > ratioRequired;

  return { total, byRoom, ratioRequired, facilityFloor, floorBinds, childrenPresent };
}

/**
 * The coverage buffer: staff on hand versus the legal minimum.
 *
 * This is the fragility measure PLAN.md §4.8 keys the early-hire wage premium on, and the thing
 * a floater pool exists to create. buffer 0 means a single absence puts the program out of
 * ratio — which is a licensing problem, not merely an inconvenience.
 */
export function coverageBuffer(staffOnHand, requirement) {
  const required = requirement.total;
  return {
    required,
    onHand: staffOnHand,
    buffer: staffOnHand - required,
    // Ratio of slack to requirement — the scale-free version, for the derived premium rule.
    bufferRatio: required > 0 ? (staffOnHand - required) / required : null,
    outOfRatio: staffOnHand < required,
  };
}
