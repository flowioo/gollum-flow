# Gollum — 文档索引

> **一句话定义**
> Gollum 是面向 Codex / Claude Code / WorkBuddy 等 Agent Host 的可移植能力层，通过 **Skills + Tools + Workflow State**，实现长期任务、跨 Session 恢复、验证、失败恢复与无人值守执行。

> **核心原则（V0.1）**
> **Agent 不以"完成 Task"作为进展，而以"改变 Outcome"作为进展。**

## 分层职责

| 层 | 负责 |
|---|---|
| Agent Host (Codex / CC / WorkBuddy) | THINK / Agent Loop |
| Gollum Skills | KNOW HOW |
| Gollum Tools | DO / OBSERVE / VERIFY |
| Gollum Workflow | STATE / CONTINUITY |

## 语义层次（V0.1）

```
Project
  └─ Goal          = Direction
       └─ Outcome  = Evidence of Progress
            └─ Task       = Action
                 └─ Execution = Attempt
```

**强约束**：Task 必须属于某个 Outcome。不允许 `Goal → Task` 直连。

## Gollum 明确不实现

- Agent Runtime / LLM Loop / Context Window 管理
- Planner Runtime / 自定义 Agent 协议
- 自定义 Workflow DSL / 长驻 Agent 进程

## 目标场景（按阶段）

1. **Coding Agent**：自主完成 GitHub Issue → PR → CI → 修复 → Merge
2. **Phone Agent**：在 Android 上完成日常任务
3. **Robot Agent**：机械臂 / IoT 控制

底层 Workflow 模型不变，只增加 Skills + Tools。

## 文档地图

| 文件 | 覆盖 |
|---|---|
| [01-architecture.md](./01-architecture.md) | 总体架构、核心设计原则（第 3、4 节） |
| [02-workflow.md](./02-workflow.md) | Workflow 模型、Task 状态机（含 Goal/Outcome 主循环） |
| [03-task-model.md](./03-task-model.md) | Project / Goal / Outcome / Task / Execution 数据模型 |
| [04-skills.md](./04-skills.md) | Skills 设计（task-run / task-resume / verify / recover + outcome-evaluate / goal-align） |
| [05-tools.md](./05-tools.md) | Tool 架构、MCP、ToolResult 协议 |
| [06-runtime.md](./06-runtime.md) | Trigger / Scheduler / Host 集成 / Session 协议 / WAITING / HITL / Memory |
| [07-roadmap.md](./07-roadmap.md) | 项目结构、CLI、阶段规划、V0.1 验收、自主性指标 |
| [08-principles.md](./08-principles.md) | 核心工程原则、最终架构总结、关键词表 |
| [09-goal-outcome-model.md](./09-goal-outcome-model.md) | **Goal / Outcome 语义层核心设计** |
| [REVIEW.md](./REVIEW.md) | **方案评审：风险、改进建议、决策点** |

## 当前阶段

**V0.1 — Autonomous Coding Agent（语义层升级版）**

只做：

```
Workflow Store (SQLite + WAL)
  - Project / Goal / Outcome / Task / Execution / Evidence / Event

Scheduler
  - 按 Outcome Gap 排序

Lease + CAS Version

Task Event Log + Outcome / Goal 层事件

6 Core Skills
  - task-run / task-resume / verify / recover
  - outcome-evaluate / goal-align

12 Core Tools
  - task.* (8)
  - outcome.* (2)
  - goal.* (2)

Verify: command / git / outcome-criterion

Codex Integration
```

不做的部分见 `07-roadmap.md` 末尾的「V0.1 不做清单」。