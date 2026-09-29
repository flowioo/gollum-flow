/**
 * Evidence tools (DESIGN §8.5 — 2 core tools)
 *
 * 1. evidence.create
 * 2. evidence.list
 *
 * Evidence 挂在 Criterion 上 (PRD §7 + DESIGN §4.1)
 */

import { ulid } from 'ulid';
import { type Store } from '../workflow/store/store.js';
import { criterionAttachEvidence } from './criterion.js';
import type { Evidence, EvidenceStatus } from '../workflow/model/types.js';

// =============================================================================
// 1. evidence.create (delegates to criterion.attach_evidence)
// =============================================================================

export interface EvidenceCreateInput {
  criterion_id: string;
  executor?: string;
  status: EvidenceStatus;
  data?: Record<string, unknown>;
}

export function evidenceCreate(store: Store, input: EvidenceCreateInput): Evidence {
  const evidence: Evidence = {
    id: ulid(),
    criterion_id: input.criterion_id,
    executor: input.executor ?? null,
    status: input.status,
    data: input.data ?? null,
    observed_at: new Date().toISOString(),
  };

  // Delegate to criterion.attach_evidence for derived_status update + event
  criterionAttachEvidence(store, { criterion_id: input.criterion_id, evidence });

  return evidence;
}

// =============================================================================
// 2. evidence.list
// =============================================================================

export function evidenceList(store: Store, criterion_id: string): Evidence[] {
  return store
    .list<Evidence>('evidences', 'criterion_id = ? ORDER BY observed_at DESC', [criterion_id])
    .map(parseEvidence);
}

function parseEvidence(row: Evidence): Evidence {
  return {
    ...row,
    data: row.data ? JSON.parse(row.data as any) : null,
  };
}