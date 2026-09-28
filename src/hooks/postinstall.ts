#!/usr/bin/env node
/**
 * Gollum postinstall hook
 * Runs after `npm install -g gollum` to set up ~/.gollum/ directory structure
 * and detect available coding agents.
 */

import { existsSync, mkdirSync, symlinkSync, readlinkSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { homedir, platform } from 'node:os';

const GOLLUM_HOME = join(homedir(), '.gollum');
const PKG_ROOT = process.env.GOLLUM_PKG_ROOT || new URL('..', import.meta.url).pathname;
// PKG_ROOT points at dist/hooks/.. = dist/. We want the install root which is one level up from dist.
const INSTALL_ROOT = process.env.GOLLUM_PKG_ROOT || join(new URL('..', import.meta.url).pathname, '..');

const colors = {
  reset: '\x1b[0m',
  dim: '\x1b[2m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  cyan: '\x1b[36m',
  bold: '\x1b[1m',
};

function info(msg: string) { console.log(`${colors.cyan}ℹ${colors.reset} ${msg}`); }
function ok(msg: string) { console.log(`${colors.green}✓${colors.reset} ${msg}`); }
function warn(msg: string) { console.log(`${colors.yellow}!${colors.reset} ${msg}`); }

function ensureDir(p: string, label: string) {
  if (!existsSync(p)) {
    mkdirSync(p, { recursive: true });
    ok(`created ${label} ${colors.dim}${p}${colors.reset}`);
  } else {
    info(`exists  ${label} ${colors.dim}${p}${colors.reset}`);
  }
}

function writeIfMissing(p: string, content: string, label: string) {
  if (!existsSync(p)) {
    require('node:fs').writeFileSync(p, content, 'utf-8');
    ok(`wrote   ${label} ${colors.dim}${p}${colors.reset}`);
  } else {
    info(`exists  ${label} ${colors.dim}${p}${colors.reset}`);
  }
}

// 1. Create ~/.gollum/ directory structure
console.log(`${colors.bold}[Gollum postinstall]${colors.reset}`);

ensureDir(GOLLUM_HOME, '~/.gollum');
ensureDir(join(GOLLUM_HOME, 'skills'), '~/.gollum/skills');
ensureDir(join(GOLLUM_HOME, 'tools'), '~/.gollum/tools');
ensureDir(join(GOLLUM_HOME, 'runtime'), '~/.gollum/runtime');
ensureDir(join(GOLLUM_HOME, 'runtime', 'leases'), '~/.gollum/runtime/leases');
ensureDir(join(GOLLUM_HOME, 'runtime', 'events'), '~/.gollum/runtime/events');
ensureDir(join(GOLLUM_HOME, 'runtime', 'scheduler'), '~/.gollum/runtime/scheduler');

// 2. Registry (only if missing — preserve existing entries)
const registryPath = join(GOLLUM_HOME, 'registry.yaml');
writeIfMissing(
  registryPath,
  `version: 1\nprojects: []\n`,
  '~/.gollum/registry.yaml'
);

// 3. Detect installed coding agents
interface AgentDir { name: string; skillsDir: string; detectPath: string }
const AGENTS: AgentDir[] = [
  { name: 'claude-code', skillsDir: join(homedir(), '.claude', 'skills'), detectPath: join(homedir(), '.claude') },
  { name: 'codex', skillsDir: join(homedir(), '.codex', 'skills'), detectPath: join(homedir(), '.codex') },
  { name: 'cursor', skillsDir: join(homedir(), '.cursor', 'skills'), detectPath: join(homedir(), '.cursor') },
  { name: 'mavis', skillsDir: join(homedir(), '.mavis', 'skills'), detectPath: join(homedir(), '.mavis') },
];

const detected = AGENTS.filter((a) => existsSync(a.detectPath));
if (detected.length === 0) {
  warn('no coding agent detected (looked for ~/.claude ~/.codex ~/.cursor ~/.mavis)');
} else {
  info(`detected ${detected.map((a) => a.name).join(', ')}`);
}

// 4. Link bundled skills to each detected agent's skills directory
const BUNDLED_SKILLS_SRC = join(INSTALL_ROOT, 'skills');
if (existsSync(BUNDLED_SKILLS_SRC)) {
  for (const agent of detected) {
    ensureDir(agent.skillsDir, `~/.${agent.name}/skills`);
    const entries = require('node:fs').readdirSync(BUNDLED_SKILLS_SRC, { withFileTypes: true });
    for (const ent of entries) {
      if (!ent.isDirectory()) continue;
      const src = join(BUNDLED_SKILLS_SRC, ent.name);
      const dst = join(agent.skillsDir, ent.name);
      if (existsSync(dst)) {
        info(`exists  ~.${agent.name}/skills/${ent.name}`);
        continue;
      }
      try {
        symlinkSync(src, dst, 'dir');
        ok(`linked  ${colors.dim}~.${agent.name}/skills/${ent.name}${colors.reset} → ${colors.dim}${src}${colors.reset}`);
      } catch (e) {
        warn(`link failed for ${dst}: ${(e as Error).message}`);
      }
    }
  }
} else {
  warn(`bundled skills not found at ${BUNDLED_SKILLS_SRC} — run \`npm run build\` first`);
}

// 5. Print next steps
console.log(`
${colors.bold}Next steps:${colors.reset}
  ${colors.cyan}gollum doctor${colors.reset}              # self-check
  ${colors.cyan}gollum install-skills -g${colors.reset}   # re-link skills into all detected agents
  ${colors.cyan}gollum init${colors.reset}               # initialize current dir as a Gollum project
`);