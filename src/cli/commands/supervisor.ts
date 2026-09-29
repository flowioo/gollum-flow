/**
 * Supervisor CLI — manage the 24/7 process supervisor
 *
 *   gollum supervisor start [--detach] [--interval <sec>]
 *     Start a parent supervisor that watches and restarts the worker loop.
 *     --detach: spawn the supervisor detached and return immediately.
 *
 *   gollum supervisor run-loop
 *     The inner worker loop (spawned by parent). DO NOT call directly.
 *
 *   gollum supervisor stop
 *     Send SIGTERM to the running supervisor (clean shutdown).
 *
 *   gollum supervisor status
 *     Show supervisor + worker health.
 *
 *   gollum supervisor log
 *     Tail the supervisor log file.
 */

import { Command } from 'commander';
import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { getStore, resetStore } from '../../workflow/store/store.js';
import {
  defaultSupervisorPaths,
  readSupervisorStatus,
  stopSupervisor,
  ParentSupervisor,
  type SupervisorPaths,
} from '../../agent/supervisor.js';
import { AgentLoop } from '../../agent/loop.js';

export function supervisorCommand(): Command {
  const cmd = new Command('supervisor').description('Manage the 24/7 process supervisor');

  // -------------------------------------------------------------------------
  // start
  // -------------------------------------------------------------------------
  cmd
    .command('start')
    .description('Start the supervisor (foreground or detached)')
    .option('--detach', 'Run detached from current terminal', false)
    .option('--interval <sec>', 'Watchdog check interval (seconds)', (v) => parseInt(v, 10), 5)
    .option('--max-restarts <n>', 'Max consecutive restarts before giving up', (v) => parseInt(v, 10), 5)
    .option('--spawn-cmd <cmd>', 'Override spawn command (default: tsx + cli supervisor run-loop)')
    .action(async (opts) => {
      const dbPath = process.env.GOLLUM_DB_PATH ?? './data/gollum.db';
      const paths = defaultSupervisorPaths(dbPath);

      // Check if already running
      const existing = readSupervisorStatus(paths, getStore());
      if (existing.parent_alive && existing.worker_alive) {
        console.error(`Supervisor already running:`);
        console.error(`  parent_pid: ${existing.parent_pid} (alive)`);
        console.error(`  worker_pid: ${existing.worker_pid} (alive)`);
        process.exit(1);
      }

      const spawnCmd = opts.spawnCmd
        ? opts.spawnCmd.split(' ')
        : ['npx', 'tsx', 'src/cli/index.ts', 'supervisor', 'run-loop'];

      const env = {
        ...process.env,
        GOLLUM_DB_PATH: paths.dbPath,
      };

      if (opts.detach) {
        // Spawn detached
        const child = spawn(spawnCmd[0]!, spawnCmd.slice(1), {
          detached: true,
          stdio: ['ignore', 'ignore', 'ignore'],
          env,
        });
        child.unref();
        console.log(`✓ Supervisor detached, parent_pid=${child.pid}`);
        console.log(`  log: ${paths.logFile}`);
        console.log(`  worker_log: ${paths.workerLogFile}`);
        process.exit(0);
      }

      // Foreground: run parent supervisor in this process
      console.log(`Starting supervisor in foreground (Ctrl+C to stop)...`);
      const supervisor = new ParentSupervisor({
        paths,
        spawnCommand: spawnCmd,
        spawnEnv: env,
        checkIntervalMs: opts.interval * 1000,
        maxRestarts: opts.maxRestarts,
        initialBackoffMs: 5_000,
        maxBackoffMs: 60_000,
        log: (msg) => {
          const ts = new Date().toISOString();
          console.log(`[parent ${ts}] ${msg}`);
          try {
            require('node:fs').appendFileSync(paths.logFile, `[parent ${ts}] ${msg}\n`);
          } catch {}
        },
      });
      await supervisor.start();
    });

  // -------------------------------------------------------------------------
  // run-loop (inner worker process)
  // -------------------------------------------------------------------------
  cmd
    .command('run-loop')
    .description('Inner worker loop (spawned by parent supervisor — do not call directly)')
    .option('--once', 'Run one cycle and exit (for testing)', false)
    .action(async (opts) => {
      const store = getStore();
      const log = (msg: string) => {
        const ts = new Date().toISOString();
        console.log(`[worker ${ts}] ${msg}`);
      };

      if (opts.once) {
        const { AgentLoop } = await import('../../agent/loop.js');
        const loop = new AgentLoop({ store, mode: 'worker', log });
        const result = await loop.cycle();
        console.log(JSON.stringify(result, null, 2));
        resetStore();
        return;
      }

      // Normal mode: 24/7 loop
      const loop = new AgentLoop({ store, mode: 'worker', log });
      await loop.start();
    });

  // -------------------------------------------------------------------------
  // stop
  // -------------------------------------------------------------------------
  cmd
    .command('stop')
    .description('Stop the running supervisor (sends SIGTERM)')
    .action(() => {
      const dbPath = process.env.GOLLUM_DB_PATH ?? './data/gollum.db';
      const paths = defaultSupervisorPaths(dbPath);
      const result = stopSupervisor(paths);
      if (!result.stopped) {
        console.log('No running supervisor found');
        console.log(`  pidfile: ${paths.parentPidFile}`);
        process.exit(1);
      }
      console.log(`✓ Supervisor stopping (parent_pid=${result.parent_pid}, worker_pid=${result.worker_pid})`);
    });

  // -------------------------------------------------------------------------
  // status
  // -------------------------------------------------------------------------
  cmd
    .command('status')
    .description('Show supervisor + worker health')
    .action(() => {
      const store = getStore();
      const dbPath = process.env.GOLLUM_DB_PATH ?? './data/gollum.db';
      const paths = defaultSupervisorPaths(dbPath);
      const status = readSupervisorStatus(paths, store);

      console.log('Supervisor Status:');
      console.log(`  parent_pid:  ${status.parent_pid ?? '(none)'} ${status.parent_alive ? '✓ alive' : '✗ dead'}`);
      console.log(`  worker_pid:  ${status.worker_pid ?? '(none)'} ${status.worker_alive ? '✓ alive' : '✗ dead'}`);
      console.log(`  heartbeat:   ${status.heartbeat_status}`);
      console.log(`  last_hb:     ${status.last_heartbeat_at ?? '(none)'}`);
      console.log(`  started_at:  ${status.started_at ?? '(none)'}`);
      console.log(`  restarts:    ${status.restart_count}`);
      console.log(`  log:         ${paths.logFile}`);
      console.log(`  worker_log:  ${paths.workerLogFile}`);

      if (!status.worker_alive && status.heartbeat_status === 'dead') {
        console.log('\n⚠ Worker is dead. Restart with: gollum supervisor start');
      }
      resetStore();
    });

  // -------------------------------------------------------------------------
  // log
  // -------------------------------------------------------------------------
  cmd
    .command('log')
    .description('Show recent supervisor log entries')
    .option('--tail <n>', 'Number of lines to show', (v) => parseInt(v, 10), 50)
    .action((opts) => {
      const dbPath = process.env.GOLLUM_DB_PATH ?? './data/gollum.db';
      const paths = defaultSupervisorPaths(dbPath);
      const logPath = paths.workerLogFile;
      if (!existsSync(logPath)) {
        console.log('(no log file)');
        return;
      }
      const lines = readFileSync(logPath, 'utf-8').split('\n').filter(Boolean);
      const tail = lines.slice(-opts.tail).join('\n');
      console.log(tail);
    });

  return cmd;
}
