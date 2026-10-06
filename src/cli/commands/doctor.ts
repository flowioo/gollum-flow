/**
 * Gollum V0.2 doctor — self-check command
 *
 * Checks:
 *   1. Node version
 *   2. ~/.gollum/ directory structure
 *   3. Store connectivity (SQLite + migrations)
 *   4. Detected coding agents (claude-code, codex, cursor, mavis)
 *   5. Skill links in each detected agent
 *   6. Project registry (count + recent)
 */

import { existsSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { getStore } from '../../workflow/store/store.js';
import { listProjects } from '../../workflow/resolver.js';

// dist/cli/commands/doctor.js → dist/skills/core
const __dirname = dirname(fileURLToPath(import.meta.url));

const c = {
  reset: '\x1b[0m', green: '\x1b[32m', yellow: '\x1b[33m', red: '\x1b[31m',
  cyan: '\x1b[36m', dim: '\x1b[2m', bold: '\x1b[1m',
};
const ok = (s: string) => console.log(`${c.green}✓${c.reset} ${s}`);
const warn = (s: string) => console.log(`${c.yellow}!${c.reset} ${s}`);
const err = (s: string) => console.log(`${c.red}✗${c.reset} ${s}`);
const info = (s: string) => console.log(`${c.cyan}ℹ${c.reset} ${s}`);

/** Relative paths of every .md under root (e.g. `gollum/init.md`). */
function findCommandFiles(root: string, prefix = ''): string[] {
  const out: string[] = [];
  for (const ent of readdirSync(root, { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${ent.name}` : ent.name;
    if (ent.isDirectory()) out.push(...findCommandFiles(join(root, ent.name), rel));
    else if (ent.isFile() && ent.name.endsWith('.md')) out.push(rel);
  }
  return out.sort();
}

/** existsSync follows symlinks, so a link into a wiped dist/ reads as missing. */
function isResolvable(p: string): boolean {
  return existsSync(p);
}

export async function runDoctor(): Promise<{ ok: boolean; report: string[] }> {
  const report: string[] = [];
  const errors: string[] = [];
  const warnings: string[] = [];

  console.log(`${c.bold}[gollum doctor]${c.reset}\n`);

  // 1. Node version
  const nodeVersion = process.version.replace(/^v/, '');
  const nodeMajor = parseInt(nodeVersion.split('.')[0] ?? '0', 10);
  if (nodeMajor > 22 || (nodeMajor === 22 && Number(nodeVersion.split('.')[1]) >= 13)) ok(`Node.js ${nodeVersion} (>= 22.13 required)`);
  else {
    err(`Node.js ${nodeVersion} (< 22.13 required)`);
    errors.push('node version');
  }

  // 2. ~.gollum/ structure
  const HOME = join(homedir() ?? process.env.HOME ?? '', '.gollum');
  const REQUIRED_DIRS = ['skills', 'tools', 'runtime/leases', 'runtime/events', 'runtime/scheduler'];
  for (const d of REQUIRED_DIRS) {
    const p = join(HOME, d);
    if (existsSync(p)) ok(`dir  ~.gollum/${d}`);
    else {
      warn(`dir  ~.gollum/${d} (missing — will be created on next install)`);
      warnings.push(`~.gollum/${d}`);
    }
  }
  if (!existsSync(HOME)) {
    err(`dir  ~.gollum (missing — run \`npm install -g gollum\` to create)`);
    errors.push('~.gollum');
  }

  // 3. Store connectivity
  try {
    const store = await getStore();
    // V0.1: probe by listing projects (proves DB is open + table exists)
    const projects = store.list('projects');
    ok(`store healthy (${projects.length} project(s) in registry)`);
  } catch (e) {
    err(`store check failed: ${(e as Error).message}`);
    errors.push('store');
  }

  // 4. Detected agents
  const AGENTS = [
    { name: 'claude-code', dir: join(homedir(), '.claude') },
    { name: 'codex', dir: join(homedir(), '.codex') },
    { name: 'cursor', dir: join(homedir(), '.cursor') },
    { name: 'mavis', dir: join(homedir(), '.mavis') },
  ];
  const detected = AGENTS.filter((a) => existsSync(a.dir));
  if (detected.length === 0) {
    warn('no coding agent detected (looked for ~/.claude ~/.codex ~/.cursor ~/.mavis)');
    warnings.push('no agent');
  } else {
    info(`detected agents: ${detected.map((a) => a.name).join(', ')}`);
  }

  // 5. Skill links
  // Derive the expected list from what actually shipped instead of hardcoding
  // it — the list drifted once already (plan was added but doctor kept saying
  // 7/7 while 8 skills were installed). An empty bundle is a hard error.
  const skillsSrc = join(__dirname, '..', '..', 'skills', 'core');
  const gollumSkills = existsSync(skillsSrc)
    ? readdirSync(skillsSrc, { withFileTypes: true })
        .filter((e) => e.isDirectory() && existsSync(join(skillsSrc, e.name, 'SKILL.md')))
        .map((e) => e.name)
        .sort()
    : [];
  if (gollumSkills.length === 0) {
    err('no bundled skills found (dist/skills/core is empty — run `npm run build`)');
    errors.push('bundled skills');
  }

  let totalSkills = 0;
  for (const agent of detected) {
    const skillsDir = join(agent.dir, 'skills');
    if (!existsSync(skillsDir)) continue;
    const missing = gollumSkills.filter((s) => !existsSync(join(skillsDir, s)));
    const found = gollumSkills.length - missing.length;
    // A partial install is not ok: reporting "1/8" as a pass is how a broken
    // install hides. Only a completely absent set is a soft warning.
    if (missing.length === 0) {
      ok(`skills linked in ${agent.name}: ${found}/${gollumSkills.length}`);
    } else if (found === 0) {
      warn(`no Gollum skills found in ${agent.name} (run: gollum install-skills)`);
    } else {
      err(`skills incomplete in ${agent.name}: ${found}/${gollumSkills.length}, missing ${missing.join(', ')}`);
      errors.push(`${agent.name} skills`);
    }
    totalSkills = Math.max(totalSkills, found);
  }
  if (totalSkills === 0) warnings.push('no skills linked');

  // 5b. Slash commands (Claude Code only — no other agent has the convention).
  // Same "partial is not ok" rule as skills: a silently absent /gollum:init is
  // exactly how a broken install stays invisible.
  const commandsSrc = join(__dirname, '..', '..', 'commands');
  const gollumCommands = existsSync(commandsSrc) ? findCommandFiles(commandsSrc) : [];
  for (const agent of detected.filter((a) => a.name === 'claude-code')) {
    const commandsDir = join(agent.dir, 'commands');
    if (gollumCommands.length === 0) {
      warn('no bundled slash commands found (dist/commands is empty — run `npm run build`)');
      break;
    }
    if (!existsSync(commandsDir)) {
      warn(`no slash commands linked in ${agent.name} (run: gollum install-skills)`);
      warnings.push(`${agent.name} commands`);
      continue;
    }
    const missing = gollumCommands.filter((rel) => !isResolvable(join(commandsDir, rel)));
    const found = gollumCommands.length - missing.length;
    if (missing.length === 0) {
      ok(`commands linked in ${agent.name}: ${found}/${gollumCommands.length} (${gollumCommands.map((c) => '/' + c.replace(/\.md$/, '').split('/').join(':')).join(', ')})`);
    } else if (found === 0) {
      warn(`no Gollum slash commands found in ${agent.name} (run: gollum install-skills)`);
    } else {
      err(`commands incomplete in ${agent.name}: ${found}/${gollumCommands.length}, missing ${missing.join(', ')}`);
      errors.push(`${agent.name} commands`);
    }
  }

  // 6. Projects
  try {
    const projects = await listProjects();
    if (projects.length === 0) {
      info('no projects registered (run: gollum init)');
    } else {
      ok(`${projects.length} project(s) registered`);
      for (const p of projects.slice(0, 5)) {
        console.log(`    ${c.dim}${p.project_id}${c.reset}  ${p.name}  ${c.dim}${p.repo_root}${c.reset}`);
      }
      if (projects.length > 5) info(`  ... and ${projects.length - 5} more`);
    }
  } catch { /* non-fatal */ }

  // Summary
  console.log('');
  if (errors.length > 0) {
    err(`${errors.length} error(s): ${errors.join(', ')}`);
    return { ok: false, report };
  } else if (warnings.length > 0) {
    warn(`${warnings.length} warning(s): ${warnings.join(', ')}`);
    return { ok: true, report };
  } else {
    ok('all checks passed');
    return { ok: true, report };
  }
}