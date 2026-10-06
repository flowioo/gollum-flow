import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync, execFile, spawn } from 'node:child_process';
import { once } from 'node:events';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { Store } from '../src/workflow/store/store.js';
import { parseConfig } from '../src/autonomy/config.js';
import { ImprovementJournal } from '../src/autonomy/journal.js';
import { runImprovement } from '../dist/autonomy/runner.js';

function fixture(t: any, mode = 'fix', apply = false) {
  const root = mkdtempSync(join(tmpdir(), 'gollum-runner-'));
  const source = join(root, 'repo'); mkdirSync(join(source, 'src'), { recursive: true });
  mkdirSync(join(source, 'tests'));
  writeFileSync(join(source, 'src/math.cjs'), 'exports.double = n => n === 0 ? 1 : n * 2;\n');
  writeFileSync(join(source, 'tests/baseline.cjs'), "const assert = require('node:assert/strict'); assert.equal(require('../src/math.cjs').double(2), 4);\n");
  if (mode === 'ignored-helper') writeFileSync(join(source, '.gitignore'), 'ignored-helper.cjs\n');
  execFileSync('git', ['init', '-q', source]);
  const host = join(root, 'host.cjs'), trace = join(root, 'calls.txt');
  writeFileSync(host, `
const fs = require('node:fs');
const request = JSON.parse(fs.readFileSync(0, 'utf8'));
fs.appendFileSync(${JSON.stringify(trace)}, request.stage + '\\n');
const mode = ${JSON.stringify(mode)};
const interruptOnce = mode === 'crash-once' && request.stage === 'implement' && !fs.existsSync(${JSON.stringify(join(root, 'crash-marker'))});
if (mode === 'quota' && fs.readFileSync(${JSON.stringify(trace)}, 'utf8') === 'discover\\n') {
  console.log(JSON.stringify({is_error:true,result:'quota exhausted 429',total_cost_usd:0.01})); process.exit(1);
}
let result;
if (request.stage === 'discover') {
  result = fs.existsSync('tests/zero.mjs') ? {kind:'stop', title:'', hypothesis:'', paths:[], test_path:'', test_content:'', acceptance:'', reason:'Zero bug was fixed'} : {
    kind:'improvement', title:'Double zero correctly', hypothesis:'Zero should double to zero', paths:['src/math.cjs'], test_path:'tests/zero.mjs',
    test_content:"import assert from 'node:assert/strict'; import m from '../src/math.cjs'; assert.equal(m.double(0),0);\\n", acceptance:'Zero doubles to zero', reason:'Concrete arithmetic bug'
  };
  if (mode === 'learn' && !request.prompt.includes('normal failing exit')) result.test_content = "import assert from 'node:assert/strict'; import m from '../src/math.cjs'; assert.equal(m.double(2),4);\\n";
} else if (request.stage === 'implement') {
  fs.writeFileSync('src/math.cjs', 'exports.double = n => n * 2;\\n');
  if (mode === 'ignored-helper') {
    fs.writeFileSync('src/math.cjs', "exports.double = require('./ignored-helper.cjs').double;\\n");
    fs.writeFileSync('src/ignored-helper.cjs', 'exports.double = n => n * 2;\\n');
  }
  if (mode === 'tamper') fs.writeFileSync('tests/baseline.cjs', 'process.exit(0);');
  result = {summary:'Fixed zero'};
} else result = {accept:mode !== 'reject',reason:mode === 'reject' ? 'Not enough semantic confidence' : 'Real zero behavior is corrected, existing behavior preserved'};
if (interruptOnce) {
  fs.writeFileSync(${JSON.stringify(join(root, 'crash-marker'))}, 'partial implementation');
  setInterval(() => fs.appendFileSync(${JSON.stringify(join(root, 'crash-ticks'))}, '.'), 10);
} else console.log(JSON.stringify({result,total_cost_usd:0.01}));
`);
  const store = new Store(join(root, 'state.db'), join(process.cwd(), 'src/workflow/store/migrations'));
  t.after(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
  const journal = new ImprovementJournal(store);
  const config = parseConfig({ repo: source, objective: 'Correct arithmetic', host: {kind:'command',executable:process.execPath,args:[host]},
    checks:[{argv:[process.execPath,'tests/baseline.cjs']}], probe_command:[process.execPath,'{test}'],
    allowed_paths:['src'], protected_paths:['tests'], dependency_dirs:[], max_iterations:3, max_failures:['learn','crash-once'].includes(mode) ? 3 : 1, cooldown_ms:20, apply });
  const run = journal.create(config, join(root, 'run'));
  return {journal, run, source, trace, store, root};
}

test('real child processes execute failure → implementation → independent checks → review → retained improvement', async t => {
  const f = fixture(t);
  const run = await runImprovement(f.journal, f.run.id);
  const state = JSON.parse(run.checkpoint);
  assert.equal(run.status, 'completed', JSON.stringify(state));
  assert.equal(state.history.length, 1);
  assert.equal(state.history[0].disposition, 'accepted');
  assert.equal(state.history[0].baseline_probe.code, 1);
  assert.equal(state.history[0].fixed_probe.code, 0);
  assert.equal(state.history[0].checks[0].code, 0);
  assert.equal(readFileSync(join(f.source, 'src/math.cjs'), 'utf8').includes('n === 0'), true);
  assert.equal(readFileSync(join(state.accepted, 'src/math.cjs'), 'utf8'), 'exports.double = n => n * 2;\n');
  assert.equal(readFileSync(f.trace, 'utf8'), 'discover\nimplement\nreview\ndiscover\n');
  assert.equal(run.owner, null);
});

test('test tampering rejects the experiment before review or promotion', async t => {
  const f = fixture(t, 'tamper');
  const run = await runImprovement(f.journal, f.run.id);
  const state = JSON.parse(run.checkpoint);
  assert.equal(run.status, 'stopped');
  assert.equal(state.history[0].disposition, 'rejected');
  assert.match(state.history[0].reason, /outside implementation scope/);
  assert.equal(state.accepted, state.initial);
  assert.equal(readFileSync(f.trace, 'utf8'), 'discover\nimplement\n');
});

test('resume after implementation checkpoint does not repeat the host mutation', async t => {
  const f = fixture(t);
  await assert.rejects(runImprovement(f.journal, f.run.id, { afterCheckpoint(run) {
    if (run.phase === 'verify') throw new Error('simulated controller crash');
  } }), /simulated controller crash/);
  assert.equal(f.journal.get(f.run.id).phase, 'verify');
  const run = await runImprovement(f.journal, f.run.id);
  assert.equal(run.status, 'completed');
  assert.equal(readFileSync(f.trace, 'utf8'), 'discover\nimplement\nreview\ndiscover\n');
});

test('accepted improvement applies to the dirty source without losing unrelated work', async t => {
  const f = fixture(t, 'fix', true);
  writeFileSync(join(f.source, 'notes.txt'), 'keep user notes');
  const run = await runImprovement(f.journal, f.run.id);
  assert.equal(run.status, 'completed');
  assert.equal(readFileSync(join(f.source, 'src/math.cjs'), 'utf8'), 'exports.double = n => n * 2;\n');
  assert.equal(readFileSync(join(f.source, 'notes.txt'), 'utf8'), 'keep user notes');
  const state = JSON.parse(run.checkpoint);
  assert.equal(state.applied, state.accepted);
});

test('concurrent edits block application but preserve the accepted experiment', async t => {
  const f = fixture(t, 'fix', true);
  const run = await runImprovement(f.journal, f.run.id, { afterCheckpoint(current) {
    if (current.phase === 'apply') writeFileSync(join(f.source, 'src/math.cjs'), 'user changed this file');
  } });
  assert.equal(run.status, 'failed');
  const state = JSON.parse(run.checkpoint);
  assert.equal(state.history[0].disposition, 'accepted');
  assert.match(state.reason, /Source changed concurrently/);
  assert.equal(readFileSync(join(f.source, 'src/math.cjs'), 'utf8'), 'user changed this file');
});

test('quota cooldown retries the host and does not fabricate quota recovery evidence', async t => {
  const f = fixture(t, 'quota');
  const statuses: string[] = [];
  const run = await runImprovement(f.journal, f.run.id, { onProgress: r => statuses.push(r.status) });
  assert.equal(run.status, 'completed');
  assert.ok(statuses.includes('waiting'));
  assert.equal(run.failures, 0);
  assert.equal(readFileSync(f.trace, 'utf8'), 'discover\ndiscover\nimplement\nreview\ndiscover\n');
});

test('a rejected reproducer informs the next hypothesis instead of stopping all improvement', async t => {
  const f = fixture(t, 'learn');
  const run = await runImprovement(f.journal, f.run.id);
  assert.equal(run.status, 'completed');
  const state = JSON.parse(run.checkpoint);
  assert.deepEqual(state.history.map((h: any) => h.disposition), ['rejected', 'accepted']);
  assert.match(state.history[0].reason, /normal failing exit/);
});

test('review rejection prevents promotion even when every command passes', async t => {
  const f = fixture(t, 'reject');
  const run = await runImprovement(f.journal, f.run.id);
  const state = JSON.parse(run.checkpoint);
  assert.equal(run.status, 'stopped');
  assert.equal(state.history[0].disposition, 'rejected');
  assert.match(state.history[0].reason, /Independent review rejected/);
  assert.equal(state.accepted, state.initial);
});

test('public CLI supervises the full loop and preserves a relative database binding across cwd changes', async t => {
  const f = fixture(t);
  const { stdout } = await promisify(execFile)(process.execPath, [join(process.cwd(), 'dist/cli/index.js'), 'improve', 'resume', f.run.id], {
    cwd: f.source, env: { ...process.env, GOLLUM_DB_PATH: '../state.db' }, timeout: 15000, maxBuffer: 2 * 1024 * 1024,
  });
  const result = JSON.parse(stdout);
  assert.equal(result.id, f.run.id);
  assert.equal(result.status, 'completed');
  assert.equal(result.checkpoint.history[0].disposition, 'accepted');
  assert.equal(f.store.get<any>('improvement_watchers', f.run.id).owner, null);
});

test('a saved host result survives interruption before the phase transition without repeating implementation', async t => {
  const f = fixture(t);
  await assert.rejects(runImprovement(f.journal, f.run.id, { afterCheckpoint(run) {
    if (run.phase === 'verify') throw new Error('interruption fixture');
  } }), /interruption fixture/);
  const run = f.journal.get(f.run.id);
  const finished = f.store.list<any>('improvement_calls', "run_id = ? AND stage = 'implement' AND status = 'finished'", [run.id]);
  assert.equal(finished.length, 1);
  // Reconstruct the crash window: finishCall committed, but the next phase was not saved.
  f.store.casUpdate<any>('improvement_runs', run.id, run.version, { phase: 'implement',
    checkpoint: JSON.stringify({ ...JSON.parse(run.checkpoint), pending_call: finished[0].id }) });
  const resumed = await runImprovement(f.journal, run.id);
  assert.equal(resumed.status, 'completed');
  assert.equal(readFileSync(f.trace, 'utf8'), 'discover\nimplement\nreview\ndiscover\n');
  assert.equal(f.store.list<any>('improvement_calls', "run_id = ? AND stage = 'implement'", [run.id]).length, 1);
});

test('candidate-only ignored dependencies cannot make an incomplete retained change pass', async t => {
  const f = fixture(t, 'ignored-helper');
  const run = await runImprovement(f.journal, f.run.id);
  const state = JSON.parse(run.checkpoint);
  assert.equal(run.status, 'stopped');
  assert.equal(state.history[0].disposition, 'rejected');
  assert.match(state.history[0].reason, /clean retained source/);
  assert.equal(state.history[0].fixed_probe.code, 0, 'candidate passed before the independent retained-source check');
  assert.equal(state.accepted, state.initial);
});

test('detached CLI watcher actually finishes the experiment after its launching process exits', async t => {
  const f = fixture(t);
  const { stdout } = await promisify(execFile)(process.execPath, [join(process.cwd(), 'dist/cli/index.js'), 'improve', 'resume', f.run.id, '--detach'], {
    cwd: f.source, env: { ...process.env, GOLLUM_DB_PATH: '../state.db' }, timeout: 5000,
  });
  const launched = JSON.parse(stdout);
  assert.equal(launched.run_id, f.run.id);
  assert.equal(launched.status, 'starting');
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    const watcher = f.store.tryGet<any>('improvement_watchers', f.run.id);
    if (f.journal.get(f.run.id).status === 'completed' && watcher?.owner === null) break;
    await delay(50);
  }
  assert.equal(f.journal.get(f.run.id).status, 'completed');
  assert.equal(f.store.get<any>('improvement_watchers', f.run.id).owner, null);
  assert.match(readFileSync(launched.log, 'utf8'), /"completed"/);
});

test('a killed controller recovers through the public supervisor without retaining its partial implementation', { skip: process.platform === 'win32', timeout: 60000 }, async t => {
  const f = fixture(t, 'crash-once');
  const cli = join(process.cwd(), 'dist/cli/index.js');
  const environment = { ...process.env, GOLLUM_DB_PATH: join(f.root, 'state.db') };
  const controller = spawn(process.execPath, [cli, 'improve', 'run', f.run.id], { cwd: f.source, env: environment, stdio: 'ignore' });
  t.after(() => controller.kill('SIGKILL'));
  const deadline = Date.now() + 5000, ticks = join(f.root, 'crash-ticks');
  while (!existsSync(ticks) && Date.now() < deadline) await delay(20);
  assert.ok(existsSync(ticks), 'implementation host must actually be editing before the crash');
  const interrupted = f.journal.get(f.run.id);
  assert.equal(interrupted.phase, 'implement');
  const partialCandidate = JSON.parse(interrupted.checkpoint).candidate;
  assert.equal(readFileSync(join(partialCandidate, 'src/math.cjs'), 'utf8'), 'exports.double = n => n * 2;\n');
  const closed = once(controller, 'close');
  controller.kill('SIGKILL'); await closed;
  const recovering = promisify(execFile)(process.execPath, [cli, 'improve', 'resume', f.run.id], {
    cwd: f.source, env: environment, timeout: 45000, maxBuffer: 2 * 1024 * 1024,
  });
  await delay(600);
  const count = readFileSync(ticks).length;
  await delay(150);
  assert.equal(readFileSync(ticks).length, count, 'interrupted editing process must be gone');
  assert.equal(f.journal.get(f.run.id).generation, interrupted.generation, 'watcher must respect the old lease before reclaiming');
  const { stdout } = await recovering;
  const result = JSON.parse(stdout), history = result.checkpoint.history;
  assert.equal(result.status, 'completed');
  assert.deepEqual(history.map((h: any) => h.disposition), ['rejected', 'accepted']);
  assert.match(history[0].reason, /interrupted/);
  assert.notEqual(history[1].candidate, partialCandidate);
  assert.equal(result.generation, interrupted.generation + 1);
  assert.ok(Math.abs(result.spent_usd - 0.55) < 1e-8, 'lost reservation must be charged once');
  assert.equal(f.store.list<any>('improvement_calls', "run_id = ? AND status = 'interrupted'", [f.run.id]).length, 1);
  assert.equal(readFileSync(join(f.source, 'src/math.cjs'), 'utf8').includes('n === 0'), true);
});
