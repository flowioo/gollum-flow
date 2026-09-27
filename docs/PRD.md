# Gollum — 编程 PRD（Product Requirements Document）

> **版本**：V0.1 收敛版
> **面向**：Agent Operator / 用户 / Product Owner
> **状态**：可执行

---

## 1. 项目定位

### 1.1 一句话定义

**Gollum 是一个面向 Codex / Claude Code / WorkBuddy 等 Agent Host 的可移植能力层**，通过 **Skills + Tools + Workflow State**，让 Coding Agent 能 **跨 Session、跨崩溃、跨环境** 持续可靠地推进 Goal / Outcome，直到完成。

### 1.2 不做什么

Gollum **不实现**：

- ❌ Agent Runtime / LLM Loop / Context Window 管理
- ❌ Planner Runtime / 自定义 Agent 协议
- ❌ 自定义 Workflow DSL / 长驻 Agent 进程
- ❌ V0.1 不做：Memory 自动归纳、Skill 自动生成、生态集成（GitHub/CI/Webhook）
- ❌ V0.1 不做：**progress 数字**（改用状态机 + 派生属性）

### 1.3 分层职责

| 层 | 负责 |
|---|---|
| Agent Host (Codex / CC / WorkBuddy) | THINK / Agent Loop |
| Gollum Skills | KNOW HOW（流程指引） |
| Gollum Tools | DO / OBSERVE / VERIFY（原子动作） |
| Gollum Workflow | STATE / CONTINUITY（持久化 + 恢复） |

---

## 2. 核心原则（业务视角精选）

| # | 原则 | 一句话 |
|---|---|---|
| 1 | Agent 可以死 | Task 不能丢。Lease + CAS + Event Log 保障。 |
| 2 | Conversation 不是 State | Session 是临时呼吸，Task 是长期生命。 |
| 3 | Environment > Memory > Checkpoint | Resume 时先 Observe Environment。 |
| 4 | No Evidence = Not Verified | 必须有 Tool 返回的 Evidence 才能算完成。 |
| 5 | 失败先 Observe，不重复 Action | Recover 强制 Classify → Identify Divergence → Change Strategy。 |
| 6 | Long-running Agent ≠ Long-running Process | Run → Wait → Wake → Continue。 |
| 7 | Gollum 不抢 Agent Loop | 只提供状态 + 工具 + 流程指引。 |
| **8** | **进展以 Outcome 为单位** | **不以 Task 完成数，以 Outcome 状态变化为进展。** |
| **9** | **Task 按结果拆** | **不按 Session 寿命，按可独立 Verify / 重试 / 增量为拆。** |
| **10** | **CAS 冲突不盲重试** | **reload + backoff + re-evaluate + ≤3。** |
| **11** | **Checkpoint 是状态，不是知识** | **不存用户偏好，V0.1 不做自动归纳。** |
| **12** | **V0.1 先证明自主循环** | **不证明生态集成（GitHub/CI/Webhook 留 V0.5）。** |
| **13** | **进展不是数字** | **Progress is not a number. Progress is verified state change.** |
| **14** | **Criterion 三段式** | **criterion → verifier → evidence，没 verifier 标 UNVERIFIED。** |
| **15** | **Human Boundary** | **Human 负责改变边界，不负责日常纠偏。** |

---

## 3. 目标场景

### 3.1 V0.1 — Autonomous Coding Agent

**核心命题**：

> **关闭 Agent，再重新启动，它还能知道自己为什么工作、做到哪了、接下来该做什么，并最终把测试跑通。**

**用户故事**：

```
用户：有一个本地 Repo，故意准备了 2~3 个 bug。
      给我一个 Goal："修复项目，使全部测试通过"。

Agent：
  1. 自动拆 Outcome + Criteria
  2. 自动拆 Task（每个 bug 一个）
  3. 执行 Task 1 → Verify
  4. 执行 Task 2 → Verify（中途进程崩溃）
  5. 30min 后重启 → Resume
  6. 知道「为什么工作 / 做到哪 / 下一步」
  7. 继续修 Task 3 → Verify PASS
  8. Outcome VERIFIED → Goal achieved
```

**一次证明 6 个能力**：Goal Alignment / Task Planning / Persistence / Resume / Verify / Recovery。

### 3.2 V0.5 — 生态集成

- GitHub Issue 接入
- PR 创建 / Review
- CI 平台集成
- Webhook 触发

### 3.3 V1+ — Phone / Robot Agent

- Phone Agent：在 Android 上完成任务
- Robot Agent：机械臂 / IoT 控制

底层 Workflow / 七层模型不变，只增加 Skills + Tools。

---

## 4. 七层语义模型

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

### 4.1 关键词

| 概念 | 角色 |
|---|---|
| Project | 工作域 |
| Goal | **为什么做** |
| Outcome | **想改变什么状态** |
| Criteria | **什么算完成** |
| Evidence | **凭什么说完成** |
| Task | **怎么推进** |
| Execution | **一次尝试** |
| Verify | **验证** |
| Verifier | **怎么验证** |

### 4.2 强约束

```
- Task 必须属于某个 Outcome（不允许 Goal → Task 直连）
- Criterion 必须属于某个 Outcome
- Criterion 必须绑定 Verifier，否则 UNVERIFIED
- Evidence 挂在 Criterion 上（不是 Task）
- Outcome VERIFIED 要求所有 Criterion 都有 PASS evidence
```

---

## 5. Task 定义

### 5.1 一句话定义

> **Task = 能在有限时间内独立执行、独立验证、失败可重试，并对某个 Outcome 产生明确增量的最小工作单元。**

### 5.2 五项硬性属性

| 属性 | 含义 | Planner 怎么判断 |
|---|---|---|
| **有限时间** | 10–30min 目标 | 估算 > 30min → 强制拆分 |
| **独立执行** | 不依赖其他 Task 中间状态 | 检查 input deps |
| **独立验证** | 有 acceptance_criteria + Verify Tool | 必须至少一条 verify.* 调用 |
| **失败可重试** | 幂等 or 显式声明可回滚 | 检查 side effect list |
| **明确 Outcome 增量** | Verify PASS 后 Criterion 派生状态变化 | criterion.verifier 绑定 + evidence 产出 |

### 5.3 拆分规则

```
预计 > 30min  → Planner 必须先拆，拆完才能 claim
预计 < 5min   → 警告：Task 太小，overhead > value，建议合并
```

### 5.4 重试规则

```
retry_count < 3   → 直接重试（同策略）
retry_count ≥ 3   → 触发 recover Skill，换 Strategy
retry_count ≥ 5   → BLOCKED（升级到 Outcome 层决策）
```

### 5.5 Task 不与 Session 绑定

- 一个 Session 可跑多个 Task
- 一个 Task 可被多个 Session 接力
- Task **不关心**是谁在跑、跑了多久

---

## 6. Outcome 状态机

```
NOT_STARTED
    │
    ▼
IN_PROGRESS ─────► BLOCKED ─────► IN_PROGRESS
    │
    ├──► VERIFIED   ← 所有 Criterion.derived_status == PASS
    │
    └──► FAILED
```

### 6.1 状态语义

| 状态 | 含义 | 转移条件 |
|---|---|---|
| NOT_STARTED | 已创建，无 Task 启动 | 第一个 Task RUNNING |
| IN_PROGRESS | 至少一个 Task 启动 | 见下 |
| BLOCKED | 等 Human 改变边界 | Human unblock |
| VERIFIED | 所有 Criterion 都 PASS | 终态 |
| FAILED | 达到失败边界 | 终态 |

### 6.2 VERIFIED 判定

```
outcome_is_verified = for each criterion: derived_status == PASS
```

**禁止**：因为所有 Task 都 DONE 就把 Outcome 标 VERIFIED。必须每条 Criterion 都有 PASS evidence。

---

## 7. Criterion 三段式绑定

### 7.1 核心机制

```
criterion  →  verifier  →  evidence
              (怎么验证)   (凭什么说完成)
```

### 7.2 Criterion 派生状态

| derived_status | 含义 | 来源 |
|---|---|---|
| **UNVERIFIED** | 没绑定 Verifier 或 Verifier 未运行 | `verifier == null` 或 `latest_evidence == null` |
| **PASS** | Evidence 支持完成 | `latest_evidence.status == PASS` |
| **FAIL** | Evidence 反驳完成 | `latest_evidence.status == FAIL` |
| **UNKNOWN** | Evidence 不足或矛盾 | `latest_evidence.status == UNKNOWN` 或多 evidence 冲突 |

### 7.3 V0.1 Verifier 类型

| type | config 示例 | 用途 |
|---|---|---|
| `command` | `{ "command": "pytest", "cwd": "." }` | 跑 shell 命令 |
| `git` | `{ "branch": "main", "expect": "clean" }` | Git 状态检查 |
| `outcome_criterion` | `{ "ref_type": "outcome", "ref_id": "outcome-002" }` | 关联其他 outcome/criterion |
| `timer_check` | `{ "duration": "4h", "signal_source": "event_log" }` | 等待 N 秒不崩 |
| `human_assert` | `{ "question": "..." }` | Human 主观确认 |

### 7.4 CLI 不做语义裁判

```
「稳定运行 4 小时」看似模糊
  → 绑定 timer_check 后 → 可验证 ✅
  → 真正不能验证的是没绑定 verifier 的 criterion → UNVERIFIED
```

CLI 只做**结构校验**（verifier 必须存在），不做 NLP 模糊词检测。

### 7.5 一个 Outcome 必须能独立 Verify

> Outcome 拆分的硬规则（不是数字上限）：
> 1. 一个 Outcome **必须能独立 Verify**
> 2. Criteria **必须共同描述同一个结果**

数字上限是 soft warning：

```
每 Goal ≤ 7 Outcome   → warning，不是 hard limit
每 Outcome ≤ 5 criteria → warning
```

---

## 8. Progress 模型（V0.1 收敛版）

### 8.1 砍掉 progress 数字

> **Progress is not a number. Progress is verified state change.**
> **进展不是一个百分比，而是被证据验证过的状态变化。**

**砍掉的字段**：

| 字段 | 替代 |
|---|---|
| ❌ `Outcome.progress: 0.0~1.0` | `Outcome.status` 状态机 |
| ❌ `progress = pass / total` | `Criterion.derived_status` 派生 |
| ❌ 调度看「83%」 | 调度看 `remaining_gap + priority` |

### 8.2 为什么砍掉：Goodhart's Law

> **指标一旦成为目标，就不再是好指标。**

`progress = pass/total` 一旦成为调度目标，Agent 会：

- 拆更多容易完成的 criteria（刷高 progress）
- 挑 criteria 数量少的 Outcome（少做事高 progress）
- 把 criterion 拆细（看起来动了但实际没动）

### 8.3 替代方案

```
Outcome.status           = NOT_STARTED / IN_PROGRESS / BLOCKED / VERIFIED / FAILED
Criterion.derived_status = UNVERIFIED / PASS / FAIL / UNKNOWN
remaining_gap            = count(criterion.derived_status != PASS)
```

Scheduler 调度依据：

```
1. status == IN_PROGRESS
2. priority 高
3. remaining_gap > 0
4. 没有 blocker
5. goal-align verdict == aligned
```

**Agent 不能优化一个数字，只能优化真实的状态变化。**

---

## 9. goal-align 三级（V0.1 收敛版）

### 9.1 双轨判断

```
1. Evidence-based check（客观）
   - 过去 N 次 Execution 后，Outcome 的 remaining_gap 是否减少？
   - Criterion.derived_status 是否有 PASS？

2. LLM semantic check（主观）
   - Task 是否直接推进 Outcome？
   - 是否偏离 Goal 方向？
```

verdict 取两者中最保守的：

```
objective == aligned && llm == aligned        → aligned
objective == regression || llm == misaligned  → misaligned
otherwise                                     → uncertain
```

### 9.2 三级判定

| verdict | 含义 | 系统动作 |
|---|---|---|
| `aligned` | 推进 Outcome | continue |
| `uncertain` | 不确定 / evidence 矛盾 | re-evaluate / replan |
| `misaligned` | 与 Outcome 无关 / scope creep | pause current task → rollback / backlog → 换 task |

### 9.3 何时找 Human（Human Boundary）

> **Human 负责改变边界，不负责日常纠偏。**

**`misaligned` 默认不找人**，Agent 自处理。

只有这些情况找 Human：

```
- 修改 Goal（title / description 改变）
- 删除关键 Outcome
- 扩大 Outcome scope（新增 criteria）
- 不可逆操作（生产删数据 / 付款）
- 高风险操作
```

---

## 10. WakeCondition 抽象

### 10.1 接口

```typescript
interface WakeCondition {
  type: "timer" | "github_pr" | "ci_status"
  config: TimerConfig | GithubPRConfig | CIStatusConfig
}
```

### 10.2 V0.1 实现

| type | V0.1 实现 |
|---|---|
| `timer` | ✅（Scheduler 定时轮询 `wake_at <= now()`） |
| `github_pr` | ⚠️ 接口预留，V0.5 实现 |
| `ci_status` | ⚠️ 接口预留，V0.5 实现 |
| `webhook` | ❌ → V0.5，作为新 Trigger Adapter |
| `email` | ❌ → V1 |

V0.1 Minimal Demo 只用 `timer`。

---

## 11. CAS 重试链

### 11.1 Agent 收到 STATE_CONFLICT 必须执行

```
reload latest state     ← task.get(task_id)
  ↓
jitter backoff 1–3s
  ↓
re-evaluate             ← 重新 Decide：基于最新 state，原 patch 可能已过时
  ↓
CAS retry ≤ 3
```

### 11.2 禁止

> **绝对禁止**：拿到 STATE_CONFLICT 后**简单拿原 patch 数据重试**。
> patch 基于的是过期 state，原封不动重试大概率还是会冲突，或者覆盖了别人正确的更新。

### 11.3 3 次仍冲突

```
→ task.block(reason="cas_thrashing") 或 task.fail(reason="cas_thrashing")
→ 触发 Planner 重新规划
→ 不要无限循环消耗 lease
```

把 `STATE_CONFLICT` 单独统计到 Event Log，用于诊断 thrashing。

---

## 12. Checkpoint / Memory 边界

### 12.1 Checkpoint 只存

```
- 当前执行状态
- Artifact 引用
- decision context（为什么做这个决定）
- criteria_delta（Criterion 派生状态的变化）
```

### 12.2 不存

```
- 用户偏好
- 技术经验
- 领域知识
- progress 数字（已砍掉）
```

### 12.3 Memory

独立。V0.1 不做自动归纳。Memory 与 Workflow State 分离。

---

## 13. Session 结束协议

任何 Agent Session 结束前，必须进入以下一种状态：

```
task.complete()    → DONE
task.wait()        → WAITING
task.block()       → BLOCKED
task.fail()        → FAILED
```

**禁止**：Session Exit 但 Task 仍然 RUNNING。

如果发生 Agent Crash：

```
lease expire  → Scheduler 识别为 RECOVERABLE → 重新调度
```

---

## 14. V0.1 Minimal Demo

### 14.1 形态

故意准备一个 **2~3 个 bug 的本地 Repo**，给定 Goal：

```
Goal: 修复项目，使全部测试通过
```

### 14.2 完整流程

```
T0: 启动 Agent
  ↓
Load Goal
  ↓
Planner 自动拆 Outcome + Criterion
  Outcome: "所有测试 PASS"
  Criterion c1: "pytest exit 0"
    verifier: { type: "command", config: { command: "pytest" } }
  ↓
Planner 自动拆 Task
  Task 1: 分析 failing tests
  Task 2: 修复 calculator
  Task 3: 修复 parser
  Task 4: 修复 utils
  ↓
goal-align(Task 1) → aligned
  ↓
Execute Task 1 → Verify → Checkpoint

T1: 启动 Agent (新进程)
  ↓
Load Task 2
  ↓
Execute Task 2 → Verify (test_calculator PASS, 其它仍 FAIL)
  ↓
attach_evidence → c1.derived_status = UNKNOWN (utils 还 FAIL)
  ↓
Checkpoint
  ↓
*** 进程崩溃 ***

T2: 30min 后重启 Agent
  ↓
Load Project + Goal + Outcome
  ↓
outcome-evaluate → remaining_gap = 1
  ↓
Select Task 3 (next PENDING)
  ↓
Execute Task 3 → Verify
  ↓
Execute Task 4 → Verify ALL TESTS PASS
  ↓
attach_evidence → c1.derived_status = PASS
  ↓
outcome-evaluate → 所有 criterion PASS → Outcome.status = VERIFIED
  ↓
Goal.achieve
  ↓
Demo 结束
```

### 14.3 一次证明 6 个能力

| # | 能力 | 体现 |
|---|---|---|
| 1 | **Goal Alignment** | 每次新建 Task / Checkpoint 时 `goal-align` 返回 aligned |
| 2 | **Task Planning** | 从 Goal 自动拆 Outcome + Criterion + Task 序列 |
| 3 | **Persistence** | 进程退出后从 store 加载 Task，知道哪些已 DONE |
| 4 | **Resume** | 重新唤醒后知道「为什么 / 做到哪 / 下一步」 |
| 5 | **Verify** | 每个 Task 都有 Verify 步骤（pytest），evidence 落库 |
| 6 | **Recovery** | 部分修复后仍 verify fail → 系统继续推进而不是放弃 |

---

## 15. V0.1 验收标准

### 15.1 功能验收

```
✓ Task DONE 后能 attach_evidence 到对应 Criterion
✓ Criterion.derived_status 随 latest_evidence.status 自动推导
✓ 所有 Criterion PASS 时 Outcome 自动 VERIFIED
✓ 所有 Outcome VERIFIED 时 Goal 自动 achieved
✓ 跨进程重启后能 Resume（30min 模拟可跑通）
✓ CAS 冲突按 reload + backoff + re-evaluate + ≤3 处理
✓ Lease 过期自动可被重新接管
✓ Event Log 完整记录 CRITERION_VERIFIED / OUTCOME_VERIFIED / TASK_RESUMED 等
✓ goal-align misaligned → pause / rollback / 换 task（不找人）
✓ criterion 没绑定 verifier → 标 UNVERIFIED
```

### 15.2 业务指标

| 维度 | 含义 | 目标 |
|---|---|---|
| Success Rate | Task 完成 / 总任务 | ↑ |
| Outcome VERIFIED Rate | Outcome 在指定时间内达到 VERIFIED 的比例 | ↑ |
| Criterion DERIVED_PASS Rate | Criterion 派生 PASS 的比例 | ↑ |
| False Completion Rate | 假完成比例 | ↓ |
| Criterion UNVERIFIED Rate | 没绑定 verifier 的 criterion 比例 | ↓ |
| Misaligned Pause Rate | misaligned → pause / 换 task 的比例（不找人） | ↑ |
| Recovery Rate | 失败后恢复比例 | ↑ |
| Human Intervention Count | 单 Outcome 平均介入次数 | ↓（V0.1 应该极少） |
| Token Cost | 单 Task token 消耗 | 不强制降 |

**砍掉的指标**：`Outcome.progress` 数字（Goodhart's Law 防御）。

---

## 16. 与现有 Agent Framework 的区别

| | 普通 Agent Framework | Gollum |
|---|---|---|
| 进展单位 | Task 完成率 | **Outcome 状态变化** |
| progress | 数字 % | **砍掉**（状态机 + 派生） |
| Task 粒度 | 与 Session 绑定 | **按结果拆**（可独立 Verify / 重试 / 增量） |
| CAS 冲突 | 直接重试 | **reload + backoff + re-evaluate** |
| criterion 校验 | NLP 模糊词检测 | **绑定 verifier** |
| Human 介入 | 频繁打断 | **只改边界** |
| Scope Creep 防御 | 弱 | **三级 goal-align + misaligned 自处理** |

---

## 17. 后续 Roadmap

```
V0.1 (现在)  自主循环 Minimal Demo
  ↓
V0.5         生态集成（GitHub/CI/Webhook）+ outcome-decompose 自动拆
  ↓
V1           Phone Agent + Robot Agent + Multi-Agent 协作
```

---

## 18. 一句话总结

> **Gollum = 让 Coding Agent 跨 Session / 跨崩溃 / 跨环境持续可靠推进 Goal 的能力层。**
> **V0.1 先证明自主循环，不证明生态集成。**
> **核心原则：Progress is not a number. Progress is verified state change.**