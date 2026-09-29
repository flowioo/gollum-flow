/**
 * CLI smoke test — every command that touches the filesystem or the store must
 * at least run without throwing.
 *
 * Why this exists: the unit tests exercise the store and the mcp core directly,
 * so several CLI code paths were never executed. `gollum validate --plan` shipped
 * with a `require()` call inside an ESM module ("type": "module") and crashed
 * with `ReferenceError: require is not defined` on first real use. Same class of
 * bug existed in supervisor.ts and commands/supervisor.ts.
 *
 * This spawns the built CLI as a child process — the only way to catch ESM/CJS
 * module-format errors, since tsx/vitest would resolve them differently.
 *
 * Skipped automatically when dist/ has not been built.
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const CLI = join(ROOT, 'dist', 'cli', 'index.js');

let dbDir: string;
let env: NodeJS.ProcessEnv;

const built = existsSync(CLI);

function gollum(args: string[]): { out: string; code: number } {
  try {
    const out = execFileSync(process.execPath, [CLI, ...args], {
      env,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { out, code: 0 };
  } catch (e) {
    const err = e as { stdout?: string; stderr?: string; status?: number };
    return {
      out: `${err.stdout ?? ''}${err.stderr ?? ''}`,
      code: typeof err.status === 'number' ? err.status : 1,
    };
  }
}

before(() => {
  dbDir = mkdtempSync(join(tmpdir(), 'gollum-cli-smoke-'));
  env = { ...process.env, GOLLUM_DB_PATH: join(dbDir, 'smoke.db') };
  if (built) gollum(['init']);
});

after(() => {
  if (dbDir) rmSync(dbDir, { recursive: true, force: true });
});

const it = (name: string, fn: () => void) =>
  test(name, { skip: built ? false : 'dist/ not built — run `npm run build` first' }, fn);

it('--help exits 0 and lists commands', () => {
  const { out, code } = gollum(['--help']);
  assert.equal(code, 0, out);
  assert.match(out, /goal/);
  assert.match(out, /outcome/);
  assert.match(out, /task/);
});

it('doctor exits 0', () => {
  const { out, code } = gollum(['doctor']);
  assert.equal(code, 0, out);
  assert.match(out, /Node\.js/);
});

it('goal create / list round-trips', () => {
  const p = gollum(['project', 'list']);
  const projectId = p.out.match(/[0-9A-Z]{26}/)?.[0];
  assert.ok(projectId, `no project id in: ${p.out}`);

  const c = gollum(['goal', 'create', '-p', projectId, '-t', 'cli smoke goal']);
  assert.equal(c.code, 0, c.out);

  const l = gollum(['goal', 'list']);
  assert.equal(l.code, 0, l.out);
  assert.match(l.out, /cli smoke goal/);
});

it('task create requires --outcome-id', () => {
  const { out, code } = gollum(['task', 'create', '-t', 'orphan']);
  assert.notEqual(code, 0);
  assert.match(out, /outcome-id/);
});

it('validate --plan parses JSON (regression: ESM require crash)', () => {
  const planPath = join(dbDir, 'plan.json');
  writeFileSync(
    planPath,
    JSON.stringify({
      title: 'g',
      outcomes: [
        {
          title: 'o',
          criteria: [{ description: 'c', verifier: { type: 'command', command: 'true' } }],
          tasks: [{ title: 't', acceptance_criteria: ['a'], estimated_minutes: 10 }],
        },
      ],
    }),
  );
  const { out, code } = gollum(['validate', '--plan', planPath]);
  assert.equal(code, 0, out);
  assert.doesNotMatch(out, /require is not defined/);
});

it('validate --plan rejects a >30min task as a hard error', () => {
  const planPath = join(dbDir, 'plan-big.json');
  writeFileSync(
    planPath,
    JSON.stringify({
      title: 'g',
      outcomes: [
        {
          title: 'o',
          criteria: [{ description: 'c', verifier: { type: 'command', command: 'true' } }],
          tasks: [{ title: 't', acceptance_criteria: ['a'], estimated_minutes: 90 }],
        },
      ],
    }),
  );
  const { out, code } = gollum(['validate', '--plan', planPath]);
  // A >30min task is a hard error, not a warning, so validate exits 1.
  assert.equal(code, 1, out);
  assert.match(out, /30min/);
  assert.match(out, /split/i);
});

it('resolver notify-cwd returns JSON, not a crash', () => {
  const { out, code } = gollum(['resolver', 'notify-cwd', ROOT]);
  assert.equal(code, 0, out);
  assert.doesNotMatch(out, /require is not defined/);
  JSON.parse(out);
});

it('store health returns JSON', () => {
  const { out, code } = gollum(['store', 'health']);
  assert.equal(code, 0, out);
  assert.doesNotMatch(out, /require is not defined/);
  JSON.parse(out);
});

it('events list runs', () => {
  const { out, code } = gollum(['events', 'list']);
  assert.equal(code, 0, out);
});

it('scheduler pick runs', () => {
  const { out, code } = gollum(['scheduler', 'pick']);
  assert.equal(code, 0, out);
});

it('supervisor status runs (regression: ESM require crash in commands/supervisor.ts)', () => {
  const { out, code } = gollum(['supervisor', 'status']);
  assert.doesNotMatch(out, /require is not defined/, out);
  assert.ok(code === 0 || code === 1, `unexpected code ${code}: ${out}`);
});

it('quota status runs', () => {
  const { out, code } = gollum(['quota', 'status']);
  assert.doesNotMatch(out, /require is not defined/, out);
  assert.ok(code === 0 || code === 1, `unexpected code ${code}: ${out}`);
});

it('heartbeat status runs', () => {
  const { out, code } = gollum(['heartbeat', 'status']);
  assert.doesNotMatch(out, /require is not defined/, out);
  assert.ok(code === 0 || code === 1, `unexpected code ${code}: ${out}`);
});

it('no command emits a require() ReferenceError', () => {
  const probes: string[][] = [
    ['--help'],
    ['doctor'],
    ['goal', 'list'],
    ['outcome', 'list'],
    ['task', 'list'],
    ['criterion', 'list'],
    ['evidence', 'list'],
    ['events', 'list'],
    ['scheduler', 'pick'],
    ['resolver', 'list'],
    ['store', 'health'],
    ['verify', 'command', '--help'],
  ];
  for (const args of probes) {
    const { out } = gollum(args);
    assert.doesNotMatch(out, /require is not defined/, `${args.join(' ')} → ${out.slice(0, 200)}`);
    assert.doesNotMatch(out, /ReferenceError/, `${args.join(' ')} → ${out.slice(0, 200)}`);
  }
});
