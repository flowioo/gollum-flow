# 08 · 核心工程原则与最终架构总结

## 1. 七条核心原则

整个项目以后都按这七条走。

### 原则 1：Agent 可以死，Task 不能丢

> Lease + CAS + Event Log 的存在意义。

### 原则 2：Conversation 不是 State

> Session 是临时呼吸，Task 是长期生命。

### 原则 3：Environment > Memory > Checkpoint

> 每次 Resume 先 Observe Environment，再参考 Memory，最后才是 Checkpoint。

### 原则 4：No Evidence = Not Verified

> 不允许 Agent 自报「应该完成了」。
> 必须有 Tool 返回的 Evidence。

### 原则 5：失败以后先 Observe，而不是重复 Action

> Recover Skill 强制 Classify Failure → Identify Divergence → Change Strategy。

### 原则 6：Long-running Agent ≠ Long-running Process

> 长期自主不是「进程不退出」，而是「Run → Wait → Wake → Continue」。

### 原则 7：Gollum 不和 Agent Host 争夺 Agent Loop

> 只提供状态 + 工具 + 流程指引。
> Loop 由 Host 负责。

### 原则 8（新增）：进展以 Outcome 为单位，不以 Task 为单位

> Agent 不以"完成 Task"作为进展，而以"改变 Outcome"作为进展。
> Task 是动作，Outcome 是事实。
> 完成一堆 Task 但 Outcome 没变化 = 没进展。

这是语义层的最核心原则。所有 Workflow、Scheduler、Verify、Skill 设计最终都要服从这条。

---

## 2. 关键词总表

| 概念 | 定义 | 角色 |
|---|---|---|
| Project | 顶层容器 | 工作域 |
| Goal | 长期方向 | Direction |
| Outcome | 可验证阶段结果 | Evidence of Progress |
| Task | 推进 Outcome 的具体行动 | Action |
| Execution | Task 的一次执行尝试 | Attempt |
| Verify | 把假设变成事实 | Truth |
| Evidence | Verify 留下的物证 | 唯一可信信号 |

> 一句话：**Goal 是方向，Outcome 是事实，Task 是动作，Execution 是尝试，Verify 是真伪，Evidence 是证据。**

---

## 3. 最终架构总结

```
              Trigger
                 │
                 ▼
             Scheduler            ← 按 Outcome Gap 排序
                 │
                 ▼
          Workflow Store
                 ▲
                 │
                 │ MCP
                 ▼
      Codex / CC / WorkBuddy
                 │
               Skills              ← task-run/task-resume/verify/recover
                 │                 ← outcome-evaluate/goal-align
                 │
               Tools               ← task.* / outcome.* / goal.* / verify.*
                 │
                 ▼
             Environment
                 │
                 ▼
              Verify
                 │
        ┌────────┴─────────┐
        │                  │
      PASS               FAIL
        │                  │
    Update Task         Recover
        │                  │
    Update Outcome ─────► Retry
        │
   Goal Alignment
        │
   ┌────┴────┐
aligned  scope_creep
   │         │
continue  block

外部条件未满足
        │
        ▼
      WAIT
        │
        ▼
    Scheduler
        │
        └──────────────→ Resume (带 Goal Context)
```

---

## 4. Gollum 长期定位

**英文**

> Portable workflow, skills and tools for reliable long-running agents.

**中文**

> 让不同 Agent 能跨 Session、跨工具、跨环境持续可靠推进 Goal / Outcome 的能力层。

注意原方案的「完成任务」改成了「**推进 Goal / Outcome**」。一字之差，语义完全不同。

---

## 5. 长期演进路径

```
Coding
  ↓
Computer / Phone
  ↓
Multi-device Personal Agent
  ↓
Agentic Robot
  ↓
Embodied Personal Assistant
```

四层 Project / Goal / Outcome / Task 保持不变，只往上叠加 Skills + Tools。

---

## 6. 架构升级日志

- **V0.1（当前方案）**：新增 Goal / Outcome / Execution 三层；新增 outcome-evaluate / goal-align 两个 Skill；新增 Outcome Gap 驱动调度。
- **V0.5 候选**：outcome-decompose（Outcome 自动拆 Task）；evidence-audit（周期审计）；skill-mine（从 Event Log 提炼 Skill）。
- **V1+ 候选**：Goal 间依赖图（DAG）；多 Goal 并行；Agent 团队协作。