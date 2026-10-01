/**
 * Codex CLI Adapter (DESIGN §10 / §24)
 *
 * Installer:
 *   1. Link the bundled skills into Codex's skills directory
 *   2. Do NOT register an MCP server — the CLI is the supported interface
 *
 * Usage:
 *   gollum install codex
 *
 * Why no MCP: every workflow operation is available through the `gollum` CLI and
 * the skills are written against it. The previous version appended an
 * [mcp_servers.gollum] block to ~/.codex/config.toml that pinned
 * GOLLUM_DB_PATH to ./data/gollum.db, so anything Codex created was invisible
 * to the CLI. That block is not written any more.
 */

import { existsSync, mkdirSync, readdirSync, symlinkSync, lstatSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// =============================================================================
// Config paths
// =============================================================================

export interface CodexPaths {
  configFile: string;   // ~/.codex/config.toml
  skillsDir: string;    // ~/.codex/skills
  detectDir: string;    // ~/.codex
}

export interface InstallResult {
  ok: boolean;
  message: string;
  steps: string[];
}

export function detectCodexPaths(): CodexPaths {
  const home = homedir() ?? '';
  return {
    configFile: process.env.CODEX_CONFIG ?? join(home, '.codex', 'config.toml'),
    skillsDir: process.env.CODEX_SKILLS_DIR ?? join(home, '.codex', 'skills'),
    detectDir: process.env.CODEX_HOME ?? join(home, '.codex'),
  };
}

/** dist/adapters/codex/installer.js → dist/skills */
function bundledSkillsDir(): string {
  return resolve(__dirname, '..', '..', 'skills', 'core');
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
// Install Skills
// =============================================================================

export function installCodexSkills(paths: CodexPaths): InstallResult {
  const steps: string[] = [];
  const src = bundledSkillsDir();
  if (!existsSync(src)) {
    return { ok: false, message: `bundled skills not found at ${src}. Run 'npm run build' first.`, steps };
  }
  if (!existsSync(paths.detectDir)) {
    return { ok: false, message: `Codex not detected (~/.codex missing)`, steps };
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

// =============================================================================
// Verification
// =============================================================================

export function verifyCodexInstall(_paths: CodexPaths): InstallResult {
  const steps: string[] = [];
  const src = bundledSkillsDir();
  if (!existsSync(src)) {
    return { ok: false, message: `bundled skills not built: ${src}. Run 'npm run build' first.`, steps };
  }
  steps.push(`✓ bundled skills present: ${src}`);
  return { ok: true, message: 'verified', steps };
}

// =============================================================================
// Main entry (CLI)
// =============================================================================

export function installCodex(): InstallResult {
  const paths = detectCodexPaths();
  const steps: string[] = [];

  const verify = verifyCodexInstall(paths);
  steps.push(...verify.steps);
  if (!verify.ok) return { ok: false, message: verify.message, steps };

  const skills = installCodexSkills(paths);
  steps.push(...skills.steps);
  if (!skills.ok) return { ok: false, message: skills.message, steps };

  steps.push('');
  steps.push('No MCP server registered — use the `gollum` CLI from the skills.');

  return {
    ok: true,
    message: 'Codex integration installed (skills only). Restart Codex to pick up.',
    steps,
  };
}

// Kept for API compatibility; no longer writes a config.toml block.
export function installCodexMcpServer(_paths: CodexPaths): InstallResult {
  return { ok: true, message: 'MCP registration removed', steps: ['skipped: MCP is not used'] };
}
