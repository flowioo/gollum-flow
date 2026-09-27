/**
 * Cross-process resume test — Process A
 * Creates Outcome + Task, claims with short lease, writes checkpoint.
 * Then "crashes" (exits).
 */
import { Store } from '../src/workflow/store/store.js';
import { projectCreate, goalCreate } from '../src/mcp/core/goal.js';
import { outcomeCreate } from '../src/mcp/core/outcome.js';
import { criterionCreate } from '../src/mcp/core/criterion.js';
import { taskCreate, taskClaim, taskCheckpoint } from '../src/mcp/core/task.js';

const dbPath = process.env.GOLLUM_DB_PATH;
if (!dbPath) {
  console.error('GOLLUM_DB_PATH required');
  process.exit(1);
}

const store = new Store(dbPath, './src/workflow/store/migrations');
const p = projectCreate(store, { name: 'p-resume' });
const g = goalCreate(store, { project_id: p.id, title: 'g-resume' });
const o = outcomeCreate(store, { goal_id: g.id, title: 'o-resume' });
const c = criterionCreate(store, {
  outcome_id: o.id,
  description: 'all tests pass',
  verifier: { type: 'command', config: { command: 'pytest' } },
});
const task = taskCreate(store, { outcome_id: o.id, title: 't-fix' });
const claimed = taskClaim(store, {
  task_id: task.id,
  owner: 'process-A',
  lease_ms: 2000, // 2s lease — will expire during the test
});
taskCheckpoint(store, task.id, {
  summary: 'Process A started, killed mid-task',
  observation: 'halfway through fix',
  next_action: 'resume from where A left off',
});

console.log('outcome_id', o.id);
console.log('task_id', task.id);
console.log('criterion_id', c.id);
console.log('lease_until', claimed.lease_until);
console.log('A_DONE');
store.close();