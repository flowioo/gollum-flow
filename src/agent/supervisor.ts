/**
 * Process Supervisor
 *
 * Long-running coding agent = Long-running process. Process dies → agent dies.
 * But we want 24/7. So we wrap everything in a supervisor that:
 *
 *   1. Spawns a worker (the agent loop)
 *   2. Watches the worker's heartbeat via SQLite
 *   3. If worker dies (heartbeat stale > threshold) → kill, restart
 *   4. Bounded restart with exponential backoff to avoid crash loops
 *   5. PID-file based discovery (so multiple supervisors don't fight)
 *
 * Architecture:
 *
 *   Parent (gollum supervisor start)
 *     ↓ spawns
 *   Child (gollum supervisor run-loop)  ← writes heartbeat every N seconds
 *     ↓ (if dies)
 *   Parent detects stale heartbeat → kill -9 + restart
 *
 * Usage:
 *
 *   # Foreground (dev):
 *   gollum supervisor start
 *
 *   # Detached (24/7):
 *   gollum supervisor start --detach
 *
 *   # Check status:
 *   gollum supervisor status
 *
 *   # Stop:
 *   gollum supervisor stop
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, unlinkSync, mkdirSync, createWriteStream } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { hostname } from 'node:os';
import { getStore as getStoreUncached, type Store } from '../workflow/store/store.js';
import {
  supervisorHealth,
  recordRestart,
} from './heartbeat.js';

// =============================================================================
// Paths
// =============================================================================

export interface SupervisorPaths {
  /** SQLite DB for cross-process communication */
  dbPath: string;
  /** PID file for parent supervisor */
  parentPidFile: string;
  /** PID file for worker */
  workerPidFile: string;
  /** Log file for parent supervisor */
  logFile: string;
  /** Log file for worker */
  workerLogFile: string;
}

export function defaultSupervisorPaths(dbPath: string): SupervisorPaths {
  const dir = dirname(resolve(dbPath));
  const logDir = join(dir, 'logs');
  if (!existsSync(logDir)) mkdirSync(logDir, { recursive: true });

  return {
    dbPath: resolve(dbPath),
    parentPidFile: join(dir, 'supervisor.parent.pid'),
    workerPidFile: join(dir, 'supervisor.worker.pid'),
    logFile: join(logDir, 'supervisor.log'),
    workerLogFile: join(logDir, 'worker.log'),
  };
}

// =============================================================================
// PID file helpers
// =============================================================================

/** POSIX reserves pid -1 and 0 as broadcast/invalid; never treat them as a live worker. */
function isValidPid(pid: number | null | undefined): pid is number {
  return pid !== null && pid !== undefined && Number.isSafeInteger(pid) && pid > 0;
}

function readPidFile(path: string): number | null {
  if (!existsSync(path)) return null;
  try {
    const content = readFileSync(path, 'utf-8').trim();
    const pid = parseInt(content, 10);
    // Reject a pid file left behind by an earlier version that persisted a sentinel.
    return isValidPid(pid) ? pid : null;
  } catch {
    return null;
  }
}

function writePidFile(path: string, pid: number): void {
  if (!isValidPid(pid)) { clearPidFile(path); return; }
  writeFileSync(path, String(pid) + '\n');
}

function clearPidFile(path: string): void {
  try {
    if (existsSync(path)) unlinkSync(path);
  } catch {
    // ignore
  }
}

/**
 * Check if a PID is alive (signal 0 — existence check, not actually sent).
 */
function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e: any) {
    if (e.code === 'ESRCH') return false; // process doesn't exist
    if (e.code === 'EPERM') return true;  // exists but we can't signal
    return false;
  }
}

// =============================================================================
// Parent Supervisor: watches worker, restarts on death
// =============================================================================

export interface ParentSupervisorOptions {
  paths: SupervisorPaths;
  /** Spawn command (e.g. ['tsx', 'src/cli/index.ts', 'supervisor', 'run-loop']) */
  spawnCommand: string[];
  /** Env vars for spawned worker */
  spawnEnv?: Record<string, string>;
  /** How often to check worker health */
  checkIntervalMs?: number;
  /** Max consecutive restarts before giving up (default 5) */
  maxRestarts?: number;
  /** Initial backoff between restarts (ms). Doubles on each failure. */
  initialBackoffMs?: number;
  /** Max backoff between restarts (ms). Caps exponential growth. */
  maxBackoffMs?: number;
  /** Log function (defaults to console.log) */
  log?: (msg: string) => void;
}

export class ParentSupervisor {
  private worker: ChildProcess | null = null;
  private currentBackoffMs: number;
  private consecutiveRestarts = 0;
  private stopping = false;
  private checking = false;
  private spawnedAt = 0;
  private checkTimer: NodeJS.Timeout | null = null;
  private store: Store;

  constructor(private opts: ParentSupervisorOptions) {
    this.currentBackoffMs = opts.initialBackoffMs ?? 5_000;
    this.store = (opts as any).store; // optional: for direct DB access if needed
  }

  async start(): Promise<void> {
    // Write our own PID
    writePidFile(this.opts.paths.parentPidFile, process.pid);
    this.log(`parent supervisor started, pid=${process.pid}, db=${this.opts.paths.dbPath}`);

    // Start worker
    await this.spawnWorker('initial start');

    // Start check loop
    const interval = this.opts.checkIntervalMs ?? 5_000;
    this.checkTimer = setInterval(() => {
      if (this.checking) return;
      this.checking = true;
      void this.check().catch((e) => this.log(`watchdog error: ${e.message}`))
        .finally(() => { this.checking = false; });
    }, interval);

    // Graceful shutdown
    const stop = async (signal: string) => {
      this.log(`parent received ${signal}, stopping...`);
      await this.stop();
      process.exit(0);
    };
    process.on('SIGINT', () => stop('SIGINT'));
    process.on('SIGTERM', () => stop('SIGTERM'));

    // Keep alive
    await new Promise<void>(() => {});
  }

  private async spawnWorker(reason: string): Promise<void> {
    this.log(`spawning worker (reason: ${reason})`);

    // Spawn detached so we can kill the whole group
    const child = spawn(this.opts.spawnCommand[0]!, this.opts.spawnCommand.slice(1), {
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, ...(this.opts.spawnEnv ?? {}), GOLLUM_DB_PATH: this.opts.paths.dbPath },
    });

    // Capture logs to file
    if (child.stdout) {
      const out = createWriteStream(this.opts.paths.workerLogFile, { flags: 'a' });
      child.stdout.pipe(out);
    }
    if (child.stderr) {
      const err = createWriteStream(this.opts.paths.workerLogFile, { flags: 'a' });
      child.stderr.pipe(err);
    }

    child.on('exit', (code, signal) => {
      if (this.stopping) return;
      this.log(`worker exited (code=${code} signal=${signal})`);
      this.worker = null;
    });

    child.on('error', (error) => {
      this.log(`worker spawn failed: ${error.message}`);
      if (this.worker === child) this.worker = null;
      // A failed spawn has no pid; leaving the previous file behind would strand a
      // stale pid that a later `supervisor stop` signals.
      clearPidFile(this.opts.paths.workerPidFile);
    });
    this.worker = child;
    this.spawnedAt = Date.now();
    writePidFile(this.opts.paths.workerPidFile, child.pid ?? 0);
    // Spawn is not proof of health; reset only after a stable run.
  }

  private async check(): Promise<void> {
    if (this.stopping) return;

    const health = supervisorHealth(this.store ?? (getStoreUncached()));

    const alive = isValidPid(this.worker?.pid) && isPidAlive(this.worker.pid);
    const uptime = Date.now() - this.spawnedAt;
    if (alive && uptime < 30000) return; // startup grace
    if (alive && health.status === 'running') {
      // Worker is alive (or just barely alive). Reset backoff.
      if (uptime < 60000) return;
      this.consecutiveRestarts = 0;
      this.currentBackoffMs = this.opts.initialBackoffMs ?? 5_000;
      return;
    }

    // Unexpected child exit must restart even if its last DB state was stopped.

    // status === 'dead'
    const maxRestarts = this.opts.maxRestarts ?? 5;
    if (this.consecutiveRestarts >= maxRestarts) {
      this.log(`worker died ${this.consecutiveRestarts} times in a row, giving up`);
      this.log(`this usually means a real bug. check ${this.opts.paths.workerLogFile}`);
      await this.stop();
      process.exit(1);
    }

    this.consecutiveRestarts++;
    const maxBackoff = this.opts.maxBackoffMs ?? 60_000;
    const wait = Math.min(this.currentBackoffMs, maxBackoff);
    this.currentBackoffMs = Math.min(this.currentBackoffMs * 2, maxBackoff);

    this.log(`worker heartbeat stale ${Math.round(health.stale_for_ms / 1000)}s, restarting in ${wait / 1000}s (attempt ${this.consecutiveRestarts}/${maxRestarts})`);

    // Kill any lingering process
    if (isValidPid(this.worker?.pid)) {
      try { process.kill(this.worker.pid, 'SIGTERM'); } catch { /* already exited */ }
      try { process.kill(this.worker.pid, 'SIGKILL'); } catch { /* already exited */ }
    }
    const oldPid = readPidFile(this.opts.paths.workerPidFile);
    if (isValidPid(oldPid) && isPidAlive(oldPid)) {
      try { process.kill(oldPid, 'SIGKILL'); } catch { /* already exited */ }
    }

    await sleep(wait);
    if (this.stopping) return;

    await this.spawnWorker(`restart after stale heartbeat (${this.consecutiveRestarts}/${maxRestarts})`);

    // Record restart in DB
    try {
      const store = this.store ?? (getStoreUncached());
      recordRestart(store, {
        reason: `heartbeat stale ${Math.round(health.stale_for_ms / 1000)}s`,
        new_pid: this.worker?.pid,
      });
    } catch (e: any) {
      this.log(`failed to record restart: ${e.message}`);
    }
  }

  async stop(): Promise<void> {
    this.stopping = true;
    if (this.checkTimer) clearInterval(this.checkTimer);
    if (isValidPid(this.worker?.pid)) {
      try { process.kill(this.worker.pid, 'SIGTERM'); } catch { /* already exited */ }
      await sleep(2000);
      try { process.kill(this.worker.pid, 'SIGKILL'); } catch { /* already exited */ }
    }
    clearPidFile(this.opts.paths.parentPidFile);
    clearPidFile(this.opts.paths.workerPidFile);
  }

  private log(msg: string): void {
    const fn = this.opts.log ?? console.log;
    fn(`[parent ${new Date().toISOString()}] ${msg}`);
  }
}

// =============================================================================
// Standalone CLI commands
// =============================================================================

export interface SupervisorStatus {
  parent_pid: number | null;
  parent_alive: boolean;
  worker_pid: number | null;
  worker_alive: boolean;
  heartbeat_status: string;
  last_heartbeat_at: string | null;
  restart_count: number;
  started_at: string | null;
}

export function readSupervisorStatus(paths: SupervisorPaths, store: Store): SupervisorStatus {
  const parentPid = readPidFile(paths.parentPidFile);
  const workerPid = readPidFile(paths.workerPidFile);
  const health = supervisorHealth(store);

  return {
    parent_pid: parentPid,
    parent_alive: isValidPid(parentPid) && isPidAlive(parentPid),
    worker_pid: workerPid,
    worker_alive: isValidPid(workerPid) && isPidAlive(workerPid),
    heartbeat_status: health.status,
    last_heartbeat_at: health.last_heartbeat_at,
    restart_count: health.restart_count,
    started_at: health.started_at,
  };
}

/**
 * Send SIGTERM to the running supervisor (if any).
 * Returns: { stopped: boolean, parent_pid, worker_pid }
 */
export function stopSupervisor(paths: SupervisorPaths): { stopped: boolean; parent_pid: number | null; worker_pid: number | null } {
  let stoppedAnything = false;
  const parentPid = readPidFile(paths.parentPidFile);
  const workerPid = readPidFile(paths.workerPidFile);

  if (isValidPid(workerPid) && isPidAlive(workerPid)) {
    try { process.kill(workerPid, 'SIGTERM'); stoppedAnything = true; } catch { /* already exited */ }
  }
  if (isValidPid(parentPid) && isPidAlive(parentPid)) {
    try { process.kill(parentPid, 'SIGTERM'); stoppedAnything = true; } catch { /* already exited */ }
  }

  // Clear pid files after a delay (let processes exit cleanly first)
  setTimeout(() => {
    clearPidFile(paths.parentPidFile);
    clearPidFile(paths.workerPidFile);
  }, 2000);

  return { stopped: stoppedAnything, parent_pid: parentPid, worker_pid: workerPid };
}

// =============================================================================
// helpers
// =============================================================================

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// Re-export hostname for callers
export { hostname };
