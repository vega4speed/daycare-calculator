// timeline-control.js — the Simple/Expand knob for a sticky-override setting.
//
// The analog of the retirement calculator's setting-control.js, rebuilt around the month axis.
// The difference that matters: because month keys are STEP keys (engine/resolver.js), an
// assumption that changes three times over five years is three entries, not sixty. So the natural
// display is not a list of years — it is a step function you can see.
//
// Two halves:
//   - a strip: the resolved value across every month, drawn as steps, so "$1,100 from open,
//     $1,175 from month 13" is one glance rather than an arithmetic exercise
//   - a list: the overrides themselves, editable, each one a month + step-or-spike + value

import { h, s, clear } from './dom.js';
import { resolve, listOverrides, setOverride, clearOverride, timeline } from '../engine/resolver.js';

const COL = {
  line: '#2f6f4f',
  spike: '#c25b2e',
  grid: '#e1e0d9',
  muted: '#898781',
};

/**
 * @param {object} opts
 * @param {string} opts.label
 * @param {object} opts.setting        the resolver setting (mutated through onChange)
 * @param {{from:number,to:number}} opts.months
 * @param {'money'|'percent'|'number'|'hour'} opts.format
 * @param {Array<{id,label}>} [opts.scopes]  per-group scopes, if the setting supports them
 * @param {string} [opts.help]
 * @param {function} opts.onChange     called with the updated setting
 */
export function timelineControl({
  label, setting, months, format = 'number', scopes = null, help = null, onChange,
}) {
  const state = { expanded: false, scope: '' };
  const root = h('div', { class: 'setting' });

  // The control owns a live reference to the setting it is editing. onChange hands the new value
  // up to the app, but the app deliberately does NOT re-render this column (that would collapse
  // the panel you are working in), so the control must advance its own reference too. Rendering
  // from the original parameter instead is a silent no-op bug: every edit computes correctly,
  // reaches the engine, and then redraws the pre-edit state.
  let current = setting;

  const fmt = {
    money: { toStr: (v) => (v == null ? '' : String(v)), parse: (t) => (t.trim() === '' ? undefined : Number(t)), show: (v) => (v == null ? '—' : '$' + Number(v).toLocaleString(undefined, { maximumFractionDigits: 0 })) },
    percent: { toStr: (v) => (v == null ? '' : String(+(v * 100).toFixed(4))), parse: (t) => (t.trim() === '' ? undefined : Number(t) / 100), show: (v) => (v == null ? '—' : +(v * 100).toFixed(2) + '%') },
    number: { toStr: (v) => (v == null ? '' : String(v)), parse: (t) => (t.trim() === '' ? undefined : Number(t)), show: (v) => (v == null ? '—' : String(+Number(v).toFixed(2))) },
    hour: {
      toStr: (v) => (v == null ? '' : String(v)),
      parse: (t) => (t.trim() === '' ? undefined : Number(t)),
      show: (v) => {
        if (v == null) return '—';
        const hh = Math.floor(v);
        const mm = Math.round((v - hh) * 60);
        const ampm = hh >= 12 ? 'pm' : 'am';
        const h12 = hh % 12 === 0 ? 12 : hh % 12;
        return `${h12}:${String(mm).padStart(2, '0')}${ampm}`;
      },
    },
  }[format];

  const commit = (next) => {
    current = next;
    onChange(next);
    render();
  };

  /** The step chart. Reads far faster than any table of the same information. */
  function strip() {
    const W = 520;
    const H = 48;
    const pad = { l: 4, r: 4, t: 6, b: 12 };
    const series = timeline(current, months.from, months.to, { groupId: state.scope || undefined });
    const values = series.map((p) => Number(p.value) || 0);
    const min = Math.min(...values, 0);
    const max = Math.max(...values, 1);
    const span = max - min || 1;

    const x = (m) => pad.l + ((m - months.from) / Math.max(1, months.to - months.from)) * (W - pad.l - pad.r);
    const y = (v) => H - pad.b - ((v - min) / span) * (H - pad.t - pad.b);

    // Step path: hold the previous value across to this month, then step to the new one.
    let d = '';
    let prevY = null;
    for (const p of series) {
      const px = x(p.month);
      const py = y(Number(p.value) || 0);
      d += prevY === null ? `M${px},${py}` : `L${px},${prevY} L${px},${py}`;
      prevY = py;
    }

    const marks = series
      .map((p, i) => ({ p, i }))
      .filter(({ p, i }) => i > 0 && p.value !== series[i - 1].value);

    return s('svg', { viewBox: `0 0 ${W} ${H}`, class: 'strip', role: 'img',
      'aria-label': `${label} across months ${months.from} to ${months.to}` },
      // month-0 marker: where the program opens
      s('line', { x1: x(0), x2: x(0), y1: pad.t - 4, y2: H - pad.b + 2, stroke: COL.grid, 'stroke-width': 2 }),
      s('path', { d, fill: 'none', stroke: COL.line, 'stroke-width': 2, 'stroke-linejoin': 'round' }),
      ...marks.map(({ p }) =>
        s('circle', {
          cx: x(p.month), cy: y(Number(p.value) || 0), r: 3,
          fill: p.sticky === false ? COL.spike : COL.line,
        })),
      s('text', { x: x(0), y: H - 2, 'font-size': 9, fill: COL.muted, 'text-anchor': 'middle' }, 'open'),
    );
  }

  function overrideRows() {
    const rows = listOverrides(current).filter((r) => {
      if (state.scope) return r.groupId === state.scope;
      return r.level === 'byMonth';
    });

    if (rows.length === 0) {
      return h('p', { class: 'muted small' }, 'No changes over time — the default applies to every month.');
    }

    return h('table', { class: 'overrides' },
      h('thead', {}, h('tr', {},
        h('th', {}, 'Month'), h('th', {}, 'Applies'), h('th', {}, 'Value'), h('th', {}))),
      h('tbody', {}, rows.map((r) =>
        h('tr', {},
          h('td', {}, String(r.month)),
          h('td', {}, r.sticky
            ? h('span', { class: 'tag' }, 'from here on')
            : h('span', { class: 'tag tag-spike' }, 'this month only')),
          h('td', {},
            h('input', {
              type: 'number', class: 'mini', value: fmt.toStr(r.value), step: 'any',
              onchange: (e) => {
                const v = fmt.parse(e.target.value);
                if (v === undefined) return;
                const next = structuredClone(current);
                next[r.level][r.key] = v;
                commit(next);
              },
            })),
          h('td', {},
            h('button', {
              class: 'link danger', title: 'Remove this change',
              onclick: () => {
                const next = structuredClone(current);
                clearOverride(next, { groupId: r.groupId, month: r.month, sticky: r.sticky });
                commit(next);
              },
            }, '×')))),
      ));
  }

  function addRow() {
    let month = 0;
    let sticky = true;
    let value = '';

    return h('div', { class: 'add-override' },
      h('label', {}, 'Month ',
        h('input', {
          type: 'number', class: 'mini', value: '0', step: '1',
          oninput: (e) => { month = Number(e.target.value); },
        })),
      h('label', {},
        h('select', {
          onchange: (e) => { sticky = e.target.value === 'step'; },
        },
          h('option', { value: 'step' }, 'from here on'),
          h('option', { value: 'spike' }, 'this month only'))),
      h('label', {}, 'Value ',
        h('input', {
          type: 'number', class: 'mini', step: 'any',
          oninput: (e) => { value = e.target.value; },
        })),
      h('button', {
        class: 'small',
        onclick: () => {
          const v = fmt.parse(value);
          if (v === undefined || !Number.isInteger(month)) return;
          const next = structuredClone(current);
          setOverride(next, { groupId: state.scope || undefined, month, sticky }, v);
          commit(next);
        },
      }, 'Add change'));
  }

  function render() {
    clear(root);

    const resolvedNow = resolve(current, { month: 0, groupId: state.scope || undefined });

    root.append(
      h('div', { class: 'setting-head' },
        h('div', { class: 'setting-label' },
          h('span', {}, label),
          help ? h('span', { class: 'help', title: help }, '?') : null),
        h('div', { class: 'setting-value' },
          h('input', {
            type: 'number', step: 'any', class: 'val',
            value: fmt.toStr(
              state.scope && current.byGroup && state.scope in current.byGroup
                ? current.byGroup[state.scope]
                : current.default,
            ),
            onchange: (e) => {
              const v = fmt.parse(e.target.value);
              if (v === undefined) return;
              const next = structuredClone(current);
              if (state.scope) {
                next.byGroup = { ...(next.byGroup ?? {}), [state.scope]: v };
              } else {
                next.default = v;
              }
              commit(next);
            },
          }),
          h('button', {
            class: 'link',
            onclick: () => { state.expanded = !state.expanded; render(); },
          }, state.expanded ? 'Hide timeline' : 'Change over time')),
      ),
    );

    if (state.expanded) {
      root.append(h('div', { class: 'setting-body' },
        scopes && scopes.length
          ? h('div', { class: 'scopes' },
            h('span', { class: 'small muted' }, 'Applies to: '),
            h('select', {
              onchange: (e) => { state.scope = e.target.value; render(); },
            },
              h('option', { value: '', selected: state.scope === '' }, 'Everyone'),
              ...scopes.map((sc) =>
                h('option', { value: sc.id, selected: state.scope === sc.id }, sc.label ?? sc.id))))
          : null,
        strip(),
        h('p', { class: 'small muted' },
          `At opening: ${fmt.show(resolvedNow)}`),

        // A month change made at "Everyone" scope OUTRANKS per-group values, because the
        // resolver goes most-specific-first and a month is more specific than a group
        // (engine/resolver.js). That is correct and it is genuinely surprising: setting tuition
        // to $1,175 from month 13 also pulls a $1,250 toddler rate DOWN to $1,175. Caught by
        // testing the real UI — the arithmetic was right and the outcome was still unexpected.
        !state.scope && current.byGroup && Object.keys(current.byGroup).length
          ? h('p', { class: 'small warn-note' },
            'Heads up: a change made here applies to everyone from that month on, replacing the ' +
            `per-group values below (${Object.keys(current.byGroup).join(', ')}). ` +
            'To change just one group, pick it in "Applies to" first.')
          : null,
        overrideRows(),
        addRow(),
      ));
    }

    return root;
  }

  return render();
}
