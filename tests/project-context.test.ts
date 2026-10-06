import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, symlinkSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { installProjectContext } from '../src/adapters/project-context.js';

test('context installation preserves user instructions and is idempotent', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gollum-context-'));
  try {
    const path = join(dir, 'CLAUDE.md');
    const user = '# User rules\nKeep the existing spec plugin for explicit spec requests.\n';
    writeFileSync(path, user);
    assert.equal(installProjectContext(dir).length, 2);
    const first = readFileSync(path, 'utf8');
    assert.ok(first.startsWith(user));
    writeFileSync(path, first + '\nAdditional local rule.\n');
    assert.deepEqual(installProjectContext(dir), []);
    assert.equal(readFileSync(path, 'utf8'), first + '\nAdditional local rule.\n');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
test('malformed markers and symlinks do not overwrite existing instructions', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gollum-context-'));
  try {
    const claude = join(dir, 'CLAUDE.md');
    const agents = join(dir, 'AGENTS.md');
    writeFileSync(agents, '<!-- gollum:resume-context:start -->\nuser content');
    assert.throws(() => installProjectContext(dir), /Malformed/);
    assert.equal(existsSync(claude), false);
    rmSync(agents);
    const target = join(dir, 'user.md'); writeFileSync(target, 'preserve me'); symlinkSync(target, agents);
    assert.throws(() => installProjectContext(dir), /symlink/);
    assert.equal(readFileSync(target, 'utf8'), 'preserve me');
    assert.equal(existsSync(claude), false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
