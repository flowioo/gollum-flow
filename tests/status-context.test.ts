import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { tmpdir } from 'node:os';
import { criterionCreate } from '../src/core/criterion.js';
import { evidenceCreate } from '../src/core/evidence.js';
import { makeTestStore } from './helpers.js';
import { projectCreate, goalCreate } from '../src/core/goal.js';
import { outcomeCreate, outcomeMarkVerified } from '../src/core/outcome.js';
import { taskCreate, taskCheckpoint, taskClaim, taskComplete } from '../src/core/task.js';

const cli = resolve('dist/cli/index.js');
test('resume context is scoped, exposes checkpoint, and does not execute', { skip: !existsSync(cli) }, () => {
  const { store, cleanup } = makeTestStore();
  const cwd = mkdtempSync(join(tmpdir(), 'gollum-status-'));
  try {
    const p = projectCreate(store, { name: 'current' });
    const other = projectCreate(store, { name: 'other' });
    goalCreate(store, { project_id: other.id, title: 'must not leak' });
    const goal = goalCreate(store, { project_id: p.id, title: 'current goal' });
    const outcome = outcomeCreate(store, { goal_id: goal.id, title: 'result' });
    const task = taskCreate(store, { outcome_id: outcome.id, title: 'work', acceptance_criteria: [] });
    taskCheckpoint(store, task.id, { summary: 'saved', next_action: 'inspect tests' });
    mkdirSync(join(cwd, '.gollum'));
    writeFileSync(join(cwd, '.gollum/project.yaml'), JSON.stringify({ project_id: p.id, name: p.name }));
    const db = (store.raw().prepare('PRAGMA database_list').all()[0] as any).file;
    const out = execFileSync(process.execPath, [cli, 'resume', '--json'], { cwd, env: { ...process.env, GOLLUM_DB_PATH: db }, encoding: 'utf8', timeout: 10000 });
    const context = JSON.parse(out);
    assert.equal(context.goals.length, 1);
    assert.equal(context.goals[0].outcomes[0].tasks[0].summary, 'saved');
    assert.doesNotMatch(out, /must not leak/);
    assert.equal(store.get<any>('tasks', task.id).status, 'PENDING');
    assert.equal(context.decision.action, 'resume');
    const c = criterionCreate(store, { outcome_id: outcome.id, description: 'done', verifier: { type: 'human_assert', config: {} } });
    evidenceCreate(store, { criterion_id: c.id, status: 'PASS', data: { manual: true } });
    taskClaim(store, { task_id: task.id, owner: 'test' });
    taskComplete(store, task.id);
    outcomeMarkVerified(store, outcome.id);
    mkdirSync(join(cwd, '.spec-workflow', 'specs'), { recursive: true });
    const completed = JSON.parse(execFileSync(process.execPath, [cli, 'resume', '--json'], { cwd, env: { ...process.env, GOLLUM_DB_PATH: db }, encoding: 'utf8', timeout: 10000 }));
    assert.equal(completed.decision.action, 'complete');
    assert.deepEqual(completed.decision.task_ids, []);
    assert.ok(completed.goals[0].outcomes[0].criteria[0].latest_evidence.id);
    assert.equal(store.list('tasks').length, 1);
    assert.equal(existsSync(join(cwd, '.spec-workflow', 'specs', 'habitrail-cli')), false);
  } finally { cleanup(); rmSync(cwd, { recursive: true, force: true }); }
});
