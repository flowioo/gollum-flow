# Gollum — 文档索引

> **一句话定义**
> Gollum 是面向 Codex / Claude Code / WorkBuddy 等 Agent Host 的可移植能力层，通过 **Skills + Tools + Workflow State**，实现长期任务、跨 Session 恢复、验证、失败恢复与无人值守执行。

## 分层职责

| 层 | 负责 |
|---|---|
| Agent Host (Codex / CC / WorkBuddy) | THINK / Agent Loop |
| Gollum Skills | KNOW HOW |
| Gollum Tools | DO / OBSERVE / VERIFY |
| Gollum Workflow | STATE / CONTINUITY |

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

| 文件 | 覆盖原方案章节 |
|---|---|
| [01-architecture.md](./01-architecture.md) | 总体架构、核心设计原则（第 3、4 节） |
| [02-workflow.md](./02-workflow.md) | Workflow 模型、Task 状态机（第 5、6 节） |
| [03-task-model.md](./03-task-model.md) | Task 数据模型、Lease、CAS、Checkpoint、Event（第 7–14 节） |
| [04-skills.md](./04-skills.md) | Skills 设计（task-run / task-resume / verify / recover）（第 15、16 节） |
| [05-tools.md](./05-tools.md) | Tool 架构、MCP、ToolResult 协议（第 17–20 节） |
| [06-runtime.md](./06-runtime.md) | Trigger / Scheduler / Host 集成 / Session 协议 / WAITING / HITL / Memory（第 21–30 节） |
| [07-roadmap.md](./07-roadmap.md) | 项目结构、CLI、阶段规划、V0.1 验收、自主性指标（第 31–38 节） |
| [08-principles.md](./08-principles.md) | 核心工程原则、最终架构总结（第 39、40 节） |
| [REVIEW.md](./REVIEW.md) | **方案评审：风险、改进建议、决策点** |

## 当前阶段

**V0.1 — Autonomous Coding Agent**

只做：

```
Workflow Store (SQLite)
Scheduler
Lease + CAS Version
Task Event Log
4 Core Skills
8 Task Tools
Verify: command / git
Codex Integration
```

不做的部分见 `07-roadmap.md` 末尾的「V0.1 不做清单」。