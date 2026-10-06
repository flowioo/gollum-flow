import { Command } from 'commander';
import { mkdtempSync, mkdirSync, readFileSync, openSync, closeSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { getStore, resolveDefaultDbPath } from '../../workflow/store/store.js';
import { parseConfig } from '../../autonomy/config.js';
import { ImprovementJournal, type ImprovementRun } from '../../autonomy/journal.js';
import { runImprovement } from '../../autonomy/runner.js';
import { superviseImprovement } from '../../autonomy/supervisor.js';

function output(run: ImprovementRun) {
  return { ...run, config: JSON.parse(run.config), checkpoint: JSON.parse(run.checkpoint) };
}
function runtimeEnvironment(): NodeJS.ProcessEnv {
  return { ...process.env, GOLLUM_DB_PATH: resolve(resolveDefaultDbPath()),
    ...(process.env.GOLLUM_MIGRATION_DIR ? { GOLLUM_MIGRATION_DIR: resolve(process.env.GOLLUM_MIGRATION_DIR) } : {}) };
}
async function execute(id: string): Promise<void> {
  const controller = new AbortController();
  const stop = () => controller.abort();
  process.once('SIGINT', stop); process.once('SIGTERM', stop);
  try {
    const result = await runImprovement(new ImprovementJournal(getStore()), id, {
      signal: controller.signal,
      onProgress: run => console.error(`[improve ${id}] ${run.status} ${run.phase} iteration=${run.iteration} spent=$${run.spent_usd.toFixed(4)}`),
    });
    console.log(JSON.stringify(output(result), null, 2));
    if (result.status === 'failed') process.exitCode = 1;
  } finally {
    process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop);
  }
}
async function watch(id: string): Promise<void> {
  const controller = new AbortController(), stop = () => controller.abort();
  process.once('SIGINT', stop); process.once('SIGTERM', stop);
  try {
    await superviseImprovement(getStore(), id, {
      worker_argv: [process.execPath, fileURLToPath(new URL('../index.js', import.meta.url)), 'improve', 'run', id],
      signal: controller.signal, env: runtimeEnvironment(),
      onProgress: run => console.error(`[improve ${id}] ${run.status} ${run.phase} iteration=${run.iteration} spent=$${run.spent_usd.toFixed(4)}`),
    });
    const run = new ImprovementJournal(getStore()).get(id);
    console.log(JSON.stringify(output(run), null, 2));
    if (run.status === 'failed') process.exitCode = 1;
  } finally {
    process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop);
  }
}
async function launch(id: string, detach: boolean): Promise<void> {
  if (!detach) return watch(id);
  const run = new ImprovementJournal(getStore()).get(id);
  if (!['running', 'waiting'].includes(run.status)) { console.log(JSON.stringify(output(run), null, 2)); return; }
  mkdirSync(run.workspace, { recursive: true });
  const log = join(run.workspace, 'watcher.log'), fd = openSync(log, 'a', 0o600);
  try {
    const child = spawn(process.execPath, [fileURLToPath(new URL('../index.js', import.meta.url)), 'improve', 'watch', id], {
      detached: true, stdio: ['ignore', fd, fd], env: runtimeEnvironment(),
    });
    await new Promise<void>((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
    child.unref();
    console.log(JSON.stringify({ run_id: id, watcher_pid: child.pid, log, status: 'starting' }, null, 2));
  } finally { closeSync(fd); }
}
export function improveCommand(): Command {
  const command = new Command('improve').description('Run autonomous, independently verified code improvement experiments');
  command.command('start').requiredOption('--config <file>', 'JSON configuration with objective, scope, checks and budgets')
    .option('--runs-dir <directory>', 'Workspace directory outside the source repository')
    .option('--detach', 'Run the supervisor in the background')
    .action(async opts => {
      const configFile = resolve(opts.config);
      const config = parseConfig(JSON.parse(readFileSync(configFile, 'utf8')), dirname(configFile));
      const root = resolve(opts.runsDir ?? join(dirname(resolveDefaultDbPath()), 'improvements'));
      mkdirSync(root, { recursive: true });
      const workspace = mkdtempSync(join(root, 'run-'));
      const run = new ImprovementJournal(getStore()).create(config, workspace);
      console.error(`Improvement run: ${run.id}\nWorkspace: ${workspace}`);
      await launch(run.id, !!opts.detach);
    });
  command.command('resume <run_id>').description('Continue a persisted experiment after its previous lease expires')
    .option('--detach', 'Run the supervisor in the background')
    .action(async (id, opts) => launch(id, !!opts.detach));
  command.command('run <run_id>', { hidden: true }).action(async id => execute(id));
  command.command('watch <run_id>', { hidden: true }).action(async id => watch(id));
  command.command('status [run_id]').description('Read persisted status and evidence without dispatching work')
    .action(id => {
      const store = getStore();
      console.log(JSON.stringify(id ? output(new ImprovementJournal(store).get(id))
        : store.list<ImprovementRun>('improvement_runs', '1 ORDER BY created_at DESC').map(output), null, 2));
    });
  command.command('stop <run_id>').description('Request cancellation of a run and its active child process')
    .action(id => {
      const journal = new ImprovementJournal(getStore()); journal.requestStop(id);
      console.log(JSON.stringify(output(journal.get(id)), null, 2));
    });
  return command;
}
