import test from 'node:test';
import assert from 'node:assert/strict';
import {
  resolve,
  explainResolve,
  isSetting,
  makeSetting,
  parseMonthKey,
  monthKey,
  overrideKeyLevel,
  setOverride,
  clearOverride,
  listOverrides,
  timeline,
} from '../engine/resolver.js';

test('literals pass through unchanged', () => {
  assert.equal(resolve(1250), 1250);
  assert.equal(resolve(null), null);
  assert.equal(resolve('x'), 'x');
  assert.deepEqual(explainResolve(42), { value: 42, level: 'literal', key: null });
});

test('a bare default resolves everywhere on the month axis', () => {
  const s = makeSetting(1100);
  assert.equal(resolve(s, { month: -2 }), 1100);
  assert.equal(resolve(s, { month: 0 }), 1100);
  assert.equal(resolve(s, { month: 60 }), 1100);
});

test('month keys parse both forms, including negatives', () => {
  assert.deepEqual(parseMonthKey('6'), { month: 6, sticky: false });
  assert.deepEqual(parseMonthKey('6+'), { month: 6, sticky: true });
  assert.deepEqual(parseMonthKey('-2'), { month: -2, sticky: false });
  assert.deepEqual(parseMonthKey('-2+'), { month: -2, sticky: true });
  assert.deepEqual(parseMonthKey('0+'), { month: 0, sticky: true });
  assert.equal(parseMonthKey('abc'), null);
  assert.equal(parseMonthKey(''), null);
  assert.equal(parseMonthKey('+'), null);
  assert.equal(monthKey(6), '6+');
  assert.equal(monthKey(6, false), '6');
});

// --- the step function, the whole point of this variant -----------------------------------

test('a step key applies from its month onward, and not before', () => {
  const tuition = { default: 1100, byMonth: { '13+': 1175 } };
  assert.equal(resolve(tuition, { month: 0 }), 1100);
  assert.equal(resolve(tuition, { month: 12 }), 1100);
  assert.equal(resolve(tuition, { month: 13 }), 1175);
  assert.equal(resolve(tuition, { month: 14 }), 1175);
  assert.equal(resolve(tuition, { month: 999 }), 1175);
});

test('the latest step at or before the month wins', () => {
  const s = { default: 0, byMonth: { '0+': 10, '6+': 20, '24+': 30 } };
  assert.equal(resolve(s, { month: -1 }), 0); // before every step -> default
  assert.equal(resolve(s, { month: 0 }), 10);
  assert.equal(resolve(s, { month: 5 }), 10);
  assert.equal(resolve(s, { month: 6 }), 20);
  assert.equal(resolve(s, { month: 23 }), 20);
  assert.equal(resolve(s, { month: 24 }), 30);
});

test('step keys are order-independent in the map', () => {
  const forward = { default: 0, byMonth: { '0+': 10, '6+': 20, '24+': 30 } };
  const shuffled = { default: 0, byMonth: { '24+': 30, '0+': 10, '6+': 20 } };
  for (let m = -3; m <= 30; m++) {
    assert.equal(resolve(forward, { month: m }), resolve(shuffled, { month: m }), `month ${m}`);
  }
});

test('negative (pre-open) step keys work', () => {
  const s = { default: 0, byMonth: { '-2+': 500, '0+': 250 } };
  assert.equal(resolve(s, { month: -3 }), 0);
  assert.equal(resolve(s, { month: -2 }), 500);
  assert.equal(resolve(s, { month: -1 }), 500);
  assert.equal(resolve(s, { month: 0 }), 250);
});

test('a spike applies to exactly one month and does not disturb the step', () => {
  // the $879 licensing fee in month -2, against an ongoing compliance cost
  const s = { default: 0, byMonth: { '-2': 879, '0+': 75 } };
  assert.equal(resolve(s, { month: -3 }), 0);
  assert.equal(resolve(s, { month: -2 }), 879);
  assert.equal(resolve(s, { month: -1 }), 0); // spike gone, step not yet started
  assert.equal(resolve(s, { month: 0 }), 75);
  assert.equal(resolve(s, { month: 1 }), 75);
});

test('a spike overrides a step covering the same month', () => {
  const s = { default: 100, byMonth: { '0+': 200, '6': 0 } };
  assert.equal(resolve(s, { month: 5 }), 200);
  assert.equal(resolve(s, { month: 6 }), 0); // waived that month
  assert.equal(resolve(s, { month: 7 }), 200); // step resumes
});

test('a spike and a step at the SAME month coexist as different keys', () => {
  // "raise it from month 6 onward, but waive month 6 itself"
  const s = { default: 100, byMonth: { '6+': 300, '6': 0 } };
  assert.equal(resolve(s, { month: 5 }), 100);
  assert.equal(resolve(s, { month: 6 }), 0);
  assert.equal(resolve(s, { month: 7 }), 300);
});

test('falsy override values resolve — presence, never truthiness', () => {
  assert.equal(resolve({ default: 1100, byMonth: { '6+': 0 } }, { month: 6 }), 0);
  assert.equal(resolve({ default: true, byMonth: { '6+': false } }, { month: 6 }), false);
  assert.equal(resolve({ default: 'a', byMonth: { '6+': '' } }, { month: 6 }), '');
  assert.equal(resolve({ default: 5, byMonth: { '3': 0 } }, { month: 3 }), 0);
});

// --- levels ------------------------------------------------------------------------------

test('byGroup applies when no month key matches', () => {
  const s = { default: 1100, byGroup: { toddler: 1250 } };
  assert.equal(resolve(s, { groupId: 'toddler', month: 0 }), 1250);
  assert.equal(resolve(s, { groupId: 'preschool', month: 0 }), 1100);
  assert.equal(resolve(s, { month: 0 }), 1100);
});

test('byMonth beats byGroup', () => {
  const s = { default: 1100, byGroup: { toddler: 1250 }, byMonth: { '6+': 1300 } };
  assert.equal(resolve(s, { groupId: 'toddler', month: 5 }), 1250);
  assert.equal(resolve(s, { groupId: 'toddler', month: 6 }), 1300);
});

test('byGroupMonth beats byMonth, and steps within a group', () => {
  const s = {
    default: 1100,
    byMonth: { '0+': 1150 },
    byGroupMonth: { 'toddler|6+': 1400 },
  };
  assert.equal(resolve(s, { groupId: 'toddler', month: 5 }), 1150);
  assert.equal(resolve(s, { groupId: 'toddler', month: 6 }), 1400);
  assert.equal(resolve(s, { groupId: 'toddler', month: 40 }), 1400);
  // a different group is unaffected
  assert.equal(resolve(s, { groupId: 'preschool', month: 40 }), 1150);
});

test('a group step does not leak across groups with similar ids', () => {
  const s = {
    default: 0,
    byGroupMonth: { 'pre|0+': 5, 'preschool|0+': 9 },
  };
  assert.equal(resolve(s, { groupId: 'pre', month: 3 }), 5);
  assert.equal(resolve(s, { groupId: 'preschool', month: 3 }), 9);
});

test('explainResolve reports level, key, and stickiness', () => {
  const s = { default: 1, byGroup: { g: 2 }, byMonth: { '4+': 3, '9': 4 } };
  assert.deepEqual(explainResolve(s, { month: 0 }), { value: 1, level: 'default', key: null });
  assert.deepEqual(explainResolve(s, { groupId: 'g', month: 0 }), {
    value: 2, level: 'byGroup', key: 'g',
  });
  assert.deepEqual(explainResolve(s, { month: 5 }), {
    value: 3, level: 'byMonth', key: '4+', sticky: true,
  });
  assert.deepEqual(explainResolve(s, { month: 9 }), {
    value: 4, level: 'byMonth', key: '9', sticky: false,
  });
});

test('a setting with no default reports unset', () => {
  assert.deepEqual(explainResolve({ byMonth: {} }, { month: 0 }), {
    value: undefined, level: 'unset', key: null,
  });
});

test('non-integer or missing month falls through to group/default', () => {
  const s = { default: 1, byMonth: { '0+': 2 } };
  assert.equal(resolve(s, {}), 1);
  assert.equal(resolve(s, { month: 1.5 }), 1);
  assert.equal(resolve(s, { month: '3' }), 1); // strings are not months here
});

// --- mutation helpers --------------------------------------------------------------------

test('overrideKeyLevel classifies targets, defaulting to sticky', () => {
  assert.deepEqual(overrideKeyLevel({}), { level: 'default', key: null });
  assert.deepEqual(overrideKeyLevel({ groupId: 'g' }), { level: 'byGroup', key: 'g' });
  assert.deepEqual(overrideKeyLevel({ month: 6 }), { level: 'byMonth', key: '6+' });
  assert.deepEqual(overrideKeyLevel({ month: 6, sticky: false }), { level: 'byMonth', key: '6' });
  assert.deepEqual(overrideKeyLevel({ groupId: 'g', month: -1 }), {
    level: 'byGroupMonth', key: 'g|-1+',
  });
  assert.deepEqual(overrideKeyLevel({ month: 0 }), { level: 'byMonth', key: '0+' });
});

test('setOverride writes at the right level and clearOverride prunes', () => {
  const s = makeSetting(1100);
  setOverride(s, {}, 1150);
  assert.equal(s.default, 1150);

  setOverride(s, { month: 12 }, 1200);
  assert.deepEqual(s.byMonth, { '12+': 1200 });

  setOverride(s, { month: 12, sticky: false }, 0);
  assert.deepEqual(s.byMonth, { '12+': 1200, '12': 0 });

  setOverride(s, { groupId: 'toddler', month: 3 }, 1400);
  assert.deepEqual(s.byGroupMonth, { 'toddler|3+': 1400 });

  clearOverride(s, { month: 12, sticky: false });
  assert.deepEqual(s.byMonth, { '12+': 1200 });

  clearOverride(s, { month: 12 });
  assert.equal(s.byMonth, undefined, 'empty maps are pruned');

  clearOverride(s, { groupId: 'toddler', month: 3 });
  assert.equal(s.byGroupMonth, undefined);

  clearOverride(s, {});
  assert.equal(s.default, 1150, 'clearing the default is a no-op');
});

test('listOverrides returns flat rows sorted as a timeline', () => {
  const s = {
    default: 0,
    byGroup: { toddler: 1 },
    byMonth: { '12+': 3, '-2': 2 },
    byGroupMonth: { 'toddler|6+': 4 },
  };
  const rows = listOverrides(s);
  assert.equal(rows.length, 4);
  // group-only rows have no month and sort first; the rest ascend by month
  assert.deepEqual(
    rows.map((r) => [r.level, r.month, r.sticky, r.value]),
    [
      ['byGroup', null, null, 1],
      ['byMonth', -2, false, 2],
      ['byGroupMonth', 6, true, 4],
      ['byMonth', 12, true, 3],
    ],
  );
});

test('listOverrides on a non-setting is empty', () => {
  assert.deepEqual(listOverrides(1100), []);
  assert.deepEqual(listOverrides(null), []);
  assert.deepEqual(listOverrides({ byMonth: { '0+': 1 } }), []); // no default -> not a setting
});

test('isSetting distinguishes settings from literals', () => {
  assert.equal(isSetting({ default: 0 }), true);
  assert.equal(isSetting({ default: undefined }), true, 'presence, not truthiness');
  assert.equal(isSetting({ byMonth: {} }), false);
  assert.equal(isSetting([1, 2]), false);
  assert.equal(isSetting(null), false);
  assert.equal(isSetting(1100), false);
});

// --- timeline ----------------------------------------------------------------------------

test('timeline materializes the step function across a range', () => {
  const s = { default: 1100, byMonth: { '2+': 1200, '4': 0 } };
  const t = timeline(s, -1, 5);
  assert.deepEqual(t.map((r) => [r.month, r.value]), [
    [-1, 1100],
    [0, 1100],
    [1, 1100],
    [2, 1200],
    [3, 1200],
    [4, 0],
    [5, 1200],
  ]);
});

test('timeline carries group context through', () => {
  const s = { default: 1100, byGroup: { toddler: 1250 }, byGroupMonth: { 'toddler|1+': 1300 } };
  const t = timeline(s, 0, 2, { groupId: 'toddler' });
  assert.deepEqual(t.map((r) => r.value), [1250, 1300, 1300]);
});
