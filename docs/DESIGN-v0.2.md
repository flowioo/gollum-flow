# Gollum V0.2 — Technical Design

> **Status**: Draft V0.2 (2026-09-28)
> **Companion to**: `docs/PRD-v0.2.md`
> **Supersedes**: `docs/DESIGN.md` (V0.1)

---

## 1. 总体架构

```text
                          User
                           │
            ┌──────────────┼──────────────┐
            ▼              ▼              ▼
         Codex Chat    CC Chat    Hermes/Mavis Chat
            │              │              │
            └──────────────┼──────────────┘
                           │
                     Host Bootstrap
                           │
                     Project Resolver
                           │
                           ▼
                  ┌────────────────────┐
                  │  Gollum Distro     │
                  │  AGENTS.md         │
                  │  Skills / Tools    │
                  └─────────┬──────────┘
                            │
                  ┌─────────┴──────────┐
                  ▼                    ▼
   ~/.gollum/registry.yaml    ~/.gollum/proj_<id>/
   (全局索引)                  (每项目状态)
```

### 三条核心不变量

1. **Project Identity 在 Repo 里**（`.steward/project.yaml`，跟着代码走）
2. **Project State 在 `~/.gollum/`**（按项目分目录，不污染 Repo）
3. **Registry 全局唯一**（跨项目索引，但不 JOIN State）

---

## 2. 目录结构

### 2.1 全局目录

```text
~/.gollum/
├── config.yaml                          # 全局配置
├── registry.yaml                        # Project Registry（人类可读）
├── skills/                              # Gollum 自带 Skills
│   ├── gollum-bootstrap/
│   ├── gollum-goal-align/
│   ├── gollum-task-run/
│   └── gollum-recover/
├── tools/                               # CLI 工具入口
│   ├── gollum                           # 主命令
│   ├── gollum-resolver                  # Project 识别
│   └── gollum-store                     # State 读写
├── runtime/                             # Runtime 全局状态
│   ├── leases/active.yaml
│   ├── events/2026-09-28.yaml
│   └── scheduler/wake-queue.yaml
└── proj_<id>/                           # 每个 Project 独立目录
```

### 2.2 Project 目录（每项目独立）

```text
~/.gollum/proj_gollum_pi/
├── identity.yaml                        # 镜像 Repo 内的 project.yaml
├── goal.yaml                            # 当前 Goal
├── outcomes/
│   ├── outcome-001.yaml
│   └── outcome-002.yaml
├── tasks/
│   ├── task-001.yaml
│   └── task-002.yaml
├── evidence/
│   ├── evidence-001.yaml
│   └── artifacts/                       # Evidence 关联的产物
│       ├── test-output-001.log
│       └── screenshot.png
├── checkpoints/
│   ├── ckpt-2026-09-28T14-30.yaml
│   └── ckpt-2026-09-28T15-45.yaml
├── sessions/
│   └── session-2026-09-28.yaml
└── memory/
    └── long-term.yaml
```

### 2.3 Repo 内的 Identity

```text
your-repo/
└── .steward/
    └── project.yaml                     # 仅 Project Identity
```

```yaml
# .steward/project.yaml
project_id: proj_gollum_pi
name: gollum-pi

workspace:
  type: git
  root: "."

# 可选：项目级约束
constraints:
  - "不得直接 push main 分支"
  - "测试必须用 pytest"

# 可选：项目级 Skills（覆盖默认）
skills:
  - local: .steward/skills/blender-mcp.md
```

### 2.4 Registry 格式（人类可读）

```yaml
# ~/.gollum/registry.yaml
version: 1
projects:
  - id: proj_gollum_pi
    name: gollum-pi
    repo_root: /Users/qinchunxia/code/gollum-pi
    state_dir: /Users/qinchunxia/.gollum/proj_gollum_pi
    identity_file: /Users/qinchunxia/code/gollum-pi/.steward/project.yaml
    last_opened: 2026-09-28T23:30:00+08:00
    last_host: claude-code
    status: active
```

**为什么不存成 SQLite**：
- `vim ~/.gollum/registry.yaml` 直接编辑修复
- `git init ~/.gollum/` 做审计 / 备份
- 跨机器同步用 `rsync` / syncthing 一目了然

---

## 3. 数据模型（统一格式）

每个 State 文件 = YAML + `version` 字段：

### 3.1 Goal

```yaml
# ~/.gollum/proj_gollum_pi/goal.yaml
version: 3
id: goal-001
title: "实现 Agent 长期自主工作"
status: active
created_at: 2026-06-01T10:00:00+08:00
updated_at: 2026-09-28T14:00:00+08:00

# Goal 修改保护
protection:
  lock_until: 2026-12-01T10:00:00+08:00   # 30 天内禁止自动修改
  requires_ack: true                       # 必须人工 ack
```

### 3.2 Outcome

```yaml
# outcomes/outcome-001.yaml
version: 5
id: outcome-001
goal_id: goal-001
title: "Agent 能跨 Session 恢复未完成工作"
status: in_progress
shape: ship                               # ship | scout

criteria:
  - id: c1
    description: "重启后恢复 active task"
    status: verified
    evidence_ref: evidence-007            # 溯源到 Evidence
  - id: c2
    description: "已完成 execution 不重复执行"
    status: unknown
```

### 3.3 Task

```yaml
# tasks/task-001.yaml
version: 7
id: task-001
outcome_id: outcome-001
title: "实现 CAS 写入"
shape: ship                               # ship | scout
status: in_progress
intent: |
  解决并发写入冲突，保证状态一致性

acceptance_criteria:
  - type: unit_test
    description: "并发写入测试"
  - type: build_pass
    description: "CI 绿"

started_at: 2026-09-28T14:00:00+08:00
updated_at: 2026-09-28T15:30:00+08:00

lease:
  owner: session-2026-09-28-cc-001
  expires_at: 2026-09-28T16:00:00+08:00
```

### 3.4 Evidence

```yaml
# evidence/evidence-007.yaml
version: 1
id: evidence-007
task_id: task-001
type: unit_test                            # 必须是白名单之一
verifier: pytest
result: "12/12 passed"
artifact: artifacts/test-output-007.log    # 相对项目根
created_at: 2026-09-28T15:30:00+08:00
```

**Verify 类型白名单**（不在白名单的一律拒绝）：

```
- unit_test          # 单元测试
- integration_test   # 集成测试
- build_pass         # CI 构建通过
- user_acceptance    # 用户验收
- static_check       # lint / type check
- artifact_exists    # 文件存在
```

### 3.5 Checkpoint

```yaml
# checkpoints/ckpt-2026-09-28T15-45.yaml
version: 1
id: ckpt-2026-09-28T15-45
project_id: proj_gollum_pi
session_id: session-2026-09-28-cc-001
host: claude-code

snapshot:
  goal_ref: goal-001
  outcome_ref: outcome-001
  task_ref: task-001
  phase: "writing CAS code"
  
decision_context: |
  决定使用 flock + atomic rename，因为 fseek 写入不原子。
  备选：SQLite，复杂度高。
  
wake_condition: "all 12 unit tests pass"
created_at: 2026-09-28T15:45:00+08:00
```

**Checkpoint 不存**：用户偏好、长期技术经验、全部聊天。这些归 Memory 管。

---

## 4. 关键算法

### 4.1 Project Resolver

```python
# ~/.gollum/lib/resolver.py

from pathlib import Path

class ProjectResolver:
    def __init__(self):
        self._current: dict | None = None  # {project_id, repo_root}
    
    def notify_cwd(self, cwd_str: str) -> dict:
        """Shell hook 调用，每次 cd 触发"""
        cwd = Path(cwd_str).resolve()  # 关键：先解 symlink
        
        # 缓存命中：仍在同一 Project 树内
        if self._current:
            try:
                cwd.relative_to(self._current["repo_root"])
                return {"project_id": self._current["project_id"], 
                        "changed": False}
            except ValueError:
                pass  # 走出 Project 树
        
        # 走出 Project 树 → 重新搜索
        project = self._search_upward(cwd)
        old = self._current
        
        if project:
            self._current = {
                "project_id": project["project_id"],
                "repo_root": project["repo_root"],
            }
        else:
            self._current = None
        
        return {
            "project_id": project["project_id"] if project else None,
            "old_project_id": old["project_id"] if old else None,
            "changed": old["project_id"] != (project["project_id"] if project else None),
        }
    
    def _search_upward(self, start: Path) -> dict | None:
        p = start
        while True:
            yaml = p / ".steward" / "project.yaml"
            if yaml.is_file():
                data = yaml.safe_load(yaml.read_text())
                return {
                    "project_id": data["project_id"],
                    "repo_root": str(p),
                    "name": data.get("name"),
                }
            parent = p.parent
            if parent == p:  # 文件系统根
                return None
            p = parent
```

### 4.2 State CAS 写入

```python
# ~/.gollum/lib/store.py

import fcntl
import yaml
from pathlib import Path

class StateConflict(Exception):
    pass

def update_yaml(path: Path, mutate_fn, expected_version: int):
    """
    原子更新 + CAS。
    mutate_fn: (current_data) -> new_data
    """
    lock_path = path.with_suffix(".lock")
    lock_path.touch()
    
    with open(lock_path, "r+") as lock_fd:
        fcntl.flock(lock_fd, fcntl.LOCK_EX)  # 文件级排他锁
        
        # 持有锁期间重新读（防止读后写前被人改）
        if path.exists():
            current = yaml.safe_load(path.read_text()) or {}
        else:
            current = {}
        
        # CAS 检查
        if current.get("version", 0) != expected_version:
            raise StateConflict(
                f"expected v{expected_version}, got v{current.get('version', 0)}"
            )
        
        # 应用变更
        new_data = mutate_fn(current)
        new_data["version"] = expected_version + 1
        new_data["updated_at"] = now_iso()
        
        # 原子写入：tmp + rename
        tmp = path.with_suffix(".tmp")
        tmp.write_text(yaml.safe_dump(new_data, allow_unicode=True))
        tmp.rename(path)  # POSIX rename 原子
```

### 4.3 Bootstrap 流程

```text
Host 启动（Codex / Claude Code / Hermes）
    ↓
Shell hook: gollum-resolver notify-cwd "$PWD"
    ↓
Resolver 返回 {project_id, changed}
    ↓
如果是 changed → Project Switch Protocol：
   1. 老 Project: save checkpoint (SessionEnd)
   2. 老 Project: release lease
   3. 新 Project: load state
    ↓
Bootstrap 加载新 Project 状态：
   1. goal.yaml
   2. active outcome
   3. current task
   4. latest evidence
    ↓
Compact Context 注入 Host:
   Project: gollum-pi
   Goal: ...
   Active Outcome: ...
   Current Task: ...
   Last Evidence: ...
   Mode: managed
    ↓
Host 正常工作
```

### 4.4 Project Switch Protocol

```python
def switch_to(new_project_id):
    old = current_project()
    
    # 1. 老项目: save checkpoint（如果当前有活跃 Session）
    if old and has_active_session(old):
        try:
            save_checkpoint(
                project_id=old["project_id"],
                phase="interrupted_by_switch",
                decision_context="User switched to another project",
            )
        except StateConflict:
            jitter_backoff()
            save_checkpoint(...)
    
    # 2. 老项目: release lease
    if old and has_active_lease(old):
        try:
            release_lease(old["project_id"])
        except StateConflict:
            jitter_backoff()
            release_lease(old["project_id"])
    
    # 3. 新项目: load state
    try:
        state = load_state(new_project_id)
    except StateConflict:
        jitter_backoff()
        state = load_state(new_project_id)
    
    # 4. Host context 全量替换
    inject_context(state)
```

---

## 5. CLI 工具

### 5.1 命令清单

```bash
# Project 生命周期
gollum init                          # 在当前目录初始化 Project
gollum adopt <project_id>            # 老项目接入 Gollum
gollum list                          # 列出所有 Project
gollum current                       # 显示当前 Project
gollum switch <project_id>           # 强制切换（不依赖 cwd）

# Goal
gollum goal.get
gollum goal.update --title "..." --requires-ack
gollum goal.align                    # Goal Alignment 检查

# Outcome
gollum outcome.list
gollum outcome.create --goal goal-001 --title "..."
gollum outcome.update outcome-001 --status in_progress
gollum outcome.evaluate outcome-001  # 检查所有 Criteria 是否 verified

# Task
gollum task.list
gollum task.create --outcome outcome-001 --title "..." --shape ship
gollum task.claim task-001           # 取 Lease
gollum task.update task-001 --status in_progress
gollum task.complete task-001 --evidence evidence-007

# Execution
gollum execution.start task-001
gollum execution.finish task-001 --status success
gollum execution.fail task-001 --error "..."

# Evidence
gollum evidence.add --task task-001 --type unit_test --artifact ...
gollum evidence.list

# Checkpoint
gollum checkpoint.save --phase "..."
gollum checkpoint.load --latest

# Memory
gollum memory.read
gollum memory.write --content "..."

# 安装与升级
gollum doctor                        # 自检：runtime / agents / skills / store
gollum install-skills --agent claude-code
gollum install-skills --agent codex --global
```

### 5.2 分发方式：npm 包

Gollum Runtime 通过 npm 分发，**包名 `gollum`**，源码在 `github.com/kunchenguid/gollum`。

```text
gollum/
├── package.json                     # npm 元数据
├── bin/
│   ├── gollum                       # 主 CLI（Node.js 入口）
│   ├── gollum-resolver
│   └── gollum-store
├── lib/                             # 核心库
│   ├── store.js                     # CAS 写入 + flock
│   ├── resolver.js                  # Project 解析
│   └── bootstrap.js                 # Context 注入
├── skills/                          # 内置 Skills（待 link）
│   ├── gollum-bootstrap/
│   ├── gollum-goal-align/
│   ├── gollum-task-run/
│   ├── gollum-verify/
│   ├── gollum-recover/
│   └── gollum-ship-scout/
├── templates/
│   ├── project.yaml                 # init 时用的模板
│   ├── AGENTS.md
│   └── skills/gollum-bootstrap/SKILL.md
├── hooks/
│   └── postinstall.js               # npm install 后自动跑
└── README.md
```

`postinstall.js` 流程：

```text
1. 检测 OS（macOS / Linux）
2. mkdir -p ~/.gollum/{skills,tools,runtime/{leases,events,scheduler}}
3. 创建 ~/.gollum/registry.yaml（如果不存在）
4. 检测可用 Agent（Claude Code / Codex / Cursor / Mavis）
5. 把 skills/ 软链到 ~/.gollum/skills/gollum-*/
6. 给每个检测到的 Agent 软链到 ~/.claude/skills/gollum-*/ 等
7. 打印下一步提示
```

`package.json` 关键字段：

```json
{
  "name": "gollum",
  "version": "0.2.0",
  "bin": {
    "gollum": "bin/gollum.js",
    "gollum-resolver": "bin/gollum-resolver.js",
    "gollum-store": "bin/gollum-store.js"
  },
  "scripts": {
    "postinstall": "node hooks/postinstall.js"
  },
  "dependencies": {
    "yaml": "^2.5.0",
    "chokidar": "^4.0.0"
  }
}
```

### 5.3 Skills 与 Runtime 的边界

```text
Runtime（npm 包）提供：
  - 可执行命令（gollum / gollum-resolver / gollum-store）
  - 状态文件读写逻辑（CAS、flock）
  - Project 解析逻辑
  - Templates（project.yaml / AGENTS.md）

Skills（GitHub repo）提供：
  - SKILL.md：教 Agent 怎么调 gollum 命令
  - 触发条件描述（让 Agent 知道何时加载）
  - 反模式（告诉 Agent 不要做什么）
```

**两者关系**：Skill 是"用法手册"，Runtime 是"实际工具"。Skill 让 Agent **记得用** gollum，gollum 让 Agent **真的能做**。

---

## 6. Skills（Agent 加载）

### 6.1 Skill 分发：通过 `npx skills add`

Skills **不打包在 npm 里**，而是放在 GitHub 仓库 `github.com/kunchenguid/gollum/skills/` 下，通过 `npx skills add` 安装到目标 Agent 的 skills 目录。

**为什么分开**：

- Skills 需要被 Agent 加载到上下文（SKILL.md 被 Agent 读）
- Runtime 是 CLI 工具，需要被 shell 调用
- 两者的更新节奏不同：Skills 可以频繁迭代，Runtime 相对稳定
- 解耦后可以独立发版

**安装命令**：

```bash
# 全局安装到 Claude Code（默认 agent）
npx skills add kunchenguid/gollum -g

# 安装到指定 agent
npx skills add kunchenguid/gollum -g --agent claude-code
npx skills add kunchenguid/gollum -g --agent codex
npx skills add kunchenguid/gollum -g --agent cursor
npx skills add kunchenguid/gollum -g --agent mavis

# 同时安装到多个 agent
npx skills add kunchenguid/gollum \
    --agent claude-code \
    --agent codex \
    --global

# 只装某个 skill（不全装）
npx skills add kunchenguid/gollum --skill gollum-bootstrap -g
npx skills add kunchenguid/gollum --skill gollum-verify -g

# 升级
npx skills update
```

### 6.2 Skills 仓库结构

```text
github.com/kunchenguid/gollum/
└── skills/
    ├── gollum-bootstrap/
    │   └── SKILL.md
    ├── gollum-goal-align/
    │   └── SKILL.md
    ├── gollum-task-run/
    │   └── SKILL.md
    ├── gollum-verify/
    │   └── SKILL.md
    ├── gollum-recover/
    │   └── SKILL.md
    └── gollum-ship-scout/
        └── SKILL.md
```

### 6.3 安装位置

`npx skills add` 会把 SKILL.md 软链到目标 Agent 的 skills 目录：

```text
Claude Code:   ~/.claude/skills/gollum-{name}/SKILL.md
              或 ./.claude/skills/gollum-{name}/SKILL.md (项目级)
Codex:         .agents/skills/gollum-{name}/SKILL.md
Cursor:        ~/.cursor/skills/gollum-{name}/SKILL.md
Mavis:         ~/.mavis/skills/gollum-{name}/SKILL.md
```

### 6.4 Skill 文件格式

每个 Skill 必须含 `SKILL.md`，标准结构：

```markdown
---
name: gollum-bootstrap
description: |
  Bootstrap Gollum 项目上下文。在 Host Agent 启动或切换目录时触发。
  加载此 skill 后，Agent 必须先调用 gollum-resolver 解析当前 Project，
  然后读取 Goal/Outcome/Task 注入上下文。
---

# Gollum Bootstrap

## 触发条件
- Host Agent 刚启动
- cwd 发生变化
- 用户显式说 "继续这个项目"

## 输入
- $PWD（当前工作目录）

## 流程
1. 调用 `gollum-resolver notify-cwd "$PWD"` 获取 project_id
2. 如果 project_id 变化：
   a. 释放老 Project 的 Lease
   b. 保存老 Project 的 SessionEnd Checkpoint
   c. 加载新 Project 的 goal.yaml / active outcome / current task
3. 注入 Context:
   ```
   [Gollum] Project: <name>
   [Gollum] Goal: <title>
   [Gollum] Outcome: <title>
   [Gollum] Task: <id> <title>
   [Gollum] Last Evidence: <id>
   [Gollum] Mode: managed
   ```
4. 选择模式：managed（有活跃 Task）/ aware（仅讨论）

## 输出
- Compact Context 已注入 Host
- Mode 已设置

## 反模式
- ❌ 不要跳過 resolver 直接读取 ~/.gollum/
- ❌ 不要把 Goal 注入到用户对话正文（只放 Context）
- ❌ 不要在 unmanaged mode 下写 Store
- ❌ 不要自动修改 Goal（必须用户 ack）
```

### 6.5 Skills 列表

| Skill | 作用 | 触发时机 |
|---|---|---|
| `gollum-bootstrap` | Project 解析 + Context 注入 | Host 启动 / cd / "继续这个项目" |
| `gollum-goal-align` | Goal Alignment 三态检查 | Task 完成时 |
| `gollum-task-run` | Task 执行标准协议 | claim → execute → complete |
| `gollum-verify` | Verify 类型白名单 + 流程 | Task complete 之前 |
| `gollum-recover` | 跨 Session 恢复协议 | Host 启动发现未完成任务 |
| `gollum-ship-scout` | 任务二分法（firstmate 借鉴） | 创建 Task 时判断 shape |

---

## 7. 借鉴 firstmate 的 6 个模式

| 模式 | 实现位置 | 优先级 |
|---|---|---|
| **Agent Distro**（npm + skills 分发） | `npm install -g gollum` + `npx skills add kunchenguid/gollum` | P0 |
| **AGENTS.md 入口** | `templates/AGENTS.md` + skill 注入 | P1 |
| **ship / scout 任务分类** | Task 模型 `shape` 字段 + `gollum-ship-scout` skill | P1 |
| **bash watcher 零 token** | `runtime/watcher.sh` | P2 |
| **重启 reconcile** | Checkpoint + Registry + Lease | P0（已实现） |
| **secondmates 远程副手** | V0.3+ | P3 |

### AGENTS.md 示例

```markdown
# AGENTS.md (placed at .gollum/AGENTS.md)

## Identity
You are operating under Gollum Project Management.

## Bootstrap (mandatory on every session start)
1. Run: `gollum-resolver notify-cwd "$PWD"`
2. Read: `~/.gollum/<current_project>/goal.yaml`
3. Read: `~/.gollum/<current_project>/outcomes/active.yaml`
4. Read: `~/.gollum/<current_project>/tasks/current.yaml`
5. Inject compact context
6. Select mode: managed | aware

## Hard Rules
- Never write to ~/.gollum/<other_project>/
- Never modify Goal without explicit user ack
- Always emit Evidence for any Task completion
- CAS conflict → jitter 1-3s → retry ≤ 3
- Verify type must be from whitelist

## Task Shape
- ship: deliver code change, requires Evidence
- scout: produce report only, no code change
```

---

## 8. 并发控制

### 8.1 Lease 模型

```yaml
# tasks/task-001.yaml
lease:
  owner: session-2026-09-28-cc-001
  expires_at: 2026-09-28T16:00:00+08:00
heartbeat:
  last_ping: 2026-09-28T15:45:00+08:00
```

### 8.2 Claim 流程

```text
Session A: gollum task.claim task-001
    ↓
读 task-001.yaml
    ↓
检查 lease.expires_at < now?
   ├─ Yes → lease.owner = session_a, CAS write
   └─ No  → 已被 Session B 持有 → retry / wait
```

### 8.3 心跳

```text
每 5 分钟 Session ping: gollum task.heartbeat task-001
    ↓
读 task-001.yaml
    ↓
CAS 更新 heartbeat.last_ping 和 lease.expires_at (+30 min)
```

### 8.4 超时

```text
lease.expires_at < now - 5min
    ↓
视为 Lease 过期
    ↓
下一个 Session 可以 claim
```

---

## 9. Goal Alignment（V0.2）

```python
def align(task_id):
    task = load_task(task_id)
    outcome = load_outcome(task.outcome_id)
    goal = load_goal(outcome.goal_id)
    
    # 检查 Task 是否真的推进 Outcome
    if not task_pushes_outcome(task, outcome):
        return "UNCERTAIN", "Task doesn't clearly advance Outcome"
    
    # 检查 Outcome 是否仍然服务 Goal
    if not outcome_serves_goal(outcome, goal):
        return "MISALIGNED", "Outcome no longer serves Goal"
    
    return "ALIGNED", None
```

三态处理：

```text
ALIGNED      → 继续
UNCERTAIN    → 允许 re-evaluate / replan / create scout task
MISALIGNED   → pause current task → backlog → replan → ask user
```

---

## 10. 实施步骤

### W1 — npm 包骨架

```bash
mkdir -p gollum/{bin,lib,skills,templates,hooks}
# package.json（见第 5.2 节）
# bin/gollum.js（CLI 入口，Node.js）
# hooks/postinstall.js（创建 ~/.gollum/ 目录结构）
```

发布到 npm：

```bash
npm login
npm publish --access public
# → gollum@0.2.0 可被 npm install -g gollum
```

### W2 — Skills 仓库

```bash
mkdir -p gollum/skills/{gollum-bootstrap,gollum-goal-align,gollum-task-run,gollum-verify,gollum-recover,gollum-ship-scout}
# 每个 skill 写 SKILL.md（参考第 6.4 节模板）
```

发布到 GitHub：`github.com/kunchenguid/gollum` 的 `skills/` 目录。

### W3 — Init + Bootstrap

```bash
gollum init
  # 创建 .steward/project.yaml
  # 创建 ~/.gollum/proj_<id>/
  # 注册到 registry.yaml
  # 提示输入 Goal
```

### W4 — State + CAS

实现 `lib/store.js` 的 `updateYaml` 和 `flock`。

### W5 — CLI 工具

实现 `gollum goal/outcome/task/evidence/checkpoint` 全套。

### W6 — Resolver + Bootstrap

实现 `lib/resolver.js`，写 shell hook 集成。

### W7 — 安装流程 E2E

```bash
# 全新环境
npm install -g gollum
npx skills add kunchenguid/gollum -g
cd ~/code/new-project
gollum init
codex
# 验证 [Gollum] Context Injection 出现
```

### W8 — 全场景 E2E 测试

测试场景：
1. npm 全局安装 + skills add 全局安装
2. 单项目完整生命周期
3. 跨项目切换
4. 跨 Session 恢复
5. CAS 冲突
6. Lease 过期
7. npx skills update 升级
8. gollum doctor 自检

---

## 11. 监控与调试

```bash
# 查看当前状态
gollum current
gollum status                        # 当前 Project + Goal + Outcome + Task

# 查看历史
gollum checkpoint.list
gollum evidence.list
gollum sessions.list

# 调试模式
GOLLUM_DEBUG=1 gollum resolver notify-cwd "$PWD"

# 全局事件流
tail -f ~/.gollum/runtime/events/2026-09-28.yaml
```

---

## 12. 与 V0.1 的差异

| 维度 | V0.1 | V0.2 |
|---|---|---|
| 全局目录 | `~/.steward/` | `~/.gollum/` |
| Registry | `registry.db`（SQLite） | `registry.yaml`（人类可读）|
| Store | 单一 `store.db` | `~/.gollum/proj_<id>/` 按项目分目录 |
| State 格式 | 表 + 字段 | YAML 文件 + `version` 字段 |
| CAS | SQLite 事务 | `flock` + 原子 rename |
| Verify 形式化 | 口号 | Verify 类型白名单 + Evidence 强引用 |
| Goal 保护 | 无 | 30 天锁 + 必须 ack |
| firstmate 整合 | 无 | 6 个具体模式借鉴 |
| Goal Alignment | 有 | 加 Outcome 服务 Goal 检查 |

---

## 13. 一句话总结

> **Gollum V0.2 是 `~/.gollum/proj_<id>/` 集中式状态层 + Goal/Outcome/Task/Evidence/Checkpoint 五层模型 + YAML + CAS，Runtime 通过 npm 分发、Skills 通过 `npx skills add` 安装到任意 Coding Agent，让多项目间切换不丢上下文。**