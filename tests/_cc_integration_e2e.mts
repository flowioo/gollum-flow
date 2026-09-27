/**
 * CC 集成端到端测试 — 真实通过 MCP JSON-RPC 协议调用 gollum tools
 *
 * 模拟 Codex CLI / Claude Code 通过 MCP 调用 gollum:
 *   1. initialize
 *   2. tools/list
 *   3. goal.create
 *   4. outcome.create
 *   5. criterion.create (with verifier)
 *   6. task.create
 *   7. scheduler.tick (pick task)
 *   8. task.claim
 *   9. verify.command (run pytest)
 *   10. criterion.attach_evidence
 *   11. outcome.mark_verified (via tools — V0.5 only, here we just check)
 *   12. task.complete
 */

import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';

const DB = '/tmp/gollum-cc-test.db';
const MCP = '/Users/qinchunxia/lab/gollum/dist/mcp/server.js';

if (!existsSync(MCP)) {
  console.error(`MCP binary not found: ${MCP}. Run 'npm run build' first.`);
  process.exit(1);
}

// =============================================================================
// MCP client helpers
// =============================================================================

class McpClient {
  private proc: ReturnType<typeof spawn>;
  private buffer = '';
  private nextId = 1;
  private pending = new Map<number, (response: any) => void>();
  private allTools: any[] = [];

  constructor(binary: string, args: string[], env: Record<string, string>) {
    this.proc = spawn(binary, args, { env, stdio: ['pipe', 'pipe', 'pipe'] });

    this.proc.stdout!.on('data', (chunk) => {
      this.buffer += chunk.toString();
      let idx;
      while ((idx = this.buffer.indexOf('\n')) !== -1) {
        const line = this.buffer.slice(0, idx).trim();
        this.buffer = this.buffer.slice(idx + 1);
        if (!line) continue;
        try {
          const msg = JSON.parse(line);
          if (msg.id !== undefined && this.pending.has(msg.id)) {
            const cb = this.pending.get(msg.id)!;
            this.pending.delete(msg.id);
            cb(msg);
          }
        } catch {}
      }
    });

    this.proc.stderr!.on('data', () => {
      // ignore stderr from MCP server (Node deprecation warnings etc.)
    });
  }

  call(method: string, params?: any): Promise<any> {
    return new Promise((resolve, reject) => {
      const id = this.nextId++;
      this.pending.set(id, resolve);
      this.proc.stdin!.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`timeout waiting for ${method}`));
        }
      }, 5000);
    });
  }

  async listTools(): Promise<any[]> {
    const result = await this.call('tools/list');
    this.allTools = result.result.tools;
    return this.allTools;
  }

  async callTool(name: string, args: any): Promise<any> {
    const result = await this.call('tools/call', { name, arguments: args });
    if (result.result?.error) {
      throw new Error(JSON.stringify(result.result.error));
    }
    const content = result.result?.content?.[0]?.text;
    return content ? JSON.parse(content) : result.result;
  }

  close(): void {
    this.proc.kill();
  }
}

// =============================================================================
// Demo
// =============================================================================

async function main() {
  console.log('=== CC Integration E2E Test ===');

  // 1. Ensure fixture repo is in broken state
  const repoDir = '/Users/qinchunxia/lab/gollum/tests/fixtures/demo-repo';
  writeFileSync(`${repoDir}/src/calculator.py`,
    `def add(a, b):\n    return a + b\n\ndef subtract(a, b):\n    return a - b - 1  # BUG\n\ndef multiply(a, b):\n    return a * b\n`);
  writeFileSync(`${repoDir}/src/parser.py`,
    `def parse_int(s):\n    if not s:\n        return 0\n    return int(s)\n\ndef parse_float(s):\n    if not s:\n        return 0.0\n    return float(s)\n`);
  writeFileSync(`${repoDir}/src/utils.py`,
    `def find_first(items, target):\n    for i, item in enumerate(items):\n        if item == target:\n            return i\n    return -1\n\ndef find_last(items, target):\n    i = len(items) - 1\n    while i >= 0:\n        if items[i] == target:\n            return i\n        i += 0  # BUG\n    return -1\n`);

  // 2. Spawn MCP server
  console.log('Starting MCP server...');
  const client = new McpClient('node', [MCP], {
    ...process.env,
    GOLLUM_DB_PATH: DB,
  } as any);

  // 3. Initialize + list tools
  console.log('Calling initialize...');
  const init = await client.call('initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'cc-test', version: '1.0' },
  });
  console.log(`  ✓ server: ${init.result.serverInfo.name} v${init.result.serverInfo.version}`);

  console.log('Listing tools...');
  const tools = await client.listTools();
  console.log(`  ✓ ${tools.length} tools available`);
  console.log(`    Tools: ${tools.map((t) => t.name).join(', ')}`);

  // 4. Create Goal
  console.log('\nCreating Goal...');
  const goal = await client.callTool('goal.create', {
    title: '修复 demo-repo，全部测试通过',
    description: 'fix all failing tests in calculator, parser, utils',
  });
  console.log(`  ✓ goal: ${goal.id}`);

  // 5. Create Outcome
  console.log('Creating Outcome...');
  const outcome = await client.callTool('outcome.create', {
    goal_id: goal.id,
    title: '所有测试 PASS',
    priority: 1,
  });
  console.log(`  ✓ outcome: ${outcome.id}`);

  // 6. Create Criterion with verifier
  console.log('Creating Criterion with verifier...');
  const criterion = await client.callTool('criterion.create', {
    outcome_id: outcome.id,
    description: 'pytest 全绿',
    verifier_type: 'command',
    verifier_config: {
      command: 'cd ' + repoDir + ' && python3 run_tests.py',
      expect: { exit_code: 0 },
    },
  });
  console.log(`  ✓ criterion: ${criterion.id} (UNVERIFIED until verified)`);

  // 7. Create Task
  console.log('Creating Task...');
  const task = await client.callTool('task.create', {
    outcome_id: outcome.id,
    title: '修复所有 bug 让测试通过',
    estimated_minutes: 30,
  });
  console.log(`  ✓ task: ${task.id}`);

  // 8. Scheduler tick to pick task
  console.log('\nScheduler tick...');
  const tick = await client.callTool('scheduler.tick', { limit: 5 });
  console.log(`  ✓ released=${tick.released.length}, picked=${tick.picked.length}`);
  for (const p of tick.picked) console.log(`    - ${p.task.title}`);

  // 9. Claim task
  console.log('\nClaiming task...');
  const claimed = await client.callTool('task.claim', {
    task_id: task.id,
    owner: 'codex/session-e2e-test',
  });
  console.log(`  ✓ status=${claimed.status}, lease_until=${claimed.lease_until}`);

  // 10. Run goal-align
  console.log('\nRunning goal-align...');
  const align = await client.callTool('goal-align', {
    task_id: task.id,
  });
  console.log(`  ✓ verdict=${align.verdict} objective=${align.objective} llm=${align.llm}`);
  console.log(`    reason: ${align.reason}`);

  // 11. Run verify.command (should FAIL — bugs not fixed)
  console.log('\nVerify criterion (initially FAIL)...');
  const verifyFail = await client.callTool('verify.command', {
    command: `cd ${repoDir} && python3 run_tests.py`,
    expect_exit_code: 0,
  });
  console.log(`  ✓ status=${verifyFail.status}`);
  console.log(`    observation: ${verifyFail.observation.slice(0, 100)}`);

  if (verifyFail.status !== 'FAIL') {
    console.error('UNEXPECTED: tests pass before fix!');
    process.exit(1);
  }

  // 12. Fix bugs
  console.log('\nFixing bugs (simulating Codex/Claude writing code)...');
  writeFileSync(`${repoDir}/src/calculator.py`,
    `def add(a, b):\n    return a + b\n\ndef subtract(a, b):\n    return a - b  # FIXED\n\ndef multiply(a, b):\n    return a * b\n`);
  writeFileSync(`${repoDir}/src/utils.py`,
    `def find_first(items, target):\n    for i, item in enumerate(items):\n        if item == target:\n            return i\n    return -1\n\ndef find_last(items, target):\n    i = len(items) - 1\n    while i >= 0:\n        if items[i] == target:\n            return i\n        i -= 1  # FIXED\n    return -1\n`);
  console.log('  ✓ fixed calculator.py + utils.py (all bugs)');

  // 13. Re-verify
  console.log('\nRe-verify criterion (should PASS now)...');
  const verifyPass = await client.callTool('verify.command', {
    command: `cd ${repoDir} && python3 run_tests.py`,
    expect_exit_code: 0,
  });
  console.log(`  ✓ status=${verifyPass.status}`);

  if (verifyPass.status !== 'PASS') {
    console.error(`Still failing: ${verifyPass.observation}`);
    process.exit(1);
  }

  // 14. Attach evidence
  console.log('\nAttaching PASS evidence to criterion...');
  const evidence = await client.callTool('criterion.attach_evidence', {
    criterion_id: criterion.id,
    status: 'PASS',
    executor: 'codex/session-e2e-test',
    data: verifyPass.evidence,
  });
  console.log(`  ✓ evidence: ${evidence.id}`);

  // 15. Check criterion derived_status
  console.log('\nChecking criterion derived_status...');
  const outcomeState = await client.callTool('outcome.get', { outcome_id: outcome.id });
  const c = outcomeState.criteria.find((x: any) => x.id === criterion.id);
  console.log(`  ✓ criterion derived_status: ${c.derived_status}`);

  // 16. Complete task
  console.log('\nCompleting task...');
  const completed = await client.callTool('task.complete', {
    task_id: task.id,
    summary: 'All tests pass, criterion verified',
  });
  console.log(`  ✓ status=${completed.status}`);

  // 17. Check remaining_gap
  console.log('\nOutcome remaining_gap...');
  const gap = await client.callTool('outcome.remaining_gap', { outcome_id: outcome.id });
  console.log(`  ✓ gap: ${JSON.stringify(gap)}`);

  client.close();
  console.log('\n=== CC INTEGRATION E2E TEST PASSED ===');
}

main().catch((e) => {
  console.error('E2E test failed:', e);
  process.exit(1);
});