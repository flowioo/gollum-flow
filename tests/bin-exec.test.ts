/**
 * Packaging contract for the `bin` entry points.
 *
 * Why this exists: `tsc` writes new files with mode 0o666 & ~umask, so the
 * compiled `dist/cli/*.js` lost the +x bit their TypeScript sources carry.
 * `npm install <tarball>` chmods bin targets back to 0755, so a registry
 * install was never actually broken — but `npm link`, a hand-made
 * `node_modules/gollum -> /path/to/repo` symlink, or running dist/cli/index.js
 * directly all hit `Permission denied`. This machine's /opt/homebrew/bin/gollum
 * is exactly that case, and every test still passed because they all spawn
 * `node <path-to-cli>` instead of executing the file.
 *
 * Test 4 below is the one that actually catches it: it execs the file as a
 * command rather than handing it to node, so a missing +x or a missing shebang
 * fails here instead of on the user's machine.
 *
 * Skipped automatically when dist/ has not been built.
 */

import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, readFileSync, statSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');

const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
const bins = (pkg.bin ?? {}) as Record<string, string>;
const names = Object.keys(bins);

let dbDir: string;
before(() => {
  dbDir = mkdtempSync(join(tmpdir(), 'gollum-bin-'));
});

const built = names.every((n) => existsSync(join(ROOT, bins[n])));
const skip = built ? false : 'dist/ not built — run `npm run build` first';

test('package.json declares the three documented bin entries', () => {
  assert.deepEqual(names.sort(), ['gollum', 'gollum-resolver', 'gollum-store']);
});

test('each bin source file carries a shebang', () => {
  for (const name of names) {
    // ./dist/cli/index.js -> src/cli/index.ts (bin name is not the source filename)
    const src = readFileSync(
      join(ROOT, bins[name].replace(/^\.?\/?dist\//, 'src/').replace(/\.js$/, '.ts')),
      'utf-8',
    );
    assert.ok(src.startsWith('#!'), `${bins[name]} source must start with "#!"`);
  }
});

test('build script chmods the bin entries after tsc', { skip }, () => {
  const build = pkg.scripts.build;
  assert.match(
    build,
    /chmod-bins/,
    'build must run scripts/chmod-bins.mjs, or linked/dev-tree installs get a non-executable gollum',
  );
  assert.doesNotMatch(
    build,
    /\|\|\s*true/,
    'build must not swallow failures with `|| true` — that hides a tsc error',
  );
});

test('each compiled bin entry is executable and has a shebang', { skip }, () => {
  for (const name of names) {
    const abs = join(ROOT, bins[name]);
    const mode = statSync(abs).mode;
    assert.ok(
      (mode & 0o111) !== 0,
      `${bins[name]} is not executable (mode ${(mode & 0o777).toString(8)}); ` +
        'a linked or dev-tree install will fail with "Permission denied"',
    );
    assert.ok(readFileSync(abs).subarray(0, 2).toString() === '#!', `${bins[name]} has no shebang`);
  }
});

test('bin entries run as commands, not only via `node <path>`', { skip }, () => {
  const env = { ...process.env, GOLLUM_DB_PATH: join(dbDir, 'bin.db') };
  const res = spawnSync(join(ROOT, bins.gollum), ['--help'], {
    env,
    encoding: 'utf-8',
  });
  assert.equal(res.error?.message, undefined, res.error?.message);
  assert.equal(res.status, 0, `${res.stdout ?? ''}${res.stderr ?? ''}`);
  assert.match(res.stdout, /goal/);
});

test('gollum-resolver and gollum-store are runnable commands', { skip }, () => {
  const env = { ...process.env, GOLLUM_DB_PATH: join(dbDir, 'bin.db') };
  for (const name of ['gollum-resolver', 'gollum-store']) {
    const res = spawnSync(join(ROOT, bins[name]), ['--help'], { env, encoding: 'utf-8' });
    // A command that does not implement --help still proves the shebang + +x
    // work: it must fail with a usage error, never EACCES/ENOEXEC.
    const combined = `${res.stdout ?? ''}${res.stderr ?? ''}`;
    assert.doesNotMatch(combined, /Permission denied|exec format error/i, `${name}: ${combined}`);
    assert.notEqual(res.error?.code, 'EACCES', `${name}: ${res.error?.message}`);
    assert.notEqual(res.error?.code, 'ENOEXEC', `${name}: ${res.error?.message}`);
  }
});

test('package.json "files" only lists paths that exist', () => {
  for (const entry of pkg.files as string[]) {
    assert.ok(existsSync(join(ROOT, entry)), `"files" lists "${entry}", which does not exist`);
  }
});

test('doctor passes on a freshly built tree', { skip }, () => {
  const env = { ...process.env, GOLLUM_DB_PATH: join(dbDir, 'bin.db') };
  const out = execFileSync(join(ROOT, bins.gollum), ['doctor'], {
    env,
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  assert.match(out, /Node\.js/);
});
