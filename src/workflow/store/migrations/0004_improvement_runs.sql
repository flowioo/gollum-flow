CREATE TABLE improvement_runs (
  id TEXT PRIMARY KEY,
  config TEXT NOT NULL,
  workspace TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'running' CHECK(status IN ('running','waiting','stopped','completed','failed')),
  phase TEXT NOT NULL DEFAULT 'baseline',
  iteration INTEGER NOT NULL DEFAULT 0,
  failures INTEGER NOT NULL DEFAULT 0,
  spent_usd REAL NOT NULL DEFAULT 0 CHECK(spent_usd >= 0),
  reserved_usd REAL NOT NULL DEFAULT 0 CHECK(reserved_usd >= 0),
  deadline_ms INTEGER NOT NULL,
  wake_ms INTEGER,
  owner TEXT,
  lease_until_ms INTEGER,
  generation INTEGER NOT NULL DEFAULT 0,
  stop_requested INTEGER NOT NULL DEFAULT 0,
  checkpoint TEXT NOT NULL DEFAULT '{}',
  version INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE improvement_calls (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES improvement_runs(id),
  iteration INTEGER NOT NULL,
  stage TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('started','finished','interrupted')),
  reserved_usd REAL NOT NULL,
  result TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX improvement_calls_run ON improvement_calls(run_id, iteration);
