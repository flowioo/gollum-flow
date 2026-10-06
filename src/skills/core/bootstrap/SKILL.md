---
name: gollum-bootstrap
description: |
  Load the current project's SQLite Goal, Task, Evidence and checkpoints with
  gollum resume --json when the user asks to continue Gollum work or enters a
  Gollum-managed project. Does not create plans or start other workflows.
---

# Gollum bootstrap

For a Gollum continuation request, start with:

```bash
gollum resume --json
```

If the project's CLAUDE.md / AGENTS.md supplies a specific Node + CLI path, use
that runtime in place of `gollum` for every command. Do not silently use an older
installation.

The command resolves `.gollum/project.yaml` upward from cwd and reads the local
SQLite store. The binding file contains identity, not tasks. Do not search for
checkpoint files or use chat memory / spec-workflow as substitutes for the store.

Read `decision`, existing Goal/Outcome/Task IDs, `criteria.latest_evidence`, and
task `summary`, `observation`, `next_action`, lease and wake time. State the task
ID and next action before implementation so the user can verify the handoff.

| decision.action | Behavior |
|---|---|
| complete / no_work | Report that no unfinished Gollum work exists and stop. |
| resume | Inspect actual files, then continue only the listed existing tasks. |
| reverify | Run the specified outcomes' existing Criterion verifiers; save evidence. |
| wait | Respect the live lease, wake time or quota. Do not duplicate the task. |
| needs_attention | Explain blocked/failed/inconsistent state; do not invent new work. |

If loading fails, report the exact error. A missing binding is not permission to
create another plan; initialize only if the user requests it. Never claim that
state was loaded when no CLI output was obtained.

## Workflow boundary

A plugin's `requirements-needed` response or an empty `.spec-workflow/specs/`
directory does not define remaining Gollum work. Use another workflow only when
explicitly requested by the user or required by an existing Gollum task. Available
tools do not grant permission to add requirements, specs, approvals or tasks.

Bootstrap is read-only: it does not checkpoint, release leases, create tasks,
change goals or install unrelated project tooling. After loading state, use the
Gollum task resume skill when execution is needed.
