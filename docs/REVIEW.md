# Gollum 方案评审

> 评审视角：实施可行性 + 架构风险 + V0.1 落地路径
> **V0.1 已经包含 Goal / Outcome 语义层 + 自主循环 Demo 简化**

---

## 1. 整体判断

**方案质量：高，V0.1 的核心命题已明确。** 思路清晰、边界克制。引入 Outcome 作为进展单位是本质升级；Task 按结果拆而非按 Session 寿命拆是核心约束；V0.1 只证明自主循环、不碰生态集成是正确的范围控制。

下面是对用户 5 条建议的采纳情况。

---

## 2. 5 条建议全部采纳

### 建议 1：Task 粒度按结果拆，不按 Session 寿命拆 ✅

**原文**：「不建议定义成'一次 Codex Session 能完成'，这会把业务 Task 和执行器绑定。更合理：Task = 一个可独立 Verify、失败后可安全重试的最小结果单元。」

**采纳**。新定义见 [02-workflow.md §2](./02-workflow.md)：

> **Task = 能在有限时间内独立执行、独立验证、失败可重试，并对某个 Outcome 产生明确增量的最小工作单元。**

五项硬性属性：

| 属性 | 含义 |
|---|---|
| 有限时间 | 10–30min 目标，> 30min Planner 强制拆分 |
| 独立执行 | 不依赖其他 Task 中间状态 |
| 独立验证 | 有 acceptance_criteria + Verify Tool |
| 失败可重试 | 幂等 or 显式声明副作用可回滚 |
| 明确 Outcome 增量 | Verify PASS 后 Outcome.progress 有可量化变化 |

### 建议 2：CAS 重试链明确定义 ✅

**原文**：「STATE_CONFLICT → reload latest state → jitter backoff 1–3s → re-evaluate → CAS retry ≤3。不要简单拿原数据重试；3 次仍冲突则 BLOCKED/FAILED(cas_thrashing)，触发重新规划。」

**采纳**。新规则见 [03-task-model.md §5.4](./03-task-model.md)：

```
reload latest state     ← task.get
  ↓
jitter backoff 1–3s
  ↓
re-evaluate             ← 基于最新 state，原 patch 可能已过时
  ↓
CAS retry ≤ 3
```

**绝对禁止**：拿原 patch 数据直接重试。

3 次仍冲突：

```
→ task.block(reason="cas_thrashing") 或 task.fail(reason="cas_thrashing")
→ 触发 Planner 重新规划
→ 不要无限循环消耗 lease
```

### 建议 3：Skill / Memory / Checkpoint 边界 ✅

**原文**：「同意。Checkpoint 只存当前执行状态 + Artifact refs + decision context；Memory 独立。V0.1 不做自动归纳，避免错误知识进入长期记忆。」

**采纳**。新增原则 11（[08-principles.md](./08-principles.md)）：

> Checkpoint 是状态，不是知识。
> Checkpoint 只存：当前执行状态 + Artifact 引用 + decision context。
> 不存用户偏好、技术经验、领域知识。
> Memory 独立。V0.1 不做自动归纳。

### 建议 4：WakeCondition 抽象 ✅

**原文**：「同意 V0.1 先 Timer + Polling。甚至抽象统一为 WakeCondition，先实现 timer / github_pr / ci_status 三种 polling condition，以后 Webhook 只是新的 Trigger Adapter。」

**采纳**。V0.1 接口定义见 [06-runtime.md §1.1](./06-runtime.md)：

```typescript
interface WakeCondition {
  type: "timer" | "github_pr" | "ci_status"
  config: TimerConfig | GithubPRConfig | CIStatusConfig
}
```

V0.1 实现：

| type | 实现 |
|---|---|
| timer | ✅ |
| github_pr | ⚠️ 接口预留，V0.5 实现 |
| ci_status | ⚠️ 接口预留，V0.5 实现 |
| webhook | ❌ → V0.5，作为新 Trigger Adapter |

V0.1 Minimal Demo 只用 timer。

### 建议 5：V0.1 Demo 简化 ✅ ✅ 核心变化

**原文**：「把 Demo 改成：已有本地 Repo → 给定 Goal → Agent 自动拆 Outcome/Task → Codex 修改代码 → Test Verify → 失败后下一轮自动修复 → PASS 后结束。」

**采纳**。新 Demo 详见 [10-v01-minimal-demo.md](./10-v01-minimal-demo.md)。

核心命题：

> **关闭 Agent，再重新启动，它还能知道自己为什么工作、做到哪了、接下来该做什么，并最终把测试跑通。**

形态：

```
故意有 2~3 个 bug 的本地 Repo
  ↓
User: Goal "修复项目，使全部测试通过"
  ↓
Agent 自动拆 Outcome + Task
  ↓
跑测试 → 修 → Verify → 失败 → Checkpoint
  ↓
进程退出
  ↓
30min / 手动重启
  ↓
恢复 Goal + Outcome + State
  ↓
继续修剩余 Task → Verify PASS
  ↓
Outcome DONE → Goal DONE
```

一次证明 6 个核心能力：

1. **Goal Alignment**
2. **Task Planning**（自动拆 Outcome/Task）
3. **Persistence**
4. **Resume**
5. **Verify**
6. **Recovery**

GitHub / CI / Webhook / PR 都属于 Tool Integration，**不是 V0.1 的核心风险**。

> **关键词：V0.1 先证明自主循环，不证明生态集成。**

---

## 3. 关闭的旧风险点

下列风险已通过采纳建议关闭：

| # | 旧风险 | 状态 |
|---|---|---|
| 1 | Task 粒度与 Session 寿命绑定 | ✅ 已解决（Task 按结果拆） |
| 6 | CAS 重试链未定义 | ✅ 已解决（reload + backoff + re-evaluate + ≤3） |
| 7 | WAITING Event Trigger 没具体实现 | ✅ 已解决（WakeCondition 抽象 + V0.1 只做 timer） |
| 8 | V0.1 Demo 太重 | ✅ 已解决（拆成本地 repo Demo，证明自主循环） |

---

## 4. 仍需关注的剩余风险

| # | 风险 | 状态 |
|---|---|---|
| 2 | success_criteria 谁来定义 | 🟡 V0.1 用户手写 + CLI 校验 |
| 3 | outcome.progress 可能被 gaming | 🟡 用 criteria 数量惩罚 + 综合权重 |
| 4 | goal-align 判定准确性 | 🟡 双轨（客观 progress_delta + 主观 verdict）+ Human 兜底 |
| 5 | Outcome 拆分粒度 | 🟡 上限经验值（每 Goal ≤ 7 Outcome，每 Outcome ≤ 5 criteria） |
| 6 | Project 层 V0.1 是否强制 | 🟡 表结构保留，CLI 默认 singleton |

---

## 5. 12 个待拍板的 V0.1 决策点（不变）

| # | 决策 | 推荐 |
|---|---|---|
| 1 | Host | Codex CLI |
| 2 | Store | SQLite + WAL |
| 3 | CLI 语言 | TypeScript / Node |
| 4 | MCP | stdio 模式 |
| 5 | Task ID | ULID |
| 6 | Event Log | append-only + 定期 checkpoint |
| 7 | 默认 Lease | 15 min（Coding） |
| 8 | CAS 冲突 | reload + backoff 1–3s + re-evaluate + ≤3（已升级） |
| 9 | success_criteria 来源 | 用户手写 + CLI 校验 |
| 10 | progress 公式 | pass/total + criteria 数量惩罚 |
| 11 | goal-align 误判 | verdict ≥ misaligned 必须 Human |
| 12 | Outcome 数量上限 | 每 Goal ≤ 7 Outcome |

---

## 6. 实施路径（4 周 Minimal Demo）

```
W1: Workflow Store + Project/Goal/Outcome/Task/Execution 表
   + task.* / outcome.* / goal.* Tools
   + outcome-evaluate / goal-align Skills 基础版
   + Task Planner（>30min 强制拆）
   → Demo 1 骨架

W2: Scheduler + WakeCondition (timer) + Codex 集成
   + CAS / Lease / Outcome Gap 排序
   → Demo 2（跨进程 Resume 基础）

W3: Verify 三态 + Recover
   + outcome-criterion verify
   + Update Outcome 自动联动
   → Demo 3（Failure Recovery）

W4: Goal Alignment 实战 + scope_creep 检测
   + 完整跑通 V0.1 Minimal Demo（详见 10）
   + 20–30 个真实 Coding Task 验证
```

每周末 commit 一次。

---

## 7. 一句话总结

> V0.1 的核心命题已收敛为「自主循环可证明性」，5 条建议全部采纳。
> 12 个决策点不变，4 周可拿到 V0.1 Minimal Demo。
> GitHub / CI / Webhook 留给 V0.5，先把架构本体跑通。