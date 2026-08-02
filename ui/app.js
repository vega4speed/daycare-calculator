// app.js — the app shell: inputs on the left, projection on the right, localStorage in between.

import { h, clear, append, download } from './dom.js';
import { defaultState, loadState, saveState, clearState } from './state.js';
import { loadTables, tables, projectFor } from './project-adapter.js';
import { timelineControl } from './timeline-control.js';
import { createProjectionView } from './projection-view.js';

let state = defaultState();
let view = null;
let inputsEl = null;

const refresh = () => {
  saveState(state);
  const result = projectFor(state);
  if (result) view.update(result, state);
};

/** Re-render the inputs column AND the projection. Used when the shape changes, not just a value. */
const rebuild = () => {
  renderInputs();
  refresh();
};

const setSetting = (key) => (next) => {
  state.settings[key] = next;
  refresh();
};

function section(title, subtitle, ...children) {
  return h('section', { class: 'panel' },
    h('h2', {}, title),
    subtitle ? h('p', { class: 'panel-sub' }, subtitle) : null,
    ...children);
}

function field(label, input, help) {
  return h('label', { class: 'field' },
    h('span', {}, label),
    input,
    help ? h('small', { class: 'muted' }, help) : null);
}

function numberInput(value, onChange, opts = {}) {
  return h('input', {
    type: 'number', value: String(value ?? ''), step: opts.step ?? 'any',
    min: opts.min, class: 'val',
    onchange: (e) => onChange(Number(e.target.value)),
  });
}

function roomsEditor() {
  const groupOptions = state.groups.map((g) => ({ id: g.id, label: g.label ?? g.id }));
  const ratioOptions = [];
  const t = tables();
  for (const chart of ['chart1_singleAge', 'chart2_multiAge']) {
    for (const r of t?.ratios?.[chart] ?? []) {
      ratioOptions.push({ id: r.id, label: `${r.label} — 1:${r.childrenPerAdult}, max ${r.maxGroupSize ?? '∞'}` });
    }
  }

  return h('table', { class: 'editor' },
    h('thead', {}, h('tr', {},
      h('th', {}, 'Room'), h('th', {}, 'Group'), h('th', {}, 'Licensing group'),
      h('th', {}, 'Seats'), h('th', {}, 'Opens'), h('th', {}))),
    h('tbody', {}, [
      ...state.rooms.map((room, i) => h('tr', {},
        h('td', {}, h('input', {
          class: 'mini wide', value: room.label ?? room.id,
          onchange: (e) => { state.rooms[i].label = e.target.value; refresh(); },
        })),
        h('td', {}, h('select', {
          onchange: (e) => { state.rooms[i].group = e.target.value; refresh(); },
        }, groupOptions.map((g) =>
          h('option', { value: g.id, selected: room.group === g.id }, g.label)))),
        h('td', {}, h('select', {
          onchange: (e) => { state.rooms[i].ratioRule = e.target.value; refresh(); },
        }, ratioOptions.map((r) =>
          h('option', { value: r.id, selected: room.ratioRule === r.id }, r.label)))),
        h('td', {}, h('input', {
          type: 'number', class: 'mini', value: String(room.seats), step: '1',
          onchange: (e) => { state.rooms[i].seats = Number(e.target.value); refresh(); },
        })),
        h('td', {}, h('input', {
          type: 'number', class: 'mini', value: String(room.openMonth ?? ''), step: '1',
          onchange: (e) => {
            const v = e.target.value;
            state.rooms[i].openMonth = v === '' ? null : Number(v);
            refresh();
          },
        })),
        h('td', {}, h('button', {
          class: 'link danger',
          onclick: () => { state.rooms.splice(i, 1); rebuild(); },
        }, '×')))),
      h('tr', {}, h('td', { colSpan: 6 },
        h('button', {
          class: 'small',
          onclick: () => {
            state.rooms.push({
              id: `room-${Date.now()}`, label: 'New room', group: state.groups[0]?.id,
              ratioRule: 'm_3_5yr', seats: 12, openMonth: 0,
            });
            rebuild();
          },
        }, '+ Add room'))),
    ]));
}

function rolesEditor() {
  return h('table', { class: 'editor' },
    h('thead', {}, h('tr', {},
      h('th', {}, 'Role'), h('th', {}, 'Wage/hr'), h('th', {}, 'Hours/wk'))),
    h('tbody', {}, state.roles.map((role) => {
      const wage = state.settings.wage;
      const current = wage.byGroup?.[role.id] ?? wage.default;
      const hours = state.settings.roleHours;
      const currentHours = hours.byGroup?.[role.id] ?? hours.default;
      return h('tr', {},
        h('td', {}, role.label ?? role.id),
        h('td', {}, h('input', {
          type: 'number', class: 'mini', value: String(current), step: '0.25',
          onchange: (e) => {
            state.settings.wage = {
              ...wage,
              byGroup: { ...(wage.byGroup ?? {}), [role.id]: Number(e.target.value) },
            };
            refresh();
          },
        })),
        h('td', {}, h('input', {
          type: 'number', class: 'mini', value: String(currentHours), step: '1',
          onchange: (e) => {
            state.settings.roleHours = {
              ...hours,
              byGroup: { ...(hours.byGroup ?? {}), [role.id]: Number(e.target.value) },
            };
            refresh();
          },
        })));
    })));
}

function renderInputs() {
  clear(inputsEl);
  const groups = state.groups.map((g) => ({ id: g.id, label: g.label ?? g.id }));
  const months = state.months;

  inputsEl.append(
    section('Setup', null,
      field('Opening month', h('input', {
        type: 'month', value: state.meta.openDate, class: 'val',
        onchange: (e) => { state.meta.openDate = e.target.value; refresh(); },
      }), 'Month 0. Everything else is an offset from here, so moving this shifts the whole plan.'),
      field('Months before opening',
        numberInput(-months.from, (v) => { state.months.from = -Math.abs(v); rebuild(); }, { step: 1, min: 0 }),
        'Pre-opening months for licensing, deposits, and marketing.'),
      field('Months to project',
        numberInput(months.to, (v) => { state.months.to = v; rebuild(); }, { step: 1, min: 1 })),
      field('Starting cash',
        numberInput(state.startingCash, (v) => { state.startingCash = v; refresh(); })),
    ),

    section('Rooms', 'Capacity is the smaller of physical seats and the licensed maximum group size.',
      roomsEditor()),

    section('Enrollment', 'The number you expect to have. Capacity clamps it, but the shortfall is reported rather than hidden.',
      timelineControl({
        label: 'Enrollment target', setting: state.settings.enrollmentTarget, months,
        format: 'number', scopes: groups, onChange: setSetting('enrollmentTarget'),
        help: 'Children enrolled in each group, by month.',
      }),
      timelineControl({
        label: 'Monthly attrition', setting: state.settings.attrition, months,
        format: 'percent', onChange: setSetting('attrition'),
        help: 'Reported as recruiting load, never subtracted from your target.',
      }),
    ),

    section('Pricing and subsidy', null,
      timelineControl({
        label: 'Monthly tuition', setting: state.settings.tuition, months,
        format: 'money', scopes: groups, onChange: setSetting('tuition'),
      }),
      timelineControl({
        label: 'Share on DHS certificates', setting: state.settings.dhsShare, months,
        format: 'percent', scopes: groups, onChange: setSetting('dhsShare'),
        help: 'DHS pays a published rate; families owe the difference.',
      }),
      timelineControl({
        label: 'Collections loss', setting: state.settings.collectionsLoss, months,
        format: 'percent', onChange: setSetting('collectionsLoss'),
        help: 'Applied only to the family-paid share. The state pays.',
      }),
      field('DHS reimbursement lag (months)',
        numberInput(state.options.dhsLagMonths, (v) => { state.options.dhsLagMonths = v; refresh(); }, { step: 1, min: 0 }),
        'Affects cash timing only, never the P&L — which is exactly why it hides.'),
      field('QRIS score', h('select', {
        class: 'val',
        onchange: (e) => {
          state.options.rateOpts = { ...state.options.rateOpts, qrisScore: e.target.value ? Number(e.target.value) : null };
          refresh();
        },
      },
        h('option', { value: '', selected: state.options.rateOpts.qrisScore == null }, 'None'),
        h('option', { value: '85', selected: state.options.rateOpts.qrisScore === 85 }, '80–89 (+5%)'),
        h('option', { value: '95', selected: state.options.rateOpts.qrisScore === 95 }, '90–100 (+10%)')),
        'A quality bonus on DHS revenue only.'),
    ),

    section('Hours', 'Opening longer costs nothing until families use the extra hours — then it costs a whole shift.',
      timelineControl({
        label: 'Opens at', setting: state.settings.hoursOpen, months,
        format: 'hour', onChange: setSetting('hoursOpen'),
      }),
      timelineControl({
        label: 'Closes at', setting: state.settings.hoursClose, months,
        format: 'hour', onChange: setSetting('hoursClose'),
      }),
    ),

    section('Staffing', 'Headcount is derived from licensed ratios and the length of your operating day.',
      rolesEditor(),
      timelineControl({
        label: 'Hire lead time (months)', setting: state.settings.hireLeadMonths, months,
        format: 'number', onChange: setSetting('hireLeadMonths'),
        help: 'Staff hired ahead of the enrollment that justifies them.',
      }),
      field('Wage growth / yr',
        h('input', {
          type: 'number', class: 'val', step: '0.5',
          value: String(((state.options.escalators.wage ?? 0) * 100).toFixed(1)),
          onchange: (e) => {
            state.options.escalators = { ...state.options.escalators, wage: Number(e.target.value) / 100 };
            refresh();
          },
        })),
    ),

    section('Costs', null,
      timelineControl({
        label: 'Supplies per child', setting: state.settings.perChildCost, months,
        format: 'money', onChange: setSetting('perChildCost'),
      }),
      timelineControl({
        label: 'Overhead (base)', setting: state.settings.overheadBase, months,
        format: 'money', onChange: setSetting('overheadBase'),
      }),
      timelineControl({
        label: 'Insurance', setting: state.settings.insurance, months,
        format: 'money', onChange: setSetting('insurance'),
      }),
      timelineControl({
        label: 'Rent', setting: state.settings.rent, months,
        format: 'money', onChange: setSetting('rent'),
        help: 'Zero if the church absorbs it — worth stating explicitly, since it means these margins are not comparable to a standalone center.',
      }),
      timelineControl({
        label: 'Marketing', setting: state.settings.marketing, months,
        format: 'money', onChange: setSetting('marketing'),
      }),
      timelineControl({
        label: 'One-time costs', setting: state.settings.oneTime, months,
        format: 'money', onChange: setSetting('oneTime'),
        help: 'Use "this month only" entries: the licensing fee, an insurance binder, signage.',
      }),
    ),

    section('Plan file', null,
      h('div', { class: 'row' },
        h('button', { class: 'small', onclick: () => download('daycare-plan.json', JSON.stringify(state, null, 2)) }, 'Export'),
        h('button', {
          class: 'small',
          onclick: () => {
            const input = h('input', { type: 'file', accept: '.json' });
            input.addEventListener('change', async () => {
              const file = input.files?.[0];
              if (!file) return;
              try {
                state = { ...defaultState(), ...JSON.parse(await file.text()) };
                rebuild();
              } catch {
                alert('That file could not be read as a plan.');
              }
            });
            input.click();
          },
        }, 'Import'),
        h('button', {
          class: 'small danger',
          onclick: () => {
            if (!confirm('Reset every assumption to the business plan defaults?')) return;
            clearState();
            state = defaultState();
            rebuild();
          },
        }, 'Reset')),
      h('p', { class: 'small muted' },
        'Your plan lives in this browser only. Export to keep a copy or share it.'),
    ),
  );
}

export async function mount(root) {
  const loaded = await loadTables();

  const inputs = h('div', { class: 'inputs' });
  const output = h('div', { class: 'output' });
  inputsEl = inputs;

  clear(root);
  append(root,
    h('header', {},
      h('h1', {}, 'Childcare Program Calculator'),
      h('p', { class: 'sub' },
        'Month-by-month financial model — enrollment, licensed staffing, DHS subsidy, and cash runway.')),
    !loaded
      ? h('div', { class: 'banner banner-bad' },
        'Could not load the Tennessee ratio and reimbursement tables. ',
        'This page must be served over http — ES modules and fetch do not work from a file:// URL. ',
        'Try: python3 -m http.server 8000')
      : null,
    h('div', { class: 'layout' }, inputs, output),
    h('footer', {},
      h('p', { class: 'small muted' },
        'Licensing ratios: TN Rule 1240-04-01-.22 (Nov 2025). ',
        'DHS rates: Child Care Certificate Program, effective 2026-01-01. ',
        'Unemployment tax is set to zero pending confirmation of the program\'s nonprofit status — ',
        'confirm with your accountant before relying on the payroll figures.')),
  );

  state = loadState();
  view = createProjectionView(output);

  if (loaded) {
    renderInputs();
    refresh();
  }
}
