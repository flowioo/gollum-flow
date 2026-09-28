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

import { existsSync, readlinkSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { homedir, platform } from 'node:os';
import { getStore } from '../../workflow/store/store.js';
import { listProjects } from '../../workflow/resolver.js';

const c = {
  reset: '\x1b[0m', green: '\x1b[32m', yellow: '\x1b[33m', red: '\x1b[31m',
  cyan: '\x1b[36m', dim: '\x1b[2m', bold: '\x1b[1m',
};
const ok = (s: string) => console.log(`${c.green}✓${c.reset} ${s}`);
const warn = (s: string) => console.log(`${c.yellow}!${c.reset} ${s}`);
const err = (s: string) => console.log(`${c.red}✗${c.reset} ${s}`);
const info = (s: string) => console.log(`${c.cyan}ℹ${c.reset} ${s}`);

interface CheckResult { ok: boolean; warnings: string[]; errors: string[] }

export async function runDoctor(): Promise<{ ok: boolean; report: string[] }> {
  const report: string[] = [];
  const errors: string[] = [];
  const warnings: string[] = [];

  console.log(`${c.bold}[gollum doctor]${c.reset}\n`);

  // 1. Node version
  const nodeVersion = process.version.replace(/^v/, '');
  const nodeMajor = parseInt(nodeVersion.split('.')[0] ?? '0', 10);
  if (nodeMajor >= 18) ok(`Node.js ${nodeVersion} (>= 18 required)`);
  else {
    err(`Node.js ${nodeVersion} (< 18 required)`);
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
  let totalSkills = 0;
  for (const agent of detected) {
    const skillsDir = join(agent.dir, 'skills');
    if (!existsSync(skillsDir)) continue;
    // Match by the skill's folder name in dist/skills/core/
    const gollumSkills = [
      'bootstrap',
      'goal-align',
      'task-run',
      'task-resume',
      'verify',
      'recover',
      'outcome-evaluate',
    ];
    let found = 0;
    for (const s of gollumSkills) {
      const link = join(skillsDir, s);
      if (existsSync(link)) {
        found++;
      }
    }
    if (found > 0) ok(`skills linked in ${agent.name}: ${found}/${gollumSkills.length}`);
    else warn(`no Gollum skills found in ${agent.name} (run: gollum install-skills)`);
    totalSkills = Math.max(totalSkills, found);
  }
  if (totalSkills === 0) warnings.push('no skills linked');

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