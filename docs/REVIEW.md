# Gollum 方案评审

> 评审视角：实施可行性 + 架构风险 + V0.1 落地路径
> **V0.1 已经包含 Goal / Outcome 语义层升级**

---

## 1. 整体判断

**方案质量：高，且 V0.1 引入 Goal / Outcome 后语义更完整。** 思路清晰、边界克制、没有自己造 Agent Loop 的轮子。引入 Outcome 作为进展单位，是这套架构区别于普通 Agent Framework 的核心。但有若干决策点必须拍板，且 Outcome 层有几个隐藏成本需要在 V0.1 动工前想清楚。

---

## 2. 核心优点（值得保留的设计）

### 2.1 Workflow Store = 唯一事实源

「跨 Session 持续工作」的根本原因。Task 物化成持久对象，Codex / Claude Code / WorkBuddy 都能接管。

### 2.2 Lease + CAS 而非锁

正确选择。Agent 崩溃是常态，永久锁会变成「僵尸任务」。

### 2.3 Environment > Checkpoint

「Verify First」的工程化体现。直接信任 Checkpoint 会让 Agent 在环境漂移时疯狂重复错误动作。

### 2.4 Verify 三态（PASS / FAIL / UNKNOWN）

`UNKNOWN` 单列很重要，「没拿到证据」≠「成功」。

### 2.5 ToolResult 统一协议（Action + Observation + Evidence + Failure Semantics）

把 Tool 从 RPC 升级成「带失败语义的观察动作」。

### 2.6 不抢 Agent Loop

知道自己不做什么，比知道自己要做什么更难。

### 2.7 Outcome 是进展单位，不是 Task ⭐ 升级后核心

> **Agent 不以"完成 Task"作为进展，而以"改变 Outcome"作为进展。**

这是 Gollum 区别于普通 Agent Framework 的本质。一个普通 Agent Framework 看的是「Task 完成率」；Gollum 看的是「Outcome.progress 实际推进了多少」。Task 完成一堆但 Outcome 没动 = 没进展。这是从「动作视角」升级到「事实视角」。

### 2.8 Goal Alignment 抗 scope creep ⭐ 升级后核心

Codex 跑 Coding Task 最容易发生的就是「技术跑偏」：发现 EventBus 写得不好就想去重写 Runtime。`goal-align` Skill 强制每次新建 Task 都要回答「这条 Task 在推进哪个 Outcome？Outcome 仍服务哪个 Goal？」直接挡住 scope creep。

### 2.9 Outcome Gap 驱动调度 ⭐ 升级后

Scheduler 不再按 `created_at` FIFO，而是按 `(1 - outcome.progress)` 排序。先做 Gap 大的，再做 Gap 小的。

---

## 3. 风险点（实施时必须想清楚）

### 风险 1：outcome.success_criteria 谁来定义？⚠️ 高优先

设计方案没明确这一点。

| 候选 | 优点 | 缺点 |
|---|---|---|
| 用户创建 Outcome 时手写 | 可控、清楚 | 增加 onboarding 成本 |
| Agent 自动提议 | 体验好 | 不可靠、容易遗漏 |
| 混合：用户写骨架 + Agent 提议细化 | 平衡 | 复杂度 |

**建议 V1**：

> Outcome 创建时强制填写 `success_criteria` 列表（最少 1 条，最多 7 条）。
> 不允许空 criteria。
> Agent 自动提议是 V0.5 的事。

每条 criterion 必须满足：

```
可观察（Observable）
可验证（Verifiable）
可证伪（Falsifiable）
具体（Concrete，无歧义）
```

CLI 应该做轻量校验：检测是否含模糊词（「稳定」「高效」「更好」「更优雅」），命中就 warn。

### 风险 2：outcome.progress 可能被"gamed" ⚠️ 中优先

如果 progress = `verified_pass_criteria / total_criteria`，Agent 可能：

- 挑 criteria 数量少的 Outcome（少做事高 progress）
- 把 criterion 拆细刷 progress（看起来动了但实际没动）

**建议**：

> Progress 只是 hint，不作为调度唯一依据。
> 调度综合看：`progress` + `priority` + `criteria 数量` + `Evidence 时间衰减`。
> 加 `criteria 数量惩罚`：criteria 越少，权重越低（避免被钻空子）。

### 风险 3：goal-align 的判定准确性 ⚠️ 中优先

LLM 自己评估"是否在推进 Outcome"可能偏差：

- 自我感觉良好 → 高估 aligned
- 不理解 Goal 意图 → 误判 scope_creep

**建议**：

> **双轨判断**：
> 1. 客观：`outcome.progress_delta`（过去 N 次 Execution 后 progress 是否变化）
> 2. 主观：LLM verdict + reason
>
> 强约束：
> - `misaligned` / `scope_creep` 必须经 Human 确认
> - `marginal` 自动继续但记 Event Log
> - 后续人工 audit 时统计 verdict_accuracy

### 风险 4：Outcome 拆分的粒度 ⚠️ 高优先

- 拆太细 → Outcome 数量爆炸，Agent 迷失
- 拆太粗 → 进度反馈不及时

**建议 V1 经验值**：

```
每个 Goal:   3–7 个 Outcome
每个 Outcome: 3–5 个 success_criteria
每个 Outcome 拆 5–20 个 Task
```

超过这个范围给 warning。

### 风险 5：Project 层是否真的需要？⚠️ 低优先

V0.1 只有一个 gollum 项目。

**建议**：

> 表结构保留 Project，但 V0.1 CLI 不强制 `project_id`（默认 singleton）。
> V0.5 多项目并行时再补 CLI 强制。

### 风险 6：CAS 重试链未定义 ⚠️ 高优先（V0.1 遗留）

`task.update(expected_version=17, patch)` 返回 `STATE_CONFLICT` 后策略没说清。

**建议**：

```
CAS_CONFLICT → sleep(随机 1–3s) → task.get → 重新 Decide → 重试 update
最多 3 次，超出 → task.fail(reason="cas_thrashing")
```

并把 `STATE_CONFLICT` 单独统计到 Event Log。

### 风险 7：WAITING 的 Event Trigger 没给具体实现 ⚠️ 中优先

V0.1 建议只做 **GitHub Polling** + Timer，覆盖 80% Coding 用例。

### 风险 8：V0.1 Demo 太重 ⚠️ 高优先（V0.1 遗留）

不要一上来就端到端跑全链路。拆 3 个微 Demo：

```
Demo 1: 单 Session Coding Task        ← 验证 Workflow Store + 6 Skills + Verify
Demo 2: 跨 Session Resume            ← 验证 Checkpoint + Re-observe + CAS
Demo 3: Failure Recovery              ← 验证 WAITING + Recover + Verify 三态
Demo 4 (新增): Outcome Progress 推进 ← 验证 Outcome Gap + Goal Alignment + Update Outcome
```

每个 Demo 1 周内能跑通，4 周拿到完整 V0.1。

---

## 4. Goal / Outcome 层 5 个待拍板的决策点

| # | 决策 | 推荐选项 | 理由 |
|---|---|---|---|
| 1 | success_criteria 谁写 | **用户写骨架，CLI 校验，V0.5 再 Agent 提议** | V0.1 不能让 LLM 自己定真理 |
| 2 | progress 计算公式 | **pass / total，加 criteria 数量惩罚** | 抗 gaming |
| 3 | goal-align 误判处理 | **misaligned/scope_creep 必须 Human 确认** | 不让 LLM 单独决定方向 |
| 4 | Outcome 数量上限 | **每个 Goal ≤ 7 个 Outcome** | 防迷失 |
| 5 | Project 层 V0.1 是否强制 | **保留表结构，CLI 默认 singleton** | 简化 V0.1 |

---

## 5. 必须拍板的 8 个 V0.1 决策点（含升级版）

| # | 决策 | 推荐 | 备注 |
|---|---|---|---|
| 1 | 第一个 Host | **Codex CLI** | 你已经在用 |
| 2 | Workflow Store | **SQLite + WAL** | 简单、够用 |
| 3 | CLI 语言 | **TypeScript / Node** | 跟 Codex 同栈 |
| 4 | MCP 实现 | **stdio 模式** | 复用社区方案 |
| 5 | Task ID | **ULID** | 时间序 + 可排序 |
| 6 | Event Log | **append-only + 定期 checkpoint** | |
| 7 | 默认 Lease | **15 min（Coding）** | |
| 8 | CAS 冲突 | **sleep(1–3s) + 重试 ≤3 次** | |
| 9 | success_criteria 来源 | **用户手写 + CLI 校验** | 见 §4 |
| 10 | progress 公式 | **pass/total + criteria 数量惩罚** | 见 §4 |
| 11 | goal-align 误判 | **verdict ≥ misaligned 必须 Human** | 见 §4 |
| 12 | Outcome 数量上限 | **每 Goal ≤ 7 Outcome** | 见 §4 |

---

## 6. 我的实施建议（升级版路径）

```
W1: Workflow Store + Project/Goal/Outcome/Task/Execution 表
   + task.* (8 tools) + outcome.* + goal.*
   + outcome-evaluate / goal-align Skills（基础版）
   → Demo 1 骨架

W2: Scheduler + Codex 集成
   + CAS / Lease / Outcome Gap 排序
   → Demo 2（跨 Session Resume）

W3: Verify 三态 + Recover
   + outcome-criterion verify
   + Update Outcome 自动联动
   → Demo 3（Failure Recovery）

W4: Goal Alignment 实战
   + scope_creep 检测 + Human 确认流程
   → Demo 4（Outcome Progress 推进）

W5: 20–30 个真实 Task A/B（Vanilla Codex vs Codex+Gollum）
   收集自主性指标
```

每个 Demo 结束都 commit 一次（按你的工作原则：阶段完成及时 commit，方便回滚）。

---

## 7. 文档已经落地的部分

✅ `docs/` 已包含（V0.1 升级版）：

- README.md — 入口与索引
- 01-architecture.md — 总体架构 + 核心原则
- 02-workflow.md — Workflow 模型 + 状态机（**含 Outcome 主循环**）
- 03-task-model.md — **Project/Goal/Outcome/Task/Execution 数据模型**
- 04-skills.md — **6 Core Skills**（含 outcome-evaluate / goal-align）
- 05-tools.md — Tool 架构 + ToolResult 协议
- 06-runtime.md — Trigger / Scheduler / Host / Session / WAITING / HITL / Memory
- 07-roadmap.md — 项目结构 + CLI + 阶段 + V0.1 验收 + 自主性指标
- 08-principles.md — 八条工程原则 + 关键词表
- 09-goal-outcome-model.md — **Goal/Outcome 语义层核心设计**
- REVIEW.md — **本文档**

---

## 8. 一句话总结

> V0.1 引入 Goal / Outcome 后架构语义更完整，但**新增了 5 个必须拍板的决策点**（success_criteria 来源、progress 公式、goal-align 误判、Outcome 数量上限、Project 强制）。
> 加上 V0.1 原有的 8 个决策点，共 **12 个**待确认项。
> 全部拍板后即可以按 5 周路径动工。