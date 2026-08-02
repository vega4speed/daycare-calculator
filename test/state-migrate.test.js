import test from 'node:test';
import assert from 'node:assert/strict';
import { defaultState, migrate } from '../ui/state.js';

test('a stored plan missing a newly-added setting gets the default', () => {
  // The bug this guards: a top-level spread keeps the old `settings` object whole, so a setting
  // added later is absent entirely and its UI control reads undefined.default.
  const old = defaultState();
  delete old.settings.hireLeadDays;
  const migrated = migrate(old);
  assert.ok(migrated.settings.hireLeadDays, 'the new setting is filled in');
});

test('migration never overwrites a value the user actually set', () => {
  const stored = defaultState();
  stored.settings.tuition = { default: 1400 };
  stored.startingCash = 99000;
  stored.options.dhsLagMonths = 3;
  const m = migrate(stored);
  assert.equal(m.settings.tuition.default, 1400);
  assert.equal(m.startingCash, 99000);
  assert.equal(m.options.dhsLagMonths, 3);
});

test('nested options are merged, not replaced', () => {
  const stored = defaultState();
  stored.options.escalators = { wage: 0.09 }; // a partial object, as an older save might hold
  const m = migrate(stored);
  assert.equal(m.options.escalators.wage, 0.09, 'the stored value wins');
  assert.ok(m.options.escalators.general != null, 'and the missing ones are filled in');
});

test('a nearly-empty stored plan still opens', () => {
  const m = migrate({ startingCash: 1000 });
  assert.equal(m.startingCash, 1000);
  assert.ok(m.rooms.length > 0);
  assert.ok(m.settings.tuition);
  assert.ok(m.meta.openDate);
});
