# 03 · 数据模型：Project / Goal / Outcome / Task / Execution

## 1. 四层关系

```
Project
  └─ 1:N Goal

Goal
  └─ 1:N Outcome

Outcome
  └─ 1:N Task

Task
  └─ 1:N Execution

Execution
  └─ 1:N Evidence
```

详细语义定义见 [09-goal-outcome-model.md](./09-goal-outcome-model.md)。本节聚焦**数据模型**。

---

## 2. 存储选型

V1 推荐 **SQLite + WAL**：

- 单文件，零部署
- 支持事务 + CAS 乐观锁
- 足够撑住 1k 并发 Task
- WAL 让读不阻塞写

核心表：

```
projects
goals
outcomes
tasks
executions
events
artifacts
evidence
```

---

## 3. 各层数据模型

### 3.1 Project

```json
{
  "id": "project-001",
  "name": "gollum",
  "description": "Gollum core development",
  "created_at": "...",
  "updated_at": "..."
}
```

### 3.2 Goal

```json
{
  "id": "goal-001",
  "project_id": "project-001",
  "title": "让 Agent 能持续自主推进软件项目",
  "description": "能够周期性唤醒、判断当前状态、继续推进，直到目标完成",
  "status": "active",
  "created_at": "...",
  "updated_at": "..."
}
```

字段：`id` / `project_id` / `title` / `description` / `status: active|achieved|abandoned`

### 3.3 Outcome

```json
{
  "id": "outcome-001",
  "goal_id": "goal-001",
  "title": "Agent 能跨多次 wakeup 连续推进任务",
  "status": "IN_PROGRESS",
  "criteria_ids": ["c1", "c2", "c3"],
  "version": 5
}
```

字段：`id` / `goal_id` / `title` / `status: NOT_STARTED|IN_PROGRESS|BLOCKED|VERIFIED|FAILED` / `criteria_ids` / `version`

**砍掉的字段**（V0.1 收敛版）：

- ❌ `success_criteria`（JSON list）→ 拆成独立 `criteria` 表
- ❌ `progress`（0.0~1.0）→ 完全砍掉（**Goodhart's Law**：指标变目标就不再是好指标）
- ❌ `evidence_ids` → 移到 `evidence` 表，通过 `evidence.criterion_id` 关联

`progress` 计算用 **状态机 + Criterion 派生状态** 替代：

```
Outcome.status           = NOT_STARTED / IN_PROGRESS / BLOCKED / VERIFIED / FAILED
Criterion.derived_status = UNVERIFIED / PASS / FAIL / UNKNOWN
remaining_gap            = count(criterion.derived_status != PASS)
```

Outcome VERIFIED 判定：

```
outcome_is_verified = for each criterion: derived_status == PASS
```

### 3.4 Task

```json
{
  "id": "task-001",
  "outcome_id": "outcome-001",
  "title": "实现 workflow state 持久化",
  "status": "running",
  "priority": 1,
  "acceptance_criteria": [
    "进程退出后重新启动能恢复当前 phase",
    "已完成 Task 不重复执行"
  ],
  "alignment_verdict": "aligned",
  "alignment_reason": "直接落实 outcome-001.criterion[c1]",
  "wake_at": null,
  "retry_count": 0,
  "version": 7,
  "created_at": "...",
  "updated_at": "..."
}
```

字段：`id` / **`outcome_id`（强约束）** / `title` / `acceptance_criteria` / `status` / `priority` / `wake_at` / `version` / `alignment_verdict: aligned|uncertain|misaligned` / `alignment_reason`

### 3.5 Criterion（V0.1 新增独立表）

```json
{
  "id": "c1",
  "outcome_id": "outcome-001",
  "description": "scheduler 唤醒后能够恢复 workflow state",
  "verifier": {
    "type": "outcome_criterion",
    "config": { "...": "..." }
  },
  "latest_evidence_id": "ev-008",
  "derived_status": "PASS",
  "version": 3
}
```

字段：`id` / `outcome_id` / `description` / **`verifier: VerifierSpec | null`** / `latest_evidence_id` / `derived_status: UNVERIFIED|PASS|FAIL|UNKNOWN` / `version`

**强约束**：

- criterion 必填 `verifier`，否则 `derived_status = UNVERIFIED`
- `derived_status` 自动从 `latest_evidence.status` 推导，不可手设
- `derived_status == UNVERIFIED` 的 criterion 让 Outcome 无法 VERIFIED

### 3.6 Verifier Spec

```json
{
  "type": "command | git | outcome_criterion | timer_check | human_assert",
  "config": { "...": "..." }
}
```

V0.1 支持的 type：

| type | config 示例 |
|---|---|
| `command` | `{ "command": "pytest", "cwd": "." }` |
| `git` | `{ "branch": "main", "expect": "clean" }` |
| `outcome_criterion` | `{ "ref_type": "outcome", "ref_id": "outcome-002" }` |
| `timer_check` | `{ "duration": "4h", "signal_source": "event_log" }` |
| `human_assert` | `{ "question": "..." }` |

### 3.7 Evidence（V0.1 重构）

```json
{
  "id": "ev-008",
  "criterion_id": "c1",
  "executor": "codex/session-123",
  "status": "PASS",
  "data": { "...": "..." },
  "observed_at": "..."
}
```

字段：`id` / **`criterion_id`** / `executor` / `status: PASS|FAIL|UNKNOWN` / `data` / `observed_at`

> Evidence 挂在 **Criterion** 上（不是 Task）。Task 通过 Verify 调用 Criterion.verifier 产出 Evidence。

### 3.8 Execution

```json
{
  "id": "exec-001",
  "task_id": "task-001",
  "executor": "codex",
  "session_id": "session-abc",
  "started_at": "...",
  "finished_at": "...",
  "result": "PASS",
  "error": null,
  "retry_of": null
}
```

字段：`id` / `task_id` / `executor: codex|claude-code|workbuddy` / `session_id`（trace only） / `started_at` / `finished_at` / `result: PASS|FAIL|UNKNOWN` / `error` / `retry_of: execution_id`

### 3.9 Artifact

PR URL / file path / screenshot 等引用，不存原始内容。

---

## 4. Task 示例（含 Outcome 归属）

```json
{
  "id": "task-001",
  "outcome_id": "outcome-001",
  "goal_id": "goal-001",
  "title": "fix GitHub issue #321",
  "status": "WAITING",
  "phase": "wait_ci",
  "version": 17,
  "next_action": "check_ci",
  "summary": "PR #456 submitted, waiting for CI",
  "last_observation": "CI running",
  "retry_count": 1,
  "wake_at": "2026-09-28T10:30:00",
  "owner": null,
  "lease_until": null,
  "created_at": "...",
  "updated_at": "..."
}
```

> 注：实际存储里 `goal_id` 由 `outcome_id` 反查，不冗余存储。这里展示用。

### 字段含义

| 字段 | 用途 |
|---|---|
| `id` | Task 全局唯一标识，长期存在（**但 Task 不是项目核心标识，Outcome / Goal 才是**） |
| `outcome_id` | 强约束：必须属于某个 Outcome |
| `title` | 这件具体的事 |
| `status` | 执行层状态机当前位置 |
| `phase` | 在该状态内的子阶段 |
| `version` | CAS 用 |
| `next_action` | Resume 时第一个动作 hint |
| `summary` | 最近一次 Checkpoint 一句话总结 |
| `last_observation` | 最近一次 Observe 客观事实 |
| `retry_count` | 当前失败链已重试次数 |
| `wake_at` | WAITING 时被唤醒的时间 |
| `owner` / `lease_until` | 当前 lease 持有 |
| `alignment_verdict` | goal-align Skill 给出的判断 |

---

## 5. 同步机制

### 5.1 获取 Task

```
task.get(task_id) →
  Task + Outcome + Goal
```

> Resume 时必须一次性返回 Goal Context，否则 Agent 拿不到方向。

### 5.2 Claim Task

```
task.claim(task_id) →
  owner = "codex/session-xxx"
  lease_until = now + 15 min
```

### 5.3 Lease

```
Agent claim    → lease_until = now + 15min
正常退出       → release lease
崩溃           → lease 自动 expire
Scheduler      → 重新接管
```

**Lease 时长建议**：

| 场景 | Lease |
|---|---|
| Coding Agent | 15 min |
| Phone Agent | 5 min |
| Robot Agent | 2 min |

### 5.4 CAS Version

```
task.update(task_id, expected_version, patch)
  → version: 17 → 18
  → STATE_CONFLICT if version 已变
```

#### Agent 收到 STATE_CONFLICT 必须执行

```
reload latest state            ← task.get(task_id)
  ↓
jitter backoff 1–3s             ← sleep(随机 1–3s)
  ↓
re-evaluate                    ← 重新 Decide：基于最新 state，原 patch 可能已经过时
  ↓
CAS retry ≤ 3
```

**绝对禁止**：拿到 STATE_CONFLICT 后**简单拿原 patch 数据重试**。patch 基于的是过期 state，原封不动重试大概率还是会冲突，或者覆盖了别人正确的更新。

**3 次仍冲突**：

```
→ task.block(reason="cas_thrashing") 或 task.fail(reason="cas_thrashing")
→ 触发 Planner 重新规划
→ 不要无限循环消耗 lease
```

把 `STATE_CONFLICT` 单独统计到 Event Log，用于诊断 thrashing。

---

## 6. Progress 替代方案（V0.1 收敛版）

### 6.1 砍掉 progress score

> **Progress is not a number. Progress is verified state change.**
> **进展不是一个百分比，而是被证据验证过的状态变化。**

### 6.2 替代状态表达

```
Outcome.status           = NOT_STARTED / IN_PROGRESS / BLOCKED / VERIFIED / FAILED
Criterion.derived_status = UNVERIFIED / PASS / FAIL / UNKNOWN
remaining_gap            = count(criterion.derived_status != PASS)
```

### 6.3 Scheduler 调度依据（替代 progress）

```
选择下一个 Outcome:
  1. status == IN_PROGRESS
  2. priority 高
  3. remaining_gap > 0
  4. 没有 blocker
  5. goal-align verdict == aligned
```

**不看 83%**。

### 6.4 Goodhart's Law 防御

`progress = pass/total` 一旦成为调度目标，Agent 会：

- 拆更多容易完成的 criteria
- 挑 criteria 数量少的 Outcome
- 把 criterion 拆细刷分

所以直接砍掉，改用状态机 + 派生属性。Agent 不能优化一个数字，只能优化**真实的状态变化**。

---

## 7. Task 定义（V0.1 最终）

> **Task = 能在有限时间内独立执行、独立验证、失败可重试，并对某个 Outcome 产生明确增量的最小工作单元。**

### 6.0 五项硬性属性

| 属性 | 含义 | Planner 怎么判断 |
|---|---|---|
| **有限时间** | 10–30min 目标 | 估算 > 30min → 强制拆分 |
| **独立执行** | 不依赖其他 Task 的中间状态 | 检查 input deps |
| **独立验证** | 有 acceptance_criteria + 可调 Verify Tool | 必须至少一条 verify.* 调用 |
| **失败可重试** | 幂等 or 显式声明可回滚 | 检查 side effect list |
| **明确 Outcome 增量** | Verify PASS 后 Criterion 派生状态变化 | criterion.verifier 绑定 + evidence 产出 |

### 6.0.1 Task 不与 Session 绑定

- 一个 Session 可跑多个 Task
- 一个 Task 可被多个 Session 接力
- Task **不关心**是谁在跑、跑了多久
- Session 寿命与 Task 寿命完全解耦

### 6.0.2 拆分规则

```
预计 > 30min
  → Planner 必须先拆，拆完才能 claim

预计 < 5min
  → 警告：Task 太小，可能 overhead > value
  → 建议合并到相邻 Task
```

### 6.0.3 重试规则

```
Task.retry_count < 3  → 直接重试（同策略）
Task.retry_count ≥ 3  → 触发 recover Skill，换 Strategy
Task.retry_count ≥ 5  → BLOCKED（升级到 Outcome 层决策）
```

---

## 7. Outcome / Goal 同步机制

### 7.1 Outcome 更新

```
outcome.update(outcome_id, expected_version, patch)
```

只有 Verify PASS 后**且 Task DONE 后**才允许调用。

### 7.2 Outcome VERIFIED 判定

```
for each criterion in outcome.criteria:
  if criterion.derived_status != PASS:
    return VERIFIED 不成立
return VERIFIED
```

**禁止**：因为所有 Task 都 DONE 就把 Outcome 标 VERIFIED。必须每条 Criterion 都有 PASS evidence。

### 7.3 Goal Alignment Check（三级版）

由 `goal-align` Skill 执行，每次创建 Task 前 / Checkpoint 时调用。

返回：

```go
type AlignmentVerdict string

const (
  Aligned    AlignmentVerdict = "aligned"     // 推进 Outcome.criterion
  Uncertain  AlignmentVerdict = "uncertain"   // 不确定或 evidence 矛盾
  Misaligned AlignmentVerdict = "misaligned"  // 与 Outcome 无关 / scope creep
)
```

**三级动作**：

| verdict | 系统动作 |
|---|---|
| `aligned` | continue |
| `uncertain` | re-evaluate / replan |
| `misaligned` | pause current task → rollback / backlog → choose another task |

**`misaligned` 不找人**。Human 只在改变边界时介入（修改 Goal / 删关键 Outcome / 扩大 scope / 不可逆操作）。

详见 [09-goal-outcome-model.md §6](./09-goal-outcome-model.md)。

---

## 8. Checkpoint

不要记录 Agent 全部 reasoning。Checkpoint 只记录：

```
发生了什么
当前状态
关键 Evidence
下一步做什么
```

```json
{
  "task_id": "task-001",
  "outcome_id": "outcome-001",
  "phase": "wait_ci",
  "summary": "Implemented idempotency fix and opened PR #456.",
  "observation": "CI currently running.",
  "criteria_delta": {
    "c1": { "from": "FAIL", "to": "PASS", "evidence_id": "ev-008" }
  },
  "next_action": "check_ci",
  "artifacts": ["PR#456"]
}
```

新增字段 `criteria_delta` — 这次 Checkpoint 让 Criterion.derived_status 发生了哪些变化。**不存 progress 数字**。

### Semantic Checkpoint 触发点

- ✅ 完成 Subgoal
- ✅ 发生 Failure
- ✅ 进入 WAITING
- ✅ 进入 BLOCKED
- ✅ 完成 Verify
- ✅ Outcome.progress 发生变化 → 改为 **Criterion.derived_status 发生变化**
- ✅ Goal Alignment 触发新评估
- ✅ 产生关键 Artifact（PR / 报告 / 部署）
- ✅ Session 准备结束

---

## 9. Event Log

所有重要 Workflow 行为写入 append-only Event。

### 9.1 原事件类型（保留）

```
TASK_CREATED
TASK_CLAIMED
TASK_RESUMED

ACTION_STARTED
ACTION_COMPLETED

CHECKPOINT_CREATED

VERIFY_STARTED
VERIFY_PASSED
VERIFY_FAILED

RECOVERY_STARTED

TASK_WAITING
TASK_BLOCKED

TASK_COMPLETED
TASK_FAILED
```

### 9.2 新增事件（Outcome / Criterion / Goal 层）

```
CRITERION_VERIFIED               # criterion.derived_status → PASS
CRITERION_FAILED                 # criterion.derived_status → FAIL
CRITERION_UNVERIFIED             # criterion 没绑定 verifier

OUTCOME_REMAINING_GAP_EVALUATED  # remaining_gap 计算
OUTCOME_VERIFIED                 # Outcome.status → VERIFIED
OUTCOME_BLOCKED                  # Outcome.status → BLOCKED
OUTCOME_FAILED                   # Outcome.status → FAILED

GOAL_ALIGNMENT_CHECKED           # goal-align 调用（aligned/uncertain/misaligned）
TASK_REJECTED_MISALIGNED         # misaligned → pause/backlog

GOAL_ACHIEVED
```

示例：

```json
{
  "task_id": "task-001",
  "outcome_id": "outcome-001",
  "event": "CRITERION_VERIFIED",
  "actor": "codex/session-123",
  "payload": {
    "criterion_id": "c1",
    "from_status": "FAIL",
    "to_status": "PASS",
    "evidence_id": "ev-008",
    "verifier_type": "command"
  },
  "timestamp": "..."
}
```

---

## 10. Task 与 Session 的关系

```
Task
 ├── Session 1: Codex
 ├── Session 2: Codex
 ├── Session 3: Claude Code
 └── Session 4: WorkBuddy
```

**Task ID = 局部标识**（执行单元）
**Outcome ID = 业务单元**
**Goal ID = 战略单元**
**Project ID = 顶层容器**

Session ID 仍然是 Trace 信息。

---

## 11. Outcome Gap 评估接口（V0.1 收敛版）

V0.1 暴露给 Scheduler：

```
outcome.list_active(goal_id) → Outcome[]
outcome.remaining_gap(outcome_id) → {
  total_criteria: 5,
  pass_count: 2,
  fail_count: 1,
  unknown_count: 0,
  unverified_count: 2,
  remaining: 4       // FAIL + UNKNOWN + UNVERIFIED
}
```

Scheduler 不再看 `progress` 数字，而是看 `remaining_gap.remaining` 和 priority。

替代旧接口 `outcome.gap()` 中的 `progress` 字段。