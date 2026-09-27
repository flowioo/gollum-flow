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

## 3. 第一个 Demo：Autonomous Coding Task

这是 V0.1 的真正考验。

```
Project: gollum
  └─ Goal: 让 Agent 能持续自主推进软件项目
       └─ Outcome: Agent 能跨多次 wakeup 连续推进任务
            └─ Task #1: 实现 workflow state 持久化
            └─ Task #2: Task 调度 + Lease 实现
            └─ Task #3: Verify 三态实现
            └─ ...

执行 Task #1
  ↓
Claim Task
  ↓
Execute (Codex)
  ↓
Verify (Verify PASS)
  ↓
Update Outcome.progress
  ↓
Goal Alignment Check (still aligned)
  ↓
Checkpoint
  ↓
Wait / Continue
```

### 这个 Demo 验证的关键能力

- ✅ 跨 Session
- ✅ 状态恢复
- ✅ Verify
- ✅ Failure Recovery
- ✅ Wait / Resume
- ✅ 无人值守
- ✅ **Outcome Gap 驱动调度**（新增）
- ✅ **Goal Alignment 防止跑偏**（新增）
- ✅ **Task DONE 触发 Outcome 更新**（新增）

任何一个失败 = V0.1 不通过。

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
  - 按 Outcome Gap 排序（V1.5）

Task Event Log
  - 原事件 + Outcome / Goal 层事件

6 Core Skills
  - task-run / task-resume / verify / recover
  - outcome-evaluate / goal-align

12 Core Tools
  - task.* (8 个)
  - outcome.* (2 个)
  - goal.* (2 个)

Verify: command / git / outcome-criterion

Codex Integration
```

### 不做

```
Memory Evolution（自动提炼）
Skill 自动生成
Multi-Agent
Distributed Scheduler
Vector DB
Robot
Android
复杂 DAG
Workflow DSL
outcome-decompose（自动拆 Task，先人工）
goal-refine（Goal 微调，先人工）
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