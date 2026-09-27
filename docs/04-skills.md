# 04 · Skills 设计

> Gollum V0.1 共 **6 个 Core Skills**：4 个执行层 + 2 个语义层。
> 语义层是 Outcome / Goal Alignment 的支撑。详细背景见 [09-goal-outcome-model.md](./09-goal-outcome-model.md)。

---

## 1. V0.1 六个 Core Skills

### 执行层（4 个）

#### 1.1 task-run

**职责**：第一次处理新任务。

```
Understand
  ↓
Define Success Criteria        ← 这里的"Success"是 Outcome.criterion
  ↓
Plan
  ↓
Execute
  ↓
Verify
  ↓
Checkpoint
  ↓
Update Outcome                ← 新增：Verify PASS 立刻 Update Outcome
  ↓
Goal Alignment Check          ← 新增：检查下一步是否仍服务 Goal
```

要点：

- 必须先写出 Success Criteria（Task 的 acceptance_criteria + 对应的 Outcome.criterion）再动手
- 强制走一次完整 Verify
- 结束时必须 `task.wait` / `task.complete` / `task.block` / `task.fail`
- **Task DONE 不等于完成**：必须 Update Outcome，评估 outcome.progress 是否真的变化

#### 1.2 task-resume

**职责**：跨 Session 恢复。

```
task.get(task_id)              ← 返回 Task + Outcome + Goal 完整 Context
  ↓
task.claim
  ↓
Load checkpoint
  ↓
Observe real environment
  ↓
Compare (Environment vs Checkpoint)
  ↓
Continue / Replan
```

**铁律**：不允许假设 Checkpoint 仍然有效。任何 Resume 第一动作是 Observe Environment，不是信任 summary。

**新增**：Resume 时必须重做一次 `goal-align`，确认 Outcome 仍服务 Goal（Outcome 可能已 achieved，或 Goal 可能已 abandoned）。

#### 1.3 verify

**职责**：统一验证流程。

```
Define Assertion
  ↓
Collect Evidence
  ↓
Evaluate
```

返回三态：

- **PASS**
- **FAIL**
- **UNKNOWN**

`UNKNOWN` 不允许被当作成功。

**新增**：Verify 的结果**同时**作为：

1. Task 完成判据（影响 Task.status）
2. Outcome.progress 更新依据（影响 Outcome.progress）

Verify 必须知道自己服务的 Outcome.criterion，否则不留 Evidence。

#### 1.4 recover

**职责**：失败恢复。

```
Failure
  ↓
Observe
  ↓
Classify Failure
  ↓
Identify Divergence
  ↓
Change Strategy
  ↓
Retry
  ↓
Verify
```

**禁止**「完全相同动作无限重试」。至少要改变 Strategy / 参数 / 顺序之一。

**新增**：Recover 触发时必须重新做一次 `outcome-evaluate`。可能不是 Task 失败，而是：

- Outcome 已经 achieved → Task 应该停止
- Outcome 被 Goal 替代 → 整个方向变了
- Outcome 没变化但 Task 在重试 → 策略根本错了

---

### 语义层（2 个，V0.1 推荐补上）

#### 1.5 outcome-evaluate

**职责**：判断 Outcome 当前状态，计算 remaining_gap，建议下一步动作。

**V0.1 收敛版**：不计算 progress 数字，只用状态机 + 派生属性。

```
outcome.get(outcome_id)
  ↓
load criteria[]
for each criterion:
  load latest_evidence
  criterion.derived_status = derive_status(latest_evidence)
  ↓
compute remaining_gap:
  pass = count(criterion.derived_status == PASS)
  remaining = count(criterion.derived_status != PASS)
  breakdown = { FAIL: n, UNKNOWN: n, UNVERIFIED: n }
  ↓
if all criteria PASS:
    outcome.status = VERIFIED
  else if any UNVERIFIED:
    return { needs_new_task: false, reason: "criterion missing verifier" }
  else:
    return { remaining_gap: N, needs_new_task: true }
```

调用时机：

- 每轮 Workflow 开始前
- 任何 Task DONE 时
- Outcome 进入 `VERIFIED` 候选时（最后一次评估）

实现要求：

- 必须读 evidence 表，不能凭 memory
- Gap 计算要可解释（哪条 criterion 没满足、为什么）
- `needs_new_task` 是给 Scheduler 的 hint，不是 Agent 强制执行

#### 1.6 goal-align（V0.1 三级版）

**职责**：判断当前 Outcome 是否仍然服务 Goal，当前 Task 是否仍然值得继续。

**三级判定**：

```
verdict = aligned   → continue
verdict = uncertain → re-evaluate / replan
verdict = misaligned → pause current task → rollback / backlog → choose another task
```

**双轨判断**：

```
1. Evidence-based check:
   - 过去 N 次 Execution 后，Outcome 的 remaining_gap 是否减少？
   - Criterion.derived_status 是否有 PASS？
   - 客观证据

2. LLM semantic check:
   - Task 是否直接推进 Outcome？
   - 是否偏离 Goal 方向？
   - 主观评估

verdict 取两者中最保守的：
  objective == aligned && llm == aligned   → aligned
  objective == regression || llm == misaligned → misaligned
  otherwise                                  → uncertain
```

调用时机：

- 每次新建 Task 前（强制）
- 每个 Checkpoint 时（轻量）
- Detect 到 Task 反复重试但 Outcome 不动时

**何时找 Human（V0.1 收敛版）**：

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

### V0.1 Alignment Verdict 枚举

| verdict | 含义 | 系统动作 |
|---|---|---|
| `aligned` | Task 直接推进 Outcome.criterion | continue |
| `uncertain` | 不确定或 evidence 矛盾 | re-evaluate / replan |
| `misaligned` | 与 Outcome 无关 / scope creep | pause → rollback / backlog → 换 task |

---

## 2. Skill 标准格式

不设计 Workflow DSL，全部 Markdown。建议统一：

```markdown
# Goal

# When to Use

# Inputs

# Tools

# Procedure

# Verification

# Recovery

# Completion
```

目录示例：

```
skills/core/task-resume/SKILL.md
skills/core/outcome-evaluate/SKILL.md
skills/core/goal-align/SKILL.md
```

---

## 3. Skills 全景

### V0.1 必须

| Skill | 性质 | 触发 |
|---|---|---|
| task-run | 执行 | 新 Task 首次执行 |
| task-resume | 执行 | 跨 Session 恢复 |
| verify | 执行 | Task 完成前 |
| recover | 执行 | 失败触发 |
| **outcome-evaluate** | 语义 | 每轮 Workflow 开头 |
| **goal-align** | 语义 | 新建 Task 前 / Checkpoint 时 |

### V0.5 候选

| Skill | 性质 | 触发 |
|---|---|---|
| outcome-decompose | 语义 | Outcome 创建时拆 Task |
| goal-refine | 语义 | Goal 微调 |
| evidence-audit | 语义 | 周期审计 Evidence 有效性 |
| skill-mine | 元 | 从 Event Log 提炼新 Skill |

### V1+ 候选

```
coding/github-issue
coding/pr-fix
android/app-launch
robot/pick-place
```

Skill 是开放集合，按需扩展。V0.1 6 个 Core + 覆盖 Coding Demo 即可。

---

## 4. Skill 编排（V0.1）

### 单 Task 完整周期

```
[outcome-evaluate]                 ← 判断接哪个 Outcome
   ↓
[goal-align]                       ← 新 Task 前必须
   ↓
[task-run | task-resume]
   ↓
[verify]
   ↓
[outcome-evaluate]                 ← 更新 progress
   ↓
[recover] (如失败)
```

### 失败恢复周期

```
[recover]
   ↓
[outcome-evaluate]                 ← 重新评估，可能 Task 方向错了
   ↓
[goal-align]                       ← 重新检查 Goal Alignment
   ↓
[task-run] (新策略)
```

如果失败是因为 Outcome 已经 achieved，那 Task 应该直接 complete 而不是重试。

如果失败是因为 Goal 方向变了，那应该升级到 Goal 层级决策，而不是 Task 层重试。