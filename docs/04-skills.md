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

**职责**：判断 Outcome 是否已经完成，当前 Gap 是什么，需不需要新增 Task。

```
outcome.get(outcome_id)
  ↓
load latest evidence for each criterion
  ↓
compute progress (pass / total)
  ↓
compute gap (1 - progress, weighted by importance)
  ↓
return {
  progress,
  gap,
  unmet_criteria,
  needs_new_task: bool,
  reason
}
```

调用时机：

- 每轮 Workflow 开始前
- 任何 Task DONE 时
- Outcome 进入 `achieved` 候选时（最后一次评估）

实现要求：

- 必须读 evidence 表，不能凭 memory
- Gap 计算要可解释（哪个 criterion 没满足）
- `needs_new_task` 是给 Scheduler 的 hint，不是 Agent 自己强制执行

#### 1.6 goal-align

**职责**：判断当前 Outcome 是否仍然服务 Goal，当前 Task 是否仍然值得继续，是否出现 scope creep。

```
load Goal.description
load Outcome.success_criteria
load candidate Task.acceptance_criteria
  ↓
evaluate: does Task.material_advance(criterion)?
  ↓
evaluate: does Outcome.still_serve(Goal)?
  ↓
return AlignmentVerdict {
  verdict: aligned | marginal | misaligned | scope_creep,
  reason: string,
  confidence: 0.0~1.0
}
```

调用时机：

- 每次新建 Task 前（强制）
- 每个 Checkpoint 时（轻量）
- Detect 到 Task 反复重试但 Outcome 不动时

**强制规则**：

```
verdict == misaligned  → Task 必须经 Human 确认才能落地
verdict == scope_creep → Task 直接拒绝（reject / backlog）
verdict == marginal    → 自动继续，但记入 Event Log
verdict == aligned     → 自动继续
```

### V1 Alignment Verdict 枚举

| verdict | 含义 | 系统动作 |
|---|---|---|
| `aligned` | Task 直接推进 Outcome.criterion | 自动继续 |
| `marginal` | 间接推进，技术上合理但 Outcome 影响弱 | 自动继续，记 Event |
| `misaligned` | 与当前 Outcome 无关 | 经 Human 确认 |
| `scope_creep` | 偏离 Goal 方向 | 直接拒绝 |

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