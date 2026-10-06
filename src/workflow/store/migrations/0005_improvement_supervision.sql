CREATE TABLE improvement_watchers (
  id TEXT PRIMARY KEY REFERENCES improvement_runs(id),
  owner TEXT,
  lease_until_ms INTEGER,
  generation INTEGER NOT NULL DEFAULT 0,
  restarts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  version INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
