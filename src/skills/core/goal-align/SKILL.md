---
name: gollum-goal-align
description: |
  Decide whether the current Outcome still serves the Goal, and whether the
  current Task is still worth continuing. Returns ALIGNED / UNCERTAIN /
  MISALIGNED, with rationale. Run before committing major work or when the
  user changes direction.
---

# gollum-goal-align

## Goal

判断当前 Outcome 是否仍然服务 Goal，当前 Task 是否仍然值得继续。

## When to Use

- 每次新建 Task 前（强制）
- 每个 Checkpoint 时（轻量）
- Detect 到 Task 反复重试但 Outcome 不动时

## Inputs

```bash
TASK_ID="<task_id>"     # 或直接给 <outcome_id> / <goal_id>
```

## Procedure

```bash
# 一步到位：传 task_id，它会自己向上找 outcome / goal
gollum goal-align "$TASK_ID"
```

返回三态：

```json
{
  "task_id": "...",
  "objective": "aligned",      // 规则判定：所有 criterion PASS 且 outcome 已 VERIFIED
  "llm": "misaligned",         // 语义判定：与 outcome 措辞无重叠
  "verdict": "misaligned",
  "reason": "objective=aligned (...); llm=misaligned (no word overlap ...)",
  "confidence": 0.6
}
```

`objective` 和 `llm` 是两路独立判断，`verdict` 取更保守的那个。**分歧时以你（Agent）的判断为准**，因为 `llm` 那路目前只是词面匹配。

## 按 verdict 处理

```text
aligned     → 继续干活
uncertain   → gollum handle-uncertain "$TASK_ID"     # 落一条 replan 信号，task 继续跑
misaligned  → gollum handle-misaligned "$TASK_ID"   # pause + rollback + 换 task
```

```bash
# misaligned 的处理：不会升级找人，自己处理
gollum handle-misaligned "$TASK_ID"

# uncertain 的处理：task 不暂停，只落一条 replan 信号（PRD §15 同理不找人）
gollum handle-uncertain "$TASK_ID"
```

## 什么时候必须问人

只有这些情况才需要停下来问用户：

- 修改 Goal
- 扩大 Scope
- 删除关键 Outcome
- 不可逆操作
- 高风险行为
- 无法判断的需求冲突

其余的（跑偏了、该拆了）**自己处理**，不要甩给用户。

> **Human 负责边界，Steward 负责日常纠偏。**

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
- 检查 `gollum events list` 确认落了 `GOAL_ALIGNMENT_CHECKED` 事件
- 调用方根据 verdict 执行下一步