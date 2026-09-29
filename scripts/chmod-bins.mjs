#!/usr/bin/env node
// Make every `bin` entry in package.json executable, and assert each has a shebang.
//
// Why: tsc writes new files with mode 0o666 & ~umask (0644), so the compiled
// entry points lose the +x bit the TypeScript sources carry. `npm install
// <tarball>` happens to chmod bin targets back to 0755, so a registry install
// works anyway — but anything that reaches dist/ without npm's fixup does not:
//   - `npm link` / a hand-made `node_modules/gollum -> /path/to/repo` symlink
//   - running ./dist/cli/index.js directly
//   - any installer that copies rather than links
// That is not hypothetical: on this machine /opt/homebrew/bin/gollum symlinks
// straight into the repo, and `gollum` failed with "Permission denied" while
// every test passed. Doing it in the build makes the artifact self-consistent
// regardless of how it was installed.

import { chmodSync, existsSync, readFileSync, openSync, readSync, closeSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const pkgDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8'));
const bins = pkg.bin ?? {};

const names = Object.keys(bins);
if (names.length === 0) {
  console.log('[gollum] no bin entries; nothing to chmod');
  process.exit(0);
}

const missingShebang = [];

for (const name of names) {
  const rel = bins[name];
  const abs = join(pkgDir, rel);

  if (!existsSync(abs)) {
    console.error(`[gollum] bin "${name}" -> ${rel} does not exist after build`);
    process.exit(1);
  }

  // Read the first two bytes only; a full read of a CLI bundle is wasted work.
  const buf = Buffer.alloc(2);
  const fd = openSync(abs, 'r');
  readSync(fd, buf, 0, 2, 0);
  closeSync(fd);
  if (buf.toString() !== '#!') {
    missingShebang.push(`${name} -> ${rel}`);
  }

  chmodSync(abs, 0o755);
}

if (missingShebang.length > 0) {
  console.error(
    `[gollum] bin entries are missing a "#!" shebang line:\n  ${missingShebang.join('\n  ')}`,
  );
  process.exit(1);
}

console.log(`[gollum] chmod +x applied to ${names.length} bin entries: ${names.join(', ')}`);
