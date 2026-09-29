/**
 * Gollum MCP Server (DESIGN §17)
 *
 * stdio JSON-RPC 2.0 server exposing core Tools to Agent Hosts (Codex CLI, Claude Code).
 *
 * Exposed tools (V0.1, 11 most-used):
 *   task.get              — 加载 Task + Outcome + Goal Context
 *   task.claim            — Agent claim 一个 task，带 lease
 *   task.checkpoint       — 写 semantic checkpoint
 *   task.complete         — DONE
 *   task.fail             — FAILED
 *   task.wait             — WAITING
 *   task.list_active      — 当前可执行 Task
 *   outcome.get           — Outcome + criteria[]
 *   outcome.remaining_gap — 替代 progress 数字
 *   criterion.attach_evidence — Verify 后 attach evidence
 *   verify.command        — 跑 shell command verifier
 *   goal-align            — 三级 verdict
 *
 * Protocol: MCP (Model Context Protocol) over stdio JSON-RPC 2.0
 */

import { Store, getStore } from '../workflow/store/store.js';
import {
  taskGet, taskClaim, taskCheckpoint, taskComplete, taskFail, taskWait,
} from './core/task.js';
import {
  outcomeGet, outcomeRemainingGap,
} from './core/outcome.js';
import { criterionAttachEvidence } from './core/criterion.js';
import { evidenceCreate } from './core/evidence.js';
import { verifyCommand } from './core/verify.js';
import { goalAlign } from './core/goal-align.js';
import { schedulerTick } from '../workflow/scheduler/scheduler.js';
import { projectGetOrCreateDefault } from './core/goal.js';
import {
  githubSearchIssues, githubGetIssue, githubCreatePrCompare, githubGetPr,
  githubForkRepo, githubDetectLocalRepo,
} from './core/github.js';
import {
  recordExhaustion,
  tickQuotaRecovery,
  getQuotaState,
  detectQuotaError,
  canDispatch,
  DEFAULT_QUOTA_RECOVERY_MS,
} from '../agent/quota.js';
import { taskHeartbeat } from '../agent/heartbeat.js';

// =============================================================================
// Tool definitions (MCP format)
// =============================================================================

const TOOLS = [
  {
    name: 'task.get',
    description: 'Load a Task with its Outcome + Goal context. Use at the start of every Task.',
    inputSchema: {
      type: 'object',
      properties: {
        task_id: { type: 'string', description: 'Task ULID' },
      },
      required: ['task_id'],
    },
  },
  {
    name: 'task.claim',
    description: 'Claim a task with lease. Sets status=RUNNING and assigns owner.',
    inputSchema: {
      type: 'object',
      properties: {
        task_id: { type: 'string' },
        owner: { type: 'string', description: 'Agent identifier, e.g. codex/session-abc' },
        lease_ms: { type: 'number', description: 'Lease duration in ms (default 15min)' },
      },
      required: ['task_id', 'owner'],
    },
  },
  {
    name: 'task.checkpoint',
    description: 'Write a semantic checkpoint (summary + observation + next action).',
    inputSchema: {
      type: 'object',
      properties: {
        task_id: { type: 'string' },
        summary: { type: 'string' },
        observation: { type: 'string' },
        next_action: { type: 'string' },
        artifacts: { type: 'array', items: { type: 'string' } },
      },
      required: ['task_id', 'summary'],
    },
  },
  {
    name: 'task.complete',
    description: 'Mark task DONE. Use after Verify PASS.',
    inputSchema: {
      type: 'object',
      properties: {
        task_id: { type: 'string' },
        summary: { type: 'string' },
      },
      required: ['task_id'],
    },
  },
  {
    name: 'task.fail',
    description: 'Mark task FAILED.',
    inputSchema: {
      type: 'object',
      properties: {
        task_id: { type: 'string' },
        reason: { type: 'string' },
      },
      required: ['task_id', 'reason'],
    },
  },
  {
    name: 'task.wait',
    description: 'Mark task WAITING (release lease, set wake_at).',
    inputSchema: {
      type: 'object',
      properties: {
        task_id: { type: 'string' },
        wake_at: { type: 'string', description: 'ISO8601' },
        reason: { type: 'string' },
      },
      required: ['task_id', 'wake_at'],
    },
  },
  {
    name: 'outcome.get',
    description: 'Get Outcome + its criteria.',
    inputSchema: {
      type: 'object',
      properties: {
        outcome_id: { type: 'string' },
      },
      required: ['outcome_id'],
    },
  },
  {
    name: 'outcome.remaining_gap',
    description: 'Count criteria by status (pass/fail/unknown/unverified). Replaces progress number.',
    inputSchema: {
      type: 'object',
      properties: {
        outcome_id: { type: 'string' },
      },
      required: ['outcome_id'],
    },
  },
  {
    name: 'criterion.attach_evidence',
    description: 'Attach evidence to a criterion, auto-update derived_status.',
    inputSchema: {
      type: 'object',
      properties: {
        criterion_id: { type: 'string' },
        status: { type: 'string', enum: ['PASS', 'FAIL', 'UNKNOWN'] },
        executor: { type: 'string' },
        data: { type: 'object' },
      },
      required: ['criterion_id', 'status'],
    },
  },
  {
    name: 'verify.command',
    description: 'Run a shell command and return ToolResult (PASS/FAIL/UNKNOWN + evidence).',
    inputSchema: {
      type: 'object',
      properties: {
        command: { type: 'string' },
        cwd: { type: 'string' },
        timeout: { type: 'number' },
        expect_exit_code: { type: 'number' },
      },
      required: ['command'],
    },
  },
  {
    name: 'goal-align',
    description: 'Run goal-align Skill (3-tier verdict: aligned|uncertain|misaligned).',
    inputSchema: {
      type: 'object',
      properties: {
        task_id: { type: 'string' },
        goal_description: { type: 'string' },
      },
      required: ['task_id'],
    },
  },
  {
    name: 'scheduler.tick',
    description: 'Run one scheduler tick: release expired leases + pick next task.',
    inputSchema: {
      type: 'object',
      properties: {
        limit: { type: 'number', description: 'Max tasks to pick (default 1)' },
      },
    },
  },
  {
    name: 'goal.create',
    description: 'Create a new Goal (returns id, status).',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string' },
        description: { type: 'string' },
      },
      required: ['title'],
    },
  },
  {
    name: 'outcome.create',
    description: 'Create a new Outcome under a Goal.',
    inputSchema: {
      type: 'object',
      properties: {
        goal_id: { type: 'string' },
        title: { type: 'string' },
        priority: { type: 'number' },
      },
      required: ['goal_id', 'title'],
    },
  },
  {
    name: 'criterion.create',
    description: 'Create a new Criterion under an Outcome (verifier required).',
    inputSchema: {
      type: 'object',
      properties: {
        outcome_id: { type: 'string' },
        description: { type: 'string' },
        verifier_type: { type: 'string', enum: ['command', 'git', 'outcome_criterion', 'timer_check', 'human_assert'] },
        verifier_config: { type: 'object' },
      },
      required: ['outcome_id', 'description', 'verifier_type', 'verifier_config'],
    },
  },
  {
    name: 'task.create',
    description: 'Create a new Task under an Outcome.',
    inputSchema: {
      type: 'object',
      properties: {
        outcome_id: { type: 'string' },
        title: { type: 'string' },
        acceptance_criteria: { type: 'array', items: { type: 'string' } },
        estimated_minutes: { type: 'number' },
        priority: { type: 'number' },
      },
      required: ['outcome_id', 'title'],
    },
  },
  {
    name: 'github.search_issues',
    description: 'Search GitHub issues. Uses GITHUB_TOKEN env if set, else unauthenticated (rate-limited).',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Free-text query (optional)' },
        labels: { type: 'array', items: { type: 'string' }, description: 'e.g. ["good first issue", "bug"]' },
        language: { type: 'string', description: 'e.g. typescript, python' },
        state: { type: 'enum', enum: ['open', 'closed'], default: 'open' },
        sort: { type: 'enum', enum: ['updated', 'created', 'comments'], default: 'updated' },
        per_page: { type: 'number', default: 20 },
      },
    },
  },
  {
    name: 'github.get_issue',
    description: 'Fetch a single GitHub issue by owner/repo/number, returns full body.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string' },
        repo: { type: 'string' },
        issue_number: { type: 'number' },
      },
      required: ['owner', 'repo', 'issue_number'],
    },
  },
  {
    name: 'github.get_pr',
    description: 'Fetch a single GitHub pull request by owner/repo/pr_number, returns full body + state + head/base.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string' },
        repo: { type: 'string' },
        pr_number: { type: 'number' },
      },
      required: ['owner', 'repo', 'pr_number'],
    },
  },
  {
    name: 'github.create_pr_compare',
    description: 'Generate a compare URL for opening a PR. With GITHUB_TOKEN set, actually submits the PR via API. Without token, returns URL for user to click.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string' },
        repo: { type: 'string' },
        head: { type: 'string', description: 'head ref, e.g. "username:branch" or "username:fix/typo"' },
        base: { type: 'string', description: 'base branch, e.g. "main"' },
        title: { type: 'string' },
        body: { type: 'string' },
      },
      required: ['owner', 'repo', 'head', 'base', 'title'],
    },
  },
  {
    name: 'github.fork_repo',
    description: 'Fork a GitHub repo to the authenticated user (or an org). Requires GITHUB_TOKEN.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string' },
        repo: { type: 'string' },
        org: { type: 'string' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'github.detect_local_repo',
    description: 'Inspect a local git repo: parse origin, test SSH auth, return owner/repo/ssh_ok.',
    inputSchema: {
      type: 'object',
      properties: {
        cwd: { type: 'string', description: 'Absolute path to local git repo (default: process.cwd())' },
      },
    },
  },
  // ---------------------------------------------------------------------------
  // Agent Self-Evolution tools (V0.2)
  // ---------------------------------------------------------------------------
  {
    name: 'quota.report_exhaustion',
    description:
      'Agent Host calls this when it sees a quota error (HTTP 429 / 5-hour window). ' +
      'Pauses all RUNNING tasks and resumes them when recovery_at elapses.',
    inputSchema: {
      type: 'object',
      properties: {
        provider: { type: 'string', description: 'e.g. "anthropic", "codex", "openai"' },
        error: { type: 'string', description: 'The error message that triggered this' },
        recovery_ms: { type: 'number', description: 'Expected recovery time in ms (default 5hr)' },
        auto_detect: { type: 'boolean', description: 'If true, inspect the error for quota patterns first', default: true },
      },
      required: ['error'],
    },
  },
  {
    name: 'quota.status',
    description: 'Get current API quota state (status / provider / recovery_at / hit_count).',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'quota.tick',
    description:
      'Check if quota has recovered. Call this from the agent loop every tick. ' +
      'If recovered, releases all paused tasks back to PENDING.',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'task.heartbeat',
    description:
      'Refresh heartbeat for a task (worker is alive). Extends lease_until automatically. ' +
      'Workers should call this every 20-30s while working on a task.',
    inputSchema: {
      type: 'object',
      properties: {
        task_id: { type: 'string' },
      },
      required: ['task_id'],
    },
  },
  {
    name: 'agent.can_dispatch',
    description:
      'Quick check: can the scheduler pick new tasks right now? ' +
      'Returns { ok: false, reason, resume_at } if quota exhausted and not yet recovered.',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
];

// =============================================================================
// JSON-RPC 2.0 helpers
// =============================================================================

interface JsonRpcRequest {
  jsonrpc: '2.0';
  id?: string | number | null;
  method: string;
  params?: unknown;
}

interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: string | number | null;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

function ok(id: string | number | null, result: unknown): JsonRpcResponse {
  return { jsonrpc: '2.0', id, result };
}

function err(id: string | number | null, code: number, message: string, data?: unknown): JsonRpcResponse {
  return { jsonrpc: '2.0', id, error: { code, message, data } };
}

// =============================================================================
// Tool dispatch
// =============================================================================

async function dispatchTool(name: string, args: any): Promise<unknown> {
  const store = getStore();

  switch (name) {
    case 'task.get':
      return taskGet(store, args.task_id);
    case 'task.claim':
      return taskClaim(store, {
        task_id: args.task_id,
        owner: args.owner,
        lease_ms: args.lease_ms,
      });
    case 'task.checkpoint':
      return taskCheckpoint(store, args.task_id, {
        summary: args.summary,
        observation: args.observation,
        next_action: args.next_action,
        artifacts: args.artifacts,
      });
    case 'task.complete':
      return taskComplete(store, args.task_id, args.summary);
    case 'task.fail':
      return taskFail(store, { task_id: args.task_id, reason: args.reason });
    case 'task.wait':
      return taskWait(store, {
        task_id: args.task_id,
        wake_at: args.wake_at,
        reason: args.reason,
      });
    case 'outcome.get':
      return outcomeGet(store, args.outcome_id);
    case 'outcome.remaining_gap':
      return outcomeRemainingGap(store, args.outcome_id);
    case 'criterion.attach_evidence':
      return evidenceCreate(store, {
        criterion_id: args.criterion_id,
        status: args.status,
        executor: args.executor,
        data: args.data,
      });
    case 'verify.command': {
      const result = await verifyCommand({
        command: args.command,
        cwd: args.cwd,
        timeout: args.timeout,
        expect: { exit_code: args.expect_exit_code ?? 0 },
      });
      return result;
    }
    case 'goal-align':
      return goalAlign(store, {
        task_id: args.task_id,
        goal_description: args.goal_description,
      });
    case 'scheduler.tick':
      return schedulerTick(store, { limit: args.limit });
    case 'goal.create': {
      const project = projectGetOrCreateDefault(store);
      const { goalCreate } = await import('./core/goal.js');
      return goalCreate(store, {
        project_id: project.id,
        title: args.title,
        description: args.description,
      });
    }
    case 'outcome.create': {
      const { outcomeCreate } = await import('./core/outcome.js');
      return outcomeCreate(store, {
        goal_id: args.goal_id,
        title: args.title,
        priority: args.priority,
      });
    }
    case 'criterion.create': {
      const { criterionCreate } = await import('./core/criterion.js');
      return criterionCreate(store, {
        outcome_id: args.outcome_id,
        description: args.description,
        verifier: {
          type: args.verifier_type,
          config: args.verifier_config,
        },
      });
    }
    case 'task.create': {
      const { taskCreate } = await import('./core/task.js');
      return taskCreate(store, {
        outcome_id: args.outcome_id,
        title: args.title,
        acceptance_criteria: args.acceptance_criteria ?? [],
        estimated_minutes: args.estimated_minutes,
        priority: args.priority,
      });
    }
    case 'github.search_issues':
      return githubSearchIssues(args);
    case 'github.get_issue':
      return githubGetIssue(args);
    case 'github.get_pr':
      return githubGetPr(args);
    case 'github.create_pr_compare':
      return githubCreatePrCompare(args);
    case 'github.fork_repo':
      return githubForkRepo(args);
    case 'github.detect_local_repo':
      return githubDetectLocalRepo(args.cwd ?? process.cwd());

    // -------------------------------------------------------------------------
    // Agent Self-Evolution tools (V0.2)
    // -------------------------------------------------------------------------
    case 'quota.report_exhaustion': {
      const error = args.error ?? '';
      let provider = args.provider ?? 'unknown';

      if (args.auto_detect !== false) {
        const detected = detectQuotaError(error);
        if (!detected.isQuota) {
          return {
            recorded: false,
            reason: 'error did not match any known quota pattern — use auto_detect=false to force',
            detected: { isQuota: false },
          };
        }
        provider = args.provider ?? detected.provider;
      }

      const recoveryMs = args.recovery_ms ?? DEFAULT_QUOTA_RECOVERY_MS;
      const state = recordExhaustion(store, {
        provider,
        error,
        recoveryMs,
        actor: 'mcp-agent-host',
      });
      return {
        recorded: true,
        provider: state.provider,
        recovery_at: state.recovery_at,
        hit_count: state.hit_count,
      };
    }
    case 'quota.status':
      return getQuotaState(store);
    case 'quota.tick':
      return tickQuotaRecovery(store);
    case 'task.heartbeat': {
      const task = taskHeartbeat(store, args.task_id, { pid: process.pid });
      return {
        task_id: task.id,
        heartbeat_at: task.heartbeat_at,
        lease_until: task.lease_until,
      };
    }
    case 'agent.can_dispatch':
      return canDispatch(store);

    default:
      throw new Error(`unknown tool: ${name}`);
  }
}

// =============================================================================
// Server main loop (stdio)
// =============================================================================

export async function runMcpServer(): Promise<void> {
  let buffer = '';
  let initialized = false;

  process.stdin.setEncoding('utf-8');
  process.stdout.setEncoding('utf-8');

  // Prevent the Node process from exiting when stdin has no data
  process.stdin.on('end', () => process.exit(0));

  for await (const chunk of process.stdin) {
    buffer += chunk;

    // Process newline-delimited JSON-RPC messages (MCP uses Content-Length headers
    // but the simplest interop is newline-delimited JSON)
    let idx;
    while ((idx = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, idx).trim();
      buffer = buffer.slice(idx + 1);
      if (!line) continue;

      let req: JsonRpcRequest;
      try {
        req = JSON.parse(line);
      } catch {
        continue; // skip malformed lines
      }

      await handle(req);
    }
  }

  async function handle(req: JsonRpcRequest) {
    // Notification (no id) — ignore
    if (req.id === undefined || req.id === null) {
      if (req.method === 'initialized' || req.method === 'notifications/initialized') {
        initialized = true;
      }
      return;
    }

    try {
      let result: unknown;

      if (req.method === 'initialize') {
        result = {
          protocolVersion: '2024-11-05',
          serverInfo: { name: 'gollum', version: '0.1.0' },
          capabilities: { tools: {} },
        };
        initialized = true;
      } else if (req.method === 'tools/list') {
        result = { tools: TOOLS };
      } else if (req.method === 'tools/call') {
        if (!initialized) {
          throw new Error('not initialized');
        }
        const params = req.params as { name: string; arguments?: Record<string, unknown> };
        const toolResult = await dispatchTool(params.name, params.arguments ?? {});
        result = {
          content: [
            {
              type: 'text',
              text: JSON.stringify(toolResult, null, 2),
            },
          ],
        };
      } else if (req.method === 'ping') {
        result = { pong: true };
      } else if (req.method === 'notifications/cancelled') {
        // Ignore cancellations
        result = null;
      } else {
        throw new Error(`unknown method: ${req.method}`);
      }

      send(ok(req.id, result));
    } catch (e: any) {
      send(err(req.id, -32603, e.message ?? 'internal error', { stack: e.stack }));
    }
  }

  function send(msg: JsonRpcResponse) {
    process.stdout.write(JSON.stringify(msg) + '\n');
  }
}

// Entry point
if (process.argv[1]?.endsWith('server.ts') || process.argv[1]?.endsWith('server.js')) {
  runMcpServer().catch((e) => {
    console.error('MCP server error:', e);
    process.exit(1);
  });
}