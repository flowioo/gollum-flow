import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/workflow/store/store.js';
import { parseConfig } from '../src/autonomy/config.js';
import { ImprovementJournal } from '../src/autonomy/journal.js';
import type { HostResult } from '../src/autonomy/host.js';

test('restart preserves checkpoints, fences old workers and charges interrupted calls', t => {
  const dir = mkdtempSync(join(tmpdir(), 'gollum-journal-'));
  const db = join(dir, 'state.db'), migrations = join(process.cwd(), 'src/workflow/store/migrations');
  let store = new Store(db, migrations);
  t.after(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });
  let journal = new ImprovementJournal(store);
  const config = parseConfig({ repo: dir, objective: 'Improve real behavior', checks: [{ argv: ['true'] }],
    probe_command: ['node', '{test}'], max_cost_usd: 1, cost_per_call_usd: 0.5 });
  const run = journal.create(config, join(dir, 'workspace'), 1000);
  const first = journal.claim(run.id, 'first', 100, 1000);
  journal.checkpoint(first, { phase: 'discover' }, { baseline: 'passed' }, 1001);
  const lostCall = journal.beginCall(first, 'discover', 1002);
  assert.throws(() => journal.claim(run.id, 'second', 100, 1050), /already owned/);
  assert.throws(() => journal.beginCall(first, 'discover', 1003), /budget unavailable/);
  store.close(); store = new Store(db, migrations); journal = new ImprovementJournal(store);
  assert.deepEqual(JSON.parse(journal.get(run.id).checkpoint), { baseline: 'passed', pending_call: lostCall });
  const second = journal.claim(run.id, 'second', 100, 1101);
  assert.equal(journal.get(run.id).spent_usd, 0.5);
  assert.equal(store.get<{ status: string }>('improvement_calls', lostCall).status, 'interrupted');
  assert.throws(() => journal.checkpoint(first, { phase: 'promote' }, {}, 1102), /Stale run lease/);
  const call = journal.beginCall(second, 'discover', 1102);
  const result: HostResult = { result: { kind: 'stop' }, cost_usd: 0.5, session_id: null, outcome: 'ok',
    process: { code: 0, signal: null, stdout: '{}', stderr: '', reason: 'exit', duration_ms: 1, log: '/tmp/example.log' } };
  journal.finishCall(second, call, result, 1103);
  assert.throws(() => journal.finishCall(second, call, result, 1104), /not active/);
  assert.equal(journal.get(run.id).spent_usd, 1);
  assert.throws(() => journal.beginCall(second, 'implement', 1105), /budget unavailable/);
  journal.release(second, 1106);
  const third = journal.claim(run.id, 'third', 100, 1107);
  journal.requestStop(run.id);
  assert.throws(() => journal.beginCall(third, 'review', 1108), /not executable/);
});
