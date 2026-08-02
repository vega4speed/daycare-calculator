// revenue.js — tuition, DHS subsidy, the family gap, and collections.
//
// Pure. No I/O, no DOM. Rate tables are passed in (the `dhsCertificate` block of
// data/tn-childcare.json).
//
// ---------------------------------------------------------------------------------------------
// The hybrid model
// ---------------------------------------------------------------------------------------------
// Each enrolled child is either private-pay (family owes full tuition) or on a DHS certificate
// (the state pays its published rate; the family owes the difference, if the provider charges it).
// The business plan calls the difference the "parent gap" and estimates $100-250/mo; at the
// verified 2026 Davidson County rates it computes to $199 for preschool and $210 for toddler.
//
// Three asymmetries this module exists to keep visible rather than average away:
//
//   1. DHS pays part-time at EXACTLY half the full-time rate. Costs do not halve — a half-day
//      child needs the same adults while present (see schedule.js). So part-time DHS children
//      are systematically the least profitable category.
//   2. DHS reimbursement age bands do NOT line up with room age bands. The toddler->preschool
//      rate boundary is 31 months, mid-way through a 2-3 year old room: same room, same tuition,
//      $139/mo less revenue. Modeled as a per-group `dhsBandMix`.
//   3. Only the family-paid portion carries collections risk. The state pays; families sometimes
//      don't. Applying one bad-debt rate to total revenue would overstate the risk on subsidized
//      children and understate it on private-pay ones.
//
// Payment TIMING is deliberately not handled here — this module reports what is EARNED in a
// month, split by payer. The DHS reimbursement lag is a cash-flow concern and belongs to the
// month loop in project.js, which is the only place that can see across months.

/** Weekly rate -> monthly. 52 weeks over 12 months, not 4 weeks/month (which loses ~4 weeks/yr). */
export const monthlyFromWeekly = (weekly) => (weekly * 52) / 12;

/**
 * The DHS weekly rate for one child.
 *
 * @param {object} tables       the `dhsCertificate` block
 * @param {string} band         'infant' | 'toddler' | 'preschool' | 'schoolIn' | 'schoolOut'
 * @param {object} opts
 * @param {'top'|'lower'} opts.tier          county tier — Davidson is 'top'
 * @param {boolean} opts.partTime            DHS part-time is half the full rate, rounded UP
 * @param {number|null} opts.qrisScore       QRIS scorecard, drives the quality bonus
 * @param {boolean} opts.infantDifferential  see the note below — defaults OFF
 * @param {string} opts.providerType         'childCareCenters' (group/family homes differ)
 */
export function dhsWeeklyRate(tables, band, {
  tier = 'top',
  partTime = false,
  qrisScore = null,
  infantDifferential = false,
  providerType = 'childCareCenters',
} = {}) {
  const row = tables?.weeklyRates?.[providerType]?.[band];
  if (!row) throw new Error(`Unknown DHS rate band: ${providerType}/${band}`);

  const base = row[tier];
  if (base == null) throw new Error(`Unknown county tier: ${tier}`);

  // QRIS quality bonus. Math.round reproduces the published chart exactly at every band
  // (208 * 1.05 -> 218, 208 * 1.10 -> 229), so this is a check on the data file too.
  let rate = base;
  const bonus = qrisBonusFor(tables, qrisScore);
  if (bonus > 0) rate = Math.round(rate * (1 + bonus));

  // UNVERIFIED: the published chart carries a note that a 15% infant differential applies
  // "above the current reimbursement rates," but does not say whether the printed infant figure
  // is already inclusive of it. Defaults OFF so the model never silently inflates infant revenue
  // by 15%. Resolve with DHS before relying on an infant-room projection.
  if (infantDifferential && band === 'infant') {
    rate = rate * (1 + (tables?.differentials?.infant?.rate ?? 0.15));
  }

  // "Part-time ... is one-half the full-time rate (rounded up)"
  return partTime ? Math.ceil(rate / 2) : rate;
}

/** The QRIS bonus fraction for a scorecard, or 0 if it doesn't qualify. */
export function qrisBonusFor(tables, qrisScore) {
  if (qrisScore == null) return 0;
  const b = tables?.qrisBonus ?? {};
  if (qrisScore >= 90) return b.score90to100 ?? 0;
  if (qrisScore >= 80) return b.score80to89 ?? 0;
  return 0;
}

/**
 * Revenue for one (group, schedule type) cell.
 *
 * @param {object} args
 * @param {number} args.count            children in this cell
 * @param {number} args.monthlyTuition   list tuition for a FULL-time child in this group
 * @param {number} args.tuitionMultiplier schedule's share of full tuition (1.0 full day; private
 *                                        part-time is normally 0.6-0.7, NOT 0.5 — a seat's cost
 *                                        is not linear in hours)
 * @param {number} args.dhsShare         fraction of this cell on a DHS certificate (0..1)
 * @param {number} args.dhsMonthly       DHS monthly reimbursement for this cell
 * @param {'charge'|'absorb'} args.gapPolicy  whether the family is billed the difference
 * @param {number} args.collectionsLoss  fraction of FAMILY-billed revenue never collected
 */
export function cellRevenue({
  count,
  monthlyTuition,
  tuitionMultiplier = 1,
  dhsShare = 0,
  dhsMonthly = 0,
  gapPolicy = 'charge',
  collectionsLoss = 0,
}) {
  const n = Math.max(0, count ?? 0);
  const tuition = monthlyTuition * tuitionMultiplier;

  const share = Math.min(1, Math.max(0, dhsShare));
  const dhsChildren = n * share;
  const privateChildren = n - dhsChildren;

  const dhsEarned = dhsChildren * dhsMonthly;

  // The gap can go negative if DHS pays more than list tuition. A provider does not refund the
  // state, so the family simply owes nothing — floor at zero rather than crediting the family.
  const rawGap = tuition - dhsMonthly;
  const gapPerChild = gapPolicy === 'absorb' ? 0 : Math.max(0, rawGap);

  const familyBilled = privateChildren * tuition + dhsChildren * gapPerChild;
  const loss = familyBilled * Math.min(1, Math.max(0, collectionsLoss));

  return {
    children: n,
    dhsChildren,
    privateChildren,
    listTuition: tuition,
    gapPerChild,
    // Negative when DHS pays above list tuition — worth surfacing, since it flips the usual
    // "subsidized children are less profitable" intuition.
    gapUncapped: rawGap,
    dhsEarned,
    familyBilled,
    collectionsLoss: loss,
    revenue: dhsEarned + familyBilled - loss,
  };
}

/**
 * Split a group's DHS children across reimbursement bands.
 *
 * A "toddler" room of 2-3 year olds straddles the DHS toddler/preschool boundary at 31 months,
 * so a single band per group would misstate revenue. `dhsBandMix` is the fraction of the group's
 * children in each band; it should sum to 1, and is normalized if it doesn't.
 */
export function normalizeBandMix(mix, fallbackBand) {
  if (!mix || Object.keys(mix).length === 0) return { [fallbackBand]: 1 };
  const total = Object.values(mix).reduce((a, b) => a + Math.max(0, b ?? 0), 0);
  if (total <= 0) return { [fallbackBand]: 1 };
  const out = {};
  for (const [band, w] of Object.entries(mix)) {
    const v = Math.max(0, w ?? 0);
    if (v > 0) out[band] = v / total;
  }
  return out;
}

/**
 * Revenue for a whole month.
 *
 * @param {object} args
 * @param {Object<string, Object<string, number>>} args.enrollment  group -> scheduleTypeId -> count
 * @param {Array} args.scheduleTypes   each { id, tuitionMultiplier?, dhsPartTime? }
 * @param {Array} args.groups          each { id, dhsBand, dhsBandMix? }
 * @param {function} args.tuitionFor   (groupId) -> monthly full-time list tuition
 * @param {function} args.dhsShareFor  (groupId) -> fraction on DHS certificates
 * @param {object} args.dhsTables      the `dhsCertificate` block
 * @param {object} args.rateOpts       passed to dhsWeeklyRate (tier, qrisScore, ...)
 * @param {number} args.collectionsLoss
 * @param {'charge'|'absorb'} args.gapPolicy
 */
export function computeRevenue({
  enrollment,
  scheduleTypes,
  groups,
  tuitionFor,
  dhsShareFor,
  dhsTables,
  rateOpts = {},
  collectionsLoss = 0,
  gapPolicy = 'charge',
}) {
  const typeById = new Map(scheduleTypes.map((s) => [s.id, s]));
  const groupById = new Map(groups.map((g) => [g.id, g]));

  const byGroup = {};
  const byScheduleType = {};
  let dhsEarned = 0;
  let familyBilled = 0;
  let loss = 0;
  let children = 0;
  let dhsChildren = 0;

  for (const [groupId, byType] of Object.entries(enrollment ?? {})) {
    const group = groupById.get(groupId);
    if (!group) throw new Error(`Unknown group: ${groupId}`);

    const monthlyTuition = tuitionFor(groupId);
    const share = dhsShareFor(groupId);
    const bandMix = normalizeBandMix(group.dhsBandMix, group.dhsBand);

    const groupTotals = { children: 0, dhsEarned: 0, familyBilled: 0, collectionsLoss: 0, revenue: 0 };

    for (const [typeId, count] of Object.entries(byType ?? {})) {
      const type = typeById.get(typeId);
      if (!type) throw new Error(`Unknown schedule type: ${typeId}`);

      // A DHS child's rate depends on which band they fall in, so the cell is split again by
      // band and the results summed. Tuition and the private-pay side are band-independent.
      let cellDhsEarned = 0;
      let cellFamilyBilled = 0;
      let cellLoss = 0;
      let cellTotal = 0;

      for (const [band, weight] of Object.entries(bandMix)) {
        const weeklyRate = dhsWeeklyRate(dhsTables, band, {
          ...rateOpts,
          partTime: type.dhsPartTime ?? false,
        });
        const r = cellRevenue({
          count: count * weight,
          monthlyTuition,
          tuitionMultiplier: type.tuitionMultiplier ?? 1,
          dhsShare: share,
          dhsMonthly: monthlyFromWeekly(weeklyRate),
          gapPolicy,
          collectionsLoss,
        });
        cellDhsEarned += r.dhsEarned;
        cellFamilyBilled += r.familyBilled;
        cellLoss += r.collectionsLoss;
        cellTotal += r.revenue;
      }

      const n = Math.max(0, count ?? 0);
      children += n;
      dhsChildren += n * Math.min(1, Math.max(0, share));
      dhsEarned += cellDhsEarned;
      familyBilled += cellFamilyBilled;
      loss += cellLoss;

      groupTotals.children += n;
      groupTotals.dhsEarned += cellDhsEarned;
      groupTotals.familyBilled += cellFamilyBilled;
      groupTotals.collectionsLoss += cellLoss;
      groupTotals.revenue += cellTotal;

      const t = (byScheduleType[typeId] ??= { children: 0, revenue: 0 });
      t.children += n;
      t.revenue += cellTotal;
    }

    byGroup[groupId] = groupTotals;
  }

  const netFamily = familyBilled - loss;
  return {
    children,
    dhsChildren,
    privateChildren: children - dhsChildren,
    byGroup,
    byScheduleType,
    // Earned this month, split by payer. project.js applies the DHS lag to `fromDhs`.
    fromDhs: dhsEarned,
    fromFamilies: netFamily,
    dhsEarned,
    familyBilled,
    collectionsLoss: loss,
    revenue: dhsEarned + netFamily,
    revenuePerChild: children > 0 ? (dhsEarned + netFamily) / children : 0,
  };
}
