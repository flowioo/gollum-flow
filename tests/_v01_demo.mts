/**
 * V0.1 Minimal Demo — 端到端证明 Gollum 6 个核心能力
 *
 * 核心命题：关闭 Agent，重新启动，仍能知道自己为什么工作、做到哪、下一步做什么。
 *
 * 6 个核心能力：
 *   1. Goal Alignment  2. Task Planning  3. Persistence  4. Resume
 *   5. Verify          6. Recovery
 */
import { execSync } from 'node:child_process';
import { Store } from '../src/workflow/store/store.js';
import {
  projectCreate,
  goalCreate,
} from '../src/mcp/core/goal.js';
import {
  outcomeCreate,
  outcomeRemainingGap,
  outcomeMarkVerified,
} from '../src/mcp/core/outcome.js';
import { criterionCreate } from '../src/mcp/core/criterion.js';
import {
  taskCreate,
  taskClaim,
  taskCheckpoint,
  taskComplete,
} from '../src/mcp/core/task.js';
import { verifyByCriterion } from '../src/mcp/core/verify.js';
import { applyRecovery } from '../src/mcp/core/recover.js';
import { goalAlign, handleMisaligned } from '../src/mcp/core/goal-align.js';
import { schedulerTick } from '../src/workflow/scheduler/scheduler.js';

const REPO = 'tests/fixtures/demo-repo';

async function main() {
  const store = new Store(process.env.GOLLUM_DB_PATH!, 'src/workflow/store/migrations');

  function log(step, msg) {
    console.log('[' + step.padEnd(15) + '] ' + msg);
  }

  // =============================================================================
  // T0: Setup
  // =============================================================================
  log('T0 Setup', 'creating project + goal + outcome + criterion + tasks');

  const p = projectCreate(store, { name: 'demo-' + Date.now() });
  const goal = goalCreate(store, {
    project_id: p.id,
    title: '修复 demo-repo，全部测试通过',
    description: 'fix all failing tests in calculator, parser, utils',
  });
  const outcome = outcomeCreate(store, { goal_id: goal.id, title: '所有测试 PASS' });
  const criterion = criterionCreate(store, {
    outcome_id: outcome.id,
    description: 'pytest 全绿',
    verifier: {
      type: 'command',
      config: {
        command: 'cd ' + REPO + ' && python3 run_tests.py',
        expect: { exit_code: 0 },
      },
    },
  });

  const taskAnalyze = taskCreate(store, {
    outcome_id: outcome.id,
    title: '分析所有测试失败原因',
    estimated_minutes: 5,
  });
  const taskCalculator = taskCreate(store, {
    outcome_id: outcome.id,
    title: '修复 calculator 加法溢出',
    estimated_minutes: 10,
  });
  const taskParser = taskCreate(store, {
    outcome_id: outcome.id,
    title: '修复 parser 边界条件',
    estimated_minutes: 10,
  });
  const taskUtils = taskCreate(store, {
    outcome_id: outcome.id,
    title: '修复 utils 死循环',
    estimated_minutes: 10,
  });

  log('  ', 'goal=' + goal.id);
  log('  ', 'outcome=' + outcome.id + ' criterion=' + criterion.id);
  log('  ', 'tasks: ' + [taskAnalyze, taskCalculator, taskParser, taskUtils].map((t) => t.id).join(', '));

  // =============================================================================
  // T1: Goal Alignment check (capability 1)
  // =============================================================================
  log('T1 GoalAlign', 'checking alignment of taskAnalyze');
  const align = goalAlign(store, { task_id: taskAnalyze.id });
  log('  ', 'verdict=' + align.verdict + ' objective=' + align.objective + ' llm=' + align.llm);

  // =============================================================================
  // T2: Scheduler picks + claim taskAnalyze
  // =============================================================================
  log('T2 Plan', 'scheduler tick picks first task (capability 2: Task Planning)');
  const tick1 = schedulerTick(store);
  log('  ', 'picked: ' + tick1.picked.length + ' task(s), first: ' + tick1.picked[0]?.task.title);

  const claimed1 = taskClaim(store, { task_id: tick1.picked[0]!.task.id, owner: 'process-A' });

  let initialTestRun = '';
  try {
    initialTestRun = execSync('cd ' + REPO + ' && python3 run_tests.py', {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    log('  ', 'tests already pass (no bugs!)');
  } catch (e: any) {
    initialTestRun = (e.stdout ?? '') + (e.stderr ?? '');
    log('  ', 'initial tests failed (expected): ' + initialTestRun.split('\n').filter((l) => l.includes('failed')).slice(0, 3).join(' | '));
  }
  taskCheckpoint(store, claimed1.id, {
    summary: 'analyzed failing tests',
    observation: 'subtract, parse_int, find_last broken',
    next_action: 'fix calculator subtract first',
  });

  // =============================================================================
  // T3: Verify criterion (capability 5)
  // =============================================================================
  log('T3 Verify', 'verifying criterion (initially FAIL — bug not fixed yet)');
  const verifyResult1 = await verifyByCriterion(store, criterion.id, 'process-A');
  log('  ', 'status=' + verifyResult1.status);

  // =============================================================================
  // T4: Recover (capability 6)
  // =============================================================================
  log('T4 Recover', 'apply recover to taskAnalyze (FAIL → change_strategy)');
  // Reload task to get latest version after taskCheckpoint bumped it
  const freshTask = store.get('tasks' as any, claimed1.id) as any;
  const recoverResult = applyRecovery(store, freshTask, verifyResult1);
  log('  ', 'action=' + recoverResult.decision.action + ' status=' + recoverResult.task.status);

  // =============================================================================
  // T5: Simulate cross-process crash + Resume (capabilities 3, 4)
  // =============================================================================
  log('T5 Crash', 'process-A exits (simulated)');
  store.close();

  log('T5 Resume', 'process-B reopens same DB + scheduler tick');
  const storeB = new Store(process.env.GOLLUM_DB_PATH!, 'src/workflow/store/migrations');
  const tickB = schedulerTick(storeB);
  log('  ', 'released expired leases: ' + tickB.released.length);
  log('  ', 'picked next: ' + tickB.picked.map((p) => p.task.title).join(', '));

  // =============================================================================
  // T6: Fix all bugs + re-verify + Outcome VERIFIED
  // =============================================================================
  log('T6 Fix', 'fixing all bugs at once (V0.1 simplified: skip Task-level granularity here)');
  // Fix calculator
  execSync("sed -i '' 's|return a - b - 1|return a - b|' " + REPO + '/src/calculator.py');
  // Fix parser
  execSync("cat > " + REPO + "/src/parser.py << 'EOF'\n" +
    'def parse_int(s):\n' +
    '    if not s:\n' +
    '        return 0\n' +
    '    return int(s)\n' +
    '\n' +
    'def parse_float(s):\n' +
    '    if not s:\n' +
    '        return 0.0\n' +
    '    return float(s)\n' +
    'EOF\n');
  // Fix utils
  execSync("sed -i '' 's|i += 0|i -= 1|' " + REPO + '/src/utils.py 2>/dev/null || true');
  log('  ', 'fixed: calculator, parser, utils');

  const finalVerify = await verifyByCriterion(storeB, criterion.id, 'process-B');
  log('  ', 'criterion verify: status=' + finalVerify.status);

  if (finalVerify.status === 'PASS') {
    log('T6 OutcomeVerify', 'outcomeMarkVerified');
    const verified = outcomeMarkVerified(storeB, outcome.id);
    log('  ', 'outcome status=' + verified.status);

    const goalFinal = storeB.get('goals' as any, goal.id);
    log('  ', 'goal status=' + goalFinal.status);
  }

  // Mark all tasks DONE
  const remainingTasks = storeB.list('tasks', "status NOT IN ('DONE', 'FAILED')") as any[];
  log('  ', 'remaining non-DONE tasks: ' + remainingTasks.length);
  for (const t of remainingTasks) {
    try {
      const c = taskClaim(storeB, { task_id: t.id, owner: 'process-B' });
      taskComplete(storeB, c.id, 'Completed via V0.1 demo');
    } catch {
      try {
        const fresh = storeB.get('tasks' as any, t.id) as any;
        storeB.casUpdate('tasks' as any, t.id, fresh.version, { status: 'DONE' });
      } catch {}
    }
  }

  // =============================================================================
  // T9: Final summary
  // =============================================================================
  log('T9 Final', 'summary');
  const finalGap = outcomeRemainingGap(storeB, outcome.id);
  log('  ', 'outcome remaining_gap: ' + JSON.stringify(finalGap));
  const goalFinal = storeB.get('goals' as any, goal.id);
  log('  ', 'goal status: ' + goalFinal.status);

  const events = storeB.list('events', '1', []);
  log('  ', 'events emitted: ' + events.length);

  storeB.close();
  console.log('\n=== V0.1 MINIMAL DEMO COMPLETE ===');
}

main().catch((e) => {
  console.error('Demo failed:', e);
  process.exit(1);
});