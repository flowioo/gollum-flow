-- =============================================================================
-- Gollum V0.1 Initial Schema (9 tables)
-- =============================================================================
-- Based on DESIGN.md §4
-- See also PRD.md 七层语义模型
-- =============================================================================

-- projects
CREATE TABLE IF NOT EXISTS projects (
  id          TEXT PRIMARY KEY,        -- ULID
  name        TEXT NOT NULL UNIQUE,
  description TEXT,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);

-- goals
CREATE TABLE IF NOT EXISTS goals (
  id          TEXT PRIMARY KEY,
  project_id  TEXT NOT NULL,
  title       TEXT NOT NULL,
  description TEXT,
  status      TEXT NOT NULL CHECK (status IN ('active', 'achieved', 'abandoned')),
  version     INTEGER NOT NULL DEFAULT 1,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL,
  FOREIGN KEY (project_id) REFERENCES projects(id)
);

CREATE INDEX IF NOT EXISTS idx_goals_project ON goals(project_id);
CREATE INDEX IF NOT EXISTS idx_goals_status ON goals(status);

-- outcomes
CREATE TABLE IF NOT EXISTS outcomes (
  id            TEXT PRIMARY KEY,
  goal_id       TEXT NOT NULL,
  title         TEXT NOT NULL,
  status        TEXT NOT NULL CHECK (status IN ('NOT_STARTED', 'IN_PROGRESS', 'BLOCKED', 'VERIFIED', 'FAILED')),
  criteria_ids  TEXT NOT NULL DEFAULT '[]',  -- JSON list of criterion ids
  priority      INTEGER NOT NULL DEFAULT 0,
  version       INTEGER NOT NULL DEFAULT 1,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL,
  FOREIGN KEY (goal_id) REFERENCES goals(id)
);

CREATE INDEX IF NOT EXISTS idx_outcomes_goal ON outcomes(goal_id);
CREATE INDEX IF NOT EXISTS idx_outcomes_status ON outcomes(status);

-- criteria
CREATE TABLE IF NOT EXISTS criteria (
  id                  TEXT PRIMARY KEY,
  outcome_id          TEXT NOT NULL,
  description         TEXT NOT NULL,
  verifier            TEXT,                    -- JSON VerifierSpec | null
  latest_evidence_id  TEXT,
  derived_status      TEXT NOT NULL DEFAULT 'UNVERIFIED' CHECK (derived_status IN ('UNVERIFIED', 'PASS', 'FAIL', 'UNKNOWN')),
  version             INTEGER NOT NULL DEFAULT 1,
  created_at          TEXT NOT NULL,
  updated_at          TEXT NOT NULL,
  FOREIGN KEY (outcome_id) REFERENCES outcomes(id)
);

CREATE INDEX IF NOT EXISTS idx_criteria_outcome ON criteria(outcome_id);
CREATE INDEX IF NOT EXISTS idx_criteria_status ON criteria(derived_status);

-- tasks
CREATE TABLE IF NOT EXISTS tasks (
  id                  TEXT PRIMARY KEY,
  outcome_id          TEXT NOT NULL,           -- 强约束
  title               TEXT NOT NULL,
  status              TEXT NOT NULL CHECK (status IN ('PENDING', 'RUNNING', 'WAITING', 'BLOCKED', 'VERIFYING', 'RECOVERING', 'DONE', 'FAILED')),
  phase               TEXT,
  priority            INTEGER NOT NULL DEFAULT 0,
  acceptance_criteria TEXT NOT NULL DEFAULT '[]',
  alignment_verdict   TEXT NOT NULL DEFAULT 'uncertain' CHECK (alignment_verdict IN ('aligned', 'uncertain', 'misaligned')),
  alignment_reason    TEXT,
  owner               TEXT,
  lease_until         TEXT,
  wake_at             TEXT,
  retry_count         INTEGER NOT NULL DEFAULT 0,
  next_action         TEXT,
  summary             TEXT,
  last_observation    TEXT,
  estimated_minutes   INTEGER,                  -- Planner 估算，用于 >30min 强拆
  version             INTEGER NOT NULL DEFAULT 1,
  created_at          TEXT NOT NULL,
  updated_at          TEXT NOT NULL,
  FOREIGN KEY (outcome_id) REFERENCES outcomes(id)
);

CREATE INDEX IF NOT EXISTS idx_tasks_outcome ON tasks(outcome_id);
CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
CREATE INDEX IF NOT EXISTS idx_tasks_wake_at ON tasks(wake_at);
CREATE INDEX IF NOT EXISTS idx_tasks_lease ON tasks(lease_until);

-- executions
CREATE TABLE IF NOT EXISTS executions (
  id          TEXT PRIMARY KEY,
  task_id     TEXT NOT NULL,
  executor    TEXT NOT NULL,              -- codex | claude-code | workbuddy
  session_id  TEXT,
  started_at  TEXT NOT NULL,
  finished_at TEXT,
  result      TEXT CHECK (result IN ('PASS', 'FAIL', 'UNKNOWN')),
  error       TEXT,                        -- JSON
  retry_of    TEXT,
  FOREIGN KEY (task_id) REFERENCES tasks(id),
  FOREIGN KEY (retry_of) REFERENCES executions(id)
);

CREATE INDEX IF NOT EXISTS idx_executions_task ON executions(task_id);

-- evidences
CREATE TABLE IF NOT EXISTS evidences (
  id           TEXT PRIMARY KEY,
  criterion_id TEXT NOT NULL,
  executor     TEXT,
  status       TEXT NOT NULL CHECK (status IN ('PASS', 'FAIL', 'UNKNOWN')),
  data         TEXT,                       -- JSON
  observed_at  TEXT NOT NULL,
  FOREIGN KEY (criterion_id) REFERENCES criteria(id)
);

CREATE INDEX IF NOT EXISTS idx_evidences_criterion ON evidences(criterion_id);

-- events (append-only)
CREATE TABLE IF NOT EXISTS events (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id    TEXT,
  outcome_id TEXT,
  goal_id    TEXT,
  event      TEXT NOT NULL,
  actor      TEXT,
  payload    TEXT,                          -- JSON
  timestamp  TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_events_task ON events(task_id);
CREATE INDEX IF NOT EXISTS idx_events_outcome ON events(outcome_id);
CREATE INDEX IF NOT EXISTS idx_events_goal ON events(goal_id);
CREATE INDEX IF NOT EXISTS idx_events_event ON events(event);
CREATE INDEX IF NOT EXISTS idx_events_timestamp ON events(timestamp);

-- artifacts
CREATE TABLE IF NOT EXISTS artifacts (
  id          TEXT PRIMARY KEY,
  task_id     TEXT NOT NULL,
  type        TEXT NOT NULL,
  reference   TEXT NOT NULL,
  metadata    TEXT,
  created_at  TEXT NOT NULL,
  FOREIGN KEY (task_id) REFERENCES tasks(id)
);

CREATE INDEX IF NOT EXISTS idx_artifacts_task ON artifacts(task_id);

-- =============================================================================
-- Schema metadata
-- =============================================================================
CREATE TABLE IF NOT EXISTS schema_meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

INSERT OR IGNORE INTO schema_meta (key, value) VALUES ('version', '0001');
INSERT OR IGNORE INTO schema_meta (key, value) VALUES ('applied_at', datetime('now'));