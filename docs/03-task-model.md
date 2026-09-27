# 03 · Task 数据模型与同步机制

## 1. Task 示例

```json
{
  "id": "task-001",
  "goal": "fix GitHub issue #321",

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

### 字段含义

| 字段 | 用途 |
|---|---|
| `id` | Task 全局唯一标识，长期存在 |
| `goal` | 原始目标（人类可读） |
| `status` | 状态机当前位置 |
| `phase` | 在该状态内的子阶段（如 `wait_ci` / `implement` / `recover`） |
| `version` | CAS 用，单调递增 |
| `next_action` | Resume 时第一个动作 hint |
| `summary` | 最近一次 Checkpoint 的一句话总结 |
| `last_observation` | 最近一次 Observe 的客观事实 |
| `retry_count` | 当前失败链已重试次数 |
| `wake_at` | WAITING 时被唤醒的时间 |
| `owner` | 当前持有 lease 的 agent/session id |
| `lease_until` | lease 到期时间 |

## 2. 存储选型

V1 推荐 **SQLite**：

- 单文件，零部署
- 支持事务 + CAS 乐观锁
- 足够撑住 1k 并发 Task

表结构：

```
tasks
task_events        -- append-only event log
checkpoints        -- semantic checkpoint, JSON blob
evidence           -- verify 出来的物证
leases             -- 当前 lease 状态（也可放 tasks 内）
artifacts          -- PR URL / file path / 截图 等
```

## 3. 同步机制

### 3.1 获取 Task

```
task.get(task_id) → Task JSON
```

### 3.2 Claim Task

执行前必须 Claim：

```
task.claim(task_id) →
  owner = "codex/session-xxx"
  lease_until = now + 15 min
```

作用：防止多 Agent 同时执行同一 Task。

### 3.3 Lease

```
Agent claim
  → lease_until = now + 15min

Agent 正常退出 → release lease
Agent 崩溃     → lease 自动 expire
Scheduler       → 重新接管
```

Lease 不是永久锁。Agent 可以死，Task 不会死。

**Lease 时长建议**：

- Coding Agent：15 min（单次 LLM 调用很少超过 10 min）
- Phone Agent：5 min（交互动作密集，频繁 checkpoint）
- Robot Agent：2 min（实时性要求高）

## 4. CAS Version

所有 Task 更新走 CAS：

```
task.update(task_id, expected_version, patch)
  → version: 17 → 18
  → STATE_CONFLICT if version 已被改
```

Agent 收到 `STATE_CONFLICT` 必须：

```
task.get()
  ↓
重新 Observe
  ↓
重新 Decide
```

禁止盲目重试。

## 5. Checkpoint

不要记录 Agent 的全部 reasoning。Checkpoint 只记录：

```
发生了什么
当前状态
关键 Evidence
下一步做什么
```

```json
{
  "task_id": "task-001",
  "phase": "wait_ci",
  "summary": "Implemented idempotency fix and opened PR #456.",
  "observation": "CI currently running.",
  "next_action": "check_ci",
  "artifacts": ["PR#456"]
}
```

### Semantic Checkpoint 触发点

不是每次 Tool 调用都保存。只在：

- ✅ 完成 Subgoal
- ✅ 发生 Failure
- ✅ 进入 WAITING
- ✅ 进入 BLOCKED
- ✅ 完成 Verify
- ✅ 产生关键 Artifact（PR / 报告 / 部署）
- ✅ Session 准备结束

控制写入成本。

## 6. Event Log

所有重要 Workflow 行为写入 append-only Event：

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

示例：

```json
{
  "task_id": "task-001",
  "event": "VERIFY_FAILED",
  "actor": "codex/session-123",
  "payload": {
    "assertion": "CI passes",
    "evidence_id": "ev-008"
  },
  "timestamp": "..."
}
```

Event Log 后续可用于：Observability / Evaluation / Failure Analysis / Skill Mining / Self Evolution。

## 7. Task 与 Session 的关系

```
Task
 ├── Session 1: Codex
 ├── Session 2: Codex
 ├── Session 3: Claude Code
 └── Session 4: WorkBuddy
```

Task ID = 核心标识
Session ID = Trace 信息

这是「Conversation ≠ State」的物理体现。