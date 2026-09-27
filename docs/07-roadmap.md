# 07 · 项目结构 / CLI / Roadmap / 验收

## 1. 项目结构

```
gollum/
│
├── skills/
│   ├── core/
│   │   ├── task-run/
│   │   ├── task-resume/
│   │   ├── verify/
│   │   ├── recover/
│   │   ├── outcome-evaluate/        ← 新增
│   │   └── goal-align/              ← 新增
│   │
│   ├── coding/
│   ├── research/
│   ├── android/
│   └── robot/
│
├── mcp/
│   ├── core/
│   │   ├── task.ts                  # task.* tools
│   │   ├── outcome.ts               # outcome.* tools  ← 新增
│   │   ├── goal.ts                  # goal.* tools     ← 新增
│   │   └── verify.ts                # verify.* tools
│   ├── browser/
│   ├── android/
│   └── robot/
│
├── workflow/
│   ├── store/
│   │   ├── schema.sql               ← projects/goals/outcomes/tasks/executions/evidence/events
│   │   ├── store.ts
│   │   └── migrations/
│   ├── scheduler/
│   │   ├── scheduler.ts             ← 按 Outcome Gap 排序
│   │   └── policies.ts
│   └── model/
│       ├── state.ts                 ← 状态机
│       └── alignment.ts             ← AlignmentVerdict
│
├── adapters/
│   ├── codex/
│   ├── claude-code/
│   └── workbuddy/
│
├── cli/
│
├── tests/
│
└── docs/                            # 你正在看的目录
```

---

## 2. CLI

V0.1：

```bash
gollum init

gollum install codex
gollum install claude
gollum install workbuddy

# Project / Goal / Outcome
gollum project create
gollum project list
gollum goal create        # 新增
gollum goal show          # 新增
gollum outcome create     # 新增
gollum outcome list       # 新增
gollum outcome gap        # 新增 ← 看每个 Outcome 的 Gap

# Task / Execution
gollum task create        # 现在强制要 --outcome-id
gollum task show
gollum task run
gollum task resume
gollum task cancel

# Worker / Scheduler
gollum worker start
gollum scheduler start
```

### Task 创建示例（升级版）

```bash
gollum task create \
  --outcome-id outcome-001 \
  --title "实现 workflow state 持久化" \
  --acceptance-criteria "进程退出后能恢复 phase, 已完成 Task 不重复执行"
```

CLI 必须强制 `--outcome-id`，否则报错。**没有 Outcome 的 Task 不被允许创建。**

---

## 3. 第一个 Demo：V0.1 Minimal Demo（自主循环证明）

> **V0.1 只证明自主循环，不证明生态集成。**

详见 [10-v01-minimal-demo.md](./10-v01-minimal-demo.md)。

一句话：

> 关闭 Agent，再重新启动，它还能知道自己为什么工作、做到哪了、接下来该做什么，并最终把测试跑通。

### Demo 形态

故意准备一个 **2~3 个 bug 的本地 Repo**，给定 Goal：

```
Goal: 修复项目，使全部测试通过
```

Agent 自动拆 Outcome / Task → 跑测试 → 修复 → Verify → 失败后下一轮自动修复 → PASS 后结束。

### 一次证明 6 个核心能力

| # | 能力 | 在 Demo 中的体现 |
|---|---|---|
| 1 | **Goal Alignment** | 每次新建 Task / Checkpoint 时 `goal-align` 返回 aligned |
| 2 | **Task Planning** | Agent 从 Goal 自动拆 Outcome + Task 序列 |
| 3 | **Persistence** | 进程退出后从 store 加载 Task，知道之前哪些已 DONE |
| 4 | **Resume** | 重新唤醒后知道「为什么工作 / 做到哪 / 下一步」 |
| 5 | **Verify** | 每个 Task 都有 Verify 步骤（运行 pytest），evidence 落库 |
| 6 | **Recovery** | Task 修了部分 bug 后仍 verify fail → 系统继续推进而不是放弃 |

### 不证明什么

```
❌ GitHub Issue 集成
❌ PR 创建 / 评论 / Review
❌ CI 平台集成
❌ Webhook 触发
❌ 多 Agent 协作
```

这些是 V0.5 的事。V0.1 跑通后，叠 Tool Integration 是 1+1 的事。

---

## 4. 第二阶段：Phone Agent

新增：

```android
android.observe
android.tap
android.input
android.swipe
android.launch
```

Gollum Workflow（Project → Goal → Outcome → Task → Execution）完全不改，只增加 Skills + Tools。

---

## 5. 第三阶段：Robot Agent

新增：

```robot
robot.observe
robot.navigate
robot.pick
robot.place
robot.camera
robot.iot
```

复用：

```
Project / Goal / Outcome / Task / Execution
Workflow / Memory / Skill / Verify / Recovery
```

这就是 Gollum 长期最大的架构价值：

> **Digital Agent 与 Embodied Agent 使用同一套 Workflow Model。**

---

## 6. V0.1 范围

第一阶段严格控制范围。

### 做

```
Workflow Store (SQLite + WAL)
  - Project / Goal / Outcome / Task / Execution / Evidence / Event 表
  - CAS Version
  - Lease

Scheduler
  - 按 Outcome Gap 排序

WakeCondition 抽象
  - timer 实现（V0.1 唯一需要）
  - github_pr / ci_status 接口预留（V0.5）

Task Event Log
  - 原事件 + Outcome / Goal 层事件

6 Core Skills
  - task-run / task-resume / verify / recover
  - outcome-evaluate / goal-align

Task Planner
  - 自动拆 Outcome / Task
  - 估算执行时间，> 30min 强制拆分

12 Core Tools
  - task.* (8 个)
  - outcome.* (2 个)
  - goal.* (2 个)

Verify
  - command (pytest / npm test)
  - git (git status / git diff)
  - outcome-criterion

Codex Integration
  - 本地 Codex CLI
  - 启动时传 Task ID + Goal Context

V0.1 Minimal Demo（详见 10）
  - 本地 2-3 bug repo
  - Goal → Outcome → Task 自动拆
  - 跨进程 Resume
  - Verify + Recover
```

### 不做

```
❌ GitHub Issue / PR / CI 集成
❌ Webhook / Email / 文件触发
❌ Memory Evolution（自动提炼）
❌ Skill 自动生成
❌ Multi-Agent
❌ Distributed Scheduler
❌ Vector DB
❌ Robot
❌ Android
❌ 复杂 DAG
❌ Workflow DSL
❌ outcome-decompose 自动拆 Task（V0.1 用简单 Planner）
❌ goal-refine（Goal 微调，先人工）
❌ 任何外部 SaaS 依赖
```

### Outcome 层 Tool 接口（V0.1）

```
outcome.list_active(goal_id?) → Outcome[]
outcome.get(outcome_id) → Outcome + latest_evidence + progress
outcome.gap(outcome_id) → { progress, gap, unmet_criteria }
outcome.update(outcome_id, expected_version, patch)
outcome.block(outcome_id, reason)
```

### Goal 层 Tool 接口（V0.1）

```
goal.list(project_id?) → Goal[]
goal.get(goal_id) → Goal + Outcomes
goal.create(...) → Goal
goal.update(goal_id, expected_version, patch)
goal.block(goal_id, reason)
```

---

## 7. V0.1 验收标准

准备约 20–30 个真实 Coding Task。Task 必须挂在某个 Outcome 下，Outcome 必须挂在某个 Goal 下。

测试：

```
Vanilla Codex
  vs
Codex + Gollum
```

比较维度：

| 维度 | 含义 |
|---|---|
| Success Rate | 完成 / 总任务 |
| **Outcome Progress Rate** | Outcome.progress 平均推进速度 |
| False Completion | 自报完成但其实没完成 |
| Recovery Rate | 失败后成功恢复的比例 |
| Cross-session Resume | 跨 Session 恢复成功率 |
| Human Intervention | 平均需要人介入次数 |
| **Scope Creep Rate** | scope_creep 被识别的比例 |
| Token Cost | 单 Task token 消耗 |
| 完成时间 | wall-clock |

**第一阶段不要求 Gollum 一定降低 Token。**

最重要：

```
Success ↑
Outcome Progress ↑
False Completion ↓
Scope Creep ↓
Recovery ↑
Human Intervention ↓
```

---

## 8. 自主性指标

未来 Gollum Benchmark：

| 指标 | 定义 |
|---|---|
| Task Success Rate | 完成 / 总任务 |
| **Outcome Achievement Rate** | Outcome 在指定时间内 achieved 的比例 |
| **Goal Achievement Rate** | Goal 在指定时间内 achieved 的比例 |
| Human-free Duration | 单 Outcome 无人介入最长时长 |
| Human Intervention Count | 单 Outcome 平均介入次数 |
| Cross-session Resume Success Rate | 跨 Session 恢复成功率 |
| Recovery Rate | 失败后恢复比例 |
| False Completion Rate | 假完成比例 |
| Scope Creep Detection Rate | scope creep 识别率 / 实际发生率 |
| Alignment Verdict Accuracy | goal-align 判定的准确率（事后人工 audit） |
| Tool Error Rate | Tool 调用失败率 |
| Average Actions / Task | 单 Task 平均 Tool 次数 |
| Token Cost | Token 消耗 |
| Wall-clock Completion Time | 实际完成时长 |

不要单纯测「Agent 连续运行了多久」，而要测：

> **它多久不需要人介入，还能持续正确推进 Outcome。**