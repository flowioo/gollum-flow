# Gollum V0.2 — Product Requirements Document

> **Status**: Draft V0.2 (2026-09-28)
> **Audience**: Gollum maintainers, contributors, design reviewers
> **Supersedes**: `docs/PRD.md` (V0.1)

---

## 1. 一句话定义

Gollum 是一个**项目级长期状态层**，让任意 Coding Agent（Codex / Claude Code / Hermes / Mavis 等）在用户多个项目间切换时，能自动识别当前项目、加载长期 Goal / Outcome / Task，并持续推进而不是丢失上下文。

它不是 Agent 框架、不是 MCP Server、不是 CLI，而是一份 **agent distro** —— clone 下来的目录即可让任何 Host 进入 Gollum 工作模式。

---

## 2. 核心问题（为什么做）

### 2.1 Coding Agent 现状的三个痛点

1. **跨 Session 失忆**：关掉再开，昨天做到哪、为什么做、接下来做什么全丢。
2. **跨项目串线**：同时维护两个项目时，Agent 容易把 A 项目的决策记到 B 项目。
3. **任务跑偏**：修 Bug 顺便重构，重构顺便抽象，抽象顺便加 Plugin System —— 半年后回看完全不知道 Goal 在哪。

### 2.2 已有的方案为什么不够

- **Firstmate**（`kunchenguid/firstmate`）：解决"同时跑多个 task"的并行冲突，但**没有 Goal / Outcome 抽象**，fire-and-forget 不关心长期推进。
- **Claude Squad / AutoGen / CrewAI**：多 Agent 编排，复杂度高，且仍以 Task 为单位。
- **纯 Memory 系统**（如 Mavis Memory）：不隔离项目，容易串线。
- **手工写 `claude.md` / `AGENTS.md`**：每次重启要让 Agent 自己重读，没有结构化状态。

Gollum 不做调度，不做编排，不替代 Host Agent。它**只负责项目级长期事实**。

---

## 3. 核心概念

```text
Project      一个 Repo 对应一个长期 Project
   ↓
Goal         这个项目最终要实现什么（长期稳定，不频繁改）
   ↓
Outcome      出现什么结果说明 Goal 被推进（可验证）
   ↓
Criteria     什么算 Outcome 完成（多条，可独立 verified）
   ↓
Task         最小工作单元（独立执行 / 独立 Verify / 失败可重试）
   ↓
Evidence     Task 完成的客观证据（不可"Agent 说完成"）
   ↓
Checkpoint   阶段性快照（含当前 Goal/Outcome/Task/Phase/Decision Context）
```

**核心原则**：

- **Progress is verified state change** —— 不是 Agent 自己说 done，而是 Criteria 被 Evidence 验证。
- **Goal 稳定优先** —— Goal 变更必须人工 ack，30 天内禁止自动重写。
- **Evidence owns TRUTH** —— 所有"完成"必须挂 Evidence ID。
- **Steward owns WHY and WHAT NEXT, Host executes HOW** —— Gollum 管为什么做和下一步做什么，Host Agent 管怎么执行。

---

## 4. 用户场景

### 场景 1：日常使用（单项目）

```
用户在 ~/code/gollum-pi 工作
$ cd ~/code/gollum-pi/src
$ codex

# Codex 启动后自动 Bootstrap：
# [Gollum] Project: gollum-pi
# [Gollum] Goal: 实现 checkpoint restore
# [Gollum] Active Outcome: 跨 Session 恢复未完成工作
# [Gollum] Current Task: task-001 实现 CAS 写入
# [Gollum] Mode: managed

# 用户正常对话即可
> 继续 task-001

# Codex 直接继续，不需要重新解释背景
```

### 场景 2：切换目录到另一个项目

```
# 用户切到另一个项目
$ cd ~/code/trading-risk

# Gollum 检测到 Project 切换：
# [Gollum] Project Switch: gollum-pi → trading-risk
# [Gollum] gollum-pi: checkpoint saved (task-001 @ "实现 CAS 写入")
# [Gollum] trading-risk: loaded Goal / Outcome / Task
# [Gollum] Mode: managed

# Context 全量替换，用户在 trading-risk 看到的是 trading-risk 的进度
```

### 场景 3：跨 Session 恢复

```
# 一天前用户关掉 Codex，今天回来
$ cd ~/code/gollum-pi
$ codex

# Gollum 检测到 Project gollum-pi 有未完成的 Task
# 自动恢复到昨天中断的位置
# 显示：当前 Outcome / 当前 Task / 上次 Evidence
```

### 场景 4：进入未注册目录

```
$ cd ~/tmp/scratch

# Gollum: 没有识别到 Project
# [Gollum] No project found at /Users/x/tmp/scratch
# [Gollum] Entering unmanaged mode (no Goal/Outcome/Task)
# 任何写入 ~/.gollum/ 的操作被禁用
```

### 场景 5：并行多项目（Future）

```
# 用户同时维护 3 个项目
$ cd ~/code/project-a && codex    # 跑 Project A
$ cd ~/code/project-b && claude    # Project B
$ cd ~/code/project-c && hermes    # Project C

# 三个 Host 各管一个 Project
# Gollum 通过 project_id 严格隔离
# 任何一个 Project 状态变更不会影响其他
```

---

## 5. 功能清单

### 5.1 P0 — V0.1 必须有

| 功能 | 描述 | 验收标准 |
|---|---|---|
| F1. Project Init | `gollum init` 在当前目录创建 `.steward/project.yaml` + 注册到 Registry | 在新 Repo 跑 init，文件创建 + Registry 条目存在 |
| F2. Project Resolver | 向上递归查找 `.steward/project.yaml` | 在子目录能识别出父 Project；走到项目外识别为 unmanaged |
| F3. Bootstrap | Host 启动后自动加载当前 Project 的 Goal/Outcome/Task | 启动 Codex 后看到 [Gollum] Context Injection 输出 |
| F4. Project Switch | 跨项目切换时自动 Checkpoint + Lease 释放 | cd 到另一个 Project 目录后看到 switch 提示，老 Project 有 checkpoint |
| F5. State 持久化 | Goal / Outcome / Task / Evidence / Checkpoint 写入 `~/.gollum/proj_<id>/` | ls 看得到目录结构，YAML 文件可读 |
| F6. CAS 更新 | 用 `version` 字段 + flock + atomic rename 实现 Compare-And-Swap | 并发写入测试：模拟两个写入竞争，一个成功一个重试 |
| F7. Goal/Outcome/Task 工具 | `gollum goal.*` / `outcome.*` / `task.*` 命令 | CLI 能创建 / 列出 / 更新任务 |
| F8. Evidence 工具 | `gollum evidence.add` 关联 Task | evidence YAML 写入，含 artifact 路径 |
| F9. Checkpoint 工具 | `gollum checkpoint.save` / `checkpoint.load` | 切换目录后老 Project 有新 checkpoint |
| F10. Registry | `~/.gollum/registry.yaml` 维护所有 Project | vim 可读，新增 init 自动注册 |

### 5.2 P1 — 已交付

| 功能 | 状态 | 证据 |
|---|---|---|
| F11. Skills 可被宿主加载 | ✅ 已实现 | 7 个 SKILL.md 带 frontmatter；E2E 证明 Claude 读到 tarball 安装的 skill |
| F12. `gollum doctor` 自检 | ✅ 已实现 | `src/cli/commands/doctor.ts`（Node/目录/store/宿主/skills/项目 六项） |
| F13. `gollum install-skills` | ✅ 已实现 | `src/cli/commands/install-skills.ts`（幂等，`lstat` 区分 symlink） |
| F14. `gollum-resolver` shell hook 入口 | ✅ 已实现 | `src/workflow/resolver.ts` + `src/cli/gollum-resolver.ts` |

### 5.3 P1 — 未实现（文档先行，代码待补）

> 以下功能在本文档中已定义，但 **V0.2 代码中尚不存在**。不要按它们编写集成。

| 功能 | 描述 | 状态 |
|---|---|---|
| F15. AGENTS.md 入口模板 | `templates/AGENTS.md` | ❌ `src/templates/` 不存在 |
| F16. ship/scout 任务分类 | Task 模型加 `shape` 字段 | ❌ `types.ts` 无该字段 |
| F17. bash watcher | 状态文件变化触发唤醒 | ❌ 无实现 |
| F18. Memory 基础读写 | `gollum memory.read/write` | ❌ CLI 无此命令 |

> F15–F18 原编号为 F11–F14，与 §5.2 已交付项重新编号后不冲突。

### 5.4 已由 V0.1 提供（V0.2 未改动）

| 功能 | 位置 |
|---|---|
| Goal Alignment 三态 | `src/mcp/core/goal-align.ts` |
| Scope Creep 关键词检测 | `goal-align.ts:81` |

### 5.5 P2 — V0.3+

| 功能 | 描述 |
|---|---|
| F19. firstmate 集成 | 把 firstmate 作为 Gollum 的"并行执行后端" |
| F20. secondmates | 远程 SSH 副手 |
| F21. Goal 自动提炼 | 长期 Memory 沉淀到 Goal |
| F22. 跨项目查询 | 管理员视角的全局 Project 状态 |

### 5.6 明确不做

- ❌ 完整 Agent 调度系统（firstmate 已经做）
- ❌ 自动修改 Goal（必须人工 ack）
- ❌ 复杂 Memory 提炼（V0.1 只做 read/write）
- ❌ Webhook / 自动触发外部系统
- ❌ 复杂 Progress 评分（只信 verified Criteria）
- ❌ 多级 Planner（Outcome 已经是顶层）

---

## 6. 用户旅程

### 6.1 首次使用

> ⚠️ **发布状态（2026-09-29）**：`gollum-flow@0.2.0` **尚未发布到 npm registry**。
> 下方 `npm install -g gollum-flow` 需要先执行 `npm publish` 才可用。
> 当前已验证的路径是**从本地 tarball 安装**（见 `tests/_v02_install_e2e.sh`）。
> 包名选 `gollum-flow` 而非 `gollum`，因为后者在 npm 上已被他人占用（v1.0.2）。

```bash
# ===== 路径 A：本地 tarball（已验证可用）=====
# 从仓库构建并安装
$ cd ~/code/gollum && npm run build
$ npm pack --pack-destination /tmp
$ npm install -g /tmp/gollum-flow-0.2.0.tgz

# postinstall hook 自动：
#   - mkdir ~/.gollum/{skills,tools,runtime/{leases,events,scheduler}}
#   - 创建 ~/.gollum/registry.yaml
#   - 检测可用 Agent（Claude Code / Codex / Cursor / Mavis）
#   - 软链 skills 到每个已检测 Agent 的 skills 目录

# ===== 路径 B：npm registry（发布后可用）=====
$ npm install -g gollum-flow
$ npx gollum-flow doctor

# ===== 手动重装 skills（覆盖 postinstall 未覆盖的情况）=====
$ gollum doctor              # 自检，看 skills 是否已链接
$ gollum install-skills      # 幂等重链
$ gollum install-skills --agent claude-code   # 只装到一个 agent
```

**skills 的分发路径**：Skills 随 npm 包一起分发（`dist/skills/core/*/SKILL.md`），
由 `postinstall` / `gollum install-skills` 软链到宿主的 skills 目录。

> ❌ **`npx skills add <repo>` 未实现**。该 CLI 需要一个 GitHub 仓库作为
> skill 源，而 Gollum 的 skills 随 npm tarball 分发，两者机制不同。
> V0.3 之前请使用上面的 `gollum install-skills`。

**初始化项目**：

```bash
$ cd ~/code/my-new-project
$ gollum init               # 提示输入 Project name / Goal

# 启动任意 Host
$ codex   # 或 claude / hermes / mavis
# Host 通过已安装的 gollum-bootstrap skill 获得 Bootstrap 协议
```

**升级路径**：

```bash
# 升级 Runtime
$ npm update -g gollum

# 升级 Skills
$ npx skills update
# 或单独升级
$ npx skills add kunchenguid/gollum -g --update
```

### 6.2 日常使用

```bash
# 进项目干活
$ cd ~/code/my-new-project
$ codex
# 看到 [Gollum] Context Injection
# 直接干活

# 切到另一个项目
$ cd ~/code/another-project
# Host（或 Gollum watcher）检测到 Project 切换
# 老 Project 自动 checkpoint，新 Project 加载

# 临时去 scratch 目录
$ cd ~/tmp/scratch
# unmanaged mode，不写 Store
```

### 6.3 长期恢复

```bash
# 三个月没碰的项目
$ cd ~/code/old-project
$ codex
# [Gollum] Project: old-project
# [Gollum] Goal: 实现离线优先
# [Gollum] Active Outcome: 缓存策略
# [Gollum] Last Task: task-042 (DONE 2026-06-15)
# [Gollum] Next Task: task-043
# 用户立即知道三个月前做到哪了
```

---

## 7. 验收标准（V0.1）

### 7.1 多项目自动识别

- [ ] 同 Project 内子目录切换：**no-op**，Project 不变
- [ ] 跨 Project 切换：自动触发 Checkpoint + Lease 释放 + Context 替换
- [ ] 未注册目录：进入 unmanaged mode，禁止写 Store
- [ ] Monorepo 子目录：找到最近的 `.steward/project.yaml` 即停

### 7.2 跨 Host 接力

- [ ] Codex 跑完 task-001 → 退出 → Claude Code 进来继续 task-001
- [ ] 不同 Host 看到同一份 Goal / Outcome / Task

### 7.3 跨 Session 恢复

- [ ] 关闭 Host → 重新启动 → 立即看到 Project 状态
- [ ] 三个月未访问的 Project → 仍能加载 Goal 和历史 Evidence

### 7.4 防跑偏

- [ ] Task 完成 → 自动跑 Goal Alignment
- [ ] Outcome 完成 → 必须所有 Criteria verified
- [ ] Goal 修改必须显式 ack

### 7.5 可验证

- [ ] 每个 Task 完成必须挂 Evidence ID
- [ ] Evidence 必须有 artifact 路径 + verifier 类型
- [ ] "Agent says done" 不算完成，必须 Verify 通过

---

## 8. 与 firstmate 的关系

**Gollum 和 firstmate 是正交的，不是替代**：

| | firstmate | Gollum |
|---|---|---|
| 抽象单位 | Task | Project |
| 解决问题 | 并行执行不冲突 | 长期推进不丢 |
| 时间尺度 | 短期爆发 | 数月到数年 |
| 是否关心 Goal | ❌ | ✅ |

**V0.2 可以组合**：

```text
Gollum (项目大脑)
  ↓ 需要并行执行一个 Outcome 的多个子 Task
firstmate (执行引擎)
  ↓ 派船员到独立 worktree 并行
Evidence 回收 → Gollum 验证 Outcome
```

---

## 9. 风险与缓解

| 风险 | 缓解 |
|---|---|
| Goal Alignment 退化为自我报告 | Verify 类型白名单（unit_test / integration / build / user_acceptance / static / artifact_exists） |
| Host Memory 污染 Project Store | Memory 写入必须显式标注 `truth=project` 或 `truth=cache`，Store 层拒绝未标注写入 |
| Context Injection 越来越长 | 字段白名单，禁止把全部 Project State 塞入 |
| Goal 被自动重写 | Goal 30 天内禁止自动修改，必须人工 ack |
| Lease 残留导致任务死锁 | 30 分钟心跳超时 + 切换目录时强制 release |
| Checkpoint 写入中断 | CAS 版本号 + 原子 rename，回退到上一个完整版本 |

---

## 10. V0.1 时间表（建议）

| Week | Deliverable |
|---|---|
| W1 | `~/.gollum/` 目录骨架 + Project Init 命令 |
| W2 | Project Resolver + Bootstrap 流程 |
| W3 | State YAML + CAS 写入 + flock |
| W4 | Goal/Outcome/Task/Evidence/Checkpoint 工具 |
| W5 | Goal Alignment v1 + Verify 类型白名单 |
| W6 | E2E 测试：单项目 + 跨项目切换 + 跨 Session 恢复 |

---

## 11. 一句话总结

> **Gollum 让 Coding Agent 不再失忆：`npm install -g gollum` + `npx skills add kunchenguid/gollum`，切到哪个目录自动加载哪个项目的 Goal / Outcome / Task / Evidence，让长期项目推进像编辑文件一样自然。**