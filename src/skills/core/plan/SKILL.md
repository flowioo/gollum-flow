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
1. Task 必须挂在 Outcome 下。直接 Goal → Task 是非法的。
2. 先打分管分，再出方案给用户确认，确认之后才落库。
3. gollum goal 只有 create/list/show —— 建错了删不掉。所以确认前一律不落库。
```

`gollum task create` 缺 `--outcome-id` 会直接报错，这是设计如此。

**第 2、3 条是硬闸门。** 用户没确认之前，一条 `gollum goal create` 都不许执行。

## Phase 0 — 清晰度打分

建任何东西之前，先给需求打分。**每项 0 或 1**，满分 5：

| # | 维度 | 1 分的样子 | 0 分的样子 |
|---|---|---|---|
| 1 | **复现** | 有能直接跑的命令/步骤，能看到失败 | 只说"坏了""不对" |
| 2 | **期望 vs 实际** | 写清正确输出和错误输出 | 只有期望，或只有实际 |
| 3 | **定位线索** | 指到文件、函数、报错信息 | 完全没有 |
| 4 | **验收标准** | 说得出怎么算修好 | 修到"感觉对了" |
| 5 | **范围** | 改动面小且清楚 | 说不清会动到哪 |

| 得分 | 结论 | 怎么做 |
|---|---|---|
| **4–5** | 明确 | 直接进 Phase 1，仍要在建库前确认方案 |
| **2–3** | 模糊 | **必须先问**，一次问清打分里缺的项 |
| **0–1** | 不明确 | **停下来问，别猜着建。** 猜出来的 Goal 会把错误方向固化进状态层 |

把分数和缺项一起报给用户：

```text
清晰度 2/5 — 缺：复现步骤、验收标准
```

### 模糊时的追问模板

一次问全，别挤牙膏：

```text
我按 issue 描述理解是：<一句话复述>
不清楚的两点：
1. 怎么算修好？（具体到能跑的命令或输出）
2. 改动范围允许到哪？（只改 X，还是可以动 Y）
```

### 用户迟迟不答怎么办

**不要干等，也不要硬猜。** 按 autoresearch 的思路走：

1. 先做**只读探索**——读代码、跑复现、定位根因。探索不落库、不改代码。
2. 探索能自证清楚 → 拿着结论回来，让用户确认**已验证的方案**再建库。
3. 探索也定位不了 → **回退**，如实说"信息不足，定位不到"，不建任何 Goal。

宁可空手回来，也不要往状态层里写一个方向错误的目标——它比没有更糟。

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

### 3. 出方案给用户确认 —— 这一步不落库

**先在脑子里/对话里把方案写完整，一条命令都别执行。** 然后拿给用户看：

```text
打算这样建，确认吗？

Goal     <一句话标题>
         背景：<为什么现在要做>
Outcome  <什么结果算推进>（可验证）
  └ criterion  <怎么验证>  ← 跑：<真实命令>
  └ Task 1  <一个最小动作>（<N>min）
      验收：<可判定的条件>
  └ Task 2  <一个最小动作>（<N>min）
      验收：<可判定的条件>

改动面：<会碰哪些文件/子系统>
```

拿到确认后再往下走。用户改方案就改，**不要先建了再解释**。

### 4. 确认后：建 Goal

```bash
gollum goal create \
  -p "$PROJECT_ID" \
  -t "让登录测试在 CI 上不再 flaky" \
  -d "当前偶发失败，阻塞发布"
```

输出里会有一串 ULID，记作 `GOAL_ID`。**Goal 要长期稳定，不要频繁改。**

### 5. 建 Outcome

Outcome 回答「出现什么结果算 Goal 被推进」，必须可验证：

```bash
gollum outcome create -g "$GOAL_ID" -t "登录测试连续 10 次全绿"
# → OUTCOME_ID
```

### 6. 建 Criterion（让 Outcome 可验证）

```bash
gollum criterion create \
  -o "$OUTCOME_ID" \
  -d "npm test 连续 10 次退出码为 0" \
  --verifier-type command \
  --verifier-config '{"command":"npm test"}'
```

**没有 criterion 的 Outcome 永远无法 VERIFIED**，`gollum validate` 会报 error。

### 7. 拆 Task

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

### 8. 批量拆：先写 plan.json

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

### 9. 落库后回读确认

```bash
gollum goal list --tree
```

应该看到完整的 Goal → Outcome → Task 树。

## 什么时候必须停下来问

| 情况 | 怎么办 |
|---|---|
| 清晰度 ≤ 3 | **先问**，按上面的追问模板一次问清 |
| 清晰度 ≤ 1 | 停下，别猜着建 |
| 用户没回应 | 只读探索 → 能自证就带结论回来再问；不能就回退，不落库 |
| 拆出 > 5 个 task | 先给方案，认可再建 |
| 与已有 goal 重叠 | 复用已有 goal，加 outcome 而不是新建 goal |
| 要改核心 API / 破坏性变更 | 停下问 |

## Anti-Patterns

- ❌ **不要在用户确认前执行 `gollum goal create`** —— goal 删不掉
- ❌ 不要跳过 step 1 直接建——会造重复目标
- ❌ 不要跳过 Outcome 直接建 Task
- ❌ 不要建没有 criterion 的 Outcome（永远无法 VERIFIED）
- ❌ 不要用 `gollum validate` 代替建任务，它不落库
- ❌ 不要把"顺手重构"混进来——见 `gollum-goal-align` 的 scope creep 检查
- ❌ 不要用 MCP 工具
- ❌ 不要因为"用户没回"就自己拍板建库——先探索，回退也是选项

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
