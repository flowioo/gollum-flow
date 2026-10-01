/**
 * Goal Alignment tests (DESIGN §9.6 / PRD §9)
 *
 * Covers:
 * - llmSemanticCheck: keyword-based scope creep detection
 * - evidenceBasedCheck: remaining_gap analysis
 * - goalAlign: combined verdict (objective + llm)
 * - handleMisaligned: pause + rollback, no Human escalation
 * - handleUncertain: emit a replan signal, task keeps running
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { projectCreate, goalCreate } from '../src/core/goal.js';
import { outcomeCreate, outcomeMarkVerified } from '../src/core/outcome.js';
import { criterionCreate } from '../src/core/criterion.js';
import { evidenceCreate } from '../src/core/evidence.js';
import { taskCreate, taskClaim } from '../src/core/task.js';
import {
  goalAlign,
  handleMisaligned,
  handleUncertain,
  llmSemanticCheck,
  evidenceBasedCheck,
} from '../src/core/goal-align.js';
import { makeTestStore } from './helpers.js';

describe('Goal Alignment / llmSemanticCheck', () => {
  function mkTask(title: string, criteria: string[] = []) {
    return {
      id: 't1',
      outcome_id: 'o1',
      title,
      status: 'RUNNING' as const,
      phase: null,
      priority: 0,
      acceptance_criteria: criteria,
      alignment_verdict: 'uncertain' as const,
      alignment_reason: null,
      owner: null,
      lease_until: null,
      wake_at: null,
      retry_count: 0,
      next_action: null,
      summary: null,
      last_observation: null,
      estimated_minutes: null,
      version: 1,
      created_at: '',
      updated_at: '',
    };
  }
  function mkOutcome(title: string) {
    return {
      id: 'o1',
      goal_id: 'g1',
      title,
      status: 'IN_PROGRESS' as const,
      criteria_ids: [],
      priority: 0,
      version: 1,
      created_at: '',
      updated_at: '',
    };
  }

  it('detects scope creep keyword → misaligned', () => {
    const result = llmSemanticCheck(mkTask('重构 EventBus'), mkOutcome('all tests pass'));
    assert.equal(result.verdict, 'misaligned');
    assert.match(result.reason, /重构/);
  });

  it('detects English scope creep keywords → misaligned', () => {
    const result = llmSemanticCheck(mkTask('Refactor runtime'), mkOutcome('tests pass'));
    assert.equal(result.verdict, 'misaligned');
  });

  it('aligned when task words overlap with outcome', () => {
    const result = llmSemanticCheck(mkTask('fix failing tests'), mkOutcome('all tests pass'));
    assert.equal(result.verdict, 'aligned');
  });

  it('misaligned when no word overlap', () => {
    const result = llmSemanticCheck(mkTask('write documentation'), mkOutcome('fix calculator'));
    assert.equal(result.verdict, 'misaligned');
  });

  it('uncertain when goal keywords missing', () => {
    const result = llmSemanticCheck(
      mkTask('fix bug'),
      mkOutcome('fix calculator'),
      'maintain high availability and uptime',
    );
    assert.equal(result.verdict, 'uncertain');
  });
});

describe('Goal Alignment / evidenceBasedCheck', () => {
  it('returns aligned when Outcome VERIFIED', () => {
    const { store, cleanup } = makeTestStore();
    try {
      const p = projectCreate(store, { name: 'p1' });
      const g = goalCreate(store, { project_id: p.id, title: 'g1' });
      const o = outcomeCreate(store, { goal_id: g.id, title: 'o1' });
      const c = criterionCreate(store, {
        outcome_id: o.id,
        description: 'c1',
        verifier: { type: 'command', config: { command: 'true' } },
      });
      evidenceCreate(store, { criterion_id: c.id, status: 'PASS' });
      outcomeMarkVerified(store, o.id);

      const outcome = store.get('outcomes', o.id) as any;
      const result = evidenceBasedCheck(store, {} as any, outcome);
      assert.equal(result.verdict, 'aligned');
      assert.equal(result.remainingGap, 0);
    } finally {
      cleanup();
    }
  });

  it('returns aligned when remaining_gap > 0 (task still relevant)', () => {
    const { store, cleanup } = makeTestStore();
    try {
      const p = projectCreate(store, { name: 'p1' });
      const g = goalCreate(store, { project_id: p.id, title: 'g1' });
      const o = outcomeCreate(store, { goal_id: g.id, title: 'o1' });
      criterionCreate(store, {
        outcome_id: o.id,
        description: 'c1',
        verifier: { type: 'command', config: { command: 'true' } },
      });
      const outcome = store.get('outcomes', o.id) as any;
      const result = evidenceBasedCheck(store, {} as any, outcome);
      assert.equal(result.verdict, 'aligned');
      assert.equal(result.remainingGap, 1);
    } finally {
      cleanup();
    }
  });
});

describe('Goal Alignment / goalAlign', () => {
  it('returns aligned for an on-task, on-outcome, on-goal Task', () => {
    const { store, cleanup } = makeTestStore();
    try {
      const p = projectCreate(store, { name: 'p1' });
      const g = goalCreate(store, {
        project_id: p.id,
        title: 'g1',
        description: 'fix calculator and parser',
      });
      const o = outcomeCreate(store, { goal_id: g.id, title: 'all tests pass' });
      const t = taskCreate(store, {
        outcome_id: o.id,
        title: 'fix failing calculator test',
      });
      const result = goalAlign(store, { task_id: t.id });
      assert.equal(result.verdict, 'aligned');
    } finally {
      cleanup();
    }
  });

  it('returns misaligned for scope-creep Task', () => {
    const { store, cleanup } = makeTestStore();
    try {
      const p = projectCreate(store, { name: 'p1' });
      const g = goalCreate(store, { project_id: p.id, title: 'g1' });
      const o = outcomeCreate(store, { goal_id: g.id, title: 'all tests pass' });
      const t = taskCreate(store, {
        outcome_id: o.id,
        title: '重构整个 EventBus',
      });
      const result = goalAlign(store, { task_id: t.id });
      assert.equal(result.verdict, 'misaligned');
    } finally {
      cleanup();
    }
  });

  it('emits GOAL_ALIGNMENT_CHECKED event', () => {
    const { store, cleanup } = makeTestStore();
    try {
      const p = projectCreate(store, { name: 'p1' });
      const g = goalCreate(store, { project_id: p.id, title: 'g1' });
      const o = outcomeCreate(store, { goal_id: g.id, title: 'all tests pass' });
      const t = taskCreate(store, { outcome_id: o.id, title: 'fix failing tests' });

      goalAlign(store, { task_id: t.id });
      const events = store.list<{ event: string }>(
        'events',
        "event = 'GOAL_ALIGNMENT_CHECKED'",
      );
      assert.ok(events.length >= 1);
    } finally {
      cleanup();
    }
  });
});

describe('Goal Alignment / handleMisaligned (PRD §15)', () => {
  it('pauses task, does NOT escalate to Human', () => {
    const { store, cleanup } = makeTestStore();
    try {
      const p = projectCreate(store, { name: 'p1' });
      const g = goalCreate(store, { project_id: p.id, title: 'g1' });
      const o = outcomeCreate(store, { goal_id: g.id, title: 'o1' });
      const t0 = taskCreate(store, { outcome_id: o.id, title: '重构 EventBus' });
      const t = taskClaim(store, { task_id: t0.id, owner: 'agent' });

      const result = handleMisaligned(store, t, 'scope creep');
      assert.equal(result.action, 'paused');
      assert.equal(result.task.status, 'PENDING');
      assert.equal(result.task.owner, null);
      assert.match(result.task.summary!, /misaligned/);

      // TASK_REJECTED_MISALIGNED event emitted (NOT TASK_BLOCKED)
      const events = store.list<{ event: string }>('events', "event LIKE '%MISALIGNED%'");
      assert.ok(events.length >= 1);
      const blocked = store.list<{ event: string }>('events', "event = 'TASK_BLOCKED'");
      assert.equal(blocked.length, 0); // NOT blocked → no Human escalation
    } finally {
      cleanup();
    }
  });
});

describe('Goal Alignment / handleUncertain (uncertain → replan)', () => {
  it('emits a replan signal and leaves the task runnable', () => {
    const { store, cleanup } = makeTestStore();
    try {
      const p = projectCreate(store, { name: 'p1' });
      const g = goalCreate(store, { project_id: p.id, title: 'g1' });
      const o = outcomeCreate(store, { goal_id: g.id, title: 'o1' });
      const t0 = taskCreate(store, { outcome_id: o.id, title: '调研缓存方案' });
      const t = taskClaim(store, { task_id: t0.id, owner: 'agent' });

      const result = handleUncertain(store, t);

      // uncertain is NOT misaligned: the task keeps running so the agent can
      // replan instead of being paused into the backlog.
      assert.equal(result.task.status, 'RUNNING');
      assert.match(result.reason, /uncertain/);
      assert.match(result.reason, /replan/);

      const events = store.list<{ event: string; payload: string | null }>(
        'events',
        "event = 'TASK_REJECTED_MISALIGNED'",
      );
      assert.ok(events.length >= 1);
      // the payload column is stored as raw JSON text, not a parsed object
      const payload = JSON.parse(events[events.length - 1].payload!) as { reason: string };
      assert.equal(payload.reason, 'uncertain, replan');
    } finally {
      cleanup();
    }
  });
});