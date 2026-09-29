#!/usr/bin/env node
/**
 * Gollum postinstall hook
 * Runs after `npm install -g gollum` to set up ~/.gollum/ directory structure
 * and detect available coding agents.
 */

import { existsSync, mkdirSync, symlinkSync, readdirSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';

const GOLLUM_HOME = join(homedir(), '.gollum');
// dist/hooks/postinstall.js → dist/skills is one level up
const INSTALL_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

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
    writeFileSync(p, content, 'utf-8');
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

// 4. Link bundled skills to each detected agent's skills directory.
//
// The bundle is dist/skills/core/<skill>/SKILL.md, so the skill directories are
// one level *below* dist/skills. Linking dist/skills' immediate children here
// produced a single useless `core` symlink per agent instead of the 8 real
// skills, and left a junk entry that host skill discovery has to trip over.
// `gollum install-skills` already recursed correctly; keep the two in sync.
const BUNDLED_SKILLS_SRC = join(INSTALL_ROOT, 'skills');

/** Collect real skill dirs (those containing a SKILL.md), recursing one level. */
function collectSkills(root: string): { name: string; dir: string }[] {
  if (!existsSync(root)) return [];
  const out: { name: string; dir: string }[] = [];
  for (const ent of readdirSync(root, { withFileTypes: true })) {
    if (!ent.isDirectory()) continue;
    const dir = join(root, ent.name);
    if (existsSync(join(dir, 'SKILL.md'))) out.push({ name: ent.name, dir });
    else out.push(...collectSkills(dir));
  }
  return out;
}

const bundledSkills = collectSkills(BUNDLED_SKILLS_SRC);
if (bundledSkills.length === 0) {
  warn(`bundled skills not found at ${BUNDLED_SKILLS_SRC} — run \`npm run build\` first`);
} else {
  for (const agent of detected) {
    ensureDir(agent.skillsDir, `~/.${agent.name}/skills`);
    for (const skill of bundledSkills) {
      const dst = join(agent.skillsDir, skill.name);
      if (existsSync(dst)) {
        info(`exists  ~.${agent.name}/skills/${skill.name}`);
        continue;
      }
      try {
        symlinkSync(skill.dir, dst, 'dir');
        ok(`linked  ${colors.dim}~.${agent.name}/skills/${skill.name}${colors.reset} → ${colors.dim}${skill.dir}${colors.reset}`);
      } catch (e) {
        warn(`link failed for ${dst}: ${(e as Error).message}`);
      }
    }
  }
}

// 5. Print next steps
console.log(`
${colors.bold}Next steps:${colors.reset}
  ${colors.cyan}gollum doctor${colors.reset}              # self-check
  ${colors.cyan}gollum install-skills -g${colors.reset}   # re-link skills into all detected agents
  ${colors.cyan}gollum init${colors.reset}               # initialize current dir as a Gollum project
`);