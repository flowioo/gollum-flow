import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decideResume, type ResumeGoal } from '../src/core/resume.js';
const goal = (status: string, taskStatus: string, remaining = 0): ResumeGoal => ({ status, outcomes: [{
  id: 'outcome', status: status === 'achieved' ? 'VERIFIED' : 'IN_PROGRESS', remaining_gap: { total: 1, remaining },
  tasks: [{ id: 'task', status: taskStatus, owner: null, lease_until: null, wake_at: null }],
}] });

test('completed Gollum plan stops without inventing another workflow', () => {
  assert.deepEqual(decideResume([goal('achieved', 'DONE')], 'ok').task_ids, []);
  assert.equal(decideResume([goal('achieved', 'DONE')], 'ok').action, 'complete');
  assert.equal(decideResume([], 'ok').action, 'no_work');
  assert.equal(decideResume([goal('abandoned', 'PENDING')], 'ok').action, 'no_work');
});
test('stale evidence leads to existing outcome verification, not a new plan', () => {
  const result = decideResume([goal('achieved', 'DONE', 1)], 'ok');
  assert.equal(result.action, 'reverify');
  assert.deepEqual(result.outcome_ids, ['outcome']);
  assert.deepEqual(result.task_ids, []);
});
test('remaining existing tasks are routed by lease, wake time and quota', () => {
  const g = goal('active', 'PENDING', 1);
  assert.equal(decideResume([g], 'ok').action, 'resume');
  assert.equal(decideResume([g], 'exhausted').action, 'wait');
  const t = g.outcomes[0]!.tasks[0]!;
  t.status = 'RUNNING'; t.owner = 'other'; t.lease_until = '2099-01-01T00:00:00Z';
  assert.equal(decideResume([g], 'ok').action, 'wait');
  t.lease_until = '2000-01-01T00:00:00Z';
  assert.deepEqual(decideResume([g], 'ok').task_ids, ['task']);
  t.status = 'WAITING'; t.owner = null; t.wake_at = '2099-01-01T00:00:00Z';
  assert.equal(decideResume([g], 'ok').action, 'wait');
  t.wake_at = null; t.status = 'BLOCKED';
  assert.equal(decideResume([g], 'ok').action, 'needs_attention');
});
test('empty criteria and inconsistent states cannot be reported as complete', () => {
  const g = goal('achieved', 'DONE');
  g.outcomes[0]!.remaining_gap.total = 0;
  assert.equal(decideResume([g], 'ok').action, 'needs_attention');
  assert.equal(decideResume([{ status: 'achieved', outcomes: [] }], 'ok').action, 'needs_attention');
  assert.equal(decideResume([goal('active', 'FAILED')], 'ok').action, 'needs_attention');
});
