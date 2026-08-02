// projection-view.js — the output half of the app: headline answers, chart, and month table.
//
// Design priority: the model now says several things the business plan does not, and some of them
// change what the sponsor has to do. Those belong at the TOP, in words, before any table. A
// finding buried in row 14 of a spreadsheet is a finding nobody acts on.

import { h, s, clear } from './dom.js';
import { COL, usd, usdFull, niceCeil } from './chart-utils.js';
import { monthLabel } from './state.js';
import { transitionsFor } from './project-adapter.js';

const pct = (v) => (v == null ? '—' : `${(v * 100).toFixed(1)}%`);
const n0 = (v) => Math.round(v ?? 0).toLocaleString();
// Headcount can be fractional: a sub-month hire lead puts someone on payroll for part of a month,
// and half a person for half a month is half a person in any figure you would divide by. Show one
// decimal when it is not whole rather than dumping the raw float.
const people = (v) => {
  const n = v ?? 0;
  return Number.isInteger(n) ? String(n) : n.toFixed(1);
};

export function createProjectionView(container) {
  let result = null;
  let state = null;
  const expanded = new Set();

  function tile(label, value, note, tone) {
    return h('div', { class: `tile${tone ? ' tile-' + tone : ''}` },
      h('div', { class: 'tile-label' }, label),
      h('div', { class: 'tile-value' }, value),
      note ? h('div', { class: 'tile-note' }, note) : null);
  }

  /** The findings panel — what the model says that the plan does not. */
  function findings() {
    const { solved } = result;
    const out = [];

    const cap = solved.capital;
    if (cap && cap.required > 0) {
      out.push({
        tone: cap.sufficient ? 'ok' : 'bad',
        title: cap.sufficient
          ? `Starting cash is enough (${usdFull(cap.provided)})`
          : `Starting cash is short by ${usdFull(cap.shortfall)}`,
        body: `The balance bottoms out at ${usdFull(cap.deepestPoint)} in month ${cap.deepestMonth}. ` +
          `Funding the program through that point and keeping a ${usdFull(solved.cashFloor)} operating ` +
          `buffer takes ${usdFull(cap.required)}. This is the accumulated operating loss plus the ` +
          `DHS receivable — a different and much larger number than one-time startup costs.`,
      });
    }

    const bl = solved.breakEvenLaunch;
    if (bl && bl.achievable === false) {
      const rt = solved.requiredTuitionLaunch;
      out.push({
        tone: 'bad',
        title: 'The launch month cannot break even at any enrollment',
        body: `Even at full capacity (${bl.capacity} children) the opening configuration does not ` +
          `cover its costs.` +
          (rt && rt.factor
            ? ` Breaking even at launch would take about ${Math.round(rt.factor * 100 - 100)}% more tuition.`
            : '') +
          ' The launch phase is an investment, not a self-funding step.',
      });
    } else if (bl && bl.enrollment != null) {
      out.push({
        tone: 'ok',
        title: `Launch breaks even at ${bl.enrollment} children`,
        body: `Of ${bl.capacity} seats open in the launch month.`,
      });
    }

    const bs = solved.breakEvenStable;
    if (bs && bs.enrollment != null && bl && bl.enrollment !== bs.enrollment) {
      out.push({
        tone: 'info',
        title: `Fully open, break-even is ${bs.enrollment} children`,
        body: `Of ${bs.capacity} seats. Each room you open raises the break-even line, because a ` +
          'room adds staff before it adds children — which is why rooms should follow enrollment ' +
          'rather than a calendar.',
      });
    }

    if (result.peakReceivable > 0) {
      out.push({
        tone: 'info',
        title: `${usdFull(result.peakReceivable)} tied up in DHS reimbursement`,
        body: 'Earned but not yet received. During a ramp this hole grows every month enrollment ' +
          'does — it never washes out, and it is invisible in a profit-and-loss statement.',
      });
    }

    return h('div', { class: 'findings' }, out.map((f) =>
      h('div', { class: `finding finding-${f.tone}` },
        h('div', { class: 'finding-title' }, f.title),
        h('div', { class: 'finding-body' }, f.body))));
  }

  function tiles() {
    const last = result.rows.at(-1);
    const { solved } = result;
    return h('div', { class: 'tiles' },
      tile('Cash required', usdFull(solved.capital?.required ?? 0),
        `incl. ${usdFull(solved.cashFloor)} buffer`,
        solved.capital?.sufficient ? 'ok' : 'bad'),
      tile('Profitable from',
        result.sustainedProfitableFrom != null ? `month ${result.sustainedProfitableFrom}` : 'never',
        'sustained, not a single good month',
        result.sustainedProfitableFrom != null ? 'ok' : 'bad'),
      tile('Lowest cash', usdFull(result.lowestCash),
        result.lowestCashMonth != null ? `month ${result.lowestCashMonth}` : null,
        result.runsOutOfCash ? 'bad' : 'ok'),
      tile('Ending cash', usdFull(result.endingCash), `month ${last?.month ?? '—'}`),
      tile('Peak receivable', usdFull(result.peakReceivable), 'DHS lag'),
    );
  }

  /** Cash balance as an area, monthly net as bars. */
  function chart() {
    const rows = result.rows;
    if (rows.length === 0) return h('div');

    const W = 900;
    const H = 260;
    const pad = { l: 62, r: 16, t: 16, b: 28 };

    const cashes = rows.map((r) => r.cash);
    const nets = rows.map((r) => r.net);
    const hi = niceCeil(Math.max(...cashes, ...nets, 1));
    const lo = -niceCeil(Math.max(-Math.min(...cashes, ...nets, 0), 1));

    const x = (m) => pad.l + ((m - rows[0].month) / Math.max(1, rows.length - 1)) * (W - pad.l - pad.r);
    const y = (v) => pad.t + ((hi - v) / (hi - lo)) * (H - pad.t - pad.b);
    const zero = y(0);

    const barW = Math.max(2, (W - pad.l - pad.r) / rows.length - 2);

    const ticks = [hi, hi / 2, 0, lo / 2, lo].filter((v, i, a) => a.indexOf(v) === i);

    const cashPath = rows.map((r, i) => `${i === 0 ? 'M' : 'L'}${x(r.month)},${y(r.cash)}`).join(' ');

    return s('svg', { viewBox: `0 0 ${W} ${H}`, class: 'chart', role: 'img',
      'aria-label': 'Cash balance and monthly net income by month' },
      ...ticks.map((v) => s('g', {},
        s('line', { x1: pad.l, x2: W - pad.r, y1: y(v), y2: y(v),
          stroke: v === 0 ? COL.base : COL.grid, 'stroke-width': v === 0 ? 1.5 : 1 }),
        s('text', { x: pad.l - 8, y: y(v) + 4, 'text-anchor': 'end', 'font-size': 11, fill: COL.muted },
          usd(v)))),

      // monthly net, as bars
      ...rows.map((r) => s('rect', {
        x: x(r.month) - barW / 2,
        y: r.net >= 0 ? y(r.net) : zero,
        width: barW,
        height: Math.max(1, Math.abs(zero - y(r.net))),
        fill: r.net >= 0 ? COL.good : COL.critical,
        opacity: 0.28,
      })),

      // cash balance line
      s('path', { d: cashPath, fill: 'none', stroke: COL.ink, 'stroke-width': 2.5 }),

      // opening marker
      s('line', { x1: x(0), x2: x(0), y1: pad.t, y2: H - pad.b, stroke: COL.ink2,
        'stroke-width': 1, 'stroke-dasharray': '3 3' }),
      s('text', { x: x(0) + 4, y: pad.t + 10, 'font-size': 10, fill: COL.ink2 }, 'opens'),

      ...rows.filter((r, i) => i % Math.ceil(rows.length / 12) === 0).map((r) =>
        s('text', { x: x(r.month), y: H - 8, 'text-anchor': 'middle', 'font-size': 10, fill: COL.muted },
          String(r.month))),
    );
  }

  /**
   * Staffing, as two clearly separate quantities.
   *
   * These were previously a table and a one-line note stacked together with nothing saying they
   * measured different things, which reads as a contradiction: a pre-opening month shows three
   * people on payroll above a line saying "0 adults on the floor · 0 staff-hours/week". Both are
   * right. One is what the LICENSED RATIO requires given the children present; the other is who
   * is actually EMPLOYED. Before opening there are no children, so the requirement is genuinely
   * zero while people are already being paid — which is the whole point of hire lead, and worth
   * seeing rather than puzzling over.
   */
  function staffingSection(row) {
    const st = row.staffing;
    const seats = st.seats;
    const required = st.weeklyStaffHours;

    // The director does not stand in a classroom, so their hours are not ratio coverage.
    let classroomHours = 0;
    let classroomPeople = 0;
    let anyFractional = false;
    for (const r of Object.values(seats?.byRole ?? {})) {
      if (!Number.isInteger(r.count)) anyFractional = true;
      if (r.kind !== 'director') {
        classroomHours += r.weeklyHours;
        classroomPeople += r.count;
      }
    }
    const buffer = classroomHours - required;

    return [
      h('h4', {}, 'Staffing'),

      h('p', { class: 'small' },
        h('strong', {}, 'Required by ratio: '),
        required > 0
          ? `${st.peakAdults} adult${st.peakAdults === 1 ? '' : 's'} on the floor at once, ` +
            `${required.toFixed(0)} staff-hours a week — ${st.fte.toFixed(2)} full-time equivalents. ` +
            'One adult covering a whole day is more than one employee, which is why the two differ.'
          : 'nothing — no children are enrolled yet, so no coverage is legally required.'),

      seats && seats.headcount > 0
        ? h('table', { class: 'mini-table' },
          h('thead', {}, h('tr', {},
            h('th', {}, 'On payroll'), h('th', {}, 'People'), h('th', {}, '$/hr'), h('th', {}, 'Cost'))),
          h('tbody', {}, Object.values(seats.byRole).map((r) =>
            h('tr', {},
              h('td', {}, r.roleId),
              h('td', {}, people(r.count)),
              h('td', {}, `$${r.averageWage.toFixed(2)}`),
              h('td', {}, usdFull(r.monthlyWages))))))
        : h('p', { class: 'muted small' }, 'Nobody on payroll this month.'),

      required > 0
        ? h('p', { class: 'small muted' },
          `${people(classroomPeople)} classroom staff supply ${classroomHours.toFixed(0)} hours a week` +
          (buffer > 0.5
            ? ` — ${buffer.toFixed(0)} more than the ratio needs, which is your cover for breaks and absences.`
            : buffer < -0.5
              ? ` — ${Math.abs(buffer).toFixed(0)} SHORT of the ratio requirement.`
              : ', exactly the ratio requirement, with no cover for breaks or absences.') +
          ' The director is not counted toward ratio.')
        : h('p', { class: 'small muted' },
          'Everyone above is being paid ahead of the children arriving — the director, plus any ' +
          'classroom staff pulled forward by their hire lead.'),

      anyFractional
        ? h('p', { class: 'small muted' },
          'Fractions are people who start part-way through the month: a hire lead shorter than a ' +
          'month puts someone on payroll for only part of it, so they are charged for that share.')
        : null,

      st.hiringAhead
        ? h('p', { class: 'small' },
          `Staffed ahead of enrollment — the longest hire lead here is ` +
          `${Math.round(st.maxLeadDays)} days.`)
        : null,
    ];
  }

  function detailPanel(row, prev) {
    const trans = transitionsFor(row, prev, state);
    const seats = row.staffing?.seats;

    return h('tr', { class: 'detail' },
      h('td', { colSpan: 10 },
        h('div', { class: 'detail-grid' },
          h('div', {},
            h('h4', {}, 'What changes this month'),
            trans.length
              ? h('ul', {}, trans.map((t) => h('li', { class: `t-${t.kind}` }, t.text)))
              : h('p', { class: 'muted small' }, 'Nothing notable.')),

          h('div', {}, staffingSection(row)),

          h('div', {},
            h('h4', {}, 'Revenue'),
            h('table', { class: 'mini-table' }, h('tbody', {},
              h('tr', {}, h('td', {}, 'From families'), h('td', {}, usdFull(row.revenue.fromFamilies))),
              h('tr', {}, h('td', {}, 'From DHS'), h('td', {}, usdFull(row.revenue.fromDhs))),
              h('tr', {}, h('td', {}, 'Collections loss'), h('td', {}, '−' + usdFull(row.revenue.collectionsLoss))),
              h('tr', { class: 'total' }, h('td', {}, 'Total'), h('td', {}, usdFull(row.revenue.revenue)))))),

          h('div', {},
            h('h4', {}, 'Expenses'),
            h('table', { class: 'mini-table' }, h('tbody', {},
              ...Object.entries(row.expenses.lines)
                .filter(([, v]) => v > 0)
                .map(([k, v]) => h('tr', {}, h('td', {}, k), h('td', {}, usdFull(v)))),
              h('tr', { class: 'total' }, h('td', {}, 'Total'), h('td', {}, usdFull(row.expenses.total)))))),

          h('div', {},
            h('h4', {}, 'Cash'),
            h('table', { class: 'mini-table' }, h('tbody', {},
              h('tr', {}, h('td', {}, 'Opening'), h('td', {}, usdFull(row.openingCash))),
              h('tr', {}, h('td', {}, 'Received'), h('td', {}, usdFull(row.cashFlow + row.expenses.total))),
              h('tr', {}, h('td', {}, 'Paid out'), h('td', {}, '−' + usdFull(row.expenses.total))),
              h('tr', { class: 'total' }, h('td', {}, 'Closing'), h('td', {}, usdFull(row.cash))),
              h('tr', {}, h('td', {}, 'Owed by DHS'), h('td', {}, usdFull(row.receivable)))))),

          row.attrition?.rate > 0
            ? h('div', {},
              h('h4', {}, 'Attrition'),
              h('p', { class: 'small' },
                `At ${pct(row.attrition.rate)} monthly churn, about ` +
                `${row.attrition.departuresExpected.toFixed(2)} children leave. ` +
                `You need ${row.attrition.newEnrollmentsNeeded.toFixed(2)} new families this month ` +
                'to hit the target.'))
            : null,
        )));
  }

  function table() {
    const rows = result.rows;
    const open = state.meta?.openDate;

    const header = h('tr', {},
      h('th', {}, ''), h('th', {}, 'Month'), h('th', {}, 'Date'), h('th', {}, 'Kids'),
      h('th', {}, 'Staff'), h('th', {}, 'Revenue'), h('th', {}, 'Payroll'),
      h('th', {}, 'Expenses'), h('th', {}, 'Net'), h('th', {}, 'Cash'));

    const body = [];
    rows.forEach((row, i) => {
      const isOpen = expanded.has(row.month);
      body.push(h('tr', {
        class: `${row.month < 0 ? 'preopen' : ''} ${row.cash < 0 ? 'negative' : ''}`,
        onclick: () => {
          if (isOpen) expanded.delete(row.month); else expanded.add(row.month);
          render();
        },
      },
        h('td', { class: 'toggle' }, isOpen ? '▾' : '▸'),
        h('td', {}, String(row.month)),
        h('td', { class: 'muted' }, monthLabel(open, row.month) ?? ''),
        h('td', {}, n0(row.enrollment.served) +
          (row.enrollment.unserved > 0 ? ` (+${n0(row.enrollment.unserved)})` : '')),
        h('td', {}, row.staffing.seats ? people(row.staffing.seats.headcount) : '—'),
        h('td', {}, usdFull(row.revenue.revenue)),
        h('td', {}, usdFull(row.payroll.total)),
        h('td', {}, usdFull(row.expenses.total)),
        h('td', { class: row.net < 0 ? 'neg' : 'pos' }, usdFull(row.net)),
        h('td', { class: row.cash < 0 ? 'neg' : '' }, usdFull(row.cash))));

      if (isOpen) body.push(detailPanel(row, i > 0 ? rows[i - 1] : null));
    });

    return h('div', { class: 'table-scroll' },
      h('table', { class: 'months' }, h('thead', {}, header), h('tbody', {}, body)));
  }

  function render() {
    // Preserve both scroll positions across the full re-render — the retirement calculator lost
    // these twice before they were fixed there, so they are handled from the start here.
    const pageY = window.scrollY;
    const scroller = container.querySelector('.table-scroll');
    const sx = scroller?.scrollLeft ?? 0;
    const sy = scroller?.scrollTop ?? 0;

    clear(container);
    if (!result) {
      container.append(h('p', { class: 'muted' }, 'No projection yet.'));
      return;
    }

    container.append(tiles(), findings(), chart(),
      h('p', { class: 'small muted' }, 'Click any month for a full breakdown.'), table());

    const newScroller = container.querySelector('.table-scroll');
    if (newScroller) { newScroller.scrollLeft = sx; newScroller.scrollTop = sy; }
    window.scrollTo(0, pageY);
  }

  return {
    update(nextResult, nextState) {
      result = nextResult;
      state = nextState;
      render();
    },
  };
}
