/**
 * Recover (DESIGN §15.4 / PRD §15.4)
 *
 * 流程：
 *   Failure → Observe → Classify → Identify Divergence → Change Strategy → Retry → Verify
 *
 * 强制规则：
 *   - 禁止完全相同动作无限重试 (PRD §5.4)
 *   - retry_count < 3  → 自动 retry (同 Task)
 *   - retry_count ≥ 3  → 换 Strategy (release 回 PENDING, 触发下一轮)
 *   - retry_count ≥ 5  → BLOCKED (升级到 Outcome 层决策, PRD §5.4)
 *
 * Strategy 切换示例：
 *   - VERIFY_FAILED      → 换不同 command / 加环境变量
 *   - TOOL_ERROR         → 降级到更简单的 verify
 *   - CAS_THRASHING      → 等待 scheduler 重新调度
 *   - ASSERTION_FAILED   → 提示 Task 重新执行代码修改
 */

import { type Store } from '../../workflow/store/store.js';
import {
  type Task,
  type ToolResult,
  type VerifyStatus,
  type Criterion,
  type VerifierSpec,
} from '../../workflow/model/types.js';

// =============================================================================
// Types
// =============================================================================

export type FailureType =
  | 'VERIFY_FAILED'
  | 'TOOL_ERROR'
  | 'CAS_THRASHING'
  | 'CRITERION_FAILED'
  | 'ENVIRONMENT_CHANGED'
  | 'TIMEOUT';

export interface RecoveryDecision {
  action: 'retry' | 'change_strategy' | 'block';
  reason: string;
  strategy_hint?: StrategyHint;
  blocked_reason?: string;
}

export type StrategyHint =
  | 'expand_criteria'        // 拆更细 criterion
  | 'change_command'         // 换 verify command
  | 'rebuild_environment'    // 重置环境
  | 'wait_and_retry'         // 等一段时间再试
  | 'switch_agent';          // 换 Host

// =============================================================================
// Classifier (DESIGN §15.4 step 2)
// =============================================================================

/**
 * Classify a verify/tool failure into a FailureType.
 */
export function classifyFailure(result: ToolResult, failureContext?: Record<string, unknown>): FailureType {
  if (!result.error) return 'VERIFY_FAILED';
  const type = result.error.type;
  if (type === 'TIMEOUT' || type === 'EVIDENCE_INSUFFICIENT') return 'TIMEOUT';
  if (type === 'CAS_CONFLICT') return 'CAS_THRASHING';
  if (type === 'ENVIRONMENT_CHANGED') return 'ENVIRONMENT_CHANGED';
  if (type === 'PERMISSION_DENIED' || type === 'INTERNAL_ERROR') return 'TOOL_ERROR';
  if (type === 'ASSERTION_FAILED') return 'CRITERION_FAILED';
  return 'VERIFY_FAILED';
}

// =============================================================================
// Recovery decision (DESIGN §15.4 step 4-6)
// =============================================================================

/**
 * Make a recovery decision based on retry_count + failure type.
 *
 * Rules:
 *   retry_count < 3  → retry (with same Strategy)
 *   retry_count 3-4  → change_strategy (Strategy 切换)
 *   retry_count ≥ 5  → block (升级到 Outcome 层)
 */
export function decideRecovery(
  task: Task,
  failureType: FailureType,
  result: ToolResult,
): RecoveryDecision {
  const retryCount = task.retry_count;

  // 1. Specific failure-type strategies
  if (failureType === 'CAS_THRASHING') {
    return {
      action: 'change_strategy',
      reason: 'CAS thrashing — wait and retry with different host',
      strategy_hint: 'wait_and_retry',
    };
  }
  if (failureType === 'ENVIRONMENT_CHANGED') {
    return {
      action: 'change_strategy',
      reason: 'Environment drift — re-observe before retry',
      strategy_hint: 'rebuild_environment',
    };
  }
  if (failureType === 'TIMEOUT') {
    return {
      action: retryCount < 2 ? 'retry' : 'change_strategy',
      reason: 'Verify timed out',
      strategy_hint: retryCount < 2 ? undefined : 'change_command',
    };
  }

  // 2. General retry_count policy
  if (retryCount < 3) {
    return {
      action: 'retry',
      reason: `first ${retryCount + 1} attempt(s), keep trying`,
    };
  }
  if (retryCount < 5) {
    return {
      action: 'change_strategy',
      reason: `${retryCount} retries exhausted for this Strategy, switching`,
      strategy_hint: inferStrategyHint(task, result),
    };
  }
  return {
    action: 'block',
    reason: `${retryCount} retries exhausted, escalate to Outcome layer`,
    blocked_reason: `${retryCount} retries failed; consider Task decomposition or manual intervention`,
  };
}

function inferStrategyHint(task: Task, result: ToolResult): StrategyHint {
  if (result.error?.type === 'ASSERTION_FAILED') return 'expand_criteria';
  if (result.error?.type === 'TOOL_ERROR') return 'change_command';
  return 'wait_and_retry';
}

// =============================================================================
// Apply recovery decision
// =============================================================================

/**
 * Apply a recovery decision to a Task:
 *   - 'retry'         → bump retry_count, emit event, leave status RUNNING
 *   - 'change_strategy' → bump retry_count, set status RECOVERING, emit event
 *   - 'block'         → set status BLOCKED (PRD §15.4: 升级)
 */
export interface ApplyRecoveryResult {
  task: Task;
  decision: RecoveryDecision;
}

export function applyRecovery(
  store: Store,
  task: Task,
  result: ToolResult,
  actor: string = 'recover-skill',
): ApplyRecoveryResult {
  const failureType = classifyFailure(result);
  const decision = decideRecovery(task, failureType, result);

  if (decision.action === 'block') {
    const updated = store.casUpdate<Task>('tasks', task.id, task.version, {
      status: 'BLOCKED',
      owner: null,
      lease_until: null,
      summary: decision.reason,
    });
    store.emit({
      event: 'TASK_BLOCKED',
      task_id: task.id,
      outcome_id: task.outcome_id,
      actor,
      payload: {
        reason: decision.blocked_reason ?? decision.reason,
        failure_type: failureType,
        retry_count: task.retry_count,
        context: 'recover escalates to BLOCKED',
      },
    });
    return { task: updated, decision };
  }

  if (decision.action === 'change_strategy') {
    const updated = store.casUpdate<Task>('tasks', task.id, task.version, {
      status: 'RECOVERING',
      retry_count: task.retry_count + 1,
      summary: decision.reason,
    });
    store.emit({
      event: 'RECOVERY_STARTED',
      task_id: task.id,
      outcome_id: task.outcome_id,
      actor,
      payload: {
        failure_type: failureType,
        retry_count: task.retry_count + 1,
        strategy_hint: decision.strategy_hint,
        reason: decision.reason,
      },
    });
    return { task: updated, decision };
  }

  // 'retry' — keep RUNNING, bump retry_count
  const updated = store.casUpdate<Task>('tasks', task.id, task.version, {
    retry_count: task.retry_count + 1,
    summary: decision.reason,
  });
  store.emit({
    event: 'TASK_RETRIED',
    task_id: task.id,
    outcome_id: task.outcome_id,
    actor,
    payload: {
      failure_type: failureType,
      retry_count: task.retry_count + 1,
      reason: decision.reason,
    },
  });
  return { task: updated, decision };
}

// =============================================================================
// Failure classification helpers (used by Skill recover)
// =============================================================================

/**
 * Identify the divergence between expected and actual.
 * Returns a human-readable description.
 */
export function identifyDivergence(result: ToolResult): string {
  if (result.status === 'PASS') return 'no divergence';
  if (result.status === 'UNKNOWN') {
    return `evidence insufficient: ${result.error?.message ?? 'unknown'}`;
  }
  return `expected PASS, got ${result.status}; ${result.observation}`;
}