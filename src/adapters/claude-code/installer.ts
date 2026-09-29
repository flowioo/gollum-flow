/**
 * Claude Code Adapter (DESIGN §10)
 *
 * Installer:
 *   1. Link the bundled skills into the agent's skills directory
 *   2. Do NOT register an MCP server — the CLI is the supported interface
 *
 * Usage:
 *   gollum install claude
 *
 * Why no MCP: the gollum CLI exposes every workflow operation, and the skills
 * are written against it. Registering an MCP server would add a process to
 * supervise and a second schema to keep in sync, for no added capability. It
 * also used to pin GOLLUM_DB_PATH to a project-local ./data/gollum.db, which
 * silently split the database from the one the CLI reads.
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, symlinkSync, lstatSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

export interface ClaudePaths {
  userSettings: string;   // ~/.claude/settings.json (informational only)
  skillsDir: string;      // ~/.claude/skills
  detectDir: string;      // ~/.claude
}

/** dist/adapters/claude-code/installer.js → dist/skills */
function bundledSkillsDir(): string {
  return resolve(__dirname, '..', '..', 'skills', 'core');
}

export function detectClaudePaths(): ClaudePaths {
  const home = homedir() ?? '';
  return {
    userSettings: process.env.CLAUDE_SETTINGS ?? join(home, '.claude', 'settings.json'),
    skillsDir: join(home, '.claude', 'skills'),
    detectDir: join(home, '.claude'),
  };
}

function findSkills(root: string): { name: string; dir: string }[] {
  if (!existsSync(root)) return [];
  const out: { name: string; dir: string }[] = [];
  for (const ent of readdirSync(root, { withFileTypes: true })) {
    if (!ent.isDirectory()) continue;
    const sub = join(root, ent.name);
    if (existsSync(join(sub, 'SKILL.md'))) out.push({ name: ent.name, dir: sub });
    else out.push(...findSkills(sub));
  }
  return out;
}

// =============================================================================
// Install
// =============================================================================

export function installClaudeSkills(paths: ClaudePaths): { ok: boolean; message: string; steps: string[] } {
  const steps: string[] = [];
  const src = bundledSkillsDir();
  if (!existsSync(src)) {
    return {
      ok: false,
      message: `bundled skills not found at ${src}. Run 'npm run build' first.`,
      steps,
    };
  }
  if (!existsSync(paths.detectDir)) {
    return { ok: false, message: `Claude Code not detected (~/.claude missing)`, steps };
  }
  mkdirSync(paths.skillsDir, { recursive: true });

  let linked = 0;
  for (const skill of findSkills(src)) {
    const dest = join(paths.skillsDir, skill.name);
    if (existsSync(dest)) {
      try {
        if (lstatSync(dest).isSymbolicLink()) {
          steps.push(`exists ${dest}`);
          continue;
        }
      } catch { /* fall through */ }
      steps.push(`skipped ${dest} (exists and is not a symlink)`);
      continue;
    }
    try {
      symlinkSync(skill.dir, dest, 'dir');
      steps.push(`linked ${dest} → ${skill.dir}`);
      linked++;
    } catch (e) {
      steps.push(`FAILED ${dest}: ${(e as Error).message}`);
    }
  }
  return { ok: true, message: `linked ${linked} skill(s)`, steps };
}

export function installClaude(): { ok: boolean; message: string; steps: string[] } {
  const paths = detectClaudePaths();
  const skills = installClaudeSkills(paths);
  const steps = [...skills.steps];
  if (!skills.ok) return { ok: false, message: skills.message, steps };

  steps.push('');
  steps.push('No MCP server registered — use the `gollum` CLI from the skills.');
  steps.push('Next: restart Claude Code, then ask it to plan or resume work.');

  return {
    ok: true,
    message: 'Claude Code integration installed (skills only). Restart Claude Code to pick up.',
    steps,
  };
}

// Kept for API compatibility; reads the current .mcp.json if present.
export function installClaudeMcpServer(paths: ClaudePaths): { ok: boolean; message: string; steps: string[] } {
  return { ok: true, message: 'MCP registration removed', steps: ['skipped: MCP is not used'] };
}
