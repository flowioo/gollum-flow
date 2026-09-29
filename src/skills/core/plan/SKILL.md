---
name: gollum-plan
description: |
  Turn what the user said into a persisted Goal / Outcome / Task hierarchy using
  the `gollum` CLI. Use when the user asks to "set a goal", "track this work",
  "break this down", "create a task for X", or starts a new unit of work. Reads
  existing state before creating anything so it does not duplicate. No MCP.
---

# gollum-plan

## Goal

把用户的一句话，落成 `Goal → Outcome → Task` 三层结构，存进 Gollum。

**全程用 `gollum` CLI，不要用 MCP 工具。**

## When to Use

- 用户说「设个目标」「把这个记下来」「拆一下这个活儿」
- 用户描述了一件值得持续推进的事
- 需求明确到可以拆出可验收的 task

**不适用**：只是问问题、临时改一行代码、纯讨论。

## 铁律

```text
Task 必须挂在 Outcome 下。直接 Goal → Task 是非法的。
```

`gollum task create` 缺 `--outcome-id` 会直接报错，这是设计如此。

## Procedure

### 1. 先查，别先建

```bash
gollum goal list --tree        # 看有没有已经建过的同类目标
gollum project list            # 拿 project_id
```

已存在就复用，不要重复建。

### 2. 拿到 project_id

```bash
gollum project list
# 输出里那串 26 位 ULID 就是 project_id，形如 01M3PRQMRA7DBDKWPFQJX5FDV3
```

首次使用先 `gollum init`。

### 3. 建 Goal

```bash
gollum goal create \
  -p "$PROJECT_ID" \
  -t "让登录测试在 CI 上不再 flaky" \
  -d "当前偶发失败，阻塞发布"
```

输出里会有一串 ULID，记作 `GOAL_ID`。**Goal 要长期稳定，不要频繁改。**

### 4. 建 Outcome

Outcome 回答「出现什么结果算 Goal 被推进」，必须可验证：

```bash
gollum outcome create -g "$GOAL_ID" -t "登录测试连续 10 次全绿"
# → OUTCOME_ID
```

### 5. 建 Criterion（让 Outcome 可验证）

```bash
gollum criterion create \
  -o "$OUTCOME_ID" \
  -d "npm test 连续 10 次退出码为 0" \
  --verifier-type command \
  --verifier-config '{"command":"npm test"}'
```

**没有 criterion 的 Outcome 永远无法 VERIFIED**，`gollum validate` 会报 error。

### 6. 拆 Task

一个 task = 一个可独立验证的最小动作：

```bash
gollum task create \
  -o "$OUTCOME_ID" \
  -t "定位竞态源头" \
  --acceptance "打印出实际触发顺序" "确认是 await 顺序问题" \
  --estimated-minutes 25
```

| 参数 | 规则 |
|---|---|
| `-o, --outcome-id` | **必填**，父 Outcome |
| `--acceptance <...>` | 空格分隔，可多个；写可判定的条件 |
| `--estimated-minutes` | **超过 30 会警告要拆**，大的活儿必须拆 |
| `--priority <n>` | 越大越优先，默认 0 |

### 7. 批量拆：先写 plan.json

```bash
gollum validate --plan plan.json
```

plan 结构：

```json
{
  "title": "让登录测试不再 flaky",
  "outcomes": [{
    "title": "登录测试连续 10 次全绿",
    "criteria": [
      { "description": "npm test 10 次全绿",
        "verifier": { "type": "command", "command": "npm test" } }
    ],
    "tasks": [
      { "title": "定位竞态源头",
        "acceptance_criteria": ["打印出触发顺序"],
        "estimated_minutes": 25 },
      { "title": "加显式等待",
        "acceptance_criteria": ["CI 10 次全绿"],
        "estimated_minutes": 20 }
    ]
  }]
}
```

`validate` 只检查，**不落库**。要真建还得逐条 `task create`。

### 8. 确认

```bash
gollum goal list --tree
```

应该看到完整的 Goal → Outcome → Task 树。

## 跟用户确认的时机

| 情况 | 怎么办 |
|---|---|
| 需求一句话讲得清 | 直接建，建完汇报结构 |
| 目标模糊（"优化一下性能"） | **先问**，别猜着建 |
| 拆出 > 5 个 task | 先给用户看拆分方案，认可再建 |
| 用户描述的和已有 goal 重叠 | 复用已有 goal，加 outcome 而不是新建 goal |

## Anti-Patterns

- ❌ 不要跳过 step 1 直接建——会造重复目标
- ❌ 不要跳过 Outcome 直接建 Task
- ❌ 不要建没有 criterion 的 Outcome（永远无法 VERIFIED）
- ❌ 不要用 `gollum validate` 代替建任务，它不落库
- ❌ 不要把"顺手重构"混进来——见 `gollum-goal-align` 的 scope creep 检查
- ❌ 不要用 MCP 工具

## 建完之后

告诉用户建了什么：

```text
已创建：
  Goal     01M3...  让登录测试在 CI 上不再 flaky
  Outcome  01M3...  登录测试连续 10 次全绿
    └ Task 01M3...  定位竞态源头（25min，验收：打印出触发顺序）
    └ Task 01M3...  加显式等待（20min，验收：CI 10 次全绿）

下一步：gollum scheduler pick
```
