# goal-align

## Goal

判断当前 Outcome 是否仍然服务 Goal，当前 Task 是否仍然值得继续。

## When to Use

- 每次新建 Task 前（强制）
- 每个 Checkpoint 时（轻量）
- Detect 到 Task 反复重试但 Outcome 不动时

## Inputs

```
task_id: string
outcome_id: string
goal_id: string
```

## Tools

```
goal.get(goal_id)
outcome.get(outcome_id)
outcome.remaining_gap(outcome_id)    // 看客观进展
event_log(outcome_id, last_n=10)     // 看最近执行历史
```

## Procedure（三级判定）

```
1. Evidence-based check（客观）
   读 outcome.remaining_gap
   读 event log（last 10 events on this outcome）
   评估：过去 N 次 Execution 后，remaining_gap 是否减少？
         Criterion.derived_status 是否有 PASS？
   ↓
   objective = "aligned" | "regression" | "neutral"
   ↓
2. LLM semantic check（主观）
   - Task 是否直接推进 Outcome？
   - 是否偏离 Goal 方向？
   - 是否出现 scope creep（想去重构 Runtime 等）？
   ↓
   llm = "aligned" | "misaligned" | "uncertain"
   ↓
3. 取两者中最保守的 verdict：
   objective == aligned && llm == aligned       → aligned
   objective == regression || llm == misaligned → misaligned
   otherwise                                    → uncertain
```

## 三级动作

| verdict | 含义 | 系统动作 |
|---|---|---|
| `aligned` | 推进 Outcome | continue |
| `uncertain` | 不确定 / evidence 矛盾 | re-evaluate / replan |
| `misaligned` | 与 Outcome 无关 / scope creep | pause current task → rollback / backlog → 换 task |

## Misaligned 处理流程（核心变化）

> **`misaligned` 默认不找人**。Agent 自己 pause / rollback / backlog / 换 task。

```
misaligned
  ↓
task.update(task_id, version, { status: 'PENDING' })  // pause
  ↓
emit TASK_REJECTED_MISALIGNED event
  ↓
选另一个 task（同类 outcome 或换 outcome）
  ↓
不找人，Agent 自处理
```

## 何时找 Human（Human Boundary）

> **Human 负责改变边界，不负责日常纠偏。**

只有这些情况找 Human：

```
- 修改 Goal（goal.update 改 title/description）
- 删除关键 Outcome
- 扩大 Outcome scope（新增 criteria）
- 不可逆操作
- 高风险操作
```

调用方式：`task.block(task_id, reason, context)`

## Verification

`goal-align` 自身不验证。它是决策判断，不产出 evidence。

但每次调用都 emit `GOAL_ALIGNMENT_CHECKED` event：

```json
{
  "task_id": "...",
  "outcome_id": "...",
  "verdict": "aligned | uncertain | misaligned",
  "objective": "aligned | regression | neutral",
  "llm": "aligned | misaligned | uncertain",
  "reason": "..."
}
```

## Recovery

`goal-align` 自身不失败。如果 LLM 调用失败：

- fallback 到 objective-only 判定
- 若 objective 也不确定 → 返回 `uncertain`

## Completion

调用完 `goal-align` 后必须：

- 返回 verdict + reason
- 落 Event
- 调用方根据 verdict 执行下一步