/**
 * CAS (Optimistic Concurrency Control) tests (DESIGN §6.1, §6.2)
 *
 * Uses Node.js built-in node:test runner (run via: npm test)
 *
 * Covers:
 * - casUpdate: success on matching version, throws on stale version
 * - casUpdateWithRetry: jitter backoff + reEvaluate on conflict
 * - StateConflictError surface
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { StateConflictError } from '../src/workflow/store/store.js';
import { goalCreate, projectCreate } from '../src/core/goal.js';
import { outcomeCreate } from '../src/core/outcome.js';
import { taskCreate, taskComplete } from '../src/core/task.js';
import { makeTestStore } from './helpers.js';

describe('CAS / casUpdate', () => {
  it('succeeds when expected_version matches', () => {
    const { store, cleanup } = makeTestStore();
    try {
      const project = projectCreate(store, { name: 'p1' });
      const goal = goalCreate(store, { project_id: project.id, title: 'g1' });
      const outcome = outcomeCreate(store, { goal_id: goal.id, title: 'o1' });
      const task = taskCreate(store, { outcome_id: outcome.id, title: 't1' });

      assert.equal(task.version, 1);

      const updated = store.casUpdate('tasks', task.id, task.version, {
        summary: 'updated',
      });
      assert.equal(updated.version, 2);
      assert.equal(updated.summary, 'updated');
    } finally {
      cleanup();
    }
  });

  it('throws StateConflictError when expected_version is stale', () => {
    const { store, cleanup } = makeTestStore();
    try {
      const project = projectCreate(store, { name: 'p1' });
      const goal = goalCreate(store, { project_id: project.id, title: 'g1' });
      const outcome = outcomeCreate(store, { goal_id: goal.id, title: 'o1' });
      const task = taskCreate(store, { outcome_id: outcome.id, title: 't1' });

      store.casUpdate('tasks', task.id, task.version, { summary: 'first' });

      assert.throws(
        () => store.casUpdate('tasks', task.id, task.version, { summary: 'second' }),
        StateConflictError,
      );
    } finally {
      cleanup();
    }
  });

  it('throws when id does not exist', () => {
    const { store, cleanup } = makeTestStore();
    try {
      assert.throws(() =>
        store.casUpdate('tasks', 'NONEXISTENT', 1, { summary: 'x' }),
      );
    } finally {
      cleanup();
    }
  });

  it('detects concurrent updates — second CAS fails', () => {
    const { store, cleanup } = makeTestStore();
    try {
      const project = projectCreate(store, { name: 'p1' });
      const goal = goalCreate(store, { project_id: project.id, title: 'g1' });
      const outcome = outcomeCreate(store, { goal_id: goal.id, title: 'o1' });
      const task = taskCreate(store, { outcome_id: outcome.id, title: 't1' });

      const a = store.casUpdate('tasks', task.id, 1, { summary: 'A wins' });
      assert.equal(a.version, 2);

      assert.throws(
        () => store.casUpdate('tasks', task.id, 1, { summary: 'B loses' }),
        StateConflictError,
      );
    } finally {
      cleanup();
    }
  });
});

describe('CAS / casUpdateWithRetry', () => {
  it('retries with reEvaluate on conflict and eventually succeeds', async () => {
    const { store, cleanup } = makeTestStore();
    try {
      const project = projectCreate(store, { name: 'p1' });
      const goal = goalCreate(store, { project_id: project.id, title: 'g1' });
      const outcome = outcomeCreate(store, { goal_id: goal.id, title: 'o1' });
      const task = taskCreate(store, { outcome_id: outcome.id, title: 't1' });

      // First update bumps version
      store.casUpdate('tasks', task.id, 1, { summary: 'other-agent' });

      let reEvalCalls = 0;
      const reEval = (_latest: any, original: any) => {
        reEvalCalls++;
        return {
          summary: original.summary,
          retry_count: ((_latest.retry_count as number) ?? 0) + 1,
        };
      };

      const result = await store.casUpdateWithRetry(
        'tasks',
        task.id,
        { summary: 'me', retry_count: 0 },
        reEval,
        3,
      );

      assert.ok(reEvalCalls > 0, 'reEvaluate should have been called');
      assert.equal(result.summary, 'me');
      assert.equal(result.retry_count, 1);
    } finally {
      cleanup();
    }
  });

  it('throws StateConflictError after maxRetries (cas_thrashing)', async () => {
    const { store, cleanup } = makeTestStore();
    try {
      const project = projectCreate(store, { name: 'p1' });
      const goal = goalCreate(store, { project_id: project.id, title: 'g1' });
      const outcome = outcomeCreate(store, { goal_id: goal.id, title: 'o1' });
      const task = taskCreate(store, { outcome_id: outcome.id, title: 't1' });

      let i = 0;
      const reEval = (_latest: any, _orig: any) => {
        i++;
        // Another "agent" bumps version on every reload
        store.casUpdate('tasks', task.id, store.get('tasks' as any, task.id).version, {
          summary: `raced-${i}`,
        });
        return { summary: 'attempt' };
      };

      await assert.rejects(
        store.casUpdateWithRetry(
          'tasks',
          task.id,
          { summary: 'me' },
          reEval,
          3,
        ),
        StateConflictError,
      );
    } finally {
      cleanup();
    }
  });
});

describe('Task state machine', () => {
  it('PENDING → RUNNING → DONE follows valid transitions', () => {
    const { store, cleanup } = makeTestStore();
    try {
      const project = projectCreate(store, { name: 'p1' });
      const goal = goalCreate(store, { project_id: project.id, title: 'g1' });
      const outcome = outcomeCreate(store, { goal_id: goal.id, title: 'o1' });
      const task = taskCreate(store, { outcome_id: outcome.id, title: 't1' });

      assert.equal(task.status, 'PENDING');

      const claimed = store.casUpdate('tasks', task.id, task.version, {
        status: 'RUNNING',
        owner: 'codex/test',
        lease_until: new Date(Date.now() + 60000).toISOString(),
      });
      assert.equal(claimed.status, 'RUNNING');

      const completed = taskComplete(store, task.id);
      assert.equal(completed.status, 'DONE');
    } finally {
      cleanup();
    }
  });
});