# 06 · 运行时：Trigger / Scheduler / Host / Session / 等待 / HITL / Memory

## 1. Workflow Trigger

### 1.1 抽象：WakeCondition

V0.1 抽象出统一的 **WakeCondition** 接口：

```typescript
interface WakeCondition {
  type: "timer" | "github_pr" | "ci_status"
  config: TimerConfig | GithubPRConfig | CIStatusConfig
  next_wake_at?: string
}

interface TimerConfig {
  fire_at: string          // ISO8601
}

interface GithubPRConfig {
  repo: string
  pr_number: number
  watch_fields: ("status" | "checks" | "comments")[]
}

interface CIStatusConfig {
  repo: string
  branch: string
  watch_runs: ("completed" | "failed" | "success")[]
}
```

**关键点**：

- V0.1 **只实现 3 种 polling condition**：`timer` / `github_pr` / `ci_status`
- Webhook 是未来的 Trigger Adapter，**不是 V0.1 的事**
- 每种 condition 都有 `next_wake_at`，Scheduler 据此唤醒
- 即便是 polling（不是真 push），也通过 WakeCondition 统一抽象

### 1.2 V0.1 三种 WakeCondition

| type | 实现方式 | 适用场景 |
|---|---|---|
| **timer** | Scheduler 定时轮询 `wake_at <= now()` | 等固定时长后回来（demo repo 修复后等 30min 看是否需要继续） |
| **github_pr** | 定时拉 PR 状态（V0.5 才用） | V0.1 Demo 不需要 |
| **ci_status** | 定时拉 CI 状态（V0.5 才用） | V0.1 Demo 不需要 |

### 1.3 Trigger 类型

| 类型 | V0.1 |
|---|---|
| Timer / WakeCondition | ✅ |
| Polling（github_pr / ci_status） | ⚠️ 接口预留，V0.5 实现 |
| Webhook | ❌ → V0.5 |
| Email 触发 | ❌ → V1 |
| 文件变化 | ❌ → V1 |
| Human（CLI） | ✅ `gollum run task-001` |

**为什么 V0.1 只做 Timer**：

V0.1 Minimal Demo 不需要外部 Trigger，30min 后的 wake 用 timer 即可。
GitHub / CI / Webhook 都属于 Tool Integration，V0.5 再做。

---

## 2. Scheduler

### 2.1 调度单位

**Scheduler 唤醒单位仍然是 Task**（不是 Goal，也不是 Outcome）。

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

| 维度 | 说明 |
|---|---|
| 执行粒度 | Task |
| 判断上下文 | Goal + Outcome |

不能每 30 分钟重新"跑整个 Goal"（浪费资源、无法精细控制）。

### 2.2 唤醒条件（V1）

```sql
SELECT *
FROM tasks
WHERE status = 'WAITING'
  AND wake_at <= now()
  AND (lease_until IS NULL OR lease_until < now())
```

### 2.3 调度策略（升级版）

V1.5 建议加 Outcome Gap 排序：

```sql
SELECT t.*
FROM tasks t
JOIN outcomes o ON t.outcome_id = o.id
WHERE t.status = 'WAITING'
  AND t.wake_at <= now()
  AND (t.lease_until IS NULL OR t.lease_until < now())
  AND o.status = 'in_progress'
ORDER BY
  o.priority DESC,           -- Outcome 优先级
  (1.0 - o.progress) DESC,   -- Gap 大的优先
  t.priority DESC,
  t.created_at ASC
LIMIT 1
```

> **按 Outcome Gap 排，而不是按 Task 创建时间排。**

### 2.4 调度上限

V1：

- 同一时间最多 N 个 Task 在 RUNNING（默认 5）
- BLOCKED 不调度
- VERIFYING / RECOVERING 不被新 Session 接管（Lease 保护）

### 2.5 Scheduler 不理解业务

Scheduler 只负责「该唤醒谁」。理解 Goal / Outcome 含义是 Skill 的事（outcome-evaluate），不是 Scheduler 的事。

---

## 3. Agent Host Integration

Gollum 不实现：

```
CodexAdapter.execute()
ClaudeAdapter.execute()
```

只负责：

```
Skill 安装
MCP 安装
启动参数
```

项目结构：

```
adapters/
  ├── codex/
  ├── claude-code/
  └── workbuddy/
```

本质是 **Installer**，不是 Runtime Adapter。

### Codex 集成

启动时：

```
codex
  + Gollum Skills
  + Gollum MCP
  + Task ID
```

Agent 第一动作：

```
task.get(task_id)
  ↓
返回 Task + Outcome + Goal 完整 Context
  ↓
按 task-resume Skill
  ↓
先 outcome-evaluate → goal-align → 恢复
```

Codex Session resume 是 **优化**，不是正确性依赖。

> **Conversation Resume = Optimization**
> **Workflow Store = Correctness**

### Claude Code / WorkBuddy

逻辑一致：

```
Host
  ↓
Load Skill
  ↓
MCP
  ↓
Task Store
```

可以实现：

```
Codex → Claude Code → WorkBuddy 连续接管同一 Task
```

---

## 4. Session 结束协议

任何 Agent Session 结束前，必须进入以下一种状态：

```
task.complete()
task.wait()
task.block()
task.fail()
```

**禁止**：「Session Exit 但 Task 仍然 RUNNING」。

### 结束前必须做的事（升级版）

1. 更新 Task（如果有进展）
2. **更新 Outcome**（如果有 Verify PASS）
3. 评估 Goal Alignment（如果方向变了）
4. Checkpoint

如果发生 Agent Crash：

```
lease expire
  +
Task RUNNING
```

Scheduler 识别为 `RECOVERABLE`，重新调度。

---

## 5. WAITING 机制

长期自主工作的关键不是「Agent 一直运行」，而是：

```
Run → Wait → Wake → Continue
```

示例：

| 场景 | wake_after |
|---|---|
| 等 CI | 10m |
| 等邮件 | 30m |
| 等部署 | 5m |
| 等 PR review | 1h |

未来优先 Event Trigger，Timer 是 fallback。

### Task 自调度

Task 自己指定 `wake_at`，不是全局 Timer。这样：

- Task 知道什么时候回来
- Scheduler 不需要轮询所有 Task
- Event 触发可以提前 wake

---

## 6. Human in the Loop

需要人工决策时 `task.block()`：

- 需要付款
- 删除生产数据
- 高风险操作
- 缺少权限
- 不可逆决策
- 目标存在重大歧义

用户处理后：

```
BLOCKED → RUNNING
```

继续原 Task。

### Goal 层 Block（新增）

Outcome / Goal 层也可能需要人工决策：

```
outcome.block(outcome_id, reason="success_criteria 定义不清楚")
goal.block(goal_id, reason="方向需要重新对齐")
```

通过 `task.block()` 之外的新 Tool 调用。

### Alignment Block（新增）

当 `goal-align` 返回 `misaligned` 或 `scope_creep` 时：

```
task.block(
  reason="alignment_verdict=misaligned",
  context={ verdict, reason, confidence }
)
```

用户必须明确 confirm 才能继续。

### Block 接口

```json
{
  "task_id": "task-001",
  "reason": "需要确认是否删除 production DB",
  "context": {
    "expected": "DELETE FROM users WHERE ... ",
    "impact": "约 12k 行"
  },
  "options": ["approve", "reject", "modify"]
}
```

---

## 7. Memory

Memory 与 Workflow State 必须分离。

| | Workflow State | Memory |
|---|---|---|
| 回答 | 「这个任务现在做到哪了？」 | 「以前发生过什么？学到了什么？」 |
| 生命周期 | 跟随 Task | 跨 Task 长期 |
| 写入触发 | Checkpoint | 显式记录或自动提炼 |

Tools：

```memory
memory.search
memory.get
memory.write
memory.update
```

### Memory 内容示例

```
memory:
  - "高德地图搜索后有概率发生页面异步刷新"
  - "本机 Codex CLI 启动平均 8 秒, 加上 MCP 注册 12 秒"
  - "用户偏好: 简单任务喜欢一气呵成, 复杂任务喜欢拆 Outcome"
```

---

## 8. Skill 与 Memory

| | Memory | Skill |
|---|---|---|
| 性质 | Experience / Facts | Reusable Procedure |
| 示例 | "高德地图搜索后有概率发生页面异步刷新" | "搜索目的地后必须重新 Observe，不要继续使用旧 UI 状态" |
| 来源 | Agent 显式记录 / 自动提炼 | 手动维护 / 从 Memory 提炼 |

V0.1 Skill **手动维护**，Memory 自动提炼是 V0.5 的事。

---

## 9. Goal / Outcome 层 Runtime

### 9.1 Outcome 评估时机

- 每轮 Workflow 开始前
- Task DONE 后
- Outcome 进入 achieved 候选时

### 9.2 Outcome 状态转移

| From | To | 触发 |
|---|---|---|
| pending | in_progress | 第一个关联 Task 进入 RUNNING |
| in_progress | achieved | 所有 success_criteria 都有 PASS evidence |
| in_progress | failed | Outcome 失败边界已知 |
| achieved | pending | Goal 调整导致 Outcome 重定义（罕见） |

### 9.3 Goal 状态转移

| From | To | 触发 |
|---|---|---|
| active | achieved | 所有 active Outcome 都 achieved |
| active | abandoned | Human 决策放弃 |

### 9.4 Goal Alignment Check 时机

- 新建 Task 前（强制）
- Checkpoint 时（轻量）
- 检测到 Task 反复重试但 Outcome 不动时

详见 [04-skills.md](./04-skills.md) `goal-align` Skill。