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
| issue 描述含糊、复现步骤不全 | 停下问，别猜着改 |
| 要改核心 API / 破坏性变更 | 停下问 |
| 搜出来 5 个候选 issue | 列出编号让人挑，**别自己挑** |
| 改了 30 分钟还没定位到根因 | `gollum task fail` + `gollum recover`，别硬扛 |
| 验证跑不过 | 同上，**不要**开 PR |

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

### 3. 落成 Goal → Outcome → Task

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

### 4. 先复现，再改

```bash
gollum task claim "$TASK_ID" -o claude/issue-$NUMBER
```

**先写一个能复现 issue 的失败用例/命令，跑一遍看到它失败。** 没见过失败就不算定位到问题。
每到一个可恢复的里程碑就存 checkpoint：

```bash
gollum task checkpoint "$TASK_ID" \
  -s "已复现：<触发条件>" -o "<观察到的现象>" --next-action "<下一步>"
```

### 5. 实现

改代码。`gollum` 不管你写代码，它只管状态；改法遵循仓库自己的规范（先读 `AGENTS.md` / `CONTRIBUTING.md`）。

### 6. 真跑验证

```bash
<那条会失败的复现命令>     # 现在应该通过
gollum verify criterion "$CRITERION_ID"
```

命令退出码非 0 就**停下**，不要开 PR。仓库自带的完整校验也要跑（如 `npm test`、`pytest`）。

### 7. 写 evidence

```bash
gollum evidence create -c "$CRITERION_ID" --status PASS \
  --executor claude/issue-$NUMBER --data '{"command":"<校验命令>","exit_code":0}'
```

### 8. Fork + 分支 + 提交 + 推送

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

### 9. 开 DRAFT PR，然后停下

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

### 10. 收工入库

```bash
gollum task complete "$TASK_ID" -s "已修复并提交 draft PR <url>"
gollum goal list --tree
```

---

## Anti-Patterns

- ❌ 没跑验证就开 PR —— 这是最严重的
- ❌ 复现步骤靠猜，不实际跑一遍
- ❌ 直接 push 到别人的仓库（要推 fork）
- ❌ 自动把 draft 转正式 PR
- ❌ issue 有多个候选时自己挑一个就开始改
- ❌ 改了代码但没 `gollum task complete`，状态烂尾
- ❌ 改完发现验证不过就硬开 PR

## 失败处理

```bash
gollum task fail "$TASK_ID" -r "复现命令仍失败：<观察>"
gollum recover "$TASK_ID"     # retry / change_strategy / block
```

`recover` 连续 5 次仍 block 就停下找用户，不要无限重试。

## 收尾检查清单

- [ ] `gollum verify criterion` 通过
- [ ] evidence 已写入且 status=PASS
- [ ] PR 是 **draft**
- [ ] PR body 引用了 `Closes #N`
- [ ] 推的是 fork 不是上游
- [ ] 已向用户汇报并**停下**
