-- =============================================================================
-- Gollum V0.2 Migration: Agent Self-Evolution Layer
-- =============================================================================
-- Adds:
--   1. quota_state         — track API quota exhaustion (5hr auto-recovery)
--   2. supervisor_state    — track supervisor PID + last heartbeat
--   3. task.heartbeat_at   — per-task heartbeat for watchdog
--   4. task.worker_pid     — which worker process owns this task
-- =============================================================================

-- ---------------------------------------------------------------------------
-- 1. quota_state: singleton row tracking current API quota status
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS quota_state (
  id              INTEGER PRIMARY KEY CHECK (id = 1),  -- enforces singleton
  status          TEXT NOT NULL DEFAULT 'ok'
                  CHECK (status IN ('ok', 'exhausted', 'recovering')),
  provider        TEXT,                                 -- 'codex' | 'claude-code' | 'openai'
  exhausted_at    TEXT,                                 -- when quota hit
  recovery_at     TEXT,                                 -- when quota expected to recover
  error_message   TEXT,                                 -- captured error
  hit_count       INTEGER NOT NULL DEFAULT 0,           -- how many times hit quota
  updated_at      TEXT NOT NULL
);

INSERT OR IGNORE INTO quota_state (id, status, updated_at)
VALUES (1, 'ok', datetime('now'));

CREATE INDEX IF NOT EXISTS idx_quota_state_status ON quota_state(status);

-- ---------------------------------------------------------------------------
-- 2. supervisor_state: track the supervisor process for restart-on-crash
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS supervisor_state (
  id                  INTEGER PRIMARY KEY CHECK (id = 1),
  pid                 INTEGER,                          -- process id of supervisor
  started_at          TEXT,                             -- when supervisor started
  last_heartbeat_at   TEXT,                             -- last watchdog heartbeat
  restart_count       INTEGER NOT NULL DEFAULT 0,       -- how many times restarted
  last_restart_at     TEXT,                             -- when last restarted
  last_restart_reason TEXT,                             -- why restarted
  status              TEXT NOT NULL DEFAULT 'stopped'
                      CHECK (status IN ('stopped', 'running', 'dead', 'paused')),
  updated_at          TEXT NOT NULL
);

INSERT OR IGNORE INTO supervisor_state (id, status, updated_at)
VALUES (1, 'stopped', datetime('now'));

-- ---------------------------------------------------------------------------
-- 3. task heartbeat: when a worker last touched this task
-- ---------------------------------------------------------------------------
-- Add columns if they don't exist (idempotent migration).
-- SQLite ALTER TABLE doesn't support IF NOT EXISTS for columns until 3.35+,
-- so we use a try/catch pattern via separate statements.
ALTER TABLE tasks ADD COLUMN heartbeat_at TEXT;
ALTER TABLE tasks ADD COLUMN worker_pid INTEGER;
ALTER TABLE tasks ADD COLUMN worker_host TEXT;  -- hostname for multi-machine

CREATE INDEX IF NOT EXISTS idx_tasks_heartbeat ON tasks(heartbeat_at);
CREATE INDEX IF NOT EXISTS idx_tasks_worker_pid ON tasks(worker_pid);

-- ---------------------------------------------------------------------------
-- 4. agent_runs: audit log of agent run cycles (one row per scheduler tick batch)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS agent_runs (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  started_at      TEXT NOT NULL,
  finished_at     TEXT,
  cycle_kind      TEXT NOT NULL,       -- 'tick' | 'recover' | 'restart' | 'quota_resume'
  status          TEXT NOT NULL,       -- 'running' | 'completed' | 'failed'
  picked_tasks    INTEGER DEFAULT 0,
  released_tasks  INTEGER DEFAULT 0,
  failed_tasks    INTEGER DEFAULT 0,
  duration_ms     INTEGER,
  error           TEXT,
  metadata        TEXT                 -- JSON
);

CREATE INDEX IF NOT EXISTS idx_agent_runs_started ON agent_runs(started_at);
CREATE INDEX IF NOT EXISTS idx_agent_runs_status ON agent_runs(status);

-- ---------------------------------------------------------------------------
-- 5. Update schema_meta
-- ---------------------------------------------------------------------------
INSERT OR REPLACE INTO schema_meta (key, value) VALUES ('version', '0002');
INSERT OR REPLACE INTO schema_meta (key, value) VALUES ('applied_at', datetime('now'));
