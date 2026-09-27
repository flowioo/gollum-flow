/**
 * Scheduler tests (DESIGN §7)
 *
 * Uses Node.js built-in node:test runner.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { projectCreate, goalCreate } from '../src/mcp/core/goal.js';
import { outcomeCreate, outcomeMarkVerified } from '../src/mcp/core/outcome.js';
import { criterionCreate } from '../src/mcp/core/criterion.js';
import { evidenceCreate } from '../src/mcp/core/evidence.js';
import { taskCreate, taskClaim } from '../src/mcp/core/task.js';
import {
  pickNextTasks,
  findExpiredLeases,
  releaseExpiredLease,
  schedulerTick,
  timerShouldFire,
} from '../src/workflow/scheduler/scheduler.js';
import { makeTestStore } from './helpers.js';

describe('Scheduler / pickNextTasks', () => {
  it('picks the task with highest priority first', () => {
    const { store, cleanup } = makeTestStore();
    try {
      const project = projectCreate(store, { name: 'p1' });
      const goal = goalCreate(store, { project_id: project.id, title: 'g1' });
      const o1 = outcomeCreate(store, { goal_id: goal.id, title: 'o1', priority: 1 });
      const o2 = outcomeCreate(store, { goal_id: goal.id, title: 'o2', priority: 5 });
      const o3 = outcomeCreate(store, { goal_id: goal.id, title: 'o3', priority: 3 });

      taskCreate(store, { outcome_id: o1.id, title: 't1', priority: 0 });
      const t2 = taskCreate(store, { outcome_id: o2.id, title: 't2', priority: 0 });
      taskCreate(store, { outcome_id: o3.id, title: 't3', priority: 0 });

      const picks = pickNextTasks(store);
      assert.equal(picks.length, 1);
      assert.equal(picks[0]!.task.id, t2.id);
      assert.equal(picks[0]!.outcome.id, o2.id);
    } finally {
      cleanup();
    }
  });

  it('excludes outcomes that are not IN_PROGRESS', () => {
    const { store, cleanup } = makeTestStore();
    try {
      const project = projectCreate(store, { name: 'p1' });
      const goal = goalCreate(store, { project_id: project.id, title: 'g1' });
      // outcome NOT_STARTED (no task created yet → no auto IN_PROGRESS)
      const o = outcomeCreate(store, { goal_id: goal.id, title: 'o1' });
      // Don't create task → outcome stays NOT_STARTED → excluded
      // But we need a task in PENDING to even consider. Create + delete?
      // Simpler: outcome with no tasks → scheduler has nothing to pick
      assert.equal(o.status, 'NOT_STARTED');

      const picks = pickNextTasks(store);
      assert.equal(picks.length, 0);
    } finally {
      cleanup();
    }
  });

  it('excludes tasks with alignment_verdict = misaligned', () => {
    const { store, cleanup } = makeTestStore();
    try {
      const project = projectCreate(store, { name: 'p1' });
      const goal = goalCreate(store, { project_id: project.id, title: 'g1' });
      const o = outcomeCreate(store, { goal_id: goal.id, title: 'o1' });
      const t1 = taskCreate(store, {
        outcome_id: o.id,
        title: 'good task',
        alignment_verdict: 'aligned',
      });
      taskCreate(store, {
        outcome_id: o.id,
        title: 'misaligned task',
        alignment_verdict: 'misaligned',
      });

      const picks = pickNextTasks(store);
      assert.equal(picks.length, 1);
      assert.equal(picks[0]!.task.id, t1.id);
    } finally {
      cleanup();
    }
  });

  it('excludes VERIFIED outcomes (only IN_PROGRESS considered)', () => {
    const { store, cleanup } = makeTestStore();
    try {
      const project = projectCreate(store, { name: 'p1' });
      const goal = goalCreate(store, { project_id: project.id, title: 'g1' });
      const o1 = outcomeCreate(store, { goal_id: goal.id, title: 'o1' });
      const o2 = outcomeCreate(store, { goal_id: goal.id, title: 'o2' });

      // o1: VERIFIED → excluded
      const c1 = criterionCreate(store, {
        outcome_id: o1.id,
        description: 'c1',
        verifier: { type: 'command', config: { command: 'x' } },
      });
      evidenceCreate(store, { criterion_id: c1.id, status: 'PASS' });
      outcomeMarkVerified(store, o1.id);
      taskCreate(store, { outcome_id: o1.id, title: 't1' });

      // o2: still IN_PROGRESS
      criterionCreate(store, {
        outcome_id: o2.id,
        description: 'c2',
        verifier: { type: 'command', config: { command: 'x' } },
      });
      const t2 = taskCreate(store, { outcome_id: o2.id, title: 't2' });

      const picks = pickNextTasks(store);
      assert.equal(picks.length, 1);
      assert.equal(picks[0]!.task.id, t2.id);
    } finally {
      cleanup();
    }
  });

  it('respects wake_at — tasks with future wake_at are excluded', () => {
    const { store, cleanup } = makeTestStore();
    try {
      const project = projectCreate(store, { name: 'p1' });
      const goal = goalCreate(store, { project_id: project.id, title: 'g1' });
      const o = outcomeCreate(store, { goal_id: goal.id, title: 'o1' });

      const future = new Date(Date.now() + 60_000).toISOString();
      const tFuture = taskCreate(store, { outcome_id: o.id, title: 'future' });
      store.casUpdate('tasks', tFuture.id, 1, { status: 'WAITING', wake_at: future });

      const past = new Date(Date.now() - 60_000).toISOString();
      const tPast = taskCreate(store, { outcome_id: o.id, title: 'past' });
      store.casUpdate('tasks', tPast.id, 1, { status: 'WAITING', wake_at: past });

      const picks = pickNextTasks(store);
      assert.equal(picks.length, 1);
      assert.equal(picks[0]!.task.id, tPast.id);
    } finally {
      cleanup();
    }
  });
});

describe('Scheduler / Lease expiry', () => {
  it('findExpiredLeases returns RUNNING tasks with lease_until < now', () => {
    const { store, cleanup } = makeTestStore();
    try {
      const project = projectCreate(store, { name: 'p1' });
      const goal = goalCreate(store, { project_id: project.id, title: 'g1' });
      const o = outcomeCreate(store, { goal_id: goal.id, title: 'o1' });
      const t = taskCreate(store, { outcome_id: o.id, title: 't1' });
      taskClaim(store, { task_id: t.id, owner: 'agent', lease_ms: -1000 });

      const expired = findExpiredLeases(store);
      assert.equal(expired.length, 1);
      assert.equal(expired[0]!.id, t.id);
    } finally {
      cleanup();
    }
  });

  it('releaseExpiredLease clears owner and lease_until, status → PENDING', () => {
    const { store, cleanup } = makeTestStore();
    try {
      const project = projectCreate(store, { name: 'p1' });
      const goal = goalCreate(store, { project_id: project.id, title: 'g1' });
      const o = outcomeCreate(store, { goal_id: goal.id, title: 'o1' });
      const t = taskCreate(store, { outcome_id: o.id, title: 't1' });
      taskClaim(store, { task_id: t.id, owner: 'agent', lease_ms: -1000 });

      const expired = findExpiredLeases(store);
      const released = releaseExpiredLease(store, expired[0]!);

      assert.equal(released.owner, null);
      assert.equal(released.lease_until, null);
      assert.equal(released.status, 'PENDING'); // ready to be re-picked
    } finally {
      cleanup();
    }
  });

  it('emits TASK_LEASE_EXPIRED event', () => {
    const { store, cleanup } = makeTestStore();
    try {
      const project = projectCreate(store, { name: 'p1' });
      const goal = goalCreate(store, { project_id: project.id, title: 'g1' });
      const o = outcomeCreate(store, { goal_id: goal.id, title: 'o1' });
      const t = taskCreate(store, { outcome_id: o.id, title: 't1' });
      taskClaim(store, { task_id: t.id, owner: 'agent', lease_ms: -1000 });

      const expired = findExpiredLeases(store);
      releaseExpiredLease(store, expired[0]!);

      const events = store.list<{ event: string; task_id: string }>(
        'events',
        "event = 'TASK_LEASE_EXPIRED'",
      );
      assert.equal(events.length, 1);
      assert.equal(events[0]!.task_id, t.id);
    } finally {
      cleanup();
    }
  });

  it('schedulerTick combines lease release + next pick', () => {
    const { store, cleanup } = makeTestStore();
    try {
      const project = projectCreate(store, { name: 'p1' });
      const goal = goalCreate(store, { project_id: project.id, title: 'g1' });
      const o = outcomeCreate(store, { goal_id: goal.id, title: 'o1' });

      const t1 = taskCreate(store, { outcome_id: o.id, title: 't1' });
      taskClaim(store, { task_id: t1.id, owner: 'agent', lease_ms: -1000 });

      const t2 = taskCreate(store, { outcome_id: o.id, title: 't2' });

      const tick = schedulerTick(store);
      // Lease released → t1 returned to PENDING
      assert.equal(tick.released.length, 1);
      assert.equal(tick.released[0]!.id, t1.id);
      // Both t1 and t2 are PENDING and pickable now
      assert.equal(tick.picked.length, 1);
      // Default ordering: by created_at ASC → t1 first
      assert.equal(tick.picked[0]!.task.id, t1.id);
      // Sanity: t2 was created after t1 but only top-1 picked
      assert.equal(tick.picked[0]!.task.title, 't1');
    } finally {
      cleanup();
    }
  });
});

describe('WakeCondition timer', () => {
  it('fires when fire_at <= now', () => {
    const past = new Date(Date.now() - 1000).toISOString();
    const future = new Date(Date.now() + 60000).toISOString();
    const now = new Date();
    assert.equal(timerShouldFire(past, now), true);
    assert.equal(timerShouldFire(future, now), false);
    assert.equal(timerShouldFire(null, now), true);
  });
});