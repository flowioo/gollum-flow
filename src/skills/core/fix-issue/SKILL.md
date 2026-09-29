---
name: gollum-fix-issue
description: |
  End-to-end "fix a GitHub issue" loop: search issues across GitHub, plan the fix
  with gollum, implement it on a branch, verify it with a real command, and open
  a DRAFT pull request. Use when the user says "修 github issue <repo>#<n>",
  "fix issue 123", "找个 issue 修一下", "fix this bug and open a PR". Stops after
  the draft PR so a human decides whether it becomes real. No MCP.
---

# gollum-fix-issue

## Goal

把一句「修 github issue」跑完一整条链路：**找 issue → 落成 Goal/Outcome/Task → 改代码 → 真跑验证 → 开 draft PR → 停下**。

全程用 `gollum` CLI + `git` + `gh`，**不要用 MCP 工具**。

## When to Use

- 「修一下 github issue 123」「修 cli/cli#11014」
- 「找个 typo issue 修一下」
- 「这个 bug 修了吗，帮我开个 PR」

**不适用**：本地改动没关联 issue；只要人读得懂的说明文档；一次要动好几个不相关仓库。

## 铁律

```text
1. 验证没跑过 = 没修完。禁止在没跑过真命令的情况下开 PR。
2. 只开 draft PR，然后停下。转正式 PR 由人决定。
3. 不在别人的仓库上直接 push。只推自己的 fork。
4. 不复现、不定位的「修复」不许提 PR。
```

## 何时该停下来问人

| 情况 | 怎么办 |
|---|---|
| **清晰度 ≤ 3（见 Phase 1）** | 停下问，别猜着改 |
| 要改核心 API / 破坏性变更 | 停下问 |
| 搜出来 5 个候选 issue | 列出编号让人挑，**别自己挑** |
| 改了 30 分钟还没定位到根因 | `gollum task fail` + `gollum recover`，别硬扛 |
| 验证跑不过 | 同上，**不要**开 PR |

**用户迟迟不回应**不是继续干等的理由。按 `autoresearch` 的思路：**先自主探索，
不行就回退。** 见下面 Phase 4。

---

## Procedure

### 0. 前置检查

```bash
gollum github auth        # 必须认证，否则搜索会被限流到 60 次/小时
gh auth status            # 提 PR / fork 用它
gollum init               # 首次使用
```

`gollum github auth` 报 `no GitHub token` 就先停，让用户跑 `gh auth login`。

### 1. 找 issue

用户给了编号就直接跳到第 2 步。没给就搜：

```bash
gollum github search "关键词" --limit 10
gollum github search "typo" --label good-first-issue --limit 10
gollum github search "crash on startup" --language python --limit 10
```

输出是 `owner/repo#number  标题  [标签]` 加 URL。**有多个候选时列给人挑。**

### 2. 读 issue 全文

```bash
gollum github issue "$REPO" "$NUMBER"
```

`$REPO` 形如 `cli/cli`。**必须读全文**——标题党很多，body 里才有复现步骤。

### Phase 1 — 清晰度打分（读完 issue 立刻做）

**读完 issue 全文、动手之前**，先按 `gollum-plan` 的 5 项标准打分（复现 / 期望vs实际 /
定位线索 / 验收标准 / 范围），每项 0 或 1：

| 得分 | 结论 | 怎么做 |
|---|---|---|
| 4–5 | 明确 | 进 Phase 2，仍要先确认方案 |
| 2–3 | 模糊 | **必须先问** |
| 0–1 | 不明确 | 停下，别猜 |

把分数和缺项报给用户：

```text
issue 清晰度 3/5 — 缺：验收标准、改动范围
```

同时检查 issue 是不是仍然可领取：已被 assign 或有进行中的 PR 就别去抢。

### Phase 2 — 出方案给用户确认（不落库）

**一条 `gollum goal create` 都不许执行。** 先把方案写出来给用户看：

```text
issue:   <url>  清晰度 4/5
打算这样修，确认吗？

Goal     修复 <repo>#<n>：<title>
Outcome  <可验证的结果>
  └ criterion  <怎么验证>  ← 跑：<真实命令>
  └ Task 1  <一个最小动作>（<N>min）
      验收：<可判定的条件>

改动面：<会碰哪些文件>
```

拿到确认才落库。`gollum goal` 没有 delete——**建错了删不掉**，这是要确认的根本原因。

### Phase 3 — baseline：先复现，再动手

这是 `autoresearch` 的核心：**动手前必须先测出基线**，否则你不知道改动有没有用。

```bash
git checkout -b fix/$NUMBER-...
<复现命令>            # 必须真的失败一次
```

**没见过失败就不算定位到问题。** 跑不出来 = issue 描述不全或已过时，
这时候按 Phase 4 走，不要硬改。

基线结果记下来，后面每次改动都跟它比。

### Phase 3.5 — 落库（确认之后才做）

按 `gollum-plan` 的流程建，来源写清是哪个 issue：

```bash
PROJECT_ID=$(gollum project list | grep -oE '[0-9A-Z]{26}' | head -1)
GOAL_ID=$(gollum goal create -p "$PROJECT_ID" \
  -t "修复 $REPO#$NUMBER：<issue 标题>" \
  -d "来源 issue: $ISSUE_URL" | grep -oE '[0-9A-Z]{26}' | head -1)
OUTCOME_ID=$(gollum outcome create -g "$GOAL_ID" \
  -t "<可验证的结果>" | grep -oE '[0-9A-Z]{26}' | head -1)
```

**Outcome 必须可验证。** 建 criterion，把验证命令写死：

```bash
CRITERION_ID=$(gollum criterion create -o "$OUTCOME_ID" \
  -d "复现该 issue 的命令现在退出码为 0" \
  --verifier-type command \
  --verifier-config '{"command":"<真实校验命令>"}' | grep -oE '[0-9A-Z]{26}' | head -1)

TASK_ID=$(gollum task create -o "$OUTCOME_ID" \
  -t "定位并修复 <一句话>" \
  --acceptance "能复现原 bug" "修复后复现命令不再失败" \
  --estimated-minutes 25 | grep -oE '[0-9A-Z]{26}' | head -1)
```

`--estimated-minutes` 超 30 会被 `gollum validate` 判错，必须拆。

```bash
gollum task claim "$TASK_ID" -o claude/issue-$NUMBER
```

每到一个可恢复的里程碑就存 checkpoint：

```bash
gollum task checkpoint "$TASK_ID" \
  -s "基线：<复现失败的表现>" -o "<观察>" --next-action "<下一步>"
```

## Phase 4 — 自主探索循环（用户没回应时）

`autoresearch` 的做法：**循环一旦启动就自主跑，不再打断用户问"要不要继续"，
但每次尝试都先 commit，改坏了能干净回退。**

```text
循环体：
  1. 提一个假设（"是 X 的拼写错了"）
  2. 改代码，改动尽量小
  3. git add -A && git commit -m "attempt: <假设>"   ← 先 commit，才能干净回退
  4. 跑校验命令
  5. 比对基线：
       变好 → 记下 commit hash，进入下一次尝试
       没变好或更糟 → git reset --hard <上一个好 hash>，记录失败原因，换个假设
  6. 循环 3 次仍没进展 → 停下来报告
```

要点：

- **每次尝试都先 commit**，否则 `git reset` 回退不干净。
- **单一指标**：就用 Phase 3 定的那个校验命令，不要一边跑一边换标准。
- **不要越界**：不改 `autoresearch` 意义上的"基础设施文件"（本 skill 指
  `CONTRIBUTING.md` 要求的规范文件、CI 配置、依赖清单），除非 issue 明确要求。
- **保留一份尝试记录**（TSV 或直接记在 checkpoint 里）：

  | # | 假设 | 校验结果 | 处置 |
  |---|---|---|---|
  | 0 | 基线 | 失败 | — |
  | 1 | cli.py 拼写错误 | 通过 | 保留 |
  | 2 | 改 README | 无变化 | 回退 |

### 循环也定位不到根因 → 回退

```bash
git reset --hard <基线 commit>
gollum task fail "$TASK_ID" -r "3 次尝试均未定位根因：<结论>"
gollum recover "$TASK_ID"
```

然后如实告诉用户：**信息不足，定位不到，没能修。**

**不要**为了"有个结果"而硬凑一个改动开 PR——那比承认失败更糟。
注意 `gollum goal` 没有 delete，已经落库的 Goal 会留在那里，这是确认闸门存在的原因。

## Phase 5 — 落定改动

### 5.1 实现

改代码。`gollum` 不管你写代码，它只管状态；改法遵循仓库自己的规范（先读 `AGENTS.md` / `CONTRIBUTING.md`）。

### 5.2 真跑验证

```bash
<那条会失败的复现命令>     # 现在应该通过
gollum verify criterion "$CRITERION_ID"
```

命令退出码非 0 就**停下**，不要开 PR。仓库自带的完整校验也要跑（如 `npm test`、`pytest`）。

### 5.3 写 evidence

```bash
gollum evidence create -c "$CRITERION_ID" --status PASS \
  --executor claude/issue-$NUMBER --data '{"command":"<校验命令>","exit_code":0}'
```

### 5.4 Fork + 分支 + 提交 + 推送

```bash
gollum github repo                 # 确认 owner/repo 和 ssh
gh repo fork "$REPO" --clone=false  # 只需第一次；已 fork 会自动跳过
git remote add fork "git@github.com:$(gh api user -q .login)/$REPO.git" 2>/dev/null || true

BRANCH="fix/$NUMBER-$(echo "$TITLE" | tr 'A-Z ' 'a-z-' | cut -c1-40)"
git checkout -b "$BRANCH"
git add -A && git commit -m "fix: $TITLE

Closes #$NUMBER"
git push -u "fork/$BRANCH" "$BRANCH"
```

### 5.5 开 DRAFT PR，然后停下

用 `gh` 而不是 `gollum github pr`——`gh` 能自动处理 fork 跨仓的 head 分支：

```bash
gh pr create --repo "$REPO" --draft \
  --head "$(gh api user -q .login):$BRANCH" \
  --base main \
  --title "fix: $TITLE" \
  --body "Closes #$NUMBER

## 验证
\`\`\`
<校验命令>
\`\`\`
输出见下……"
```

然后**必须停下来**，向用户汇报：

```text
已开 draft PR：
  https://github.com/<owner>/<repo>/pull/<n>

Issue:  <issue url>
改了:    <改了哪些文件，一句话>
验证:    <跑了什么命令，退出码>
验证记录: gollum evidence <evidence_id>

要我把它转成正式 PR 吗？
```

**不要自动 `gh pr ready`。** 用户确认后才转。

### 5.6 收工入库

```bash
gollum task complete "$TASK_ID" -s "已修复并提交 draft PR <url>"
gollum goal list --tree
```

---

## Anti-Patterns

- ❌ **没确认就 `gollum goal create`** —— goal 删不掉，这是最贵的错
- ❌ **不打清晰度分就开始** —— 模糊需求建出来的 Goal 会把错误方向固化
- ❌ 没跑验证就开 PR —— 这是最严重的
- ❌ 复现步骤靠猜，不实际跑一遍
- ❌ 直接 push 到别人的仓库（要推 fork）
- ❌ 自动把 draft 转正式 PR
- ❌ issue 有多个候选时自己挑一个就开始改
- ❌ 改了代码但没 `gollum task complete`，状态烂尾
- ❌ 改完发现验证不过就硬开 PR
- ❌ 循环里不 commit 就改——`git reset` 回退不干净
- ❌ 为了"有结果"硬凑一个改动 —— 定位不到就如实说定位不到

## 失败处理

```bash
gollum task fail "$TASK_ID" -r "复现命令仍失败：<观察>"
gollum recover "$TASK_ID"     # retry / change_strategy / block
```

`recover` 连续 5 次仍 block 就停下找用户，不要无限重试。

代码层面的回退是 `git reset --hard <基线 commit>`，不是 `gollum` 的职责——
`gollum` 只管状态，代码归 git。

## 收尾检查清单

流程闸门：

- [ ] 读过 issue 全文并打过清晰度分（分数已报给用户）
- [ ] 清晰度 ≤ 3 时**问过**用户
- [ ] **建库前**把方案给用户确认过
- [ ] 先跑出失败基线才动的手
- [ ] 用户没回应时走了探索/回退，而不是干等

产出：

- [ ] `gollum verify criterion` 通过
- [ ] evidence 已写入且 status=PASS
- [ ] PR 是 **draft**
- [ ] PR body 引用了 `Closes #N`
- [ ] 推的是 fork 不是上游
- [ ] 已向用户汇报并**停下**
