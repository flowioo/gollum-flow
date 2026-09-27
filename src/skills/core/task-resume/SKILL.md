# task-resume

## Goal

跨 Session 恢复 Task，**不依赖恢复 Codex/Claude Code/WorkBuddy 的 Session**。

## When to Use

- Agent 启动时被传一个 `task_id`
- 上次 Session 中途崩溃或正常退出
- Scheduler 重新接管一个 lease 过期的 Task
- 30min timer 到点唤醒一个 WAITING Task

## Inputs

```
task_id: string
agent_owner: string  // 如 "codex/session-abc"
```

## Tools

```
task.get(task_id)               → Task + Outcome + Goal
goal-align                      // 必须重新评估
outcome-evaluate
task.claim(task_id, owner)
task.checkpoint(task_id, payload)
verify.* / criterion.*
```

## Procedure

```
1. task.get(task_id)
   拿到 Task + Outcome + Goal 完整 Context
   ↓
2. 检查 Task.status：
   PENDING     → 走 task-run
   RUNNING     → lease 是否过期？
                  expired → 重新 claim
                  valid   → 异常（不应该唤醒）
   WAITING     → 评估是否到 wake_at
   BLOCKED     → 等 Human
   VERIFYING   → 走 verify 流程
   RECOVERING  → 走 recover 流程
   DONE / FAILED → 终态
   ↓
3. 重新调用 goal-align
   （Outcome 可能已 VERIFIED，Goal 可能已 achieved）
   ↓
4. 重新 outcome-evaluate
   ↓
5. 与 Checkpoint 对比
   Checkpoint.observation vs 当前 Environment
   ↓ 不一致 → 重新 Decide
   ↓ 一致 → 继续
   ↓
6. task.claim(task_id, agent_owner)
   ↓
7. 继续走 task-run 后续步骤
```

## Verification（核心铁律）

> **不允许假设 Checkpoint 仍然有效。**

每次 Resume 必须：

1. **重新 Observe Environment**（重新读 task.outcome_id / outcome / goal）
2. **对比** Checkpoint.observation 和 Environment
3. 若不一致 → 必须重新 Decide
4. **重新 goal-align**（Outcome 可能已 VERIFIED，Goal 可能已 achieved）

## Recovery

Resume 时若发现：

- Outcome 已 VERIFIED → task.complete 结束，不要重新跑
- Goal 已 achieved → task.complete 结束
- Outcome/Goal 状态已变 → 重新 outcome-evaluate
- Lease 过期但 Task 应仍 RUNNING → 重新 claim（不丢失进度）

## Completion

同 `task-run`：

- `task.complete()` / `task.wait()` / `task.block()` / `task.fail()`

必须显式 transition，**禁止** Session 退出但 Task RUNNING。