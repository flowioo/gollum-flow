# 01 · 总体架构与核心原则

## 1. 总体架构

```
                     Trigger Layer
                 ┌──────────────────┐
                 │ Timer            │
                 │ Event            │
                 │ Human            │
                 └────────┬─────────┘
                          │
                          ▼
                 ┌──────────────────┐
                 │ Workflow Manager │
                 └────────┬─────────┘
                          │
                    load / claim
                          │
                          ▼
                ┌─────────────────────┐
                │ Agent Host          │
                │                     │
                │ Codex               │
                │ Claude Code         │
                │ WorkBuddy           │
                └──────────┬──────────┘
                           │
                         Skills
                           │
                           ▼
                ┌─────────────────────┐
                │ Gollum Skills       │
                │                     │
                │ task-run            │
                │ task-resume         │
                │ verify              │
                │ recover             │
                │ coding/...          │
                └──────────┬──────────┘
                           │
                          MCP
                           │
                           ▼
                ┌─────────────────────┐
                │ Gollum Tools        │
                │                     │
                │ task.*              │
                │ verify.*            │
                │ memory.*            │
                │ browser.*           │
                │ android.*           │
                │ robot.*             │
                └──────────┬──────────┘
                           │
                           ▼
                ┌─────────────────────┐
                │ Workflow Store      │
                │                     │
                │ Task               │
                │ Events             │
                │ Checkpoints        │
                │ Evidence           │
                │ Lease              │
                └─────────────────────┘
```

数据流是单向的：**Trigger → Scheduler → Store → Host → Skill → Tool → Environment → Verify → Store**。

## 2. 核心设计原则

### 2.1 Workflow Store 是唯一事实源

```
Conversation ≠ Workflow State
Session      ≠ Task
Agent        ≠ Task Owner forever
```

Agent Context 只属于当前 Session。任何时刻，「Task 现在在哪个状态」只能由 Workflow Store 回答。

### 2.2 Agent Session Stateless

一次 Agent Session 本质是：

```
Load Task
  ↓
Observe
  ↓
Execute
  ↓
Checkpoint
  ↓
Exit
```

任何 Agent 都可以重新接管 Task。Session 不是 Task 的生命周期，而是 Task 的一次呼吸。

### 2.3 Environment > Checkpoint

```
Checkpoint = 过去发生了什么
Environment = 现在是什么状态
```

每次 Resume 必须：

```
Load Checkpoint
  ↓
Re-observe Environment
  ↓
Compare
  ↓
Continue / Replan
```

禁止直接相信旧状态。这是「Verify First」的工程化体现。

### 2.4 不抢 Agent Loop

Gollum 不实现：

- Agent Runtime / Planner Runtime / LLM Loop
- Context Window 管理
- 自定义 Workflow DSL

只提供 **状态 + 工具 + 流程指引**。Loop 由 Agent Host 负责。