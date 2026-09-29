---
name: gollum-verify
description: |
  Verify a task outcome using one of the whitelisted verifier types
  (unit_test, integration_test, build_pass, user_acceptance, static_check,
  artifact_exists). Turns hypotheses into evidence-backed facts.
---

# gollum-verify

## Goal

统一验证流程：把假设变成事实，留下 Evidence。

## When to Use

- Task 完成前，必须 Verify 一遍
- 每个 acceptance_criterion 必须有 evidence
- Outcome VERIFIED 前需要确认所有 Criterion 派生状态正确

## CLI

```bash
gollum verify command -c "<cmd>" [--cwd <path>] [--timeout <ms>] [--expect-exit <code>]
gollum verify git --type status|diff|log [--repo <path>] [--expect-clean]
gollum verify criterion <criterion_id>      # 按 criterion 绑定的 verifier 跑
gollum evidence list
```

支持的 `criterion --verifier-type`：`command` / `git` / `outcome_criterion` /
`timer_check` / `human_assert`

## Procedure

```bash
# 1. 拿 acceptance_criteria
gollum task show "$TASK_ID"
```

```text
2. 对每条 acceptance_criterion：
   a. 选 verify 方式，按 PRD §7.3 五种 VerifierType
   b. 跑真实的校验命令，拿到输出当证据
   c. 若有对应 Criterion，挂 evidence
      gollum verify criterion <criterion_id>
      → derived_status 自动更新（DESIGN §5.3）
   d. 若没对应 Criterion → evidence 挂 acceptance_criterion 名下
3. 重新评估：
   gollum outcome remaining-gap <outcome_id>
4. 若 remaining == 0 → 可以收工：
   gollum task complete "$TASK_ID"
   gollum outcome mark-verified "$OUTCOME_ID"   # 所有 criterion PASS 才有效
```

## Verification 返回值

```json
{
  "ok": true,
  "data": {...},
  "observation": "...",
  "evidence": {...},
  "error": null
}
```

失败：

```json
{
  "ok": false,
  "error": {
    "type": "ASSERTION_FAILED | ENVIRONMENT_CHANGED | ..."，
    "message": "...",
    "retryable": true|false
  }
}
```

## 三态语义

| status | 含义 | 后续 |
|---|---|---|
| PASS | 验证通过 | attach_evidence → criterion PASS |
| FAIL | 验证失败 | 触发 recover Skill |
| **UNKNOWN** | **evidence 不足** | **不能算成功**；继续收集 evidence 或升级到 BLOCKED |

> **UNKNOWN 不允许被当作成功。**

## Recovery

Verify FAIL 时：

```
1. 观察失败原因（error.type）
2. 若 ENVIRONMENT_CHANGED → 重新 Observe + Decide（不要重复同一动作）
3. 若 ASSERTION_FAILED → 修复代码 + 重新 Verify
4. 连续 3 次仍 FAIL → 升级到 recover Skill 换 Strategy
```

## Completion

Verify 完成后必须：

- 至少一条 evidence 已 attach 到对应 Criterion
- outcome-evaluate 已重新调用
- 若 remaining_gap.remaining == 0 → outcome.mark_verified
- task.checkpoint(summary)