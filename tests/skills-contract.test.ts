/**
 * Skills ↔ CLI contract test.
 *
 * The skills are markdown instructions an agent follows. If they name a command
 * that does not exist, the agent runs it, gets an error, and the whole workflow
 * silently degrades. Six of the seven skills originally shipped as prose with
 * abstract tool names (task.get, goal.create) rather than runnable commands.
 *
 * This test extracts every `gollum <subcommand>` mentioned in a SKILL.md and
 * asserts the built CLI actually accepts it. It is what keeps the docs honest.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const SKILLS_DIR = join(ROOT, 'src', 'skills', 'core');
const CLI = join(ROOT, 'dist', 'cli', 'index.js');

const built = existsSync(CLI);

/**
 * Extract each `gollum <subcommand ...>` invocation from markdown together with
 * the long flags written on that same line. The subcommand is the first one or
 * two lowercase words; everything after it on the line is treated as arguments,
 * and any `--flag` in that tail is what we validate.
 */
function gollumCommands(md: string): { cmd: string; flags: string[] }[] {
  const out: { cmd: string; flags: string[] }[] = [];
  const seen = new Set<string>();
  for (const line of md.split('\n')) {
    if (!/\bgollum\s+[a-z]/.test(line)) continue;
    for (const m of line.matchAll(/\bgollum\s+((?:[a-z][a-z-]*\s*)+)/g)) {
      const words = m[1]!.trim().split(/\s+/);
      if (!words.length) continue;
      // A valid subcommand is 1-2 words; stop before positional values.
      const cmdWords: string[] = [];
      for (const w of words) {
        if (cmdWords.length >= 2) break;
        if (w.includes('$')) break;      // e.g. "$TASK_ID" — stop, it's a value
        if (!/^[a-z][a-z-]*$/.test(w)) break;
        cmdWords.push(w);
      }
      if (cmdWords.length === 0) continue;
      const cmd = cmdWords.join(' ');
      if (cmd.includes('$')) continue;
      // Flags = long flags anywhere in the rest of the line after `gollum <cmd>`.
      const after = line.slice(line.indexOf('gollum ' + cmd) + ('gollum ' + cmd).length);
      const flags = [...after.matchAll(/(--[a-z][a-z-]*)/g)].map((f) => f[1]!);
      const key = cmd + '|' + flags.join(' ');
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ cmd, flags });
    }
  }
  return out;
}

/** Does the CLI accept `<cmd> --help`, and does it document every long flag? */
function cliAccepts(cmd: string, flags: string[]): { ok: boolean; why: string } {
  let help = '';
  try {
    help = execFileSync(process.execPath, [CLI, ...cmd.split(' '), '--help'], {
      stdio: ['ignore', 'pipe', 'pipe'],
      encoding: 'utf-8',
    });
  } catch (e) {
    const err = e as { stdout?: string; stderr?: string };
    return { ok: false, why: `command not found: gollum ${cmd} :: ${(err.stderr ?? '').slice(0, 120)}` };
  }
  for (const f of flags) {
    // Short flags are too ambiguous to check reliably in prose.
    if (!f.startsWith('--')) continue;
    if (!help.includes(f)) return { ok: false, why: `gollum ${cmd} does not support ${f}` };
  }
  return { ok: true, why: '' };
}

const skillDirs = existsSync(SKILLS_DIR)
  ? readdirSync(SKILLS_DIR, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
  : [];

// Commands the CLI accepts but only when given a real argument, so --help
// alone errors. They are validated separately in cli-smoke.test.ts.
const NEEDS_ARG = new Set(['validate']);

test('skills directory is non-empty', () => {
  assert.ok(skillDirs.length >= 7, `expected >=7 skills, found ${skillDirs.length}`);
});

for (const name of skillDirs) {
  const file = join(SKILLS_DIR, name, 'SKILL.md');

  test(`${name}: has YAML frontmatter with name + description`, () => {
    const md = readFileSync(file, 'utf-8');
    assert.ok(md.startsWith('---\n'), 'must start with --- frontmatter');
    const fm = md.slice(4, md.indexOf('\n---', 4));
    assert.match(fm, /^name:\s*\S+/m, 'frontmatter needs name:');
    assert.match(fm, /^description:/m, 'frontmatter needs description:');
  });

  test(`${name}: code fences are balanced`, () => {
    const md = readFileSync(file, 'utf-8');
    const fences = md.split('\n').filter((l) => l.startsWith('```')).length;
    assert.equal(fences % 2, 0, `unbalanced code fences (${fences})`);
  });

  test(`${name}: does not instruct the agent to use MCP`, () => {
    const md = readFileSync(file, 'utf-8');
    // The CLI path is the supported one; MCP tool calls are not documented as
    // the way to do these workflows.
    assert.doesNotMatch(md, /mcp__gollum__/, 'references an MCP tool directly');
  });

  test(`${name}: every gollum command and flag it names actually exists`, { skip: built ? false : 'dist/ not built' }, () => {
    const md = readFileSync(file, 'utf-8');
    const cmds = gollumCommands(md).filter((c) => !NEEDS_ARG.has(c.cmd.split(' ')[0]!));
    const bad: string[] = [];
    for (const { cmd, flags } of cmds) {
      const r = cliAccepts(cmd, flags);
      if (!r.ok) bad.push(r.why);
    }
    assert.deepEqual(bad, [], `\n${name}/SKILL.md documents commands the CLI does not have:\n  ${bad.join('\n  ')}`);
  });
}

test('at least one skill documents a runnable create path', () => {
  // The question "can I create a goal by talking to the agent" needs an answer
  // in the skills, not just in the CLI.
  const plan = readFileSync(join(SKILLS_DIR, 'plan', 'SKILL.md'), 'utf-8');
  assert.match(plan, /gollum goal create/);
  assert.match(plan, /gollum task create/);
  assert.match(plan, /--outcome-id/);
});
