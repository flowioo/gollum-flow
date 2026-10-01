/**
 * Planner (DESIGN §13.1)
 *
 * V0.1 minimum: estimate task duration, warn if > 30min, suggest split.
 *
 * V0.1 不做 outcome-decompose（自动拆 Outcome / Task）— 由用户提供骨架。
 * Planner 的角色：
 * 1. 校验 estimated_minutes，> 30min 报错
 * 2. 校验 Criterion 三段式：verifier 必须存在
 * 3. 提供"软警告"：每 Goal ≤ 7 Outcome，每 Outcome ≤ 5 criteria
 */

import type { VerifierSpec } from './model/types.js';

// =============================================================================
// Constants (DESIGN §13.1 + PRD §5)
// =============================================================================

export const MAX_TASK_MINUTES = 30;
export const MIN_TASK_MINUTES = 5;
export const SOFT_MAX_OUTCOMES_PER_GOAL = 7;
export const SOFT_MAX_CRITERIA_PER_OUTCOME = 5;

// =============================================================================
// Types
// =============================================================================

export interface PlannedTask {
  title: string;
  acceptance_criteria: string[];
  estimated_minutes: number;
}

export interface PlannedCriterion {
  description: string;
  verifier: VerifierSpec; // 必填
}

export interface PlannedOutcome {
  title: string;
  criteria: PlannedCriterion[];
  tasks: PlannedTask[];
}

export interface PlannedGoal {
  title: string;
  description?: string;
  outcomes: PlannedOutcome[];
}

// =============================================================================
// Validation
// =============================================================================

export interface PlannerWarning {
  level: 'error' | 'warning';
  scope: 'goal' | 'outcome' | 'task' | 'criterion';
  ref?: string;
  message: string;
}

export interface PlannerResult {
  ok: boolean;
  warnings: PlannerWarning[];
}

/**
 * Validate a planned structure (called by CLI before persisting).
 * Returns warnings; ok=false if there are any 'error' level issues.
 */
export function validatePlan(plan: PlannedGoal): PlannerResult {
  const warnings: PlannerWarning[] = [];

  // Goal-level
  if (plan.outcomes.length > SOFT_MAX_OUTCOMES_PER_GOAL) {
    warnings.push({
      level: 'warning',
      scope: 'goal',
      message: `Goal has ${plan.outcomes.length} outcomes (> ${SOFT_MAX_OUTCOMES_PER_GOAL} soft limit). Consider splitting into multiple Goals.`,
    });
  }

  // Outcome-level
  for (const outcome of plan.outcomes) {
    if (outcome.criteria.length > SOFT_MAX_CRITERIA_PER_OUTCOME) {
      warnings.push({
        level: 'warning',
        scope: 'outcome',
        ref: outcome.title,
        message: `Outcome has ${outcome.criteria.length} criteria (> ${SOFT_MAX_CRITERIA_PER_OUTCOME} soft limit).`,
      });
    }
    if (outcome.criteria.length === 0) {
      warnings.push({
        level: 'error',
        scope: 'outcome',
        ref: outcome.title,
        message: 'Outcome must have at least 1 criterion (otherwise it cannot be VERIFIED).',
      });
    }

    // Criterion-level: verifier required (PRD §7.4 三段式)
    for (const c of outcome.criteria) {
      if (!c.verifier) {
        warnings.push({
          level: 'error',
          scope: 'criterion',
          ref: c.description,
          message: `Criterion has no verifier (PR §7.4): "${c.description}". Must bind a verifier.`,
        });
      }
    }

    // Task-level
    if (outcome.tasks.length === 0) {
      warnings.push({
        level: 'error',
        scope: 'outcome',
        ref: outcome.title,
        message: 'Outcome must have at least 1 task.',
      });
    }

    for (const task of outcome.tasks) {
      if (task.estimated_minutes == null) {
        warnings.push({
          level: 'warning',
          scope: 'task',
          ref: task.title,
          message: 'Task has no estimated_minutes. Planner cannot enforce >30min split rule.',
        });
      } else if (task.estimated_minutes > MAX_TASK_MINUTES) {
        warnings.push({
          level: 'error',
          scope: 'task',
          ref: task.title,
          message: `Task estimated ${task.estimated_minutes}min > ${MAX_TASK_MINUTES}min. Must split.`,
        });
      } else if (task.estimated_minutes < MIN_TASK_MINUTES) {
        warnings.push({
          level: 'warning',
          scope: 'task',
          ref: task.title,
          message: `Task estimated ${task.estimated_minutes}min < ${MIN_TASK_MINUTES}min. Too small, consider merging.`,
        });
      }
    }
  }

  return {
    ok: warnings.every((w) => w.level !== 'error'),
    warnings,
  };
}
