/**
 * Outcome tools (DESIGN §8.2 — 5 core tools)
 *
 * 1. outcome.list_active
 * 2. outcome.get
 * 3. outcome.remaining_gap
 * 4. outcome.update
 * 5. outcome.mark_verified
 */

import { ulid } from 'ulid';
import { NotFoundError, type Store } from '../workflow/store/store.js';
import { guardOutcomeTransition } from '../workflow/model/state.js';
import type { Outcome, OutcomeStatus, RemainingGap } from '../workflow/model/types.js';

// =============================================================================
// 1. outcome.list_active
// =============================================================================

export interface OutcomeListActiveInput {
  goal_id?: string;
}

export function outcomeListActive(
  store: Store,
  input: OutcomeListActiveInput = {},
): Outcome[] {
  const where = input.goal_id
    ? `goal_id = ? AND status IN ('IN_PROGRESS', 'BLOCKED')`
    : `status IN ('IN_PROGRESS', 'BLOCKED')`;
  const params = input.goal_id ? [input.goal_id] : [];
  const rows = store.list<Outcome>('outcomes', where, params);
  return rows.map(parseOutcome);
}

// =============================================================================
// 2. outcome.get
// =============================================================================

export interface OutcomeGetResult {
  outcome: Outcome;
  criteria: import('../workflow/model/types.js').Criterion[];
}

export function outcomeGet(store: Store, outcome_id: string): OutcomeGetResult {
  const outcome = parseOutcome(store.get<Outcome>('outcomes', outcome_id));
  const criteria = store
    .list<import('../workflow/model/types.js').Criterion>(
      'criteria',
      'outcome_id = ?',
      [outcome_id],
    )
    .map(parseCriterion);
  return { outcome, criteria };
}

// =============================================================================
// 3. outcome.remaining_gap (DESIGN §11 — 替代 progress 数字)
// =============================================================================

export function outcomeRemainingGap(store: Store, outcome_id: string): RemainingGap {
  const criteria = store.list<import('../workflow/model/types.js').Criterion>(
    'criteria',
    'outcome_id = ?',
    [outcome_id],
  );

  const gap: RemainingGap = {
    total: criteria.length,
    pass: 0,
    fail: 0,
    unknown: 0,
    unverified: 0,
    remaining: 0,
  };

  for (const c of criteria) {
    switch (c.derived_status) {
      case 'PASS':
        gap.pass++;
        break;
      case 'FAIL':
        gap.fail++;
        break;
      case 'UNKNOWN':
        gap.unknown++;
        break;
      case 'UNVERIFIED':
        gap.unverified++;
        break;
    }
  }
  gap.remaining = gap.fail + gap.unknown + gap.unverified;
  return gap;
}

// =============================================================================
// 4. outcome.update (CAS)
// =============================================================================

export type OutcomePatch = {
  title?: string;
  status?: OutcomeStatus;
  priority?: number;
  criteria_ids?: unknown; // accepts string[] | JSON-string; serialized internally
};

export function outcomeUpdate(
  store: Store,
  outcome_id: string,
  expected_version: number,
  patch: OutcomePatch,
): Outcome {
  const outcome = store.get<Outcome>('outcomes', outcome_id);
  if (patch.status) {
    guardOutcomeTransition(outcome.status, patch.status);
  }
  const updated = store.casUpdate<Outcome>('outcomes', outcome_id, expected_version, patch as Partial<Outcome>);

  store.emit({
    event: 'OUTCOME_UPDATED',
    outcome_id,
    goal_id: outcome.goal_id,
    payload: { patch, old_status: outcome.status, new_status: updated.status },
  });

  return parseOutcome(updated);
}

// =============================================================================
// 5. outcome.mark_verified (校验所有 criteria PASS 后置 VERIFIED)
// =============================================================================

/**
 * Auto-evaluation entry point: returns true if all criteria are PASS
 * AND current status is IN_PROGRESS / NOT_STARTED → transition to VERIFIED.
 *
 * Auto-cascades through IN_PROGRESS if current status is NOT_STARTED
 * (i.e., caller hasn't created any Tasks but already verified via direct evidence).
 */
export function outcomeMarkVerified(store: Store, outcome_id: string): Outcome {
  const outcome = store.get<Outcome>('outcomes', outcome_id);
  const gap = outcomeRemainingGap(store, outcome_id);

  if (gap.unverified > 0) {
    throw new Error(
      `Cannot mark Outcome ${outcome_id} VERIFIED: ${gap.unverified} criteria UNVERIFIED (missing verifier)`,
    );
  }
  if (gap.fail > 0 || gap.unknown > 0) {
    throw new Error(
      `Cannot mark Outcome ${outcome_id} VERIFIED: remaining gap = ${gap.remaining}`,
    );
  }

  let current = outcome;
  // Auto-cascade NOT_STARTED → IN_PROGRESS if needed
  if (current.status === 'NOT_STARTED') {
    current = store.casUpdate<Outcome>('outcomes', outcome_id, current.version, {
      status: 'IN_PROGRESS',
    });
    store.emit({
      event: 'OUTCOME_IN_PROGRESS',
      outcome_id,
      payload: { reason: 'auto before mark_verified' },
    });
  }

  guardOutcomeTransition(current.status, 'VERIFIED');

  const updated = store.casUpdate<Outcome>('outcomes', outcome_id, current.version, {
    status: 'VERIFIED',
  });

  store.emit({
    event: 'OUTCOME_VERIFIED',
    outcome_id,
    goal_id: outcome.goal_id,
    payload: { total_criteria: gap.total },
  });

  // Trigger Goal.achieve check (DESIGN §8.3)
  maybeAchieveGoal(store, outcome.goal_id);

  return parseOutcome(updated);
}

// =============================================================================
// Helpers
// =============================================================================

function maybeAchieveGoal(store: Store, goal_id: string): void {
  const outcomes = store.list<Outcome>('outcomes', 'goal_id = ?', [goal_id]);
  const allVerified = outcomes.every((o) => o.status === 'VERIFIED' || o.status === 'FAILED');
  if (!allVerified) return;

  const verifiedCount = outcomes.filter((o) => o.status === 'VERIFIED').length;
  if (verifiedCount !== outcomes.length) return; // some FAILED → don't auto-achieve

  const goal = store.get<{ status: string; version: number }>('goals', goal_id);
  if (goal.status !== 'active') return;

  store.casUpdate('goals', goal_id, goal.version, { status: 'achieved' });
  store.emit({
    event: 'GOAL_ACHIEVED',
    goal_id,
    payload: { total_outcomes: outcomes.length, verified: verifiedCount },
  });
}

function parseOutcome(row: Outcome): Outcome {
  return {
    ...row,
    criteria_ids: parseJSONArray(row.criteria_ids as unknown as string),
    priority: row.priority,
  };
}

function parseCriterion(row: any): any {
  return { ...row, verifier: row.verifier ? JSON.parse(row.verifier) : null };
}

function parseJSONArray<T>(s: string | null | undefined): T[] {
  if (!s) return [];
  try {
    return JSON.parse(s) as T[];
  } catch {
    return [];
  }
}

// =============================================================================
// Factory (for CLI / Planner)
// =============================================================================

export interface OutcomeCreateInput {
  goal_id: string;
  title: string;
  priority?: number;
}

export function outcomeCreate(store: Store, input: OutcomeCreateInput): Outcome {
  if (!store.tryGet('goals', input.goal_id)) {
    throw new NotFoundError('goals', input.goal_id);
  }
  const now = new Date().toISOString();
  const outcome: Outcome = {
    id: ulid(),
    goal_id: input.goal_id,
    title: input.title,
    status: 'NOT_STARTED',
    criteria_ids: [],
    priority: input.priority ?? 0,
    version: 1,
    created_at: now,
    updated_at: now,
  };
  store.raw()
    .prepare(
      `INSERT INTO outcomes (id, goal_id, title, status, criteria_ids, priority, version, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      outcome.id,
      outcome.goal_id,
      outcome.title,
      outcome.status,
      JSON.stringify(outcome.criteria_ids),
      outcome.priority,
      outcome.version,
      outcome.created_at,
      outcome.updated_at,
    );
  store.emit({
    event: 'OUTCOME_CREATED',
    outcome_id: outcome.id,
    goal_id: outcome.goal_id,
    payload: { title: outcome.title, priority: outcome.priority },
  });
  return outcome;
}