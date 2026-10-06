import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Store } from '../src/workflow/store/store.js';
import { ImprovementJournal } from '../src/autonomy/journal.js';
import { parseConfig } from '../src/autonomy/config.js';
import { superviseImprovement } from '../dist/autonomy/supervisor.js';

function fixture(t: any, succeeds: boolean) {
  const root = mkdtempSync(join(tmpdir(), 'gollum-watch-')), db = join(root, 'state.db');
  const migrations = join(process.cwd(), 'src/workflow/store/migrations');
  const store = new Store(db, migrations), journal = new ImprovementJournal(store);
  t.after(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
  const config = parseConfig({ repo: root, objective: 'Supervisor fixture', checks:[{argv:['true']}], probe_command:['node','{test}'] });
  const run = journal.create(config, root), trace = join(root, 'launches'), worker = join(root, 'worker.mjs');
  writeFileSync(worker, `
import {appendFileSync,readFileSync} from 'node:fs';
import {Store} from ${JSON.stringify(pathToFileURL(join(process.cwd(), 'dist/workflow/store/store.js')).href)};
import {ImprovementJournal} from ${JSON.stringify(pathToFileURL(join(process.cwd(), 'dist/autonomy/journal.js')).href)};
appendFileSync(${JSON.stringify(trace)},'.');
if (${succeeds} && readFileSync(${JSON.stringify(trace)}).length >= 3) {
  const store = new Store(${JSON.stringify(db)}, ${JSON.stringify(migrations)});
  const journal = new ImprovementJournal(store);
  const lease = journal.claim(${JSON.stringify(run.id)},'fixture-worker');
  journal.checkpoint(lease,{status:'completed'},{history:[],reason:'Supervisor test fixture completed'});
  journal.release(lease);store.close();
} else process.exit(1);
`);
  return {root, store, journal, run, trace, worker};
}

test('watchdog automatically relaunches a crashing controller with a durable restart count', async t => {
  const f = fixture(t, true);
  await superviseImprovement(f.store, f.run.id, {worker_argv:[process.execPath,f.worker],restart_delay_ms:10});
  assert.equal(f.journal.get(f.run.id).status, 'completed');
  assert.equal(readFileSync(f.trace).length, 3);
  const watcher = f.store.get<any>('improvement_watchers', f.run.id);
  assert.equal(watcher.restarts, 2);
  assert.equal(watcher.owner, null);
});

test('watchdog restart exhaustion stops instead of resetting the budget indefinitely', async t => {
  const f = fixture(t, false);
  await superviseImprovement(f.store, f.run.id, {worker_argv:[process.execPath,f.worker],restart_delay_ms:10,max_restarts:1});
  assert.equal(readFileSync(f.trace).length, 2);
  assert.equal(f.journal.get(f.run.id).status, 'stopped');
  assert.equal(f.journal.get(f.run.id).stop_requested, 1);
  await superviseImprovement(f.store, f.run.id, {worker_argv:[process.execPath,f.worker],restart_delay_ms:10,max_restarts:1});
  assert.equal(readFileSync(f.trace).length, 2);
});

test('a second watcher cannot supervise the same run concurrently', async t => {
  const f = fixture(t, true);
  const first = superviseImprovement(f.store, f.run.id, {worker_argv:[process.execPath,f.worker],restart_delay_ms:10});
  await assert.rejects(superviseImprovement(f.store, f.run.id, {worker_argv:[process.execPath,f.worker]}), /already supervised/);
  await first;
  assert.equal(readFileSync(f.trace).length, 3);
});
