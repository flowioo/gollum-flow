# 02 · Workflow 模型与 Task 状态机

## 1. 语义层先于状态层

> **核心原则**
> **Agent 不以"完成 Task"作为进展，而以"改变 Outcome"作为进展。**

详细 Goal / Outcome 设计见 [09-goal-outcome-model.md](./09-goal-outcome-model.md)。本节只覆盖「执行层」的状态机。

层次结构（语义层 → 执行层）：

```
Project
  └─ Goal
       └─ Outcome           ← Evidence of Progress
            └─ Task         ← Action
                 └─ Execution  ← Attempt
```

**强约束**：Task 必须属于某个 Outcome。不允许 `Goal → Task` 直连。

---

## 2. 标准 Workflow 流程（升级版）

```
Trigger
   ↓
Load Project / Goal            ← 新增：每次唤醒带 Goal Context
   ↓
Load active Outcomes           ← 新增：看活跃 Outcomes 列表
   ↓
Observe current state
   ↓
Evaluate Outcome Gap           ← 新增：哪个 Outcome Gap 最大？
   ↓
Select Outcome                 ← 新增：按 Gap 大小选
   ↓
Select / Create Task
   ↓
Claim Task
   ↓
Execute
   ↓
Verify
   ↓
Update Task
   ↓
Update Outcome                 ← 新增：用 evidence 更新 Outcome.progress
   ↓
Goal Alignment Check           ← 新增：检查是否跑偏
   ↓
Checkpoint
   ↓
Wait / Continue / Complete
```

### 新增步骤的语义

- **Load Project / Goal**：每次唤醒必须先知道在做什么方向，避免执行层一上来就选 Task 跑偏。
- **Evaluate Outcome Gap**：不是先问「下一个 Task 是什么」，而是「哪个 Outcome 距离完成最远」。按 Gap 大小选，而非按 Task 创建顺序选。
- **Update Outcome**：Verify PASS 后不仅更新 Task，也要更新 Outcome 的 `progress` 和 `evidence_ids`。Outcome 才是进展单位。
- **Goal Alignment Check**：每次完成一轮自检「Task 在推进 / Outcome 仍服务 / 没偏离 Goal」。出现 Task 很忙但 Outcome 没动，立刻触发 recover。

---

## 3. Task 状态机（执行层）

```
PENDING
   │
   ▼
RUNNING
   │
   ├─────────────┐
   │             │
   ▼             ▼
WAITING       BLOCKED
   │             │
   ▼             ▼
RUNNING       RUNNING
   │
   ├─────────────┐
   │             │
   ▼             ▼
VERIFYING     RECOVERING
   │             │
   ▼             ▼
DONE          RUNNING
   │
   └─────────────┐
                 ▼
               FAILED
```

> 注：原方案中「SUCCESS」改名为「DONE」，与 Outcome 的 `achieved` 状态做语义区分。
> - **Task.DONE** = 这件事完成了
> - **Outcome.achieved** = 这个阶段成果成立了
> - **Goal.achieved** = 长期目标达成

### 状态语义

| 状态 | 含义 | 下一步触发 |
|---|---|---|
| **PENDING** | 等待第一次执行 | Trigger（Timer / Event / Human） |
| **RUNNING** | Agent 正在执行 | Agent 主动 transition |
| **WAITING** | 等待外部条件（CI / 部署 / 邮件 / 充电） | `wake_at` 到点 / Event 触发 |
| **BLOCKED** | 必须等用户（付款 / 删生产 / 缺权限 / 重大歧义） | 用户 unblock |
| **VERIFYING** | 正在执行 Verify 子流程 | Verify 结果（PASS/FAIL/UNKNOWN） |
| **RECOVERING** | 失败后重新 Observe + Replan | 回到 RUNNING 或 FAILED |
| **DONE** | 完成 | 终态（但要触发 Update Outcome） |
| **FAILED** | 达到失败边界 | 终态 |

### 关键不变量

- `RUNNING` 必须配对 `lease_until`，否则视为 Agent Crash。
- `BLOCKED` 不允许自动 unblock，必须 Human。
- `WAITING` 不持有 lease，Scheduler 可随时在 `wake_at` 时重调度。
- `VERIFYING` 是 `RUNNING` 的子状态，不是独立生命周期，但必须落 Event。
- **Task DONE 不等于 Outcome achieved**。DONE 后必须立刻 Update Outcome，让 Outcome 评估是否真的推进。

### 状态转移表

| From | Event | To | Tool |
|---|---|---|---|
| PENDING | scheduler 选中 | RUNNING | `task.claim` |
| RUNNING | 等 CI / 部署 | WAITING | `task.wait` |
| RUNNING | 需人工决策 | BLOCKED | `task.block` |
| RUNNING | 开始验证 | VERIFYING | 内部 |
| RUNNING | 失败触发恢复 | RECOVERING | `task.checkpoint(reason="failure")` |
| WAITING | wake_at 到点 | RUNNING | scheduler |
| BLOCKED | 用户 unblock | RUNNING | 用户操作 |
| VERIFYING | PASS | DONE | `task.complete` → 立刻 `outcome.update` |
| VERIFYING | FAIL | RECOVERING | 内部 |
| RECOVERING | 重试策略选定 | RUNNING | 内部 |
| DONE | Outcome.update 后 | （终态） | 触发 outcome-evaluate |
| * | 重试耗尽 | FAILED | `task.fail` |