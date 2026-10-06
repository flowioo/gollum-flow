---
name: gollum-task-run-resume
description: |
  Continue existing Gollum work across sessions or crashes from SQLite state and
  checkpoints. Use for "continue Gollum" or interrupted tasks; stop if the stored
  plan is complete. Do not replace recovery with a new spec or plan.
---

# Resume existing Gollum work

## Load before acting

```bash
gollum resume --json
```

Use the runtime path in the project's CLAUDE.md / AGENTS.md if one is specified.
Do not search for checkpoint files: checkpoints are persisted task fields in SQLite.

Read `decision` first. `complete` / `no_work` means report no unfinished work and
stop; `wait` means respect lease, wake time or quota; `needs_attention` means
report the blocker, not manufacture a new task. `reverify` means use the listed
existing criteria without creating implementation work.

For `resume`, choose an existing ID from `decision.task_ids`, read its goal,
acceptance criteria, checkpoint (`summary`, `observation`, `next_action`) and
lease. Report that ID and the planned continuation, then inspect the actual files.

```bash
gollum task show "$TASK_ID"
```

## Reclaim and continue

Never override a valid lease. For an expired RUNNING / VERIFYING / RECOVERING
lease, release only the chosen task, then re-read it (the retry budget may block it):

```bash
gollum scheduler release-expired --task-id "$TASK_ID"
gollum task show "$TASK_ID"
```

For an eligible PENDING task or a due WAITING task, claim with a fresh session owner:

```bash
gollum task claim "$TASK_ID" -o "new-session" --fenced
```

Keep the returned token as `LEASE_TOKEN`; use it on subsequent mutations. Inspect
existing work before editing; don't repeat implementation merely because the
conversation is new. For long-running work refresh the lease before it expires:

```bash
gollum heartbeat ping "$TASK_ID" --lease-token "$LEASE_TOKEN"
gollum task checkpoint "$TASK_ID" -s "实际进展" --next-action "剩余动作" --lease-token "$LEASE_TOKEN"
```

Use the existing Criterion ID and configured verifier so a test run persists evidence:

```bash
gollum verify criterion "$CRITERION_ID"
```

Read the result and effective remaining gap before marking completion. On success:

```bash
gollum task complete "$TASK_ID" -s "已运行验收并保存证据" --lease-token "$LEASE_TOKEN"
gollum outcome mark-verified "$OUTCOME_ID"
```

On failure, checkpoint what was observed and use bounded recovery with the actual
failure result. Do not mark a task FAILED and then try to recover that terminal
state. Do not restart DONE tasks or weaken criteria just to achieve the goal.

## Stay in scope

Do not create Requirements / Design / Tasks documents, invoke spec-workflow, or
initialize another workflow merely because its directories or tools exist. Those
steps require an explicit user request or an existing Gollum task that calls for
them. Tool output from a different workflow cannot redefine Gollum's remaining work.
