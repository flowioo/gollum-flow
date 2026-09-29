/**
 * Heartbeat CLI — inspect task + supervisor heartbeats
 *
 *   gollum heartbeat status        Show supervisor + stuck-task summary
 *   gollum heartbeat stuck         List tasks with stale heartbeat
 *   gollum heartbeat recover       Release stuck tasks (manually)
 */

import { Command } from 'commander';
import { getStore, resetStore } from '../../workflow/store/store.js';
import {
  findStuckTasks,
  recoverStuckTasks,
  supervisorHealth,
  taskHeartbeat,
  HEARTBEAT_STALE_MS,
} from '../../agent/heartbeat.js';

export function heartbeatCommand(): Command {
  const cmd = new Command('heartbeat').description('Inspect task + supervisor heartbeats');

  cmd
    .command('status')
    .description('Show supervisor + stuck-task summary')
    .action(() => {
      const store = getStore();
      const health = supervisorHealth(store);
      const stuck = findStuckTasks(store);

      console.log('Heartbeat Status:');
      console.log(`  supervisor:        ${health.status}`);
      console.log(`  supervisor_pid:    ${health.pid ?? '-'}`);
      console.log(`  last_heartbeat:    ${health.last_heartbeat_at ?? '-'}`);
      console.log(`  stale_for:         ${Math.round(health.stale_for_ms / 1000)}s (threshold ${HEARTBEAT_STALE_MS / 1000}s)`);
      console.log(`  started_at:        ${health.started_at ?? '-'}`);
      console.log(`  restart_count:     ${health.restart_count}`);
      console.log(`  last_restart:      ${health.last_restart_reason ?? '-'}`);

      console.log(`\nStuck Tasks: ${stuck.length}`);
      for (const s of stuck) {
        console.log(`  - ${s.task.id.slice(-6)} "${s.task.title.slice(0, 40)}" stale=${Math.round(s.stale_for_ms / 1000)}s owner=${s.task.owner}`);
      }

      // List all RUNNING tasks
      const running = store.raw()
        .prepare(`SELECT id, title, owner, heartbeat_at, lease_until FROM tasks WHERE status IN ('RUNNING', 'VERIFYING', 'RECOVERING') ORDER BY heartbeat_at`)
        .all() as Array<{ id: string; title: string; owner: string | null; heartbeat_at: string | null; lease_until: string | null }>;

      console.log(`\nActive (RUNNING) Tasks: ${running.length}`);
      for (const r of running) {
        const hbAge = r.heartbeat_at
          ? Math.round((Date.now() - new Date(r.heartbeat_at).getTime()) / 1000)
          : 'no-hb';
        console.log(`  - ${r.id.slice(-6)} "${r.title.slice(0, 40)}" owner=${r.owner ?? '-'} heartbeat_age=${hbAge}s`);
      }
      resetStore();
    });

  cmd
    .command('stuck')
    .description('List tasks with stale heartbeat')
    .option('--stale-ms <ms>', 'Override stale threshold (ms)', (v) => parseInt(v, 10), HEARTBEAT_STALE_MS)
    .action((opts) => {
      const store = getStore();
      const stuck = findStuckTasks(store, { staleMs: opts.staleMs });
      console.log(`Found ${stuck.length} stuck tasks (threshold=${opts.staleMs}ms):`);
      for (const s of stuck) {
        console.log(`  - ${s.task.id.slice(-6)} "${s.task.title.slice(0, 40)}" stale=${Math.round(s.stale_for_ms / 1000)}s retry=${s.task.retry_count}`);
      }
      resetStore();
    });

  cmd
    .command('recover')
    .description('Release stuck tasks (manually trigger recovery)')
    .option('--stale-ms <ms>', 'Override stale threshold (ms)', (v) => parseInt(v, 10), HEARTBEAT_STALE_MS)
    .action((opts) => {
      const store = getStore();
      const results = recoverStuckTasks(store, { staleMs: opts.staleMs, actor: 'cli-manual' });
      console.log(`Recovered ${results.length} tasks:`);
      for (const r of results) {
        console.log(`  - ${r.task.id.slice(-6)} action=${r.action} retry=${r.task.retry_count} reason=${r.reason}`);
      }
      resetStore();
    });

  cmd
    .command('ping <task_id>')
    .description('Refresh heartbeat for a specific task (worker keeps alive)')
    .action((task_id) => {
      const store = getStore();
      try {
        const task = taskHeartbeat(store, task_id, { pid: process.pid });
        console.log(`✓ Heartbeat refreshed for ${task.id.slice(-6)}`);
        console.log(`  heartbeat_at: ${task.heartbeat_at}`);
        console.log(`  lease_until:  ${task.lease_until}`);
      } catch (e: any) {
        console.error(`✗ Failed: ${e.message}`);
        process.exit(1);
      }
      resetStore();
    });

  return cmd;
}
