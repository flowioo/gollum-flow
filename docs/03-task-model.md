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
  "status": "in_progress",
  "progress": 0.4,
  "success_criteria": [
    "scheduler 唤醒后能够恢复 workflow state",
    "不会重复执行已完成 Task",
    "发生失败后能够创建新的 Execution 重试"
  ],
  "evidence_ids": ["ev-008"],
  "version": 5
}
```

字段：`id` / `goal_id` / `title` / `success_criteria` / `status: pending|in_progress|achieved|failed` / `progress: 0.0~1.0` / `evidence_ids` / `version`

`progress` 计算规则：

```
progress = verified_pass_criteria / total_criteria
```

每个 `success_criterion` 独立验证（PASS / FAIL / UNKNOWN），不能合并。

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
  "alignment_reason": "直接落实 outcome-001.criterion[1]",
  "wake_at": null,
  "retry_count": 0,
  "version": 7,
  "created_at": "...",
  "updated_at": "..."
}
```

字段：`id` / **`outcome_id`（强约束）** / `title` / `acceptance_criteria` / `status` / `priority` / `wake_at` / `version` / `alignment_verdict: aligned|marginal|misaligned|scope_creep` / `alignment_reason`

### 3.5 Execution

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

### 3.6 Evidence

```json
{
  "id": "ev-008",
  "execution_id": "exec-001",
  "outcome_id": "outcome-001",
  "criterion": "scheduler 唤醒后能够恢复 workflow state",
  "status": "PASS",
  "data": { "...": "..." },
  "observed_at": "..."
}
```

Evidence 是 Outcome.progress 变化的唯一依据。

### 3.7 Event

Append-only event log（见第 8 节）。

### 3.8 Artifact

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

Agent 收到 `STATE_CONFLICT` 必须：

```
task.get → 重新 Observe → 重新 Decide
```

**CAS 冲突时退避策略（REVIEW.md 已建议）**：

```
sleep(随机 1–3s) → task.get → 重新 Decide → 重试 update
最多 3 次，超出 → task.fail(reason="cas_thrashing")
```

并把 `STATE_CONFLICT` 单独统计到 Event Log。

---

## 6. Outcome / Goal 同步机制

### 6.1 Outcome 更新

```
outcome.update(outcome_id, expected_version, patch)
```

只有 Verify PASS 后**且 Task DONE 后**才允许调用。

### 6.2 Outcome 完成判定

```
for each criterion in success_criteria:
  evidence = latest evidence for this criterion
  if evidence.status != PASS: outcome 不算 achieved
```

**禁止**：因为所有 Task 都 DONE 就把 Outcome 标 achieved。必须每条 criterion 都有 PASS evidence。

### 6.3 Goal Alignment Check

由 `goal-align` Skill 执行，每次创建 Task 前 / Checkpoint 时调用。

返回：

```go
type AlignmentVerdict string

const (
  Aligned      AlignmentVerdict = "aligned"      // 推进 Outcome.evidence
  Marginal     AlignmentVerdict = "marginal"     // 间接推进
  Misaligned   AlignmentVerdict = "misaligned"   // 与 Outcome 无关
  ScopeCreep   AlignmentVerdict = "scope_creep"  // 偏离 Goal
)
```

`Misaligned` / `ScopeCreep` 必须经过 Human 确认才能落地。

---

## 7. Checkpoint

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
  "outcome_progress_delta": 0.33,
  "next_action": "check_ci",
  "artifacts": ["PR#456"]
}
```

新增字段 `outcome_progress_delta` — 这次 Checkpoint 让 Outcome.progress 移动了多少。

### Semantic Checkpoint 触发点

- ✅ 完成 Subgoal
- ✅ 发生 Failure
- ✅ 进入 WAITING
- ✅ 进入 BLOCKED
- ✅ 完成 Verify
- ✅ Outcome.progress 发生变化
- ✅ Goal Alignment 触发新评估
- ✅ 产生关键 Artifact（PR / 报告 / 部署）
- ✅ Session 准备结束

---

## 8. Event Log

所有重要 Workflow 行为写入 append-only Event。

### 8.1 原事件类型（保留）

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

### 8.2 新增事件（Outcome / Goal 层）

```
OUTCOME_GAP_EVALUATED       # 哪条 Outcome Gap 最大
OUTCOME_PROGRESS_UPDATED    # Outcome.progress 变化
OUTCOME_ACHIEVED            # Outcome 完成

GOAL_ALIGNMENT_CHECKED      # goal-align 调用
TASK_REJECTED_SCOPE_CREEP   # 拒绝 scope creep Task

GOAL_ACHIEVED
```

示例：

```json
{
  "task_id": "task-001",
  "outcome_id": "outcome-001",
  "event": "OUTCOME_PROGRESS_UPDATED",
  "actor": "codex/session-123",
  "payload": {
    "outcome_id": "outcome-001",
    "old_progress": 0.33,
    "new_progress": 0.66,
    "criterion": "scheduler 唤醒后能够恢复 workflow state",
    "evidence_id": "ev-008",
    "verdict": "PASS"
  },
  "timestamp": "..."
}
```

---

## 9. Task 与 Session 的关系

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

## 10. Outcome Gap 评估接口

V0.1 暴露给 Scheduler：

```
outcome.list_active(goal_id) → Outcome[]
outcome.gap(outcome_id) → { progress: 0.4, gap: 0.6, criteria_unmet: [...] }
```

`outcome.gap` 让 Scheduler 能按 Gap 大小调度，而不是按 Task 创建时间。