---
name: gollum-bootstrap
description: |
  Bootstrap Gollum context on Host startup or directory change. Use when
  the user opens the project for the first time, switches directories, or
  asks "continue this project". Calls gollum-resolver, loads Goal/Outcome/
  Task from ~/.gollum/<project>/, and injects a compact context block.
  Also creates .gollum/project.yaml on `gollum init`.
---

# gollum-bootstrap

## When to Use

- Host (Codex / Claude Code / Mavis) just started in a project directory
- User runs `cd` into a different project
- User says: "继续这个项目" / "continue this project" / "where were we"
- User runs `gollum init` for the first time

## Inputs

- `$PWD` (current working directory)

## Procedure

1. **Run resolver** to discover the project:
   ```bash
   gollum-resolver notify-cwd "$PWD"
   ```
   Returns `{ project_id, source, repo_root }` or `{ project_id: null }` for unmanaged directories.

2. **If the current Project has unfinished work** (a task in RUNNING/RECOVERING
   whose lease is stale):
   a. Record where you stopped so a later session can pick it up:
      ```bash
      gollum task checkpoint <task_id> -s "切换前状态"
      ```
   b. Hand the lease back:
      ```bash
      gollum task wait <task_id>
      ```

3. **Load project state**:
   ```bash
   gollum goal list --tree          # 全树，一眼看清 Goal→Outcome→Task
   gollum task list --status RUNNING
   gollum task list --status RECOVERING
   gollum evidence list
   ```

4. **Inject compact context** (do NOT inline in user-visible chat):
   ```
   [Gollum] Project: <name> (<id>)
   [Gollum] Goal: <title>
   [Gollum] Active Outcome: <id> <title>
   [Gollum] Current Task: <id> <title>
   [Gollum] Last Evidence: <id> <verifier> <result>
   [Gollum] Mode: managed | aware
   ```

5. **Select mode**:
   - `managed` if there's an active `PENDING` or `RUNNING` task
   - `aware` otherwise (just discussion / exploration)

## First time in a directory

If there is no Gollum state yet and the user wants to start tracking work here:

```bash
gollum init          # 建默认 project + 跑 migration
gollum project list   # 拿 project_id
```

`gollum init` takes no arguments — it creates the default project. Then use
`gollum-plan` to turn what the user said into Goal / Outcome / Task.

## Outputs

- Compact context block in Host memory
- Mode selected (managed / aware / unmanaged)
- For unmanaged directories: a clear message that this is a scratch / non-Gollum directory and no Store writes are allowed

## Anti-Patterns

- ❌ Do NOT skip the resolver and read `~/.gollum/` directly — you'll get the wrong project's state on Project Switch.
- ❌ Do NOT inline the Goal in the user-visible chat — only put it in Context.
- ❌ Do NOT write to the Store from `unmanaged` mode (no project found).
- ❌ Do NOT auto-modify the Goal (requires explicit user ack).
- ❌ Do NOT claim a task that already has a non-expired lease held by another session.

## Recovery

If bootstrap fails (e.g., store is locked, schema drift, missing migration):
1. Run `gollum doctor` for diagnostics.
2. If schema drift: run migrations (built into `gollum init` if missing).
3. If lock persists: wait 30s (lease timeout) and retry.