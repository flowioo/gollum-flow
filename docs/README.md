# Gollum — 文档索引

> **一句话定义**
> Gollum 是面向 Codex / Claude Code / WorkBuddy 等 Agent Host 的可移植能力层，通过 **Skills + Tools + Workflow State**，实现长期任务、跨 Session 恢复、验证、失败恢复与无人值守执行。

> **核心原则（V0.1）**
> - **Agent 不以"完成 Task"作为进展，而以"改变 Outcome"作为进展。**
> - **Task = 可独立执行 / 独立验证 / 失败可重试 / 产生 Outcome 增量 的最小工作单元。**
> - **V0.1 先证明自主循环，不证明生态集成。**

## 分层职责

| 层 | 负责 |
|---|---|
| Agent Host (Codex / CC / WorkBuddy) | THINK / Agent Loop |
| Gollum Skills | KNOW HOW |
| Gollum Tools | DO / OBSERVE / VERIFY |
| Gollum Workflow | STATE / CONTINUITY |

## 语义层次

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
- V0.1：Memory 自动归纳、Skill 自动生成、生态集成（GitHub/CI/Webhook）

## 文档地图

| 文件 | 覆盖 |
|---|---|
| [01-architecture.md](./01-architecture.md) | 总体架构、核心设计原则 |
| [02-workflow.md](./02-workflow.md) | Workflow 模型、Task 状态机、Task 定义（V0.1 调整版） |
| [03-task-model.md](./03-task-model.md) | Project / Goal / Outcome / Task / Execution 数据模型、CAS 重试链 |
| [04-skills.md](./04-skills.md) | 6 Core Skills（task-run / task-resume / verify / recover / outcome-evaluate / goal-align） |
| [05-tools.md](./05-tools.md) | Tool 架构、MCP、ToolResult 协议 |
| [06-runtime.md](./06-runtime.md) | Trigger / WakeCondition / Scheduler / Host / Session / WAITING / HITL / Memory |
| [07-roadmap.md](./07-roadmap.md) | 项目结构、CLI、V0.1 范围、阶段规划 |
| [08-principles.md](./08-principles.md) | 12 条核心工程原则、关键词表 |
| [09-goal-outcome-model.md](./09-goal-outcome-model.md) | Goal / Outcome 语义层核心设计 |
| [10-v01-minimal-demo.md](./10-v01-minimal-demo.md) | **V0.1 Minimal Demo：自主循环证明** |
| [REVIEW.md](./REVIEW.md) | 方案评审：风险、改进建议、决策点 |

## 当前阶段

**V0.1 — Autonomous Coding Agent（自主循环版）**

只做：

```
Workflow Store (SQLite + WAL)
  - Project / Goal / Outcome / Task / Execution / Evidence / Event 表
  - CAS Version + 退避重试链
  - Lease

Scheduler
  - 按 Outcome Gap 排序
  - WakeCondition 抽象（V0.1 只实现 timer）

Task Planner
  - 自动拆 Outcome / Task（>30min 强制拆）

Task Event Log
  - 原事件 + Outcome / Goal 层事件

6 Core Skills
  - task-run / task-resume / verify / recover
  - outcome-evaluate / goal-align

12 Core Tools
  - task.* (8)
  - outcome.* (2)
  - goal.* (2)

Verify: command / git / outcome-criterion

Codex Integration
  - 本地 Codex CLI
  - 启动时传 Task ID + Goal Context

V0.1 Minimal Demo
  - 本地 2-3 bug repo
  - Goal → Outcome → Task 自动拆
  - 跨进程 Resume
  - Verify + Recover
```

明确不做：见 [07-roadmap.md](./07-roadmap.md) §6 「V0.1 不做清单」。