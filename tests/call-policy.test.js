import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizePhone, validateCallWindow, isEligibleDestination } from '../src/call-policy.js';

test('phone canonicalization prevents duplicate formatting', () => {
  assert.equal(normalizePhone('00 375 (29) 123-45-67'), '+375291234567');
});
test('allowed prefixes are checked after canonicalization', () => {
  assert.equal(isEligibleDestination('+375291234567', ['+375']), true);
  assert.equal(isEligibleDestination('+18005550199', ['+375']), false);
});
test('outbound hours use explicitly configured timezone', () => {
  assert.equal(validateCallWindow(new Date('2026-10-28T09:00:00Z'), {timezone:'Europe/Minsk', startHour:10,endHour:18}), true);
  assert.equal(validateCallWindow(new Date('2026-10-28T20:00:00Z'), {timezone:'Europe/Minsk', startHour:10,endHour:18}), false);
});
