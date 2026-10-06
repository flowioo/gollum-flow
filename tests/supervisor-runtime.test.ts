import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { defaultSupervisorPaths, readSupervisorStatus, stopSupervisor } from '../src/agent/supervisor.js';
import { Store } from '../src/workflow/store/store.js';
const cli = resolve('dist/cli/index.js');
const skip = !existsSync(cli);
const delay = (ms: number) => new Promise(r => setTimeout(r, ms));

async function waitFor(predicate: () => boolean, timeout = 8000) {
  const until = Date.now() + timeout;
  while (!predicate()) { if (Date.now() > until) throw new Error('timed out waiting for supervisor'); await delay(50); }
}

test('packaged detached supervisor starts a parent and worker outside the source tree', { skip }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'gollum-supervisor-'));
  const env = { ...process.env, GOLLUM_DB_PATH: join(dir, 'state.db') };
  const pids: number[] = [];
  const parent = join(dir, 'supervisor.parent.pid');
  const worker = join(dir, 'supervisor.worker.pid');
  try {
    const out = execFileSync(process.execPath, [cli, 'supervisor', 'start', '--detach', '--interval', '1'], { cwd: dir, env, encoding: 'utf8', timeout: 10000 });
    await waitFor(() => existsSync(parent) && existsSync(worker));
    pids.push(Number(readFileSync(parent, 'utf8')), Number(readFileSync(worker, 'utf8')));
    assert.notEqual(pids[0], pids[1]);
    assert.match(out, new RegExp(`parent_pid=${pids[0]}`));
    await waitFor(() => existsSync(join(dir, 'logs/worker.log')) && readFileSync(join(dir, 'logs/worker.log'), 'utf8').includes('Monitor-only'));
    execFileSync(process.execPath, [cli, 'supervisor', 'stop'], { cwd: dir, env, timeout: 10000 });
    await waitFor(() => !existsSync(parent));
  } finally {
    for (const pid of pids) { try { process.kill(pid, 'SIGKILL'); } catch { /* already stopped */ } }
    rmSync(dir, { recursive: true, force: true });
  }
});

test('supervisor stops a repeated crash after its configured restart budget', { skip }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'gollum-crash-budget-'));
  // Test ParentSupervisor with real child exits, short intervals and no external host.
  const module = resolve('dist/agent/supervisor.js');
  const script = join(dir, 'parent.mjs');
  writeFileSync(script, `import {ParentSupervisor,defaultSupervisorPaths} from ${JSON.stringify(module)};
    await new ParentSupervisor({paths:defaultSupervisorPaths(process.env.GOLLUM_DB_PATH),
      spawnCommand:[process.execPath,'-e','process.exit(1)'],checkIntervalMs:20,
      maxRestarts:2,initialBackoffMs:10,maxBackoffMs:20}).start();`);
  const child = spawn(process.execPath, [script], { env: { ...process.env, GOLLUM_DB_PATH: join(dir, 'state.db') }, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = ''; child.stdout.on('data', x => { output += x; }); child.stderr.on('data', x => { output += x; });
  const timer = setTimeout(() => child.kill('SIGKILL'), 8000);
  try {
    const code = await new Promise<number | null>((done, reject) => { child.once('exit', done); child.once('error', reject); });
    assert.equal(code, 1, output);
    assert.match(output, /giving up/);
    assert.equal((output.match(/spawning worker/g) ?? []).length, 3, output);
  } finally { clearTimeout(timer); child.kill('SIGKILL'); rmSync(dir, { recursive: true, force: true }); }
});

test('a failed spawn never leaves a pid file that stop would broadcast to', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'gollum-spawn-fail-'));
  const module = resolve('dist/agent/supervisor.js');
  const script = join(dir, 'parent.mjs');
  // A spawn command that cannot exist: the child never gets a pid.
  writeFileSync(script, `import {ParentSupervisor,defaultSupervisorPaths} from ${JSON.stringify(module)};
    await new ParentSupervisor({paths:defaultSupervisorPaths(process.env.GOLLUM_DB_PATH),
      spawnCommand:['/nonexistent/gollum-worker-does-not-exist'],checkIntervalMs:20,
      maxRestarts:1,initialBackoffMs:10,maxBackoffMs:20}).start();`);
  const child = spawn(process.execPath, [script], { env: { ...process.env, GOLLUM_DB_PATH: join(dir, 'state.db') }, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = ''; child.stdout.on('data', x => { output += x; }); child.stderr.on('data', x => { output += x; });
  const timer = setTimeout(() => child.kill('SIGKILL'), 8000);
  try {
    const code = await new Promise<number | null>((done, reject) => { child.once('exit', done); child.once('error', reject); });
    assert.equal(code, 1, output);
    assert.match(output, /spawn failed/);
    // The sentinel must not survive: a persisted -1 would be read back as a live pid.
    assert.equal(existsSync(join(dir, 'supervisor.worker.pid')), false, output);
  } finally { clearTimeout(timer); child.kill('SIGKILL'); rmSync(dir, { recursive: true, force: true }); }
});

test('a pid file holding a broadcast sentinel is treated as absent, never signalled', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'gollum-bad-pid-'));
  const store = new Store(join(dir, 'state.db'), resolve('src/workflow/store/migrations'));
  const paths = defaultSupervisorPaths(join(dir, 'state.db'));
  try {
    // Simulates the file an unfixed build persisted after a spawn failure.
    writeFileSync(paths.workerPidFile, '-1\n');
    const status = readSupervisorStatus(paths, store);
    assert.equal(status.worker_pid, null);
    assert.equal(status.worker_alive, false);
    // stopSupervisor must not call process.kill(-1), which signals every process of the user.
    const stopped = stopSupervisor(paths);
    assert.equal(stopped.stopped, false);
    assert.equal(stopped.worker_pid, null);
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});
