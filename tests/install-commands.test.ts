/**
 * install-skills: slash-command namespacing contract.
 *
 * Why this exists: the first version of findCommands resolved each command's
 * destination against the directory it was currently walking, so the recursion
 * dropped one level of path. `commands/gollum/init.md` was linked as
 * `~/.claude/commands/init.md` — a flat, generic `/init` that both shadows
 * whatever the user already had and loses the namespace entirely.
 *
 * The nesting is the whole point of the feature: `commands/<ns>/<name>.md`
 * becomes `/<ns>:<name>`. These run the built CLI against a throwaway HOME so
 * the real ~/.claude is never touched.
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const CLI = join(ROOT, 'dist', 'cli', 'index.js');
const SRC_COMMAND = join(ROOT, 'dist', 'commands', 'gollum', 'init.md');

const built = existsSync(CLI) && existsSync(SRC_COMMAND);
const skip = built ? false : 'dist/ not built — run `npm run build` first';

let home: string;
let env: NodeJS.ProcessEnv;

function run(args: string[]): { out: string; code: number } {
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
  home = mkdtempSync(join(tmpdir(), 'gollum-cmd-'));
  // claude-code is "detected" when ~/.claude exists; create it so the target
  // is not filtered out.
  mkdirSync(join(home, '.claude'), { recursive: true });
  env = { ...process.env, HOME: home };
});

after(() => {
  if (home) rmSync(home, { recursive: true, force: true });
});

test('links the command under its namespace, not flattened', { skip }, () => {
  const r = run(['install-skills', '--agent', 'claude-code']);
  assert.equal(r.code, 0, r.out);

  const namespaced = join(home, '.claude', 'commands', 'gollum', 'init.md');
  assert.ok(existsSync(namespaced), `expected ${namespaced} to exist\n${r.out}`);

  // The regression: a flattened link means `/init`, which is both wrong and
  // liable to collide with the user's own command.
  const flat = join(home, '.claude', 'commands', 'init.md');
  assert.equal(existsSync(flat), false, `namespace was dropped: ${flat} exists\n${r.out}`);

  assert.match(r.out, /\/gollum:init/, `report should name the slash command\n${r.out}`);
});

test('linked command is readable and keeps its frontmatter', { skip }, () => {
  const linked = join(home, '.claude', 'commands', 'gollum', 'init.md');
  const md = readFileSync(linked, 'utf-8');
  assert.match(md, /^---\n/, 'slash command must open with YAML frontmatter');
  assert.match(md, /description:/);
  assert.match(md, /gollum init/, 'body should drive the CLI');
});

test('re-running install-skills is idempotent and does not nest copies', { skip }, () => {
  const first = run(['install-skills', '--agent', 'claude-code']);
  assert.equal(first.code, 0, first.out);
  assert.match(first.out, /exists ~\.claude-code\/commands\/gollum\/init\.md/, first.out);

  const linked = join(home, '.claude', 'commands', 'gollum', 'init.md');
  assert.ok(existsSync(linked));
});

test('a dangling command symlink is relinked, not left broken', { skip }, () => {
  const linked = join(home, '.claude', 'commands', 'gollum', 'init.md');
  rmSync(linked, { force: true });
  // Repoint at a target that does not exist: existsSync() follows the link and
  // reports false, so only an explicit lstat check catches this.
  symlinkSync(join(home, 'gone', 'init.md'), linked);

  const r = run(['install-skills', '--agent', 'claude-code']);
  assert.equal(r.code, 0, r.out);
  assert.ok(existsSync(linked), `broken symlink was not repaired\n${r.out}`);
  assert.match(r.out, /relinked/, r.out);
});
