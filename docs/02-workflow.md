# 02 · Workflow 模型与 Task 状态机

## 1. 语义层先于状态层

> **核心原则**
> **Agent 不以"完成 Task"作为进展，而以"改变 Outcome"作为进展。**

详细 Goal / Outcome 设计见 [09-goal-outcome-model.md](./09-goal-outcome-model.md)。
本节覆盖「执行层」的状态机。

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

## 2. Task 定义（V0.1 调整版）

> **Task = 能在有限时间内独立执行、独立验证、失败可重试，并对某个 Outcome 产生明确增量的最小工作单元。**

**关键属性**：

| 属性 | 含义 |
|---|---|
| **有限时间** | 目标 10–30min。预计 > 30min 必须由 Planner 优先拆分 |
| **独立执行** | 不依赖其他 Task 的中间状态（除非显式声明） |
| **独立验证** | 有自己的 `acceptance_criteria`，对应一个 Verify Tool 调用 |
| **失败可重试** | 幂等 or 显式声明副作用可回滚 |
| **明确 Outcome 增量** | Verify PASS 后 Outcome.progress 有可量化的变化 |

**为什么不与「Session 长度」绑定**：

> 业务 Task 应该按「结果是否独立、可验证」拆，而不是按「Agent 能连续干多久」拆。
> 一个 Session 可能跑多个 Task；一个 Task 也可能被多个 Session 接力。
> **业务 Task ≠ 执行器寿命。**

---

## 3. 标准 Workflow 流程

```
Trigger
   ↓
Load Project / Goal
   ↓
Load active Outcomes
   ↓
Observe current state
   ↓
Evaluate Outcome Gap
   ↓
Select Outcome
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
Update Outcome
   ↓
Goal Alignment Check
   ↓
Checkpoint
   ↓
Wait / Continue / Complete
```

详细见 [03-task-model.md](./03-task-model.md) 和 [09-goal-outcome-model.md](./09-goal-outcome-model.md)。

---

## 4. Task 状态机（执行层）

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

### 状态语义

| 状态 | 含义 | 下一步触发 |
|---|---|---|
| **PENDING** | 等待第一次执行 | Trigger（Timer / Event / Human） |
| **RUNNING** | Agent 正在执行 | Agent 主动 transition |
| **WAITING** | 等待外部条件（CI / 部署 / 邮件 / 充电） | `wake_at` 到点 / Event 触发 |
| **BLOCKED** | 必须等用户（付款 / 删生产 / 缺权限 / 重大歧义） | 用户 unblock |
| **VERIFYING** | 正在执行 Verify 子流程 | Verify 结果（PASS/FAIL/UNKNOWN） |
| **RECOVERING** | 失败后重新 Observe + Replan | 回到 RUNNING 或 FAILED |
| **DONE** | 完成 | 终态（触发 Update Outcome） |
| **FAILED** | 达到失败边界 | 终态 |

### 关键不变量

- `RUNNING` 必须配对 `lease_until`，否则视为 Agent Crash。
- `BLOCKED` 不允许自动 unblock，必须 Human。
- `WAITING` 不持有 lease，Scheduler 可随时在 `wake_at` 时重调度。
- `VERIFYING` 是 `RUNNING` 的子状态，不是独立生命周期。
- **Task DONE 不等于 Outcome achieved**。DONE 后立刻 Update Outcome。

### 状态转移表

| From | Event | To | Tool |
|---|---|---|---|
| PENDING | scheduler 选中 | RUNNING | `task.claim` |
| RUNNING | 等外部条件 | WAITING | `task.wait` |
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