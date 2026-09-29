---
name: gollum-outcome-evaluate
description: |
  Evaluate an Outcome's current state: compute remaining_gap (which criteria
  are still unverified), and recommend the next concrete action
  (continue / split / replan / pause).
---

# gollum-outcome-evaluate

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

## CLI

```bash
gollum outcome show "$OUTCOME_ID"              # Outcome + criteria
gollum outcome remaining-gap "$OUTCOME_ID"     # { total, pass, fail, unknown, unverified, remaining }
gollum criterion list --outcome-id "$OUTCOME_ID"
gollum evidence list
gollum outcome mark-verified "$OUTCOME_ID"     # 所有 criterion PASS 时自动 VERIFIED
```

## Procedure

```bash
# 1. 拿到 Outcome + criteria
gollum outcome show "$OUTCOME_ID"

# 2. 看还差什么
gollum remaining=$(
gollum outcome remaining-gap "$OUTCOME_ID" | grep '"remaining"'
)
#   gap.remaining = fail + unknown + unverified
```

```text
3. 评估状态：
   a. 所有 criterion PASS
      → gollum outcome mark-verified "$OUTCOME_ID"
      → 触发 GOAL_ACHIEVED 检查
      → needs_new_task = false
   b. 任一 criterion UNVERIFIED（没绑 verifier）
      → needs_new_task = false
      → 先补 verifier：
        gollum criterion create -o "$OUTCOME_ID" -d "..." \
          --verifier-type command --verifier-config '{"command":"npm test"}'
   c. 还有 fail / unknown
      → 有在跑的 task？gollum task list --outcome-id "$OUTCOME_ID"
      → 有 → 继续推进那个
      → 无 → 拆新 task：gollum task create -o "$OUTCOME_ID" -t "..." --acceptance "..."
      → needs_new_task = true
      → reason = "{remaining} criteria not PASS, need task to address them"
```

```text
4. 返回结果给 Scheduler：
   { outcome_id, status, remaining_gap, needs_new_task, reason }
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