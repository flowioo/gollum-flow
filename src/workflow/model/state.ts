/**
 * State machines for Task and Outcome (DESIGN §5)
 *
 * These are pure transition tables. Enforcing them is the caller's
 * responsibility (use before casUpdate).
 */

import type { TaskStatus, OutcomeStatus } from './types.js';

// =============================================================================
// Task state machine
// =============================================================================

/**
 * Allowed Task status transitions (DESIGN §5.1).
 * PENDING → RUNNING is the main entry.
 * RUNNING is the busy state and can branch to WAITING, BLOCKED, VERIFYING, etc.
 */
const TASK_TRANSITIONS: Record<TaskStatus, readonly TaskStatus[]> = {
  PENDING: ['RUNNING', 'BLOCKED', 'FAILED'],
  RUNNING: ['WAITING', 'BLOCKED', 'VERIFYING', 'RECOVERING', 'DONE', 'FAILED'],
  WAITING: ['RUNNING', 'FAILED'],
  BLOCKED: ['RUNNING', 'FAILED'],
  VERIFYING: ['DONE', 'RECOVERING', 'FAILED'],
  RECOVERING: ['RUNNING', 'FAILED'],
  DONE: [], // terminal
  FAILED: [], // terminal
};

export function canTransitionTask(from: TaskStatus, to: TaskStatus): boolean {
  return TASK_TRANSITIONS[from].includes(to);
}

export function assertTaskTransition(from: TaskStatus, to: TaskStatus): void {
  if (!canTransitionTask(from, to)) {
    throw new IllegalTransitionError(`Task: ${from} → ${to}`);
  }
}

export function isTaskTerminal(status: TaskStatus): boolean {
  return status === 'DONE' || status === 'FAILED';
}

// =============================================================================
// Outcome state machine
// =============================================================================

/**
 * Allowed Outcome status transitions (DESIGN §5.2).
 * VERIFIED requires all Criteria.derived_status == PASS (enforced in tools).
 */
const OUTCOME_TRANSITIONS: Record<OutcomeStatus, readonly OutcomeStatus[]> = {
  NOT_STARTED: ['IN_PROGRESS', 'FAILED'],
  IN_PROGRESS: ['VERIFIED', 'FAILED', 'BLOCKED'],
  BLOCKED: ['IN_PROGRESS', 'FAILED'],
  VERIFIED: ['IN_PROGRESS'], // rare: Goal adjustment reopens
  FAILED: ['IN_PROGRESS'], // rare: Goal adjustment allows retry
};

export function canTransitionOutcome(from: OutcomeStatus, to: OutcomeStatus): boolean {
  return OUTCOME_TRANSITIONS[from].includes(to);
}

export function assertOutcomeTransition(from: OutcomeStatus, to: OutcomeStatus): void {
  if (!canTransitionOutcome(from, to)) {
    throw new IllegalTransitionError(`Outcome: ${from} → ${to}`);
  }
}

export function isOutcomeTerminal(status: OutcomeStatus): boolean {
  return status === 'VERIFIED' || status === 'FAILED';
}

// =============================================================================
// Errors
// =============================================================================

export class IllegalTransitionError extends Error {
  readonly kind = 'ILLEGAL_TRANSITION' as const;
  readonly retryable = false;

  constructor(message: string) {
    super(`Illegal state transition: ${message}`);
  }
}

// =============================================================================
// State transition helpers (used by tools)
// =============================================================================

/**
 * Check if a status transition is allowed and throw if not.
 * Used by tools/* before invoking casUpdate.
 */
export function guardTaskTransition(from: TaskStatus, to: TaskStatus): void {
  assertTaskTransition(from, to);
}

export function guardOutcomeTransition(from: OutcomeStatus, to: OutcomeStatus): void {
  assertOutcomeTransition(from, to);
}