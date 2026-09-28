#!/usr/bin/env node
/**
 * gollum-resolver — thin wrapper that dispatches to `gollum resolver` subcommand
 * Usage:
 *   gollum-resolver notify-cwd "$PWD"     # from shell hook (precmd/PROMPT_COMMAND)
 *   gollum-resolver list                  # list known projects
 *   gollum-resolver current               # current project from cache
 */

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const GOLLUM_BIN = join(__dirname, 'index.js');

if (!existsSync(GOLLUM_BIN)) {
  console.error(`gollum-resolver: cannot find ${GOLLUM_BIN}. Did you run \`npm run build\`?`);
  process.exit(1);
}

const args = ['resolver', ...process.argv.slice(2)];
const child = spawn(process.execPath, [GOLLUM_BIN, ...args], { stdio: 'inherit' });
child.on('exit', (code) => process.exit(code ?? 0));