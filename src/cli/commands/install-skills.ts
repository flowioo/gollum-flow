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

import { existsSync, mkdirSync, readdirSync, lstatSync, statSync, symlinkSync, unlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
// After build: dist/cli/commands/install-skills.js → skills live at dist/skills/
const INSTALL_ROOT = join(__dirname, '..', '..');

interface AgentDir { name: string; skillsDir: string; detectPath: string; commandsDir?: string }
const AGENTS: AgentDir[] = [
  // Only Claude Code has the `commands/<ns>/<name>.md` → `/<ns>:<name>`
  // slash-command convention, so it is the only agent that gets commandsDir.
  { name: 'claude-code', skillsDir: join(homedir() ?? '', '.claude', 'skills'), detectPath: join(homedir() ?? '', '.claude'), commandsDir: join(homedir() ?? '', '.claude', 'commands') },
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

/**
 * Slash commands: every .md under <base>, keeping the path relative to *base*
 * so a `commands/gollum/init.md` lands at `~/.claude/commands/gollum/init.md`
 * and is invoked as `/gollum:init`. The prefix has to be carried down through
 * the recursion — resolving against the current dir flattens the namespace and
 * silently turns it into a generic `/init`.
 */
interface CommandEntry { relPath: string; srcFile: string }

function findCommands(base: string, dir: string = base, prefix: string = ''): CommandEntry[] {
  const out: CommandEntry[] = [];
  if (!existsSync(dir)) return out;
  for (const ent of readdirSync(dir, { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${ent.name}` : ent.name;
    const p = join(dir, ent.name);
    if (ent.isDirectory()) out.push(...findCommands(base, p, rel));
    else if (ent.isFile() && ent.name.endsWith('.md')) out.push({ relPath: rel, srcFile: p });
  }
  return out;
}

/**
 * Link one path, reporting what happened. Shared by skills and commands:
 * an existing symlink is left alone, a broken one is relinked, and a real
 * file/dir the user owns is never touched.
 */
function linkInto(dst: string, src: string, kind: 'dir' | 'file'): 'linked' | 'exists' | 'relinked' | 'skipped' | 'failed' {
  let repaired = false;
  if (existsSync(dst) || isDanglingSymlink(dst)) {
    if (isDanglingSymlink(dst)) {
      // A symlink whose target vanished (stale dist/) is never a success.
      // Remove it and fall through to a fresh link.
      try {
        unlinkSync(dst);
        repaired = true;
      } catch { /* fall through — the link call below reports the real error */ }
    } else {
      return 'exists';
    }
  }
  try {
    mkdirSync(dirname(dst), { recursive: true });
    symlinkSync(src, dst, kind);
    return repaired ? 'relinked' : 'linked';
  } catch {
    // Lost a race, or the destination is a real file/dir the user owns.
    if (existsSync(dst)) return 'skipped';
    return 'failed';
  }
}

function isDanglingSymlink(p: string): boolean {
  let lst;
  try {
    lst = lstatSync(p);
  } catch {
    return false;   // nothing there at all — not a broken link
  }
  if (!lst.isSymbolicLink()) return false;
  try {
    statSync(p);    // follows the link; throws when the target is gone
    return false;
  } catch {
    return true;
  }
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
  let linkedCommands = 0;
  for (const agent of targets) {
    mkdirSync(agent.skillsDir, { recursive: true });
    const skills = findSkills(skillsSrc);
    for (const skill of skills) {
      const dst = join(agent.skillsDir, skill.name);
      const rel = `~.${agent.name}/skills/${skill.name}`;
      const r = linkInto(dst, skill.srcDir, 'dir');
      if (r === 'linked') { steps.push(`linked ${rel} → ${skill.srcDir}`); linked++; }
      else if (r === 'relinked') { steps.push(`relinked ${rel} → ${skill.srcDir}`); linked++; }
      else if (r === 'exists') steps.push(`exists ${rel}`);
      else if (r === 'skipped') steps.push(`exists ${rel} (not a symlink — leaving alone)`);
      else steps.push(`FAILED ${dst}`);
    }

    // Slash commands (Claude Code only)
    if (agent.commandsDir) {
      for (const cmd of findCommands(join(INSTALL_ROOT, 'commands'))) {
        const dst = join(agent.commandsDir, cmd.relPath);
        const slash = '/' + cmd.relPath.replace(/\.md$/, '').split(/[\\/]/).join(':');
        const rel = `~.${agent.name}/commands/${cmd.relPath}`;
        const r = linkInto(dst, cmd.srcFile, 'file');
        if (r === 'linked' || r === 'relinked') {
          steps.push(`${r === 'linked' ? 'linked' : 'relinked'} ${rel} → ${slash}`);
          linkedCommands++;
        } else if (r === 'exists') steps.push(`exists ${rel} → ${slash}`);
        else if (r === 'skipped') steps.push(`exists ${rel} (not a symlink — leaving alone)`);
        else steps.push(`FAILED ${dst}`);
      }
    }
  }

  return {
    ok: true,
    message: `linked ${linked} skill(s) and ${linkedCommands} command(s) into ${targets.length} agent(s)`,
    steps,
  };
}