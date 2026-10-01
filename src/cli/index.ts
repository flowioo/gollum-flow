#!/usr/bin/env node
/**
 * Gollum CLI — entry point (DESIGN §11)
 */

import { Command } from 'commander';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { basename, dirname, join, resolve as resolvePath } from 'node:path';
import { getStore, resetStore, resolveDefaultDbPath } from '../workflow/store/store.js';
import {
  projectCreate,
  projectList,
  projectFindByName,
  goalCreate,
  goalList,
  goalGet,
} from '../core/goal.js';
import {
  outcomeCreate,
  outcomeListActive,
  outcomeGet,
  outcomeRemainingGap,
  outcomeMarkVerified,
} from '../core/outcome.js';
import {
  criterionCreate,
  criterionList,
} from '../core/criterion.js';
import {
  taskCreate,
  taskGet,
  taskClaim,
  taskCheckpoint,
  taskComplete,
  taskFail,
  taskWait,
  taskBlock,
} from '../core/task.js';
import { evidenceCreate, evidenceList } from '../core/evidence.js';
import { validatePlan, type PlannedGoal } from '../workflow/planner.js';
import { schedulerCommand } from './commands/scheduler.js';
import { supervisorCommand } from './commands/supervisor.js';
import { quotaCommand } from './commands/quota.js';
import { heartbeatCommand } from './commands/heartbeat.js';
import { verifyByCriterion, verifyCommand, verifyGit } from '../core/verify.js';
import { applyRecovery } from '../core/recover.js';
import { goalAlign, handleMisaligned, handleUncertain } from '../core/goal-align.js';
import {
  githubSearchIssues,
  githubGetIssue,
  githubCreatePrCompare,
  githubForkRepo,
  githubDetectLocalRepo,
  ghTokenSource,
} from '../core/github.js';
import { installCodex } from '../adapters/codex/installer.js';
import { installClaude } from '../adapters/claude-code/installer.js';
import type { Outcome, Task } from '../workflow/model/types.js';

// Read the version from package.json instead of hardcoding it — a hardcoded
// string shipped 0.1.0 well after the package moved to 0.2.0. Resolved relative
// to this file so it works from dist/ (installed) and from src/ (tsx dev).
function readVersion(): string {
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    const pkg = JSON.parse(readFileSync(join(here, '..', '..', 'package.json'), 'utf-8'));
    return pkg.version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}

const program = new Command();
program
  .name('gollum')
  .description('Portable workflow, skills and tools for reliable long-running coding agents')
  .version(readVersion());

// =============================================================================
// init
// =============================================================================
program
  .command('init')
  .description('Initialize gollum in a directory: create/reuse a Project and write .gollum/project.yaml')
  .option('-n, --name <name>', 'Project name (default: the directory name)')
  .option('-d, --description <desc>', 'Project description')
  .option('--cwd <dir>', 'Target directory (default: current directory)')
  .option('--force', 'Overwrite an existing .gollum/project.yaml', false)
  .action(async (opts) => {
    const store = getStore();
    const targetDir = resolvePath(opts.cwd ?? process.cwd());
    const gollumDir = join(targetDir, '.gollum');
    const yamlPath = join(gollumDir, 'project.yaml');

    // Idempotency: an existing binding is reused as-is. `gollum project` has no
    // delete, so a second `init` must not create a second project row.
    if (existsSync(yamlPath) && !opts.force) {
      const existing = readFileSync(yamlPath, 'utf-8');
      let projectId = '(unreadable)';
      try {
        projectId = (JSON.parse(existing) as { project_id?: string }).project_id ?? '(missing project_id)';
      } catch {
        console.error(`✗ ${yamlPath} is not valid JSON — the resolver cannot read it.`);
        console.error('  Fix the file by hand, or re-run with --force to overwrite it.');
        process.exitCode = 1;
        return;
      }
      console.log(`✓ Already bound — ${yamlPath}`);
      console.log(`  Project ID: ${projectId}`);
      console.log('  Nothing changed. Re-run with --force to rebind to a different project.');
      return;
    }

    const name = opts.name ?? basename(targetDir);
    const existingProject = projectFindByName(store, name);
    const project = existingProject
      ?? projectCreate(store, { name, description: opts.description ?? `gollum workspace at ${targetDir}` });

    // The file is named .yaml but the resolver parses it with JSON.parse
    // (src/workflow/resolver.ts) — plain YAML fails silently, so write JSON.
    mkdirSync(gollumDir, { recursive: true });
    writeFileSync(
      yamlPath,
      JSON.stringify({ project_id: project.id, name: project.name }, null, 2) + '\n',
      'utf-8',
    );

    console.log(`✓ Gollum initialized`);
    console.log(`  Project: ${project.name} (${project.id})${existingProject ? '  [reused]' : ''}`);
    console.log(`  Bound:   ${yamlPath}`);
    console.log(`  DB:      ${resolveDefaultDbPath()}`);
    if (existsSync(join(targetDir, '.git'))) {
      console.log(`  Note:    ${join(targetDir, '.gollum', 'project.yaml')} holds a machine-local Project ID — add .gollum/ to .gitignore.`);
    }
  });

// =============================================================================
// project
// =============================================================================
const project = program.command('project').description('Manage projects');
project
  .command('create')
  .description('Create a new project')
  .requiredOption('-n, --name <name>', 'Project name')
  .option('-d, --description <desc>', 'Description')
  .action((opts) => {
    const store = getStore();
    const p = projectCreate(store, { name: opts.name, description: opts.description });
    console.log(`✓ Project created: ${p.id}`);
  });
project
  .command('list')
  .description('List all projects')
  .action(() => {
    const store = getStore();
    const list = projectList(store);
    console.table(list.map((p) => ({ id: p.id, name: p.name })));
  });

// =============================================================================
// goal
// =============================================================================
const goal = program.command('goal').description('Manage goals');
goal
  .command('create')
  .description('Create a new goal')
  .requiredOption('-p, --project-id <id>', 'Project ID')
  .requiredOption('-t, --title <title>', 'Goal title')
  .option('-d, --description <desc>', 'Description')
  .action((opts) => {
    const store = getStore();
    const g = goalCreate(store, {
      project_id: opts.projectId,
      title: opts.title,
      description: opts.description,
    });
    console.log(`✓ Goal created: ${g.id}`);
    console.log(JSON.stringify(g, null, 2));
  });
goal
  .command('list')
  .description('List goals (pass --tree for goal → outcome → task + criterion gap)')
  .option('-p, --project-id <id>', 'Filter by project (default: the project bound to cwd)')
  .option('--all', 'List goals across every project, ignoring the cwd binding')
  .option('--tree', 'Show goal → outcome → task + criterion gap')
  .action(async (opts) => {
    const store = getStore();
    // One DB serves every project, so an unfiltered list mixes unrelated repos'
    // task trees. Prefer the project bound to cwd; `--all` is the escape hatch.
    let projectId: string | undefined = opts.projectId;
    if (!projectId && !opts.all) {
      const { resolveProject } = await import('../workflow/resolver.js');
      projectId = (await resolveProject(process.cwd())).project_id ?? undefined;
    }
    const list = goalList(store, { project_id: projectId });
    if (!opts.projectId && !opts.all) {
      console.error(
        projectId
          ? `(scoped to project ${projectId} — pass --all to list every project)`
          : `(no project bound to cwd — pass --all to list every project)`,
      );
    }
    if (!opts.tree) {
      console.table(list.map((g) => ({ id: g.id, title: g.title, status: g.status })));
      return;
    }
    if (list.length === 0) {
      console.log('(no goals)');
      return;
    }
    for (const g of list) {
      const outcomes = store.list<Outcome>('outcomes', 'goal_id = ?', [g.id]);
      console.log(`● ${g.id}  ${g.title}  [${g.status}]`);
      if (outcomes.length === 0) {
        console.log('  └─ (no outcomes)');
        console.log('');
        continue;
      }
      for (let i = 0; i < outcomes.length; i++) {
        const o = outcomes[i]!;
        const isLastOutcome = i === outcomes.length - 1;
        const branch = isLastOutcome ? '└─' : '├─';
        const pad = isLastOutcome ? '   ' : '│  ';
        const gap = outcomeRemainingGap(store, o.id);
        console.log(
          `  ${branch} ${o.id}  ${o.title}  [${o.status}]  crit=${gap.pass}/${gap.total}`,
        );
        const tasks = store.list<Task>('tasks', 'outcome_id = ?', [o.id]);
        if (tasks.length === 0) {
          console.log(`  ${pad}  └─ (no tasks)`);
          continue;
        }
        for (let j = 0; j < tasks.length; j++) {
          const t = tasks[j]!;
          const tBranch = j === tasks.length - 1 ? '└─' : '├─';
          console.log(`  ${pad}  ${tBranch} ${t.id}  ${t.title}  [${t.status}]`);
        }
      }
      console.log('');
    }
  });
goal
  .command('show <goal_id>')
  .description('Show goal + outcomes')
  .action((id) => {
    const store = getStore();
    const { goal: g, outcomes } = goalGet(store, id);
    console.log(`Goal: ${g.title} [${g.status}]`);
    console.log(`  id: ${g.id}`);
    console.log(`  description: ${g.description ?? '-'}`);
    console.log(`  Outcomes:`);
    for (const o of outcomes) {
      const gap = outcomeRemainingGap(store, o.id);
      console.log(
        `    - [${o.status}] ${o.title} (${o.id})  remaining=${gap.remaining}/${gap.total}`,
      );
    }
  });

// =============================================================================
// outcome
// =============================================================================
const outcome = program.command('outcome').description('Manage outcomes');
outcome
  .command('create')
  .description('Create a new outcome')
  .requiredOption('-g, --goal-id <id>', 'Goal ID')
  .requiredOption('-t, --title <title>', 'Outcome title')
  .option('--priority <n>', 'Priority', (v) => parseInt(v, 10), 0)
  .action((opts) => {
    const store = getStore();
    const o = outcomeCreate(store, {
      goal_id: opts.goalId,
      title: opts.title,
      priority: opts.priority,
    });
    console.log(`✓ Outcome created: ${o.id}`);
  });
outcome
  .command('list')
  .description('List active outcomes')
  .option('-g, --goal-id <id>', 'Filter by goal')
  .action((opts) => {
    const store = getStore();
    const list = outcomeListActive(store, { goal_id: opts.goalId });
    console.table(list.map((o) => ({ id: o.id, title: o.title, status: o.status, priority: o.priority })));
  });
outcome
  .command('show <outcome_id>')
  .description('Show outcome + criteria')
  .action((id) => {
    const store = getStore();
    const { outcome: o, criteria } = outcomeGet(store, id);
    const gap = outcomeRemainingGap(store, id);
    console.log(`Outcome: ${o.title} [${o.status}]`);
    console.log(`  id: ${o.id}`);
    console.log(`  goal_id: ${o.goal_id}`);
    console.log(`  priority: ${o.priority}`);
    console.log(`  remaining_gap: ${JSON.stringify(gap)}`);
    console.log(`  Criteria:`);
    for (const c of criteria) {
      const verifierType = c.verifier?.type ?? 'UNVERIFIED';
      console.log(`    - [${c.derived_status}] ${c.description} (${c.id})  verifier=${verifierType}`);
    }
  });
outcome
  .command('remaining-gap <outcome_id>')
  .description('Show remaining gap (replaces progress)')
  .action((id) => {
    const store = getStore();
    const gap = outcomeRemainingGap(store, id);
    console.log(JSON.stringify(gap, null, 2));
  });
outcome
  .command('mark-verified <outcome_id>')
  .description('Mark outcome VERIFIED (requires all criteria PASS)')
  .action((id) => {
    const store = getStore();
    try {
      const o = outcomeMarkVerified(store, id);
      console.log(`✓ Outcome VERIFIED: ${o.id}`);
    } catch (e: any) {
      console.error(`✗ ${e.message}`);
      process.exit(1);
    }
  });

// =============================================================================
// criterion
// =============================================================================
const criterion = program.command('criterion').description('Manage criteria');
criterion
  .command('create')
  .description('Create a new criterion (criterion 三段式: verifier required)')
  .requiredOption('-o, --outcome-id <id>', 'Outcome ID')
  .requiredOption('-d, --description <desc>', 'Criterion description')
  .requiredOption('--verifier-type <type>', 'Verifier type: command|git|outcome_criterion|timer_check|human_assert')
  .option('--verifier-config <json>', 'Verifier config as JSON', '{}')
  .action((opts) => {
    const store = getStore();
    let config: Record<string, unknown>;
    try {
      config = JSON.parse(opts.verifierConfig);
    } catch {
      console.error(`✗ --verifier-config must be valid JSON`);
      process.exit(1);
    }
    try {
      const c = criterionCreate(store, {
        outcome_id: opts.outcomeId,
        description: opts.description,
        verifier: { type: opts.verifierType, config },
      });
      console.log(`✓ Criterion created: ${c.id}`);
      console.log(`  Note: status is UNVERIFIED until evidence attaches.`);
    } catch (e: any) {
      console.error(`✗ ${e.message}`);
      process.exit(1);
    }
  });
criterion
  .command('list')
  .description('List criteria for an outcome')
  .requiredOption('-o, --outcome-id <id>', 'Outcome ID')
  .action((opts) => {
    const store = getStore();
    const list = criterionList(store, opts.outcomeId);
    console.table(
      list.map((c) => ({
        id: c.id,
        description: c.description,
        derived_status: c.derived_status,
        verifier_type: c.verifier?.type ?? 'UNVERIFIED',
      })),
    );
  });

// =============================================================================
// task
// =============================================================================
const task = program.command('task').description('Manage tasks');
task
  .command('list')
  .description('List tasks (filter by --outcome / --status)')
  .option('-o, --outcome-id <id>', 'Filter by outcome ID')
  .option('-s, --status <status>', 'Filter by status (PENDING|RUNNING|WAITING|BLOCKED|VERIFYING|RECOVERING|DONE|FAILED)')
  .option('-l, --limit <n>', 'Limit', (v) => parseInt(v, 10), 50)
  .action((opts) => {
    const store = getStore();
    const conds: string[] = [];
    const params: unknown[] = [];
    if (opts.outcomeId) {
      conds.push('outcome_id = ?');
      params.push(opts.outcomeId);
    }
    if (opts.status) {
      conds.push('status = ?');
      params.push(opts.status);
    }
    const where = conds.length ? conds.join(' AND ') : '1';
    const rows = store.list<{ id: string; outcome_id: string; title: string; status: string; priority: number; retry_count: number; owner: string | null; lease_until: string | null }>(
      'tasks',
      `${where} ORDER BY priority DESC, created_at ASC LIMIT ?`,
      [...params, opts.limit],
    );
    if (rows.length === 0) {
      console.log('(no tasks match)');
      return;
    }
    console.table(
      rows.map((t) => ({
        id: t.id,
        status: t.status,
        priority: t.priority,
        retry: t.retry_count,
        owner: t.owner ?? '-',
        lease_until: t.lease_until ? t.lease_until.slice(11, 19) : '-',
        title: t.title.slice(0, 60),
      })),
    );
  });
task
  .command('create')
  .description('Create a new task (must belong to an outcome)')
  .requiredOption('-o, --outcome-id <id>', 'Outcome ID (强约束)')
  .requiredOption('-t, --title <title>', 'Task title')
  .option('--acceptance <criteria...>', 'Acceptance criteria (space-separated)')
  .option('--estimated-minutes <n>', 'Estimated minutes (Planner checks >30min)', (v) => parseInt(v, 10))
  .option('--priority <n>', 'Priority', (v) => parseInt(v, 10), 0)
  .action((opts) => {
    const store = getStore();
    try {
      const t = taskCreate(store, {
        outcome_id: opts.outcomeId,
        title: opts.title,
        acceptance_criteria: opts.acceptance ?? [],
        estimated_minutes: opts.estimatedMinutes,
        priority: opts.priority,
      });
      console.log(`✓ Task created: ${t.id}`);
      if (t.estimated_minutes && t.estimated_minutes > 30) {
        console.warn(
          `⚠ Estimated ${t.estimated_minutes}min > 30min. PRD §5.3 requires split.`,
        );
      }
    } catch (e: any) {
      console.error(`✗ ${e.message}`);
      process.exit(1);
    }
  });
task
  .command('show <task_id>')
  .description('Show task + outcome + goal')
  .action((id) => {
    const store = getStore();
    const { task: t, outcome, goal } = taskGet(store, id);
    console.log(`Task: ${t.title} [${t.status}]`);
    console.log(`  id: ${t.id}`);
    console.log(`  acceptance_criteria: ${JSON.stringify(t.acceptance_criteria)}`);
    console.log(`  owner: ${t.owner ?? '-'}`);
    console.log(`  lease_until: ${t.lease_until ?? '-'}`);
    console.log(`  retry_count: ${t.retry_count}`);
    console.log(`  estimated_minutes: ${t.estimated_minutes ?? '-'}`);
    console.log(`  Outcome: ${outcome.title} [${outcome.status}]`);
    console.log(`  Goal: ${goal.title} [${goal.status}]`);
  });
task
  .command('claim <task_id>')
  .description('Claim task with lease')
  .requiredOption('-o, --owner <owner>', 'Owner (e.g., codex/session-abc)')
  .action((id, opts) => {
    const store = getStore();
    try {
      const t = taskClaim(store, { task_id: id, owner: opts.owner });
      console.log(`✓ Task claimed: ${t.id}  status=${t.status}  lease_until=${t.lease_until}`);
    } catch (e: any) {
      console.error(`✗ ${e.message}`);
      process.exit(1);
    }
  });
task
  .command('checkpoint <task_id>')
  .description('Create semantic checkpoint')
  .requiredOption('-s, --summary <summary>', 'Summary')
  .option('-o, --observation <obs>', 'Last observation')
  .option('--next-action <action>', 'Next action hint')
  .option('--artifacts <refs...>', 'Artifact references (PRs, files, URLs)')
  .action((id, opts) => {
    const store = getStore();
    const t = taskCheckpoint(store, id, {
      summary: opts.summary,
      observation: opts.observation,
      next_action: opts.nextAction,
      artifacts: opts.artifacts,
    });
    console.log(`✓ Checkpoint created: ${t.id}`);
  });
task
  .command('complete <task_id>')
  .description('Mark task DONE')
  .option('-s, --summary <summary>', 'Final summary')
  .action((id, opts) => {
    const store = getStore();
    const t = taskComplete(store, id, opts.summary);
    console.log(`✓ Task DONE: ${t.id}`);
  });
task
  .command('fail <task_id>')
  .description('Mark task FAILED')
  .requiredOption('-r, --reason <reason>', 'Reason')
  .action((id, opts) => {
    const store = getStore();
    const t = taskFail(store, { task_id: id, reason: opts.reason });
    console.log(`✓ Task FAILED: ${t.id}`);
  });
task
  .command('wait <task_id>')
  .description('Mark task WAITING (release lease)')
  .requiredOption('--wake-at <iso>', 'Wake at (ISO8601)')
  .option('-r, --reason <reason>', 'Reason')
  .action((id, opts) => {
    const store = getStore();
    const t = taskWait(store, {
      task_id: id,
      wake_at: opts.wakeAt,
      reason: opts.reason,
    });
    console.log(`✓ Task WAITING: ${t.id}  wake_at=${t.wake_at}`);
  });
task
  .command('block <task_id>')
  .description('Mark task BLOCKED (need Human)')
  .requiredOption('-r, --reason <reason>', 'Reason')
  .action((id, opts) => {
    const store = getStore();
    const t = taskBlock(store, { task_id: id, reason: opts.reason });
    console.log(`✓ Task BLOCKED: ${t.id}`);
  });

// =============================================================================
// evidence
// =============================================================================
const evidence = program.command('evidence').description('Manage evidence');
evidence
  .command('create')
  .description('Create evidence and update criterion derived_status')
  .requiredOption('-c, --criterion-id <id>', 'Criterion ID')
  .requiredOption('--status <status>', 'PASS | FAIL | UNKNOWN')
  .option('--executor <executor>', 'Executor (e.g., codex/session-abc)')
  .option('--data <json>', 'Evidence data as JSON')
  .action((opts) => {
    const store = getStore();
    let data: Record<string, unknown> | undefined;
    if (opts.data) {
      try {
        data = JSON.parse(opts.data);
      } catch {
        console.error(`✗ --data must be valid JSON`);
        process.exit(1);
      }
    }
    const e = evidenceCreate(store, {
      criterion_id: opts.criterionId,
      status: opts.status,
      executor: opts.executor,
      data,
    });
    console.log(`✓ Evidence created: ${e.id}  status=${e.status}`);
  });
evidence
  .command('list')
  .description('List evidence for a criterion')
  .requiredOption('-c, --criterion-id <id>', 'Criterion ID')
  .action((opts) => {
    const store = getStore();
    const list = evidenceList(store, opts.criterionId);
    console.table(
      list.map((e) => ({
        id: e.id,
        status: e.status,
        executor: e.executor ?? '-',
        observed_at: e.observed_at,
      })),
    );
  });

// =============================================================================
// events
// =============================================================================
const events = program.command('events').description('Inspect workflow events');
events
  .command('list')
  .description('List recent events')
  .option('--task-id <id>', 'Filter by task')
  .option('--outcome-id <id>', 'Filter by outcome')
  .option('--limit <n>', 'Limit', (v) => parseInt(v, 10), 20)
  .action((opts) => {
    const store = getStore();
    const conds: string[] = [];
    const params: unknown[] = [];
    if (opts.taskId) {
      conds.push('task_id = ?');
      params.push(opts.taskId);
    }
    if (opts.outcomeId) {
      conds.push('outcome_id = ?');
      params.push(opts.outcomeId);
    }
    const where = conds.length ? conds.join(' AND ') : '1';
    const list = store
      .list<{ id: number; event: string; task_id: string | null; actor: string | null; timestamp: string }>(
        'events',
        `${where} ORDER BY id DESC LIMIT ?`,
        [...params, opts.limit],
      );
    console.table(list);
  });

// =============================================================================
// scheduler (sub-command group)
// =============================================================================
program.addCommand(schedulerCommand());

// =============================================================================
// supervisor (sub-command group) — 24/7 self-evolution layer
// =============================================================================
program.addCommand(supervisorCommand());

// =============================================================================
// quota (sub-command group) — API quota detection + 5hr recovery
// =============================================================================
program.addCommand(quotaCommand());

// =============================================================================
// heartbeat (sub-command group) — task + supervisor heartbeat watchdog
// =============================================================================
program.addCommand(heartbeatCommand());

// =============================================================================
// verify (sub-command group)
// =============================================================================

const verify = program.command('verify').description('Run verification tools');

verify
  .command('command')
  .description('Run a shell command verifier')
  .requiredOption('-c, --command <cmd>', 'Command to run')
  .option('--cwd <path>', 'Working directory')
  .option('--timeout <ms>', 'Timeout in ms', (v) => parseInt(v, 10), 30000)
  .option('--expect-exit <code>', 'Expected exit code', (v) => parseInt(v, 10), 0)
  .action(async (opts) => {
    const result = await verifyCommand({
      command: opts.command,
      cwd: opts.cwd,
      timeout: opts.timeout,
      expect: { exit_code: opts.expectExit },
    });
    console.log(JSON.stringify(result, null, 2));
    process.exit(result.ok ? 0 : 1);
  });

verify
  .command('git')
  .description('Run a git verifier')
  .requiredOption('-t, --type <type>', 'status | diff | log')
  .option('--repo <path>', 'Repo path')
  .option('--expect-clean', 'Expect clean status')
  .action(async (opts) => {
    const result = await verifyGit({
      type: opts.type,
      repo: opts.repo,
      expect: { clean: opts.expectClean },
    });
    console.log(JSON.stringify(result, null, 2));
    process.exit(result.ok ? 0 : 1);
  });

verify
  .command('criterion <criterion_id>')
  .description('Dispatch verifyByCriterion based on criterion.verifier.type')
  .action(async (id) => {
    const store = getStore();
    const result = await verifyByCriterion(store, id);
    console.log(JSON.stringify(result, null, 2));
    process.exit(result.ok ? 0 : 1);
  });

// =============================================================================
// recover
// =============================================================================

program
  .command('recover <task_id>')
  .description('Apply recover Skill to a Task after a failure')
  .requiredOption('--status <status>', 'Last verify status: PASS|FAIL|UNKNOWN')
  .option('--error-type <type>', 'Error type from ToolResult.error')
  .option('--observation <text>', 'Observation from last verify')
  .action(async (id, opts) => {
    const store = getStore();
    const { task } = taskGet(store, id);
    // Build a synthetic ToolResult from CLI input
    const result = {
      ok: opts.status === 'PASS',
      status: opts.status as 'PASS' | 'FAIL' | 'UNKNOWN',
      observation: opts.observation ?? '',
      evidence: {},
      error: opts.errorType
        ? { type: opts.errorType, message: opts.observation ?? '', retryable: false }
        : null,
    };
    const decision = applyRecovery(store, task, result);
    console.log(JSON.stringify(decision, null, 2));
    process.exit(decision.decision.action === 'block' ? 1 : 0);
  });

// =============================================================================
// goal-align
// =============================================================================

program
  .command('goal-align <task_id>')
  .description('Run goal-align Skill on a Task (returns aligned|uncertain|misaligned)')
  .option('--goal-description <desc>', 'Override Goal description')
  .action((id, opts) => {
    const store = getStore();
    const result = goalAlign(store, {
      task_id: id,
      goal_description: opts.goalDescription,
    });
    console.log(JSON.stringify(result, null, 2));
    process.exit(result.verdict === 'misaligned' ? 2 : 0);
  });

program
  .command('handle-misaligned <task_id>')
  .description('Apply misaligned handler (pause + rollback, NOT escalate to Human)')
  .requiredOption('-r, --reason <reason>', 'Misalignment reason')
  .action((id, opts) => {
    const store = getStore();
    const { task } = taskGet(store, id);
    const result = handleMisaligned(store, task, opts.reason);
    console.log(JSON.stringify(result, null, 2));
  });

// =============================================================================
// validate (Planner)
// =============================================================================
program
  .command('validate')
  .description('Validate a planned structure from JSON file')
  .requiredOption('--plan <file>', 'Plan JSON file')
  .action((opts) => {
    let plan: PlannedGoal;
    try {
      plan = JSON.parse(readFileSync(opts.plan, 'utf-8'));
    } catch (e: any) {
      console.error(`✗ Cannot read plan file: ${e.message}`);
      process.exit(1);
    }
    const result = validatePlan(plan);
    if (result.warnings.length === 0) {
      console.log(`✓ Plan valid (no warnings)`);
    } else {
      for (const w of result.warnings) {
        const marker = w.level === 'error' ? '✗' : '⚠';
        console.log(`${marker} [${w.level}][${w.scope}] ${w.ref ?? ''}: ${w.message}`);
      }
    }
    if (!result.ok) process.exit(1);
  });

// =============================================================================
// github (issue → fix → draft PR 的 GitHub 侧)
// =============================================================================
// These were MCP tools before the MCP layer was removed; they had no CLI entry
// point at all, so the "fix a GitHub issue" workflow had nowhere to start.
// Token resolution: GITHUB_TOKEN → GH_TOKEN → `gh auth token`.

const github = program
  .command('github')
  .description('GitHub operations used by the gollum-fix-issue skill');

github
  .command('auth')
  .description('Show which GitHub credential gollum will use')
  .action(() => {
    const source = ghTokenSource();
    const authenticated = source !== 'none';
    console.log(
      authenticated
        ? `✓ authenticated via ${source}`
        : '✗ no GitHub token (set GITHUB_TOKEN, or run `gh auth login`)',
    );
    if (!authenticated) {
      console.log('  Read-only GitHub calls will work but are rate-limited to 60/hour.');
    }
    if (!authenticated) process.exitCode = 1;
  });

github
  .command('search <query>')
  .description('Search issues across all of GitHub')
  .option('-l, --label <label...>', 'Filter by label(s)')
  .option('--language <lang>', 'Filter by repository language')
  .option('--state <state>', 'open | closed', 'open')
  .option('--sort <field>', 'updated | created | comments', 'updated')
  .option('--limit <n>', 'Max results (1-100)', '20')
  .option('--json', 'Print raw JSON instead of a table')
  .action(async (query: string, opts: {
    label?: string[]; language?: string; state?: string; sort?: string; limit?: string; json?: boolean;
  }) => {
    const res = await githubSearchIssues({
      query,
      labels: opts.label,
      language: opts.language,
      state: (opts.state === 'closed' ? 'closed' : 'open'),
      sort: (opts.sort === 'created' || opts.sort === 'comments' ? opts.sort : 'updated'),
      per_page: Math.min(Math.max(Number(opts.limit ?? 20) || 20, 1), 100),
    });
    if (!res.ok) {
      console.error(`✗ GitHub search failed: ${res.error}`);
      process.exit(1);
    }
    if (opts.json) {
      console.log(JSON.stringify(res, null, 2));
      return;
    }
    console.log(`found ${res.total_count} issue(s), showing ${res.issues.length}`);
    for (const i of res.issues) {
      const labels = i.labels.length ? ` [${i.labels.join(', ')}]` : '';
      console.log(`  ${i.owner}/${i.repo}#${i.number}  ${i.title}${labels}`);
      console.log(`      ${i.html_url}`);
    }
    if (res.rate_limit_remaining !== undefined) {
      console.log(`  rate limit remaining: ${res.rate_limit_remaining}`);
    }
  });

github
  .command('issue <repo> <number>')
  .description('Read a single issue, including its full body')
  .action(async (repoArg: string, numberArg: string) => {
    const [owner, repo] = String(repoArg).split('/');
    if (!owner || !repo) {
      console.error('✗ expected owner/repo, e.g. cli/cli');
      process.exit(1);
    }
    const res = await githubGetIssue({ owner, repo, issue_number: Number(numberArg) });
    if (!res.ok || !res.issue) {
      console.error(`✗ could not read issue: ${res.error}`);
      process.exit(1);
    }
    const i = res.issue;
    console.log(`#${i.number}  ${i.title}`);
    console.log(`state: ${i.state}   labels: ${i.labels.join(', ') || '(none)'}   assignee: ${i.assignee ?? '(none)'}`);
    console.log(`url:   ${i.html_url}`);
    console.log(`\n${i.body || '(empty body)'}`);
  });

github
  .command('fork <repo>')
  .description('Fork a repository (needs a token with repo scope)')
  .option('--org <org>', 'Fork into this organization')
  .action(async (repoArg: string, opts: { org?: string }) => {
    const [owner, repo] = String(repoArg).split('/');
    if (!owner || !repo) {
      console.error('✗ expected owner/repo, e.g. cli/cli');
      process.exit(1);
    }
    const res = await githubForkRepo({ owner, repo, org: opts.org });
    if (!res.ok || !res.fork_url) {
      console.error(`✗ fork failed: ${res.error}`);
      process.exit(1);
    }
    console.log(`✓ forked: ${res.fork_url}`);
  });

github
  .command('pr <repo>')
  .description('Open a pull request, or print a compare URL when unauthenticated')
  .requiredOption('-H, --head <head>', 'Branch ref, e.g. "myuser:fix/typo"')
  .requiredOption('-B, --base <base>', 'Base branch, e.g. "main"')
  .requiredOption('-t, --title <title>', 'PR title')
  .option('-b, --body <body>', 'PR body')
  .option('--draft', 'Open as a draft PR')
  .action(async (repoArg: string, opts: { head: string; base: string; title: string; body?: string; draft?: boolean }) => {
    const [owner, repo] = String(repoArg).split('/');
    if (!owner || !repo) {
      console.error('✗ expected owner/repo, e.g. cli/cli');
      process.exit(1);
    }
    const res = await githubCreatePrCompare({
      owner, repo, head: opts.head, base: opts.base, title: opts.title, body: opts.body, draft: opts.draft,
    });
    console.log(`compare: ${res.compare_url}`);
    if (res.pr_url) {
      console.log(`pull request: ${res.pr_url}${opts.draft ? ' (draft)' : ''}`);
    }
    if (res.note) console.log(res.note);
    if (res.error) {
      console.error(`✗ ${res.error}`);
      process.exit(1);
    }
  });

github
  .command('repo')
  .description('Infer owner/repo and auth state for the current git repository')
  .option('-C, --cwd <dir>', 'Directory to inspect', process.cwd())
  .action((opts: { cwd: string }) => {
    const r = githubDetectLocalRepo(opts.cwd);
    if (!r.has_origin) {
      console.error('✗ no git remote origin here');
      process.exit(1);
    }
    console.log(`origin:  ${r.origin_url}`);
    console.log(`repo:    ${r.inferred_owner}/${r.inferred_repo}`);
    console.log(`ssh:     ${r.ssh_ok ? 'ok' : 'unavailable'}`);
    console.log(`token:   ${ghTokenSource()}`);
  });

// =============================================================================
// install (Codex / Claude Code adapters)
// =============================================================================

const install = program.command('install').description('Install Gollum into an Agent Host');

install
  .command('codex')
  .description('Install Gollum skills into Codex CLI (no MCP server)')
  .action(() => {
    const result = installCodex();
    console.log(result.message);
    for (const step of result.steps) console.log(`  ${step}`);
    process.exit(result.ok ? 0 : 1);
  });

install
  .command('claude')
  .description('Install Gollum skills into Claude Code (no MCP server)')
  .action(() => {
    const result = installClaude();
    console.log(result.message);
    for (const step of result.steps) console.log(`  ${step}`);
    process.exit(result.ok ? 0 : 1);
  });

// =============================================================================
// V0.2 — resolver subcommand (for gollum-resolver thin wrapper)
// =============================================================================
const resolver = program.command('resolver').description('Project resolution (used by shell hooks)');

resolver
  .command('notify-cwd <cwd>')
  .description('Notify Gollum of cwd change; returns current project_id')
  .action(async (cwd: string) => {
    const { resolveProject } = await import('../workflow/resolver.js');
    const result = await resolveProject(cwd);
    console.log(JSON.stringify(result, null, 2));
  });

resolver
  .command('current')
  .description('Print the currently bound project (from cached registry)')
  .action(async () => {
    const { currentProject } = await import('../workflow/resolver.js');
    const result = await currentProject();
    console.log(result ? JSON.stringify(result, null, 2) : '(no current project)');
  });

resolver
  .command('list')
  .description('List all known projects in ~/.gollum/registry.yaml')
  .action(async () => {
    const { listProjects } = await import('../workflow/resolver.js');
    const projects = await listProjects();
    for (const p of projects) {
      console.log(`${p.project_id}\t${p.name}\t${p.repo_root}`);
    }
  });

// =============================================================================
// V0.2 — store subcommand (for gollum-store thin wrapper)
// =============================================================================
const store = program.command('store').description('Low-level state store operations');

store
  .command('health')
  .description('Check store connectivity')
  .action(async () => {
    try {
      const s = await getStore();
      const projects = s.list('projects');
      const goals = s.list('goals');
      console.log(JSON.stringify({ healthy: true, projects: projects.length, goals: goals.length }, null, 2));
    } catch (e) {
      console.log(JSON.stringify({ healthy: false, error: (e as Error).message }, null, 2));
      process.exit(1);
    }
  });

store
  .command('info')
  .description('Print store location and stats')
  .action(async () => {
    try {
      const s = await getStore();
      const projects = s.list('projects');
      const goals = s.list('goals');
      const outcomes = s.list('outcomes');
      const tasks = s.list('tasks');
      console.log(JSON.stringify({
        stats: {
          projects: projects.length,
          goals: goals.length,
          outcomes: outcomes.length,
          tasks: tasks.length,
        },
      }, null, 2));
    } catch (e) {
      console.log(JSON.stringify({ error: (e as Error).message }, null, 2));
      process.exit(1);
    }
  });

// =============================================================================
// V0.2 — doctor (self-check)
// =============================================================================
program
  .command('doctor')
  .description('Self-check: runtime, store, agents, skills, project registry')
  .action(async () => {
    const { runDoctor } = await import('./commands/doctor.js');
    const report = await runDoctor();
    process.exit(report.ok ? 0 : 1);
  });

// =============================================================================
// V0.2 — install-skills (link bundled skills to detected agent dirs)
// =============================================================================
program
  .command('install-skills')
  .description('Symlink bundled Gollum skills into detected coding agent skills dirs')
  .option('-g, --global', 'install into global agent skills dirs (default)')
  .option('-a, --agent <name>', 'target a specific agent (claude-code, codex, cursor, mavis)')
  .action(async (opts: { global?: boolean; agent?: string }) => {
    const { installSkills } = await import('./commands/install-skills.js');
    const result = await installSkills({ global: opts.global ?? true, agent: opts.agent });
    console.log(result.message);
    for (const step of result.steps) console.log(`  ${step}`);
    process.exit(result.ok ? 0 : 1);
  });

// =============================================================================
// shutdown
// =============================================================================
process.on('exit', () => resetStore());

program.parseAsync().catch((err) => {
  console.error(err);
  resetStore();
  process.exit(1);
});