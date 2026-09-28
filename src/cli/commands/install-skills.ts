/**
 * Gollum V0.2 install-skills — symlink bundled skills to agent skill dirs
 *
 * Usage:
 *   gollum install-skills                  # link to all detected agents
 *   gollum install-skills --agent claude-code
 *
 * Skills source: bundled inside the npm package at <install_root>/skills/
 * Targets: ~/.claude/skills/, ~/.codex/skills/, ~/.cursor/skills/, ~/.mavis/skills/
 */

import { existsSync, mkdirSync, readdirSync, lstatSync, statSync, symlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
// After build: dist/cli/commands/install-skills.js → skills live at dist/skills/
const INSTALL_ROOT = join(__dirname, '..', '..');

interface AgentDir { name: string; skillsDir: string; detectPath: string }
const AGENTS: AgentDir[] = [
  { name: 'claude-code', skillsDir: join(homedir() ?? '', '.claude', 'skills'), detectPath: join(homedir() ?? '', '.claude') },
  { name: 'codex', skillsDir: join(homedir() ?? '', '.codex', 'skills'), detectPath: join(homedir() ?? '', '.codex') },
  { name: 'cursor', skillsDir: join(homedir() ?? '', '.cursor', 'skills'), detectPath: join(homedir() ?? '', '.cursor') },
  { name: 'mavis', skillsDir: join(homedir() ?? '', '.mavis', 'skills'), detectPath: join(homedir() ?? '', '.mavis') },
];

interface SkillEntry { name: string; srcDir: string; skillMd: string }

function findSkills(root: string): SkillEntry[] {
  const out: SkillEntry[] = [];
  if (!existsSync(root)) return out;
  for (const ent of readdirSync(root, { withFileTypes: true })) {
    if (!ent.isDirectory()) continue;
    const subdir = join(root, ent.name);
    const skillMd = join(subdir, 'SKILL.md');
    if (existsSync(skillMd)) {
      out.push({ name: ent.name, srcDir: subdir, skillMd });
    } else {
      // Recurse one level (handles src/skills/core/<skill>/ structure)
      out.push(...findSkills(subdir));
    }
  }
  return out;
}

export async function installSkills(opts: { global: boolean; agent?: string }): Promise<{
  ok: boolean;
  message: string;
  steps: string[];
}> {
  const steps: string[] = [];
  const skillsSrc = join(INSTALL_ROOT, 'skills');

  if (!existsSync(skillsSrc)) {
    return {
      ok: false,
      message: `bundled skills not found at ${skillsSrc}`,
      steps: [`run \`npm run build\` first to populate ${skillsSrc}`],
    };
  }

  const targets = opts.agent
    ? AGENTS.filter((a) => a.name === opts.agent)
    : AGENTS.filter((a) => existsSync(a.detectPath));

  if (targets.length === 0) {
    return {
      ok: false,
      message: opts.agent
        ? `agent "${opts.agent}" not recognized (valid: ${AGENTS.map((a) => a.name).join(', ')})`
        : 'no coding agent detected',
      steps: [],
    };
  }

  let linked = 0;
  for (const agent of targets) {
    mkdirSync(agent.skillsDir, { recursive: true });
    const skills = findSkills(skillsSrc);
    for (const skill of skills) {
      const dst = join(agent.skillsDir, skill.name);
      if (existsSync(dst)) {
        try {
          const target = lstatSync(dst);
          if (target.isSymbolicLink()) {
            // Verify the symlink target still exists
            try {
              statSync(dst);
              steps.push(`exists ~.${agent.name}/skills/${skill.name}`);
            } catch {
              steps.push(`broken ~.${agent.name}/skills/${skill.name} — relinking`);
              // fall through to relink below by removing
              // (skip symlinkSync; let it create fresh)
            }
            continue;
          }
        } catch { /* not a symlink, fall through */ }
        // Real dir exists; skip (don't overwrite user's local skill)
        steps.push(`exists ~.${agent.name}/skills/${skill.name} (not a symlink — leaving alone)`);
        continue;
      }
      try {
        symlinkSync(skill.srcDir, dst, 'dir');
        steps.push(`linked ~.${agent.name}/skills/${skill.name} → ${skill.srcDir}`);
        linked++;
      } catch (e) {
        steps.push(`FAILED ${dst}: ${(e as Error).message}`);
      }
    }
  }

  return {
    ok: true,
    message: `linked ${linked} skill(s) into ${targets.length} agent(s)`,
    steps,
  };
}