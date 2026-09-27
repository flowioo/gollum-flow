# 02 · Workflow 模型与 Task 状态机

## 1. 标准 Workflow 流程

```
Trigger
  ↓
Load Task
  ↓
Claim
  ↓
Resume Context
  ↓
Observe
  ↓
Evaluate
  ↓
Choose Skill
  ↓
Execute Tools
  ↓
Verify
  ↓
Checkpoint
  ↓
Complete / Wait / Block / Fail
```

这是单次 Session 的「标准呼吸」。任何 Host（Codex / CC / WorkBuddy）都按这个顺序推进。

## 2. Task 状态机（V1）

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
SUCCESS       RUNNING
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
| **SUCCESS** | 完成 | 终态 |
| **FAILED** | 达到失败边界 | 终态 |

### 关键不变量

- `RUNNING` 必须配对 `lease_until`，否则视为 Agent Crash。
- `BLOCKED` 不允许自动 unblock，必须 Human。
- `WAITING` 不持有 lease，Scheduler 可随时在 `wake_at` 时重调度。
- `VERIFYING` 是 `RUNNING` 的子状态，不是独立生命周期，但必须落 Event。

### 状态转移表（V1 建议）

| From | Event | To | Tool |
|---|---|---|---|
| PENDING | scheduler 选中 | RUNNING | `task.claim` |
| RUNNING | 等 CI / 部署 | WAITING | `task.wait` |
| RUNNING | 需人工决策 | BLOCKED | `task.block` |
| RUNNING | 开始验证 | VERIFYING | 内部 |
| RUNNING | 失败触发恢复 | RECOVERING | `task.checkpoint(reason="failure")` |
| WAITING | wake_at 到点 | RUNNING | scheduler |
| BLOCKED | 用户 unblock | RUNNING | 用户操作 |
| VERIFYING | PASS | SUCCESS | `task.complete` |
| VERIFYING | FAIL | RECOVERING | 内部 |
| RECOVERING | 重试策略选定 | RUNNING | 内部 |
| * | 重试耗尽 | FAILED | `task.fail` |