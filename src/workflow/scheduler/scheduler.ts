/**
 * Scheduler (DESIGN §7)
 *
 * V0.1 收敛版调度依据（替代 progress 数字）：
 *   1. status == IN_PROGRESS
 *   2. priority 高
 *   3. remaining_gap > 0
 *   4. 没有 blocker
 *   5. goal-align verdict == aligned
 *
 * 不看 83%。
 */

import type { Store } from '../store/store.js';
import type { Task, Outcome } from '../model/types.js';
import { outcomeRemainingGap } from '../../mcp/core/outcome.js';

// =============================================================================
// Core scheduler
// =============================================================================

export interface SchedulePick {
  task: Task;
  outcome: Outcome;
  reason: string;
}

export interface SchedulerOptions {
  /** Limit the number of tasks to pick (default 1) */
  limit?: number;
  /** Only consider tasks whose outcome has goal-align verdict 'aligned' */
  filterMisaligned?: boolean;
}

/**
 * Pick the next wakeable task according to Outcome Gap + Priority ordering.
 *
 * Algorithm (DESIGN §7.1):
 *   1. Filter: tasks with status='WAITING' (or PENDING), wake_at <= now(),
 *      lease expired/unset
 *   2. Join with outcomes where outcome.status='IN_PROGRESS'
 *   3. Order by: outcome.priority DESC, remaining_gap DESC,
 *                task.priority DESC, task.created_at ASC
 *   4. Return top N
 */
export function pickNextTasks(
  store: Store,
  options: SchedulerOptions = {},
): SchedulePick[] {
  const limit = options.limit ?? 1;
  const now = new Date().toISOString();

  // Step 1+2: SQL query joining tasks and outcomes
  const rows = store.raw().prepare(`
    SELECT t.*, o.priority AS o_priority, o.status AS o_status, o.title AS o_title
    FROM tasks t
    JOIN outcomes o ON t.outcome_id = o.id
    WHERE t.status IN ('PENDING', 'WAITING')
      AND (t.wake_at IS NULL OR t.wake_at <= ?)
      AND (t.lease_until IS NULL OR t.lease_until < ?)
      AND o.status = 'IN_PROGRESS'
      AND t.alignment_verdict != 'misaligned'
    ORDER BY
      o.priority DESC,
      t.priority DESC,
      t.created_at ASC
    LIMIT ?
  `).all(now, now, limit) as any[];

  // Step 3: refine ordering by remaining_gap (computed in JS since SQLite
  // can't easily count criteria by status from a join)
  const enriched = rows.map((row) => {
    const task = row as Task;
    const outcome: Outcome = {
      id: row.outcome_id,
      goal_id: '',  // filled below
      title: row.o_title,
      status: row.o_status,
      criteria_ids: [],
      priority: row.o_priority,
      version: 1,
      created_at: '',
      updated_at: '',
    };
    const gap = outcomeRemainingGap(store, task.outcome_id);
    return { task, outcome, gap };
  });

  // Stable sort: priority > remaining_gap.remaining > created_at
  enriched.sort((a, b) => {
    if (a.outcome.priority !== b.outcome.priority) {
      return b.outcome.priority - a.outcome.priority;
    }
    if (a.gap.remaining !== b.gap.remaining) {
      return b.gap.remaining - a.gap.remaining;
    }
    return a.task.created_at.localeCompare(b.task.created_at);
  });

  return enriched.slice(0, limit).map(({ task, outcome, gap }) => ({
    task,
    outcome,
    reason: `priority=${outcome.priority}, remaining_gap=${gap.remaining}/${gap.total}`,
  }));
}

/**
 * Find RUNNING tasks whose lease has expired (DESIGN §6.3).
 * These should be released so Scheduler can reclaim them.
 */
export function findExpiredLeases(store: Store, now: Date = new Date()): Task[] {
  const rows = store.raw().prepare(`
    SELECT * FROM tasks
    WHERE status = 'RUNNING'
      AND lease_until IS NOT NULL
      AND lease_until < ?
  `).all(now.toISOString()) as Task[];
  return rows;
}

/**
 * Release an expired lease (DESIGN §6.3).
 * Task transitions RUNNING → PENDING (so Scheduler can re-pick).
 * This is recovery, not failure.
 */
export function releaseExpiredLease(store: Store, task: Task, actor: string = 'scheduler'): Task {
  // Force status back to PENDING (RUNNING + no lease = orphan; PENDING is the
  // correct "ready to be picked again" state).
  const released = store.casUpdate<Task>('tasks', task.id, task.version, {
    status: 'PENDING',
    owner: null,
    lease_until: null,
  });
  store.emit({
    event: 'TASK_LEASE_EXPIRED',
    task_id: task.id,
    outcome_id: task.outcome_id,
    actor,
    payload: {
      previous_owner: task.owner,
      previous_lease_until: task.lease_until,
      note: 'lease expired, task returned to PENDING for re-pick',
    },
  });
  return released;
}

/**
 * One scheduler tick: pick wakeable tasks, release expired leases.
 * Returns the list of picks for the worker to dispatch.
 */
export interface SchedulerTickResult {
  picked: SchedulePick[];
  released: Task[];
}

export function schedulerTick(store: Store, options: SchedulerOptions = {}): SchedulerTickResult {
  // Step 1: release expired leases first
  const expired = findExpiredLeases(store);
  const released: Task[] = [];
  for (const t of expired) {
    try {
      released.push(releaseExpiredLease(store, t));
    } catch (e) {
      // Skip on conflict (another scheduler reclaimed it)
      continue;
    }
  }

  // Step 2: pick next tasks
  const picked = pickNextTasks(store, options);
  return { picked, released };
}

// =============================================================================
// WakeCondition timer (DESIGN §7.3)
// =============================================================================

/**
 * TimerWakeCondition: fires when fire_at <= now.
 * V0.1 only implements timer; github_pr / ci_status / webhook are V0.5+.
 */
export interface TimerConfig {
  fire_at: string; // ISO8601
}

export function timerShouldFire(taskWakeAt: string | null, now: Date = new Date()): boolean {
  if (!taskWakeAt) return true; // no wake_at → ready immediately
  return new Date(taskWakeAt) <= now;
}