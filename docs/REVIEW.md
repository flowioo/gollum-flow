# Gollum 方案评审

> 评审视角：实施可行性 + 架构风险 + V0.1 落地路径

---

## 1. 整体判断

**方案质量：高分。** 思路清晰、边界克制、没有自己造 Agent Loop 的轮子。但有几个关键决策点没拍死，会直接影响 V0.1 能不能在 1 个月内跑起来。

---

## 2. 核心优点（值得保留的设计）

### 2.1 Workflow Store = 唯一事实源

这才是「跨 Session 持续工作」能成立的根本。不是把 Conversation 序列化，而是把 **Task** 物化成持久对象。Codex / Claude Code / WorkBuddy 都能接管同一个 Task，本质就是因为 Task 不依赖任何 Session 的内存。

### 2.2 Lease + CAS 而非锁

正确选择。Agent 崩溃是常态，永久锁会变成「僵尸任务」。`lease_until + version` 是经过分布式系统验证的范式。

### 2.3 Environment > Checkpoint

这是「Verify First」的工程化体现。直接信任 Checkpoint 会让 Agent 在环境漂移时疯狂重复错误动作。

### 2.4 Verify 三态（PASS / FAIL / UNKNOWN）

`UNKNOWN` 单独成态很重要。「我没拿到证据」≠「成功了」。很多 Agent 框架栽在这里。

### 2.5 ToolResult 统一协议（Action + Observation + Evidence + Failure Semantics）

把「Tool 调用」从 RPC 升级成「带失败语义的观察动作」。这一条是 Agent 可靠性的关键，单做 RPC 是不够的。

### 2.6 不抢 Agent Loop

知道自己不做什么，比知道自己要做什么更难。Gollum 只做能力层，不做 Runtime，是非常清醒的边界。

---

## 3. 风险点（实施时必须想清楚）

### 风险 1：Task 粒度定义模糊 ⚠️ 高优先

方案里 Task 用 goal 描述（"fix GitHub issue #321"），但实际执行时粒度差很大：

- 简单：3 行 typo fix，5 分钟
- 中等：加 idempotency + 测试，30 分钟
- 困难：跨 5 个文件的架构改造，2 小时+

**问题**：

1. 粒度小 → Checkpoint 开销 > Task 本身，得不偿失
2. 粒度大 → WAITING 拆不出去（CI 失败 vs 我还没写完是两回事）

**建议 V1 规则**：

> Task 粒度 = **一次 Codex Session 能完成的最大工作单元**。
> 如果预估 > 30 分钟，必须拆 Task（父子 Task）。

否则 Lease 15 min 会被频繁打爆。

### 风险 2：CAS 重试链未定义 ⚠️ 高优先

`task.update(expected_version=17, patch)` 返回 `STATE_CONFLICT` 后，方案只说「重新 Observe + Decide」。但：

- 如果两个 Agent 在抢同一个 Task，且两者都在做正确的下一步动作，谁优先？
- Agent 收到冲突后是 sleep + retry 还是 backoff + observe？

**建议**：

```
CAS_CONFLICT → sleep(随机 1–3s) → task.get → 重新 Decide → 重试 update
最多 3 次，超出 → task.fail(reason="cas_thrashing")
```

并把 `STATE_CONFLICT` 单独统计到 Event Log（用于诊断）。

### 风险 3：Memory 与 Checkpoint 的边界没说清 ⚠️ 中优先

第 29 节说「Memory 与 Workflow State 必须分离」，但 V0.1 又「不做 Memory Evolution」。这两条不冲突，但有一个真空：

**Checkpoints 里到底放什么？**

- 如果放「用户偏好」（高德地图搜索后会异步刷新）→ 这是 Memory，会膨胀
- 如果放「技术事实」（PR #456 已开）→ 这是 Workflow State，会过期

**建议**：

> Checkpoint 只放 **Workflow State + 关键 Artifact 引用**。
> Memory 单独建表 `memories`，V0.1 只暴露 `memory.write/read`，不做自动提炼。
> Skill 自动从 Memory 提炼这件事是 V0.5 的事。

### 风险 4：WAITING 的 Event Trigger 没给具体实现 ⚠️ 中优先

第 27 节说「未来优先 Event Trigger，Timer 是 fallback」。但 V0.1 怎么实现 Event？

- GitHub webhook 需要公网回调，本地开发怎么办？
- CI Event 怎么 polling？用 GitHub API 还是 gh CLI？
- 邮件到达触发的 Event 来源？

**建议 V0.1**：

> 只做 **GitHub Polling**（定时拉 PR 状态）+ **Timer**。
> 真 Webhook V0.5 再做。
> 这能覆盖 80% 的 Coding Demo 用例。

### 风险 5：Skill 与 Memory 的反馈回路没设计 ⚠️ 低优先（V0.1 可不做）

Skill 是 Markdown，但 Memory 升级后 Skill 应该更新。V0.1 不做这件事没问题，但要在文档里明确写「Skill 是手动维护的」，避免后续被「Skill 自动从 Memory 进化」这件事绑架。

### 风险 6：V0.1 Demo 太重 ⚠️ 高优先

「GitHub Issue → PR → CI → 修复 → Merge」这条链看着完整，但 CI 集成坑很多：

- CI 平台选择（GitHub Actions / CircleCI / Jenkins）？
- 失败日志怎么结构化？
- CI 修复可能需要多轮，要几次？
- 重试 vs 升级到 BLOCKED 的边界？

**建议**：

> V0.1 Demo 拆成 **3 个微 Demo**，每个只验证一个核心能力：

```
Demo 1: 单 Session Coding Task
  Issue → 改 → Test → PR → Complete
  验证：Workflow Store + 4 Core Skills + Verify

Demo 2: 跨 Session Resume
  Task 写一半 → 强制 Session 退出 → 新 Session → Resume → 完成
  验证：Checkpoint + Re-observe + CAS

Demo 3: Failure Recovery
  Task 写一半 → CI 失败 → 自动 Replan → 修复 → Verify → Complete
  验证：WAITING + Recover + Verify 三态
```

每个 Demo 1 周内能跑通，3 周拿到完整 V0.1。不要一上来就端到端跑全链路。

---

## 4. 必须拍板的决策点

下面这几条 **直接影响 V0.1 代码骨架**，需要在动手前确认。

| # | 决策 | 推荐选项 | 理由 |
|---|---|---|---|
| 1 | 第一个 Host | Codex CLI | 用户已经在用，适配最快 |
| 2 | Workflow Store | SQLite + WAL | 简单、够用、可单文件备份 |
| 3 | CLI 语言 | TypeScript / Node | 跟 Codex 同栈，Skill 解析方便 |
| 4 | MCP 实现 | 用 mcp-for-blender 同款 stdio 模式 | 复用社区方案，零造轮 |
| 5 | Task ID 生成 | ULID | 时间序 + 全局唯一 + 可排序 |
| 6 | Event Log 写入 | append-only + 定期 checkpoint | 简单，足够 V0.1 |
| 7 | 默认 Lease | 15 min（Coding） | 跟单次 LLM 调用时长匹配 |
| 8 | CAS 冲突处理 | sleep(1–3s) + 重试 ≤3 次 | 简单可控 |

---

## 5. 文档已经落地的部分

✅ `docs/` 已包含：

- README.md — 入口与索引
- 01-architecture.md — 总体架构 + 核心原则
- 02-workflow.md — Workflow 模型 + 状态机
- 03-task-model.md — Task 数据模型 + Lease + CAS + Checkpoint + Event
- 04-skills.md — Skills 设计
- 05-tools.md — Tool 架构 + ToolResult 协议
- 06-runtime.md — Trigger / Scheduler / Host / Session / WAITING / HITL / Memory
- 07-roadmap.md — 项目结构 + CLI + 阶段 + V0.1 验收 + 自主性指标
- 08-principles.md — 七条工程原则 + 架构总结
- REVIEW.md — **本文档**

---

## 6. 我的建议（下一步）

1. **先拍板第 4 节的 8 个决策点**（一次性确认，避免返工）。
2. **按风险 6 拆 Demo**，不要端到端一锅端。
3. **第一周只做 Workflow Store + task.get/claim/checkpoint/wait/complete**，跑通 Demo 1 的骨架。
4. **第二周加 Scheduler + Codex 集成**，跑通 Demo 2。
5. **第三周加 Verify + Recover**，跑通 Demo 3。
6. **V0.1 结束用 20–30 个真实 Task 做 A/B**（Vanilla Codex vs Codex+Gollum）。

---

## 7. 一句话总结

> 方案思路正确、边界克制，关键补充是 **Task 粒度规则、CAS 重试链、Skill/Memory 边界、Event Trigger 落地、拆 Demo**。这 5 点不改，V0.1 大概率会卡。
> 决策点拍板后就可以动工。