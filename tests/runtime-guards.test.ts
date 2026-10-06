import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeTestStore } from './helpers.js';
import { projectCreate, goalCreate } from '../src/core/goal.js';
import { outcomeCreate, outcomeMarkVerified, outcomeRemainingGap } from '../src/core/outcome.js';
import { criterionCreate, criterionAttachEvidence } from '../src/core/criterion.js';
import { taskCreate, taskClaim, taskComplete, taskCheckpoint, taskWait } from '../src/core/task.js';
import { applyRecovery } from '../src/core/recover.js';
import { verifyCommand, verifyByCriterion } from '../src/core/verify.js';
import { schedulerTick, pickNextTasks } from '../src/workflow/scheduler/scheduler.js';
import { taskHeartbeat } from '../src/agent/heartbeat.js';
import { AgentLoop } from '../src/agent/loop.js';
import { recordExhaustion, tickQuotaRecovery } from '../src/agent/quota.js';

function setup() {
  const fixture = makeTestStore();
  const p = projectCreate(fixture.store, { name: 'runtime' });
  const g = goalCreate(fixture.store, { project_id: p.id, title: 'runtime' });
  const o = outcomeCreate(fixture.store, { goal_id: g.id, title: 'result' });
  const task = taskCreate(fixture.store, { outcome_id: o.id, title: 'work', acceptance_criteria: ['verified'] });
  return { ...fixture, p, g, o, task };
}

test('empty criteria cannot achieve the outcome or goal', () => {
  const { store, cleanup, o, g } = setup();
  try {
    assert.throws(() => outcomeMarkVerified(store, o.id), /without criteria/);
    assert.equal(store.get<any>('goals', g.id).status, 'active');
  } finally { cleanup(); }
});

for (const type of ['TIMEOUT', 'CAS_CONFLICT', 'ENVIRONMENT_CHANGED']) {
  test(`${type} recovery exhausts its budget`, () => {
    const { store, cleanup, task } = setup();
    try {
      let current = taskClaim(store, { task_id: task.id, owner: 'a' });
      for (let i = 0; i < 6; i++) current = applyRecovery(store, current, {
        ok: false, status: 'FAIL', observation: type, evidence: {},
        error: { type, message: type, retryable: true },
      }).task;
      assert.equal(current.status, 'BLOCKED');
      assert.equal(current.retry_count, 5);
    } finally { cleanup(); }
  });
}

test('expired recovery is picked again; the old fenced executor cannot write', () => {
  const { store, cleanup, task } = setup();
  try {
    const a = taskClaim(store, { task_id: task.id, owner: 'a', fenced: true });
    store.casUpdate('tasks', a.id, a.version, { status: 'RECOVERING', lease_until: new Date(0).toISOString() });
    assert.equal(schedulerTick(store).picked[0]?.task.id, task.id);
    const b = taskClaim(store, { task_id: task.id, owner: 'b' });
    assert.ok(b.lease_token && b.lease_token !== a.lease_token);
    assert.throws(() => taskComplete(store, task.id, 'stale', a.lease_token!), /STALE_LEASE/);
    assert.throws(() => taskHeartbeat(store, task.id, { lease_token: a.lease_token! }), /STALE_LEASE/);
    assert.throws(() => taskCheckpoint(store, task.id, { summary: 'no token' }), /STALE_LEASE/);
    assert.equal(taskComplete(store, task.id, 'current', b.lease_token!).status, 'DONE');
  } finally { cleanup(); }
});

test('event failure rolls back state and nested transactions', () => {
  const { store, cleanup, task } = setup();
  try {
    store.raw().exec("CREATE TRIGGER reject_claim BEFORE INSERT ON events WHEN NEW.event = 'TASK_CLAIMED' BEGIN SELECT RAISE(ABORT, 'event failed'); END");
    assert.throws(() => taskClaim(store, { task_id: task.id, owner: 'a' }), /event failed/);
    assert.equal(store.get<any>('tasks', task.id).status, 'PENDING');
    store.raw().exec('DROP TRIGGER reject_claim');
    assert.throws(() => store.transaction(() => { taskClaim(store, { task_id: task.id, owner: 'a' }); throw new Error('outer'); }), /outer/);
    assert.equal(store.get<any>('tasks', task.id).status, 'PENDING');
  } finally { cleanup(); }
});

test('evidence cannot point to a different criterion', () => {
  const { store, cleanup, o } = setup();
  try {
    const c = criterionCreate(store, { outcome_id: o.id, description: 'test', verifier: { type: 'command', config: { command: 'true' } } });
    assert.throws(() => criterionAttachEvidence(store, { criterion_id: c.id, evidence: {
      id: 'wrong', criterion_id: 'other', executor: 'test', status: 'PASS', data: {}, observed_at: new Date().toISOString(),
    } }), /mismatch/);
    assert.equal(store.list('evidences').length, 0);
  } finally { cleanup(); }
});

test('command verifier checks stderr, expected failures, and lets heartbeat timers run', async () => {
  assert.equal((await verifyCommand({ command: 'echo expected >&2; exit 3', expect: { exit_code: 3, stderr_contains: 'expected' } })).status, 'PASS');
  assert.equal((await verifyCommand({ command: 'true', expect: { stderr_contains: 'missing' } })).status, 'FAIL');
  let fired = false;
  const timer = setTimeout(() => { fired = true; }, 20);
  await verifyCommand({ command: 'sleep 0.1' });
  clearTimeout(timer);
  assert.equal(fired, true);
});

test('workspace changes invalidate prior evidence even when HEAD did not change', async () => {
  const { store, cleanup, o } = setup();
  const dir = mkdtempSync(join(tmpdir(), 'gollum-scope-'));
  try {
    const git = (...args: string[]) => execFileSync('git', args, { cwd: dir, stdio: 'ignore' });
    git('init', '-q'); git('config', 'user.email', 'test@example.com'); git('config', 'user.name', 'test');
    writeFileSync(join(dir, 'code.txt'), 'one'); git('add', '.'); git('commit', '-qm', 'fixture');
    const c = criterionCreate(store, { outcome_id: o.id, description: 'test', verifier: { type: 'command', config: { command: 'true', cwd: dir } } });
    assert.equal((await verifyByCriterion(store, c.id)).status, 'PASS');
    assert.equal(outcomeRemainingGap(store, o.id).pass, 1);
    writeFileSync(join(dir, 'code.txt'), 'two');
    assert.equal(outcomeRemainingGap(store, o.id).unknown, 1);
    assert.throws(() => outcomeMarkVerified(store, o.id), /remaining gap/);
    assert.equal(store.list('evidences').length, 1, 'historical evidence remains');
    await verifyByCriterion(store, c.id);
    assert.equal(outcomeMarkVerified(store, o.id).status, 'VERIFIED');
    criterionCreate(store, { outcome_id: o.id, description: 'new requirement', verifier: { type: 'command', config: { command: 'true' } } });
    assert.equal(store.get<any>('outcomes', o.id).status, 'IN_PROGRESS');
  } finally { cleanup(); rmSync(dir, { recursive: true, force: true }); }
});

test('scheduler orders by outcome gap before applying its limit', () => {
  const { store, cleanup, o, g } = setup();
  try {
    const o2 = outcomeCreate(store, { goal_id: g.id, title: 'larger gap' });
    const t2 = taskCreate(store, { outcome_id: o2.id, title: 'second', acceptance_criteria: [], priority: -1 });
    for (const outcome of [o, o2, o2]) criterionCreate(store, { outcome_id: outcome.id, description: 'test', verifier: { type: 'command', config: { command: 'true' } } });
    assert.equal(pickNextTasks(store, { limit: 1 })[0]?.task.id, t2.id);
  } finally { cleanup(); }
});

test('monitor without a dispatcher does not claim it executed work', async () => {
  const { store, cleanup } = setup();
  try {
    const result = await new AgentLoop({ store, log: () => {} }).cycle();
    assert.equal(result.scheduler.picked, 1);
    assert.equal(result.dispatched, 0);
  } finally { cleanup(); }
});

test('quota resumes only its own tasks and increments versions', () => {
  const { store, cleanup, o, task } = setup();
  try {
    const timed = taskCreate(store, { outcome_id: o.id, title: 'timer', acceptance_criteria: [] });
    taskClaim(store, { task_id: timed.id, owner: 'timer' });
    taskWait(store, { task_id: timed.id, wake_at: new Date(0).toISOString() });
    const running = taskClaim(store, { task_id: task.id, owner: 'quota' });
    recordExhaustion(store, { provider: 'test', error: '429', recoveryMs: 1 });
    assert.ok(store.get<any>('tasks', task.id).version > running.version);
    const result = tickQuotaRecovery(store, new Date(Date.now() + 1000));
    assert.equal(result.released_tasks, 1);
    assert.equal(store.get<any>('tasks', timed.id).status, 'WAITING');
  } finally { cleanup(); }
});

test('strict autonomous evidence refuses an unscoped verifier run', async () => {
  const { store, cleanup, o } = setup();
  const cwd = mkdtempSync(join(tmpdir(), 'gollum-no-git-'));
  try {
    const c = criterionCreate(store, { outcome_id: o.id, description: 'strict', verifier: {
      type: 'command', config: { command: 'true', cwd, require_scope: true },
    } });
    assert.equal((await verifyByCriterion(store, c.id)).status, 'UNKNOWN');
    assert.throws(() => outcomeMarkVerified(store, o.id), /remaining gap/);
  } finally { cleanup(); rmSync(cwd, { recursive: true, force: true }); }
});

test('repeated expired leases also exhaust the recovery budget', () => {
  const { store, cleanup, task } = setup();
  try {
    for (let i = 0; i < 6; i++) {
      const claimed = taskClaim(store, { task_id: task.id, owner: 'crashing-worker' });
      store.casUpdate('tasks', task.id, claimed.version, { lease_until: new Date(0).toISOString() });
      schedulerTick(store);
    }
    assert.equal(store.get<any>('tasks', task.id).status, 'BLOCKED');
  } finally { cleanup(); }
});
