/**
 * Criterion tools (DESIGN §8.4 — 4 core tools)
 *
 * 1. criterion.create
 * 2. criterion.get
 * 3. criterion.list
 * 4. criterion.attach_evidence
 *
 * Criterion 三段式：criterion → verifier → evidence (PRD §7)
 */

import { ulid } from 'ulid';
import { NotFoundError, type Store } from '../workflow/store/store.js';
import type { Criterion, VerifierSpec } from '../workflow/model/types.js';

// =============================================================================
// 1. criterion.create
// =============================================================================

export interface CriterionCreateInput {
  outcome_id: string;
  description: string;
  verifier: VerifierSpec;  // 必填；UNVERIFIED = 没绑定 verifier
}

export function criterionCreate(store: Store, input: CriterionCreateInput): Criterion {
  if (!store.tryGet('outcomes', input.outcome_id)) {
    throw new NotFoundError('outcomes', input.outcome_id);
  }
  if (!input.verifier) {
    throw new Error(
      'Verifier is required (PRD §7.4): criterion without verifier is UNVERIFIED and unusable',
    );
  }

  const now = new Date().toISOString();
  const criterion: Criterion = {
    id: ulid(),
    outcome_id: input.outcome_id,
    description: input.description,
    verifier: input.verifier,
    latest_evidence_id: null,
    derived_status: 'UNVERIFIED', // remains UNVERIFIED until evidence attaches
    version: 1,
    created_at: now,
    updated_at: now,
  };

  store.raw()
    .prepare(
      `INSERT INTO criteria (id, outcome_id, description, verifier, latest_evidence_id, derived_status, version, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      criterion.id,
      criterion.outcome_id,
      criterion.description,
      JSON.stringify(criterion.verifier),
      criterion.latest_evidence_id,
      criterion.derived_status,
      criterion.version,
      criterion.created_at,
      criterion.updated_at,
    );

  // Update Outcome.criteria_ids
  const outcome = store.get<{ criteria_ids: string; version: number }>(
    'outcomes',
    criterion.outcome_id,
  );
  const ids = JSON.parse(outcome.criteria_ids) as string[];
  ids.push(criterion.id);
  store.casUpdate('outcomes', criterion.outcome_id, outcome.version, {
    criteria_ids: JSON.stringify(ids) as unknown as string[],
  });

  store.emit({
    event: 'CRITERION_CREATED',
    outcome_id: criterion.outcome_id,
    payload: {
      criterion_id: criterion.id,
      description: criterion.description,
      verifier_type: input.verifier.type,
    },
  });

  return criterion;
}

// =============================================================================
// 2. criterion.get
// =============================================================================

export interface CriterionGetResult {
  criterion: Criterion;
  latest_evidence: import('../workflow/model/types.js').Evidence | null;
}

export function criterionGet(store: Store, criterion_id: string): CriterionGetResult {
  const criterion = parseCriterion(store.get<Criterion>('criteria', criterion_id));
  let latest_evidence: import('../workflow/model/types.js').Evidence | null = null;
  if (criterion.latest_evidence_id) {
    latest_evidence = store.tryGet('evidences', criterion.latest_evidence_id);
  }
  return { criterion, latest_evidence };
}

// =============================================================================
// 3. criterion.list
// =============================================================================

export function criterionList(store: Store, outcome_id: string): Criterion[] {
  return store
    .list<Criterion>('criteria', 'outcome_id = ?', [outcome_id])
    .map(parseCriterion);
}

// =============================================================================
// 4. criterion.attach_evidence
// =============================================================================

export interface AttachEvidenceInput {
  criterion_id: string;
  evidence: import('../workflow/model/types.js').Evidence;
}

/**
 * Attach evidence to a criterion, derive new status, and propagate to outcome.
 * 这是 Outcome VERIFIED 判定的核心调用（DESIGN §5.3）。
 */
export function criterionAttachEvidence(
  store: Store,
  input: AttachEvidenceInput,
): Criterion {
  const criterion = store.get<Criterion>('criteria', input.criterion_id);
  if (!criterion.verifier) {
    throw new Error(`Criterion ${criterion.id} has no verifier, status is UNVERIFIED`);
  }

  // Persist evidence
  store.raw()
    .prepare(
      `INSERT INTO evidences (id, criterion_id, executor, status, data, observed_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(
      input.evidence.id,
      input.evidence.criterion_id,
      input.evidence.executor,
      input.evidence.status,
      input.evidence.data ? JSON.stringify(input.evidence.data) : null,
      input.evidence.observed_at,
    );

  // Derive new status (DESIGN §5.3)
  const newStatus = deriveStatus(input.evidence.status);
  const previousStatus = criterion.derived_status;

  const updated = store.casUpdate<Criterion>(
    'criteria',
    criterion.id,
    criterion.version,
    {
      latest_evidence_id: input.evidence.id,
      derived_status: newStatus,
    },
  );

  store.emit({
    event: newStatus === 'PASS' ? 'CRITERION_VERIFIED' : `CRITERION_${newStatus}`,
    outcome_id: criterion.outcome_id,
    payload: {
      criterion_id: criterion.id,
      from_status: previousStatus,
      to_status: newStatus,
      evidence_id: input.evidence.id,
    },
  });

  return parseCriterion(updated);
}

// =============================================================================
// Helpers
// =============================================================================

function deriveStatus(evidenceStatus: 'PASS' | 'FAIL' | 'UNKNOWN'): Criterion['derived_status'] {
  return evidenceStatus; // simple 1:1 mapping per DESIGN §5.3
}

function parseCriterion(row: Criterion): Criterion {
  return {
    ...row,
    verifier: row.verifier ? JSON.parse(row.verifier as any) : null,
  };
}