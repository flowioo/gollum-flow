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

## 2. 最终架构总结

```
              Trigger
                 │
                 ▼
             Scheduler
                 │
                 ▼
          Workflow Store
                 ▲
                 │
                 │ MCP
                 ▼
      Codex / CC / WorkBuddy
                 │
               Skills
                 │
               Tools
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
    Complete            Recover
                           │
                         Retry

外部条件未满足
        │
        ▼
      WAIT
        │
        ▼
    Scheduler
        │
        └──────────────→ Resume
```

## 3. Gollum 长期定位

**英文**

> Portable workflow, skills and tools for reliable long-running agents.

**中文**

> 让不同 Agent 能跨 Session、跨工具、跨环境持续可靠完成任务的能力层。

## 4. 长期演进路径

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

底层 Workflow 模型保持不变，只往上叠加 Skills + Tools。