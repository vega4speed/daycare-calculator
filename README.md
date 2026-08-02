# Daycare Calculator

A month-by-month financial model for launching a childcare program — enrollment, licensing-driven
staffing, revenue (private pay + state subsidy), expenses, and cash runway.

Static, zero-dependency, vanilla JS, no build step. Hostable on GitHub Pages.

## What it answers

- What enrollment do we need to break even, and in which month do we get there?
- How much cash does the sponsor need to front before the program funds itself?
- How many staff does each enrollment level legally require, and what does that cost?
- What happens if the DHS subsidy mix, insurance quote, or enrollment ramp comes in worse
  than planned?

Assumptions can be set once and changed at any month — see "sticky overrides" below.

## Status

**Phases 0–2 complete.** The override resolver, capacity/ratios/staffing, operating hours and schedules, revenue, expenses, and the month loop with cash carry. See `PLAN.md` for
the full design, the variable inventory, verified Tennessee figures, and the build order.

```
PLAN.md                  design plan, variable inventory, open questions
engine/resolver.js       the override resolver (month axis, sticky keys)
engine/capacity.js       rooms, licensing ratios, and the staff they require
engine/schedule.js       operating hours, day blocks, occupancy, staff-hours
engine/revenue.js        tuition, DHS subsidy, the family gap, collections
engine/expenses.js       per-child / semi-fixed / fixed cost lines and escalators
engine/project.js        the month loop: cash carry, DHS payment lag, headline answers
data/tn-childcare.json   verified TN licensing ratios + DHS reimbursement rates, cited
test/                    node:test suites — 137 passing
```

## Sticky overrides

Every adjustable knob is a setting: `{ default, byGroup?, byMonth?, byGroupMonth? }`, resolved
most-specific-first. Months are **signed offsets from opening** — `-2`, `-1` are pre-open,
`0` is the opening month — so slipping the open date shifts the whole plan without re-keying
anything.

Month keys resolve as a **step function**, not an exact match:

```js
{ default: 1100, byMonth: { '13+': 1175, '-2': 879 } }
```

- `'13+'` — a **step**: $1,175 from month 13 onward, until a later step supersedes it
- `'-2'` — a **spike**: applies to month −2 only (a licensing fee, an insurance binder)

So an assumption that changes three times over five years takes three entries, not sixty.

## Running

- **Tests:** `npm test` (runs `node --test` over `test/*.test.js`, nothing to install)
- **App:** not yet built — see `PLAN.md` §8

## Data

No real financial data lives in this repo. `data/tn-childcare.json` holds public Tennessee
licensing and subsidy figures, every one of them verified against a primary source and cited in
its `_meta` block.
