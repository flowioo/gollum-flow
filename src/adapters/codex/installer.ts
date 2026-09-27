/**
 * Codex CLI Adapter (DESIGN §10 / §24)
 *
 * Installer:
 *   1. Register Gollum MCP server in Codex config.toml
 *   2. Copy Gollum Skills to Codex skill directory
 *   3. Provide startup params (--task-id + goal context)
 *
 * Usage:
 *   gollum install codex
 *
 * After install, Codex can:
 *   - Spawn Gollum MCP server as stdio subprocess
 *   - Discover 16 tools via tools/list
 *   - Call task.get / task.claim / task.checkpoint / verify.* / goal-align ...
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { homedir } from 'node:os';

// =============================================================================
// Config paths
// =============================================================================

export interface CodexPaths {
  configFile: string;   // ~/.codex/config.toml
  skillsDir: string;    // ~/.codex/skills
  mcpServerName: string; // "gollum"
  mcpCommand: string;   // absolute path to dist/mcp/server.js
}

export function detectCodexPaths(): CodexPaths {
  const home = homedir();
  const configFile = process.env.CODEX_CONFIG ?? join(home, '.codex', 'config.toml');
  const skillsDir = process.env.CODEX_SKILLS_DIR ?? join(home, '.codex', 'skills');

  // mcpCommand = absolute path to compiled gollum-mcp entry
  // We assume the CLI entry will be at <project>/dist/cli/index.js
  // and the MCP server lives at <project>/dist/mcp/server.js
  const projectRoot = process.cwd();
  const mcpCommand = resolve(join(projectRoot, 'dist', 'mcp', 'server.js'));

  return {
    configFile,
    skillsDir,
    mcpServerName: 'gollum',
    mcpCommand,
  };
}

// =============================================================================
// Install MCP server in Codex config.toml
// =============================================================================

export interface InstallResult {
  ok: boolean;
  message: string;
  steps: string[];
}

/**
 * Parse existing Codex config.toml (or create new).
 * V0.1: simple string-based TOML manipulation (no TOML parser dep).
 *
 * Strategy: append a new [mcp_servers.gollum] section if absent.
 * Idempotent: if already installed, no-op.
 */
export function installCodexMcpServer(paths: CodexPaths): InstallResult {
  const steps: string[] = [];

  if (!existsSync(dirname(paths.configFile))) {
    mkdirSync(dirname(paths.configFile), { recursive: true });
  }

  let content = '';
  if (existsSync(paths.configFile)) {
    content = readFileSync(paths.configFile, 'utf-8');
  }

  if (content.includes('[mcp_servers.gollum]')) {
    steps.push(`MCP server "${paths.mcpServerName}" already registered in ${paths.configFile}`);
    return { ok: true, message: 'already installed', steps };
  }

  const block = `\n# Added by gollum install codex
[mcp_servers.${paths.mcpServerName}]
command = "${paths.mcpCommand}"
args = []
env = { "GOLLUM_DB_PATH" = "${process.env.GOLLUM_DB_PATH ?? './data/gollum.db'}" }
enabled = true
`;
  appendFileSync(paths.configFile, block);
  steps.push(`Registered MCP server "${paths.mcpServerName}" → ${paths.mcpCommand}`);
  return { ok: true, message: 'installed', steps };
}

// =============================================================================
// Install Skills
// =============================================================================

/**
 * Copy src/skills/core/* SKILL.md to Codex skills dir as gollum-*/
export function installCodexSkills(paths: CodexPaths): InstallResult {
  const steps: string[] = [];
  const srcDir = resolve(process.cwd(), 'src/skills/core');
  if (!existsSync(srcDir)) {
    return { ok: false, message: `source skills dir not found: ${srcDir}`, steps };
  }
  if (!existsSync(paths.skillsDir)) {
    mkdirSync(paths.skillsDir, { recursive: true });
  }

  const skillNames = [
    'task-run',
    'task-resume',
    'verify',
    'recover',
    'outcome-evaluate',
    'goal-align',
  ];

  for (const name of skillNames) {
    const src = join(srcDir, name, 'SKILL.md');
    if (!existsSync(src)) {
      steps.push(`⚠ skill ${name} not found at ${src}`);
      continue;
    }
    const dest = join(paths.skillsDir, `gollum-${name}`, 'SKILL.md');
    if (!existsSync(dirname(dest))) mkdirSync(dirname(dest), { recursive: true });
    const content = readFileSync(src, 'utf-8');
    writeFileSync(dest, content);
    steps.push(`Installed skill gollum-${name} → ${dest}`);
  }

  return { ok: true, message: 'skills installed', steps };
}

// =============================================================================
// Verification
// =============================================================================

export function verifyCodexInstall(paths: CodexPaths): InstallResult {
  const steps: string[] = [];
  if (!existsSync(paths.mcpCommand)) {
    return {
      ok: false,
      message: `MCP server binary not built: ${paths.mcpCommand}. Run 'npm run build' first.`,
      steps,
    };
  }
  steps.push(`✓ MCP binary exists: ${paths.mcpCommand}`);
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

  const mcp = installCodexMcpServer(paths);
  steps.push(...mcp.steps);
  if (!mcp.ok) return { ok: false, message: mcp.message, steps };

  const skills = installCodexSkills(paths);
  steps.push(...skills.steps);
  if (!skills.ok) return { ok: false, message: skills.message, steps };

  return {
    ok: true,
    message: `Codex integration installed. Restart Codex to pick up.`,
    steps,
  };
}