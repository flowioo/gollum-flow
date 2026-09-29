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
# from a local tarball (verified path)
git clone <this repo> && cd gollum
npm install && npm run build
npm pack --pack-destination /tmp
npm install -g /tmp/gollum-flow-0.2.0.tgz
```

`postinstall` will:
- create `~/.gollum/{skills,tools,runtime/{leases,events,scheduler}}` and `registry.yaml`
- detect installed agents (claude-code, codex, cursor, mavis)
- symlink the bundled skills into each detected agent's skills directory

## Verify the install

```bash
gollum doctor            # node version, ~/.gollum layout, store, agents, skills, projects
gollum install-skills    # re-link skills (idempotent)
gollum install-skills --agent claude-code
```

`gollum doctor` should end with `all checks passed`.

## Daily use

```bash
cd ~/code/my-project
gollum init               # create project + prompt for a goal
claude                    # or codex / mavis / cursor
```

The host picks up the `gollum-bootstrap` skill, resolves the current project, and
loads Goal / Outcome / Task into context.

## Skills

Seven skills ship inside the npm package at `dist/skills/core/`, each with YAML
frontmatter so hosts can discover them:

| Directory | `name:` |
|---|---|
| `bootstrap` | `gollum-bootstrap` |
| `task-run` | `gollum-task-run` |
| `task-resume` | `gollum-task-run-resume` |
| `verify` | `gollum-verify` |
| `recover` | `gollum-recover` |
| `outcome-evaluate` | `gollum-outcome-evaluate` |
| `goal-align` | `gollum-goal-align` |

The directory name is short on purpose; the `name:` field carries the `gollum-`
prefix to avoid collisions. `gollum install-skills` links by **directory name**.

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
gollum goal list
gollum outcome list --active
gollum task list
gollum evidence list
gollum scheduler tick
gollum goal-align <task_id>
gollum recover <task_id>
```

## Development

```bash
npm run typecheck
npm test                      # 77 unit tests
npm run build
bash tests/_v02_install_e2e.sh            # install E2E (isolated HOME, includes Claude)
GOLLUM_E2E_SKIP_CLAUDE=1 bash tests/_v02_install_e2e.sh   # skip the Claude step
```

`tests/_v02_install_e2e.sh` packs a tarball, installs it into an isolated prefix
with an isolated `HOME`, audits that all seven skill symlinks resolve inside the
tarball install (not the dev tree), runs `gollum doctor`, and — unless skipped —
has Claude Code read the installed `SKILL.md`.

## Known gaps (v0.2)

- Not published to npm
- `npx skills add` integration not implemented
- `templates/AGENTS.md` not implemented
- Task `shape` (ship/scout) field not implemented
- bash watcher / scheduler wake events not implemented
- `gollum memory.read/write` not implemented
- Project switch protocol (checkpoint + lease release on directory change) not implemented

See `docs/PRD-v0.2.md` §5 for the shipped/not-implemented breakdown.

## License

MIT
