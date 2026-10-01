/**
 * Workflow Store — SQLite (node:sqlite built-in) + WAL, CAS update, transactions
 *
 * Implements DESIGN.md §4 (data model), §6 (CAS/Lease), §7 (Scheduler query)
 *
 * Uses Node.js built-in node:sqlite (Node 22.5+), no native compilation needed.
 *
 * Conventions:
 * - All entities use ULID (string IDs)
 * - All entities have `version: number` for CAS
 * - All entities have `created_at` / `updated_at` (ISO8601)
 * - Mutations that change version MUST go through `casUpdate()`
 * - Reads can be raw queries
 */

import { DatabaseSync } from 'node:sqlite';
import { ulid } from 'ulid';
import { existsSync, mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';

// =============================================================================
// Errors
// =============================================================================

export class StateConflictError extends Error {
  readonly kind = 'STATE_CONFLICT' as const;
  readonly retryable = true;

  constructor(
    public readonly resource: string,
    public readonly currentVersion: number,
    public readonly expectedVersion: number,
  ) {
    super(
      `CAS conflict on ${resource}: expected version ${expectedVersion}, current ${currentVersion}`,
    );
  }
}

export class NotFoundError extends Error {
  readonly kind = 'NOT_FOUND' as const;
  readonly retryable = false;

  constructor(public readonly resource: string, public readonly id: string) {
    super(`${resource} not found: ${id}`);
  }
}

// =============================================================================
// Store class
// =============================================================================

export class Store {
  private db: DatabaseSync;

  constructor(dbPath: string, migrationDir: string) {
    // Ensure parent directory exists
    const parent = dirname(dbPath);
    if (!existsSync(parent)) mkdirSync(parent, { recursive: true });

    this.db = new DatabaseSync(dbPath);

    // Apply PRAGMA for WAL mode (DESIGN §4.2)
    this.db.exec('PRAGMA journal_mode = WAL');
    this.db.exec('PRAGMA synchronous = NORMAL');
    this.db.exec('PRAGMA foreign_keys = ON');
    this.db.exec('PRAGMA busy_timeout = 5000');

    // Run migrations
    this.migrate(migrationDir);
  }

  private migrate(migrationDir: string): void {
    // Track applied migrations
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS _migrations (
        name TEXT PRIMARY KEY,
        applied_at TEXT NOT NULL
      );
    `);

    const appliedRows = this.db
      .prepare('SELECT name FROM _migrations')
      .all() as { name: string }[];
    const applied = new Set(appliedRows.map((r) => r.name));

    const files = readdirSync(migrationDir)
      .filter((f) => f.endsWith('.sql'))
      .sort();

    for (const file of files) {
      if (applied.has(file)) continue;
      const sql = readFileSync(resolve(migrationDir, file), 'utf-8');
      // Wrap each migration in a transaction
      this.db.exec('BEGIN');
      try {
        this.db.exec(sql);
        this.db
          .prepare('INSERT INTO _migrations (name, applied_at) VALUES (?, ?)')
          .run(file, new Date().toISOString());
        this.db.exec('COMMIT');
      } catch (e) {
        this.db.exec('ROLLBACK');
        throw e;
      }
    }
  }

  // ===========================================================================
  // CAS update (DESIGN §6.1)
  // ===========================================================================

  /**
   * Generic CAS update. Throws StateConflictError if version mismatch.
   * Always increments version and updates updated_at.
   */
  casUpdate<T extends { id: string; version: number; updated_at: string }>(
    table: string,
    id: string,
    expectedVersion: number,
    patch: Partial<Omit<T, 'id' | 'version' | 'created_at' | 'updated_at'>>,
  ): T {
    const now = new Date().toISOString();
    const setKeys = Object.keys(patch);
    if (setKeys.length === 0) {
      const row = this.tryGet<T>(table, id);
      if (!row) throw new NotFoundError(table, id);
      return row;
    }

    const setClause = setKeys.map((k) => `${k} = ?`).join(', ');
    const values = setKeys.map((k) => serializeValue((patch as any)[k]));
    const stmt = this.db.prepare(
      `UPDATE ${table}
       SET version = version + 1, updated_at = ?, ${setClause}
       WHERE id = ? AND version = ?`,
    );
    const result = stmt.run(now, ...values, id, expectedVersion);

    if (result.changes === 0) {
      const current = this.tryGet<{ version: number }>(table, id);
      if (!current) throw new NotFoundError(table, id);
      throw new StateConflictError(table, current.version, expectedVersion);
    }

    return this.get<T>(table, id);
  }

  /**
   * CAS update with retry + backoff + re-evaluate hook (DESIGN §6.2)
   *
   * Algorithm:
   *   1. reload latest state
   *   2. re-evaluate: derive fresh patch from latest state
   *   3. CAS attempt
   *   4. if StateConflict → jitter backoff 1–3s → retry ≤ 3
   *
   * reEvaluate is invoked on EVERY attempt (not only on conflict) so that
   * patches are always derived from the latest state — never naively replayed
   * (per DESIGN §6.2: "禁止简单拿原数据重试").
   */
  async casUpdateWithRetry<T extends { id: string; version: number; updated_at: string }>(
    table: string,
    id: string,
    initialPatch: Record<string, unknown>,
    reEvaluate: (latest: T, original: Record<string, unknown>) => Record<string, unknown>,
    maxRetries: number = 3,
  ): Promise<T> {
    let attempt = 0;
    let patch = initialPatch;

    while (attempt < maxRetries) {
      // 1. reload latest state
      const current = this.get<T>(table as any, id);

      // 2. re-evaluate based on latest state
      patch = reEvaluate(current, initialPatch);

      // 3. CAS attempt
      try {
        return this.casUpdate<T>(table, id, current.version, patch as any);
      } catch (err) {
        if (err instanceof StateConflictError) {
          attempt++;
          if (attempt >= maxRetries) {
            throw new StateConflictError(table, err.currentVersion, err.expectedVersion);
          }
          // 4. jitter backoff 1–3s before next attempt
          await sleep(jitter(1000, 3000));
        } else {
          throw err;
        }
      }
    }
    throw new Error('unreachable');
  }

  // ===========================================================================
  // Generic CRUD
  // ===========================================================================

  get<T>(table: string, id: string): T {
    const row = this.tryGet<T>(table, id);
    if (!row) throw new NotFoundError(table, id);
    return row;
  }

  tryGet<T>(table: string, id: string): T | null {
    const stmt = this.db.prepare(`SELECT * FROM ${table} WHERE id = ?`);
    const row = stmt.get(id) as T | undefined;
    return row ?? null;
  }

  list<T>(table: string, where: string = '1', params: unknown[] = []): T[] {
    const stmt = this.db.prepare(`SELECT * FROM ${table} WHERE ${where}`);
    return stmt.all(...(params as never[])) as T[];
  }

  // ===========================================================================
  // Event emission (append-only, DESIGN §12)
  // ===========================================================================

  emit(event: {
    event: string;
    task_id?: string | null;
    outcome_id?: string | null;
    goal_id?: string | null;
    actor?: string | null;
    payload?: Record<string, unknown> | null;
  }): {
    id: number;
    task_id: string | null;
    outcome_id: string | null;
    goal_id: string | null;
    event: string;
    actor: string | null;
    payload: Record<string, unknown> | null;
    timestamp: string;
  } {
    const stmt = this.db.prepare(`
      INSERT INTO events (task_id, outcome_id, goal_id, event, actor, payload, timestamp)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    const timestamp = new Date().toISOString();
    const result = stmt.run(
      event.task_id ?? null,
      event.outcome_id ?? null,
      event.goal_id ?? null,
      event.event,
      event.actor ?? null,
      event.payload ? JSON.stringify(event.payload) : null,
      timestamp,
    );
    return {
      id: Number(result.lastInsertRowid),
      task_id: event.task_id ?? null,
      outcome_id: event.outcome_id ?? null,
      goal_id: event.goal_id ?? null,
      event: event.event,
      actor: event.actor ?? null,
      payload: event.payload ?? null,
      timestamp,
    };
  }

  // ===========================================================================
  // Direct DB access (for advanced queries, transactions)
  // ===========================================================================

  transaction<T>(fn: () => T): T {
    this.db.exec('BEGIN');
    try {
      const result = fn();
      this.db.exec('COMMIT');
      return result;
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
  }

  raw(): DatabaseSync {
    return this.db;
  }

  close(): void {
    this.db.close();
  }
}

// =============================================================================
// Helpers
// =============================================================================

function jitter(min: number, max: number): number {
  return Math.floor(min + Math.random() * (max - min));
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function serializeValue(v: unknown): string | number | null {
  if (v === undefined) return null;
  if (v === null) return null;
  if (Array.isArray(v) || (typeof v === 'object' && v !== null && !(v instanceof Date))) {
    return JSON.stringify(v);
  }
  if (typeof v === 'number' || typeof v === 'string') return v;
  return String(v);
}

// =============================================================================
// Singleton (CLI-friendly)
// =============================================================================

let _store: Store | null = null;

// Resolve migrations relative to this module's location. When gollum is run via
// `npm link` from any cwd, this points at the installed package's migrations
// instead of the user's cwd (which would ENOENT). Falls back to a local
// `./src/workflow/store/migrations` path when run in-place from the source repo.
function resolveDefaultMigrationDir(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    resolve(here, 'migrations'),                              // dist/workflow/store/store.js → dist/workflow/store/migrations
    resolve(here, '../../src/workflow/store/migrations'),    // src layout
    resolve(process.cwd(), 'src/workflow/store/migrations'), // dev fallback (cwd = repo root)
  ];
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  return candidates[0]!; // throw with the most informative path
}

export function resolveDefaultDbPath(): string {
  if (process.env.GOLLUM_DB_PATH) return process.env.GOLLUM_DB_PATH;
  // Default: XDG_DATA_HOME-aware global location. Same DB from any cwd after install.
  const xdg = process.env.XDG_DATA_HOME ?? join(homedir(), '.local', 'share');
  return join(xdg, 'gollum', 'gollum.db');
}

export function getStore(): Store {
  if (!_store) {
    const dbPath = resolveDefaultDbPath();
    const migrationDir =
      process.env.GOLLUM_MIGRATION_DIR ?? resolveDefaultMigrationDir();
    _store = new Store(resolve(dbPath), resolve(migrationDir));
  }
  return _store;
}

export function resetStore(): void {
  if (_store) {
    _store.close();
    _store = null;
  }
}

// Re-export for convenience
export { ulid };