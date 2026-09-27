# 09 · Goal / Outcome 模型 — 语义层核心

> **核心原则**
> **Agent 不以"完成 Task"作为进展，而以"改变 Outcome"作为进展。**

这是 Gollum 语义层的最重要升级。在 Task 之上引入 Goal 和 Outcome 两层，让 Agent 能长期对齐方向、抵御 scope creep、用 Outcome Gap 驱动调度，而不是被一堆忙忙碌碌的 Task 拖偏。

---

## 1. 关键词

| 概念 | 定义 | 角色 |
|---|---|---|
| **Project** | 顶层容器 | 一个 Project = 一个独立工作域 |
| **Goal** | 长期方向 | **Direction** |
| **Outcome** | 可验证的阶段结果 | **Evidence of Progress** |
| **Task** | 推进 Outcome 的具体行动 | **Action** |
| **Execution** | Task 的一次执行尝试 | **Attempt** |
| **Verify** | 把 Outcome 假设变成事实 | **Truth** |
| **Evidence** | Verify 留下的物证 | 唯一可信信号 |

---

## 2. 四层结构

```
                   Project
                      │
                    Goal
                      │
               ┌──────┴──────┐
            Outcome        Outcome
               │
          ┌────┴────┐
        Task       Task
          │
     Execution
          │
        Verify
          │
      Evidence
```

### 2.1 Project

```
project:
  id: project-001
  name: "gollum"
  description: "Gollum core development"
```

### 2.2 Goal

长期目标。**尽量稳定，不因一次执行变化。**

```
goal:
  id: goal-001
  project_id: project-001
  title: "让 Agent 能持续自主推进软件项目"
  description: "能够周期性唤醒、判断当前状态、继续推进，直到目标完成"
  status: active          # active | achieved | abandoned
```

**回答**：最终想实现什么？

### 2.3 Outcome

Goal 的**可验证阶段结果**。不是「改进体验」「提高稳定性」这种空话，而是**会出现什么事实**才能说明 Goal 向前推进了。

```
outcome:
  id: outcome-001
  goal_id: goal-001
  title: "Agent 能跨多次 wakeup 连续推进任务"
  status: in_progress     # pending | in_progress | achieved | failed
  progress: 0.4           # 0.0 ~ 1.0
  success_criteria:
    - "scheduler 唤醒后能够恢复 workflow state"
    - "不会重复执行已完成 Task"
    - "发生失败后能够创建新的 Execution 重试"
  evidence:               # 累计证据
    - evidence_id: ev-008
      criterion: "scheduler 唤醒后能够恢复 workflow state"
      status: PASS
      observed_at: "..."
```

**回答**：出现什么事实，才能说明 Goal 确实向前推进了？

**强约束**：

| ❌ 不能写 | ✅ 应该写 |
|---|---|
| 提高 Agent 稳定性 | 连续运行 4 小时，发生一次 Tool failure 后自动恢复，最终 Verify PASS |
| 改善代码质量 | Pylint 分数从 6.2 → 9.0，全部模块 ≥ 8.0 |
| 支持更多场景 | 在 5 个真实 Android 应用上完成 20 个目标任务，Human Intervention ≤ 2 次/Task |

每一个 `success_criterion` 必须是 **可观察、可验证、可证伪** 的事实。

### 2.4 Task

推进某个 Outcome 的具体行动。

```
task:
  id: task-001
  outcome_id: outcome-001        # 强约束：必须属于某个 Outcome
  title: "实现 workflow state 持久化"
  status: running                # pending | running | waiting | blocked | done | failed
  priority: 1
  acceptance_criteria:
    - "进程退出后重新启动能恢复当前 phase"
    - "已完成 Task 不重复执行"
  wake_at: null
  retry_count: 0
  version: 7
```

**强约束**：

> **Task 必须属于某个 Outcome。**
> 不允许 `Goal → Task` 直连。
> 只能 `Goal → Outcome → Task`。

Agent 新建 Task 时必须回答：**这个 Task 在推进哪个 Outcome？** 答不上来，就不应该创建。

### 2.5 Execution

Task 的一次执行尝试。保持现有设计。

```
Task
  ├── Execution #1 → FAIL
  ├── Execution #2 → FAIL
  └── Execution #3 → PASS
```

- **Task 是业务事实**（要做什么事）
- **Execution 是 Host 的一次运行**（谁、用什么、怎么跑的）

**继续坚持原则**：

> 不依赖恢复 Codex / Claude Code / WorkBuddy 的 Session。
> 失败后重新启动新的 Execution 即可。

最终：

```
Verify PASS → Task DONE
```

而不是：

```
Codex 说 done → Task DONE
```

---

## 3. Workflow 主循环（升级版）

原版：

```
Trigger
  → Load Task
  → Resume
  → Observe
  → Decide
  → Act
  → Verify
  → Checkpoint
```

升级版：

```
Trigger
   ↓
Load Project / Goal
   ↓
Load active Outcomes
   ↓
Observe current state
   ↓
Evaluate Outcome Gap      ← 新增
   ↓
Select Outcome            ← 新增：哪个 Outcome Gap 最大就做哪个
   ↓
Select / Create Task
   ↓
Claim Task
   ↓
Execute
   ↓
Verify
   ↓
Update Task
   ↓
Update Outcome            ← 新增：用 evidence 更新 Outcome.progress
   ↓
Goal Alignment Check      ← 新增：Task 在推进 / Outcome 仍服务 Goal 吗？
   ↓
Checkpoint
   ↓
Wait / Continue / Complete
```

### 3.1 Outcome Gap 评估

每轮不是先问「下一个 Task 是什么？」，而是问：

> **哪个 Outcome 距离完成还有最大 Gap？**

然后才产生 Task。

### 3.2 Goal Alignment Check

每完成一轮，都检查：

```
当前 Task
   ↓
推进了 Outcome 吗？
   ↓
Outcome 仍然服务于 Goal 吗？
```

如果出现：

```
Task 很忙
Outcome 没变化
```

说明可能已经跑偏。

---

## 4. 防止"技术性跑偏"（scope creep 防御）

这对 Coding Agent 特别重要。

### 场景示例

```
Goal:
  发布 gollum v1

Outcome:
  支持 Codex 跨 wakeup 持续执行任务

Task:
  修复 state restore
```

Codex 执行过程中发现：

```
EventBus 写得不好
  ↓
想：重构 EventBus
  → 抽象 MessageBus
  → 增加插件机制
  → 重写 Runtime
```

这些事情**技术上都"合理"**，但系统必须问：

> **Does this task materially advance outcome-001?**

如果只是「以后可能更优雅」，则：

```
reject / backlog
```

这会**显著降低长期 Agent 的 scope creep**。

### 检测机制

每次创建新 Task，必须由 `goal-align` Skill 给出 verdict：

```go
type AlignmentVerdict string

const (
  Aligned       AlignmentVerdict = "aligned"        // 推进 Outcome.evidence
  Marginal      AlignmentVerdict = "marginal"       // 间接推进，weakly
  Misaligned    AlignmentVerdict = "misaligned"     // 与 Outcome 无关
  ScopeCreep    AlignmentVerdict = "scope_creep"    // 偏离 Goal 方向
)
```

`Misaligned` / `ScopeCreep` 必须经过 Human 确认才能落地。

---

## 5. Store 数据模型

SQLite Workflow Store 仍然是唯一事实来源。

核心表：

```
projects
goals
outcomes
tasks
executions
events
artifacts
evidence
```

### 关系

```
Project
  └─ 1:N Goal

Goal
  └─ 1:N Outcome

Outcome
  └─ 1:N Task

Task
  └─ 1:N Execution

Execution
  └─ 1:N Evidence

Task / Outcome / Execution
  └─ 1:N Event
```

### 关键字段

#### Goal

```
- id
- project_id
- title
- description
- status            # active | achieved | abandoned
- created_at
- updated_at
```

#### Outcome

```
- id
- goal_id
- title
- success_criteria   # JSON list, each is verifiable claim
- status             # pending | in_progress | achieved | failed
- progress           # 0.0 ~ 1.0, derived from criteria verification
- evidence_ids       # JSON list, refs to evidence rows
- version            # CAS
```

#### Task

```
- id
- outcome_id         # 强约束
- title
- acceptance_criteria
- status
- priority
- wake_at
- version
- alignment_verdict    # aligned | marginal | misaligned | scope_creep
- alignment_reason     # goal-align Skill 的解释
```

#### Execution

```
- id
- task_id
- executor            # codex | claude-code | workbuddy
- session_id          # trace only
- started_at
- finished_at
- result              # PASS | FAIL | UNKNOWN
- error               # ToolResult.error
- retry_of            # execution_id（用于重试链）
```

---

## 6. Scheduler 行为

Scheduler 唤醒单位**仍然是 Task**，但带 Goal + Outcome Context。

```
Scheduler
  ↓
find wakeable Task
  ↓
load Task
  ↓
反查 Outcome
  ↓
反查 Goal
  ↓
带 Goal Context 执行
```

关键区分：

| 维度 | 说明 |
|---|---|
| 执行粒度 | Task |
| 判断上下文 | Goal + Outcome |

不能每 30 分钟重新"跑整个 Goal"，那会浪费资源；但必须带 Goal Context 启动 Task，否则容易跑偏。

---

## 7. Skills 调整

### 现有 4 个 Core Skills（保留）

```
task-run
task-resume
verify
recover
```

### 新增 2 个核心 Skills（V0.1 推荐补上）

#### outcome-evaluate

负责：

```
Outcome 是否已经完成？
当前 Gap 是什么？
需要新增 Task 吗？
```

调用时机：

- 每轮 Workflow 开始前
- 任何 Task 完成时
- Outcome 进入 `achieved` 候选时（最后一次评估）

#### goal-align

负责：

```
当前 Outcome 是否仍然服务 Goal？
当前 Task 是否仍然值得继续？
是否出现 scope creep？
```

调用时机：

- 每次新建 Task 前
- 每个 Checkpoint 时（轻量）
- Detect 到 Task 反复重试同一动作但 Outcome 不动时

---

## 8. 自主循环（最终形态）

```
Observe
   ↓
What Goal am I serving?
   ↓
What Outcome has the largest gap?
   ↓
What Task best reduces that gap?
   ↓
Act
   ↓
Verify
   ↓
Did the Outcome actually move?
```

### 自我审视问题（每个 Checkpoint 都问）

1. **What Goal am I serving?** — 这次执行是为哪个 Goal 服务？
2. **What Outcome has the largest gap?** — 当前最该推进哪个 Outcome？
3. **What Task best reduces that gap?** — 哪个 Task 能最大缩小 Gap？
4. **Did the Outcome actually move?** — Verify 之后 Outcome.progress 有变化吗？

如果第 4 问的答案是「没变化」，必须触发 recover Skill，重新 Observe / Replan。

---

## 9. 与现有设计的关系

| 现有设计 | 影响 |
|---|---|
| Task 数据模型 | 扩展：增加 `outcome_id`（强约束）+ `alignment_verdict` |
| Workflow 循环 | 主循环扩展：增加 Evaluate Outcome Gap + Goal Alignment |
| Skills | 增加 `outcome-evaluate` + `goal-align` |
| Scheduler | 调度单位不变，但 Context 装载 Goal + Outcome |
| Verify | 不变，但 Verify 的 evidence 现在同时更新 Outcome.progress |
| Event Log | 新增事件：`OUTCOME_GAP_EVALUATED`、`TASK_REJECTED_SCOPE_CREEP`、`OUTCOME_PROGRESS_UPDATED` |
| ToolResult 协议 | 不变 |

### 兼容路径

V0.1 可以先实现最小集：

```
1. Outcome / Goal 表先建，但不强制 Agent 拆解
2. Task 仍然带 outcome_id，但允许一次性批量迁移
3. outcome-evaluate / goal-align 标记为 v0.5
```

这样**不破坏**现有架构，新设计作为**增强层**叠加。V0.5 强制使用。