import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { snapshotWorkspace, createCandidate, inspectCandidate } from '../src/autonomy/workspace.js';

test('experiments snapshot dirty code, preserve source, and reject test or scope tampering', t => {
  const root = mkdtempSync(join(tmpdir(), 'gollum-experiment-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const source = join(root, 'source'), accepted = join(root, 'accepted'), candidate = join(root, 'candidate');
  mkdirSync(join(source, 'src'), { recursive: true }); mkdirSync(join(source, 'tests'));
  writeFileSync(join(source, 'src/main.js'), 'old');
  writeFileSync(join(source, 'tests/existing.js'), 'assertions');
  execFileSync('git', ['init', '-q', source]);
  execFileSync('git', ['add', '.'], { cwd: source });
  writeFileSync(join(source, 'src/main.js'), 'dirty');
  writeFileSync(join(source, 'src/new.js'), 'untracked');
  snapshotWorkspace(source, accepted); createCandidate(accepted, candidate);
  assert.equal(readFileSync(join(candidate, 'src/main.js'), 'utf8'), 'dirty');
  assert.equal(readFileSync(join(candidate, 'src/new.js'), 'utf8'), 'untracked');
  const options = { allowed: ['src'], protected: ['tests'], test_path: 'tests/regression.js', test_content: 'new assertion' };
  writeFileSync(join(candidate, options.test_path), options.test_content);
  assert.throws(() => inspectCandidate(accepted, candidate, options), /No implementation/);
  writeFileSync(join(candidate, 'src/main.js'), 'fixed');
  assert.deepEqual(inspectCandidate(accepted, candidate, options).sort(), ['src/main.js', 'tests/regression.js']);
  writeFileSync(join(candidate, 'tests/existing.js'), 'weakened');
  assert.throws(() => inspectCandidate(accepted, candidate, options), /outside implementation scope/);
  writeFileSync(join(candidate, 'tests/existing.js'), 'assertions');
  writeFileSync(join(candidate, options.test_path), 'fake pass');
  assert.throws(() => inspectCandidate(accepted, candidate, options), /Regression test was altered/);
  assert.equal(readFileSync(join(source, 'src/main.js'), 'utf8'), 'dirty');
});

test('snapshots reject dangling symlinks before creating a workspace', t => {
  const root = mkdtempSync(join(tmpdir(), 'gollum-symlink-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const source = join(root, 'source'); mkdirSync(source);
  execFileSync('git', ['init', '-q', source]);
  symlinkSync('/missing/gollum-file', join(source, 'escape'));
  assert.throws(() => snapshotWorkspace(source, join(root, 'snapshot')), /symlink/);
});

test('a destination reached through a symlink cannot place the snapshot inside its source', t => {
  const root = mkdtempSync(join(tmpdir(), 'gollum-alias-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const source = join(root, 'source'), alias = join(root, 'alias');
  mkdirSync(source); symlinkSync(source, alias);
  assert.throws(() => snapshotWorkspace(source, join(alias, 'nested')), /outside the source/);
});
