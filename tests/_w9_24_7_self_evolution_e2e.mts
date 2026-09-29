#!/usr/bin/env tsx
/**
 * W9 E2E: Agent Self-Evolution — 24/7 long-running scenarios
 *
 * Three scenarios:
 *   A. 24/7 loop picks tasks, dispatches, heartbeats → completes
 *   B. Quota exhaustion mid-flight → all tasks paused → 5hr later → resumed
 *   C. Worker dies (heartbeat stops) → watchdog releases → retry → done
 *
 * This E2E uses fake dispatchers (no actual Claude Code calls) to verify
 * the orchestration logic. The goal is to prove the self-evolution layer
 * is correct end-to-end.
 */

import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Store, resetStore } from '../src/workflow/store/store.js';
import {
  AgentLoop,
  recordExhaustion,
  tickQuotaRecovery,
  taskHeartbeat,
  recoverStuckTasks,
  supervisorStart,
  supervisorStop,
  DEFAULT_QUOTA_RECOVERY_MS,
} from '../src/agent/index.js';
import { projectGetOrCreateDefault, goalCreate } from '../src/core/goal.js';
import { outcomeCreate } from '../src/core/outcome.js';
import { taskCreate, taskClaim, taskComplete } from '../src/core/task.js';

// =============================================================================
// Setup
// =============================================================================

const log = (s: string) => console.log(`  ${s}`);

function makeIsolatedStore(): { store: Store; dbPath: string } {
  const dir = mkdtempSync(join(tmpdir(), 'gollum-w9-'));
  const dbPath = join(dir, 'w9.db');
  const migrationDir = join(process.cwd(), 'src/workflow/store/migrations');
  const store = new Store(dbPath, migrationDir);
  return { store, dbPath };
}

async function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

// =============================================================================
// Scenario A: 24/7 loop dispatches + completes tasks
// =============================================================================

async function scenarioA(): Promise<void> {
  console.log('\n=== Scenario A: 24/7 loop picks → dispatches → completes ===\n');

  const { store } = makeIsolatedStore();
  const project = projectGetOrCreateDefault(store);
  const goal = goalCreate(store, { project_id: project.id, title: 'W9-A: 24/7 picks' });
  const outcome = outcomeCreate(store, { goal_id: goal.id, title: '24/7 picks', priority: 1 });

  // Create 3 tasks
  const tasks = [];
  for (let i = 0; i < 3; i++) {
    const t = taskCreate(store, {
      outcome_id: outcome.id,
      title: `pick-me-${i}`,
      priority: 1,
    });
    tasks.push(t);
  }
  log(`created ${tasks.length} tasks: ${tasks.map((t) => t.id.slice(-6)).join(', ')}`);

  // Simulate a dispatcher that claims + completes each task
  const dispatched: string[] = [];
  let shouldStop = false;
  setTimeout(() => { shouldStop = true; }, 1000);

  const loop = new AgentLoop({
    store,
    mode: 'worker',
    dispatch: async (pick) => {
      const claimed = taskClaim(store, { task_id: pick.task.id, owner: 'fake-worker', lease_ms: 30_000 });
      dispatched.push(claimed.id);
      // Simulate work + heartbeat
      taskHeartbeat(store, claimed.id);
      await sleep(10);
      taskComplete(store, claimed.id, `done by fake-worker`);
    },
    intervals: {
      fast: 100, normal: 100, slow: 100, quota_recovery: 100, heartbeat: 50,
    },
    shouldStop: () => shouldStop,
  });

  await loop.start();

  const stats = loop.getStats();
  log(`cycles=${stats.total_cycles} dispatched=${dispatched.length} total_dispatched=${stats.total_dispatched}`);
  if (dispatched.length === 0) {
    throw new Error('Scenario A failed: no tasks dispatched');
  }
  log(`✓ Scenario A: ${dispatched.length} tasks dispatched and completed`);
  store.close();
}

// =============================================================================
// Scenario B: Quota exhaustion pauses all tasks, recovery resumes them
// =============================================================================

async function scenarioB(): Promise<void> {
  console.log('\n=== Scenario B: Quota exhaustion → 5hr recovery (simulated 500ms) ===\n');

  const { store } = makeIsolatedStore();
  const project = projectGetOrCreateDefault(store);
  const goal = goalCreate(store, { project_id: project.id, title: 'W9-B: quota recovery' });
  const outcome = outcomeCreate(store, { goal_id: goal.id, title: 'quota test', priority: 1 });

  // Setup: claim 2 tasks (RUNNING)
  const t1 = taskCreate(store, { outcome_id: outcome.id, title: 'task-1' });
  const t2 = taskCreate(store, { outcome_id: outcome.id, title: 'task-2' });
  taskClaim(store, { task_id: t1.id, owner: 'w1', lease_ms: 60_000 });
  taskClaim(store, { task_id: t2.id, owner: 'w2', lease_ms: 60_000 });
  log(`claimed 2 tasks, both RUNNING`);

  // Trigger quota exhaustion (with short recovery for fast test)
  const recoveryMs = 500; // simulate 5hr as 500ms
  const state = recordExhaustion(store, {
    provider: 'anthropic',
    error: '429 — 5-hour rolling window exceeded',
    recoveryMs,
    actor: 'w9-test',
  });
  log(`quota exhausted: provider=${state.provider} recovery_at=${state.recovery_at}`);
  log(`hit_count=${state.hit_count}`);

  // Verify tasks are paused
  const t1After = store.get('tasks', t1.id);
  const t2After = store.get('tasks', t2.id);
  assert_eq(t1After.status, 'WAITING', 'task-1 should be WAITING');
  assert_eq(t2After.status, 'WAITING', 'task-2 should be WAITING');
  assert(t1After.wake_at, 'task-1 should have wake_at set');
  log(`both tasks paused (status=WAITING, wake_at set to ${t1After.wake_at?.slice(11, 19)})`);

  // Run the loop briefly — should NOT dispatch while quota active
  const dispatchedDuringCooldown: string[] = [];
  let shouldStopB = false;
  setTimeout(() => { shouldStopB = true; }, 200);

  const loop = new AgentLoop({
    store,
    mode: 'worker',
    dispatch: async (pick) => { dispatchedDuringCooldown.push(pick.task.id); },
    intervals: { fast: 50, normal: 50, slow: 50, quota_recovery: 50, heartbeat: 25 },
    shouldStop: () => shouldStopB,
  });
  await loop.start();

  if (dispatchedDuringCooldown.length > 0) {
    throw new Error(`Scenario B failed: tasks dispatched during cooldown: ${dispatchedDuringCooldown.length}`);
  }
  log(`✓ loop correctly skipped dispatch during quota cooldown (no tasks picked)`);

  // Wait for recovery
  log(`waiting ${recoveryMs}ms for recovery...`);
  await sleep(recoveryMs + 100);

  // Tick recovery
  const tick = tickQuotaRecovery(store);
  assert_eq(tick.recovered, true, 'recovery should fire');
  assert_eq(tick.released_tasks, 2, 'both tasks should be released');
  log(`recovery tick: released=${tick.released_tasks}, status=${tick.current_status}`);

  // Verify tasks are PENDING again
  const t1Recovered = store.get('tasks', t1.id);
  const t2Recovered = store.get('tasks', t2.id);
  assert_eq(t1Recovered.status, 'PENDING', 'task-1 should be PENDING');
  assert_eq(t2Recovered.status, 'PENDING', 'task-2 should be PENDING');
  log(`✓ both tasks resumed (status=PENDING, wake_at=null)`);

  store.close();
}

// =============================================================================
// Scenario C: Worker dies mid-task → watchdog recovers
// =============================================================================

async function scenarioC(): Promise<void> {
  console.log('\n=== Scenario C: Worker dies → watchdog recovers → task retries → done ===\n');

  const { store } = makeIsolatedStore();
  const project = projectGetOrCreateDefault(store);
  const goal = goalCreate(store, { project_id: project.id, title: 'W9-C: worker death recovery' });
  const outcome = outcomeCreate(store, { goal_id: goal.id, title: 'crash recovery', priority: 1 });

  const t = taskCreate(store, { outcome_id: outcome.id, title: 'task-with-crashing-worker' });
  taskClaim(store, { task_id: t.id, owner: 'will-die', lease_ms: 60_000 });
  log(`task claimed by will-die, status=RUNNING`);

  // Simulate worker death: backdate heartbeat to 2 minutes ago (way past 60s stale threshold)
  const old = new Date(Date.now() - 120_000).toISOString();
  store.raw().prepare('UPDATE tasks SET heartbeat_at = ? WHERE id = ?').run(old, t.id);
  log(`simulated worker death (heartbeat_at backdated 120s)`);

  // Run watchdog tick — should release the task (retry_count: 0 → 1)
  const recovered = recoverStuckTasks(store);
  assert_eq(recovered.length, 1, 'should find 1 stuck task');
  assert_eq(recovered[0]!.action, 'released', 'first time → release');
  assert_eq(recovered[0]!.task.retry_count, 1, 'retry_count bumped to 1');
  log(`watchdog recovered: action=${recovered[0]!.action} retry_count=${recovered[0]!.task.retry_count}`);

  // Verify task is PENDING and ready for re-pick
  const tAfter = store.get('tasks', t.id);
  assert_eq(tAfter.status, 'PENDING', 'task should be PENDING after recovery');

  // New worker picks it up and completes
  taskClaim(store, { task_id: t.id, owner: 'new-worker', lease_ms: 60_000 });
  taskHeartbeat(store, t.id);
  taskComplete(store, t.id, 'completed by recovery worker');

  const tFinal = store.get('tasks', t.id);
  assert_eq(tFinal.status, 'DONE', 'task should be DONE');
  log(`✓ Scenario C: stuck task recovered + completed (retry_count=${tFinal.retry_count})`);

  store.close();
}

// =============================================================================
// Scenario D: Supervisor health watchdog detects dead process
// =============================================================================

async function scenarioD(): Promise<void> {
  console.log('\n=== Scenario D: Supervisor health watchdog ===\n');

  const { store } = makeIsolatedStore();

  // Simulate a supervisor that started
  supervisorStart(store, { pid: 99999 });
  log(`supervisor started (pid=99999)`);

  // Backdate heartbeat — simulates the whole process dying
  const old = new Date(Date.now() - 60_000).toISOString();
  store.raw().prepare('UPDATE supervisor_state SET last_heartbeat_at = ? WHERE id = 1').run(old);
  log(`heartbeat backdated 60s (simulates crashed process)`);

  // Import supervisorHealth dynamically
  const { supervisorHealth } = await import('../src/agent/heartbeat.js');
  const health = supervisorHealth(store);
  assert_eq(health.status, 'dead', 'should detect dead supervisor');
  assert(health.stale_for_ms > 30_000, 'stale_for_ms should be > 30s');
  log(`watchdog detected: status=${health.status} stale_for=${Math.round(health.stale_for_ms / 1000)}s`);

  // Clean stop
  supervisorStop(store);
  log(`✓ Scenario D: supervisor death detected`);
  store.close();
}

// =============================================================================
// Assertions
// =============================================================================

function assert_eq<T>(actual: T, expected: T, msg?: string) {
  if (actual !== expected) {
    throw new Error(`Assertion failed${msg ? ` (${msg})` : ''}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

function assert(cond: any, msg?: string) {
  if (!cond) throw new Error(`Assertion failed${msg ? `: ${msg}` : ''}`);
}

// =============================================================================
// Main
// =============================================================================

(async () => {
  console.log('=== W9 E2E: Agent Self-Evolution 24/7 Scenarios ===\n');
  try {
    await scenarioA();
    await scenarioB();
    await scenarioC();
    await scenarioD();
    console.log('\n=== ✓ All 4 scenarios passed ===');
    resetStore();
    process.exit(0);
  } catch (e: any) {
    console.error('\n=== ✗ FAILED ===');
    console.error(e.message);
    console.error(e.stack);
    process.exit(1);
  }
})();
