# 10 · V0.1 Minimal Demo：自主循环证明

> **V0.1 的核心命题**
> **关闭 Agent，再重新启动，它还能知道自己为什么工作、做到哪了、接下来该做什么，并最终把测试跑通。**

这个命题压过了「Issue → PR → CI → Merge」。

---

## 1. V0.1 只证明自主循环，不证明生态集成

| 维度 | V0.1 是否验证 |
|---|---|
| Goal Alignment | ✅ |
| Task Planning | ✅ |
| Persistence | ✅ |
| Resume | ✅ |
| Verify | ✅ |
| Recovery | ✅ |
| GitHub Issue 接入 | ❌ → V0.5 |
| PR 自动化 | ❌ → V0.5 |
| CI 集成 | ❌ → V0.5 |
| Webhook 触发 | ❌ → V0.5 |
| 多 Agent 协作 | ❌ → V1 |

理由：

> **GitHub PR / CI / Merge 都只是 Tool Integration，不应该成为 V0.1 的核心风险。**
> 如果 V0.1 失败在 CI 集成上，是工具问题不是架构问题。
> 如果 V0.1 失败在自主循环上，那是真问题。

---

## 2. Demo 形态：故意有 bug 的本地 Repo

### 2.1 Repo 准备

故意准备一个 **2~3 个 bug** 的本地 Repo：

```
demo-repo/
├── src/
│   ├── calculator.py    # bug 1: 加法溢出
│   ├── parser.py        # bug 2: 边界条件错误
│   └── utils.py         # bug 3: 死循环
├── tests/
│   ├── test_calculator.py
│   ├── test_parser.py
│   └── test_utils.py
└── README.md
```

Bug 设计原则：

- 每个 bug 独立，不会因为修一个就带出新 bug
- 每个 bug 有对应 unit test 失败
- 修复后测试立刻 PASS
- 修复工作量在 10–30min 范围内

### 2.2 Goal 输入

User 给定：

```
Goal: 修复项目，使全部测试通过
```

没有指定 Outcome、没有指定 Task、没有指定策略 — **Agent 自己拆**。

---

## 3. 完整流程

### 第一轮：拆解 + 修第一个 bug

```
T0: 启动 Agent
  ↓
Load Goal: "修复项目，使全部测试通过"
  ↓
Planner 自动拆 Outcome + Criteria:
  Outcome: "所有测试 PASS"
  Criterion c1: "pytest 全绿"
    verifier: { type: "command", config: { command: "pytest", expect: "exit 0" } }
  ↓
Planner 自动拆 Task:
  Task 1: 分析 failing tests
  Task 2: 修复 calculator 加法溢出
  Task 3: 修复 parser 边界条件
  Task 4: 修复 utils 死循环
  ↓
goal-align(Task 1) → aligned
  ↓
Execute Task 1:
  - 运行 pytest
  - 收集失败列表
  ↓
Verify Task 1 → PASS
  ↓
attach_evidence → 不直接动 Criterion（Task 1 不产出最终 evidence）
  ↓
Checkpoint
```

### 第二轮：修第二个 bug（中途模拟进程崩溃）

```
T1: 启动 Agent (新进程)
  ↓
Load Task: "Task 2: 修复 calculator 加法溢出"
  ↓
goal-align(Task 2) → aligned
  ↓
Execute Task 2:
  - 修改 src/calculator.py
  - 运行 pytest
  - 收集 evidence（test_calculator.py 现在 PASS, test_parser.py 仍 FAIL, test_utils.py 仍 FAIL）
  ↓
Verify Task 2 → PASS (test_calculator.py PASS)
  ↓
attach_evidence(c1, evidence) → criterion.derived_status 仍为 UNKNOWN（不是全部 PASS）
  ↓
Checkpoint
  ↓
*** 模拟进程崩溃（手动 kill Agent 进程） ***
  ↓
Task 3 / Task 4 仍然 PENDING
  Criterion c1.derived_status = UNKNOWN
  Outcome.status = IN_PROGRESS
```

### 第三轮：Resume + 修剩余 bug

```
T2: 30min 后 / 手动重启 Agent (新进程)
  ↓
Load Project + Goal + Outcome
  ↓
Load active Outcomes (status = IN_PROGRESS)
  ↓
outcome-evaluate:
  remaining_gap = 1 (c1.derived_status = UNKNOWN)
  needs_new_task = true
  ↓
Select Outcome (只有 1 个 active)
  ↓
Select Task: Task 3 (next PENDING, priority 最高)
  ↓
goal-align(Task 3) → aligned
  ↓
Claim Task 3 → RUNNING
  ↓
Execute Task 3:
  - 修复 src/parser.py 边界条件
  - 运行 pytest
  - 收集 evidence（test_parser.py 现在 PASS, test_utils.py 仍 FAIL）
  ↓
Verify Task 3 → PASS
  ↓
attach_evidence(c1, evidence) → criterion.derived_status 仍为 UNKNOWN（utils 还 FAIL）
  ↓
Select Task 4
  ↓
Execute Task 4:
  - 修复 src/utils.py 死循环
  - 运行 pytest
  - 收集 evidence（ALL TESTS PASS）
  ↓
Verify Task 4 → PASS
  ↓
attach_evidence(c1, evidence) → criterion.derived_status = PASS
  ↓
outcome-evaluate: 所有 criterion PASS → Outcome.status = VERIFIED
  ↓
goal-align → Task 已无 PENDING
  ↓
Goal.achieve (所有 Outcome VERIFIED)
  ↓
Demo 结束
```

---

## 4. 一次证明 6 个核心能力

| # | 能力 | 在 Demo 中的体现 |
|---|---|---|
| 1 | **Goal Alignment** | 每次新建 Task / Checkpoint 时 `goal-align` 返回 aligned |
| 2 | **Task Planning** | Agent 启动时从 Goal 自动拆 Outcome + Task 序列 |
| 3 | **Persistence** | T2 时刻从 store 加载 Task 3，知道之前 Task 1/2 已 DONE |
| 4 | **Resume** | T2 时刻知道「自己为什么工作（Goal）、做到哪了（Outcome.progress=0.5）、接下来做什么（Task 3）」 |
| 5 | **Verify** | 每个 Task 都有 Verify 步骤（运行 pytest），evidence 落库 |
| 6 | **Recovery** | T1 进程崩溃 → T2 自动恢复；Task 2 修了 A 但 B/C 仍失败 → 系统继续推进而不是放弃 |

> **这 6 个能力就是 Gollum 的「自主循环」。**
> 没有 GitHub、没有 CI、没有 Webhook、没有 PR。
> 但**这就是 Gollum 区别于普通 Agent 的本质**。

---

## 5. 为什么这个 Demo 比「Issue → PR → CI → Merge」更强

| 对比项 | 旧 Demo | 新 Demo |
|---|---|---|
| 触发复杂度 | 需 Issue / PR / CI 平台 | 纯本地 |
| 验证依赖 | CI 服务可用性 | pytest 即可 |
| 失败模式 | CI 失败 / 网络失败 / 平台限流 | 只有代码 bug |
| 噪音 | PR 评论 / CI 日志结构化 | 干净的 pytest 输出 |
| 核心风险 | 生态集成（Tool 问题） | 自主循环（架构问题） |
| 调试成本 | 高（CI 平台黑盒） | 低（一切本地） |
| 完成时间 | 难以预测 | **1 个会话内可完成** |

> 旧 Demo 把架构风险和工具风险混在一起。
> 新 Demo 把架构风险隔离出来。
> 如果新 Demo 跑不通，说明架构真有 bug。
> 如果新 Demo 跑通了，再叠 Tool Integration 是 1+1 的事。

---

## 6. Demo Repo 准备规范（建议）

为了让 Demo 能稳定复现，建议 repo 满足：

1. **Bug 数量**：2~3 个（太少不够验证 Recovery，太多 Demo 太长）
2. **Bug 独立性**：每个 bug 修复后对应的 test 立刻 PASS，不影响其他 test
3. **测试运行时间**：整套 pytest < 30s（避免 Verify 太慢）
4. **无外部依赖**：不联网、不依赖 docker（除 python 外无其他依赖）
5. **可重现**：随机种子、固定版本依赖（requirements.txt）
6. **修复工作量**：每个 bug 5–15min 代码改动（不引入新设计）

### 示例：bug 设计

```python
# src/calculator.py - bug 1: 加法溢出
def add(a: int, b: int) -> int:
    return a + b  # 实际正确，但下面的减法有 bug

def subtract(a: int, b: int) -> int:
    return a - b - 1  # bug: 多减了 1

# src/parser.py - bug 2: 边界条件
def parse_int(s: str) -> int:
    if not s:
        return 0
    return int(s)  # bug: 不处理负数

# src/utils.py - bug 3: 死循环
def find_first(items: list, target) -> int:
    i = 0
    while i < len(items):
        if items[i] == target:
            return i
        i += 1
    return -1  # 实际正确，但下面有 bug

def find_last(items: list, target) -> int:
    i = len(items) - 1
    while i >= 0:
        if items[i] == target:
            return i
        i += 0  # bug: 死循环，永远 i=len-1
    return -1
```

每个 bug 都有对应 unit test 失败，修复后立刻 PASS。

---

## 7. 配套的 V0.1 验收

跑通这个 Demo 后，V0.1 还必须满足：

```
Task DONE 后能 attach_evidence 到对应 Criterion
Criterion.derived_status 随最新 evidence.status 自动推导
所有 Criterion.derived_status == PASS 时 Outcome 自动 VERIFIED
所有 Outcome VERIFIED 时 Goal 自动 achieved
跨进程重启后能 Resume
CAS 冲突按 reload + backoff 1-3s + re-evaluate + ≤3 次处理
Lease 过期自动可被重新接管
Event Log 完整记录 CRITERION_VERIFIED / OUTCOME_VERIFIED / TASK_RESUMED 等事件
goal-align misaligned 时 Agent 自处理（pause → rollback → 换 task），不找人
```

---

## 8. Demo 之外的 V0.1 不做清单（强化）

V0.1 **明确不做**：

```
❌ GitHub Issue 集成
❌ PR 创建 / 评论 / Review
❌ CI 平台集成（GitHub Actions / CircleCI / Jenkins）
❌ Webhook 接收
❌ Email 触发
❌ 任何外部 SaaS 依赖
❌ Docker / 远程执行
❌ Vector DB / Memory Evolution
❌ Skill 自动生成
❌ Multi-Agent
❌ 复杂 DAG
```

V0.1 只证明：**自主循环 + 持久化 + Resume + Recover**。

生态集成留给 V0.5，能力更稳定后再说。

---

## 9. 演示脚本（CLI 一键）

```bash
# 准备 demo repo
./scripts/setup-demo-repo.sh

# 初始化 gollum
gollum init

# 创建 Goal
gollum goal create \
  --title "修复 demo-repo，使全部测试通过" \
  --project gollum-demo

# 创建 Outcome
gollum outcome create \
  --goal goal-001 \
  --title "所有测试 PASS" \
  --success-criteria "pytest 全部通过"

# 启动 worker（会触发 outcome-evaluate + 自动拆 Task）
gollum worker start

# 模拟进程崩溃
pkill -f gollum-worker

# 重启 worker，验证 resume
gollum worker start

# 查看进度
gollum outcome show outcome-001
# → status: IN_PROGRESS / VERIFIED
# → criteria: c1 [PASS]

# Demo 完成时
gollum goal show goal-001
# → status: achieved
```

---

## 10. 总结

> **V0.1 Minimal Demo = 本地 repo + 自动拆 Outcome/Task + 跨进程 Resume + Verify + Recover。**
> 不碰 GitHub，不碰 CI，不碰 Webhook。
> 这才是 Gollum 的核心命题。