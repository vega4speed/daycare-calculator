// app.js — the app shell: inputs on the left, projection on the right, localStorage in between.

import { h, clear, append, download } from './dom.js';
import { defaultState, loadState, saveState, clearState, migrate } from './state.js';
import { loadTables, tables, projectFor } from './project-adapter.js';
import { timelineControl } from './timeline-control.js';
import { resolve as resolveSetting, timeline as settingTimeline } from '../engine/resolver.js';
import { createProjectionView } from './projection-view.js';
import { createScenarios } from './scenarios.js';

let state = defaultState();
let view = null;
let inputsEl = null;
let scenarios = null;

const refresh = () => {
  saveState(state);
  const result = projectFor(state);
  if (result) view.update(result, state);
};

/**
 * Re-render the inputs column AND the projection. Used when the SHAPE changes (a room added, a
 * field appearing or disappearing), not merely when a value does.
 *
 * Rebuilding empties and refills the column, which drops the page's scroll anchor and throws you
 * back to the top — adding a room would scroll you away from the room you just added. Capture and
 * restore around the whole operation, after the projection has re-rendered too, since that also
 * replaces a large subtree.
 */
const rebuild = () => {
  const y = window.scrollY;
  renderInputs();
  refresh();
  window.scrollTo(0, y);
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

function ratioOptions() {
  const t = tables();
  const out = [];
  for (const chart of ['chart1_singleAge', 'chart2_multiAge']) {
    for (const r of t?.ratios?.[chart] ?? []) {
      // Short labels: the full rule wording does not fit a 400px column, and the numbers are
      // what you actually choose between.
      const short = (r.label ?? r.id)
        .replace(/\s*years?/gi, '').replace(/\s*months?/gi, 'mo')
        .replace(/Six \(6\) weeks/i, '6wk')
        .replace(/\((\d+)\)/g, '').replace(/\s+/g, ' ').trim();
      out.push({ id: r.id, label: `${short} · 1:${r.childrenPerAdult}, max ${r.maxGroupSize ?? '—'}` });
    }
  }
  return out;
}

function roomCard(room, i) {
  const groupOptions = state.groups.map((g) => ({ id: g.id, label: g.label ?? g.id }));
  const isCustom = room.ratioRule && typeof room.ratioRule === 'object';

  const group = state.groups.find((g) => g.id === room.group);
  const inheritedId = group?.ratioRule;
  const inheritedLabel = ratioOptions().find((o) => o.id === inheritedId)?.label ?? inheritedId;

  const setRule = (v) => {
    if (v === '__inherit') delete state.rooms[i].ratioRule;
    else if (v === '__custom') {
      state.rooms[i].ratioRule = { id: 'custom', label: 'Custom', childrenPerAdult: 13, maxGroupSize: 24 };
    } else state.rooms[i].ratioRule = v;
    rebuild();
  };

  return h('div', { class: 'card' },
    h('div', { class: 'card-head' },
      h('input', {
        class: 'card-title', value: room.label ?? room.id,
        onchange: (e) => { state.rooms[i].label = e.target.value; refresh(); },
      }),
      h('button', {
        class: 'link danger', title: 'Remove this room',
        onclick: () => { state.rooms.splice(i, 1); rebuild(); },
      }, '×')),

    h('div', { class: 'card-fields' },
      h('label', {}, h('span', {}, 'Age group'),
        h('select', { onchange: (e) => { state.rooms[i].group = e.target.value; refresh(); } },
          groupOptions.map((g) =>
            h('option', { value: g.id, selected: room.group === g.id }, g.label)))),

      h('label', { class: 'wide' },
        h('span', {}, 'Licensed ratio',
          !room.ratioRule
            ? h('span', { class: 'tag tag-varies', title: 'Taken from this room’s age group. Most rooms want this.' }, 'inherited')
            : null),
        h('select', { onchange: (e) => setRule(e.target.value) },
          h('option', { value: '__inherit', selected: !room.ratioRule },
            inheritedLabel ? `Same as age group · ${inheritedLabel}` : 'Same as age group'),
          ...ratioOptions().map((r) =>
            h('option', { value: r.id, selected: room.ratioRule === r.id }, r.label)),
          h('option', { value: '__custom', selected: isCustom }, 'Custom…'))),

      isCustom
        ? h('label', {}, h('span', {}, 'Ratio 1:'),
          h('input', {
            type: 'number', step: '1', min: '1', value: String(room.ratioRule.childrenPerAdult),
            onchange: (e) => {
              state.rooms[i].ratioRule = { ...room.ratioRule, childrenPerAdult: Number(e.target.value) };
              refresh();
            },
          }))
        : null,
      isCustom
        ? h('label', {}, h('span', {}, 'Max group'),
          h('input', {
            type: 'number', step: '1', min: '1', value: String(room.ratioRule.maxGroupSize ?? ''),
            onchange: (e) => {
              const v = e.target.value;
              state.rooms[i].ratioRule = { ...room.ratioRule, maxGroupSize: v === '' ? null : Number(v) };
              refresh();
            },
          }))
        : null,

      h('label', {}, h('span', {}, 'Seats'),
        h('input', {
          type: 'number', step: '1', min: '0', value: String(room.seats),
          onchange: (e) => { state.rooms[i].seats = Number(e.target.value); refresh(); },
        })),

      h('label', {}, h('span', {}, 'Opens in month'),
        h('input', {
          type: 'number', step: '1', value: String(room.openMonth ?? ''), placeholder: 'never',
          title: 'Month offset from opening: 0 is the opening month, -1 is the month before',
          onchange: (e) => {
            const v = e.target.value;
            state.rooms[i].openMonth = v === '' ? null : Number(v);
            refresh();
          },
        }))),

    isCustom
      ? h('p', { class: 'small warn-note' },
        'A custom grouping is not one the state publishes — confirm the ratio with licensing ' +
        'before relying on it.')
      : null);
}

function roomsEditor() {
  return h('div', {},
    state.rooms.map((room, i) => roomCard(room, i)),
    h('button', {
      class: 'small',
      onclick: () => {
        // No ratioRule: inherit from the age group, which is what almost every room wants.
        state.rooms.push({
          id: `room-${Date.now()}`, label: 'New room', group: state.groups[0]?.id,
          seats: 12, openMonth: 0,
        });
        rebuild();
      },
    }, '+ Add room'));
}

/**
 * Describe a setting's schedule in words: "20 from month -2, then 40 from month 8".
 *
 * A chip saying "by month" tells you THAT something varies without telling you what, which just
 * moves the question rather than answering it. Resolving every month and compressing equal runs
 * gives the actual schedule in one line, which is what a reader wanted in the first place.
 */
function scheduleSummary(setting, roleId, months, unit = '') {
  const points = settingTimeline(setting, months.from, months.to, { groupId: roleId });
  const runs = [];
  for (const p of points) {
    const last = runs[runs.length - 1];
    if (!last || last.value !== p.value) runs.push({ value: p.value, from: p.month });
  }
  if (runs.length <= 1) return null;
  return runs
    .map((r, i) => `${r.value}${unit} from month ${r.from}${i === 0 ? '' : ''}`)
    .join(', then ');
}

/**
 * Does a month-scoped override outrank the role-level value for this setting?
 *
 * The resolver goes most-specific-first, so byGroupMonth and byMonth both beat byGroup. A card
 * that shows the byGroup value would then display a number the engine is not using — and an edit
 * to it would silently do nothing.
 */
function overriddenByMonth(setting, roleId) {
  if (!setting) return false;
  const byMonth = Object.keys(setting.byMonth ?? {}).length > 0;
  const byRoleMonth = Object.keys(setting.byGroupMonth ?? {})
    .some((k) => k.startsWith(`${roleId}|`));
  return byMonth || byRoleMonth;
}

function rolesEditor() {
  // Cards show the value RESOLVED AT THE OPENING MONTH, not the stored role-level default, so the
  // number on screen is one the engine actually uses somewhere.
  const shownValue = (key, roleId, fallback) =>
    resolveSetting(state.settings[key] ?? { default: fallback }, { month: 0, groupId: roleId }) ?? fallback;

  const setPerRole = (key, fallback) => (roleId, value) => {
    const setting = state.settings[key] ?? { default: fallback };
    state.settings[key] = { ...setting, byGroup: { ...(setting.byGroup ?? {}), [roleId]: value } };
    refresh();
  };

  const setWage = setPerRole('wage', 18);
  const setHours = setPerRole('roleHours', 40);
  const setLead = setPerRole('hireLeadDays', 0);

  // Notes go BELOW the field row, spanning the card, rather than inside a field. A field wide
  // enough to hold a sentence forces its row to wrap and leaves its siblings stretched across
  // the card on their own, which looks broken.
  const cell = (notes) => (label, key, roleId, fallback, onChange, opts = {}) => {
    const setting = state.settings[key];
    const varies = overriddenByMonth(setting, roleId);
    if (varies) {
      const schedule = scheduleSummary(setting, roleId, state.months, opts.unit ?? '');
      if (schedule) notes.push(`${label}: ${schedule}. Edit on the timeline below.`);
    }
    return h('label', {},
      h('span', {}, label),
      h('input', {
        type: 'number', step: opts.step ?? '1', min: opts.min,
        value: String(shownValue(key, roleId, fallback)),
        disabled: varies,
        title: varies
          ? 'This changes over time — edit it on the timeline below.'
          : opts.title,
        onchange: (e) => onChange(roleId, Number(e.target.value)),
      }));
  };

  return h('div', {}, state.roles.map((role) => {
    const notes = [];
    const c = cell(notes);
    const fields = h('div', { class: 'card-fields' },
      c('Wage $/hr', 'wage', role.id, 18, setWage, { step: '0.25' }),
      c('Hours/week', 'roleHours', role.id, 40, setHours, { unit: ' hrs' }),
      c('Hire lead (days)', 'hireLeadDays', role.id, 0, setLead, {
        min: '0', unit: ' days',
        title: 'How far ahead of the enrollment that justifies them this role is hired. '
          + 'Under a month is prorated, not charged as a whole month.',
      }));
    return h('div', { class: 'card' },
      h('div', { class: 'card-head' }, h('strong', {}, role.label ?? role.id)),
      fields,
      notes.map((n) => h('p', { class: 'schedule' }, n)));
  }));
}

function renderInputs() {
  clear(inputsEl);
  const groups = state.groups.map((g) => ({ id: g.id, label: g.label ?? g.id }));
  const roleScopes = state.roles.map((r) => ({ id: r.id, label: r.label ?? r.id }));
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

    section('Rooms',
      'Capacity is the smaller of physical seats and the licensed maximum group size.',
      roomsEditor(),
      h('p', { class: 'small muted', style: { marginTop: '8px' } },
        '“Age group” is which enrollment group the children belong to — it carries ' +
        'their tuition, DHS reimbursement band, and enrollment target. “Licensed ratio” is ' +
        'the rule governing this room’s staffing, and it normally follows from the age group, so ' +
        'leave it inherited. Set it only when one age group occupies rooms with different age ' +
        'mixes — a 3-year-old room at 1:9 beside a 4–5 room at 1:16. ' +
        'Ratios come from TN Rule 1240-04-01-.22, Charts 1 and 2 — the state’s own list, ' +
        'not ours. It has a 3–5 and a 4–6 but no 3–6; Tennessee handles mixes it ' +
        'has not tabulated through its multi-age provision (ratio set by the age of the majority). ' +
        'Use Custom for those, and confirm the ratio with licensing.')),

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
      h('p', { class: 'small muted', style: { margin: '4px 0 10px' } },
        'Hire lead is per role because the questions differ — a director is recruited months ' +
        'out, a floater in a fortnight. A lead under one month is prorated, not charged whole. ' +
        'Note what a lead does NOT do: it only pulls staffing EARLIER than the enrollment that ' +
        'justifies it. It cannot delay a start. If someone is on the payroll from the first ' +
        'projected month, that is their headcount setting, not their lead — see ' +
        '“Director on staff” below.'),
      timelineControl({
        label: 'Hours per week', setting: state.settings.roleHours, months,
        format: 'number', scopes: roleScopes, onChange: setSetting('roleHours'),
        help: 'Pick a role under "Applies to". This is where a director goes part-time to full-time.',
      }),
      timelineControl({
        label: 'Director on staff', setting: state.settings.directorCount, months,
        format: 'number', onChange: setSetting('directorCount'),
        help: 'How many directors are employed. Set 0 for months before they start — this, '
          + 'not hire lead, is what controls when the director joins.',
      }),
      timelineControl({
        label: 'Lead teachers per room', setting: state.settings.leadsPerRoom, months,
        format: 'number', onChange: setSetting('leadsPerRoom'),
      }),
      timelineControl({
        label: 'Hire lead, all roles (days)', setting: state.settings.hireLeadDays, months,
        format: 'number', scopes: roleScopes, onChange: setSetting('hireLeadDays'),
        help: 'Sets every role at once, or pick one role under "Applies to".',
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
                state = migrate(JSON.parse(await file.text()));
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
        'Export writes the plan you are editing right now to a JSON file — for a backup, ' +
        'another browser, or sending to someone. Scenarios are different: they are named copies ' +
        'kept inside this browser so you can compare them side by side, and they never leave it. ' +
        'Export is how a plan travels; scenarios are how you weigh two of them.'),
    ),
  );
}

export async function mount(root) {
  const loaded = await loadTables();

  const inputs = h('div', { class: 'inputs' });
  const output = h('div', { class: 'output' });
  const scenarioPanel = h('section', { class: 'panel scenarios' });
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
    h('div', { class: 'layout' }, inputs, h('div', {}, output, scenarioPanel)),
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
    scenarios = createScenarios(scenarioPanel, {
      getState: () => state,
      // Loading a scenario replaces the whole plan, so the inputs column must be rebuilt, not
      // just refreshed — its rooms and roles editors are built from the state's shape.
      setState: (next) => { state = next; rebuild(); },
    });
    renderInputs();
    refresh();
  }
}
