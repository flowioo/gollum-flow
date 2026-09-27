# Gollum — 技术方案（Technical Design Document）

> **版本**：V0.1 收敛版
> **面向**：实现工程师 / 架构师
> **状态**：可执行

---

## 1. 总体架构

### 1.1 系统图

```
                     Trigger Layer
                 ┌──────────────────┐
                 │ Timer            │
                 │ WakeCondition    │
                 │ Human (CLI)      │
                 └────────┬─────────┘
                          │
                          ▼
                 ┌──────────────────┐
                 │ Workflow Manager │
                 │  (Scheduler)     │
                 └────────┬─────────┘
                          │
                    load / claim
                          │
                          ▼
                ┌─────────────────────┐
                │ Agent Host          │
                │ (Codex CLI V0.1)    │
                │ (Claude Code V0.5)  │
                │ (WorkBuddy   V1)    │
                └──────────┬──────────┘
                           │
                         Skills (6 Core)
                           │
                           ▼
                ┌─────────────────────┐
                │ Gollum Skills       │
                │                     │
                │ task-run            │
                │ task-resume         │
                │ verify              │
                │ recover             │
                │ outcome-evaluate    │
                │ goal-align          │
                └──────────┬──────────┘
                           │
                          MCP (stdio)
                           │
                           ▼
                ┌─────────────────────┐
                │ Gollum Tools        │
                │                     │
                │ task.*              │
                │ outcome.*           │
                │ goal.*              │
                │ criterion.*         │
                │ evidence.*          │
                │ verify.*            │
                └──────────┬──────────┘
                           │
                           ▼
                ┌─────────────────────┐
                │ Workflow Store      │
                │ (SQLite + WAL)      │
                │                     │
                │ projects            │
                │ goals               │
                │ outcomes            │
                │ criteria            │
                │ tasks               │
                │ executions          │
                │ evidences           │
                │ events              │
                └─────────────────────┘
```

### 1.2 数据流

**单向**：Trigger → Scheduler → Store → Host → Skill → Tool → Environment → Verify → Store

---

## 2. 14 个 V0.1 决策点

| # | 决策 | 拍板 |
|---|---|---|
| 1 | Host | **Codex CLI** |
| 2 | Workflow Store | **SQLite + WAL** |
| 3 | CLI 语言 | **TypeScript / Node** |
| 4 | MCP 实现 | **stdio 模式**（复用社区方案） |
| 5 | Task ID | **ULID**（时间序 + 可排序） |
| 6 | Event Log | **append-only + 定期 checkpoint** |
| 7 | 默认 Lease | **15 min（Coding）** |
| 8 | CAS 冲突 | **reload + backoff 1-3s + re-evaluate + ≤3** |
| 9 | success_criteria 来源 | **用户/Planner 提供，CLI 做结构校验** |
| 10 | progress 数字 | **🔴 砍掉，改用状态机 + remaining_gap** |
| 11 | goal-align | **三级 aligned/uncertain/misaligned；misaligned 自处理不找人** |
| 12 | Outcome 数量上限 | **soft warning（≤7/≤5）** |
| 13 | Project 层 | **Schema 保留，CLI singleton** |
| 14 | Criterion 三段式 | **criterion → verifier → evidence** |

---

## 3. 项目结构

```
gollum/
│
├── skills/
│   └── core/
│       ├── task-run/SKILL.md
│       ├── task-resume/SKILL.md
│       ├── verify/SKILL.md
│       ├── recover/SKILL.md
│       ├── outcome-evaluate/SKILL.md
│       └── goal-align/SKILL.md
│
├── mcp/
│   └── core/
│       ├── task.ts        # 8 tools
│       ├── outcome.ts     # 5 tools
│       ├── goal.ts        # 5 tools
│       ├── criterion.ts   # 4 tools
│       ├── evidence.ts    # 2 tools
│       └── verify.ts      # verify.* tools
│
├── workflow/
│   ├── store/
│   │   ├── schema.sql    # 9 张表
│   │   ├── migrations/
│   │   └── store.ts
│   ├── scheduler/
│   │   ├── scheduler.ts  # 按 remaining_gap + priority 排序
│   │   └── policies.ts
│   └── model/
│       ├── state.ts      # 状态机
│       └── alignment.ts  # AlignmentVerdict
│
├── adapters/
│   └── codex/
│       └── installer.ts  # 安装 Skills + MCP + 启动参数
│
├── cli/
│   └── commands/
│
├── tests/
│
├── docs/
│   ├── PRD.md
│   └── DESIGN.md
│
└── package.json
```

---

## 4. 数据模型（SQLite Schema）

### 4.1 9 张表

```sql
-- ============================================================
-- projects
-- ============================================================
CREATE TABLE projects (
  id          TEXT PRIMARY KEY,        -- ULID
  name        TEXT NOT NULL,
  description TEXT,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);

-- ============================================================
-- goals
-- ============================================================
CREATE TABLE goals (
  id          TEXT PRIMARY KEY,        -- ULID
  project_id  TEXT NOT NULL,
  title       TEXT NOT NULL,
  description TEXT,
  status      TEXT NOT NULL,            -- active | achieved | abandoned
  version     INTEGER NOT NULL DEFAULT 1,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL,
  FOREIGN KEY (project_id) REFERENCES projects(id)
);

CREATE INDEX idx_goals_project ON goals(project_id);
CREATE INDEX idx_goals_status ON goals(status);

-- ============================================================
-- outcomes
-- ============================================================
CREATE TABLE outcomes (
  id            TEXT PRIMARY KEY,
  goal_id       TEXT NOT NULL,
  title         TEXT NOT NULL,
  status        TEXT NOT NULL,          -- NOT_STARTED | IN_PROGRESS | BLOCKED | VERIFIED | FAILED
  criteria_ids  TEXT NOT NULL DEFAULT '[]',  -- JSON list of criterion ids
  version       INTEGER NOT NULL DEFAULT 1,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL,
  FOREIGN KEY (goal_id) REFERENCES goals(id)
);

CREATE INDEX idx_outcomes_goal ON outcomes(goal_id);
CREATE INDEX idx_outcomes_status ON outcomes(status);

-- ============================================================
-- criteria
-- ============================================================
CREATE TABLE criteria (
  id                  TEXT PRIMARY KEY,
  outcome_id          TEXT NOT NULL,
  description         TEXT NOT NULL,
  verifier            TEXT,                    -- JSON VerifierSpec | null
  latest_evidence_id  TEXT,
  derived_status      TEXT NOT NULL DEFAULT 'UNVERIFIED',  -- UNVERIFIED | PASS | FAIL | UNKNOWN
  version             INTEGER NOT NULL DEFAULT 1,
  created_at          TEXT NOT NULL,
  updated_at          TEXT NOT NULL,
  FOREIGN KEY (outcome_id) REFERENCES outcomes(id),
  FOREIGN KEY (latest_evidence_id) REFERENCES evidences(id)
);

CREATE INDEX idx_criteria_outcome ON criteria(outcome_id);
CREATE INDEX idx_criteria_status ON criteria(derived_status);

-- ============================================================
-- tasks
-- ============================================================
CREATE TABLE tasks (
  id                  TEXT PRIMARY KEY,
  outcome_id          TEXT NOT NULL,           -- 强约束
  title               TEXT NOT NULL,
  status              TEXT NOT NULL,            -- PENDING | RUNNING | WAITING | BLOCKED | VERIFYING | DONE | FAILED | RECOVERING
  phase               TEXT,
  priority            INTEGER NOT NULL DEFAULT 0,
  acceptance_criteria TEXT NOT NULL DEFAULT '[]',   -- JSON list
  alignment_verdict   TEXT NOT NULL DEFAULT 'uncertain',  -- aligned | uncertain | misaligned
  alignment_reason    TEXT,
  owner               TEXT,
  lease_until         TEXT,
  wake_at             TEXT,
  retry_count         INTEGER NOT NULL DEFAULT 0,
  next_action         TEXT,
  summary             TEXT,
  last_observation    TEXT,
  version             INTEGER NOT NULL DEFAULT 1,
  created_at          TEXT NOT NULL,
  updated_at          TEXT NOT NULL,
  FOREIGN KEY (outcome_id) REFERENCES outcomes(id)
);

CREATE INDEX idx_tasks_outcome ON tasks(outcome_id);
CREATE INDEX idx_tasks_status ON tasks(status);
CREATE INDEX idx_tasks_wake_at ON tasks(wake_at);
CREATE INDEX idx_tasks_lease ON tasks(lease_until);

-- ============================================================
-- executions
-- ============================================================
CREATE TABLE executions (
  id          TEXT PRIMARY KEY,
  task_id     TEXT NOT NULL,
  executor    TEXT NOT NULL,              -- codex | claude-code | workbuddy
  session_id  TEXT,                        -- trace only
  started_at  TEXT NOT NULL,
  finished_at TEXT,
  result      TEXT,                        -- PASS | FAIL | UNKNOWN
  error       TEXT,                        -- JSON ToolResult.error
  retry_of    TEXT,                        -- execution_id for retry chain
  FOREIGN KEY (task_id) REFERENCES tasks(id),
  FOREIGN KEY (retry_of) REFERENCES executions(id)
);

CREATE INDEX idx_executions_task ON executions(task_id);

-- ============================================================
-- evidences
-- ============================================================
CREATE TABLE evidences (
  id           TEXT PRIMARY KEY,
  criterion_id TEXT NOT NULL,
  executor     TEXT,                       -- codex/session-xxx
  status       TEXT NOT NULL,              -- PASS | FAIL | UNKNOWN
  data         TEXT,                       -- JSON
  observed_at  TEXT NOT NULL,
  FOREIGN KEY (criterion_id) REFERENCES criteria(id)
);

CREATE INDEX idx_evidences_criterion ON evidences(criterion_id);

-- ============================================================
-- events (append-only)
-- ============================================================
CREATE TABLE events (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id    TEXT,
  outcome_id TEXT,
  goal_id    TEXT,
  event      TEXT NOT NULL,
  actor      TEXT,                          -- codex/session-123
  payload    TEXT,                          -- JSON
  timestamp  TEXT NOT NULL
);

CREATE INDEX idx_events_task ON events(task_id);
CREATE INDEX idx_events_outcome ON events(outcome_id);
CREATE INDEX idx_events_goal ON events(goal_id);
CREATE INDEX idx_events_event ON events(event);
CREATE INDEX idx_events_timestamp ON events(timestamp);

-- ============================================================
-- artifacts
-- ============================================================
CREATE TABLE artifacts (
  id          TEXT PRIMARY KEY,
  task_id     TEXT NOT NULL,
  type        TEXT NOT NULL,                -- file | pr | url | screenshot
  reference   TEXT NOT NULL,
  metadata    TEXT,                          -- JSON
  created_at  TEXT NOT NULL,
  FOREIGN KEY (task_id) REFERENCES tasks(id)
);
```

### 4.2 WAL 模式

```sql
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
PRAGMA foreign_keys = ON;
PRAGMA busy_timeout = 5000;
```

### 4.3 Outcome VERIFIED 触发器

```sql
-- 每次 evidence 更新时，重新评估所属 Criterion + Outcome
-- 在应用层实现，不在 SQLite 触发器中
```

---

## 5. 状态机实现

### 5.1 Task 状态机

```typescript
type TaskStatus =
  | "PENDING"
  | "RUNNING"
  | "WAITING"
  | "BLOCKED"
  | "VERIFYING"
  | "RECOVERING"
  | "DONE"
  | "FAILED";

const taskTransitions: Record<TaskStatus, TaskStatus[]> = {
  PENDING:    ["RUNNING", "BLOCKED"],
  RUNNING:    ["WAITING", "BLOCKED", "VERIFYING", "RECOVERING", "DONE", "FAILED"],
  WAITING:    ["RUNNING"],
  BLOCKED:    ["RUNNING"],
  VERIFYING:  ["DONE", "RECOVERING", "FAILED"],
  RECOVERING: ["RUNNING", "FAILED"],
  DONE:       [],
  FAILED:     []
};
```

### 5.2 Outcome 状态机

```typescript
type OutcomeStatus =
  | "NOT_STARTED"
  | "IN_PROGRESS"
  | "BLOCKED"
  | "VERIFIED"
  | "FAILED";

const outcomeTransitions: Record<OutcomeStatus, OutcomeStatus[]> = {
  NOT_STARTED: ["IN_PROGRESS"],
  IN_PROGRESS: ["VERIFIED", "FAILED", "BLOCKED"],
  BLOCKED:     ["IN_PROGRESS"],
  VERIFIED:    ["IN_PROGRESS"],  // 极少见：Goal 调整
  FAILED:      ["IN_PROGRESS"]   // 极少见：Goal 调整
};

// Outcome 自动 VERIFIED 评估
function evaluateOutcomeStatus(outcomeId: string): OutcomeStatus {
  const criteria = store.criterion.list(outcomeId);
  const allPass = criteria.every(c => c.derived_status === "PASS");
  if (allPass) return "VERIFIED";
  if (outcome.status === "VERIFIED" || outcome.status === "FAILED") return outcome.status;
  return "IN_PROGRESS";
}
```

### 5.3 Criterion derived_status 自动推导

```typescript
function deriveCriterionStatus(criterion: Criterion, evidence: Evidence | null): CriterionStatus {
  if (!criterion.verifier) return "UNVERIFIED";
  if (!evidence) return "UNVERIFIED";
  if (evidence.status === "PASS") return "PASS";
  if (evidence.status === "FAIL") return "FAIL";
  return "UNKNOWN";
}

// attach_evidence 后自动调用
function attachEvidence(criterionId: string, evidence: Evidence): void {
  store.evidence.create(evidence);
  store.criterion.update(criterionId, {
    latest_evidence_id: evidence.id,
    derived_status: deriveCriterionStatus(...)
  });
  // 触发 Outcome 重新评估
  const outcome = store.outcome.get(criterion.outcome_id);
  const newStatus = evaluateOutcomeStatus(outcome.id);
  if (newStatus !== outcome.status) {
    store.outcome.update(outcome.id, { status: newStatus });
  }
}
```

---

## 6. CAS / Lease 实现

### 6.1 CAS Update

```typescript
async function casUpdate<T>(
  table: string,
  id: string,
  expectedVersion: number,
  patch: Partial<T>
): Promise<T> {
  return await db.transaction(async (tx) => {
    const current = await tx.get(`${table} WHERE id = ?`, id);
    if (current.version !== expectedVersion) {
      throw new StateConflictError({
        current_version: current.version,
        expected_version: expectedVersion,
        resource: `${table}:${id}`
      });
    }
    const updated = { ...current, ...patch, version: current.version + 1 };
    await tx.update(table, id, updated);
    return updated;
  });
}
```

### 6.2 CAS 冲突处理

```typescript
async function casUpdateWithRetry<T>(
  table: string,
  id: string,
  initialPatch: Partial<T>,
  maxRetries: number = 3
): Promise<T> {
  let attempt = 0;
  let patch = initialPatch;
  while (attempt < maxRetries) {
    try {
      const current = await store.get(table, id);
      return await casUpdate(table, id, current.version, patch);
    } catch (err) {
      if (err instanceof StateConflictError) {
        attempt++;
        if (attempt >= maxRetries) {
          await store.task.block(id, {
            reason: "cas_thrashing",
            attempts: attempt
          });
          throw err;
        }
        // 退避 + reload + re-evaluate
        await sleep(jitter(1000, 3000));  // 1-3s
        const latest = await store.get(table, id);
        patch = reEvaluate(latest, patch);  // 基于最新 state 重新 Decide
      } else {
        throw err;
      }
    }
  }
}

function jitter(min: number, max: number): number {
  return Math.floor(min + Math.random() * (max - min));
}
```

### 6.3 Lease 实现

```typescript
async function claimTask(taskId: string, owner: string): Promise<void> {
  const leaseDuration = 15 * 60 * 1000;  // 15 min for Coding
  const leaseUntil = new Date(Date.now() + leaseDuration).toISOString();
  await casUpdate("tasks", taskId, current.version, {
    owner,
    lease_until: leaseUntil,
    status: "RUNNING"
  });
}

async function releaseLease(taskId: string): Promise<void> {
  await casUpdate("tasks", taskId, current.version, {
    owner: null,
    lease_until: null
  });
}

// Scheduler 检测 lease 过期
async function findExpiredLeases(): Promise<Task[]> {
  return await db.query(`
    SELECT * FROM tasks
    WHERE status = 'RUNNING'
      AND lease_until IS NOT NULL
      AND lease_until < datetime('now')
  `);
}
```

### 6.4 Lease 时长建议

| 场景 | Lease |
|---|---|
| Coding Agent | 15 min |
| Phone Agent | 5 min |
| Robot Agent | 2 min |

---

## 7. Scheduler 实现

### 7.1 调度算法

```sql
-- 找出 wakeable Task，按 Outcome.remaining_gap + priority 排序
SELECT t.*
FROM tasks t
JOIN outcomes o ON t.outcome_id = o.id
WHERE t.status = 'WAITING'
  AND t.wake_at <= datetime('now')
  AND (t.lease_until IS NULL OR t.lease_until < datetime('now'))
  AND o.status = 'IN_PROGRESS'
ORDER BY
  o.priority DESC,
  (
    SELECT COUNT(*) FROM criteria c
    WHERE c.outcome_id = o.id
      AND c.derived_status != 'PASS'
  ) DESC,
  t.priority DESC,
  t.created_at ASC
LIMIT 1
```

### 7.2 调度依据（替代 progress）

```
1. status == IN_PROGRESS（不做 VERIFIED / BLOCKED / FAILED）
2. priority 高
3. remaining_gap > 0
4. 没有 blocker
5. goal-align verdict == aligned
```

### 7.3 WakeCondition 实现

```typescript
interface WakeCondition {
  type: "timer" | "github_pr" | "ci_status";
  config: TimerConfig | GithubPRConfig | CIStatusConfig;
}

interface TimerConfig {
  fire_at: string;  // ISO8601
}

// V0.1 只实现 timer
class TimerWakeCondition {
  shouldWake(task: Task, condition: WakeCondition): boolean {
    if (condition.type !== "timer") return false;
    return new Date(condition.config.fire_at) <= new Date();
  }
}
```

---

## 8. Tool 接口（MCP stdio）

### 8.1 Task Tools（8 个）

```typescript
task.create({
  outcome_id: string,
  title: string,
  acceptance_criteria: string[],
  priority?: number
}) → Task

task.get(task_id) → Task + Outcome + Goal

task.claim(task_id, owner: string) → Task

task.update(task_id, expected_version: number, patch: Partial<Task>) → Task

task.checkpoint(task_id, checkpoint: {
  summary: string,
  observation: string,
  criteria_delta?: Record<string, {from: string, to: string}>,
  artifacts?: string[]
}) → Checkpoint

task.wait(task_id, wake_at: string, wake_condition?: WakeCondition) → Task
task.block(task_id, reason: string, context?: any) → Task
task.complete(task_id) → Task  // → DONE
task.fail(task_id, reason: string) → Task  // → FAILED
```

### 8.2 Outcome Tools（5 个）

```typescript
outcome.list_active(goal_id?: string) → Outcome[]
outcome.get(outcome_id) → Outcome + criteria[]
outcome.remaining_gap(outcome_id) → {
  total_criteria, pass_count, fail_count, unknown_count, unverified_count, remaining
}
outcome.update(outcome_id, expected_version, patch)
outcome.mark_verified(outcome_id)  // 校验所有 criteria PASS
outcome.mark_failed(outcome_id, reason)
outcome.block(outcome_id, reason)
```

### 8.3 Goal Tools（5 个）

```typescript
goal.list(project_id?: string) → Goal[]
goal.get(goal_id) → Goal + Outcomes[]
goal.create({ project_id, title, description }) → Goal
goal.update(goal_id, expected_version, patch)
goal.block(goal_id, reason)  // → Human
goal.achieve(goal_id)  // 所有 Outcome VERIFIED 后自动
```

### 8.4 Criterion Tools（4 个）

```typescript
criterion.create({
  outcome_id,
  description,
  verifier: VerifierSpec
}) → Criterion  // 没 verifier → UNVERIFIED

criterion.get(criterion_id) → Criterion + latest_evidence
criterion.list(outcome_id) → Criterion[]
criterion.attach_evidence(criterion_id, evidence: Evidence) → Criterion
```

### 8.5 Evidence Tools（2 个）

```typescript
evidence.create({
  criterion_id,
  executor,
  status: "PASS" | "FAIL" | "UNKNOWN",
  data: any
}) → Evidence

evidence.list(criterion_id) → Evidence[]
```

### 8.6 Verify Tools

```typescript
verify.command({
  command: string,
  cwd?: string,
  timeout?: number
}) → { status: "PASS" | "FAIL" | "UNKNOWN", evidence: any }

verify.git({
  type: "status" | "diff" | "log",
  repo?: string
}) → { status, evidence }

verify.outcome_criterion({
  criterion_id
}) → { status, evidence }  // 调用 Criterion.verifier
```

---

## 9. Skill 实现

### 9.1 6 Core Skills

| Skill | 性质 | 触发时机 |
|---|---|---|
| `task-run` | 执行 | 新 Task 首次执行 |
| `task-resume` | 执行 | 跨 Session 恢复 |
| `verify` | 执行 | Task 完成前 |
| `recover` | 执行 | 失败触发 |
| `outcome-evaluate` | 语义 | 每轮 Workflow 开头 + Task DONE 后 |
| `goal-align` | 语义 | 新建 Task 前 + Checkpoint 时 |

### 9.2 Skill Markdown 格式

```markdown
# Goal
# When to Use
# Inputs
# Tools
# Procedure
# Verification
# Recovery
# Completion
```

### 9.3 outcome-evaluate 伪代码

```python
def outcome_evaluate(outcome_id):
    outcome = store.outcome.get(outcome_id)
    criteria = store.criterion.list(outcome_id)

    result = {
        "outcome_id": outcome_id,
        "status": outcome.status,
        "remaining_gap": {
            "total": len(criteria),
            "pass": 0,
            "fail": 0,
            "unknown": 0,
            "unverified": 0,
            "remaining": 0
        },
        "needs_new_task": False,
        "reason": ""
    }

    for c in criteria:
        result["remaining_gap"][c.derived_status.lower()] += 1

    result["remaining_gap"]["remaining"] = (
        result["remaining_gap"]["fail"]
        + result["remaining_gap"]["unknown"]
        + result["remaining_gap"]["unverified"]
    )

    # 自动 VERIFIED 评估
    if all(c.derived_status == "PASS" for c in criteria):
        if outcome.status != "VERIFIED":
            store.outcome.mark_verified(outcome_id)
        result["needs_new_task"] = False
        result["reason"] = "all criteria PASS"
    elif any(c.derived_status == "UNVERIFIED" for c in criteria):
        result["needs_new_task"] = False
        result["reason"] = "criterion missing verifier, need to attach"
    else:
        result["needs_new_task"] = result["remaining_gap"]["remaining"] > 0
        result["reason"] = f"{result['remaining_gap']['remaining']} criteria not PASS"

    return result
```

### 9.4 goal-align 伪代码（三级版）

```python
def goal_align(task_id, outcome_id):
    task = store.task.get(task_id)
    outcome = store.outcome.get(outcome_id)
    goal = store.goal.get(outcome.goal_id)

    # 1. Evidence-based check (客观)
    objective_verdict = check_objective(task, outcome)

    # 2. LLM semantic check (主观)
    llm_verdict = llm_judge_alignment(task, outcome, goal)

    # 3. 取最保守
    if objective_verdict == "regression" or llm_verdict == "misaligned":
        verdict = "misaligned"
    elif objective_verdict == "aligned" and llm_verdict == "aligned":
        verdict = "aligned"
    else:
        verdict = "uncertain"

    return {
        "verdict": verdict,
        "reason": f"objective={objective_verdict}, llm={llm_verdict}",
        "confidence": 0.8
    }


def handle_misaligned(task_id):
    """misaligned → pause / rollback / backlog / 换 task。不找人。"""
    task = store.task.get(task_id)
    store.task.update(task_id, task.version, {"status": "PENDING"})
    store.event.create({
        "event": "TASK_REJECTED_MISALIGNED",
        "task_id": task_id,
        "payload": {"reason": "goal-align misaligned"}
    })
    # Scheduler 选下一个 Task
```

---

## 10. Agent Host Integration

### 10.1 Codex CLI 集成

```bash
# 启动 Codex with Gollum
codex \
  --skill-path ~/.gollum/skills \
  --mcp-server gollum-core \
  --task-id task-001 \
  --goal-context "$(gollum task get-context task-001)"
```

启动时：

1. Agent 第一动作：`task.get(task_id)` 拿到 Task + Outcome + Goal Context
2. 按 `task-resume` Skill 恢复
3. 先 `outcome-evaluate` → `goal-align` → 继续

### 10.2 安装脚本

```typescript
// adapters/codex/installer.ts
async function installCodexAdapter(): Promise<void> {
  // 1. 复制 Skills 到 Codex skill 目录
  await copySkills("~/.gollum/skills", "~/.codex/skills");
  // 2. 注册 MCP server
  await registerMCPServer("gollum-core", "stdio://gollum-mcp");
  // 3. 配置启动参数
  await configureStartup();
}
```

---

## 11. CLI 设计

```bash
# 初始化
gollum init

# 安装 Host
gollum install codex

# Project / Goal / Outcome / Criterion
gollum project create
gollum project list
gollum goal create --project project-001 --title "..."
gollum goal show goal-001
gollum outcome create \
  --goal goal-001 \
  --title "..." \
  --criteria '[{"description": "...", "verifier": {...}}]'
gollum outcome list
gollum outcome remaining-gap outcome-001

# Task / Execution
gollum task create \
  --outcome-id outcome-001 \
  --title "..." \
  --acceptance-criteria "..."
gollum task show task-001
gollum task run task-001
gollum task resume task-001
gollum task cancel task-001

# Worker / Scheduler
gollum worker start
gollum scheduler start

# 事件 / Evidence
gollum events list --task task-001
gollum evidence list --criterion c1
```

---

## 12. Event Log

### 12.1 事件类型

**Task 层**：

```
TASK_CREATED
TASK_CLAIMED
TASK_RESUMED
ACTION_STARTED
ACTION_COMPLETED
CHECKPOINT_CREATED
VERIFY_STARTED
VERIFY_PASSED
VERIFY_FAILED
RECOVERY_STARTED
TASK_WAITING
TASK_BLOCKED
TASK_COMPLETED
TASK_FAILED
```

**Outcome / Criterion / Goal 层**：

```
CRITERION_VERIFIED
CRITERION_FAILED
CRITERION_UNVERIFIED
OUTCOME_REMAINING_GAP_EVALUATED
OUTCOME_VERIFIED
OUTCOME_BLOCKED
OUTCOME_FAILED
GOAL_ALIGNMENT_CHECKED
TASK_REJECTED_MISALIGNED
GOAL_ACHIEVED
```

### 12.2 Event 写入

```typescript
async function emitEvent(event: Event): Promise<void> {
  await db.insert("events", {
    task_id: event.task_id,
    outcome_id: event.outcome_id,
    goal_id: event.goal_id,
    event: event.event,
    actor: event.actor,
    payload: JSON.stringify(event.payload),
    timestamp: new Date().toISOString()
  });
}
```

---

## 13. V0.1 范围

### 13.1 做

```
Workflow Store (SQLite + WAL)
  - 9 张表：projects/goals/outcomes/criteria/tasks/executions/evidences/events/artifacts
  - CAS Version + 退避重试链
  - Lease

Scheduler
  - 按 Outcome.status + remaining_gap + priority 排序

WakeCondition 抽象
  - timer 实现（V0.1 唯一需要）

Task Planner
  - 自动拆 Outcome / Task
  - 估算执行时间，> 30min 强制拆
  - 为 Criterion 自动绑定 Verifier

Task Event Log
  - 原事件 + Criterion/Outcome/Goal 层事件

6 Core Skills
  - task-run / task-resume / verify / recover
  - outcome-evaluate / goal-align（三级版）

24 Core Tools
  - task.* (8)
  - outcome.* (5)
  - goal.* (5)
  - criterion.* (4)
  - evidence.* (2)

Verify
  - command / git / outcome-criterion

Codex CLI Integration

V0.1 Minimal Demo
  - 本地 2-3 bug repo
  - 跨进程 Resume
  - Verify + Recover
  - goal-align misaligned 不找人
```

### 13.2 不做

```
❌ GitHub Issue / PR / CI 集成
❌ Webhook / Email / 文件触发
❌ Memory Evolution（自动归纳）
❌ Skill 自动生成
❌ Multi-Agent
❌ Distributed Scheduler
❌ Vector DB
❌ Robot / Android
❌ 复杂 DAG
❌ Workflow DSL
❌ outcome-decompose 自动拆 Task（V0.1 简单 Planner）
❌ goal-refine
❌ progress 数字（砍掉）
❌ 任何外部 SaaS 依赖
```

---

## 14. 实施路径（4 周）

```
W1: Workflow Store + 9 表 + 24 Tools + 6 Skills(三级) + Planner + Verifier 绑定
   → Demo 1 骨架

W2: Scheduler + WakeCondition(timer) + Codex 集成 + CAS/Lease
   → Demo 2（跨进程 Resume 基础）

W3: Verify 三态 + Recover + attach_evidence → 自动 VERIFIED Outcome
   → Demo 3（Failure Recovery）

W4: Goal Alignment 三级实战
   + misaligned → pause / rollback / 换 task（不找人）
   + 完整跑通 V0.1 Minimal Demo
   + 20-30 个真实 Coding Task 验证
```

每周末 commit 一次。

---

## 15. 风险防御

| 风险 | 防御 |
|---|---|
| Task 粒度过粗 | 五项硬性属性 + >30min 强制拆 |
| Task 与 Session 寿命绑定 | Task 按结果拆（独立 Verify / 重试 / 增量） |
| CAS 冲突 thrashing | reload + backoff + re-evaluate + ≤3 + cas_thrashing block |
| Checkpoint 膨胀 | 只存状态 + artifact refs + decision context + criteria_delta |
| Memory 错误归纳 | V0.1 不做自动归纳 |
| 生态集成失败 | V0.1 不碰 GitHub/CI/Webhook |
| progress 被 gaming | 🔴 砍掉 progress 数字 |
| Criterion 模糊 | verifier 绑定，没绑定 → UNVERIFIED |
| Outcome 拆太碎 | soft warning + 硬规则（独立 Verify） |
| 人类被打扰频繁 | Human Boundary：Human 只改边界，misaligned 自处理 |

---

## 16. 自主性指标（V0.1 验收）

| 指标 | 定义 | 目标 |
|---|---|---|
| Task Success Rate | 完成 / 总任务 | ↑ |
| Outcome VERIFIED Rate | Outcome 在指定时间内达到 VERIFIED | ↑ |
| Criterion DERIVED_PASS Rate | Criterion 派生 PASS 比例 | ↑ |
| False Completion Rate | 假完成比例 | ↓ |
| Criterion UNVERIFIED Rate | 没绑定 verifier 的 criterion 比例 | ↓ |
| Misaligned Pause Rate | misaligned → pause / 换 task 的比例（不找人） | ↑ |
| Recovery Rate | 失败后恢复比例 | ↑ |
| Human Intervention Count | 单 Outcome 平均介入次数 | ↓（V0.1 应该极少） |
| Cross-session Resume Success Rate | 跨 Session 恢复成功率 | ↑ |
| Token Cost | 单 Task token 消耗 | 不强制降 |
| Wall-clock Completion Time | 实际完成时长 | 越短越好 |

---

## 17. 与设计的关系

详见 [PRD.md](./PRD.md) — 业务视角的需求定义。

PRD 讲**做什么**，DESIGN 讲**怎么做**。两份文档互为补充：
- PRD 是 Agent Operator / 用户 视角
- DESIGN 是实现工程师视角

---

## 18. 一句话总结

> **V0.1 技术方案 = 9 表 SQLite + 6 Skills + 24 Tools + CAS/Lease + 三级 goal-align + Criterion 三段式。**
> **核心原则：Progress is not a number. Progress is verified state change.**
> **4 周路径，14 决策点全部拍板。**