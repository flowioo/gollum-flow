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
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const CLI = join(ROOT, 'dist', 'cli', 'index.js');

let dbDir: string;
let env: NodeJS.ProcessEnv;

const built = existsSync(CLI);

function gollum(args: string[], cwd?: string): { out: string; stdout: string; stderr: string; code: number } {
  // spawnSync (not execFileSync) so the scoping notice on stderr is visible on
  // the success path too — that notice is how a user knows which project was used.
  const r = spawnSync(process.execPath, [CLI, ...args], {
    env,
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'pipe'],
    ...(cwd ? { cwd } : {}),
  });
  const stdout = r.stdout ?? '';
  const stderr = r.stderr ?? '';
  return {
    out: `${stdout}${stderr}`,
    // stdout/stderr stay separate: Node 22.13 still prints an ExperimentalWarning
    // for node:sqlite, so `out` is not always valid JSON even when stdout is.
    stdout,
    stderr,
    code: r.status === null ? 1 : r.status,
  };
}

before(() => {
  dbDir = mkdtempSync(join(tmpdir(), 'gollum-cli-smoke-'));
  const home = mkdtempSync(join(tmpdir(), 'gollum-cli-smoke-home-'));
  // `doctor` reads ~/.gollum, so an inherited HOME makes this pass or fail
  // depending on whether the developer happens to have gollum installed globally.
  mkdirSync(join(home, '.gollum'), { recursive: true });
  env = { ...process.env, HOME: home, USERPROFILE: home, GOLLUM_DB_PATH: join(dbDir, 'smoke.db') };
  // --cwd is not optional here: `init` writes .gollum/project.yaml into its
  // target, and without it the test would bind the gollum repo to itself.
  if (built) gollum(['init', '--cwd', dbDir, '-n', 'cli-smoke']);
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
  const { out, stdout, code } = gollum(['resolver', 'notify-cwd', ROOT]);
  assert.equal(code, 0, out);
  assert.doesNotMatch(out, /require is not defined/);
  JSON.parse(stdout);
});

it('init writes .gollum/project.yaml as JSON, and the resolver reads it back', () => {
  const target = join(dbDir, 'bound-project');
  mkdirSync(target, { recursive: true });

  const a = gollum(['init', '--cwd', target, '-n', 'bound-project']);
  assert.equal(a.code, 0, a.out);
  assert.match(a.out, /Bound:/, a.out);

  const yamlPath = join(target, '.gollum', 'project.yaml');
  assert.ok(existsSync(yamlPath), 'init did not write .gollum/project.yaml');

  // The file is named .yaml but the resolver JSON.parses it — plain YAML
  // fails silently and returns project_id: null, so assert the exact shape.
  const parsed = JSON.parse(readFileSync(yamlPath, 'utf-8'));
  assert.match(parsed.project_id, /^[0-9A-Z]{26}$/, `bad project_id: ${parsed.project_id}`);
  assert.equal(parsed.name, 'bound-project');

  const r = gollum(['resolver', 'notify-cwd', target]);
  const resolved = JSON.parse(r.stdout);
  assert.equal(resolved.project_id, parsed.project_id, r.out);
  assert.equal(resolved.source, 'project-yaml', r.out);
});

it('init is idempotent and reuses the same project (no delete exists)', () => {
  const target = join(dbDir, 'idempotent-project');
  mkdirSync(target, { recursive: true });

  gollum(['init', '--cwd', target, '-n', 'idempotent-project']);
  const first = JSON.parse(readFileSync(join(target, '.gollum', 'project.yaml'), 'utf-8'));

  const second = gollum(['init', '--cwd', target, '-n', 'idempotent-project']);
  assert.equal(second.code, 0, second.out);
  assert.match(second.out, /Already bound/, second.out);

  const third = gollum(['init', '--cwd', target, '-n', 'idempotent-project', '--force']);
  assert.equal(third.code, 0, third.out);
  assert.match(third.out, /\[reused\]/, 'force re-init must reuse the project, not create a second one');

  const after = JSON.parse(readFileSync(join(target, '.gollum', 'project.yaml'), 'utf-8'));
  assert.equal(after.project_id, first.project_id, 're-init changed the bound project');
});

it('goal list scopes to the project bound to cwd, --all escapes it', () => {
  // Two projects share one DB. Without scoping, `goal list --tree` in one
  // directory prints the other directory's task trees too.
  const dirA = join(dbDir, 'scope-a');
  const dirB = join(dbDir, 'scope-b');
  mkdirSync(dirA, { recursive: true });
  mkdirSync(dirB, { recursive: true });

  gollum(['init', '--cwd', dirA, '-n', 'scope-a']);
  gollum(['init', '--cwd', dirB, '-n', 'scope-b']);

  const idA = JSON.parse(readFileSync(join(dirA, '.gollum', 'project.yaml'), 'utf-8')).project_id;
  const idB = JSON.parse(readFileSync(join(dirB, '.gollum', 'project.yaml'), 'utf-8')).project_id;
  assert.notEqual(idA, idB);

  gollum(['goal', 'create', '-p', idA, '-t', 'goal in A']);
  gollum(['goal', 'create', '-p', idB, '-t', 'goal in B']);

  const scoped = gollum(['goal', 'list'], dirA);
  assert.equal(scoped.code, 0, scoped.out);
  assert.match(scoped.out, /goal in A/, scoped.out);
  assert.doesNotMatch(scoped.out, /goal in B/, 'goal list leaked another project goal');
  assert.match(scoped.out, /scoped to project/, 'must say which project it scoped to');

  const all = gollum(['goal', 'list', '--all'], dirA);
  assert.equal(all.code, 0, all.out);
  assert.match(all.out, /goal in A/, all.out);
  assert.match(all.out, /goal in B/, '--all must still show every project');
});

it('store health returns JSON', () => {
  const { out, stdout, code } = gollum(['store', 'health']);
  assert.equal(code, 0, out);
  assert.doesNotMatch(out, /require is not defined/);
  JSON.parse(stdout);
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
