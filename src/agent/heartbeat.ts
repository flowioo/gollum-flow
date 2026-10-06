/**
 * Heartbeat Watchdog
 *
 * Two levels of heartbeat:
 *
 *   1. task.heartbeat_at  — per-task: worker calls heartbeat() every N seconds
 *      while working on a task. If heartbeat is stale (> heartbeatStaleMs),
 *      watchdog considers the worker dead.
 *
 *   2. supervisor_state.last_heartbeat_at — per-supervisor: supervisor calls
 *      supervisorHeartbeat() every N seconds. If stale, parent supervisor
 *      kills and restarts the supervisor.
 *
 * Why both?
 *   - task.heartbeat catches "worker stuck on this task but still alive"
 *   - supervisor.heartbeat catches "whole supervisor process died"
 *
 * On stuck-task detection:
 *   - Release lease (RUNNING → PENDING)
 *   - Bump retry_count
 *   - If retry_count >= max → BLOCKED (escalate)
 *   - Emit TASK_STUCK_HEARTBEAT_STALE event
 */

import { assertTaskLease } from '../core/lease.js';
import { hostname } from 'node:os';
import type { Store } from '../workflow/store/store.js';
import type { Task } from '../workflow/model/types.js';
import { tickQuotaRecovery } from './quota.js';

// =============================================================================
// Constants
// =============================================================================

/**
 * If a task heartbeat is older than this, the watchdog considers the worker dead.
 * Should be 2-3x the worker's heartbeat interval.
 *
 * Default: 60s — assumes workers heartbeat every 20-30s.
 */
export const HEARTBEAT_STALE_MS = 60 * 1000;

/**
 * If a supervisor heartbeat is older than this, the parent considers the
 * supervisor dead and will restart it.
 *
 * Default: 30s — assumes supervisor heartbeats every 10s.
 */
export const SUPERVISOR_STALE_MS = 30 * 1000;

/**
 * How many consecutive stuck-detections before we BLOCK the task.
 * (We don't want to block on a single false positive.)
 */
export const STUCK_RETRY_LIMIT = 2;

// =============================================================================
// Per-task heartbeat
// =============================================================================

/**
 * Update a task's heartbeat. Workers call this while executing a task.
 *
 * Side effect: extends the lease_until by HEARTBEAT_STALE_MS so the scheduler
 * doesn't reclaim the task while the worker is alive.
 */
export function taskHeartbeat(
  store: Store,
  task_id: string,
  args: { pid?: number; note?: string; lease_token?: string } = {},
): Task {
  return store.transaction(() => {
    const task = store.get<Task>('tasks', task_id);
    assertTaskLease(task, args.lease_token);
    if (task.status !== 'RUNNING' && task.status !== 'VERIFYING' && task.status !== 'RECOVERING') {
      // Idempotent: don't bump heartbeat for tasks not actively running.
      return task;
    }

    const now = new Date();
    const newLease = new Date(now.getTime() + HEARTBEAT_STALE_MS).toISOString();

    const updated = store.casUpdate<Task>('tasks', task.id, task.version, {
      heartbeat_at: now.toISOString(),
      lease_until: newLease,
      worker_pid: args.pid ?? process.pid,
      worker_host: hostname(),
    });
    return updated;
  });
}

// =============================================================================
// Stuck task detection
// =============================================================================

export interface StuckTask {
  task: Task;
  stale_for_ms: number;
  heartbeat_at: string;
  action: 'released' | 'blocked' | 'skipped';
  reason: string;
}

/**
 * Find RUNNING tasks whose heartbeat is stale (worker likely dead).
 *
 * Idempotent: a stuck task with retry_count already at STUCK_RETRY_LIMIT
 * gets BLOCKED instead of re-released.
 */
export function findStuckTasks(
  store: Store,
  options: { staleMs?: number; now?: Date } = {},
): StuckTask[] {
  const staleMs = options.staleMs ?? HEARTBEAT_STALE_MS;
  const now = options.now ?? new Date();
  const cutoff = new Date(now.getTime() - staleMs).toISOString();

  // Tasks that look stuck: RUNNING/VERIFYING/RECOVERING, heartbeat_at < cutoff
  // OR heartbeat_at IS NULL with lease expired (legacy claim without heartbeat)
  const rows = store.raw()
    .prepare(`
      SELECT * FROM tasks
      WHERE status IN ('RUNNING', 'VERIFYING', 'RECOVERING')
        AND (
          (heartbeat_at IS NOT NULL AND heartbeat_at < ?)
          OR (heartbeat_at IS NULL AND lease_until IS NOT NULL AND lease_until < ?)
        )
    `)
    .all(cutoff, now.toISOString()) as unknown as Task[];

  return rows.map((task) => {
    const heartbeatAt = task.heartbeat_at ?? task.lease_until ?? task.updated_at;
    const staleFor = now.getTime() - new Date(heartbeatAt).getTime();
    return {
      task,
      stale_for_ms: staleFor,
      heartbeat_at: heartbeatAt,
      action: 'skipped',
      reason: `heartbeat stale ${Math.round(staleFor / 1000)}s (cutoff ${Math.round(staleMs / 1000)}s)`,
    };
  });
}

/**
 * Recover stuck tasks:
 *   - retry_count < STUCK_RETRY_LIMIT: release lease → PENDING (worker will retry)
 *   - retry_count >= STUCK_RETRY_LIMIT: → BLOCKED (escalate)
 *
 * Each task handled in a CAS loop to avoid conflicts with concurrent updates.
 *
 * Returns the actions taken.
 */
export function recoverStuckTasks(
  store: Store,
  options: { staleMs?: number; now?: Date; actor?: string } = {},
): StuckTask[] {
  const stuck = findStuckTasks(store, options);
  const actor = options.actor ?? 'heartbeat-watchdog';
  const results: StuckTask[] = [];

  for (const s of stuck) {
    try {
      const task = store.get<Task>('tasks', s.task.id);

      // Re-check status (might have been updated between find and now)
      if (task.status !== 'RUNNING' && task.status !== 'VERIFYING' && task.status !== 'RECOVERING') {
        results.push({ ...s, action: 'skipped', reason: 'status changed' });
        continue;
      }

      if (task.retry_count >= STUCK_RETRY_LIMIT) {
        // Escalate to BLOCKED.
        const blocked = store.casUpdate<Task>('tasks', task.id, task.version, {
          status: 'BLOCKED',
          owner: null,
          lease_until: null,
          summary: `BLOCKED: heartbeat stale after ${task.retry_count} retries (${s.reason})`,
        });
        store.emit({
          event: 'TASK_BLOCKED_STUCK',
          task_id: task.id,
          outcome_id: task.outcome_id,
          actor,
          payload: {
            retry_count: task.retry_count,
            stale_for_ms: s.stale_for_ms,
            heartbeat_at: s.heartbeat_at,
            reason: 'heartbeat stale past retry limit',
          },
        });
        results.push({ ...s, task: blocked, action: 'blocked', reason: 'retry limit exceeded' });
      } else {
        // Release lease → PENDING, bump retry_count.
        const released = store.casUpdate<Task>('tasks', task.id, task.version, {
          status: 'PENDING',
          owner: null,
          lease_until: null,
          retry_count: task.retry_count + 1,
          summary: `released: heartbeat stale ${Math.round(s.stale_for_ms / 1000)}s`,
        });
        store.emit({
          event: 'TASK_HEARTBEAT_STALE',
          task_id: task.id,
          outcome_id: task.outcome_id,
          actor,
          payload: {
            retry_count: released.retry_count,
            stale_for_ms: s.stale_for_ms,
            heartbeat_at: s.heartbeat_at,
          },
        });
        results.push({ ...s, task: released, action: 'released' });
      }
    } catch (e: any) {
      // CAS conflict — skip silently (someone else updated)
      results.push({ ...s, action: 'skipped', reason: `CAS conflict: ${e.message}` });
    }
  }

  return results;
}

// =============================================================================
// Supervisor heartbeat (process-level watchdog)
// =============================================================================

export interface SupervisorHeartbeatArgs {
  pid?: number;
}

/**
 * Update supervisor heartbeat. Called by the supervisor loop itself,
 * every N seconds. If this stops being called, parent process detects dead.
 */
export function supervisorHeartbeat(
  store: Store,
  args: SupervisorHeartbeatArgs = {},
): { last_heartbeat_at: string } {
  const now = new Date().toISOString();
  const pid = args.pid ?? process.pid;
  store.raw()
    .prepare(`
      UPDATE supervisor_state
      SET last_heartbeat_at = ?,
          pid = ?,
          status = 'running',
          updated_at = ?
      WHERE id = 1
    `)
    .run(now, pid, now);
  return { last_heartbeat_at: now };
}

/**
 * Mark supervisor as started. Used at boot.
 */
export function supervisorStart(
  store: Store,
  args: { pid?: number } = {},
): void {
  const now = new Date().toISOString();
  const pid = args.pid ?? process.pid;
  store.raw()
    .prepare(`
      UPDATE supervisor_state
      SET pid = ?,
          started_at = ?,
          last_heartbeat_at = ?,
          status = 'running',
          updated_at = ?
      WHERE id = 1
    `)
    .run(pid, now, now, now);
  store.emit({
    event: 'SUPERVISOR_STARTED',
    actor: 'supervisor',
    payload: { pid, started_at: now },
  });
}

/**
 * Mark supervisor as stopped. Used for clean shutdown.
 */
export function supervisorStop(
  store: Store,
  args: { reason?: string } = {},
): void {
  const now = new Date().toISOString();
  store.raw()
    .prepare(`
      UPDATE supervisor_state
      SET status = 'stopped',
          updated_at = ?
      WHERE id = 1
    `)
    .run(now);
  store.emit({
    event: 'SUPERVISOR_STOPPED',
    actor: 'supervisor',
    payload: { reason: args.reason ?? 'clean shutdown', stopped_at: now },
  });
}

export interface SupervisorHealth {
  status: 'running' | 'stale' | 'dead' | 'stopped' | 'paused';
  pid: number | null;
  started_at: string | null;
  last_heartbeat_at: string | null;
  stale_for_ms: number;
  restart_count: number;
  last_restart_reason: string | null;
}

/**
 * Check supervisor health.
 *
 * - 'running'  : heartbeat fresh
 * - 'stale'    : heartbeat old but not yet past stale threshold
 * - 'dead'     : heartbeat past SUPERVISOR_STALE_MS (parent should restart)
 * - 'stopped'  : clean shutdown
 * - 'paused'   : paused (quota or similar)
 */
export function supervisorHealth(
  store: Store,
  options: { staleMs?: number; now?: Date } = {},
): SupervisorHealth {
  const staleMs = options.staleMs ?? SUPERVISOR_STALE_MS;
  const now = options.now ?? new Date();
  const row = store.raw()
    .prepare('SELECT * FROM supervisor_state WHERE id = 1')
    .get() as {
      pid: number | null;
      started_at: string | null;
      last_heartbeat_at: string | null;
      restart_count: number;
      last_restart_reason: string | null;
      status: 'running' | 'dead' | 'stopped' | 'paused';
    };

  let status: SupervisorHealth['status'] = row.status as SupervisorHealth['status'];
  let staleForMs = 0;

  if (row.last_heartbeat_at) {
    staleForMs = now.getTime() - new Date(row.last_heartbeat_at).getTime();
    if (status === 'running' && staleForMs > staleMs) {
      status = 'dead';
    } else if (status === 'running' && staleForMs > staleMs / 2) {
      status = 'stale';
    }
  } else if (status === 'running') {
    // Running but no heartbeat — treat as dead.
    status = 'dead';
  }

  return {
    status,
    pid: row.pid,
    started_at: row.started_at,
    last_heartbeat_at: row.last_heartbeat_at,
    stale_for_ms: staleForMs,
    restart_count: row.restart_count,
    last_restart_reason: row.last_restart_reason,
  };
}

/**
 * Record a restart event. Called by parent supervisor when it restarts.
 */
export function recordRestart(
  store: Store,
  args: { reason: string; new_pid?: number },
): void {
  const now = new Date().toISOString();
  store.transaction(() => {
    store.raw()
      .prepare(`
        UPDATE supervisor_state
        SET restart_count = restart_count + 1,
            last_restart_at = ?,
            last_restart_reason = ?,
            pid = ?,
            started_at = ?,
            last_heartbeat_at = ?,
            status = 'running',
            updated_at = ?
        WHERE id = 1
      `)
      .run(now, args.reason, args.new_pid ?? null, now, now, now);
    store.emit({
      event: 'SUPERVISOR_RESTARTED',
      actor: 'parent-supervisor',
      payload: { reason: args.reason, new_pid: args.new_pid, restarted_at: now },
    });
  });
}

// =============================================================================
// Combined watchdog tick
// =============================================================================

export interface WatchdogTickResult {
  stuck_tasks: StuckTask[];
  supervisor_health: SupervisorHealth;
  quota_recovery: { recovered: boolean; released_tasks: number };
}

/**
 * One watchdog tick: do all health checks.
 * Use this from the main 24/7 loop.
 */
export function watchdogTick(
  store: Store,
  options: { staleMs?: number; now?: Date; actor?: string } = {},
): WatchdogTickResult {
  const stuck = recoverStuckTasks(store, options);
  const supervisor = supervisorHealth(store, options);
  const quota = tickQuotaRecovery(store, options.now);
  return {
    stuck_tasks: stuck,
    supervisor_health: supervisor,
    quota_recovery: quota,
  };
}
