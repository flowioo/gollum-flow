# Gollum V0.2 — Agent Self-Evolution Layer

> 让 Coding Agent 24/7 不间断运行。自动处理 API 配额耗尽、自动检测卡死、自动恢复。

## 1. 目标

把 Gollum 从"任务调度框架"升级为"**长跑型 Agent 操作系统**"。

| 场景 | V0.1 表现 | V0.2 表现 |
|---|---|---|
| Agent 进程崩溃 | 任务永远 RUNNING | 进程 watchdog 检测 → 自动重启 |
| Worker 卡死 | 任务永远 RUNNING | 心跳 watchdog → 释放 lease → 重试 |
| API 配额耗尽 | 任务失败 → 人工重启 | 自动暂停所有任务 → 5hr 后自动恢复 |
| 配额恢复后 | 人工逐一重启任务 | tick 自动释放，调度器继续 |
| 长时间空闲 | 浪费 poll | adaptive sleep（idle 1min/quota 5min） |

## 2. 架构

```
            ┌─────────────────────────┐
            │  Parent Supervisor      │  ←-- 重启进程 (PID 1)
            │  (process watchdog)     │
            └────────────┬────────────┘
                         │ spawns + watches
                         ▼
            ┌─────────────────────────┐
            │  Worker / AgentLoop     │  ←-- 写心跳 + 处理任务
            │  (24/7 main loop)       │
            └────────────┬────────────┘
                         │ tick
            ┌────────────┴────────────┐
            ▼                         ▼
   ┌─────────────────┐       ┌──────────────────┐
   │  Watchdog       │       │  Scheduler        │
   │  - heartbeat    │       │  - lease release  │
   │  - supervisor   │       │  - pick next      │
   │  - quota tick   │       │  - dispatch       │
   └─────────────────┘       └──────────────────┘
            │                         │
            └─────────────┬───────────┘
                          ▼
                  ┌────────────────┐
                  │  SQLite Store  │  ←-- 唯一真相源 (CAS + lease)
                  └────────────────┘
```

### 2.1 三道防线

1. **心跳 (per-task)** — Worker 每 20-30s 调 `task.heartbeat`，扩展 lease。
   60s 没心跳 → 看门狗释放任务（重试），重试 2 次后升级 BLOCKED。

2. **进程 (supervisor)** — Supervisor 每 10s 写自己的心跳。
   30s 没心跳 → 父 supervisor kill + 重启（带 backoff）。

3. **配额 (quota)** — Worker 遇 429 → 调 `quota.report_exhaustion`。
   5hr 后 tick 自动恢复 + 释放所有暂停任务。

## 3. 启动 24/7

### 3.1 一键启动（生产模式）

```bash
# 后台启动 supervisor（worker 由它自动派生）
gollum supervisor start --detach

# 看状态
gollum supervisor status
# Output:
#   parent_pid:  12345 ✓ alive
#   worker_pid:  12346 ✓ alive
#   heartbeat:   running
#   last_hb:     2026-09-28T02:18:00Z
#   restarts:    0
#   log:         ./data/logs/supervisor.log

# 跟踪日志
gollum supervisor log --tail 100
```

### 3.2 前台开发模式

```bash
gollum supervisor start --interval 5
# Ctrl+C 停止
```

### 3.3 优雅停止

```bash
gollum supervisor stop
```

### 3.4 进程死了怎么办？

父 supervisor 每 5s 检查 worker 心跳。一旦发现 stale > 30s：
1. `SIGTERM` → `SIGKILL` worker
2. 等 5s（初始 backoff）
3. spawn 新 worker
4. 记录 `SUPERVISOR_RESTARTED` event
5. 若连续失败 5 次 → 整个 supervisor 退出（说明有真 bug）

## 4. API 配额管理

### 4.1 Worker 报告配额耗尽

Worker 在 Claude Code / Codex 看到 429 时调 MCP 工具：

```typescript
// 在 Agent Host 里调用 gollum 的 MCP 工具
await gollum.tool('quota.report_exhaustion', {
  error: '429 — 5-hour rolling window exceeded',
  auto_detect: true,  // 自动检测 pattern
});
// → Gollum 把所有 RUNNING 任务标记为 WAITING
//   wake_at = now + 5hr
//   lease 释放
```

### 4.2 手动查看状态

```bash
gollum quota status
# Output:
#   status:        exhausted
#   provider:      anthropic
#   exhausted_at:  2026-09-28T00:00:00
#   recovery_at:   2026-09-28T05:00:00
#   hit_count:     1
#   error:         429 — 5-hour rolling window exceeded
#   recovery_in:   17300s (288min)
```

### 4.3 自动恢复

AgentLoop 每 cycle 自动调 `tickQuotaRecovery()`：
- `recovery_at <= now` → 释放所有 WAITING 任务 → 状态 `ok` → 继续 dispatch

### 4.4 手动强制恢复（紧急情况）

```bash
gollum quota clear --reason "manually verified recovery"
```

## 5. 心跳 & 卡死检测

### 5.1 Worker 维护心跳

Worker 在执行 task 时每 20-30s 调：

```typescript
await gollum.tool('task.heartbeat', { task_id: '01HXYZ...' });
// → 刷新 heartbeat_at = now
//   延长 lease_until = now + 60s
```

### 5.2 看门狗检测

AgentLoop 每 cycle 调 `recoverStuckTasks()`：

| 条件 | 行为 |
|---|---|
| heartbeat stale > 60s, retry_count < 2 | release → PENDING, retry_count++ |
| heartbeat stale > 60s, retry_count ≥ 2 | → BLOCKED (升级) |
| heartbeat fresh | 跳过 |

### 5.3 查看活跃任务

```bash
gollum heartbeat status
# Output:
#   supervisor:        running
#   supervisor_pid:    12346
#   last_heartbeat:    2026-09-28T02:18:00
#   stale_for:         3s (threshold 60s)
#
#   Stuck Tasks: 0
#
#   Active (RUNNING) Tasks: 2
#     - K7M3QA "implement quota.ts" owner=worker-1 heartbeat_age=15s
#     - 9X2PFG "write heartbeat tests" owner=worker-1 heartbeat_age=22s
```

### 5.4 手动恢复卡死任务

```bash
gollum heartbeat recover
```

## 6. 自适应轮询

AgentLoop 不固定间隔，根据状态动态调整：

| 状态 | 下次 sleep |
|---|---|
| 配额 cooldown 中 | `min(recovery剩余, 5min)` — 到点立即醒 |
| 刚恢复 | 5s (fast) |
| 有任务 ready | 5s (fast) |
| 空闲 | 15s (normal) |
| 完全无活动 | 60s (slow) |

设计原则：**忙时频繁查，空闲时省 CPU**。

## 7. 集成到自己的 Worker

```typescript
import { AgentLoop } from 'gollum/agent';
import { getStore } from 'gollum/workflow/store/store';
import { taskHeartbeat, taskComplete } from 'gollum/mcp/core/task';

const store = getStore();
const loop = new AgentLoop({
  store,
  mode: 'worker',

  // 你自己的 dispatcher（这里调 Claude Code / Codex）
  dispatch: async (pick) => {
    const task = taskClaim(store, { task_id: pick.task.id, owner: `worker-${process.pid}` });

    // 启动定时心跳（关键！不写心跳会被 watchdog 当成卡死）
    const heartbeatTimer = setInterval(() => {
      taskHeartbeat(store, task.id);
    }, 25_000);

    try {
      // 调 Claude Code / Codex 实际执行 task
      const result = await callClaudeCode(task);

      // Verify 通过后 complete
      taskComplete(store, task.id, `done: ${result.summary}`);
    } catch (e) {
      // 配额错误时报告给 gollum
      if (isQuotaError(e)) {
        await gollum.tool('quota.report_exhaustion', { error: e.message });
      }
      // 其他错误让 recover skill 处理
      throw e;
    } finally {
      clearInterval(heartbeatTimer);
    }
  },
});

await loop.start();  // never returns
```

## 8. MCP 工具一览（Agent Host 可调用）

| 工具 | 用途 |
|---|---|
| `quota.report_exhaustion` | 报告配额耗尽（自动检测 pattern） |
| `quota.status` | 查询当前配额状态 |
| `quota.tick` | 主动 tick 恢复（一般不需手动调） |
| `task.heartbeat` | Worker 心跳 |
| `agent.can_dispatch` | 是否可继续 dispatch（quota gate） |

## 9. CLI 一览

```bash
# Supervisor
gollum supervisor start [--detach] [--interval <sec>] [--max-restarts <n>]
gollum supervisor run-loop           # 内部循环（不要直接调）
gollum supervisor stop
gollum supervisor status
gollum supervisor log [--tail <n>]

# Quota
gollum quota status
gollum quota clear [--reason <text>]
gollum quota exhaust --provider <name> --error <msg> [--recovery-ms <ms>]
gollum quota tick

# Heartbeat
gollum heartbeat status
gollum heartbeat stuck [--stale-ms <ms>]
gollum heartbeat recover [--stale-ms <ms>]
gollum heartbeat ping <task_id>      # 手动刷心跳
```

## 10. 数据库 schema（V0.2 migration 0002）

新增 2 张表 + 3 个列：

```sql
-- 配额状态（singleton）
quota_state (id=1, status, provider, exhausted_at, recovery_at,
             error_message, hit_count, updated_at)

-- 进程 supervisor 状态（singleton）
supervisor_state (id=1, pid, started_at, last_heartbeat_at,
                  restart_count, last_restart_reason, status, updated_at)

-- Task 增加 3 列
tasks.heartbeat_at      TEXT     -- Worker 心跳时间
tasks.worker_pid        INTEGER  -- Worker 进程 PID
tasks.worker_host       TEXT     -- 主机名（多机部署安全）

-- Agent 运行日志
agent_runs (id, started_at, finished_at, cycle_kind, status,
            picked_tasks, released_tasks, failed_tasks, duration_ms, error, metadata)
```

## 11. 测试

```bash
# 单元测试 (27 新测试覆盖 self-evol layer)
npx tsx --test tests/agent-self-evol.test.ts

# E2E (4 scenarios: 24/7 / quota / crash / supervisor)
npx tsx tests/_w9_24_7_self_evolution_e2e.mts

# 全套 (50 原有 + 27 新 = 77)
npm test
```

## 12. 不变量（V0.2 强约束）

1. **Conversation 不是 State**（沿用 V0.1）
2. **Agent 可以死，Task 不能丢**（V0.1） → V0.2 加强：**Worker 死了也要继续**
3. **失败先 Observe，不重复 Action**（V0.1） → V0.2：recover 有重试上限
4. **Progress is verified state change**（V0.1） → 不变
5. **心跳不能停** ← V0.2 新增：worker 必须每 30s 写心跳，否则视为死
6. **配额恢复必须自动** ← V0.2 新增：不能让人工盯着 5hr 倒计时
7. **进程死了要被自动拉起** ← V0.2 新增：supervisor watchdog

## 13. 已知限制 / 下一步

| 限制 | V0.2 处理 | V0.5 计划 |
|---|---|---|
| 单一 host（单机器） | ✓ | 多机器 lease 协调 |
| 心跳阈值固定 | ✓ | adaptive（按 task 复杂度） |
| 配额 cooldown 固定 5hr | ✓ | per-provider 实际值 |
| 没分级告警 | ✗ | 接 Lark/Slack webhook |
| 没 panic 自动 submit issue | ✗ | 自动开 GitHub issue |

## 14. 设计决策记录

### 14.1 为什么心跳阈值 60s？
Worker 心跳间隔推荐 20-30s（task.heartbeat 调一次 ~1ms）。
阈值 = 2-3 × 心跳间隔，给网络抖动留余量。

### 14.2 为什么 STUCK_RETRY_LIMIT = 2？
不是无限重试。第 3 次还在卡，说明不是临时问题 → 升级到 Outcome 层人工决策。

### 14.3 为什么 supervisor max_restarts = 5？
给真实 bug 留 5 次机会（5 × 平均 backoff ≈ 5min）。还失败 = 真有 bug，退出让人工介入。

### 14.4 为什么 quota recovery 后用 PENDING 而不是 RUNNING？
PENDING = "可以调度"，RUNNING = "正在跑"。恢复后让 scheduler 重新 pick，避免：
- 重复执行已经做了的部分
- 在原 worker 上接着跑（原 worker 可能已死）
