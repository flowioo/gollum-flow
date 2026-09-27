# Gollum

> **可移植能力层，让 Coding Agent 跨 Session / 跨崩溃 / 跨环境持续可靠推进 Goal。**

## 文档（两份）

| 文档 | 面向 | 内容 |
|---|---|---|
| **[PRD.md](./PRD.md)** | Agent Operator / 用户 / Product Owner | 做什么 — 项目定位、七层模型、Task 定义、Outcome 状态机、Criterion 三段式、goal-align 三级、Human Boundary、V0.1 Demo、验收标准 |
| **[DESIGN.md](./DESIGN.md)** | 实现工程师 / 架构师 | 怎么做 — 架构图、14 决策点、9 表 SQLite schema、状态机实现、CAS/Lease、Scheduler、Tool 接口、Skill 伪代码、4 周实施路径 |

**PRD 讲做什么，DESIGN 讲怎么做。**

## 当前阶段

**V0.1 — Autonomous Coding Agent（语义层收敛版）**

核心命题：

> 关闭 Agent，再重新启动，它还能知道自己为什么工作、做到哪了、接下来该做什么，并最终把测试跑通。

详细见 [PRD §14](./PRD.md) 和 [DESIGN §14](./DESIGN.md)。

## 核心原则（V0.1 收敛版）

1. Agent 可以死，Task 不能丢
2. Conversation 不是 State
3. Environment > Memory > Checkpoint
4. No Evidence = Not Verified
5. 失败先 Observe，不重复 Action
6. Long-running Agent ≠ Long-running Process
7. Gollum 不抢 Agent Loop
8. **进展以 Outcome 为单位**
9. **Task 按结果拆**（不按 Session 寿命）
10. **CAS 冲突不盲重试**（reload + backoff + re-evaluate + ≤3）
11. **Checkpoint 是状态，不是知识**
12. **V0.1 先证明自主循环**
13. **Progress is not a number. Progress is verified state change.**
14. **Criterion 三段式**（criterion → verifier → evidence）
15. **Human Boundary**（Human 负责改变边界，不负责日常纠偏）

## 七层语义模型

```
Goal            = 为什么做          (Direction)
   ↓
Outcome         = 想改变什么状态    (State to change)
   ↓
Criteria        = 什么算完成        (Definition of done)
   ↓
Evidence        = 凭什么说完成      (Proof)
   ↓
Task            = 怎么推进          (Action)
   ↓
Execution       = 一次尝试          (Attempt)
   ↓
Verify          = 验证              (Truth check)
```

## 4 周实施路径

```
W1: Workflow Store + 9 表 + 24 Tools + 6 Skills + Planner
W2: Scheduler + WakeCondition(timer) + Codex + CAS/Lease
W3: Verify + Recover + attach_evidence → 自动 VERIFIED
W4: goal-align 三级 + 完整 Minimal Demo + 20-30 真实 Task
```

详细见 [DESIGN §14](./DESIGN.md)。

---

**准备好就开干。**