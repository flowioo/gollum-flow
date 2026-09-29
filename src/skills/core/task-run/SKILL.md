---
name: gollum-task-run
description: |
  Run a Gollum Task end-to-end using the `gollum` CLI: align → claim → checkpoint →
  verify → complete or fail. Use when the scheduler hands you a PENDING task.
  Does NOT use MCP — every step is a shell command. For cross-session recovery use
  gollum-task-run-resume instead.
---

# gollum-task-run

## Goal

首次处理一个新 Task，按 Gollum 标准流程推进到完成或受控失败。

## When to Use

- Scheduler 选中一个 `PENDING` Task
- 你刚 claim 到一个 Task 准备开工
- **不用于**跨 Session 恢复（用 `gollum-task-run-resume`）

## 前提

所有操作走 `gollum` CLI（已在 PATH）。**不要用 MCP 工具**——本 skill 的每一步都是 shell 命令。

## Procedure

```bash
# 0. 拿到 task_id。若用户没说，先问或从 scheduler 拿
TASK_ID="<task_id>"

# 1. 读任务现状（拿到 outcome_id / goal_id / acceptance_criteria）
gollum task show "$TASK_ID"

# 2. 【强制】先问：这活儿还服务 Goal 吗？
gollum goal-align "$TASK_ID"
#   verdict=aligned     → 继续第 3 步
#   verdict=uncertain   → 说明理由给用户，或拆小 task 后继续
#   verdict=misaligned  → 走 gollum handle-misaligned "$TASK_ID"，换 task，**不要**硬做

# 3. 看还差什么（不是百分比，是具体哪条没满足）
gollum outcome remaining-gap <outcome_id>

# 4. 领活（拿 lease；-o 用你的 session 标识）
gollum task claim "$TASK_ID" -o "agent-session"

# 5. 开工。每完成一个可恢复的里程碑就存一次 checkpoint
#    -s 是必填的，写清楚"做到哪、为什么"
gollum task checkpoint "$TASK_ID" -s "已定位到 test 里 await 顺序问题"

# 6. 逐条满足 acceptance_criteria，然后跑校验
#    把真实校验命令跑一遍，输出就是证据
gollum verify command -c "npm test"
gollum verify git --type status --expect-clean
#    若该 outcome 有 criterion，先建再验
#      gollum criterion create -o <outcome_id> -d "测试连续 10 次全绿" \
#        --verifier-type command --verifier-config '{"command":"npm test"}'
#      gollum verify criterion <criterion_id>

# 7. 确认 outcome 的 remaining_gap 归零
gollum outcome remaining-gap <outcome_id>

# 8. 收工
gollum task complete "$TASK_ID"
```

## 失败处理

```bash
# 失败了不要原地重试，先分类
gollum task fail "$TASK_ID" -r "测试仍 flaky，第 3 次尝试"
gollum recover "$TASK_ID"     # 自动决定 retry / change_strategy / block
```

`recover` 的策略：

| retry_count | 策略 |
|---|---|
| < 3 | retry |
| 3–4 | change_strategy |
| ≥ 5 | block（需要人）|

CAS 冲突时 Gollum 自动处理（reload + backoff 1–3s + 最多 3 次），**不要**自己写重试循环。

## 收尾（可选）

任务全做完后，把 Outcome 标记完成：

```bash
gollum outcome mark-verified <outcome_id>   # 需要所有 criterion 都 PASS
```

## Anti-Patterns

- ❌ 不要跳过 `goal-align` 直接开工
- ❌ 不要自己发明 verify 方式——必须产出真实命令输出
- ❌ 不要在 `gollum` 之外直接改 DB
- ❌ 不要用 MCP 工具，本 skill 统一走 CLI
- ❌ 不要因为"我觉得做完了"就 complete，必须 verify 通过
- ❌ 不要绕开 CLI 去调 MCP server 的工具——本 skill 统一走 `gollum` 命令

## Recovery

进程崩了用 `gollum-task-run-resume`；lease 过期（默认 30 分钟无心跳）后任何 session 都能重新 claim。
