# task-run

## Goal

首次处理一个新 Task，按 Gollum 标准流程推进到完成或受控失败。

## When to Use

- Agent 拿到一个状态为 `PENDING` 的 Task
- Scheduler 选中并 claim 该 Task
- 不用于跨 Session 恢复（用 `task-resume`）

## Inputs

```typescript
{
  task_id: string
  // 通过 task.get(task_id) 自动加载
}
```

加载后 Agent 拿到：
- `task`：Task 实体（含 acceptance_criteria）
- `outcome`：Outcome 实体（含 criteria_ids）
- `goal`：Goal 实体
- Criterion 列表（如有）
- 上次 Checkpoint（如有）

## Tools

```
task.get(task_id)               → Task + Outcome + Goal
goal-align                      → AlignmentVerdict
outcome-evaluate                → remaining_gap
task.claim(task_id, owner)      → RUNNING + lease
task.checkpoint(task_id, payload)
task.complete(task_id)          → DONE
task.fail(task_id, reason)      → FAILED
task.wait(task_id, wake_at)     → WAITING
task.block(task_id, reason)     → BLOCKED
verify.command / verify.git / verify.outcome_criterion
criterion.create / criterion.attach_evidence
outcome.mark_verified
```

## Procedure

```
1. task.get(task_id)
   ↓
2. goal-align(task, outcome, goal)  // 必须 aligned 才能继续
   ↓ misaligned → pause + rollback + 换 task（不找人）
   ↓ uncertain  → re-evaluate / replan
   ↓ aligned    → continue
4. outcome-evaluate(outcome)
   ↓
5. 读 acceptance_criteria 列表
   ↓
6. 对每条 acceptance_criteria：
   a. 选定 verify tool（command / git / outcome_criterion）
   b. 执行 verify → 得到 evidence
   c. criterion.attach_evidence(criterion_id, evidence)
   d. outcome-evaluate 重新评估
   ↓
7. 当 outcome_remaining_gap.remaining == 0
   ↓
8. outcome.mark_verified(outcome_id)
   ↓
9. task.complete(task_id)
   ↓
10. task.checkpoint(task_id, summary)
```

## Verification

每个 acceptance_criterion 都需要：

- 至少一个 verify.* 调用产生 evidence
- evidence attach 到对应 criterion（V0.1 可不强求 1:1，但 Outcome VERIFIED 必须每条 criterion 都有 PASS evidence）
- 最终 outcome.mark_verified 成功

## Recovery

失败时：

```
1. 重新 outcome-evaluate → 看 remaining_gap 是否真的减少
2. 若 remaining_gap 没变 → recover Skill（不要重复同一动作）
3. 若 outcome 已 VERIFIED → task.complete 直接结束，不要继续
4. 若 outcome 被 Goal 替代 → 升级到 Goal 层决策
```

## Completion

必须进入以下一种状态：

- `task.complete()` → DONE
- `task.wait(wake_at)` → WAITING
- `task.block(reason)` → BLOCKED（仅限需要改变边界的情况）
- `task.fail(reason)` → FAILED

**禁止**：Session 退出但 Task 仍 RUNNING。