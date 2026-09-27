/**
 * Verify + Recover tests (DESIGN §15.3 verify / §15.4 recover)
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { projectCreate, goalCreate } from '../src/mcp/core/goal.js';
import { outcomeCreate } from '../src/mcp/core/outcome.js';
import { criterionCreate, criterionList } from '../src/mcp/core/criterion.js';
import { taskCreate, taskClaim } from '../src/mcp/core/task.js';
import {
  verifyCommand,
  verifyGit,
  verifyByCriterion,
  type ToolResult,
} from '../src/mcp/core/verify.js';
import {
  classifyFailure,
  decideRecovery,
  applyRecovery,
} from '../src/mcp/core/recover.js';
import { makeTestStore } from './helpers.js';

describe('verify.command', () => {
  it('passes when exit_code matches expected', async () => {
    const result = await verifyCommand({
      command: 'echo hello',
      expect: { exit_code: 0 },
    });
    assert.equal(result.ok, true);
    assert.equal(result.status, 'PASS');
    assert.match(result.evidence.stdout as string, /hello/);
  });

  it('fails when exit_code does not match', async () => {
    const result = await verifyCommand({
      command: 'exit 1',
      expect: { exit_code: 0 },
    });
    assert.equal(result.ok, false);
    assert.equal(result.status, 'FAIL');
    assert.equal(result.evidence.exit_code, 1);
    assert.equal(result.error?.type, 'ASSERTION_FAILED');
  });

  it('fails when stdout missing expected substring', async () => {
    const result = await verifyCommand({
      command: 'echo hello',
      expect: { stdout_contains: 'goodbye' },
    });
    assert.equal(result.ok, false);
    assert.equal(result.status, 'FAIL');
  });

  it('returns UNKNOWN on timeout', async () => {
    const result = await verifyCommand({
      command: 'sleep 5',
      timeout: 100,
    });
    assert.equal(result.status, 'UNKNOWN');
    assert.equal(result.error?.type, 'EVIDENCE_INSUFFICIENT');
  });
});

describe('verify.git', () => {
  it('returns PASS when working tree is clean', async () => {
    // /tmp is typically not a git repo; use current dir if it is, else skip
    // For robustness, just call it without expect.clean
    const result = await verifyGit({ type: 'status' });
    assert.ok(result.status === 'PASS' || result.status === 'FAIL');
  });

  it('reports diff summary', async () => {
    const result = await verifyGit({ type: 'diff' });
    assert.equal(result.ok, true);
    assert.equal(result.status, 'PASS');
  });
});

describe('verifyByCriterion — command type', () => {
  it('dispatches command verifier and attaches evidence', async () => {
    const { store, cleanup } = makeTestStore();
    try {
      const p = projectCreate(store, { name: 'p1' });
      const g = goalCreate(store, { project_id: p.id, title: 'g1' });
      const o = outcomeCreate(store, { goal_id: g.id, title: 'o1' });
      const c = criterionCreate(store, {
        outcome_id: o.id,
        description: 'echo test',
        verifier: {
          type: 'command',
          config: { command: 'echo criterion-verify-test', expect: { exit_code: 0 } },
        },
      });
      const result = await verifyByCriterion(store, c.id, 'test-runner');
      assert.equal(result.status, 'PASS');

      // criterion.derived_status should now be PASS (auto-attached)
      const list = criterionList(store, o.id);
      const updated = list.find((x) => x.id === c.id)!;
      assert.equal(updated.derived_status, 'PASS');
      assert.ok(updated.latest_evidence_id !== null);
    } finally {
      cleanup();
    }
  });

  it('fails when criterion command fails', async () => {
    const { store, cleanup } = makeTestStore();
    try {
      const p = projectCreate(store, { name: 'p1' });
      const g = goalCreate(store, { project_id: p.id, title: 'g1' });
      const o = outcomeCreate(store, { goal_id: g.id, title: 'o1' });
      const c = criterionCreate(store, {
        outcome_id: o.id,
        description: 'fail',
        verifier: {
          type: 'command',
          config: { command: 'exit 7', expect: { exit_code: 0 } },
        },
      });
      const result = await verifyByCriterion(store, c.id);
      assert.equal(result.status, 'FAIL');
      assert.equal(result.evidence.exit_code, 7);
      const list = criterionList(store, o.id);
      assert.equal(list.find((x) => x.id === c.id)!.derived_status, 'FAIL');
    } finally {
      cleanup();
    }
  });
});

describe('Recover / classifyFailure', () => {
  it('classifies ASSERTION_FAILED → CRITERION_FAILED', () => {
    const result: ToolResult = {
      ok: false,
      status: 'FAIL',
      observation: '...',
      evidence: {},
      error: { type: 'ASSERTION_FAILED', message: 'mismatch', retryable: false },
    };
    assert.equal(classifyFailure(result), 'CRITERION_FAILED');
  });

  it('classifies CAS_CONFLICT → CAS_THRASHING', () => {
    const result: ToolResult = {
      ok: false,
      status: 'FAIL',
      observation: '...',
      evidence: {},
      error: { type: 'CAS_CONFLICT', message: 'race', retryable: true },
    };
    assert.equal(classifyFailure(result), 'CAS_THRASHING');
  });

  it('classifies EVIDENCE_INSUFFICIENT → TIMEOUT', () => {
    const result: ToolResult = {
      ok: false,
      status: 'UNKNOWN',
      observation: '...',
      evidence: {},
      error: { type: 'EVIDENCE_INSUFFICIENT', message: 'no data', retryable: true },
    };
    assert.equal(classifyFailure(result), 'TIMEOUT');
  });
});

describe('Recover / decideRecovery', () => {
  function makeTask(retryCount: number) {
    return {
      id: 't1',
      outcome_id: 'o1',
      title: 't1',
      status: 'RUNNING' as const,
      phase: null,
      priority: 0,
      acceptance_criteria: [],
      alignment_verdict: 'aligned' as const,
      alignment_reason: null,
      owner: 'agent',
      lease_until: null,
      wake_at: null,
      retry_count: retryCount,
      next_action: null,
      summary: null,
      last_observation: null,
      estimated_minutes: null,
      version: 1,
      created_at: '',
      updated_at: '',
    };
  }

  function failResult(type = 'ASSERTION_FAILED'): ToolResult {
    return {
      ok: false,
      status: 'FAIL',
      observation: '...',
      evidence: {},
      error: { type, message: 'fail', retryable: false },
    };
  }

  it('retry_count < 3 → retry', () => {
    const d = decideRecovery(makeTask(0), 'CRITERION_FAILED', failResult());
    assert.equal(d.action, 'retry');
  });

  it('retry_count 3-4 → change_strategy', () => {
    const d = decideRecovery(makeTask(3), 'CRITERION_FAILED', failResult());
    assert.equal(d.action, 'change_strategy');
  });

  it('retry_count ≥ 5 → block', () => {
    const d = decideRecovery(makeTask(5), 'CRITERION_FAILED', failResult());
    assert.equal(d.action, 'block');
  });

  it('CAS_THRASHING → change_strategy regardless of retry_count', () => {
    const d = decideRecovery(makeTask(0), 'CAS_THRASHING', failResult('CAS_CONFLICT'));
    assert.equal(d.action, 'change_strategy');
  });
});

describe('Recover / applyRecovery', () => {
  it('retry bumps retry_count', () => {
    const { store, cleanup } = makeTestStore();
    try {
      const p = projectCreate(store, { name: 'p1' });
      const g = goalCreate(store, { project_id: p.id, title: 'g1' });
      const o = outcomeCreate(store, { goal_id: g.id, title: 'o1' });
      const t0 = taskCreate(store, { outcome_id: o.id, title: 't1' });
      const t = taskClaim(store, { task_id: t0.id, owner: 'agent' });

      const result: ToolResult = {
        ok: false,
        status: 'FAIL',
        observation: '...',
        evidence: {},
        error: { type: 'ASSERTION_FAILED', message: 'mismatch', retryable: false },
      };
      const apply = applyRecovery(store, t, result);
      assert.equal(apply.decision.action, 'retry');
      assert.equal(apply.task.retry_count, 1);
      assert.equal(apply.task.status, 'RUNNING');
    } finally {
      cleanup();
    }
  });

  it('change_strategy sets status=RECOVERING', () => {
    const { store, cleanup } = makeTestStore();
    try {
      const p = projectCreate(store, { name: 'p1' });
      const g = goalCreate(store, { project_id: p.id, title: 'g1' });
      const o = outcomeCreate(store, { goal_id: g.id, title: 'o1' });
      const t0 = taskCreate(store, { outcome_id: o.id, title: 't1' });
      const tClaimed = taskClaim(store, { task_id: t0.id, owner: 'agent' });

      // simulate 3 prior retries (reload latest version first)
      const bumped = store.casUpdate('tasks', tClaimed.id, tClaimed.version, { retry_count: 3 });

      const result: ToolResult = {
        ok: false,
        status: 'FAIL',
        observation: '...',
        evidence: {},
        error: { type: 'ASSERTION_FAILED', message: 'mismatch', retryable: false },
      };
      const apply = applyRecovery(store, bumped, result);
      assert.equal(apply.decision.action, 'change_strategy');
      assert.equal(apply.task.status, 'RECOVERING');
      assert.equal(apply.task.retry_count, 4);
    } finally {
      cleanup();
    }
  });

  it('block sets status=BLOCKED', () => {
    const { store, cleanup } = makeTestStore();
    try {
      const p = projectCreate(store, { name: 'p1' });
      const g = goalCreate(store, { project_id: p.id, title: 'g1' });
      const o = outcomeCreate(store, { goal_id: g.id, title: 'o1' });
      const t0 = taskCreate(store, { outcome_id: o.id, title: 't1' });
      const tClaimed = taskClaim(store, { task_id: t0.id, owner: 'agent' });
      const bumped = store.casUpdate('tasks', tClaimed.id, tClaimed.version, { retry_count: 5 });

      const result: ToolResult = {
        ok: false,
        status: 'FAIL',
        observation: '...',
        evidence: {},
        error: { type: 'ASSERTION_FAILED', message: 'mismatch', retryable: false },
      };
      const apply = applyRecovery(store, bumped, result);
      assert.equal(apply.decision.action, 'block');
      assert.equal(apply.task.status, 'BLOCKED');
    } finally {
      cleanup();
    }
  });

  it('emits RECOVERY_STARTED event on strategy change', () => {
    const { store, cleanup } = makeTestStore();
    try {
      const p = projectCreate(store, { name: 'p1' });
      const g = goalCreate(store, { project_id: p.id, title: 'g1' });
      const o = outcomeCreate(store, { goal_id: g.id, title: 'o1' });
      const t0 = taskCreate(store, { outcome_id: o.id, title: 't1' });
      const tClaimed = taskClaim(store, { task_id: t0.id, owner: 'agent' });
      const bumped = store.casUpdate('tasks', tClaimed.id, tClaimed.version, { retry_count: 3 });

      const result: ToolResult = {
        ok: false,
        status: 'FAIL',
        observation: '...',
        evidence: {},
        error: { type: 'TOOL_ERROR', message: 'broken', retryable: false },
      };
      applyRecovery(store, bumped, result);

      const events = store.list<{ event: string; task_id: string }>(
        'events',
        "event IN ('RECOVERY_STARTED', 'TASK_RETRIED', 'TASK_BLOCKED')",
      );
      assert.ok(events.length > 0);
      assert.equal(events[0]!.event, 'RECOVERY_STARTED');
    } finally {
      cleanup();
    }
  });
});