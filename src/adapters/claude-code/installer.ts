/**
 * Claude Code Adapter (DESIGN §10)
 *
 * Installer:
 *   1. Register Gollum MCP server in Claude Code config
 *   2. Provide Skills via .claude/skills/gollum-<name>
 *
 * Usage:
 *   gollum install claude
 *
 * Claude Code config locations:
 *   User-level: ~/.claude.json or ~/.claude/settings.json
 *   Project-level: .mcp.json (in project root)
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { homedir } from 'node:os';

export interface ClaudePaths {
  userSettings: string;      // ~/.claude/settings.json
  projectMcpConfig: string;  // .mcp.json in cwd
  skillsDir: string;         // .claude/skills in cwd
  mcpServerName: string;     // "gollum"
  mcpCommand: string;        // absolute path to dist/mcp/server.js
}

export function detectClaudePaths(): ClaudePaths {
  const home = homedir();
  const cwd = process.cwd();
  return {
    userSettings: process.env.CLAUDE_SETTINGS ?? join(home, '.claude', 'settings.json'),
    projectMcpConfig: join(cwd, '.mcp.json'),
    skillsDir: join(cwd, '.claude', 'skills'),
    mcpServerName: 'gollum',
    mcpCommand: resolve(join(cwd, 'dist', 'mcp', 'server.js')),
  };
}

// =============================================================================
// Install
// =============================================================================

export function installClaudeMcpServer(paths: ClaudePaths): { ok: boolean; message: string; steps: string[] } {
  const steps: string[] = [];

  // Write .mcp.json (project-level)
  let config: any = { mcpServers: {} };
  if (existsSync(paths.projectMcpConfig)) {
    try {
      config = JSON.parse(readFileSync(paths.projectMcpConfig, 'utf-8'));
      if (!config.mcpServers) config.mcpServers = {};
    } catch {
      // ignore parse errors
    }
  }

  if (config.mcpServers.gollum) {
    steps.push(`MCP server already registered in ${paths.projectMcpConfig}`);
  } else {
    config.mcpServers.gollum = {
      command: 'node',
      args: [paths.mcpCommand],
      env: {
        GOLLUM_DB_PATH: process.env.GOLLUM_DB_PATH ?? './data/gollum.db',
      },
    };
    if (!existsSync(dirname(paths.projectMcpConfig))) {
      mkdirSync(dirname(paths.projectMcpConfig), { recursive: true });
    }
    writeFileSync(paths.projectMcpConfig, JSON.stringify(config, null, 2));
    steps.push(`Registered MCP server "gollum" in ${paths.projectMcpConfig}`);
  }

  return { ok: true, message: 'installed', steps };
}

export function installClaudeSkills(paths: ClaudePaths): { ok: boolean; message: string; steps: string[] } {
  const steps: string[] = [];
  const srcDir = resolve(process.cwd(), 'src/skills/core');
  if (!existsSync(srcDir)) {
    return { ok: false, message: `source skills dir not found: ${srcDir}`, steps };
  }
  if (!existsSync(paths.skillsDir)) {
    mkdirSync(paths.skillsDir, { recursive: true });
  }

  const skillNames = ['task-run', 'task-resume', 'verify', 'recover', 'outcome-evaluate', 'goal-align'];

  for (const name of skillNames) {
    const src = join(srcDir, name, 'SKILL.md');
    if (!existsSync(src)) continue;
    const dest = join(paths.skillsDir, `gollum-${name}`, 'SKILL.md');
    if (!existsSync(dirname(dest))) mkdirSync(dirname(dest), { recursive: true });
    const content = readFileSync(src, 'utf-8');
    writeFileSync(dest, content);
    steps.push(`Installed skill gollum-${name} → ${dest}`);
  }

  return { ok: true, message: 'skills installed', steps };
}

export function installClaude(): { ok: boolean; message: string; steps: string[] } {
  const paths = detectClaudePaths();
  const steps: string[] = [];

  if (!existsSync(paths.mcpCommand)) {
    return {
      ok: false,
      message: `MCP server binary not built: ${paths.mcpCommand}. Run 'npm run build' first.`,
      steps,
    };
  }

  const mcp = installClaudeMcpServer(paths);
  steps.push(...mcp.steps);
  if (!mcp.ok) return { ok: false, message: mcp.message, steps };

  const skills = installClaudeSkills(paths);
  steps.push(...skills.steps);
  if (!skills.ok) return { ok: false, message: skills.message, steps };

  return {
    ok: true,
    message: `Claude Code integration installed. Restart Claude Code to pick up.`,
    steps,
  };
}