---
name: gollum-task-run-resume
description: |
  Resume an interrupted Gollum Task after the agent process died, using the
  `gollum` CLI. Reads the persisted state and continues from where it stopped
  instead of restarting. No MCP.
---

# gollum-task-run-resume

## Goal

跨 Session 恢复 Task。进程死了、Session 没了、换了个 agent——状态还在库里，接着干。

## When to Use

- Host 进程被 kill / 崩溃 / 重启后
- 用户说「继续」「接着上次」
- 发现有 `RUNNING` 但心跳已死的 task

**不用于**：正常的新任务（用 `gollum-task-run`）。

## 铁律

> **先 Observe，再 Action。** 不要在没读状态的情况下重跑命令。

## Procedure

### 1. 找有没有该恢复的活儿

```bash
gollum heartbeat status        # 哪些 task/supervisor 心跳死了
gollum task list --status RUNNING
gollum task list --status RECOVERING
```

### 2. 读它停在哪

```bash
gollum task show "$TASK_ID"
```

重点看：

- `acceptance_criteria` — 还没满足的
- `lease_until` — 上一任的 lease 是否已过期
- `retry_count` — 试过几次
- `summary` / `last_observation` — 上次记下的观察

### 3. 检查 checkpoint

```bash
gollum task list --status RUNNING     # 再确认一次状态
```

checkpoint 存在 task 的 `summary` / `phase` 字段里。**这是崩溃后唯一能拿回来的进度线索。**

### 4. 判断 lease 能不能抢

```bash
# lease 未过期（默认 30 分钟）→ 等，或者问用户要不要强制接管
# lease 已过期 → 直接 claim
gollum task claim "$TASK_ID" -o "agent-session-2"
```

claim 失败说明别人还持有 lease。**不要绕过**，等它过期或让用户决定。

### 5. 接着干

```bash
# 先重新对齐目标（上下文丢了，可能已经跑偏）
gollum goal-align "$TASK_ID"

# 重新跑一遍验收，确认之前的修改还在
gollum verify command -c "npm test"

# 接着推进，每个里程碑存 checkpoint
gollum task checkpoint "$TASK_ID" -s "恢复自上一 checkpoint，已重跑校验通过"
```

### 6. 反复失败的处理

```bash
gollum task fail "$TASK_ID" -r "第 N 次仍失败"
gollum recover "$TASK_ID"
```

`retry_count` 增长到 5 会自动 `block`，等人工介入。**别硬重试。**

## 环境观察优先

原则 3：**Environment > Memory > Checkpoint**。

恢复时先确认真实环境状态（文件改没改、测试过没过），**再**参考 checkpoint 里的记录。
checkpoint 可能过期，环境不会骗人。

## Anti-Patterns

- ❌ 不要跳过 `task show` 就动手
- ❌ 不要忽略 `lease_until` 强行 claim
- ❌ 不要因为「不记得做过什么」就重跑所有命令——先 verify 看现状
- ❌ 不要假设上次的修改还在——先 verify
- ❌ 不要用 MCP 工具

## 相关

- `gollum-task-run` — 正常开新活
- `gollum-recover` — 失败分类与策略
- `gollum-verify` — 怎么产出证据
