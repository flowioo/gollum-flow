# recover

## Goal

失败后系统化恢复，避免无限重复同一动作。

## When to Use

- Verify 返回 FAIL
- Task 执行过程中遇到 Tool Error
- CAS 冲突连续 3 次（cas_thrashing）
- 任何 retry_count ≥ 3 的情况

## Inputs

```
task_id: string
failure_type: 'VERIFY_FAILED' | 'TOOL_ERROR' | 'CAS_THRASHING' | 'CRITERION_FAILED'
error: Record<string, unknown>
```

## Procedure

```
1. Observe
   ↓ 重新读 Task + Outcome + Goal + 上次 Checkpoint
2. Classify Failure
   ↓ 分四类：
   a. ENV_CHANGED     → Environment 漂移，重新 Observe
   b. ASSERTION_FAIL  → 假设错了，换 Strategy
   c. TOOL_ERROR      → Tool 调用失败，换 tool 或降级
   d. CAS_THRASHING   → 竞争激烈，升级到 Planner 重新规划
   ↓
3. Identify Divergence
   ↓ 找出期望 vs 实际的差异点
   ↓
4. Change Strategy
   ↓ 至少改变以下之一：
      - 工具 / 参数
      - 执行顺序
      - 拆 Task 粒度
      - 加 Criterion
   ↓
5. Retry
   ↓
   retry_count < 3  → 直接重试新策略
   retry_count ≥ 3  → 升级到 Outcome 层决策
   retry_count ≥ 5  → BLOCKED
   ↓
6. Verify
   ↓ 用 verify Skill 重新验证
   ↓
   若 Outcome 已 achieved → task.complete 直接结束
   若 Outcome 没变但 Task 在重试 → 策略根本错了
   若 Goal 方向变了 → 升级到 Goal 层
```

## Recovery 三大铁律

```
1. 禁止完全相同动作无限重试
   至少改变 Strategy / 参数 / 顺序之一

2. 重新 outcome-evaluate
   可能不是 Task 失败，而是：
   - Outcome 已经 achieved（Task 应停止）
   - Outcome 被 Goal 替代（方向变了）
   - Outcome 没变化但 Task 在重试（策略错了）

3. 重新 goal-align
   可能 Goal 方向变了，需要升级到 Goal 层决策
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