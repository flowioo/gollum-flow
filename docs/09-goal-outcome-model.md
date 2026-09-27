# 09 · Goal / Outcome / Criteria 模型 — 语义层核心

> **核心原则（V0.1 收敛版）**
>
> **Progress is not a number. Progress is verified state change.**
> **进展不是一个百分比，而是被证据验证过的状态变化。**

这条原则直接砍掉了 `progress = pass / total` 这种**容易被优化**的数字指标（Goodhart's Law），改用**状态机**描述进展。

---

## 1. 七层模型

```
Goal           = 为什么做          (Direction)
   ↓
Outcome        = 想改变什么状态    (State to change)
   ↓
Criteria       = 什么算完成        (Definition of done)
   ↓
Evidence       = 凭什么说完成      (Proof)
   ↓
Task           = 怎么推进          (Action)
   ↓
Execution      = 一次尝试          (Attempt)
   ↓
Verify         = 验证              (Truth check)
```

### 关键词

| 概念 | 定义 | 角色 |
|---|---|---|
| Project | 顶层容器 | 工作域 |
| Goal | 长期方向 | **为什么做** |
| Outcome | 可验证阶段结果 | **想改变什么状态** |
| Criteria | 完成判据列表 | **什么算完成** |
| Evidence | 验证结果 | **凭什么说完成** |
| Task | 推进 Outcome 的具体行动 | **怎么推进** |
| Execution | Task 的一次执行尝试 | **一次尝试** |
| Verify | 把假设变成事实 | **验证** |

---

## 2. Outcome 状态机（V0.1 收敛版）

```
NOT_STARTED
    │
    ▼
IN_PROGRESS ─────► BLOCKED ─────► IN_PROGRESS
    │
    ├──► VERIFIED   ← 所有 Criteria 都有 PASS evidence
    │
    └──► FAILED     ← 达到失败边界
```

### 状态语义

| 状态 | 含义 | 转移条件 |
|---|---|---|
| **NOT_STARTED** | Outcome 已创建，无 Task 启动 | 第一个 Task RUNNING → IN_PROGRESS |
| **IN_PROGRESS** | 至少有一个 Task 启动 | 见下表 |
| **BLOCKED** | 等待 Human 解决边界问题 | Human unblock → IN_PROGRESS |
| **VERIFIED** | 所有 Criteria 都派生 PASS | 终态 |
| **FAILED** | 达到失败边界 | 终态 |

### 状态转移表

| From | To | 触发条件 |
|---|---|---|
| NOT_STARTED | IN_PROGRESS | 第一个关联 Task 进入 RUNNING |
| IN_PROGRESS | VERIFIED | **所有** Criteria 的 `derived_status == PASS` |
| IN_PROGRESS | FAILED | Outcome 失败边界（Human 判定 或 criteria 全部 FAIL 且不可重试） |
| IN_PROGRESS | BLOCKED | 需要 Human 改变边界（Goal 修改 / 删 Outcome / 扩大 scope / 不可逆操作） |
| BLOCKED | IN_PROGRESS | Human unblock |
| VERIFIED | IN_PROGRESS | 极少见：Goal 调整导致 Criteria 重定义 |
| FAILED | IN_PROGRESS | 极少见：Goal 调整允许重新尝试 |

> **关键**：VERIFIED **不依赖 progress 数字**。只看所有 Criteria 是否都有 PASS evidence。

---

## 3. Criteria 三段式绑定

每条 Criterion 必须绑定一个 Verifier。**没有 Verifier 的 Criterion 标 `UNVERIFIED`**（不能用）。

```yaml
criterion:
  id: c1
  description: "system runs without crash for 4 hours"

  # 三段式绑定核心
  verifier:
    type: timer_check
    config:
      duration: "4h"
      signal_source: "event_log"

  latest_evidence:
    id: ev-001
    observed_at: "..."
    status: PASS
    data:
      crash_count: 0
      duration_seconds: 14400

  derived_status: PASS   # 从 latest_evidence.status 自动推导
```

### Criterion 状态（derived）

| derived_status | 含义 | 来源 |
|---|---|---|
| **UNVERIFIED** | 没有绑定 Verifier 或 Verifier 未运行 | `verifier == null` 或 `latest_evidence == null` |
| **PASS** | Evidence 支持完成 | `latest_evidence.status == PASS` |
| **FAIL** | Evidence 反驳完成 | `latest_evidence.status == FAIL` |
| **UNKNOWN** | Evidence 不足或矛盾 | `latest_evidence.status == UNKNOWN` 或多 evidence 冲突 |

### Verifier 三段式校验逻辑

```
criterion → verifier?  →  没有 Verifier → UNVERIFIED（不能 VERIFY Outcome）
              ↓
              有 → evidence?
                       ↓
                       没有 → UNKNOWN（evidence 不足）
                       ↓
                       有 → evidence.status 决定 PASS/FAIL/UNKNOWN
```

> **核心**：CLI 不做语义裁判（不检测「稳定」「高效」），只做**结构校验**（criterion 必须有 verifier/evidence 绑定路径）。
> 「稳定运行 4 小时」看似模糊，但有 `timer_check` 绑定 → **可验证**，不是「模糊」。
> 真正「不能验证」的 criterion 是那些没有 Verifier 的，标 `UNVERIFIED` 提醒补 Verifier。

### 模糊词的正确处理

```yaml
# ❌ 旧做法：CLI 检测模糊词，警告/拒绝
- description: "系统稳定运行 4 小时"
  ⏰ warning: 包含模糊词「稳定」

# ✅ 新做法：criterion 通过 verifier 绑定证明「稳定」是可验证的
- description: "system runs without crash for 4 hours"
  verifier:
    type: timer_check
    config: { duration: "4h", signal_source: "event_log" }
  → 这是合法的 criterion，不算模糊
```

模糊词的正确处理是 **绑定可执行的 verifier**，不是 NLP 文本检测。

---

## 4. 数据模型（V0.1 收敛版）

### 4.1 Outcome

```json
{
  "id": "outcome-001",
  "goal_id": "goal-001",
  "title": "Agent 能跨多次 wakeup 连续推进任务",
  "status": "IN_PROGRESS",
  "criteria_ids": ["c1", "c2", "c3"],
  "version": 5
}
```

**砍掉的字段**：
- ~~`success_criteria`~~（JSON list）→ 拆成独立表 `criteria`
- ~~`progress`~~（0.0~1.0）→ 完全砍掉，用 criteria 状态推断
- ~~`evidence_ids`~~ → 移到 `evidence` 表，`evidence.criterion_id` 关联

### 4.2 Criterion（独立表）

```json
{
  "id": "c1",
  "outcome_id": "outcome-001",
  "description": "scheduler 唤醒后能够恢复 workflow state",
  "verifier": {
    "type": "outcome_criterion",
    "config": { "...": "..." }
  },
  "latest_evidence_id": "ev-008",
  "derived_status": "PASS",
  "version": 3
}
```

字段：`id` / `outcome_id` / `description` / `verifier: VerifierSpec | null` / `latest_evidence_id` / `derived_status: UNVERIFIED|PASS|FAIL|UNKNOWN`

### 4.3 Verifier Spec

```json
{
  "type": "outcome_criterion",
  "config": { "...": "..." }
}
```

支持的 verifier type（V0.1）：

| type | 用途 | config 示例 |
|---|---|---|
| `command` | 运行 shell 命令 | `{ "command": "pytest", "cwd": "." }` |
| `git` | Git 状态检查 | `{ "branch": "main", "expect": "clean" }` |
| `outcome_criterion` | 关联其他 outcome / criterion | `{ "ref_type": "outcome", "ref_id": "outcome-002" }` |
| `timer_check` | 等待 N 秒不崩 | `{ "duration": "4h", "signal_source": "event_log" }` |
| `human_assert` | Human 主观确认 | `{ "question": "..." }` |

### 4.4 Evidence

```json
{
  "id": "ev-008",
  "criterion_id": "c1",
  "executor": "codex/session-123",
  "status": "PASS",
  "data": { "...": "..." },
  "observed_at": "..."
}
```

字段：`id` / `criterion_id` / `executor` / `status: PASS|FAIL|UNKNOWN` / `data` / `observed_at`

> Evidence 总是挂在 **Criterion** 上，不挂在 Task 上。
> Task 完成 → 触发 Verify → Verify 调用 Criterion 的 verifier → 产出 Evidence → 更新 Criterion.derived_status → 触发 Outcome 状态评估

### 4.5 Outcome VERIFIED 判定

```
outcome_is_verified(outcome) =
  for each criterion in outcome.criteria:
    if criterion.derived_status != PASS:
      return false
  return true
```

**禁止**：因为所有 Task 都 DONE 就把 Outcome 标 VERIFIED。**必须每条 Criterion 都有 PASS evidence。**

---

## 5. 为什么砍掉 progress score

### 5.1 Goodhart's Law

> **When a measure becomes a target, it ceases to be a good measure.**
> **指标一旦成为目标，就不再是好指标。**

`progress = pass / total` 一旦成为 Scheduler 优化目标，Agent 就会：

- 拆更多容易完成的 criteria（刷高 progress）
- 挑 criteria 数量少的 Outcome（少做事高 progress）
- 把 criterion 拆细（看起来动了但实际没动）

### 5.2 替代方案：状态 + 派生属性

```
Outcome.status    = 状态机当前位置（NOT_STARTED / IN_PROGRESS / BLOCKED / VERIFIED / FAILED）
Criterion.derived_status = 从最新 evidence 推导（UNVERIFIED / PASS / FAIL / UNKNOWN）
remaining_gap    = Criterion 中 derived_status != PASS 的数量
```

Scheduler 调度的依据：

```
选择下一个 Outcome:
  1. priority 高
  2. status == IN_PROGRESS（不要选 BLOCKED / VERIFIED / FAILED）
  3. remaining_gap > 0（有可执行 gap）
  4. 没有 blocker
  5. 最能推进 Goal（goal-align verdict == aligned）
```

**不看 83%**。

---

## 6. goal-align 三级（V0.1 收敛版）

### 6.1 三级判定

| verdict | 含义 | 系统动作 |
|---|---|---|
| **aligned** | 推进 Outcome | continue |
| **uncertain** | 主观不确定或 evidence 矛盾 | re-evaluate / replan |
| **misaligned** | 与 Outcome 无关或 scope creep | pause current task → rollback / backlog → choose another task |

### 6.2 双轨判断

```
1. Evidence-based check:
   - 过去 N 次 Execution 后，Outcome 的 remaining_gap 是否减少？
   - Criterion.derived_status 是否有 PASS？
   - 客观证据

2. LLM semantic check:
   - Task 是否直接推进 Outcome？
   - 是否偏离 Goal 方向？
   - 主观评估
```

verdict 取两者中最保守的：

```
objective == aligned && llm == aligned   → aligned
objective == regression || llm == misaligned → misaligned
otherwise                                  → uncertain
```

### 6.3 何时找 Human（核心变化）

> **Human 负责改变边界，不负责日常纠偏。**

只有这些情况找 Human：

- Goal 本身需要修改
- Outcome 定义需要删除/新增重大范围
- 需求冲突无法自行解决
- 不可逆操作
- 高风险操作

**`misaligned` 默认不找人**，而是自己处理：

```
misaligned
  ↓
pause current task
  ↓
rollback / backlog
  ↓
choose another task
```

自主性不被频繁打断。

---

## 7. Outcome / Goal Layer Tools（V0.1）

### Outcome 层

```
outcome.list_active(goal_id?) → Outcome[]
outcome.get(outcome_id) → Outcome + criteria[] + remaining_gap
outcome.criteria(outcome_id) → Criterion[]
outcome.start(outcome_id) → state transition NOT_STARTED → IN_PROGRESS
outcome.mark_verified(outcome_id) → 校验所有 criteria PASS 后置 VERIFIED
outcome.mark_failed(outcome_id, reason)
outcome.block(outcome_id, reason) → IN_PROGRESS → BLOCKED
outcome.unblock(outcome_id) → BLOCKED → IN_PROGRESS
```

### Goal 层

```
goal.list(project_id?) → Goal[]
goal.get(goal_id) → Goal + Outcomes[]
goal.create(...) → Goal
goal.update(goal_id, expected_version, patch)
goal.block(goal_id, reason)  // 修改 Goal 边界 → Human
goal.achieve(goal_id)  // 所有 Outcome VERIFIED 后自动调用
```

### Criterion 层（新增）

```
criterion.create(outcome_id, description, verifier) → Criterion
criterion.get(criterion_id) → Criterion + latest_evidence
criterion.list(outcome_id) → Criterion[]
criterion.attach_evidence(criterion_id, evidence) → 更新 derived_status
```

### Evidence 层（新增）

```
evidence.create(criterion_id, executor, status, data) → Evidence
evidence.list(criterion_id) → Evidence[]
```

---

## 8. 七层模型关系图

```
                   Project
                      │
                    Goal                   = Direction
                      │
               ┌──────┴──────┐
            Outcome        Outcome          = State to change
               │
        ┌──────┴──────┐
     Criteria       Criteria               = Definition of done
        │
        ▼
   ┌────────┐    ┌────────┐
   │Verifier│ → │Evidence│                  = Proof
   └────────┘    └────────┘
        ▲
        │
     (Verify Skill 调用)
        │
       Task                                       = Action
        │
     Execution                                    = Attempt
```

**强约束**：

- Task 必须属于某个 Outcome
- Criterion 必须属于某个 Outcome
- Criterion 必须绑定 Verifier 才能 valid（否则 UNVERIFIED）
- Evidence 必须挂在 Criterion 上
- Outcome VERIFIED 要求所有 Criterion 都有 PASS evidence

**禁止的边**：

- Goal → Task（必须经过 Outcome）
- Outcome → Task（Task 必须挂 Criterion 吗？V0.1 不强制，V0.5 建议关联）
- Criterion → Task 直接（Task 通过 Verify 间接产出 Evidence）

---

## 9. 与现有设计的关系

| 现有设计 | 影响 |
|---|---|
| Outcome 数据模型 | 砍掉 `progress`；`success_criteria` JSON 拆成独立 `criteria` 表 |
| Workflow 循环 | "Update Outcome" 步骤：从更新 progress 改为更新 criterion.derived_status |
| Skills | `outcome-evaluate` 改：基于 criteria 状态评估，不算 progress |
| Skills | `goal-align` 改三级：aligned / uncertain / misaligned |
| Scheduler | 调度依据：priority + blockers + remaining_gap，不看 progress 数字 |
| Verify | 调用 Criterion.verifier 产出 Evidence |
| Event Log | 新增 `CRITERION_VERIFIED`、`CRITERION_UNVERIFIED`、`OUTCOME_VERIFIED` 等 |
| ToolResult 协议 | 不变 |

### 兼容路径

V0.1 直接落地新模型，不做迁移（这是新项目，没有历史负担）。

---

## 10. 关键词表（V0.1 收敛版）

| 概念 | 定义 | 角色 |
|---|---|---|
| Project | 顶层容器 | 工作域 |
| Goal | 长期方向 | **为什么做** |
| Outcome | 可验证阶段结果 | **想改变什么状态** |
| Criteria | 完成判据列表 | **什么算完成** |
| Evidence | 验证结果 | **凭什么说完成** |
| Task | 推进 Outcome 的具体行动 | **怎么推进** |
| Execution | Task 的一次执行尝试 | **一次尝试** |
| Verify | 把假设变成事实 | **验证** |
| Verifier | 验证器规格 | **怎么验证** |
| Goal Alignment | Outcome 是否仍服务 Goal | **方向校准** |

> **一句话**：Goal 是方向，Outcome 是状态，Criteria 是定义，Evidence 是证明，Task 是动作，Execution 是尝试，Verify 是验证，Verifier 是验证方法。