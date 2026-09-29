---
name: gollum-recover
description: |
  Systematically recover from a failed task without infinite retries.
  Classifies failure, decides action (retry / change strategy / block / abort),
  applies the action, and emits a decision event.
---

# gollum-recover

## Goal

失败后系统化恢复，避免无限重复同一动作。

## When to Use

- Verify 返回 FAIL
- Task 执行过程中遇到 Tool Error
- CAS 冲突连续 3 次（cas_thrashing）
- 任何 retry_count ≥ 3 的情况

## Inputs

```bash
TASK_ID="<task_id>"      # gollum task fail -r "<原因>" 之后调
```

## Procedure

```bash
# 1. Observe —— 先看现状，别猜
gollum task show "$TASK_ID"
gollum outcome remaining-gap <outcome_id>
```

```text
2. Classify Failure（gollum 自动做，你负责执行它的决定）
   ↓ 四类：
   a. ENV_CHANGED     → 环境漂移，重新 Observe
   b. ASSERTION_FAIL  → 假设错了，换 Strategy
   c. TOOL_ERROR      → 工具失败，换工具或降级
   d. CAS_THRASHING   → 竞争激烈，重新规划
   ↓
3. Change Strategy
   ↓ 至少改变以下之一：
      - 工具 / 参数
      - 执行顺序
      - 拆 Task 粒度
```
      - 加 Criterion
   ↓
5. Retry —— 策略由 gollum 决定，别自己拍
   ↓
gollum recover "$TASK_ID"
```

`recover` 的自动策略：

| `retry_count` | 策略 |
|---|---|
| < 3 | retry |
| 3–4 | change_strategy |
| ≥ 5 | block（等人工）|
| CAS_THRASHING | 直接 change_strategy（不看次数）|

```bash
6. Verify —— 用新策略重跑校验
   gollum verify command -c "npm test"
   gollum outcome remaining-gap <outcome_id>
   ↓
   Outcome 已 achieved  → gollum task complete "$TASK_ID"，结束
   Outcome 没变但 Task 在重试 → 策略根本错了，回到第 3 步换策略
   Goal 方向变了       → 升级到 Goal 层（见下）
```

## 恢复三大铁律

```text
1. 禁止完全相同动作无限重试
   至少改变 Strategy / 参数 / 顺序之一

2. 重新评估 Outcome（gollum outcome remaining-gap）
   可能不是 Task 失败，而是：
   - Outcome 已经 achieved（Task 该停）
   - Outcome 被别的替代（方向变了）
   - Outcome 没变但 Task 在重试（策略错了）

3. 重新对齐 Goal（gollum goal-align "$TASK_ID"）
   方向变了就该升级到 Goal 层决策
```
```

## Failure 分类参考

| failure_type | 触发 | 策略 |
|---|---|---|
| `VERIFY_FAILED` | verify.* 返回 FAIL | 重新 Decide + 换 Strategy |
| `TOOL_ERROR` | Tool 调用失败 | 换 Tool / 降级 / 重试 |
| `CAS_THRASHING` | CAS 冲突 3 次 | 升级 Planner / 等待 |
| `CRITERION_FAILED` | criterion.derived_status = FAIL | 加 Criterion 或换 Verifier |
| `ENVIRONMENT_CHANGED` | Environment 与 Checkpoint 不一致 | 重新 Observe + 重新 Decide |
| `TIMEOUT` | 执行超时 | 重试或 escalate 到 Outcome 层 |

## Completion

恢复成功后必须：

- task.checkpoint(reason="failure_recovered")
- 更新 retry_count
- 继续走 task-run 后续步骤
- 若升级到 BLOCKED → task.block(reason)

**禁止**：

- 同一个动作连续重试超过 3 次
- 在不重新 outcome-evaluate 的情况下继续重试