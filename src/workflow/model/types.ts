/**
 * Core domain types for Gollum V0.1
 * Based on DESIGN.md §4 data model + PRD.md §4 七层语义模型
 */

// =============================================================================
// ULID helper (re-export from ulid package, project uses ulid for IDs)
// =============================================================================

// =============================================================================
// Status enums
// =============================================================================

export type GoalStatus = 'active' | 'achieved' | 'abandoned';

export type OutcomeStatus =
  | 'NOT_STARTED'
  | 'IN_PROGRESS'
  | 'BLOCKED'
  | 'VERIFIED'
  | 'FAILED';

export type CriterionStatus = 'UNVERIFIED' | 'PASS' | 'FAIL' | 'UNKNOWN';

export type TaskStatus =
  | 'PENDING'
  | 'RUNNING'
  | 'WAITING'
  | 'BLOCKED'
  | 'VERIFYING'
  | 'RECOVERING'
  | 'DONE'
  | 'FAILED';

export type AlignmentVerdict = 'aligned' | 'uncertain' | 'misaligned';

export type EvidenceStatus = 'PASS' | 'FAIL' | 'UNKNOWN';

export type ExecutorType = 'codex' | 'claude-code' | 'workbuddy';

export type ArtifactType = 'file' | 'pr' | 'url' | 'screenshot' | 'log';

// =============================================================================
// ToolResult (DESIGN §20)
// =============================================================================

export type VerifyStatus = 'PASS' | 'FAIL' | 'UNKNOWN';

export interface ToolResult<T = unknown> {
  ok: boolean;
  status: VerifyStatus;
  data?: T;
  observation: string;
  evidence: Record<string, unknown>;
  error: {
    type: string;
    message: string;
    retryable: boolean;
  } | null;
}

// =============================================================================
// Verifier types (Criterion §7.3 in PRD)
// =============================================================================

export type VerifierType =
  | 'command'
  | 'git'
  | 'outcome_criterion'
  | 'timer_check'
  | 'human_assert';

export interface VerifierSpec {
  type: VerifierType;
  config: Record<string, unknown>;
}

// =============================================================================
// Core entities (9 tables)
// =============================================================================

export interface Project {
  id: string;
  name: string;
  description: string | null;
  created_at: string;
  updated_at: string;
}

export interface Goal {
  id: string;
  project_id: string;
  title: string;
  description: string | null;
  status: GoalStatus;
  version: number;
  created_at: string;
  updated_at: string;
}

export interface Outcome {
  id: string;
  goal_id: string;
  title: string;
  status: OutcomeStatus;
  criteria_ids: string[];
  priority: number;
  version: number;
  created_at: string;
  updated_at: string;
}

export interface Criterion {
  id: string;
  outcome_id: string;
  description: string;
  verifier: VerifierSpec | null;
  latest_evidence_id: string | null;
  derived_status: CriterionStatus;
  version: number;
  created_at: string;
  updated_at: string;
}

export interface Task {
  id: string;
  outcome_id: string;
  title: string;
  status: TaskStatus;
  phase: string | null;
  priority: number;
  acceptance_criteria: string[];
  alignment_verdict: AlignmentVerdict;
  alignment_reason: string | null;
  owner: string | null;
  lease_until: string | null;
  lease_token?: string | null;
  wait_reason?: string | null;
  wake_at: string | null;
  retry_count: number;
  next_action: string | null;
  summary: string | null;
  last_observation: string | null;
  estimated_minutes: number | null;
  /** V0.2 self-evolution: when worker last touched this task (heartbeat watchdog) */
  heartbeat_at: string | null;
  /** V0.2 self-evolution: PID of worker process that claimed this task */
  worker_pid: number | null;
  /** V0.2 self-evolution: hostname of worker (multi-machine safety) */
  worker_host: string | null;
  version: number;
  created_at: string;
  updated_at: string;
}

export interface Execution {
  id: string;
  task_id: string;
  executor: ExecutorType;
  session_id: string | null;
  started_at: string;
  finished_at: string | null;
  result: EvidenceStatus | null;
  error: string | null;
  retry_of: string | null;
}

export interface Evidence {
  id: string;
  criterion_id: string;
  executor: string | null;
  status: EvidenceStatus;
  data: Record<string, unknown> | null;
  observed_at: string;
}

export interface Artifact {
  id: string;
  task_id: string;
  type: ArtifactType;
  reference: string;
  metadata: Record<string, unknown> | null;
  created_at: string;
}

// =============================================================================
// Computed views
// =============================================================================

export interface RemainingGap {
  total: number;
  pass: number;
  fail: number;
  unknown: number;
  unverified: number;
  remaining: number;
}

// =============================================================================
// Checkpoint payload
// =============================================================================

export interface CheckpointPayload {
  summary: string;
  observation?: string;
  criteria_delta?: Record<string, { from: CriterionStatus; to: CriterionStatus }>;
  artifacts?: string[];
  next_action?: string;
}

// =============================================================================
// WakeCondition (DESIGN §7.3)
// =============================================================================

export type WakeConditionType = 'timer' | 'github_pr' | 'ci_status';

export interface WakeCondition {
  type: WakeConditionType;
  config: Record<string, unknown>;
}