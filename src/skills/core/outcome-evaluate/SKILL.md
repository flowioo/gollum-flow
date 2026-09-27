# outcome-evaluate

## Goal

判断 Outcome 当前状态，计算 remaining_gap，建议下一步动作。

## When to Use

- 每轮 Workflow 开始前
- 任何 Task DONE 后
- Outcome 进入 `VERIFIED` 候选时（最后一次评估）
- 重新决策前

## Inputs

```
outcome_id: string
```

## Tools

```
outcome.get(outcome_id)              → Outcome + criteria[]
outcome.remaining_gap(outcome_id)    → { total, pass, fail, unknown, unverified, remaining }
criterion.list(outcome_id)
criterion.get(criterion_id)
evidence.list(criterion_id)
outcome.mark_verified(outcome_id)    // 自动 VERIFIED 当所有 criterion PASS
```

## Procedure

```
1. outcome.get(outcome_id)
   拿到 Outcome + criteria[]
   ↓
2. outcome.remaining_gap(outcome_id)
   ↓
   gap.remaining = fail + unknown + unverified
   ↓
3. 评估 Outcome.status：
   a. 所有 criterion.derived_status == PASS
      → outcome.mark_verified(outcome_id)
      → 触发 GOAL_ACHIEVED 检查
      → needs_new_task = false
   b. 任一 criterion.derived_status == UNVERIFIED
      → needs_new_task = false
      → reason = "criterion missing verifier, attach verifier first"
   c. 否则（还有 fail/unknown）
      → needs_new_task = true
      → reason = "{remaining} criteria not PASS, need task to address them"
   ↓
4. 返回结果给 Scheduler：
   {
     outcome_id,
     status,
     remaining_gap,
     needs_new_task,
     reason
   }
```

## 关键原则（V0.1 收敛版）

> **Progress is not a number. Progress is verified state change.**
> **进展不是一个百分比，而是被证据验证过的状态变化。**

**砍掉 progress 数字**。只用：

```
Outcome.status           = NOT_STARTED / IN_PROGRESS / BLOCKED / VERIFIED / FAILED
Criterion.derived_status = UNVERIFIED / PASS / FAIL / UNKNOWN
remaining_gap.remaining  = count(criterion.derived_status != PASS)
```

**Goodhart's Law 防御**：

`progress = pass/total` 一旦成为调度目标，Agent 会拆 criteria 刷分。所以直接砍掉。

## Verification

`outcome-evaluate` 自身不验证。它只是状态评估，不产出 evidence。

## Recovery

`outcome-evaluate` 报错时（DB 错误、状态不一致）：

```
1. 重新 outcome.get 确认数据一致
2. 检查 criteria.verifier 绑定是否完整
3. 检查 evidence 是否正确 attach
4. 若 Outcome 状态机矛盾 → 升级到 recover Skill
```

## Completion

调用完 `outcome-evaluate` 后必须：

- 返回结果给调用方（Scheduler 或其他 Skill）
- 若 outcome 已 VERIFIED → 触发 `goal.achieve` 检查
- task.checkpoint(criteria_delta)（如适用）