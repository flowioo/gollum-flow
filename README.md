# gollum-flow

Persistent project state for long-running coding agents.

Gollum is a state layer, not an agent framework. It keeps **Goal → Outcome → Task →
Evidence → Checkpoint** in a durable store so a coding agent (Codex, Claude Code,
Mavis, Cursor…) can be killed and restarted without losing why it was working, where
it got to, or what to do next.

> Status: v0.2. Not yet published to the npm registry — install from a local tarball
> (see below). The `npx skills add` route is **not implemented**; see "Skills" below.

## Install

```bash
# from source (npm install runs `prepare`, which builds dist)
git clone <this repo>
cd gollum
npm install

# or install the packed tarball
npm pack --pack-destination /tmp
npm install -g /tmp/gollum-flow-0.2.0.tgz
```

`postinstall` will:
- create `~/.gollum/{skills,tools,runtime/{leases,events,scheduler}}` and `registry.yaml`
- detect installed agents (claude-code, codex, cursor, mavis)
- symlink the bundled skills into each detected agent's skills directory

## Verify the install

```bash
gollum doctor            # node version, ~/.gollum layout, store, agents, skills, slash commands, projects
gollum install-skills    # re-link skills (idempotent)
gollum install-skills --agent claude-code
```

`gollum doctor` should end with `all checks passed`. It runs seven check groups:
Node version, `~/.gollum` layout, store connectivity, detected agents, skill
links, slash commands, and registered projects. A *partial* link set is an error,
not a warning — a silently half-installed bundle is the failure mode this is
built to catch.

## Daily use

```bash
cd ~/code/my-project
gollum init               # create/reuse a Project + write .gollum/project.yaml
claude                    # or codex / mavis / cursor
```

`gollum init` is what binds a directory to the state layer. It finds a Project
with the same name and reuses it, or creates one, then writes
`.gollum/project.yaml` in the current directory:

```bash
gollum init                          # project name = directory name
gollum init -n my-project            # explicit name
gollum init --cwd ~/code/other-repo  # bind a directory you are not standing in
gollum init --force                  # rebind over an existing project.yaml
```

Re-running is safe: an already-bound directory reports `Already bound` and
changes nothing. `gollum project` has **no delete command**, which is why `init`
reuses an existing Project by name instead of creating a second one.

> `.gollum/project.yaml` is named `.yaml` but is parsed with `JSON.parse` —
> write it as JSON. Plain YAML fails silently: the resolver just returns
> `project_id: null` with no error. Add `.gollum/` to `.gitignore`, since the
> Project ID inside is a row ID in your local SQLite.

Inside Claude Code, `/gollum:init` wraps the same flow (installed to
`~/.claude/commands/gollum/init.md`):

```text
/gollum:init                    # bind the current directory
/gollum:init my-project         # …under a specific project name
```

Then just talk to the host — no commands to memorise:

```text
用 gollum 记一下：把登录测试的偶发失败查清楚      → gollum-plan  skill 建 Goal/Outcome/Task
继续 gollum 的活儿                              → gollum-task-resume / gollum-task-run
这个 task 做完了，验证一下                       → gollum-verify skill 写 evidence
看看这个 outcome 还差什么                       → gollum-outcome-evaluate
这个 task 好像跑偏了                             → gollum-goal-align
刚才失败了，帮我恢复                             → gollum-recover
```

Skills are read when the host starts, so **restart Claude Code / Codex after
installing** before the first `gollum` request.

Everything the skills do is plain `gollum` CLI, so you can always bypass the
host and drive it yourself:

```bash
gollum goal create -p "$PROJECT_ID" -t "标题" -d "背景"   # → GOAL_ID
gollum outcome create -g "$GOAL_ID" -t "结果"              # → OUTCOME_ID
gollum criterion create -o "$OUTCOME_ID" -d "可验证的条件" \
  --verifier-type command --verifier-config '{"command":"npm test"}'
gollum task create -o "$OUTCOME_ID" -t "一个最小动作" \
  --acceptance "验收条件" --estimated-minutes 25           # → TASK_ID

gollum scheduler pick                    # 挑下一个该做的 task
gollum task claim "$TASK_ID" -o me       # PENDING → RUNNING（带 lease）
gollum task checkpoint "$TASK_ID" -s "进展摘要" -o "观察" --next-action "下一步"
gollum task complete "$TASK_ID" -s "结果" # RUNNING → DONE
gollum evidence create -c "$CRITERION_ID" --status PASS --executor me --data '{}'
gollum goal list --tree                  # Goal → Outcome → Task 全树
```

Two rules the state machine enforces, so you cannot skip them: a `Task` must
hang off an `Outcome` (`task create` requires `--outcome-id`), and a task cannot
go `PENDING → DONE` directly — you must `claim` it first.

## Skills

Eight core skills plus a GitHub issue workflow ship inside the npm package at `dist/skills/core/`, each with YAML
frontmatter so hosts can discover them:

| Directory | `name:` | what it is for |
|---|---|---|
| `bootstrap` | `gollum-bootstrap` | host startup: resolve project, load state into context |
| `plan` | `gollum-plan` | turn one sentence into Goal → Outcome → Task |
| `task-run` | `gollum-task-run` | run a task start to finish |
| `task-resume` | `gollum-task-run-resume` | pick up an interrupted task |
| `verify` | `gollum-verify` | attach evidence, drive the outcome to VERIFIED |
| `recover` | `gollum-recover` | recover a failed task |
| `outcome-evaluate` | `gollum-outcome-evaluate` | report remaining gap on an outcome |
| `goal-align` | `gollum-goal-align` | detect scope creep on a task |
| `fix-issue` | `gollum-fix-issue` | search a GitHub issue → fix → verify → open a **draft** PR |

Every command and flag these skills name is checked against the real CLI by
`tests/skills-contract.test.ts`, which also covers this README.

## Fix a GitHub issue from one sentence

```text
修一下 github issue cli/cli#11014
找个 typo 的 good-first-issue 修一下
```

The `gollum-fix-issue` skill runs the whole loop: search issues across GitHub →
score how clear the issue actually is → **show you the plan and wait for
confirmation** → reproduce the bug on a branch → implement → run the real
verification command → attach evidence → push to a fork → open a **draft** PR →
stop and report.

Two gates make it safe to run unattended:

- **Nothing is written to the store before you confirm.** `gollum goal` has
  create/list/show and no `delete`, so a Goal created without asking is
  permanent. The agent shows the Goal / Outcome / Criterion / Task plan and
  waits.
- **Clarity is scored before work starts.** Five dimensions (reproduction,
  expected-vs-actual, location hints, acceptance criteria, scope), 0–5. At 4–5
  it proceeds to the confirmation gate; at 2–3 it must ask; at 0–1 it stops
  rather than guessing a direction into the state layer.

If you don't answer in time it does not stall and does not guess: it runs a
read-only exploration, and if that cannot pin the root cause it reverts
(`git reset --hard` to baseline), marks the task FAILED, and says so.

It never opens a ready-for-review PR on its own, and never opens one without
having actually run the verification.

```bash
gollum github auth                      # which credential will be used
gollum github search "flaky test" --limit 10
gollum github search "typo" --label good-first-issue
gollum github issue cli/cli 11014       # full issue body
gollum github repo                      # owner/repo of the current checkout
```

Auth resolves in order: `GITHUB_TOKEN` → `GH_TOKEN` → `gh auth token` (so a
machine that only ran `gh auth login` still works). Unauthenticated calls fall
back to read-only and get GitHub's 60/hour anonymous limit.

`npx skills add <github-repo>` is **not** used — it requires a GitHub repo as the
skill source, while these skills ship in the npm tarball.

## Shell hook (optional, manual)

```bash
# zsh
precmd() { gollum-resolver notify-cwd "$PWD" >/dev/null; }

# bash
PROMPT_COMMAND="gollum-resolver notify-cwd \"\$PWD\" >/dev/null; $PROMPT_COMMAND"
```

## State layer

State lives in SQLite (`~/.local/share/gollum/gollum.db`, WAL, version-based CAS),
**not** in per-project YAML directories. `~/.gollum/` holds only non-state files
(skills, tools, runtime, registry.yaml).

```bash
gollum goal list --tree
gollum outcome list -g "$GOAL_ID"
gollum task list -o "$OUTCOME_ID"
gollum evidence list -c "$CRITERION_ID"
gollum scheduler tick
gollum goal-align <task_id>
gollum recover <task_id>
```

## Development

```bash
npm run typecheck
npm run lint
npm test                      # 171 tests
npm run build
bash tests/_v02_install_e2e.sh            # install E2E (isolated HOME, includes Claude)
GOLLUM_E2E_SKIP_CLAUDE=1 bash tests/_v02_install_e2e.sh   # skip the Claude step
```

`tests/_v02_install_e2e.sh` packs a tarball, installs it into an isolated prefix
with an isolated `HOME`, asserts the three `bin` entries are executable and
`.bin/gollum` runs as a command, audits that all eight skill symlinks resolve
inside the tarball install (not the dev tree), runs `gollum doctor`, and —
unless skipped — has Claude Code read the installed `SKILL.md`.

## Known gaps (v0.2)

- Not published to npm
- `npx skills add` integration not implemented
- `templates/AGENTS.md` not implemented
- Task `shape` (ship/scout) field not implemented
- bash watcher / scheduler wake events not implemented
- `gollum memory.read/write` not implemented
- Project switch protocol (checkpoint + lease release on directory change) not implemented

See `docs/PRD-v0.2.md` §5 for the shipped/not-implemented breakdown.

## Contributing

`npm run lint && npm run typecheck && npm test` is the full local gate; CI runs
the same three on Node 18/20/22 plus a `npm pack` assertion that the nine skills,
the slash-command bundle and the three `bin` entries actually ship. A PR that
says "verified" without pasting the real command output is not verified — the
state layer's whole premise is *no evidence, not verified*.

State-layer changes (a status transition, a migration, a CAS/lease rule) need
evidence attached the same way `gollum verify` requires it: name the command,
paste the result.

## License

[MIT](./LICENSE) © 2026 flowioo
