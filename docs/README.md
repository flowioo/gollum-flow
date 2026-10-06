# Gollum

> **可移植能力层，让 Coding Agent 跨 Session / 跨崩溃 / 跨环境持续可靠推进 Goal。**

安装、命令、skills 和已知缺口见仓库根目录的 [README](../README.md)。这里是设计文档。

## 文档

当前运行边界、已补齐保障和无人值守验收顺序见 [AUTONOMY.md](./AUTONOMY.md)。

| 文档 | 面向 | 内容 |
|---|---|---|
| **[PRD-v0.2.md](./PRD-v0.2.md)** | Agent Operator / 用户 / PO | 业务视角：项目定位、七层模型、Task 定义、Outcome 状态机、Criterion 三段式、goal-align 三级、Human Boundary、验收标准，以及 §5 的已实现 / 未实现对照 |
| **[DESIGN-v0.2.md](./DESIGN-v0.2.md)** | 实现工程师 / 架构师 | 工程视角：架构图、决策点、SQLite schema、状态机实现、CAS/Lease、Scheduler、Tool 接口、Skill 伪代码 |
| **[AGENTS.md](./AGENTS.md)** | 实现工程师 | V0.2 自进化层：进程 watchdog、心跳 watchdog、API 配额耗尽与自动恢复 |

**PRD 讲做什么，DESIGN 讲怎么做。** `PRD-v0.2.md` §5 是判断「某个功能到底有没有」的权威位置。

### V0.1 历史文档

以下三份是 V0.1 的设计记录与完成报告，**已被 v0.2 取代**，其中的状态描述和测试数字都是当时的快照，不要当作现状：

- [PRD.md](./PRD.md) — V0.1 收敛版
- [DESIGN.md](./DESIGN.md) — V0.1 工程设计
- [V01-COMPLETE.md](./V01-COMPLETE.md) — V0.1 完成报告

## 核心原则

```
1. Agent 可以死，Task 不能丢
2. Conversation 不是 State
3. Environment > Memory > Checkpoint
4. No Evidence = Not Verified
5. 失败先 Observe，不重复 Action
6. Long-running Agent ≠ Long-running Process
7. Gollum 不抢 Agent Loop
8. 进展以 Outcome 为单位
9. Task 按结果拆（不按 Session 寿命）
10. CAS 冲突不盲重试（reload + backoff + re-evaluate + ≤3）
11. Checkpoint 是状态，不是知识
12. Progress is not a number. Progress is verified state change.
13. Criterion 三段式（criterion → verifier → evidence）
14. Human Boundary（Human 负责改变边界，不负责日常纠偏）
```

## 七层语义模型

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

## 开发

测试数量会随功能变化，以 `npm test` 的实际输出为准：

```bash
npm run lint
npm run typecheck
npm test
npm run build
```

端到端脚本（会操作 `~/.gollum`，建议先看脚本头部的隔离说明）：

```bash
bash tests/_v02_install_e2e.sh   # 安装链路：打包 → 隔离 HOME 安装 → doctor
GOLLUM_E2E_SKIP_CLAUDE=1 bash tests/_v02_install_e2e.sh
bash tests/v01-minimal-demo.sh   # Goal → Outcome → Task → Verify → Recover
bash tests/cross-process-resume.sh
```
