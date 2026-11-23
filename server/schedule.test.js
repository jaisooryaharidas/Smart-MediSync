import test from 'node:test';
import assert from 'node:assert/strict';
import { timesFor, makeDoses, statusOf, adherence, dayKey } from './schedule.js';

test('frequency parsing', () => {
  assert.deepEqual(timesFor('twice daily'), ['08:00', '20:00']);
  assert.deepEqual(timesFor('TDS'), ['08:00', '14:00', '20:00']);
  assert.deepEqual(timesFor('1-0-1'), ['08:00', '20:00']);
  assert.deepEqual(timesFor('once daily', 'at night'), ['21:00']);
  assert.equal(timesFor('Unknown'), null);
});

test('schedule uses India wall-clock time even when host timezone is UTC', () => {
  const start = new Date('2026-10-01T00:00:00.000Z');
  const doses = makeDoses({ id: 'm', userId: 'u', frequency: 'twice daily', timing: '', durationDays: 2 }, start);
  assert.equal(doses.length, 4);
  assert.equal(doses[0].scheduledAt, '2026-10-01T02:30:00.000Z'); // 08:00 IST
  assert.equal(doses[1].scheduledAt, '2026-10-01T14:30:00.000Z'); // 20:00 IST
  assert.equal(dayKey(new Date('2026-10-01T20:00:00.000Z')), '2026-10-02');
});

test('upcoming, due, missed and late thresholds', () => {
  const dose = { scheduledAt: '2026-10-01T02:30:00.000Z', takenAt: null };
  assert.equal(statusOf(dose, new Date('2026-10-01T02:29:59.999Z')), 'upcoming');
  assert.equal(statusOf(dose, new Date('2026-10-01T02:30:00.000Z')), 'due');
  assert.equal(statusOf(dose, new Date('2026-10-01T04:30:00.000Z')), 'due');
  assert.equal(statusOf(dose, new Date('2026-10-01T04:30:00.001Z')), 'missed');
  assert.equal(statusOf({ ...dose, takenAt: '2026-10-01T03:00:00.000Z' }), 'taken'); // exactly 30 min
  assert.equal(statusOf({ ...dose, takenAt: '2026-10-01T03:00:00.001Z' }), 'delayed');
  assert.equal(statusOf({ ...dose, takenAt: '2026-10-01T05:00:00.000Z' }), 'delayed'); // can log after missed
});

test('adherence counts taken, delayed and missed only', () => {
  const doses = [
    { scheduledAt: '2026-10-01T02:30:00.000Z', takenAt: '2026-10-01T02:40:00.000Z' },
    { scheduledAt: '2026-10-01T02:30:00.000Z', takenAt: '2026-10-01T03:10:00.000Z' },
    { scheduledAt: '2026-10-01T02:30:00.000Z', takenAt: null },
  ];
  assert.equal(adherence(doses, new Date('2026-10-01T05:00:00.001Z')), 67);
});
