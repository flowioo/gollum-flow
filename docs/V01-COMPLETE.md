# Gollum V0.1 — 完成报告

> **V0.1 状态**：✅ **主体完成**，核心命题验证通过
> **完成时间**：2026-09-28
> **代码量**：约 3500 行 TypeScript（src/ + tests/）

---

## 1. 核心命题

> **关闭 Agent，再重新启动，它还能知道自己为什么工作、做到哪了、接下来该做什么，并最终把测试跑通。**

**已通过 V0.1 Minimal Demo 端到端验证。**

---

## 2. PRD §13.1 V0.1 范围 — 全部完成

| 项 | 状态 | 证据 |
|---|---|---|
| Workflow Store (SQLite + WAL) | ✅ | `src/workflow/store/store.ts` + `migrations/0001_initial.sql`（9 表） |
| Scheduler | ✅ | `src/workflow/scheduler/scheduler.ts`（按 remaining_gap + priority 排序，不看 83%） |
| WakeCondition 抽象 | ✅ | `timer` 实现；`github_pr` / `ci_status` / `webhook` 接口预留 V0.5 |
| Task Planner | ✅ | `src/workflow/planner.ts`（>30min 强制拆 + soft warning） |
| Task Event Log | ✅ | 21+ 种事件类型；append-only |
| 6 Core Skills | ✅ | Markdown skills（task-run/task-resume/verify/recover/outcome-evaluate/goal-align） |
| 24+ Core Tools | ✅ | `task.*` (8) + `outcome.*` (5) + `goal.*` (5) + `criterion.*` (4) + `evidence.*` (2) + `verify.*` (5) |
| Verify (command / git / outcome-criterion) | ✅ | `src/mcp/core/verify.ts` |
| CLI (commander) | ✅ | `src/cli/index.ts`（覆盖所有 tools） |
| V0.1 Minimal Demo | ✅ | `tests/_v01_demo.mts` + `tests/fixtures/demo-repo/` |

---

## 3. 15 条核心原则 — 全部落地

```
1.  Agent 可以死，Task 不能丢                  ✅ Lease + CAS + Event
2.  Conversation 不是 State                    ✅ Workflow Store 是唯一事实源
3.  Environment > Memory > Checkpoint         ✅ Resume 时先 Observe
4.  No Evidence = Not Verified                 ✅ verify 三态 + UNKNOWN
5.  失败先 Observe，不重复 Action              ✅ Recover Skill
6.  Long-running Agent ≠ Long-running Process ✅ Run → Wait → Wake → Continue
7.  Gollum 不抢 Agent Loop                     ✅ 只提供状态 + 工具
8.  进展以 Outcome 为单位                      ✅ Outcome.status 状态机
9.  Task 按结果拆                              ✅ Task 五项硬性属性
10. CAS 冲突不盲重试                            ✅ reload + reEvaluate + backoff 1-3s + ≤3
11. Checkpoint 是状态，不是知识                ✅ 不存偏好；V0.1 不做归纳
12. V0.1 先证明自主循环                        ✅ 不碰 GitHub/CI/Webhook
13. Progress is not a number                   ✅ 砍掉 progress 字段
14. Criterion 三段式                            ✅ criterion → verifier → evidence
15. Human Boundary                             ✅ misaligned 自处理，不找人
```

---

## 4. 七层语义模型 — 完整实现

```
Goal            → projects + goals 表 + goal-create/get/list/update/achieve
Outcome         → outcomes 表 + outcome-create/get/list/update/mark-verified + remaining_gap
Criteria        → criteria 表 + criterion-create/get/list/attach-evidence
Evidence        → evidences 表 + evidence-create/list + derived_status 自动推导
Task            → tasks 表 + task-create/get/claim/checkpoint/wait/block/complete/fail
Execution       → executions 表（trace only，V0.1 简化）
Verify          → verify-command/git/timeout-check/human-assert/outcome-criterion
```

---

## 5. 测试覆盖

```
tests/
├── cas.test.ts              CAS 重试 + 状态机       8 tests
├── scheduler.test.ts        Scheduler + Lease       9 tests
├── verify-recover.test.ts   Verify + Recover       19 tests
├── goal-align.test.ts       Goal Alignment         11 tests
├── cross-process-resume.sh  跨进程 Resume 模拟    1 scenario
└── _v01_demo.mts            V0.1 Minimal Demo     1 scenario
                                    Total: 47 unit tests + 2 scenarios
```

### 全部测试结果

```
ℹ tests 47
ℹ suites 16
ℹ pass 47
ℹ fail 0
```

---

## 6. V0.1 Minimal Demo — 实测结果

```
[T0 Setup       ]  ✓ Goal + Outcome + Criterion + 4 Tasks created
[T1 GoalAlign   ]  ✓ verdict: aligned | uncertain (capability 1)
[T2 Plan        ]  ✓ Scheduler picks first task (capability 2)
[T3 Verify      ]  ✓ criterion FAIL (bug not fixed yet, capability 5)
[T4 Recover     ]  ✓ retry / change_strategy (capability 6)
[T5 Crash       ]  ✓ Process A exits (simulated)
[T5 Resume      ]  ✓ Process B reopens same DB (capabilities 3, 4)
[T6 Fix         ]  ✓ Fixed all 3 bugs
[T6 Verify      ]  ✓ criterion PASS
[T6 Outcome]    ✓ outcome.status = VERIFIED
[T6 Goal]       ✓ goal.status = achieved (auto, 因所有 Outcome VERIFIED)
[T9 Final]      ✓ 128 events recorded
```

**一次证明 6 个核心能力**：Goal Alignment / Task Planning / Persistence / Resume / Verify / Recovery

---

## 7. CLI 命令清单

```bash
# Setup
gollum init
gollum project create|list
gollum goal create|list|show
gollum outcome create|list|show|remaining-gap|mark-verified
gollum criterion create|list
gollum evidence create|list

# Task lifecycle
gollum task create|show|claim|checkpoint|complete|fail|wait|block

# Scheduler
gollum scheduler tick|pick|expired|release-expired|run

# Verify
gollum verify command|git|criterion

# Recovery & alignment
gollum recover <task_id>
gollum goal-align <task_id>
gollum handle-misaligned <task_id>

# Inspection
gollum events list
gollum validate --plan <file>
```

---

## 8. 项目结构（最终）

```
gollum/
├── docs/
│   ├── README.md
│   ├── PRD.md                     业务视角
│   ├── DESIGN.md                  工程视角
│   └── V01-COMPLETE.md            ← 本文档
├── src/
│   ├── workflow/
│   │   ├── model/                 types.ts + state.ts
│   │   ├── store/                 store.ts + migrations/
│   │   ├── scheduler/             scheduler.ts
│   │   └── planner.ts
│   ├── mcp/core/
│   │   ├── task.ts                8 tools
│   │   ├── outcome.ts             5 tools
│   │   ├── goal.ts                5 tools + project 4 helpers
│   │   ├── criterion.ts           4 tools
│   │   ├── evidence.ts            2 tools
│   │   ├── verify.ts              5 verifiers
│   │   ├── recover.ts             classify + decide + apply
│   │   └── goal-align.ts          双轨判断 + 三级 verdict
│   ├── skills/core/               6 Markdown skills
│   ├── adapters/codex/            (待 W5')
│   └── cli/                       index.ts + commands/scheduler.ts
├── tests/
│   ├── helpers.ts
│   ├── cas.test.ts                8 tests
│   ├── scheduler.test.ts          9 tests
│   ├── verify-recover.test.ts     19 tests
│   ├── goal-align.test.ts         11 tests
│   ├── cross-process-resume.sh    跨进程模拟
│   ├── v01-minimal-demo.sh        完整 demo shell 脚本
│   ├── _v01_demo.mts              完整 demo TS 脚本
│   ├── _process_a.ts              跨进程测试 Process A
│   ├── _process_b.ts              跨进程测试 Process B
│   └── fixtures/demo-repo/        2-3 bug fixture
├── data/                          gitignored
├── package.json
├── tsconfig.json
├── vitest.config.ts               (empty placeholder)
└── .gitignore
```

---

## 9. git 提交历史

```
b3cc203 w4: Goal Alignment + 完整 V0.1 Minimal Demo 通过
89d92ff w3: Verify + Recover 完整实现
d9579cc w2: Scheduler + WakeCondition + 跨进程 Resume 通过
c393d8f w1: V0.1 Demo 1 骨架 + 端到端冒烟测试通过
091656b chore: 添加 .gitignore
865057e docs: 合并为 PRD + DESIGN
3673e12 docs: 砍掉 progress 数字 + Criterion 三段式 + goal-align 三级
c684163 docs: V0.1 Minimal Demo 收敛 + 5 项建议全部采纳
2308323 docs: 引入 Goal / Outcome 语义层
b3623bc docs: Gollum 方案 + 评审
```

---

## 10. V0.1 → V0.5 演进路径

按 DESIGN §14，V0.1 完成后下一步是 V0.5：

```
V0.5 (下一步)：
  - 生态集成：GitHub Issue / PR / CI / Webhook
  - outcome-decompose 自动拆 Task
  - 真实 LLM 替换 keyword matching（goal-align + planner）
  - 20-30 个真实 Coding Task A/B 验证
  - Codex CLI Adapter (adapters/codex/installer.ts)

V1（远期）：
  - Phone Agent（Android）
  - Robot Agent（机械臂 / IoT）
  - Multi-Agent 协作
  - Memory Evolution
  - Skill Mining
```

---

## 11. V0.1 验收（PRD §15）对照

```
✓ Task DONE 后能 attach_evidence 到对应 Criterion
✓ Criterion.derived_status 随 latest_evidence.status 自动推导
✓ 所有 Criterion.derived_status == PASS 时 Outcome 自动 VERIFIED
✓ 所有 Outcome VERIFIED 时 Goal 自动 achieved
✓ 跨进程重启后能 Resume
✓ CAS 冲突按 reload + backoff 1-3s + re-evaluate + ≤3 次处理
✓ Lease 过期自动可被重新接管
✓ Event Log 完整记录 CRITERION_VERIFIED / OUTCOME_VERIFIED / TASK_RESUMED 等
✓ goal-align misaligned → pause / rollback / 换 task（不找人）
✓ Criterion 没绑定 verifier → 标 UNVERIFIED
```

---

## 12. 一句话总结

> **Gollum V0.1 = 47 测试全绿 + Minimal Demo 跑通 + 核心命题验证通过。**
> **Coding Agent 现在能跨进程、跨 Session 持续可靠推进 Goal / Outcome。**

下一步默认按 DESIGN §14 继续 W5（生态集成）或 W5'（20-30 真实 Task 验证）。