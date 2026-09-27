/**
 * Cross-process resume test — Process B
 * Scheduler tick on same DB. Should:
 *   1. Find the expired lease from Process A
 *   2. Release it
 *   3. Re-pick the task
 *   4. Find Outcome still IN_PROGRESS with persisted criteria + checkpoint
 */
import { Store } from '../src/workflow/store/store.js';
import {
  schedulerTick,
  findExpiredLeases,
} from '../src/workflow/scheduler/scheduler.js';
import { outcomeGet, outcomeRemainingGap } from '../src/mcp/core/outcome.js';
import { taskGet } from '../src/mcp/core/task.js';

const dbPath = process.env.GOLLUM_DB_PATH;
if (!dbPath) {
  console.error('GOLLUM_DB_PATH required');
  process.exit(1);
}

const store = new Store(dbPath, './src/workflow/store/migrations');

// Before tick: check expired leases
const expired = findExpiredLeases(store);
console.log('Expired leases:', expired.length);
for (const t of expired) {
  console.log('  -', t.id, 'owner:', t.owner, 'lease_until:', t.lease_until);
}

// Tick: release expired + pick next
const tick = schedulerTick(store);
console.log('Released:', tick.released.length);
console.log('Picked:', tick.picked.length);
for (const p of tick.picked) {
  console.log('  - task:', p.task.id, 'title:', p.task.title);
  console.log('    summary still:', p.task.summary);
  console.log('    next_action:', p.task.next_action);

  // Full state inspection
  const { task: fullTask, outcome, goal } = taskGet(store, p.task.id);
  console.log('    owner (should be null after release):', fullTask.owner);
  console.log('    lease_until (should be null):', fullTask.lease_until);
  console.log('    Outcome:', outcome.title, outcome.status);
  console.log('    Goal:', goal.title, goal.status);

  const gap = outcomeRemainingGap(store, outcome.id);
  console.log('    Gap:', JSON.stringify(gap));
}

console.log('B_DONE');
store.close();