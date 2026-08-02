// scenarios.js — save a plan as a named, frozen scenario; compare 2–4 side by side.
//
// The business plan already thinks in scenarios (its §13 runs A–E at 14/36/70/100/138 children),
// so this is the feature that lets the document's own structure be checked rather than asserted.
//
// FROZEN means deep-copied at save time, not a live reference. Editing your rooms or assumptions
// afterwards never silently rewrites a saved scenario — the whole point is a fixed thing to
// compare against.
//
// Colour is assigned ONCE per scenario at save time and stored with it, so a scenario keeps its
// colour no matter which others are selected. Colour follows the entity, never its rank: if
// colours were assigned by position in the current selection, deselecting one would repaint the
// survivors and silently invalidate every comparison the reader had already made.

import { h, s, clear, append } from './dom.js';
import { usd, usdFull, niceCeil } from './chart-utils.js';
import { projectFor } from './project-adapter.js';

const KEY = 'daycare-calc:scenarios:v1';

// Validated categorical palette (see the dataviz skill's reference instance). Fixed order, never
// cycled — a 5th simultaneous scenario is refused rather than given a generated hue.
const SERIES = ['#2a78d6', '#eb6834', '#1baf7a', '#eda100'];
const MAX_COMPARE = 4;

const INK = '#0b0b0b';
const INK2 = '#52514e';
const MUTED = '#898781';
const GRID = '#e1e0d9';

function load() {
  try {
    return JSON.parse(localStorage.getItem(KEY)) ?? [];
  } catch {
    return [];
  }
}

function persist(list) {
  try {
    localStorage.setItem(KEY, JSON.stringify(list));
  } catch { /* private browsing / quota — not worth breaking the app over */ }
}

/** The next unused colour, so two live scenarios never share one. */
function nextColor(existing) {
  const used = new Set(existing.map((x) => x.color));
  return SERIES.find((c) => !used.has(c)) ?? SERIES[existing.length % SERIES.length];
}

/**
 * The headline figures a comparison actually turns on. Everything here is already computed by
 * the engine or the solvers — nothing is re-derived, so the table can never disagree with the
 * single-plan view of the same scenario.
 */
function metricsFor(result) {
  const last = result.rows.at(-1);
  const cap = result.solved?.capital;
  const bel = result.solved?.breakEvenLaunch;
  const bes = result.solved?.breakEvenStable;
  return {
    cashRequired: cap?.required ?? null,
    sufficient: cap?.sufficient ?? null,
    profitableFrom: result.sustainedProfitableFrom,
    lowestCash: result.lowestCash,
    lowestCashMonth: result.lowestCashMonth,
    endingCash: result.endingCash,
    peakReceivable: result.peakReceivable,
    breakEvenLaunch: bel?.achievable === false ? 'not achievable' : bel?.enrollment ?? null,
    breakEvenStable: bes?.achievable === false ? 'not achievable' : bes?.enrollment ?? null,
    endingChildren: last?.enrollment?.served ?? 0,
    endingStaff: last?.staffing?.seats?.headcount ?? null,
  };
}

/**
 * Which assumptions actually differ. Comparing two plans is only useful if you can see what you
 * changed — otherwise the reader is left diffing numbers by eye, which is exactly the work the
 * tool exists to remove.
 */
function differences(scenarios) {
  const paths = [
    ['startingCash', (st) => st.startingCash, usdFull],
    ['Tuition (default)', (st) => st.settings.tuition?.default, usdFull],
    ['DHS share', (st) => st.settings.dhsShare?.default, (v) => `${Math.round(v * 100)}%`],
    ['DHS lag (months)', (st) => st.options.dhsLagMonths, String],
    ['Collections loss', (st) => st.settings.collectionsLoss?.default, (v) => `${(v * 100).toFixed(1)}%`],
    ['Attrition', (st) => st.settings.attrition?.default, (v) => `${(v * 100).toFixed(1)}%`],
    ['Opens at', (st) => st.settings.hoursOpen?.default, (v) => `${v}:00`],
    ['Closes at', (st) => st.settings.hoursClose?.default, (v) => `${v}:00`],
    ['Teacher wage', (st) => st.settings.wage?.default, (v) => `$${v}/hr`],
    ['Hire lead (months)', (st) => st.settings.hireLeadMonths?.default, String],
    ['Insurance', (st) => st.settings.insurance?.default, usdFull],
    ['Rent', (st) => st.settings.rent?.default, usdFull],
    ['Rooms', (st) => st.rooms.length, String],
    ['Seats', (st) => st.rooms.reduce((a, r) => a + r.seats, 0), String],
  ];

  return paths
    .map(([label, get, fmt]) => {
      const values = scenarios.map((sc) => {
        try { return get(sc.state); } catch { return undefined; }
      });
      const distinct = new Set(values.map((v) => JSON.stringify(v)));
      return distinct.size > 1
        ? { label, values: values.map((v) => (v == null ? '—' : fmt(v))) }
        : null;
    })
    .filter(Boolean);
}

/** Cash balance over time, one line per scenario. */
function comparisonChart(entries) {
  const W = 900;
  const H = 300;
  const pad = { l: 64, r: 92, t: 16, b: 30 };

  const allRows = entries.flatMap((e) => e.result.rows);
  if (allRows.length === 0) return h('div');

  const minMonth = Math.min(...allRows.map((r) => r.month));
  const maxMonth = Math.max(...allRows.map((r) => r.month));
  const hi = niceCeil(Math.max(...allRows.map((r) => r.cash), 1));
  const lo = -niceCeil(Math.max(-Math.min(...allRows.map((r) => r.cash), 0), 1));

  const x = (m) => pad.l + ((m - minMonth) / Math.max(1, maxMonth - minMonth)) * (W - pad.l - pad.r);
  const y = (v) => pad.t + ((hi - v) / (hi - lo)) * (H - pad.t - pad.b);

  const ticks = [hi, hi / 2, 0, lo / 2, lo].filter((v, i, a) => a.indexOf(v) === i);

  return s('svg', { viewBox: `0 0 ${W} ${H}`, class: 'chart', role: 'img',
    'aria-label': 'Cash balance by month, one line per scenario' },
    ...ticks.map((v) => s('g', {},
      s('line', { x1: pad.l, x2: W - pad.r, y1: y(v), y2: y(v),
        stroke: v === 0 ? '#c3c2b7' : GRID, 'stroke-width': v === 0 ? 1.5 : 1 }),
      s('text', { x: pad.l - 8, y: y(v) + 4, 'text-anchor': 'end', 'font-size': 11, fill: MUTED },
        usd(v)))),

    s('line', { x1: x(0), x2: x(0), y1: pad.t, y2: H - pad.b, stroke: INK2,
      'stroke-width': 1, 'stroke-dasharray': '3 3' }),
    s('text', { x: x(0) + 4, y: pad.t + 10, 'font-size': 10, fill: INK2 }, 'opens'),

    // 2px lines, per the mark spec.
    ...entries.map((e) => s('path', {
      d: e.result.rows.map((r, i) => `${i === 0 ? 'M' : 'L'}${x(r.month)},${y(r.cash)}`).join(' '),
      fill: 'none', stroke: e.scenario.color, 'stroke-width': 2, 'stroke-linejoin': 'round',
    })),

    // Direct labels at the line end — identity is never carried by colour alone, and this is
    // also the relief the palette's contrast WARN requires.
    ...entries.map((e) => {
      const last = e.result.rows.at(-1);
      return s('text', {
        x: x(last.month) + 6, y: y(last.cash) + 4, 'font-size': 11, fill: INK2,
      }, e.scenario.name.slice(0, 14));
    }),

    ...Array.from({ length: 7 }, (_, i) => minMonth + Math.round((i * (maxMonth - minMonth)) / 6))
      .filter((v, i, a) => a.indexOf(v) === i)
      .map((m) => s('text', {
        x: x(m), y: H - 8, 'text-anchor': 'middle', 'font-size': 10, fill: MUTED,
      }, String(m))),
  );
}

export function createScenarios(container, { getState, setState }) {
  let list = load();
  let selected = new Set();
  let loadedId = null;

  const save = () => { persist(list); render(); };

  function saveCurrent(name) {
    const scenario = {
      id: `sc-${Date.now()}`,
      name: name || `Scenario ${list.length + 1}`,
      color: nextColor(list),
      savedAt: new Date().toISOString(),
      // Deep copy — frozen, not a live reference.
      state: structuredClone(getState()),
    };
    list.push(scenario);
    loadedId = scenario.id;
    if (selected.size < MAX_COMPARE) selected.add(scenario.id);
    save();
  }

  function controls() {
    let nameInput = null;
    return h('div', { class: 'row', style: { marginBottom: '10px' } },
      (nameInput = h('input', { class: 'val', placeholder: 'Name this scenario', style: { maxWidth: '220px' } })),
      h('button', {
        class: 'small',
        onclick: () => { saveCurrent(nameInput.value.trim()); nameInput.value = ''; },
      }, 'Save current as scenario'),
      loadedId
        ? h('button', {
          class: 'small',
          title: 'Overwrite the scenario you loaded with your current edits',
          onclick: () => {
            const sc = list.find((x) => x.id === loadedId);
            if (!sc) return;
            sc.state = structuredClone(getState());
            sc.savedAt = new Date().toISOString();
            save();
          },
        }, `Update “${list.find((x) => x.id === loadedId)?.name ?? ''}”`)
        : null);
  }

  function scenarioList() {
    if (list.length === 0) {
      return h('p', { class: 'muted small' },
        'No saved scenarios yet. Save the current plan, change something, save again — then tick ' +
        'two to compare them.');
    }

    return h('table', { class: 'editor' },
      h('tbody', {}, list.map((sc) => h('tr', {},
        h('td', { style: { width: '24px' } },
          h('input', {
            type: 'checkbox', checked: selected.has(sc.id),
            onchange: (e) => {
              if (e.target.checked) {
                if (selected.size >= MAX_COMPARE) {
                  e.target.checked = false;
                  alert(`Compare at most ${MAX_COMPARE} at once — beyond that the lines stop being ` +
                    'tellable apart. Untick one first.');
                  return;
                }
                selected.add(sc.id);
              } else selected.delete(sc.id);
              render();
            },
          })),
        h('td', { style: { width: '14px' } },
          h('span', { class: 'swatch', style: { background: sc.color } })),
        h('td', {}, h('input', {
          class: 'mini wide', value: sc.name,
          onchange: (e) => { sc.name = e.target.value; save(); },
        })),
        h('td', {},
          h('button', {
            class: 'link',
            title: 'Put this scenario back into the editor',
            onclick: () => { setState(structuredClone(sc.state)); loadedId = sc.id; render(); },
          }, 'Load'),
          h('button', {
            class: 'link danger',
            onclick: () => {
              if (!confirm(`Delete “${sc.name}”?`)) return;
              list = list.filter((x) => x.id !== sc.id);
              selected.delete(sc.id);
              if (loadedId === sc.id) loadedId = null;
              save();
            },
          }, 'Delete'))))));
  }

  function comparison() {
    const chosen = list.filter((sc) => selected.has(sc.id));
    if (chosen.length < 2) {
      return h('p', { class: 'muted small' }, 'Tick two or more scenarios to compare them.');
    }

    const entries = chosen
      .map((scenario) => ({ scenario, result: projectFor(scenario.state) }))
      .filter((e) => e.result);
    if (entries.length < 2) return h('p', { class: 'muted small' }, 'Could not project those scenarios.');

    const metrics = entries.map((e) => metricsFor(e.result));
    const diffs = differences(chosen);

    const row = (label, get) => h('tr', {},
      h('th', { scope: 'row' }, label),
      ...metrics.map((m) => h('td', {}, get(m))));

    return h('div', {},
      h('div', { class: 'legend' }, entries.map((e) =>
        h('span', { class: 'legend-item' },
          h('span', { class: 'swatch', style: { background: e.scenario.color } }),
          e.scenario.name))),

      comparisonChart(entries),

      h('table', { class: 'compare' },
        h('thead', {}, h('tr', {},
          h('th', {}, ''),
          ...entries.map((e) => h('th', {},
            h('span', { class: 'swatch', style: { background: e.scenario.color } }),
            ' ', e.scenario.name)))),
        h('tbody', {},
          row('Cash required', (m) => (m.cashRequired == null ? '—' : usdFull(m.cashRequired))),
          row('Profitable from', (m) => (m.profitableFrom == null ? 'never' : `month ${m.profitableFrom}`)),
          row('Lowest cash', (m) => `${usdFull(m.lowestCash)}${m.lowestCashMonth != null ? ` (m${m.lowestCashMonth})` : ''}`),
          row('Ending cash', (m) => usdFull(m.endingCash)),
          row('Peak DHS receivable', (m) => usdFull(m.peakReceivable)),
          row('Break-even, launch', (m) => (m.breakEvenLaunch == null ? '—' : String(m.breakEvenLaunch))),
          row('Break-even, fully open', (m) => (m.breakEvenStable == null ? '—' : String(m.breakEvenStable))),
          row('Children at end', (m) => String(m.endingChildren)),
          row('Staff at end', (m) => (m.endingStaff == null ? '—' : String(m.endingStaff))))),

      h('h3', { class: 'sub-head' }, 'What differs'),
      diffs.length
        ? h('table', { class: 'compare' },
          h('tbody', {}, diffs.map((d) => h('tr', {},
            h('th', { scope: 'row' }, d.label),
            ...d.values.map((v) => h('td', {}, v))))))
        : h('p', { class: 'muted small' },
          'These scenarios have identical assumptions on every field compared here — any ' +
          'difference is in a month-specific override.'),
    );
  }

  function render() {
    clear(container);
    append(container,
      h('h2', {}, 'Scenarios'),
      h('p', { class: 'panel-sub' },
        'Saved scenarios are frozen copies — editing your plan afterwards never changes them.'),
      controls(),
      scenarioList(),
      h('hr'),
      comparison());
  }

  render();
  return { render };
}
