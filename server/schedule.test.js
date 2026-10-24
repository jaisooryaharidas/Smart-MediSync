import test from 'node:test';
import assert from 'node:assert';
import { timesFor, makeDoses, statusOf, adherence } from './schedule.js';
test('frequency parsing', () => {
  assert.deepEqual(timesFor('twice daily'), ['08:00', '20:00']);
  assert.deepEqual(timesFor('TDS'), ['08:00', '14:00', '20:00']);
  assert.deepEqual(timesFor('1-0-1'), ['08:00', '20:00']);
  assert.deepEqual(timesFor('once daily', 'at night'), ['21:00']);
  assert.equal(timesFor('Unknown'), null);
});
test('doses, status, adherence', () => {
  const doses = makeDoses({ id: 'm', userId: 'u', frequency: 'twice daily', timing: '', durationDays: 3 }, new Date(2026, 9, 1));
  assert.equal(doses.length, 6);
  const now = new Date(2026, 9, 1, 12, 0);
  assert.equal(statusOf(doses[0], now), 'missed');
  doses[0].takenAt = new Date(2026, 9, 1, 8, 10).toISOString();
  assert.equal(statusOf(doses[0], now), 'taken');
  doses[1].takenAt = new Date(2026, 9, 1, 21, 0).toISOString();
  assert.equal(statusOf(doses[1], now), 'delayed');
  assert.equal(adherence(doses.slice(0, 2), new Date(2026, 9, 2)), 100);
});
