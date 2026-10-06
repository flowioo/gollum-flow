import { existsSync, lstatSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const START = '<!-- gollum:resume-context:start -->';
const END = '<!-- gollum:resume-context:end -->';
const quote = (value: string) => `'${value.replace(/'/g, "'\\''")}'`;

/** Preserve user instructions; replace only our own marked section. */
export function installProjectContext(directory: string): string[] {
  const cli = fileURLToPath(new URL('../cli/index.js', import.meta.url));
  const runtime = `${quote(process.execPath)} ${quote(cli)}`;
  const block = `${START}
## Gollum task recovery

Apply this section when the user asks to continue/resume Gollum work in this project.
For unrelated requests, follow the user's chosen workflow.

Before searching for task files, creating plans, or selecting another workflow, run:

\`\`\`bash
${runtime} resume --json
\`\`\`

Use this same Node + CLI path for subsequent Gollum commands; it identifies the
runtime which installed this context. Re-run init after moving the installation.

The project binding is .gollum/project.yaml; Goal, Task, Evidence and checkpoints
live in SQLite, not in checkpoint files, chat memory or .spec-workflow.
Read decision, goals, criteria/evidence and task summary/observation/next_action.
Report the existing task ID and next action before continuing implementation.

- decision.action=complete or no_work: report that there is no unfinished Gollum work and stop.
- decision.action=wait or needs_attention: report the reason; do not bypass a live lease,
  future wake time, blocked/failed task, abandoned goal, or quota cooldown.
- decision.action=resume: inspect the actual workspace, then continue only the listed task IDs.
- decision.action=reverify: inspect the affected outcomes and run their configured verifiers;
  do not create replacement tasks or mark completion without valid evidence.
- If the command fails or the binding is missing, report the error. Do not infer
  missing tasks from directory names or switch to another task system.

An empty spec directory, a plugin's requirements-needed response, and available
MCP tools are not Gollum requirements. Do not start spec-workflow or generate
Requirements/Design/Tasks unless the user explicitly requests that work or an
existing Gollum task requires it. Do not duplicate goals/tasks or restart DONE tasks.
After real verification, save evidence to the existing Criterion before completion.
${END}`;

  // Validate both files before writing either; never follow a user-owned symlink.
  const updates = ['CLAUDE.md', 'AGENTS.md'].map(name => {
    const path = join(directory, name);
    try { if (lstatSync(path).isSymbolicLink()) throw new Error(`Refusing to replace context symlink: ${path}`); }
    catch (error: any) { if (error.code !== 'ENOENT') throw error; }
    const old = existsSync(path) ? readFileSync(path, 'utf8') : '';
    const start = old.indexOf(START);
    const end = old.indexOf(END);
    if ((start < 0) !== (end < 0) || (start >= 0 && end < start) ||
        (start >= 0 && old.indexOf(START, start + START.length) >= 0)) {
      throw new Error(`Malformed Gollum context markers in ${path}; preserve and repair manually`);
    }
    const next = start < 0 ? `${old}${old && !old.endsWith('\n') ? '\n' : ''}${old ? '\n' : ''}${block}\n`
      : old.slice(0, start) + block + old.slice(end + END.length);
    return { path, old, next };
  });
  return updates.filter(update => {
    if (update.old === update.next) return false;
    writeFileSync(update.path, update.next, 'utf8');
    return true;
  }).map(update => update.path);
}
