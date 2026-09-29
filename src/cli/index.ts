#!/usr/bin/env node
/**
 * Gollum CLI — entry point (DESIGN §11)
 */

import { Command } from 'commander';
import { readFileSync } from 'node:fs';
import { getStore, resetStore } from '../workflow/store/store.js';
import {
  projectCreate,
  projectList,
  projectGetOrCreateDefault,
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
import { installCodex } from '../adapters/codex/installer.js';
import { installClaude } from '../adapters/claude-code/installer.js';
import type { Outcome, Task } from '../workflow/model/types.js';

const program = new Command();
program
  .name('gollum')
  .description('Portable workflow, skills and tools for reliable long-running coding agents')
  .version('0.1.0');

// =============================================================================
// init
// =============================================================================
program
  .command('init')
  .description('Initialize gollum workspace (creates default project + runs migrations)')
  .action(() => {
    const store = getStore();
    const project = projectGetOrCreateDefault(store);
    console.log(`✓ Gollum initialized`);
    console.log(`  Project: ${project.name} (${project.id})`);
    console.log(`  DB: ${process.env.GOLLUM_DB_PATH ?? './data/gollum.db'}`);
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
  .option('-p, --project-id <id>', 'Filter by project')
  .option('--tree', 'Show goal → outcome → task + criterion gap')
  .action((opts) => {
    const store = getStore();
    const list = goalList(store, { project_id: opts.projectId });
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