/**
 * postinstall contract.
 *
 * Why this exists: the hook linked `dist/skills`'s immediate children, which is
 * the `core` directory itself. So `npm install -g gollum-flow` left exactly one
 * useless symlink per agent —
 *
 *   ~/.claude/skills/core -> .../dist/skills/core
 *
 * — instead of the eight real skills, while `gollum install-skills` linked them
 * correctly. The two paths disagreed, the host's skill discovery had a junk
 * entry to trip over, and the E2E reported PASSED because it only ever asserted
 * on what `install-skills` produced.
 *
 * These tests run the built hook against a throwaway HOME so the real
 * ~/.claude is never touched.
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, rmSync, lstatSync, readlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const HOOK = join(ROOT, 'dist', 'hooks', 'postinstall.js');

const built = existsSync(HOOK);
const skip = built ? false : 'dist/ not built — run `npm run build` first';

const SKILLS = [
  'bootstrap',
  'plan',
  'task-run',
  'task-resume',
  'verify',
  'recover',
  'outcome-evaluate',
  'goal-align',
];

let home: string;
let skillsDir: string;
let out: string;

before(() => {
  home = mkdtempSync(join(tmpdir(), 'gollum-postinstall-'));
  // postinstall only links into agent dirs that already exist, and a real user
  // running `npm install -g` has one. Create it so the link path is exercised.
  skillsDir = join(home, '.claude', 'skills');
  execFileSync(process.execPath, ['-e', `require('fs').mkdirSync(${JSON.stringify(join(home, '.claude'))},{recursive:true})`]);
  out = execFileSync(process.execPath, [HOOK], {
    encoding: 'utf-8',
    env: { ...process.env, HOME: home },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
});

after(() => {
  if (home) rmSync(home, { recursive: true, force: true });
});

test('provisions ~/.gollum under the given HOME', { skip }, () => {
  for (const d of ['skills', 'tools', 'runtime/leases', 'runtime/events', 'runtime/scheduler']) {
    assert.ok(existsSync(join(home, '.gollum', d)), `~/.gollum/${d} missing`);
  }
  assert.ok(existsSync(join(home, '.gollum', 'registry.yaml')));
});

test('links every real skill, not the core/ wrapper directory', { skip }, () => {
  const entries = readdirSync(skillsDir);
  assert.ok(
    !entries.includes('core'),
    'postinstall must not link dist/skills/core as a single "core" skill — ' +
      'that yields one useless symlink instead of the real skills',
  );
  for (const s of SKILLS) {
    assert.ok(entries.includes(s), `postinstall did not link the ${s} skill (got: ${entries.join(', ')})`);
  }
});

test('each skill link points at a directory containing SKILL.md', { skip }, () => {
  for (const s of SKILLS) {
    const link = join(skillsDir, s);
    assert.ok(lstatSync(link).isSymbolicLink(), `${s} is not a symlink`);
    const target = readlinkSync(link);
    assert.match(target, /dist\/skills\/core\//, `${s} does not point into dist/skills/core`);
    assert.ok(existsSync(join(target, 'SKILL.md')), `${s} target has no SKILL.md`);
  }
});

test('links exactly the shipped skills and nothing else', { skip }, () => {
  const entries = readdirSync(skillsDir).sort();
  const shipped = readdirSync(join(ROOT, 'dist', 'skills', 'core'))
    .filter((d) => existsSync(join(ROOT, 'dist', 'skills', 'core', d, 'SKILL.md')))
    .sort();
  assert.deepEqual(entries, shipped, 'postinstall and the bundled skills disagree');
});

test('is idempotent — a second run re-links nothing', { skip }, () => {
  const second = execFileSync(process.execPath, [HOOK], {
    encoding: 'utf-8',
    env: { ...process.env, HOME: home },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  assert.doesNotMatch(second, /linked\s/, 'second run tried to link again');
  assert.match(second, /exists/);
});
