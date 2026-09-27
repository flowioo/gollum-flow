# Gollum 方案评审

> 评审视角：实施可行性 + 架构风险 + V0.1 落地路径
> **V0.1 已收敛为「自主循环可证明」+ 七层语义模型 + 砍掉 progress 数字**

---

## 1. 整体判断

**方案质量：高。** 思路清晰、边界克制。引入 Outcome 作为进展单位是本质升级；Task 按结果拆而非按 Session 寿命拆是核心约束；V0.1 只证明自主循环、不碰生态集成是正确的范围控制。

**本轮关键收敛**：砍掉 `progress` 数字，改用 Outcome 状态机 + Criterion 三段式 + Evidence 派生。这是核心架构决定，**Goodhart's Law 防御**。

---

## 2. 5 个风险的拍板结果

### 风险 1：success_criteria 谁写 ✅ 同意 + 加深

**你的拍板**：「V0.1 用户/上层 Planner 提供，CLI 只做结构校验，不做语义裁判。模糊词检测可以 warning，但不能阻止。很多真实目标本身就带主观性。」

**采纳**。改进方案：**Criterion 三段式绑定**（criterion → verifier → evidence）。

> 「稳定运行 4 小时」看似模糊，但有 `timer_check` 绑定 → **可验证**。
> 真正不能验证的 criterion 是那些**没绑定 verifier** 的 → 标 `UNVERIFIED`。
> CLI 不做语义裁判（不检测「稳定」「高效」），只做结构校验。

详见 [09-goal-outcome-model.md §3](./09-goal-outcome-model.md)。

### 风险 2：progress gaming 🔥 直接砍掉

**你的拍板**：「progress score 我建议直接砍掉。这是 Goodhart's Law：指标一旦成为目标，就不再是好指标。所以 Outcome 状态就够了...调度不看 83%。」

**完全采纳**。

> **Progress is not a number. Progress is verified state change.**

砍掉方案：

| 旧 | 新 |
|---|---|
| `progress: 0.0~1.0` | ❌ 砍掉 |
| `progress = pass / total` | ❌ 公式砍掉 |
| `Outcome.status = in_progress / achieved` | → `NOT_STARTED / IN_PROGRESS / BLOCKED / VERIFIED / FAILED` |
| `Criterion` 是 JSON list | → 独立表 + `derived_status` 派生 |
| 调度看 `progress` | → 调度看 `remaining_gap` + `priority` + `status` |

新增原则 13（[08-principles.md](./08-principles.md)）。

### 风险 3：goal-align 准确性 ✅ 同意双轨 + 三级 + 不频繁找人

**你的拍板**：「双轨思路对，但改成：Evidence-based check + LLM semantic check。若 misaligned，默认 pause/replan，只有涉及修改 Goal、删除关键 Outcome、扩大 scope 时才 Human confirm。」

**采纳**。三级判定：

| verdict | 含义 | 系统动作 |
|---|---|---|
| `aligned` | 推进 Outcome | continue |
| `uncertain` | 不确定 / evidence 矛盾 | re-evaluate / replan |
| `misaligned` | 与 Outcome 无关 / scope creep | pause current task → rollback / backlog → 换 task |

**核心变化**：`misaligned` 默认**不找人**，自己 pause / rollback / 换 task。

> **Human 负责改变边界，不负责日常纠偏。**

只有这些情况找 Human：
- 修改 Goal
- 删除关键 Outcome
- 扩大 Outcome scope
- 不可逆操作
- 高风险操作

新增原则 15（[08-principles.md](./08-principles.md)）。

### 风险 4：Outcome 拆分粒度 ✅ 同意 + 改规则

**你的拍板**：「≤7 Outcome / ≤5 criteria 可以作为 soft warning，不要做 hard limit。更好的规则：一个 Outcome 必须能独立 Verify，criteria 必须共同描述同一个结果。」

**采纳**。改用更本质的规则：

> **一个 Outcome 必须能独立 Verify。**
> **Criteria 必须共同描述同一个结果。**

数字上限作为 **soft warning**：
- 每 Goal ≤ 7 Outcome → warning，不是 hard limit
- 每 Outcome ≤ 5 criteria → warning

### 风险 5：Project 层 ✅ 同意

**你的拍板**：「Schema 保留 Project，V0.1 CLI 默认 singleton project。这是最省事的。」

**采纳**。表结构保留，CLI 默认 singleton。

---

## 3. 关键概念：七层语义模型

```
Goal            = 为什么做          (Direction)
   ↓
Outcome         = 想改变什么状态    (State to change)
   ↓
Criteria        = 什么算完成        (Definition of done)
   ↓
Evidence        = 凭什么说完成      (Proof)
   ↓
Task            = 怎么推进          (Action)
   ↓
Execution       = 一次尝试          (Attempt)
   ↓
Verify          = 验证              (Truth check)
```

详见 [09-goal-outcome-model.md](./09-goal-outcome-model.md)。

---

## 4. Criterion 三段式（核心新机制）

```
criterion  →  verifier  →  evidence
              (怎么验证)   (凭什么说完成)
```

没有 verifier → criterion 标 `UNVERIFIED` → Outcome 无法 VERIFIED。

CLI 不做语义裁判（不检测模糊词），只做结构校验（verifier 必须存在）。

---

## 5. Outcome VERIFIED 判定（V0.1 收敛版）

```
outcome_is_verified = for each criterion: derived_status == PASS
```

**不依赖 progress 数字**。只看 Criterion 是否都有 PASS evidence。

---

## 6. V0.1 决策点（最终版）

| # | 决策 | 拍板 | 备注 |
|---|---|---|---|
| 1 | Host | **Codex CLI** | 你已经在用 |
| 2 | Workflow Store | **SQLite + WAL** | 简单、够用 |
| 3 | CLI 语言 | **TypeScript / Node** | 跟 Codex 同栈 |
| 4 | MCP | **stdio 模式** | 复用社区方案 |
| 5 | Task ID | **ULID** | 时间序 + 可排序 |
| 6 | Event Log | **append-only + 定期 checkpoint** | |
| 7 | 默认 Lease | **15 min（Coding）** | |
| 8 | CAS 冲突 | **reload + backoff 1-3s + re-evaluate + ≤3** | 已升级 |
| 9 | success_criteria 来源 | **用户/Planner 提供，CLI 做结构校验** | 不做语义裁判 |
| 10 | progress | **🔴 直接砍掉，改用状态机 + remaining_gap** | Goodhart's Law 防御 |
| 11 | goal-align 误判 | **三级 aligned/uncertain/misaligned；misaligned 自处理，不找人** | Human 只改边界 |
| 12 | Outcome 数量上限 | **soft warning（≤7/≤5）** | 规则：必须独立 Verify |
| 13 | Project 层 | **Schema 保留，CLI singleton** | 最省事 |
| 14 | Criterion 三段式 | **criterion → verifier → evidence** | 没 verifier → UNVERIFIED |

---

## 7. 实施路径（4 周 Minimal Demo）

```
W1: Workflow Store + projects/goals/outcomes/criteria/tasks/executions/evidence/events 表
   + task.* / outcome.* / goal.* / criterion.* / evidence.* Tools
   + outcome-evaluate / goal-align Skills（三级版）
   + Task Planner（>30min 强制拆）+ Criterion Verifier 绑定
   → Demo 1 骨架

W2: Scheduler + WakeCondition (timer) + Codex 集成
   + CAS / Lease / 按 remaining_gap 排序
   → Demo 2（跨进程 Resume 基础）

W3: Verify 三态 + Recover
   + outcome-criterion verify（调用 Criterion.verifier）
   + attach_evidence → 自动更新 derived_status → 自动 VERIFIED Outcome
   → Demo 3（Failure Recovery）

W4: Goal Alignment 三级实战
   + misaligned → pause / rollback / 换 task（不找人）
   + 完整跑通 V0.1 Minimal Demo（详见 10）
   + 20–30 个真实 Coding Task 验证
```

每周末 commit 一次（已遵守）。

---

## 8. 一句话总结

> **本轮收敛砍掉 progress 数字，改用 Criterion 三段式 + Outcome 状态机 + goal-align 三级 + Human 只改边界。**
> **核心原则：Progress is not a number. Progress is verified state change.**
> **V0.1 先证明自主循环，不证明生态集成。**
> 14 个决策点全部拍板，4 周可拿到 V0.1 Minimal Demo。