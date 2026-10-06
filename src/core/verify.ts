/**
 * Verify Tools (DESIGN §8.6)
 *
 * 统一 verify.* 接口，按 Criterion.verifier.type 调用对应实现：
 *   - command           : 跑 shell 命令，expect exit code
 *   - git               : 检查 git status / diff / log
 *   - outcome_criterion : 引用其他 outcome/criterion（V0.5 完善）
 *   - timer_check       : 等待 N 秒不崩
 *   - human_assert      : Human 主观确认（V0.5 完善）
 *
 * V0.1 全部实现。统一返回 ToolResult 协议（DESIGN §20）：
 *   {
 *     ok, status: PASS|FAIL|UNKNOWN,
 *     data, observation, evidence, error
 *   }
 */

import { captureEvidenceScope } from './evidence-scope.js';
import { resolve } from 'node:path';
import { exec, execSync } from 'node:child_process';
import { type Store } from '../workflow/store/store.js';
import { criterionAttachEvidence, criterionGet } from './criterion.js';
import { ulid } from 'ulid';

// =============================================================================
// ToolResult protocol (DESIGN §20)
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

function pass<T>(
  observation: string,
  evidence: Record<string, unknown> = {},
  data?: T,
): ToolResult<T> {
  return {
    ok: true,
    status: 'PASS',
    data,
    observation,
    evidence,
    error: null,
  };
}

function fail(
  observation: string,
  errorType: string,
  message: string,
  evidence: Record<string, unknown> = {},
  retryable: boolean = false,
): ToolResult {
  return {
    ok: false,
    status: 'FAIL',
    observation,
    evidence,
    error: { type: errorType, message, retryable },
  };
}

function unknown(
  observation: string,
  evidence: Record<string, unknown> = {},
  message: string = 'evidence insufficient',
): ToolResult {
  return {
    ok: false,
    status: 'UNKNOWN',
    observation,
    evidence,
    error: { type: 'EVIDENCE_INSUFFICIENT', message, retryable: true },
  };
}

// =============================================================================
// verify.command
// =============================================================================

export interface CommandVerifyConfig {
  command: string;
  cwd?: string;
  timeout?: number; // ms, default 30000
  expect?: { exit_code?: number; stdout_contains?: string; stderr_contains?: string };
}

/**
 * Run a shell command, capture stdout/stderr/exit_code, compare against expect.
 */
export async function verifyCommand(config: CommandVerifyConfig): Promise<ToolResult> {
  const timeout = config.timeout ?? 30000;
  if (!config.command || !Number.isFinite(timeout) || timeout <= 0) {
    return fail('invalid command configuration', 'INVALID_CONFIG', 'command and positive timeout required');
  }
  const cwd = resolve(config.cwd ?? process.cwd());
  const execution = await new Promise<{ error: any; stdout: string; stderr: string }>((done) => {
    exec(config.command, { cwd, timeout, maxBuffer: 1024 * 1024, encoding: 'utf8' },
      (error, stdout, stderr) => done({ error, stdout, stderr }));
  });
  const { error, stdout, stderr } = execution;
  const exitCode = error ? (typeof error.code === 'number' ? error.code : -1) : 0;
  const evidence = { command: config.command, cwd, exit_code: exitCode,
    stdout: stdout.slice(0, 4000), stderr: stderr.slice(0, 4000) };
  if (error?.killed || error?.code === 'ETIMEDOUT') {
    return unknown(`command timed out after ${timeout}ms`, evidence, 'timeout');
  }
  if (error && typeof error.code !== 'number') {
    return unknown('command could not be fully observed', evidence, error.message);
  }
  const expected = config.expect ?? {};
  if (exitCode !== (expected.exit_code ?? 0) ||
      (expected.stdout_contains !== undefined && !stdout.includes(expected.stdout_contains)) ||
      (expected.stderr_contains !== undefined && !stderr.includes(expected.stderr_contains))) {
    return fail(`command expectations failed (exit ${exitCode})`, 'ASSERTION_FAILED', 'command output or exit code mismatch', evidence);
  }
  return pass(`command succeeded (exit ${exitCode})`, evidence);
}

// =============================================================================
// verify.git
// =============================================================================

export interface GitVerifyConfig {
  type: 'status' | 'diff' | 'log';
  repo?: string; // cwd for git command, default process.cwd()
  expect?: { clean?: boolean; max_changes?: number; min_commits?: number };
}

/**
 * Verify a git repository state.
 */
export async function verifyGit(config: GitVerifyConfig): Promise<ToolResult> {
  const cwd = config.repo ?? process.cwd();
  const expect = config.expect ?? {};

  try {
    if (config.type === 'status') {
      const out = execSync('git status --porcelain', { cwd, encoding: 'utf-8' });
      const lines = out.trim().split('\n').filter((l) => l.length > 0);
      const evidence = {
        type: 'status',
        changes: lines.length,
        files: lines.slice(0, 20),
      };
      if (expect.clean && lines.length > 0) {
        return fail(`git status: ${lines.length} uncommitted changes`, 'ASSERTION_FAILED', 'git not clean', evidence);
      }
      if (expect.max_changes !== undefined && lines.length > expect.max_changes) {
        return fail(`git status: ${lines.length} changes > max ${expect.max_changes}`, 'ASSERTION_FAILED', 'too many changes', evidence);
      }
      return pass(`git status: ${lines.length} changes`, evidence);
    }

    if (config.type === 'diff') {
      const out = execSync('git diff --shortstat', { cwd, encoding: 'utf-8' });
      const evidence = { type: 'diff', summary: out.trim() };
      return pass(`git diff: ${out.trim() || 'no changes'}`, evidence);
    }

    if (config.type === 'log') {
      const out = execSync('git log --oneline -1', { cwd, encoding: 'utf-8' });
      const evidence = { type: 'log', last_commit: out.trim() };
      if (expect.min_commits !== undefined) {
        const count = parseInt(execSync('git rev-list --count HEAD', { cwd, encoding: 'utf-8' }), 10);
        if (count < expect.min_commits) {
          return fail(`git log: only ${count} commits, need ≥${expect.min_commits}`, 'ASSERTION_FAILED', 'too few commits', { ...evidence, total: count });
        }
      }
      return pass(`git log: ${out.trim()}`, evidence);
    }

    return fail(`unknown git verify type: ${config.type}`, 'INVALID_CONFIG', 'bad type');
  } catch (e: any) {
    return fail(`git ${config.type} failed: ${e.message}`, 'TOOL_ERROR', e.message, {}, false);
  }
}

// =============================================================================
// verify.outcome_criterion (V0.1 stub)
// =============================================================================

export interface OutcomeCriterionVerifyConfig {
  ref_type: 'outcome' | 'criterion';
  ref_id: string;
}

/**
 * V0.1 stub: just checks if the referenced outcome/criterion exists and is VERIFIED/PASS.
 * Full implementation requires cross-outcome evaluation (V0.5).
 */
export async function verifyOutcomeCriterion(
  store: Store,
  config: OutcomeCriterionVerifyConfig,
): Promise<ToolResult> {
  try {
    if (config.ref_type === 'outcome') {
      const outcome = store.tryGet<{ status: string }>('outcomes', config.ref_id);
      if (!outcome) return fail(`outcome ${config.ref_id} not found`, 'NOT_FOUND', 'no such outcome');
      if (outcome.status === 'VERIFIED') return pass(`outcome ${config.ref_id} VERIFIED`, { status: outcome.status });
      return fail(`outcome ${config.ref_id} status=${outcome.status}`, 'ASSERTION_FAILED', 'not VERIFIED', { status: outcome.status });
    }
    if (config.ref_type === 'criterion') {
      const criterion = store.tryGet<{ derived_status: string }>('criteria', config.ref_id);
      if (!criterion) return fail(`criterion ${config.ref_id} not found`, 'NOT_FOUND', 'no such criterion');
      if (criterion.derived_status === 'PASS') return pass(`criterion ${config.ref_id} PASS`, { status: criterion.derived_status });
      return fail(`criterion ${config.ref_id} status=${criterion.derived_status}`, 'ASSERTION_FAILED', 'not PASS', { status: criterion.derived_status });
    }
    return fail(`unknown ref_type: ${config.ref_type}`, 'INVALID_CONFIG', 'bad ref_type');
  } catch (e: any) {
    return fail(`outcome_criterion verify failed: ${e.message}`, 'TOOL_ERROR', e.message);
  }
}

// =============================================================================
// verify.timer_check (V0.1 stub)
// =============================================================================

export interface TimerCheckConfig {
  duration: string; // e.g. "4h", "30min"
  signal_source: 'event_log' | 'process';
}

/**
 * V0.1 stub: just returns the requested wait. Full implementation requires
 * background process monitoring (V0.5).
 */
export async function verifyTimerCheck(
  store: Store,
  config: TimerCheckConfig,
): Promise<ToolResult> {
  const evidence = {
    duration: config.duration,
    signal_source: config.signal_source,
    note: 'V0.1 stub: timer_check requires V0.5 background monitoring',
  };
  return unknown(
    `timer_check ${config.duration} (V0.1 stub)`,
    evidence,
    'V0.5 required',
  );
}

// =============================================================================
// verify.human_assert (V0.1 stub)
// =============================================================================

export interface HumanAssertConfig {
  question: string;
}

/**
 * V0.1 stub: returns UNKNOWN requiring Human confirmation via BLOCKED Task.
 */
export async function verifyHumanAssert(config: HumanAssertConfig): Promise<ToolResult> {
  return unknown(
    `human_assert: ${config.question}`,
    { question: config.question, note: 'V0.1 stub: BLOCKED Task required' },
    'Human confirmation needed (BLOCKED)',
  );
}

// =============================================================================
// verifyByCriterion (entry point used by Skill verify)
// =============================================================================

/**
 * Dispatch to the appropriate verifier based on Criterion.verifier.type.
 * Returns ToolResult, then attaches evidence to criterion.
 *
 * V0.1 fully implements this:
 *   command → verifyCommand (real exec)
 *   git → verifyGit (real exec)
 *   outcome_criterion → verifyOutcomeCriterion (real store check)
 *   timer_check → verifyTimerCheck (stub, returns UNKNOWN)
 *   human_assert → verifyHumanAssert (stub, returns UNKNOWN)
 */
export async function verifyByCriterion(
  store: Store,
  criterion_id: string,
  executor: string = 'system',
): Promise<ToolResult> {
  const { criterion } = criterionGet(store, criterion_id);
  if (!criterion.verifier) {
    return fail(
      `criterion ${criterion_id} has no verifier`,
      'UNVERIFIED',
      'criterion missing verifier (UNVERIFIED)',
      { criterion_id },
    );
  }

  const verifier = criterion.verifier;
  const scopeCwd = String(verifier.config.cwd ?? verifier.config.repo ?? process.cwd());
  const before = captureEvidenceScope(scopeCwd);
  let result: ToolResult;

  switch (verifier.type) {
    case 'command':
      result = await verifyCommand(verifier.config as unknown as CommandVerifyConfig);
      break;
    case 'git':
      result = await verifyGit(verifier.config as unknown as GitVerifyConfig);
      break;
    case 'outcome_criterion':
      result = await verifyOutcomeCriterion(store, verifier.config as unknown as OutcomeCriterionVerifyConfig);
      break;
    case 'timer_check':
      result = await verifyTimerCheck(store, verifier.config as unknown as TimerCheckConfig);
      break;
    case 'human_assert':
      result = await verifyHumanAssert(verifier.config as unknown as HumanAssertConfig);
      break;
    default:
      return fail(`unknown verifier type`, 'INVALID_CONFIG', 'unknown verifier type', { verifier_type: (verifier as any).type });
  }

  const after = captureEvidenceScope(scopeCwd);
  if (verifier.config.require_scope === true && (!before || !after)) {
    result = unknown('required Git workspace scope is unavailable', result.evidence);
  }
  if (before && (!after || before.digest !== after.digest)) {
    result = unknown('workspace changed during verification; rerun verification', result.evidence);
  }
  result.evidence = { ...result.evidence, scope: after, verifier_spec: JSON.stringify(verifier),
    provenance: 'runtime-verifier' };
  // Attach evidence to criterion (auto-update derived_status)
  criterionAttachEvidence(store, {
    criterion_id,
    evidence: {
      id: ulid(),
      criterion_id,
      executor,
      status: result.status,
      data: result.evidence,
      observed_at: new Date().toISOString(),
    },
  });

  return result;
}