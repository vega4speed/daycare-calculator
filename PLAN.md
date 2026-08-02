# Childcare Program Calculator — design plan

A month-by-month financial model for the CFEN Preschool & Childcare Program, in the same spirit
as the retirement calculator: static, zero-dependency, vanilla JS, pure `engine/` + vanilla `ui/`,
no build step, GitHub Pages hostable, no real data in the repo.

Source: `childcare_business_plan.docx` (Childcare Hybrid Model Business Plan).

---

## 1. What it computes

Given assumptions that can change month by month, project **month −N through month M**:

- **Enrollment** per age group (driven by a ramp, capped by licensed capacity and by rooms open)
- **Revenue** — private-pay tuition + DHS subsidy + family gap payments, net of collections loss
- **Staffing** — derived from state child:staff ratios and rooms open, with a hire-lead-time lever
- **Expenses** — payroll + employer payroll tax, supplies (per child), overhead, insurance, marketing
- **Net income** per month, and **cash balance** carried forward from startup capital
- **Break-even enrollment**, **month of first profit**, **lowest cash point**, **total cash needed**

The cash balance is the structural analog of the retirement calculator's portfolio balance;
"does the program run out of cash before it turns profitable" is the analog of portfolio survival.

---

## 2. What carries over from the retirement calculator

| Retirement calculator | Childcare calculator |
|---|---|
| `engine/resolver.js` — `{default, byAccount?, byYear?, byAccountYear?}` | same primitive, `{default, byGroup?, byMonth?, byGroupMonth?}` — **plus sticky month keys** (§3) |
| `byYear` (absolute calendar year) | `byMonth` (signed offset from opening, §3) |
| `byAccount` (per financial account) | `byGroup` (per age group: toddler / preschool / infant) |
| `ui/setting-control.js` — Simple/Expand knob w/ live preview | same, with a month-timeline editor instead of a year list |
| `inflation` + `medicalInflation` — separate compounding escalators | `inflation`, `wageGrowth`, `insuranceGrowth`, `tuitionGrowth` — same `cumulative*` pattern |
| `ui/scenarios.js` — save frozen named scenarios, compare 2–4 | same, near-verbatim. The doc already thinks in scenarios (A–E). |
| `solveMaxSustainableSpending()` — binary search over `project()` | `solveBreakEvenEnrollment()` + `solveMinimumStartupCapital()` — same search-over-project shape |
| `engine/tax.js` — brackets, indexed year tables | `engine/payroll.js` — employer FICA/FUTA/SUTA + a verified-figures JSON with `_meta`, same convention |
| `ui/projection-view.js` — chart + table + expandable row detail | same, months on the x-axis, one detail panel per month row |
| `ui/project-adapter.js` — the one state→engine mapping | same |

**Reuse mechanics:** copy `resolver.js`, `dom.js`, `formats.js`, `chart-utils.js`, `setting-control.js`
into the new repo rather than sharing a package. They're small, dependency-free, and the childcare
version needs real changes to the resolver anyway (sticky keys). A shared package for two static
GitHub Pages sites costs more than it saves.

---

## 3. The month axis and sticky overrides

**Indexing.** Signed integer offset from opening. `-2`, `-1` = pre-open (licensing, deposits,
signage, pre-launch ads, any staff hired early); `0` = opening month; `1…M` = operating months.
The plan's real calendar start date is stored once, separately, so the table can display
"Mar 2027" while the model works in offsets — and so slipping the open date shifts the whole
plan without re-keying a single override.

**Sticky resolution** — the main improvement over the retirement calculator, whose `byYear` is a
strict exact match (`engine/resolver.js:36`), meaning every changed period needs its own entry.
Fine for 40 sparse years, miserable for 60 months.

`byMonth` keys carry an explicit suffix:

- `"6+": 4200` — **step**: applies from month 6 onward until a later key supersedes it
- `"6": 4200` — **spike**: that single month only

Resolution order for month `m`: exact `"m"` → the largest step key `"k+"` where `k <= m` →
`byGroup` → `default`. Spikes punch one-month holes in the step function; both live in one map, so
the saved JSON reads as a timeline. Real spike cases from the doc: the $879 licensing fee,
insurance binder deposits, the yard-signage buy.

`byGroupMonth` composes the same way (`"toddler|6+"`).

The UI for this is a **timeline strip**, not a list of rows: a horizontal month axis where you
click a month and type the new value, and the strip renders the resulting step function so you can
see "tuition is $1,100 from open, $1,175 from month 13" at a glance.

---

## 4. Variable inventory

Tagged: **[doc]** stated in the business plan · **[derive]** computed, not entered ·
**[decide]** needs your input · **[verify]** needs an external figure I should not guess at.

### Decisions made 2026-08-02

- **Enrollment: absolute target per month** (sticky). You type the enrollment you expect; the
  model does not accumulate a ramp. Capacity still clamps physically, but a target above capacity
  is reported as an explicit `unserved` figure per group per month — surfaced in the table and in
  the transitions narration — rather than silently lowering your number. An invisible clamp would
  make the model disagree with what you typed for reasons you can't see.
- **Facility/rent: undecided** — build the line in, default `$0`, visible and easy to turn on.
- **TN ratios + DHS rates: research and verify**, with citations, before the engine relies on them.
- **DHS: full model in v1** — mix %, per-group reimbursement rate, derived family gap, and a
  reimbursement payment lag that affects cash timing without affecting the P&L.

### 4.1 Program structure

| Variable | Source | Notes |
|---|---|---|
| Age groups | [doc] | Toddler (2–3), Preschool (3–5); Infant deferred to a later phase but should exist in the model as a group you can turn on |
| Rooms, and seats per room | [doc] | Y1: toddler room 12, preschool rooms 24 (2 rooms?) — **[decide]** is preschool 2 rooms of 12, or 1 of 24? Ratios and staffing depend on it |
| Room age group vs licensing rule | [design, 2026-08-02] | Two different questions: `group` is which ENROLLMENT group the children belong to (tuition, DHS band, target); `ratioRule` is which licensing row governs the room. The second normally follows from the first, so it is OPTIONAL and inherited (`resolveRoomRules`). Stated only to override — one age group can occupy a 3-year-old room at 1:9 beside a 4–5 room at 1:16 |
| Long-run capacity | [doc] | 6 rooms × 21 + 1 room × 12 = 138 |
| Room-open schedule | [doc, phased] | Which month each room opens — a natural sticky-override setting |
| Licensed child:staff ratio, per age group | [verify] | TN DHS ratios by age. I will not guess these; they drive every payroll number. Same treatment as `tax-tables.json` — a verified JSON with a `_meta` citation |
| Max group size per room | [verify] | TN also caps group size independent of ratio |

### 4.2 Enrollment

| Variable | Source | Notes |
|---|---|---|
| Starting enrollment at open | [doc] | 12–14 |
| Enrollment ramp | [doc, implied] | The phases imply ~14 → 18–20 → 24–26 → 30–36. **[decide]** model as *net adds per month* (a sticky setting) or as an *absolute enrollment target per month*? I lean net-adds-per-month with capacity clamping, so capacity constraints bind visibly |
| Monthly attrition / churn | [decide] | Not in the doc. Families move, age out, drop. Even 2–3%/mo materially changes the ramp |
| Waitlist size | [doc, strategy] | Optional cap on how fast adds can happen |
| Capacity clamp | [derive] | min(rooms open × seats, ratio-feasible given staff) |

### 4.3 Revenue

| Variable | Source | Notes |
|---|---|---|
| Monthly tuition, per group | [doc] | Toddler $1,250, Preschool $1,100 |
| Tuition escalator | [decide] | Annual increase %, its own compounding rate |
| Share of children on DHS assistance | [decide] | The doc says hybrid but never states the mix. This is one of the highest-leverage unknowns |
| DHS reimbursement rate, per group | [verify] | TN DHS certificate rates are published by county and age. Real numbers exist |
| Family gap payment | [doc] | $100–$250/mo — note this is *derived* from tuition − DHS rate in reality; **[decide]** whether to model gap as an input or derive it and let the doc's range be a sanity check |
| DHS payment lag | [decide] | State reimbursement typically arrives weeks-to-a-month behind. Pure cash-flow item, invisible in P&L, potentially decisive for runway |
| Collections loss / bad debt % | [decide] | On the family-paid portion |
| Registration / supply fees | [decide] | One-time per enrollment — common revenue line, absent from the doc |
| Operating hours | **[Jake, undecided]** | Licensed 6am–6pm; actual hours TBD. §4.9 prices the choice |
| Schedule types | **[Jake]** | Full day / half day AM / half day PM / part-week, each with arrive+depart hours, days/week, a tuition multiplier, and a DHS full-vs-part-time flag. §4.9 |
| Schedule mix per group | [decide] | What share of each group is on each schedule — drives both revenue and seat sharing |
| Part-time tuition multiplier | **[ask Jake]** | DHS pays exactly half (verified). Private-pay is normally 60–70%, not 50% — needs his pricing call. §4.9 |
| Food program reimbursement (CACFP) | [decide] | A real revenue line for licensed centers; absent from the doc |

### 4.4 Staffing and payroll

| Variable | Source | Notes |
|---|---|---|
| Teachers required | [derive] | ceil per room from ratio + rooms open. The doc's phases (2 → 3 → 4 → 5 teachers) should fall out of this, not be typed in — that's the model earning its keep |
| Hire lead time | [doc, risk] | "Hiring too early" is named as a top risk. **Per role, in DAYS** — a director is recruited months out, a floater in a fortnight. A lead under one month is PRORATED, not charged whole (2026-08-02) |
| Manual staffing override | [decide] | You should be able to force a headcount in a month regardless of what the ratio says — sticky setting, same as everything else |
| Wage per role | [Jake] | Hourly × hours/week. Lead $20–21, teacher $18, floater $17, director $26. See §4.8 |
| Roles + headcount rules | [Jake] | Lead ≈1/classroom, teacher = ratio remainder, floater = a pool (the buffer lever), director ×1. §4.8 |
| Early-hire premium | [Jake] | First N hires in a role paid above later ones — a fragility premium. Needs a per-role hire-index axis. §4.8 |
| Market comp range per role | **[ask Jake]** | min/mid/max, to compute compa-ratio. He has researched this |
| Turnover ↔ compa-ratio | [decide, §4.8] | User-adjustable relationship. An explicit assumption, not an empirical constant |
| Turnover cost | [decide, §4.8] | Vacancy coverage (mandatory — ratios are law), recruiting, ramp, and enrollment loss |
| Director: PT → FT | [doc] | Phase 4. A sticky override on director hours |
| Employer payroll tax burden | **[resolved, §4.8]** | The doc's payroll figures are gross wages, excluding employer FICA/FUTA/SUTA — confirmed by reconciling Jake's rates against both ends of the ramp. Computed explicitly in `engine/payroll.js` |
| Benefits / paid time off | [decide] | Absent from the doc. Substitutes are handled via the floater pool + vacancy coverage |
| Wage growth escalator | [decide] | The doc itself names low wages as a sector-wide staffing problem |

### 4.5 Expenses

| Variable | Source | Notes |
|---|---|---|
| Supplies, per child per month | [derive from doc] | $1,680/14 = $120; $4,320/36 = $120. Cleanly per-child — good, model it that way |
| Overhead | [doc] | $2,500/mo at 14 kids, $3,000 at 36. Semi-fixed: **[decide]** flat + per-child step, or just a sticky monthly figure? |
| Rent / facility charge to the church | [decide] | **Not in the plan at all.** If the church charges the program nothing, the margins are real but not comparable to a standalone center. Worth an explicit `$0` rather than an omission |
| Utilities, cleaning, maintenance | [decide] | Possibly inside "overhead" — worth splitting |
| Food cost | [decide] | Paired with CACFP above |
| Insurance | [doc, uncertain] | $6k–10k/yr expected, $12k–18k conservative. The doc explicitly flags this as provisional — a perfect case for a scenario comparison |
| Marketing | [doc] | Ads $500–1,000, signage $150–400 — mostly pre-open, plus **[decide]** an ongoing monthly amount |
| Licensing & compliance | [doc] | $879, pre-open; **[decide]** annual renewal? |
| Curriculum / training / background checks | [decide] | Recurring per-staff costs, absent from the doc |
| General inflation escalator | — | Applied to overhead/supplies, separate from wage and insurance escalators |

### 4.6 Cash and startup

| Variable | Source | Notes |
|---|---|---|
| Startup capital / church contribution | [decide] | The doc gives startup *costs* ($2,200–4,000) but never says what cash the program starts with |
| Startup costs by month | [doc] | Licensing, insurance binder, signage, ads — placed in months −2/−1 |
| Build-out / equipment / furnishing | [gap] | **Not in the plan.** Cribs, cots, tables, playground, fencing, kitchen — this is usually the largest startup line by far, and $2,200–4,000 total is implausibly low unless the facility is already fully equipped and licensed-ready |
| Church profit distribution / retained cash | [decide] | Does surplus stay in the program or transfer out monthly? Affects runway |

---

## 4.7 Verified Tennessee figures (researched 2026-08-02)

All in `data/tn-childcare.json` with `_meta` citations. Both primary sources were read directly —
a secondary source found first (hellosubs.co) stated 1:11 for both toddlers and preschool, which
is **wrong**; the actual rule is stricter.

**Ratios** — TN Rule 1240-04-01-.22(1)(c), Chart 1 (single-age), Nov 2025 revision:

| Age | Ratio | Max group |
|---|---|---|
| 6 wk – 15 mo | 1:4 | 8 |
| 12 – 30 mo | 1:6 | 12 |
| 2 years | 1:7 | 14 |
| 3 years | 1:9 | 18 |
| 4 years | 1:13 | 24 |
| 5 years | 1:16 | 24 |

Chart 2 (multi-age) matters more here, since rooms will be mixed: **2–3 years is 1:8 / max 16**,
**3–5 years is 1:13 / max 24**, 2½–5 years is 1:11 / max 20.

Two rules with real modeling consequences:
- **"More than 12 children present ⇒ a second adult must be physically available"** — binds at the
  12–14 launch enrollment independently of ratio, which is exactly why Phase 1 needs 2 teachers.
- A 10% ratio/group-size variance is allowed ≤3 days/week, **never** for infant or toddler groups.
  Not modeled by default — it's an exception, not a planning basis.

**Finding: the plan is staffed above the legal minimum.** At 36 children (12 toddler + 24
preschool), ratios require 2 + 2 = 4 staff; the plan budgets 5 plus a full-time director. At 18–20
children, ratios require 2; the plan budgets 3. This is good practice — breaks, sick days, ratio
coverage during transitions and openings — but it means the model must expose a **staffing buffer
above ratio minimum** as a lever, not assume minimum staffing. Payroll is the largest expense, so
this lever is where most of the margin sensitivity lives.

**DHS reimbursement** — Child Care Certificate Program, effective 2026-01-01. Davidson County is a
**Top Tier** county. Weekly, full-time, child care centers:

| DHS band | Weekly (top tier) | ≈ Monthly | Program tuition | Gap |
|---|---|---|---|---|
| Toddler (13–31 mo) | $240 | $1,040 | $1,250 | **$210** |
| Preschool (31 mo – K) | $208 | $901 | $1,100 | **$199** |
| Infant (6 wk – 13 mo) | $260 (+15% differential ⇒ $299) | $1,296 | — | — |

**Finding: the doc's "$100–$250 typical parent gap" checks out.** Both computed gaps land inside
that range, which independently validates the pricing model. Good sign for the plan's credibility.

Two things the doc doesn't account for:
- **QRIS quality bonus is a real, controllable lever** — +5% at a scorecard of 80–89, +10% at
  90–100, applied to DHS revenue only. Worth modeling as a toggle.
- **The DHS age bands don't line up with the program's rooms.** DHS switches from toddler to
  preschool rates at **31 months**, mid-way through the program's "Toddler (2–3 years)" room. A
  2-year-old generates $1,040/mo until 31 months and $901/mo after, in the same room at the same
  $1,250 tuition. Modeling groups purely by room will misstate DHS revenue.
- Toddler, child-care-desert, and non-traditional-hours differentials were **eliminated**
  2025-10-01. Only the infant and special-needs 15% differentials remain.

**Strategic note for the later infant phase:** infants carry the highest DHS rate ($299/wk with the
differential ≈ $1,296/mo) and the doc identifies the sharpest local shortage there ("only 1 in 5
infants has access"). But 1:4 with a max group of 8 makes them by far the most staff-expensive.
The calculator should be able to settle that question rather than leave it to intuition.

---

## 4.8 Compensation, roles, and turnover (from Jake, 2026-08-02)

The strategic premise: **pay above the midpoint of the market range to reduce turnover.** That
makes comp position a lever with a payoff, not just a cost — so the calculator has to model both
sides of it. This is the single most interesting piece of the model, because turnover is the one
assumption that touches payroll, staffing feasibility, *and* revenue at the same time.

### Roles and rates

| Role | Rate | Headcount rule |
|---|---|---|
| Lead teacher | $20–21/hr | Assumed 1 per classroom |
| Teacher | $18/hr | Ratio-driven remainder |
| Floater | $17/hr | **Not one per class** — a pool; this is the buffer lever (below) |
| Director | $26/hr | 1; part-time at launch, full-time by Phase 4 |

Roles are a first-class entity in the model, the way `accounts` are in the retirement calculator.
Each carries an hourly wage (a setting, so it can change by month), hours/week, and a headcount
rule. Monthly cost is `wage × hours/week × 52 ÷ 12`.

### Finding: the business plan's payroll excludes employer payroll taxes

Jake's rates reconcile with the plan's payroll line at both ends of the ramp — which pins down
what those figures do and don't include:

| | Gross wages | + employer FICA (7.65%) | Plan says |
|---|---|---|---|
| Phase 1 — 1 lead + 1 teacher + PT director | $8,927 | $9,610 | **$9,300** |
| Phase 4 — 3 leads + 2 teachers + FT director | $21,407 | $23,044 | **$22,000** |

Both plan figures sit between gross and gross-plus-FICA, much nearer gross. Two conclusions:

1. **Jake's rates are consistent with the plan** — they independently reproduce both payroll
   figures to within a few percent. The staffing model hangs together.
2. **The plan's payroll almost certainly excludes the employer's share of payroll taxes.**
   Adding employer FICA alone costs ~$680/mo at launch and ~$1,640/mo at Phase 4, and TN
   unemployment tax (SUTA + FUTA) sits on top of that. At launch that consumes roughly a third
   of the stated $1,800–2,100 net income — real net is closer to **$1,100–1,400**.

This resolves open issue §7.3. The model computes employer payroll tax explicitly rather than
folding it into a wage figure.

### Comp position → turnover

Measured as **compa-ratio** = paid wage ÷ market midpoint. Jake's "over mid" is a compa-ratio
above 1.0. Per role, the model needs a market range (min / mid / max) and the paid wage; the
compa-ratio falls out.

Turnover as a function of compa-ratio, applied per role:

```
annualTurnover = clamp(
  baseTurnoverAtMid × (1 − sensitivity × (compaRatio − 1)),
  floorTurnover,
  ceilingTurnover
)
```

Three user-adjustable knobs (`baseTurnoverAtMid`, `sensitivity`, `floorTurnover`), all settings,
so they can differ by role and by month.

**This relationship must be presented as an assumption, not as evidence.** Sector-wide childcare
turnover is well documented as high, and low wages are well documented as a driver — but there is
no credible published elasticity that says "1% above midpoint buys X% less turnover." I won't
manufacture one. The default will be a clearly-labeled starting guess, the UI will say so, and
the honest use of the feature is *sensitivity analysis*: "how good would this relationship have to
be for the raise to pay for itself?" That question the calculator can answer rigorously, and it's
the more useful question anyway.

### What turnover costs

The lever only pays for itself if the cost side is modeled. Four components:

1. **Vacancy coverage.** The big one, and it's not optional: ratios are a licensing requirement,
   so an empty seat must be covered by a substitute, overtime, or a floater — or the room closes.
   Running short is not a legal option, which is why this cost is unavoidable rather than a
   choice.
2. **Recruiting** — advertising, background checks (TN-required), onboarding admin.
3. **Ramp** — a new hire is not immediately at full effectiveness; modeled as a productivity
   discount over N weeks, or simply as a fixed onboarding cost.
4. **Enrollment loss.** Families leave when their child's teacher leaves. This is the component
   that makes turnover a *revenue* problem rather than a payroll problem, and it's why the whole
   lever matters. Modeled as: each departure has probability *p* of costing *k* enrolled children.

### Wage tiering by hire order — the fragility premium

Jake's idea: the first couple of teachers are paid a bit above the later ones, because at lean
staffing a single departure is catastrophic, and once a buffer exists the system can absorb one.

The reasoning is about **fragility**, so the model should key on it directly. Two ways to express
it, and I'd build both:

- **Simple (the default):** a per-role `earlyHirePremium: { count: 2, amount: 1.50 }` — the first
  N hires in a role get +$X/hr, held for as long as they're employed. Predictable, matches what
  you'd actually put in an offer letter, easy to reason about.
- **Derived (the interesting one):** premium as a function of the **coverage buffer** at the time
  of hire — staff on hand versus the ratio minimum. At zero buffer the premium is at maximum; it
  decays to zero as the buffer grows. This is Jake's stated reasoning expressed as a rule rather
  than a hardcoded "first two," and it self-adjusts if the ramp changes.

Mechanically this needs a third axis the retirement calculator never had: **hire index within a
role**. So staff are modeled as individual **seats** — each with a role, a hire month, and its own
wage — created as room and ratio requirements demand them. A seat's wage is
`resolve(wage, {roleId, month})` plus its premium. Seats also give turnover somewhere to live: a
departure is a seat ending and a new one starting, with all four costs above attached.

### The floater is the buffer lever

Worth calling out because it ties the whole section together. Floaters cost $17/hr and don't
belong to a classroom — but they're what covers breaks, absences, and vacancies while keeping
ratios legal. So floater headcount is simultaneously:

- a payroll cost,
- the thing that makes ratio compliance survivable during breaks and callouts,
- and the thing that absorbs turnover without emergency substitute costs or a room closure.

Which means there's a real optimum, and the calculator can find it: **how many floaters, and how
far above midpoint, minimizes total cost including the revenue lost to turnover?** That's a
solver in the same family as the retirement calculator's `solveMaxSustainableSpending` — a search
over `project()`, not a mode of it.

**Open question for Jake:** he mentioned a comp range he'd already researched. The actual min /
mid / max per role would be much better than reverse-engineering a midpoint from the target wage.

---

## 4.9 Operating hours and enrollment schedules (2026-08-02)

Licensed 6am–6pm; actual hours undecided. Broader hours widen the applicant pool but cost staff.
Some children full day, some partial. Both questions turn out to share one mechanism.

### Finding: ratio slots are not full-time employees

The largest thing this section surfaces. `engine/capacity.js` answers "how many adults do N
children require" — a ratio at a **moment**. That is not what payroll costs. You pay for adults
present across the whole operating day, and one adult on the floor all day is more than one
employee.

| Operating day | Adults on the floor | Weekly staff-hours | **FTE at 40 hrs** |
|---|---|---|---|
| 9 hours (7:30–4:30) | 2 | 90 | **2.25** |
| 10 hours (7–5) | 2 | 100 | **2.50** |
| 12 hours (6–6, full license) | 2 | 120 | **3.00** |

The business plan's phase table reads as headcount — "Phase 1: 12–14 students, 2 teachers." Two
adults is the correct ratio answer for 14 children at 1:13. But **two 40-hour teachers cannot keep
two adults on the floor for a nine-hour day.** It takes 2.25 people, and 3.0 across the full
license. This compounds with §4.8's finding that the payroll figures also exclude employer payroll
taxes — the two gaps are independent and both point the same direction.

The gap is reported as `ftePerPeakAdult`, and it is the number to watch: at a 9-hour day it's
1.125, at 12 hours it's 1.5.

### What extended hours actually cost

Not as much as the table above implies, because **ratio scales with children present**. Opening at
6am costs nothing if no one comes at 6am — the cost arrives with the families who use the hours.
So the honest model needs intra-day occupancy, which is what `engine/schedule.js` does: it cuts
the day into blocks at every boundary where the set of children present changes, and evaluates
ratio once per block.

TN Rule 1240-04-01-.22(1)(c)3 supplies the block boundaries for free. Chart 3 permits combined
grouping at a more permissive ratio (2½–5 years at 1:11 instead of 1:13) for "the first/last hour
and one half of each day **only**" — which is precisely the state's accommodation for extended
hours, and precisely where the fringe blocks fall.

Concrete answer to Jake's question: with a handful of families using a 6am–6pm span, the fringe
costs **one adult over two 1.5-hour windows, five days a week — 15 staff-hours, 0.375 FTE, about
$1,170/mo at $18/hr.** `compareOperatingHours()` computes this for any pair of configurations. The
cost side is exact; the benefit — how many more families apply — stays an assumption, because no
model can tell you that.

### Full day vs. partial day

**Verified:** DHS prices part-time at exactly **half** the full-time rate, rounded up (it's in
`data/tn-childcare.json`). Part-time preschool in Davidson County is $104/wk against $208.

**Industry practice, not verified for this market:** private-pay part-time is normally priced
*above* pro-rata — a half day typically runs 60–70% of full-day, not 50% — because a seat's cost
isn't linear in hours. Staffing, rent, and insurance don't halve.

**The asymmetry that creates is the thing to model.** DHS pays exactly half; costs don't halve.
A half-day child present in the morning needs the same adults as a full-day child while they're
there — there's a test pinning this (14 half-day children still require 2 adults). So **part-time
DHS children are systematically less profitable than full-time ones**, and that should be visible
per schedule type rather than buried in an average.

**Where part-time earns its keep** is seat sharing: ratios bind on children *present*, so two
complementary half-day children occupy one seat and enrollment can exceed physical capacity.
`seatUtilization()` reports `enrolledPerSeat` and `seatFillRate` — but only complementary
schedules tile. Two AM-only cohorts don't share a seat, they leave it empty every afternoon
(`enrolledPerSeat` 1.0, `seatFillRate` 0.5). Both cases have tests, because "part-time lets you
enroll more children" is true only under a condition that's easy to assume away.

**Strategic note.** Jake's instinct to select for a narrower time range at first is well founded,
and now quantifiable: a tight schedule band concentrates children into fewer blocks, which
maximizes ratio efficiency and minimizes fringe coverage. The tradeoff is a smaller applicant
pool. That's exactly the shape of question the calculator should answer — cost side exact,
enrollment side an assumption you vary.

**Known simplification:** part-week schedules (MWF vs T/Th) are averaged rather than laid out on a
real weekly grid, so `peak` may overstate staffing when two part-week cohorts actually peak on
different days. Overstating a licensing requirement is the safe direction to be wrong in; a real
weekly grid is a later refinement.

---

## 4.10 Phase 2 results (2026-08-02)

The month loop runs end to end. Two of the business plan's own revenue figures reproduce
**exactly** from verified rates, which is a strong check that the model matches the plan's intent:

- §7 blended at 36 children: 12 toddler × $1,250 + 24 preschool × $1,100 = **$41,400** ✓
- §13 all-Pre-K at 36 children: 36 × $1,100 = **$39,600** ✓

The cost lines reproduce too: supplies are cleanly $120/child/mo at both 14 and 36 children, and
overhead fits a semi-fixed line of $2,182 base + $22.73/child through both of the plan's
observations.

### The accrual/cash split is bigger than it looks

A one-month DHS lag at a 50% subsidy mix ties up a **$16,640 receivable** at full Year 1
enrollment. That is not a one-month timing quirk that washes out — during a ramp the hole grows
every time enrollment does, and it never comes back. It is invisible in a P&L and it is a direct
claim on the cash the church must front. `receivable` is a running balance in every row for
exactly this reason.

### Known gap: payroll is ratio-required classroom staff only

Phase 2 derives payroll from staff-hours, which correctly captures §4.9's operating-hours effect.
But it has no concept of ROLES yet, so at 36 children it produces:

| | Monthly |
|---|---|
| Phase 2 derived payroll (ratio-required classroom staff, 4.5 FTE) | $16,701 |
| + full-time director (not yet modeled) | $4,851 |
| + the 5th teacher the plan budgets above the ratio's 4 | $3,545 |
| **= realistic payroll** | **$25,098** |
| *plan's $22,000 gross, with employer tax added* | *$23,683* |

So the model currently **understates payroll by roughly a third** at full enrollment, and any net
income it reports before Phase 3 is optimistic. With the director and buffer added by hand, net at
36 children is about **$7,400/mo against the plan's ~$11,000** — the gap being employer payroll
taxes plus the staff-hours effect, the two findings from §4.8 and §4.9 compounding as expected.

Phase 3 replaces the blended-wage derivation with real per-role seats and closes this.

---

## 4.11 Phase 3 results (2026-08-02) — the launch does not break even

With real roles, employer taxes, and turnover in place, the model contradicts the business plan's
central claim about the launch phase. The plan says Phase 1 is "near break-even" with net income
of $1,800–2,100/mo. The model says the launch phase **loses about $2,000/mo**, and on $25,000 of
starting cash the program **goes cash-negative in month 2**.

Three independent errors, all in the same direction, and together they account for the entire
claimed profit:

**1. Launch revenue assumes children the phasing doesn't allow.** The plan's $16,100 at 14
children implies $1,150/child — a blended toddler ($1,250) and preschool ($1,100) rate. But the
plan's own phasing is preschool-first: the toddler room doesn't open until Phase 3. At launch only
preschool is open, so 14 children is **14 × $1,100 = $15,400**. The blended rate overstates launch
revenue by about **$700/mo**.

**2. Employer payroll taxes are missing** (§4.8). About **$680/mo** at launch.

**3. Capacity constrains launch below the target anyway.** A single 12-seat room cannot hold the
14 children the revenue figure assumes. Either the launch room needs 14 seats — legal, since max
group size for 3–5 year olds is 24 — or launch revenue is a further ~$2,200/mo lower.

Items 1 and 2 alone total roughly **$1,380/mo against a claimed $1,800–2,100**. Add scaled
overhead, ongoing marketing, and turnover and the launch phase is underwater until the second
classroom opens.

**This is not a reason to abandon the plan.** The model shows it turning sustainably profitable in
**month 4** when the second room opens, and reaching ~$3,600/mo net at full Year 1 enrollment.
The plan's *strategy* — launch lean, prove demand, add rooms as enrollment supports them — holds
up. What fails is the claim that the launch phase pays for itself. It needs to be funded through
roughly four months of losses, and **the cash requirement is about $27,500, not the $2,200–4,000
of startup costs the plan lists**.

### What the model says at full Year 1 enrollment (month 12, 36 children)

| Role | Count | Avg wage | Monthly |
|---|---|---|---|
| Lead teacher | 3 | $21.46 | $11,159 |
| Teacher | 2 | $20.34 | $7,052 |
| Floater | 1 | $17.80 | $3,085 |
| Director | 1 | $27.22 | $4,718 |
| **Gross wages** | | | **$26,014** |
| Employer FICA | | | $1,990 |
| **Total payroll** | | | **$28,004** |

Against $40,905 revenue and $37,330 total expenses, that is **$3,575/mo net** — against the plan's
~$11,000. Staffing is one person above the plan's five-teacher structure, because the model adds a
floater the plan doesn't budget.

### The comp/turnover finding: paying above midpoint cannot be justified on turnover savings

`breakEvenSensitivity()` produced an algebraic surprise. Writing out the break-even condition,
**both the raise size and the headcount cancel**:

```
costPerDeparture = (hours · 52 · load · midpoint) / (baseTurnover · sensitivity)
```

So whether an above-midpoint raise pays for itself does **not** depend on how big the raise is or
how many people get it. A larger raise costs proportionally more *and* moves compa-ratio
proportionally further.

At Jake's numbers — $18 midpoint, 40 hours, 35% baseline turnover, and a generous sensitivity of
1.5 — a single departure would have to cost **~$77,000** for the raise to break even. Typical
direct replacement cost in this sector is nowhere near that, and the model's own turnover line at
full enrollment is only ~$880/mo.

**The honest conclusion: the case for paying over mid is not expected-value, it's fragility.** At
lean staffing one departure can put the program out of ratio and force a room to close — a
licensing event, not an incremental cost. That is a tail-risk argument, and it is exactly why the
early-hire premium is keyed to the coverage buffer rather than applied flat. Jake's instinct is
sound; the justification he'd give a board should be risk, not ROI.

**Known choice:** the early-hire premium is a flat dollar differential and does not escalate with
wage growth, so it erodes in real terms. Defensible (it's how a differential usually reads in an
offer letter) but worth revisiting.

---

## 4.12 Phase 4 results (2026-08-02) — the solvers

`engine/solve.js`. Each solver runs the whole projection repeatedly against a varied input;
none is a mode of `project()`. Search method is chosen per problem rather than reaching for
binary search everywhere — minimum capital is algebraic, break-even enrollment is a staircase
(staff arrive in whole people, so an integer scan is exact where bisection can land mid-step),
and required tuition is genuinely continuous.

### Finding: the launch phase cannot break even at any enrollment

The business plan states two break-even points: "Lean startup: 12–14 students" and "Full
staffing: 22–24 students."

| | Plan says | Model says |
|---|---|---|
| Lean launch (1 room) | 12–14 children | **Not achievable at any enrollment** |
| Two rooms open (month 4+) | — | **23 children** |
| Full staffing (3 rooms) | 22–24 children | **34 children** |

**The plan's full-staffing figure is very nearly right** — 23 against a stated 22–24, arrived at
independently. That's a good sign for the rest of its cost work.

**The lean launch figure is not.** At a single 14-seat room with a lead, a teacher, and a
part-time director, no enrollment the room can legally hold covers the cost. Breaking even at
launch capacity would take tuition of about **$1,509** against the planned $1,100 — a 37%
increase. The launch phase is a deliberate investment, not a self-funding step, and it should be
presented that way.

### Finding: each room you open raises your break-even

Break-even rises from 23 children (two rooms) to 34 (three rooms), because opening a room adds
staff before it adds children. This is exactly the "overexpansion" risk the plan names in §10, now
quantified: **a room opened ahead of demand moves the break-even line away from you faster than it
adds capacity.** The phased strategy is right; the sequencing needs to follow enrollment, not a
calendar.

### Finding: the cash requirement is an order of magnitude above the plan's startup costs

Under a realistic configuration (38-child target, 50% DHS mix with a one-month reimbursement lag,
one month of hire lead time, 3% monthly attrition):

| | |
|---|---|
| Deepest cash point | **−$46,101**, in month 4 |
| Required starting capital, with a $10k operating floor | **$56,101** |
| The plan's stated startup costs | $2,200–4,000 |

Those are different quantities and the plan only ever names the second. Startup *costs* are the
licensing fee, signage, and ads. What the church actually has to front is **the accumulated
operating loss until the program turns**, plus the DHS receivable, plus a working buffer. Nothing
in the plan document currently asks for that number.

Sensitivity worth stating plainly: this figure moves a lot with the DHS mix and lag, with hire
lead time, and with how fast enrollment ramps. It is not a precise forecast — it is the right
order of magnitude, and it is tens of thousands rather than thousands.

### Attrition, and why it is reported rather than applied

Enrollment is an absolute target (§4.2), so attrition must not silently shrink it — that would
make the model disagree with the number you typed. Instead it reports **replacement demand**: at
3% monthly churn, a 38-child program loses about **1.14 children a month** and must therefore
enrol 1.14 new families a month just to stand still. In a growth month the requirement is
replacements *plus* the increase. That reframes attrition as the marketing and waitlist question
it actually is, and it feeds an optional per-acquisition cost line.

### Hire lead time

Deferred from Phase 3, now in. `project()` runs in two passes — enrollment and coverage first for
every month, then money — because staffing in month *m* must be able to see the enrollment of
month *m + lead*, which a single forward pass cannot do. Hiring a month early is visible in the
row as `staffing.hiringAhead`, and it costs real money with no revenue against it, which is the
plan's own "hiring too early" risk made explicit rather than assumed away.

**Fixed while building this:** `summarize()` reported `runsOutOfCash` for a plan funded to
*exactly* the solved minimum, because accumulated floating-point error on a long chain of monthly
flows landed a hair below zero. Now tolerant to half a cent. Found by a solver asserting its own
answer was sufficient — the kind of bug that only shows up when two parts of a system check each
other.

---

## 5. Engine layout

```
engine/
  resolver.js       the override resolver + sticky month keys (§3)
  capacity.js       rooms + ratios -> licensed capacity, staff required
  enrollment.js     ramp + attrition + capacity clamp -> children per group per month
  revenue.js        tuition, DHS split, gap, collections, payment lag
  schedule.js       operating hours, day blocks, schedule types -> occupancy + staff-hours (§4.9)
  staffing.js       roles + seats: how many of each, at what wage, incl. the early-hire premium
  turnover.js       compa-ratio -> turnover rate -> departures + their four costs (§4.8)
  payroll.js        seats -> wages + employer taxes (FICA on; FUTA/SUTA off pending nonprofit
                    status -- see the module header, it is a real legal question)
  expenses.js       per-child / fixed / escalated cost lines
  project.js        the month loop: ties it together, carries cash forward
  solve.js          minimum startup capital (algebraic), break-even enrollment (integer scan,
                    because the answer is a staircase), required tuition (bisection), and the
                    floater/comp grid (§4.8) — searches OVER project(), not modes of it
data/
  tn-childcare.json ratios, group sizes, DHS rates — VERIFIED with citations, or clearly marked TBD
  payroll.json      FICA/FUTA/SUTA rates and wage bases, per year
```

Same discipline as the retirement calculator: `engine/` is pure, unit-tested with golden numbers,
no DOM, no personal data. Every doc figure above becomes a test case — the model should reproduce
the doc's Scenario A ($16,100 rev / ~$14,000 exp) and Scenario B before it's trusted for anything new.

---

## 6. Outputs

- **Month table** — enrollment, staff, revenue, expenses, net, cash balance; one expandable
  detail panel per month (the consolidated-panel design the retirement calculator landed on)
- **Chart** — cash balance + monthly net over time, with markers for room openings and the
  break-even month
- **Stat tiles** — break-even enrollment, first profitable month, lowest cash point, total cash
  required, Year 1 revenue/net, margin
- **Transitions narration** — "room 2 opens", "4th teacher hired", "break-even reached",
  "cash goes negative" — the `transitionsFor()` pattern, which fits this domain even better
- **Scenarios** — the doc's A–E, plus the insurance-uncertainty and DHS-mix cases

---

## 7. Issues found in the business plan

1. **Startup costs look far too low.** $2,200–4,000 covers licensing, insurance, signs, and ads —
   no furniture, equipment, playground, fencing, kitchen, or facility modification. Either the
   space is already fully equipped and license-ready, or this line is missing a large number.
2. **No rent or facility cost.** If the church absorbs it, that should be an explicit $0
   assumption, because it means these margins can't be compared to a standalone center's.
3. ~~**Payroll tax treatment is unstated.**~~ **RESOLVED 2026-08-02 (§4.8): the payroll figures are
   gross wages, excluding the employer's share.** Jake's per-role rates reproduce both $9,300 and
   $22,000 to within a few percent as gross wages. Employer FICA alone adds ~$680/mo at launch,
   cutting the stated $1,800–2,100 net to roughly $1,100–1,400 before TN unemployment tax.
4. **Revenue at 36 kids appears twice with different numbers** — $41,400 (§7) vs $39,600 (§13).
   §13 explains this (all-Pre-K vs blended mix), so it's intentional, but the model should be
   explicit about which mix it's using.
5. **No DHS mix percentage**, despite "hybrid" being the model's name — and DHS rates are usually
   below private tuition, so this single number moves revenue substantially.
6. **No attrition assumption.** The phase progression reads as pure net growth.
7. **Scale scenarios C–E use a flat expense ratio** (~60% of revenue) rather than building up
   from rooms, ratios, and staff. Fine as an illustration; the calculator should build them up
   properly and see whether they hold.
8. **No cash-flow timing.** DHS reimbursement lag and the fact that startup spending precedes
   any revenue are exactly what determine how much cash the church must front.

None of these block building — they're what the calculator is *for*.

---

## 8. Build order

1. ~~**Phase 0** — repo skeleton, `resolver.js` with sticky month keys + its test suite~~ **DONE**
   (25 tests). Repo: `github.com/vega4speed/daycare-calculator`.
2. ~~**Phase 1** — capacity/ratios, pure, tested against the doc's phases~~ **DONE**
   (`engine/capacity.js`, 25 more tests). Rooms, the seats-vs-group-size distinction, the opening
   schedule, target allocation with a visible `unserved` surface, ratio-derived staffing including
   the second-adult floor, and `coverageBuffer` (the fragility measure §4.8's premium keys on).
   The doc's phase staffing reproduces: 14 children ⇒ 2 adults, 36 across 3 rooms ⇒ 4.
3. ~~**Phase 2** — revenue, expenses, net, cash. Reproduce Scenario A + B~~ **DONE**
   (`engine/schedule.js`, `revenue.js`, `expenses.js`, `project.js`; 137 tests). Reproduces the
   plan's $41,400 and $39,600 revenue figures exactly, and its supplies/overhead cost curves.
   See §4.9 (hours) and §4.10 (results + the payroll gap Phase 3 closes).
4. ~~**Phase 3** — roles + seats, the early-hire premium, employer payroll taxes, turnover~~
   **DONE** (`engine/staffing.js`, `payroll.js`, `turnover.js`; 193 tests). See §4.11 — the launch
   phase does not break even, and the comp-above-midpoint case is fragility, not ROI.
   *Deferred from this phase:* hire lead time (hiring N months ahead of the enrollment that
   justifies it) — the seats model supports it, but it needs a demand-lookahead pass.
5. ~~**Phase 4** — DHS split, collections, payment lag~~ **PULLED FORWARD into Phase 2**
   (revenue needed it). Phase 4 instead delivered the **solvers** (`engine/solve.js`), plus the
   **hire lead time** deferred from Phase 3 and **attrition** from the variable inventory.
   220 tests. See §4.12 — the launch cannot break even at any enrollment, and the real cash
   requirement is ~$56k, not the $2,200–4,000 of startup costs the plan names.
6. ~~**Phase 5** — UI~~ **DONE.** `index.html` + `ui/`. Rooms and roles editors, the sticky-override
   timeline control (a step chart you edit directly), headline tiles, a findings panel that states
   the §4.11/§4.12 conclusions in words above the fold, a cash+net chart, and a month table with a
   per-month breakdown incl. transitions narration. Export/Import/Reset, localStorage.
7. **Phase 6** — solvers (break-even, minimum capital), transitions narration
8. ~~**Phase 7** — scenarios + comparison~~ **DONE.** `ui/scenarios.js`. Save the current plan as a
   named FROZEN copy, compare 2–4 side by side: a cash-balance chart (validated categorical
   palette, colour assigned once per scenario at save time so it never repaints when the selection
   changes), a headline table, and a "what differs" diff so you can see what you actually changed.
9. ~~**Phase 8** — enable GitHub Pages~~ **DONE.** Live at
   https://vega4speed.github.io/daycare-calculator/ — served from `main` at the repo root, no
   build step, verified rendering with the tables loading over https.

**All planned phases are complete.** Remaining work is in the open questions of §4 (Jake's comp
range, part-time tuition, the DHS infant differential, and unemployment-tax coverage) plus the
known simplifications noted throughout — not in the build.
