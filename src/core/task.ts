/**
 * Task tools (DESIGN §8.1 — 8 core tools)
 *
 * 1. task.create
 * 2. task.get
 * 3. task.claim
 * 4. task.checkpoint
 * 5. task.wait
 * 6. task.block
 * 7. task.complete
 * 8. task.fail
 *
 * Additional helpers (task.list, task.update, task.release) are exposed via
 * the Store class directly (DESIGN §13.1: 后续补).
 */

import { assertTaskLease } from './lease.js';
import { ulid } from 'ulid';
import { NotFoundError, type Store } from '../workflow/store/store.js';
import {
  guardTaskTransition,
  IllegalTransitionError,
} from '../workflow/model/state.js';
import type { Task, CheckpointPayload, WakeCondition } from '../workflow/model/types.js';

// =============================================================================
// Constants (DESIGN §6.4)
// =============================================================================

const DEFAULT_LEASE_MS = 15 * 60 * 1000; // 15 min for Coding Agent

// =============================================================================
// 1. task.create
// =============================================================================

export interface TaskCreateInput {
  outcome_id: string;
  title: string;
  acceptance_criteria: string[];
  priority?: number;
  estimated_minutes?: number;
  alignment_verdict?: Task['alignment_verdict'];
  alignment_reason?: string;
}

export function taskCreate(store: Store, input: TaskCreateInput): Task {
  return store.transaction(() => {
    // Validate outcome exists
    if (!store.tryGet('outcomes', input.outcome_id)) {
      throw new NotFoundError('outcomes', input.outcome_id);
    }

    const now = new Date().toISOString();
    const task: Task = {
      id: ulid(),
      outcome_id: input.outcome_id,
      title: input.title,
      status: 'PENDING',
      phase: null,
      priority: input.priority ?? 0,
      acceptance_criteria: input.acceptance_criteria ?? [],
      alignment_verdict: input.alignment_verdict ?? 'uncertain',
      alignment_reason: input.alignment_reason ?? null,
      owner: null,
      lease_until: null,
      wake_at: null,
      retry_count: 0,
      next_action: null,
      summary: null,
      last_observation: null,
      estimated_minutes: input.estimated_minutes ?? null,
      heartbeat_at: null,
      worker_pid: null,
      worker_host: null,
      version: 1,
      created_at: now,
      updated_at: now,
    };

    store.raw()
      .prepare(
        `INSERT INTO tasks (
          id, outcome_id, title, status, phase, priority, acceptance_criteria,
          alignment_verdict, alignment_reason, owner, lease_until, wake_at,
          retry_count, next_action, summary, last_observation, estimated_minutes,
          heartbeat_at, worker_pid, worker_host,
          version, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        task.id,
        task.outcome_id,
        task.title,
        task.status,
        task.phase,
        task.priority,
        JSON.stringify(task.acceptance_criteria),
        task.alignment_verdict,
        task.alignment_reason,
        task.owner,
        task.lease_until,
        task.wake_at,
        task.retry_count,
        task.next_action,
        task.summary,
        task.last_observation,
        task.estimated_minutes,
        task.heartbeat_at,
        task.worker_pid,
        task.worker_host,
        task.version,
        task.created_at,
        task.updated_at,
      );

    store.emit({
      event: 'TASK_CREATED',
      task_id: task.id,
      outcome_id: task.outcome_id,
      actor: 'system',
      payload: {
        title: task.title,
        priority: task.priority,
        estimated_minutes: task.estimated_minutes,
      },
    });

    // First task on this outcome → transition NOT_STARTED → IN_PROGRESS
    const outcome = store.get<{ status: string; version: number }>('outcomes', task.outcome_id);
    if (outcome.status === 'NOT_STARTED') {
      store.casUpdate('outcomes', task.outcome_id, outcome.version, { status: 'IN_PROGRESS' });
      store.emit({
        event: 'OUTCOME_IN_PROGRESS',
        outcome_id: task.outcome_id,
        payload: { reason: 'first task created' },
      });
    }

    return task;
  });
}

// =============================================================================
// 2. task.get
// =============================================================================

export interface TaskGetResult {
  task: Task;
  outcome: {
    id: string;
    title: string;
    status: string;
    goal_id: string;
  };
  goal: {
    id: string;
    title: string;
    status: string;
  };
}

export function taskGet(store: Store, task_id: string): TaskGetResult {
  const task = store.get<Task>('tasks', task_id);
  const outcome = store.get<{ id: string; title: string; status: string; goal_id: string }>(
    'outcomes',
    task.outcome_id,
  );
  const goal = store.get<{ id: string; title: string; status: string }>(
    'goals',
    outcome.goal_id,
  );
  return { task, outcome, goal };
}

// =============================================================================
// 3. task.claim (with lease)
// =============================================================================

export interface TaskClaimInput {
  task_id: string;
  owner: string;
  lease_ms?: number;
  fenced?: boolean;
}

export function taskClaim(store: Store, input: TaskClaimInput): Task {
  return store.transaction(() => {
    const task = store.get<Task>('tasks', input.task_id);
    guardTaskTransition(task.status, 'RUNNING');

    // Check lease is not held by someone else and still valid
    if (task.owner && task.lease_until && new Date(task.lease_until) > new Date()) {
      throw new LeaseHeldError(task.id, task.owner, task.lease_until);
    }

    const leaseMs = input.lease_ms ?? DEFAULT_LEASE_MS;
    if (!Number.isFinite(leaseMs) || leaseMs <= 0) throw new Error('lease_ms must be positive');
    const leaseUntil = new Date(Date.now() + leaseMs).toISOString();

    const updated = store.casUpdate<Task>('tasks', task.id, task.version, {
      status: 'RUNNING',
      owner: input.owner,
      lease_token: input.fenced || task.lease_token ? ulid() : null,
      heartbeat_at: null,
      worker_pid: null,
      worker_host: null,
      wake_at: null,
      wait_reason: null,
      lease_until: leaseUntil,
    });

    store.emit({
      event: 'TASK_CLAIMED',
      task_id: task.id,
      outcome_id: task.outcome_id,
      actor: input.owner,
      payload: { lease_until: leaseUntil },
    });

    return updated;
  });
}

export class LeaseHeldError extends Error {
  readonly kind = 'LEASE_HELD' as const;
  readonly retryable = true;

  constructor(
    public readonly taskId: string,
    public readonly owner: string,
    public readonly leaseUntil: string,
  ) {
    super(`Task ${taskId} lease held by ${owner} until ${leaseUntil}`);
  }
}

// =============================================================================
// 4. task.checkpoint (semantic checkpoint, DESIGN §13.1 + PRD §12)
// =============================================================================

export function taskCheckpoint(store: Store, task_id: string, payload: CheckpointPayload, leaseToken?: string): Task {
  return store.transaction(() => {
    const task = store.get<Task>('tasks', task_id);
    assertTaskLease(task, leaseToken);
    if (task.status === 'DONE' || task.status === 'FAILED') {
      throw new IllegalTransitionError(`cannot checkpoint terminal task (${task.status})`);
    }

    const updated = store.casUpdate<Task>('tasks', task_id, task.version, {
      summary: payload.summary,
      last_observation: payload.observation ?? task.last_observation,
      next_action: payload.next_action ?? task.next_action,
      // Note: criteria_delta lives on outcome side, but we record it on the
      // checkpoint event for observability.
    });

    // Persist artifact references (DESIGN §13.1)
    if (payload.artifacts && payload.artifacts.length > 0) {
      for (const ref of payload.artifacts) {
        store.raw()
          .prepare(
            `INSERT INTO artifacts (id, task_id, type, reference, metadata, created_at)
             VALUES (?, ?, ?, ?, ?, ?)`,
          )
          .run(ulid(), task_id, inferArtifactType(ref), ref, null, new Date().toISOString());
      }
    }

    store.emit({
      event: 'CHECKPOINT_CREATED',
      task_id,
      outcome_id: task.outcome_id,
      actor: task.owner,
      payload: {
        summary: payload.summary,
        observation: payload.observation,
        criteria_delta: payload.criteria_delta,
        artifacts: payload.artifacts,
        next_action: payload.next_action,
      },
    });

    return updated;
  });
}

function inferArtifactType(ref: string): 'url' | 'file' | 'pr' {
  if (ref.startsWith('PR:') || ref.startsWith('http')) return ref.startsWith('PR:') ? 'pr' : 'url';
  return 'file';
}

// =============================================================================
// 5. task.wait
// =============================================================================

export interface TaskWaitInput {
  lease_token?: string;
  task_id: string;
  wake_at: string; // ISO8601
  wake_condition?: WakeCondition;
  reason?: string;
}

export function taskWait(store: Store, input: TaskWaitInput): Task {
  return store.transaction(() => {
    const task = store.get<Task>('tasks', input.task_id);
    assertTaskLease(task, input.lease_token);
    guardTaskTransition(task.status, 'WAITING');

    const updated = store.casUpdate<Task>('tasks', task.id, task.version, {
      status: 'WAITING',
      wake_at: input.wake_at,
      wait_reason: 'timer',
      // Release lease on wait (Scheduler can re-claim)
      owner: null,
      lease_until: null,
    });

    store.emit({
      event: 'TASK_WAITING',
      task_id: task.id,
      outcome_id: task.outcome_id,
      actor: task.owner,
      payload: {
        wake_at: input.wake_at,
      wait_reason: 'timer',
        wake_condition: input.wake_condition,
        reason: input.reason,
      },
    });

    return updated;
  });
}

// =============================================================================
// 6. task.block
// =============================================================================

export interface TaskBlockInput {
  lease_token?: string;
  task_id: string;
  reason: string;
  context?: Record<string, unknown>;
}

export function taskBlock(store: Store, input: TaskBlockInput): Task {
  return store.transaction(() => {
    const task = store.get<Task>('tasks', input.task_id);
    assertTaskLease(task, input.lease_token);
    guardTaskTransition(task.status, 'BLOCKED');

    const updated = store.casUpdate<Task>('tasks', task.id, task.version, {
      status: 'BLOCKED',
      owner: null,
      lease_until: null,
    });

    store.emit({
      event: 'TASK_BLOCKED',
      task_id: task.id,
      outcome_id: task.outcome_id,
      actor: task.owner,
      payload: { reason: input.reason, context: input.context },
    });

    return updated;
  });
}

// =============================================================================
// 7. task.complete (→ DONE, triggers outcome-evaluate)
// =============================================================================

export function taskComplete(store: Store, task_id: string, summary?: string, leaseToken?: string): Task {
  return store.transaction(() => {
    const task = store.get<Task>('tasks', task_id);
    assertTaskLease(task, leaseToken);
    // Allow RUNNING → DONE; also allow VERIFYING → DONE
    guardTaskTransition(task.status, 'DONE');

    const updated = store.casUpdate<Task>('tasks', task.id, task.version, {
      status: 'DONE',
      summary: summary ?? task.summary,
      owner: null,
      lease_until: null,
    });

    store.emit({
      event: 'TASK_COMPLETED',
      task_id: task.id,
      outcome_id: task.outcome_id,
      actor: task.owner,
      payload: { summary: updated.summary },
    });

    return updated;
  });
}

// =============================================================================
// 8. task.fail (→ FAILED)
// =============================================================================

export interface TaskFailInput {
  lease_token?: string;
  task_id: string;
  reason: string;
  error?: Record<string, unknown>;
}

export function taskFail(store: Store, input: TaskFailInput): Task {
  return store.transaction(() => {
    const task = store.get<Task>('tasks', input.task_id);
    assertTaskLease(task, input.lease_token);
    guardTaskTransition(task.status, 'FAILED');

    const updated = store.casUpdate<Task>('tasks', task.id, task.version, {
      status: 'FAILED',
      summary: input.reason,
      owner: null,
      lease_until: null,
    });

    store.emit({
      event: 'TASK_FAILED',
      task_id: task.id,
      outcome_id: task.outcome_id,
      actor: task.owner,
      payload: { reason: input.reason, error: input.error },
    });

    return updated;
  });
}