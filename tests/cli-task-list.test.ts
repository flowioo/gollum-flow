/**
 * Tests for `gollum task list` CLI command.
 *
 * Uses node:test built-in runner. Each test sets GOLLUM_DB_PATH to a fresh
 * temp file so the module-level store cache picks up a clean DB.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

interface FreshHandles {
  resetStore: () => void;
  getStore: () => any;
  projectGetOrCreateDefault: (s: any) => any;
  goalCreate: (s: any, i: any) => any;
  outcomeCreate: (s: any, i: any) => any;
  taskCreate: (s: any, i: any) => any;
  taskClaim: (s: any, i: any) => any;
  taskComplete: (s: any, id: string) => any;
}

async function freshDb(): Promise<FreshHandles & { cleanup: () => void }> {
  const dir = mkdtempSync(join(tmpdir(), 'gollum-test-'));
  const dbPath = join(dir, 'test.db');
  process.env.GOLLUM_DB_PATH = dbPath;
  const storeMod = await import('../src/workflow/store/store.js');
  storeMod.resetStore();
  const goalMod = await import('../src/core/goal.js');
  const outcomeMod = await import('../src/core/outcome.js');
  const taskMod = await import('../src/core/task.js');
  return {
    resetStore: () => storeMod.resetStore(),
    getStore: () => storeMod.getStore(),
    projectGetOrCreateDefault: (s: any) => goalMod.projectGetOrCreateDefault(s),
    goalCreate: (s: any, i: any) => goalMod.goalCreate(s, i),
    outcomeCreate: (s: any, i: any) => outcomeMod.outcomeCreate(s, i),
    taskCreate: (s: any, i: any) => taskMod.taskCreate(s, i),
    taskClaim: (s: any, i: any) => taskMod.taskClaim(s, i),
    taskComplete: (s: any, id: string) => taskMod.taskComplete(s, id),
    cleanup: () => {
      storeMod.resetStore();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

test('task list: returns empty list when no tasks', async () => {
  const { getStore, cleanup } = await freshDb();
  try {
    const store = getStore();
    const rows = store.list('tasks', '1', []);
    assert.equal(rows.length, 0);
  } finally {
    cleanup();
  }
});

test('task list: filters by status and outcome_id', async () => {
  const { getStore, projectGetOrCreateDefault, goalCreate, outcomeCreate, taskCreate, taskClaim, taskComplete, cleanup } = await freshDb();
  try {
    const store = getStore();
    const project = projectGetOrCreateDefault(store);
    const goal = goalCreate(store, { project_id: project.id, title: 'test goal' });
    const outcome = outcomeCreate(store, { goal_id: goal.id, title: 'test outcome' });

    const t1 = taskCreate(store, { outcome_id: outcome.id, title: 'pending 1', priority: 5 });
    const t2 = taskCreate(store, { outcome_id: outcome.id, title: 'pending 2', priority: 5 });
    const t3 = taskCreate(store, { outcome_id: outcome.id, title: 'to complete', priority: 5 });

    // Walk t3 through state machine: PENDING → RUNNING → DONE
    taskClaim(store, { task_id: t3.id, owner: 'tester' });
    taskComplete(store, t3.id);

    // Status filter
    const pending = store.list('tasks', `status = ? ORDER BY priority DESC, created_at ASC`, ['PENDING']);
    assert.equal(pending.length, 2);
    const done = store.list('tasks', `status = ? ORDER BY priority DESC, created_at ASC`, ['DONE']);
    assert.equal(done.length, 1);
    assert.equal((done[0] as any).id, t3.id);

    // Outcome filter
    const byOutcome = store.list('tasks', `outcome_id = ? ORDER BY priority DESC, created_at ASC`, [outcome.id]);
    assert.equal(byOutcome.length, 3);

    // Combined
    const doneInOutcome = store.list('tasks', `outcome_id = ? AND status = ?`, [outcome.id, 'DONE']);
    assert.equal(doneInOutcome.length, 1);

    // Untouched status check
    assert.equal((store.get('tasks', t1.id) as any).status, 'PENDING');
    assert.equal((store.get('tasks', t2.id) as any).status, 'PENDING');
  } finally {
    cleanup();
  }
});

test('task list: limit param works', async () => {
  const { getStore, projectGetOrCreateDefault, goalCreate, outcomeCreate, taskCreate, cleanup } = await freshDb();
  try {
    const store = getStore();
    const project = projectGetOrCreateDefault(store);
    const goal = goalCreate(store, { project_id: project.id, title: 'g' });
    const outcome = outcomeCreate(store, { goal_id: goal.id, title: 'o' });
    for (let i = 0; i < 5; i++) {
      taskCreate(store, { outcome_id: outcome.id, title: `t${i}`, priority: i });
    }
    const limited = store.list('tasks', `outcome_id = ? ORDER BY priority DESC, created_at ASC LIMIT ?`, [outcome.id, 3]);
    assert.equal(limited.length, 3);
    assert.equal((limited[0] as any).priority, 4); // highest priority first
    assert.equal((limited[1] as any).priority, 3);
    assert.equal((limited[2] as any).priority, 2);
  } finally {
    cleanup();
  }
});