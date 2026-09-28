#!/usr/bin/env node
/**
 * gollum-store — thin wrapper that dispatches to `gollum store` subcommand
 * Usage:
 *   gollum-store get task <id>
 *   gollum-store list tasks --outcome outcome-001
 *   gollum-store update task <id> --status in_progress
 */

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const GOLLUM_BIN = join(__dirname, 'index.js');

if (!existsSync(GOLLUM_BIN)) {
  console.error(`gollum-store: cannot find ${GOLLUM_BIN}. Did you run \`npm run build\`?`);
  process.exit(1);
}

const args = ['store', ...process.argv.slice(2)];
const child = spawn(process.execPath, [GOLLUM_BIN, ...args], { stdio: 'inherit' });
child.on('exit', (code) => process.exit(code ?? 0));