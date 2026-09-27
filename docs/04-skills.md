# 04 · Skills 设计

## 1. V0.1 四个 Core Skills

### 1.1 task-run

**职责**：第一次处理新任务。

```
Understand
  ↓
Define Success Criteria
  ↓
Plan
  ↓
Execute
  ↓
Verify
  ↓
Checkpoint
```

要点：

- 必须先写出 Success Criteria 再动手
- 强制走一次完整 Verify
- 结束时必须 `task.wait` / `task.complete` / `task.block` / `task.fail`

### 1.2 task-resume

**职责**：跨 Session 恢复。

```
task.get
  ↓
task.claim
  ↓
Load checkpoint
  ↓
Observe real environment
  ↓
Compare
  ↓
Continue / Replan
```

**铁律**：不允许假设 Checkpoint 仍然有效。任何 Resume 第一动作是 Observe Environment，不是信任 summary。

### 1.3 verify

**职责**：统一验证流程。

```
Define Assertion
  ↓
Collect Evidence
  ↓
Evaluate
```

返回三态：

- **PASS**
- **FAIL**
- **UNKNOWN**

`UNKNOWN` 不允许被当作成功。

### 1.4 recover

**职责**：失败恢复。

```
Failure
  ↓
Observe
  ↓
Classify Failure
  ↓
Identify Divergence
  ↓
Change Strategy
  ↓
Retry
  ↓
Verify
```

**禁止**「完全相同动作无限重试」。至少要改变 Strategy / 参数 / 顺序之一。

## 2. Skill 标准格式

不设计 Workflow DSL，全部 Markdown。建议统一：

```markdown
# Goal

# When to Use

# Inputs

# Tools

# Procedure

# Verification

# Recovery

# Completion
```

目录示例：

```
skills/core/task-resume/SKILL.md
```

## 3. 后续 Skills（V0.1 不做）

- `coding/github-issue` — 接 GitHub Issue → Task
- `coding/pr-fix` — 接 CI 失败 → 修复
- `android/app-launch`
- `robot/pick-place`
- `recover/cas-conflict`
- `verify/visual-diff`

Skill 是开放集合，按需扩展。V0.1 只保证 4 个 Core + 足够覆盖 Coding Demo。