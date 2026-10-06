/**
 * Scheduler CLI commands
 *
 * - gollum scheduler tick   : run one tick, print picks
 * - gollum scheduler pick   : print next task to dispatch
 * - gollum scheduler run    : poll loop (every N seconds)
 * - gollum scheduler expired: list expired leases
 * - gollum scheduler release-expired : release expired leases
 */

import { Command } from 'commander';
import { getStore, resetStore } from '../../workflow/store/store.js';
import {
  pickNextTasks,
  schedulerTick,
  findExpiredLeases,
  releaseExpiredLease,
} from '../../workflow/scheduler/scheduler.js';

export function schedulerCommand(): Command {
  const cmd = new Command('scheduler').description('Run the workflow scheduler');

  cmd
    .command('tick')
    .description('Run one scheduler tick (release expired leases + pick next task)')
    .option('-l, --limit <n>', 'Max tasks to pick', (v) => parseInt(v, 10), 1)
    .action((opts) => {
      const store = getStore();
      const tick = schedulerTick(store, { limit: opts.limit });
      console.log(`Released leases: ${tick.released.length}`);
      for (const t of tick.released) {
        console.log(`  - ${t.id} (was ${t.owner})`);
      }
      console.log(`Picked tasks: ${tick.picked.length}`);
      for (const p of tick.picked) {
        console.log(`  - ${p.task.id} [${p.task.status}] "${p.task.title}" — ${p.reason}`);
      }
    });

  cmd
    .command('pick')
    .description('Just pick the next task without releasing leases')
    .option('-l, --limit <n>', 'Max tasks to pick', (v) => parseInt(v, 10), 1)
    .action((opts) => {
      const store = getStore();
      const picks = pickNextTasks(store, { limit: opts.limit });
      for (const p of picks) {
        console.log(
          `${p.task.id}\t${p.task.status}\t${p.task.title}\t${p.reason}`,
        );
      }
    });

  cmd
    .command('expired')
    .description('List tasks with expired leases')
    .action(() => {
      const store = getStore();
      const expired = findExpiredLeases(store);
      console.log(`Found ${expired.length} expired leases`);
      for (const t of expired) {
        console.log(
          `  - ${t.id} owner=${t.owner} lease_until=${t.lease_until} title="${t.title}"`,
        );
      }
    });

  cmd
    .command('release-expired')
    .description('Release expired leases (optionally one task)')
    .option('--task-id <id>', 'Release only this task if its lease expired')
    .action((opts) => {
      const store = getStore();
      const expired = findExpiredLeases(store).filter(t => !opts.taskId || t.id === opts.taskId);
      let released = 0;
      for (const t of expired) {
        try {
          releaseExpiredLease(store, t);
          released++;
        } catch {
          // skip on conflict
        }
      }
      console.log(`Released ${released}/${expired.length} expired leases`);
    });

  cmd
    .command('run')
    .description('Run scheduler in polling loop (Ctrl+C to stop)')
    .option('--every <seconds>', 'Poll interval (seconds)', (v) => parseInt(v, 10), 10)
    .action(async (opts) => {
      const every = opts.every * 1000;
      console.log(`Scheduler polling every ${opts.every}s. Ctrl+C to stop.`);
      const tick = async () => {
        const store = getStore();
        const result = schedulerTick(store);
        if (result.released.length > 0 || result.picked.length > 0) {
          console.log(
            `[${new Date().toISOString()}] released=${result.released.length} picked=${result.picked.length}`,
          );
        }
      };
      // First tick immediately
      await tick();
      const interval = setInterval(tick, every);
      process.on('SIGINT', () => {
        clearInterval(interval);
        resetStore();
        process.exit(0);
      });
      // Keep alive
      await new Promise(() => {});
    });

  return cmd;
}