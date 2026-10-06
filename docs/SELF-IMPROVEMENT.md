# Autonomous improvement experiments

`gollum improve` runs a bounded sequence of code improvement experiments. It uses
Claude Code to discover a concrete defect, implement a fix, and independently
review the result. The controller runs the tests and decides whether to retain
the change. The generic `supervisor` command still monitors tasks; it does not
dispatch these experiments.

## Configure and run

Create a JSON file outside the repository being improved. Paths in `repo` are
resolved relative to that configuration file. Example for a Node/TypeScript
repository with installed dependencies:

```json
{
  "repo": "/absolute/path/to/repository",
  "objective": "Find and fix a concrete input-validation defect while preserving valid behavior",
  "checks": [
    { "argv": ["npm", "run", "build"], "timeout_ms": 120000 },
    { "argv": ["node", "--import", "tsx", "--test", "tests/existing.test.ts"] }
  ],
  "probe_command": ["node", "--import", "tsx", "--test", "{test}"],
  "test_directory": "tests",
  "allowed_paths": ["src"],
  "protected_paths": ["tests", "package.json", "package-lock.json", "tsconfig.json"],
  "dependency_dirs": ["node_modules"],
  "host": { "kind": "claude", "executable": "claude", "args": [] },
  "max_iterations": 3,
  "max_failures": 3,
  "max_duration_ms": 1800000,
  "call_timeout_ms": 300000,
  "max_cost_usd": 3,
  "cost_per_call_usd": 0.5,
  "cooldown_ms": 60000,
  "apply": false
}
```

Check commands use argv, not shell syntax: globs, pipes and environment assignment
are not expanded. Use explicit filenames or a configured script. The host must
already be installed and authenticated. Claude must support `--restricted` and
structured JSON output. No login or purchase is performed by Gollum.
The adapter inherits only allowlisted provider/authentication/model variables from
the user's Claude settings, with existing process environment taking precedence;
it does not load settings hooks or project plugins. Secrets are passed in the
child environment, not command arguments or the run configuration.

```bash
gollum improve start --config /absolute/path/improve.json
gollum improve start --config /absolute/path/improve.json --detach
gollum improve status RUN_ID
gollum improve stop RUN_ID
gollum improve resume RUN_ID
```

`start` supervises a controller in the foreground and prints its run ID immediately.
`--detach` starts that supervisor in the background and prints its PID/log path.
SIGINT/SIGTERM
requests cancellation. `stop` records a request that the controller checks at
least once per second while asynchronous commands are running. `resume` continues
a nonterminal run after its previous lease expires; it does not reset budgets or
restart a terminal run. The run supervisor restarts a crashed or unresponsive
controller up to three times, preserving its restart count, deadline and cost
budget. Watcher leases prevent two supervisors from owning the same run. If the
supervisor itself or the machine dies, use `resume` (or an OS service manager) to
restart it after its lease expires.

The default workspace root is beside the configured SQLite database under
`improvements/`; override with `--runs-dir`, outside the source repository.
`GOLLUM_DB_PATH` can select an isolated database for experiments. Keep that database
and workspace together for recovery. Logs are capped per subprocess; accumulated
run directories are currently retained until explicitly removed.

## Acceptance and learning

### Local, offline host

The bundled `dist/autonomy/local-host.js` adapter can use an installed llama.cpp
CLI and an existing GGUF model through the same experiment protocol. It does not
download weights or contact a model API. For example, replace `host` in the run
configuration with:

```json
{
  "kind": "command",
  "executable": "node",
  "args": [
    "/absolute/path/to/gollum/dist/autonomy/local-host.js",
    "--model", "/absolute/path/to/model.gguf",
    "--executable", "/absolute/path/to/llama-cli",
    "--timeout-ms", "240000",
    "--files", "src/autonomy/config.ts"
  ]
}
```

The exact files listed in `--files` are the model's source context and its only
permitted replacement targets. Keep them inside the run's `allowed_paths`. Set
`call_timeout_ms` above the local inference timeout. Discovery still returns a new
test; implementation returns complete file replacements; review uses a fresh
inference. All existing acceptance gates remain in the controller.

The adapter uses `--offline`, CPU inference with four threads, a local weight path,
a bounded context/output size, and a temporary working directory. It strips cloud
credentials and remote-server environment overrides from the inference process.
Local calls report zero API cost; wall time and iteration budgets still apply.
Model quality and CPU inference time vary, so a small local model may produce
rejected experiments rather than useful improvements.

One available Apache-2.0 option is the official
[Qwen2.5-Coder-1.5B-Instruct-GGUF](https://huggingface.co/Qwen/Qwen2.5-Coder-1.5B-Instruct-GGUF).
The official [Q8 weight artifact](https://huggingface.co/Qwen/Qwen2.5-Coder-1.5B-Instruct-GGUF/blob/main/qwen2.5-coder-1.5b-instruct-q8_0.gguf)
is approximately 1.89 GB and lists SHA256
`507de59046601282ba768a9789900e6ccf60ed93ddf346730b7c68eb0715bc47`.
Verify downloaded weights before use. Gollum does not bundle model weights.

### Experiment stages

Each run snapshots tracked and nonignored new files, including uncommitted work.
Dependencies are private copies. Source symlinks are rejected. Each experiment
uses a separate Git repository and follows these stages:

1. Run the fixed checks on the initial snapshot. A failing baseline stops the run.
2. Ask the host for one hypothesis, concrete implementation paths and a new test.
3. Run the new test on the baseline. Require a normal, nonzero exit.
4. Ask the implementation host to fix the code without changing tests or policy.
5. Compare file contents and modes with the accepted baseline; reject changes
   outside the proposed paths or changes to protected files/the new test.
6. Require the new test and all fixed checks to pass. Reject source changes caused
   by those verification commands.
7. Ask a fresh host invocation to review correctness and test relevance, including
   whether the baseline failure was merely a syntax/import/environment error.
8. Recheck the candidate digest, reconstruct a clean retained Git commit, rebuild
   and rerun the probe and all checks there, then use that accepted code as the
   next experiment's baseline. Candidate-only ignored files cannot supply the proof.

The next discovery receives prior accepted/rejected hypotheses and reasons. Tests,
outputs, cost, review, workspace paths and dispositions are persisted. A host's
claim of success cannot directly promote code. These experimental records live in
`improvement_runs` and `improvement_calls`; they are not yet mirrored into the
generic Goal/Outcome/Task graph.

With `apply:false`, accepted code remains in the run workspace. With `apply:true`,
the controller applies the verified diff to the original working tree. It preserves
unrelated edits and refuses application if affected source files changed since the
snapshot. It does not commit, reset, push, publish, create a PR, or deploy the user's
repository. Application is reconciled after a crash by comparing file contents;
an already-applied diff is not applied twice. Generated build output is not copied
back, so rebuild before launching an updated compiled CLI.

## Recovery and current limits

SQLite records each call reservation before spawning the host. Saved host results
are reused after restart. Interrupted calls are conservatively charged their full
reservation and their experiment is rejected. Lease generations reject stale
controller writes. Subprocess groups have deadlines, output caps and cancellation;
on POSIX the child launcher kills its group after detecting an orphaned controller.

Quota responses create a durable cooldown. Expiry permits another bounded host
attempt; it is not evidence that provider quota recovered. Budgets, cancellation,
too many failures or too many experiments stop the run. `completed` means the host
declined further experiments in this bounded run, not that an arbitrary objective
has been exhaustively proved.

Workspace isolation and Claude restricted tools are not an OS security sandbox.
Configured checks and test code execute with the controller's OS permissions.
Digest coverage excludes ignored dependencies/build outputs and external state.
Independent review is another model judgment; it supplements the actual command
evidence, not a mathematical correctness proof. Use a container or restricted OS
account when running untrusted repositories or tests.

The deterministic command-host tests cover the loop and failure behavior but do
not establish real-model effectiveness or 24-hour stability. Those require
separate live-host evidence and soak/fault-injection runs.

## Local fault-injection verification

```bash
npm test
# Focused POSIX controller-death and recovery exercises (build first):
node --import tsx --test --test-name-pattern='SIGKILL of' tests/autonomy-process.test.ts
node --import tsx --test --test-name-pattern='killed controller recovers' tests/autonomy-runner.test.ts
```

These tests start real subprocesses. One kills the controller while its editing
host is writing and verifies that those writes stop. The other kills a controller
after a partial implementation, then starts the public supervisor. It observes
the original 30-second lease before takeover, verifies that the interrupted call's
reservation is charged once, rejects the incomplete experiment, and completes a
new experiment in a different candidate workspace. The original repository remains
unchanged. Both use a deterministic host fixture; they verify process/state recovery,
not model judgment or successful live self-improvement.
