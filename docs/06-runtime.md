# 06 · 运行时：Trigger / Scheduler / Host / Session / 等待 / HITL / Memory

## 1. Workflow Trigger

三种：

### Timer

- 周期：`every 30m`
- 最终推荐：**Task 自己指定 `wake_at`**

### Event

- GitHub webhook
- CI completed
- 邮件到达
- 文件变化
- Robot event

### Human

```
gollum run task-001
```

未来 Event Trigger 优先，Timer 作为 fallback。

## 2. Scheduler

逻辑非常简单：

```sql
SELECT *
FROM tasks
WHERE status = 'WAITING'
  AND wake_at <= now()
  AND (lease_until IS NULL OR lease_until < now())
```

然后：

```
选 Agent Host
  ↓
启动 Session
  ↓
传 Task ID
```

Scheduler 不理解业务，只负责「该唤醒谁」。

### 调度策略

V1 简单实现：

- 同一时间最多 N 个 Task 在 RUNNING
- 按 `created_at` FIFO
- BLOCKED 不调度
- VERIFYING / RECOVERING 不被新 Session 接管（Lease 保护）

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
按 task-resume Skill
  ↓
恢复
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

## 4. Session 结束协议

任何 Agent Session 结束前，必须进入以下一种状态：

```
task.complete()
task.wait()
task.block()
task.fail()
```

**禁止**：「Session Exit 但 Task 仍然 RUNNING」。

如果发生 Agent Crash：

```
lease expire
  +
Task RUNNING
```

Scheduler 识别为 `RECOVERABLE`，重新调度。

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

### Block 接口

```json
{
  "task_id": "task-001",
  "reason": "需要确认是否删除 production DB",
  "context": {
    "expected": "DELETE FROM users WHERE ... ",
    "impact": "约 12k 行"
  },
  "options": [
    "approve",
    "reject",
    "modify"
  ]
}
```

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

## 8. Skill 与 Memory

| | Memory | Skill |
|---|---|---|
| 性质 | Experience / Facts | Reusable Procedure |
| 示例 | "高德地图搜索后有概率发生页面异步刷新" | "搜索目的地后必须重新 Observe，不要继续使用旧 UI 状态" |

Memory 是「发生过的事」，Skill 是「以后该怎么做的流程」。Skill 升级需要 Memory 提炼，反过来 Skill 应用又产生新的 Memory。

V0.1 不做 Memory 自动进化，但接口要预留。