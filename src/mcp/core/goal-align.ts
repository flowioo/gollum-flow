/**
 * Goal Alignment Skill (DESIGN §9.6 / PRD §9)
 *
 * 三级判定：
 *   aligned      → 推进 Outcome.criterion        → continue
 *   uncertain    → 不确定 / evidence 矛盾        → re-evaluate / replan
 *   misaligned   → 与 Outcome 无关 / scope creep → pause + rollback / backlog / 换 task
 *
 * 双轨判断（V0.1 收敛版）：
 *   1. Evidence-based check (客观):
 *      - outcome.remaining_gap 是否减少？
 *      - criterion.derived_status 是否有 PASS？
 *   2. LLM semantic check (主观):
 *      - V0.1 用 keyword matching 模拟 LLM
 *      - 检查 task title/acceptance 是否提到 scope creep 关键词
 *      - 检查 task 是否描述与 Outcome 标题完全无关的内容
 *
 * misaligned 默认不找人 (PRD §15):
 *   pause current task → rollback / backlog → choose another task
 *
 * Human Boundary (PRD §15):
 *   仅在改变 Goal 边界、删除关键 Outcome、扩大 scope、不可逆操作、高风险操作时找人
 */

import { type Store } from '../workflow/store/store.js';
import type { Task, AlignmentVerdict, Outcome } from '../workflow/model/types.js';
import { outcomeRemainingGap, outcomeGet } from './outcome.js';

// =============================================================================
// LLM semantic check (V0.1: keyword matching as placeholder)
// =============================================================================

const SCOPE_CREEP_KEYWORDS = [
  'refactor',
  'rewrite',
  'redesign',
  'rebuild',
  '抽象',
  '重构',
  '重写',
  '重设计',
  '重新设计',
  '抽象出',
  'plugin',
  '插件',
  'runtime',
  'framework',
  'clean up',
  'optimize',
  'improve',
];

interface LLMSemanticResult {
  verdict: AlignmentVerdict;
  reason: string;
  confidence: number;
}

/**
 * V0.1: simulate LLM via keyword matching.
 * V0.5: replace with actual LLM call.
 */
export function llmSemanticCheck(
  task: Task,
  outcome: Outcome,
  goalDescription?: string,
): LLMSemanticResult {
  // acceptance_criteria may be string (DB JSON) or string[] (typed)
  const ac = Array.isArray(task.acceptance_criteria)
    ? task.acceptance_criteria
    : safeJsonArray(task.acceptance_criteria as unknown);
  const text = `${task.title} ${ac.join(' ')}`.toLowerCase();

  // 1. Scope creep detection: keyword match
  const matchedKeyword = SCOPE_CREEP_KEYWORDS.find((kw) =>
    text.includes(kw.toLowerCase()),
  );
  if (matchedKeyword) {
    return {
      verdict: 'misaligned',
      reason: `scope creep keyword "${matchedKeyword}" detected`,
      confidence: 0.85,
    };
  }

  // 2. Outcome-relevance: do task words overlap with outcome title?
  const outcomeWords = outcome.title.toLowerCase().split(/\s+/).filter((w) => w.length > 0);
  const taskWords = text.split(/\s+/).filter((w) => w.length > 0);
  // Check for substring overlap (handles "test" matching "tests", "测试" matching "测试中" etc.)
  const overlap = outcomeWords.filter(
    (w) => w.length >= 2 && taskWords.some((tw) => tw.length >= 2 && (tw.includes(w) || w.includes(tw))),
  );
  if (overlap.length === 0) {
    return {
      verdict: 'misaligned',
      reason: `no word overlap with outcome "${outcome.title}"`,
      confidence: 0.6,
    };
  }

  // 3. Goal-alignment check
  if (goalDescription) {
    const goalWords = goalDescription.toLowerCase().split(/\s+/).filter((w) => w.length > 0);
    const goalOverlap = goalWords.filter(
      (w) => w.length >= 2 && taskWords.some((tw) => tw.length >= 2 && (tw.includes(w) || w.includes(tw))),
    );
    if (goalOverlap.length === 0) {
      return {
        verdict: 'uncertain',
        reason: `task doesn't mention Goal keywords`,
        confidence: 0.4,
      };
    }
  }

  return {
    verdict: 'aligned',
    reason: `task words overlap with outcome: ${overlap.slice(0, 3).join(', ')}`,
    confidence: 0.7,
  };
}

function safeJsonArray(v: unknown): string[] {
  if (Array.isArray(v)) return v as string[];
  if (typeof v === 'string') {
    try { return JSON.parse(v); } catch { return []; }
  }
  return [];
}

// =============================================================================
// Evidence-based check (objective)
// =============================================================================

export type ObjectiveVerdict = 'aligned' | 'regression' | 'neutral';

interface EvidenceBasedResult {
  verdict: ObjectiveVerdict;
  reason: string;
  remainingGap: number;
  passCount: number;
}

/**
 * Check if the Task has historically advanced the Outcome.
 *
 * V0.1 simplification: just look at current remaining_gap.
 *   remaining_gap > 0   → 'aligned' (still needs work, not regression)
 *   remaining_gap = 0   → 'aligned' (Outcome VERIFIED, this task contributed)
 *   (no event history needed for V0.1)
 *
 * V0.5: look at task_events to see if previous executions of similar tasks
 *       reduced remaining_gap → true evidence of forward motion.
 */
export function evidenceBasedCheck(
  store: Store,
  task: Task,
  outcome: Outcome,
): EvidenceBasedResult {
  const gap = outcomeRemainingGap(store, outcome.id);

  if (gap.remaining === 0) {
    return {
      verdict: 'aligned',
      reason: 'all criteria PASS, outcome VERIFIED',
      remainingGap: 0,
      passCount: gap.pass,
    };
  }

  return {
    verdict: 'aligned',
    reason: `${gap.remaining}/${gap.total} criteria remaining, task still relevant`,
    remainingGap: gap.remaining,
    passCount: gap.pass,
  };
}

// =============================================================================
// Combined verdict (V0.1 收敛版)
// =============================================================================

export interface GoalAlignInput {
  task_id: string;
  goal_description?: string;
}

export interface GoalAlignResult {
  task_id: string;
  outcome_id: string;
  objective: ObjectiveVerdict;
  llm: AlignmentVerdict;
  verdict: AlignmentVerdict; // final (most conservative)
  reason: string;
  confidence: number;
  evidence: {
    remaining_gap: number;
    pass_count: number;
    llm_reason: string;
  };
}

export function goalAlign(store: Store, input: GoalAlignInput): GoalAlignResult {
  const task = store.get<Task>('tasks', input.task_id);
  const { outcome } = outcomeGet(store, task.outcome_id);
  const goal = store.get<{ description: string | null }>('goals', outcome.goal_id);

  const objective = evidenceBasedCheck(store, task, outcome);
  const llm = llmSemanticCheck(
    task,
    outcome,
    input.goal_description ?? goal.description ?? undefined,
  );

  // Take most conservative
  let verdict: AlignmentVerdict;
  if (objective.verdict === 'regression' || llm.verdict === 'misaligned') {
    verdict = 'misaligned';
  } else if (objective.verdict === 'aligned' && llm.verdict === 'aligned') {
    verdict = 'aligned';
  } else {
    verdict = 'uncertain';
  }

  const reason = `objective=${objective.verdict} (${objective.reason}); llm=${llm.verdict} (${llm.reason})`;

  // Emit event
  store.emit({
    event: 'GOAL_ALIGNMENT_CHECKED',
    task_id: task.id,
    outcome_id: outcome.id,
    goal_id: outcome.goal_id,
    payload: {
      objective: objective.verdict,
      llm: llm.verdict,
      verdict,
      reason,
      confidence: llm.confidence,
    },
  });

  return {
    task_id: task.id,
    outcome_id: outcome.id,
    objective: objective.verdict,
    llm: llm.verdict,
    verdict,
    reason,
    confidence: llm.confidence,
    evidence: {
      remaining_gap: objective.remainingGap,
      pass_count: objective.passCount,
      llm_reason: llm.reason,
    },
  };
}

// =============================================================================
// Misaligned handler (PRD §15: 不找人, Agent 自处理)
// =============================================================================

export interface MisalignedAction {
  action: 'paused' | 'rolled_back' | 'left_for_replan';
  task: Task;
  reason: string;
}

/**
 * Apply misaligned verdict to a Task (PRD §15: 自处理, 不找人):
 *   1. Pause the current task (status → PENDING)
 *   2. Increment retry_count (so scheduler knows it's been rejected)
 *   3. Emit TASK_REJECTED_MISALIGNED event
 *   4. Return control to Scheduler — it will pick another task
 */
export function handleMisaligned(
  store: Store,
  task: Task,
  reason: string,
): MisalignedAction {
  const updated = store.casUpdate<Task>('tasks', task.id, task.version, {
    status: 'PENDING',
    owner: null,
    lease_until: null,
    summary: `[misaligned] ${reason}`,
  });

  store.emit({
    event: 'TASK_REJECTED_MISALIGNED',
    task_id: task.id,
    outcome_id: task.outcome_id,
    actor: 'goal-align',
    payload: {
      reason,
      note: 'PRD §15: misaligned handled by Agent, NOT escalated to Human',
    },
  });

  return {
    action: 'paused',
    task: updated,
    reason,
  };
}

// =============================================================================
// Uncertainty handler (re-evaluate / replan)
// =============================================================================

/**
 * uncertain verdict: re-evaluate by calling outcome-evaluate again.
 * Caller should re-plan based on remaining_gap.
 */
export function handleUncertain(store: Store, task: Task): { task: Task; reason: string } {
  const { outcome, criteria } = outcomeGet(store, task.outcome_id);
  const gap = outcomeRemainingGap(store, outcome.id);

  store.emit({
    event: 'TASK_REJECTED_MISALIGNED',
    task_id: task.id,
    outcome_id: task.outcome_id,
    actor: 'goal-align',
    payload: {
      reason: 'uncertain, replan',
      uncertain_criteria: criteria.length - gap.pass,
      note: 're-evaluate Outcome Gap and choose more relevant task',
    },
  });

  // Don't pause; let agent continue but with awareness
  return { task, reason: `uncertain: ${gap.remaining} criteria remaining, replan` };
}