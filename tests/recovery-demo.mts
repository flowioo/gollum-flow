/** Isolated real-process restart demo. No writes to the checkout or user state. */
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync, execFileSync } from 'node:child_process';
import { Store } from '../src/workflow/store/store.js';
import { projectCreate, goalCreate } from '../src/core/goal.js';
import { outcomeCreate, outcomeMarkVerified } from '../src/core/outcome.js';
import { criterionCreate } from '../src/core/criterion.js';
import { taskCreate, taskClaim, taskCheckpoint, taskComplete } from '../src/core/task.js';
import { verifyByCriterion } from '../src/core/verify.js';
import { schedulerTick } from '../src/workflow/scheduler/scheduler.js';

const mode = process.argv[2];
const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const work = process.argv[3];
if (!mode) {
  const dir = mkdtempSync(join(tmpdir(), 'gollum-recovery-demo-'));
  try {
    const repo = join(dir, 'repo'); mkdirSync(repo);
    writeFileSync(join(repo, 'sum.cjs'), 'module.exports = (a, b) => a - b;\n');
    for (const args of [['init', '-q'], ['config', 'user.email', 'demo@example.com'], ['config', 'user.name', 'demo'], ['add', '.'], ['commit', '-qm', 'broken fixture']]) {
      execFileSync('git', args, { cwd: repo, stdio: 'ignore' });
    }
    const run = (phase: string) => spawnSync(process.execPath,
      ['--import', 'tsx', fileURLToPath(import.meta.url), phase, dir], { cwd: root, encoding: 'utf8', timeout: 20000 });
    const a = run('a'); process.stdout.write(a.stdout); assert.equal(a.status, 42, a.stderr);
    await new Promise(r => setTimeout(r, 150));
    const b = run('b'); process.stdout.write(b.stdout); assert.equal(b.status, 0, b.stderr);
    console.log('PASS: process exit → persisted checkpoint → reclaim → fix → real verification → achieved');
  } finally { rmSync(dir, { recursive: true, force: true }); }
} else {
  const store = new Store(join(work!, 'state.db'), join(root, 'src/workflow/store/migrations'));
  const repo = join(work!, 'repo');
  if (mode === 'a') {
    const p = projectCreate(store, { name: 'demo' });
    const g = goalCreate(store, { project_id: p.id, title: 'addition works' });
    const o = outcomeCreate(store, { goal_id: g.id, title: '2 + 3 = 5' });
    const c = criterionCreate(store, { outcome_id: o.id, description: 'actual node assertion', verifier: {
      type: 'command', config: { cwd: repo, command: 'node -e "require(\'node:assert/strict\').equal(require(\'./sum.cjs\')(2,3),5)"' },
    } });
    assert.equal((await verifyByCriterion(store, c.id)).status, 'FAIL');
    const task = taskCreate(store, { outcome_id: o.id, title: 'fix addition', acceptance_criteria: ['assertion passes'] });
    const claimed = taskClaim(store, { task_id: task.id, owner: 'process-a', fenced: true, lease_ms: 100 });
    taskCheckpoint(store, task.id, { summary: 'subtraction found in sum', observation: 'test fails', next_action: 'replace subtraction with addition, then verify' }, claimed.lease_token!);
    console.log('A: persisted failure and checkpoint; terminating without cleanup');
    process.exit(42);
  }
  const tick = schedulerTick(store); assert.equal(tick.released.length, 1); assert.equal(tick.picked.length, 1);
  const task = tick.picked[0]!.task; assert.equal(task.summary, 'subtraction found in sum');
  const claimed = taskClaim(store, { task_id: task.id, owner: 'process-b', fenced: true });
  writeFileSync(join(repo, 'sum.cjs'), 'module.exports = (a, b) => a + b;\n');
  const c = store.list<any>('criteria', 'outcome_id = ?', [task.outcome_id])[0]!;
  assert.equal((await verifyByCriterion(store, c.id)).status, 'PASS');
  taskComplete(store, task.id, 'node assertion passed', claimed.lease_token!);
  const o = outcomeMarkVerified(store, task.outcome_id);
  assert.equal(o.status, 'VERIFIED'); assert.equal(store.get<any>('goals', o.goal_id).status, 'achieved');
  console.log('B: resumed checkpoint, fixed code, verified outcome and goal');
  store.close();
}
