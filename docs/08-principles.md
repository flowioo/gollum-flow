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

### 原则 8（语义层）：进展以 Outcome 为单位，不以 Task 为单位

> Agent 不以"完成 Task"作为进展，而以"改变 Outcome"作为进展。
> Task 是动作，Outcome 是事实。
> 完成一堆 Task 但 Outcome 没变化 = 没进展。

这是语义层的最核心原则。所有 Workflow、Scheduler、Verify、Skill 设计最终都要服从这条。

### 原则 9（Task 拆分）：Task 按结果拆，不按执行器寿命拆

> **Task = 能在有限时间内独立执行、独立验证、失败可重试，并对某个 Outcome 产生明确增量的最小工作单元。**

不绑定 Agent Session：
- 一个 Session 可以跑多个 Task
- 一个 Task 可以被多个 Session 接力
- Task **不关心**是谁在跑、跑了多久

目标 10–30min，预计 > 30min 时 Planner 优先拆分。

业务 Task 应该按「结果是否独立、可验证、可重试、产生 Outcome 增量」拆，按 Session 寿命拆会污染 Task 边界。

### 原则 10（CAS 冲突）：不能盲重试，要 reload + backoff + re-evaluate

收到 `STATE_CONFLICT` 后：

```
reload latest state
  ↓
jitter backoff 1–3s
  ↓
re-evaluate（基于最新 state，原 patch 可能已过时）
  ↓
CAS retry ≤ 3
```

**绝对禁止**：拿原 patch 数据直接重试。

3 次仍冲突 → `task.block(reason="cas_thrashing")` 或 `task.fail(reason="cas_thrashing")`，触发 Planner 重新规划。

### 原则 11（Checkpoint / Memory 边界）：Checkpoint 是状态，不是知识

Checkpoint 只存：

- 当前执行状态
- Artifact 引用
- decision context（为什么做这个决定）

**不存**用户偏好、技术经验、领域知识。

Memory 独立。V0.1 不做自动归纳，避免错误知识进入长期记忆。

### 原则 12（V0.1 范围）：先证明自主循环，不证明生态集成

V0.1 的核心命题：

> 关闭 Agent，再重新启动，它还能知道自己为什么工作、做到哪了、接下来该做什么，并最终把测试跑通。

GitHub / CI / Webhook / PR 都属于 Tool Integration，不是 V0.1 的核心风险。
V0.5 再做。

### 原则 13（Progress）：进展不是数字，是被证据验证的状态变化

> **Progress is not a number. Progress is verified state change.**
> **进展不是一个百分比，而是被证据验证过的状态变化。**

**砍掉** `progress = pass / total` 数字。**原因**：

> **Goodhart's Law**: When a measure becomes a target, it ceases to be a good measure.
> **指标一旦成为目标，就不再是好指标。**

Agent 会刷分：

- 拆更多容易完成的 criteria
- 挑 criteria 数量少的 Outcome
- 把 criterion 拆细刷分

**替代方案**：

```
Outcome.status           = NOT_STARTED / IN_PROGRESS / BLOCKED / VERIFIED / FAILED
Criterion.derived_status = UNVERIFIED / PASS / FAIL / UNKNOWN
remaining_gap            = count(criterion.derived_status != PASS)
```

Agent 不能优化一个数字，只能优化**真实的状态变化**。

### 原则 14（Criterion 三段式）：criterion → verifier → evidence

每条 Criterion 必须绑定一个 Verifier。**没有 Verifier 的 Criterion 标 `UNVERIFIED`**。

```
criterion  →  verifier  →  evidence
              (怎么验证)   (凭什么说完成)
```

「稳定运行 4 小时」看似模糊，但有 `timer_check` 绑定 → **可验证**，不是「模糊」。
真正「不能验证」的 criterion 是那些没有 Verifier 的。

**CLI 不做语义裁判**（不检测「稳定」「高效」），只做**结构校验**（criterion 必须有 verifier 路径）。

### 原则 15（Human Boundary）：Human 负责改变边界，不负责日常纠偏

V0.1 触发 Human 的情况（极少见）：

- 修改 Goal（goal.update 修改 title/description）
- 删除关键 Outcome
- 扩大 Outcome scope（新增 criteria）
- 不可逆操作
- 高风险操作

日常纠偏（misaligned Task / 选择下一个 Task / 修复 bug）→ Agent 自己处理。

`goal-align` 返回 `misaligned` → Agent 自动 pause / rollback / backlog，**不找人**。
`goal-align` 返回 `uncertain` → re-evaluate / replan。
`goal-align` 返回 `aligned` → continue。

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