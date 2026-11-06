import test from 'node:test';
import assert from 'node:assert/strict';
import { validateReport, overlapProblems, scoreDays, dayTotals, todayWAT } from '../lib.js';
const now = Date.parse('2026-11-05T15:00:00Z');
const good = { date: '2026-11-05', tasks: [
  { start: '9:00', end: '10:30', project: 'Alpha City', task: 'Screened six candidate profiles', outputs: 6, proofLinks: ['https://docs.google.com/x'] },
  { start: '10:30', end: '11:00', project: 'Alpha City', task: 'Called candidate to follow up', outputs: 1, fileNames: ['call.png'] }] };
test('valid report passes and pads times', () => {
  const r = validateReport(good, { fileNames: ['call.png'], now });
  assert.deepEqual(r.problems, []); assert.equal(r.tasks[0].start, '09:00'); assert.equal(r.tasks[0].hours, 1.5);
});
test('missing proof, overlap, future date are reported', () => {
  const r = validateReport({ date: '2026-11-06', tasks: [{ ...good.tasks[0], proofLinks: [] }, { ...good.tasks[1], start: '10:00', fileNames: ['nope.png'] }] }, { now });
  assert.ok(r.problems.some(p => /future/.test(p)));
  assert.ok(r.problems.some(p => /Task 1: add proof/.test(p)));
  assert.ok(r.problems.some(p => /Task 2: add proof/.test(p)));
  assert.ok(r.problems.some(p => /overlap/.test(p)));
});
test('overlap with saved entries', () => {
  assert.equal(overlapProblems([{ start: '09:00', end: '10:00' }], [{ start: '09:30', end: '11:00', task: 'x' }]).length, 1);
  assert.equal(overlapProblems([{ start: '09:00', end: '10:00' }], [{ start: '10:00', end: '11:00', task: 'x' }]).length, 0);
});
test('scoring compares with team median', () => {
  const base = dayTotals([
    { contractorId: 'a', date: '2026-11-02', hours: 8, outputs: 16, proofLink: 'https://x.io' },
    { contractorId: 'b', date: '2026-11-02', hours: 8, outputs: 8, proofLink: 'https://x.io' },
    { contractorId: 'c', date: '2026-11-02', hours: 8, outputs: 12, proofLink: 'https://x.io' }]);
  const [s] = scoreDays(dayTotals([{ contractorId: 'a', date: '2026-11-03', hours: 8, outputs: 24, proofLink: 'https://x.io' }]), base);
  assert.equal(s.score, 5); assert.equal(s.recommendation, 'approve');
  const [w] = scoreDays(dayTotals([{ contractorId: 'b', date: '2026-11-03', hours: 8, outputs: 4 }]), base);
  assert.equal(w.score, 1); assert.equal(w.recommendation, 'review'); assert.ok(w.issues.length);
  const [n] = scoreDays(dayTotals([{ contractorId: 'b', date: '2026-11-03', hours: 8, outputs: 4 }]), []);
  assert.equal(n.score, null);
});
test('today in WAT', () => assert.equal(todayWAT(Date.parse('2026-11-05T23:30:00Z')), '2026-11-06'));
