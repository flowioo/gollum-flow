/**
 * 24/7 Main Loop
 *
 * The brain of the self-evolution layer.
 *
 * Lifecycle of one cycle:
 *   1. Watchdog tick:
 *      - Recover stuck tasks (heartbeat stale)
 *      - Check supervisor health (we ARE the supervisor in this process)
 *      - Check quota recovery (resume if 5hr passed)
 *   2. Scheduler tick:
 *      - Release expired leases
 *      - Pick next task(s)
 *      - Hand off to worker(s) — we don't execute here, just dispatch
 *   3. Adaptive sleep:
 *      - If quota exhausted AND recovery far away → long sleep (5min)
 *      - If no tasks ready + no quota issue → short sleep (10s)
 *      - If tasks ready → tick immediately again
 *
 * This loop is designed to run forever. To stop it cleanly, send SIGTERM/SIGINT.
 *
 * Usage (inside a child process spawned by parent supervisor):
 *
 *   const loop = new AgentLoop({ store, dbPath });
 *   loop.start(); // never returns; resolves only on shutdown
 */

import type { Store } from '../workflow/store/store.js';
import {
  schedulerTick,
  type SchedulePick,
} from '../workflow/scheduler/scheduler.js';
import {
  watchdogTick,
  supervisorHeartbeat,
  supervisorStart,
  supervisorStop,
} from './heartbeat.js';
import {
  canDispatch,
  getQuotaState,
  tickQuotaRecovery,
} from './quota.js';

// =============================================================================
// Constants
// =============================================================================

const FAST_POLL_MS = 5_000;          // tasks ready or quota recovering
const NORMAL_POLL_MS = 15_000;       // idle, waiting for work
const SLOW_POLL_MS = 60_000;         // no work, no quota issue
const QUOTA_RECOVERY_POLL_MS = 5 * 60_000;  // quota cooldown — wake every 5min to recheck
const HEARTBEAT_INTERVAL_MS = 10_000; // write own heartbeat every 10s

// =============================================================================
// Loop config
// =============================================================================

export interface AgentLoopOptions {
  store: Store;
  /** Run as worker (writes worker heartbeat) vs as supervisor (writes supervisor heartbeat). Default: worker. */
  mode?: 'worker' | 'supervisor';
  /** Hand-off function: called with each picked task. The handler is responsible for executing the task (e.g. via Claude Code). */
  dispatch?: (pick: SchedulePick) => Promise<void>;
  /** Override poll intervals (ms). */
  intervals?: {
    fast?: number;
    normal?: number;
    slow?: number;
    quota_recovery?: number;
    heartbeat?: number;
  };
  /** Log function */
  log?: (msg: string) => void;
  /** Force-stop predicate (e.g. from parent signal) */
  shouldStop?: () => boolean;
}

export interface CycleResult {
  cycle_started_at: string;
  cycle_finished_at: string;
  duration_ms: number;
  watchdog: {
    stuck_recovered: number;
    quota_recovered: boolean;
    quota_released_tasks: number;
  };
  scheduler: {
    picked: number;
    released_leases: number;
  };
  dispatched: number;
  dispatch_errors: number;
  next_sleep_ms: number;
}

// =============================================================================
// Agent Loop
// =============================================================================

export class AgentLoop {
  private stopping = false;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private store: Store;
  private dispatch?: (pick: SchedulePick) => Promise<void>;
  private log: (msg: string) => void;
  private shouldStop: () => boolean;
  private intervals: Required<NonNullable<AgentLoopOptions['intervals']>>;
  private mode: 'worker' | 'supervisor';
  private runId = 0;

  // Metrics
  private totalCycles = 0;
  private totalDispatched = 0;
  private totalStuckRecovered = 0;
  private totalQuotaRecoveries = 0;
  private startedAt: string;

  constructor(opts: AgentLoopOptions) {
    this.store = opts.store;
    this.dispatch = opts.dispatch;
    this.log = opts.log ?? ((m) => console.log(`[agent-loop ${new Date().toISOString()}] ${m}`));
    this.shouldStop = opts.shouldStop ?? (() => this.stopping);
    this.mode = opts.mode ?? 'worker';
    this.intervals = {
      fast: opts.intervals?.fast ?? FAST_POLL_MS,
      normal: opts.intervals?.normal ?? NORMAL_POLL_MS,
      slow: opts.intervals?.slow ?? SLOW_POLL_MS,
      quota_recovery: opts.intervals?.quota_recovery ?? QUOTA_RECOVERY_POLL_MS,
      heartbeat: opts.intervals?.heartbeat ?? HEARTBEAT_INTERVAL_MS,
    };
    this.startedAt = new Date().toISOString();
  }

  async start(): Promise<void> {
    // Register ourselves
    if (this.mode === 'supervisor') {
      supervisorStart(this.store, { pid: process.pid });
    }
    supervisorHeartbeat(this.store);

    // Periodic heartbeat (separate from cycle)
    this.heartbeatTimer = setInterval(() => {
      try {
        supervisorHeartbeat(this.store);
      } catch (e: any) {
        this.log(`heartbeat write failed: ${e.message}`);
      }
    }, this.intervals.heartbeat);

    // Signal handlers
    const onSignal = (sig: string) => {
      this.log(`received ${sig}, stopping cleanly...`);
      this.stopping = true;
    };
    process.on('SIGTERM', () => onSignal('SIGTERM'));
    process.on('SIGINT', () => onSignal('SIGINT'));

    this.log(`agent loop started (mode=${this.mode}, pid=${process.pid})`);

    // Main loop
    while (!this.shouldStop()) {
      const cycleStart = Date.now();
      this.runId++;
      const runId = this.runId;

      let result: CycleResult;
      try {
        result = await this.cycle();
      } catch (e: any) {
        this.log(`cycle ${runId} crashed: ${e.message}`);
        // Don't die — sleep and retry
        await sleep(this.intervals.slow);
        continue;
      }

      this.totalCycles++;
      this.totalDispatched += result.dispatched;
      this.totalStuckRecovered += result.watchdog.stuck_recovered;
      if (result.watchdog.quota_recovered) this.totalQuotaRecoveries++;

      // Log summary if interesting
      const interesting =
        result.dispatched > 0 ||
        result.watchdog.stuck_recovered > 0 ||
        result.watchdog.quota_recovered ||
        result.scheduler.released_leases > 0 ||
        result.dispatch_errors > 0;

      if (interesting) {
        this.log(
          `cycle=${runId} dur=${result.duration_ms}ms picked=${result.scheduler.picked} dispatched=${result.dispatched} ` +
            `released_leases=${result.scheduler.released_leases} stuck_recovered=${result.watchdog.stuck_recovered} ` +
            `quota_recovered=${result.watchdog.quota_recovered} dispatch_errors=${result.dispatch_errors} ` +
            `next_sleep=${result.next_sleep_ms}ms`,
        );
      }

      await sleep(result.next_sleep_ms);
    }

    // Cleanup
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    if (this.mode === 'supervisor') {
      supervisorStop(this.store, { reason: 'agent loop exit' });
    }
    this.log(`agent loop stopped after ${this.totalCycles} cycles`);
  }

  /**
   * One cycle: watchdog + scheduler tick + dispatch.
   */
  async cycle(): Promise<CycleResult> {
    const cycleStart = new Date().toISOString();
    const startMs = Date.now();

    // 1. Watchdog tick (stuck recovery + supervisor health + quota recovery)
    const watchdog = watchdogTick(this.store);

    // 2. Decide whether to dispatch
    const quotaDispatch = canDispatch(this.store);
    let schedulerResult = { picked: [] as SchedulePick[], released: [] as any[] };
    if (quotaDispatch.ok) {
      schedulerResult = schedulerTick(this.store, { limit: 1 });
    }

    // 3. Dispatch picked tasks
    let dispatched = 0;
    let dispatchErrors = 0;
    if (this.dispatch) {
      for (const pick of schedulerResult.picked) {
        try {
          await this.dispatch(pick);
          dispatched++;
        } catch (e: any) {
          dispatchErrors++;
          this.log(`dispatch failed for task ${pick.task.id}: ${e.message}`);
          // Don't let dispatch errors kill the loop
        }
      }
    } else {
      // No dispatch handler — just count picks
      dispatched = schedulerResult.picked.length;
    }

    const durationMs = Date.now() - startMs;

    // 4. Decide next sleep
    let nextSleepMs: number;
    if (!quotaDispatch.ok) {
      // Quota cooldown: sleep until recovery (or check interval)
      const quotaState = getQuotaState(this.store);
      if (quotaState.recovery_at) {
        const remaining = new Date(quotaState.recovery_at).getTime() - Date.now();
        // Wake at recovery_at (or every 5min, whichever is sooner)
        nextSleepMs = Math.min(
          Math.max(remaining, 1000), // at least 1s
          this.intervals.quota_recovery,
        );
      } else {
        nextSleepMs = this.intervals.quota_recovery;
      }
    } else if (schedulerResult.picked.length > 0) {
      // Had work — poll fast to grab more
      nextSleepMs = this.intervals.fast;
    } else if (watchdog.quota_recovery.recovered) {
      // Just recovered from quota — be eager
      nextSleepMs = this.intervals.fast;
    } else {
      // Idle — slow poll
      nextSleepMs = this.intervals.normal;
    }

    return {
      cycle_started_at: cycleStart,
      cycle_finished_at: new Date().toISOString(),
      duration_ms: durationMs,
      watchdog: {
        stuck_recovered: watchdog.stuck_tasks.filter((s) => s.action === 'released' || s.action === 'blocked').length,
        quota_recovered: watchdog.quota_recovery.recovered,
        quota_released_tasks: watchdog.quota_recovery.released_tasks,
      },
      scheduler: {
        picked: schedulerResult.picked.length,
        released_leases: schedulerResult.released.length,
      },
      dispatched,
      dispatch_errors: dispatchErrors,
      next_sleep_ms: nextSleepMs,
    };
  }

  // ---------------------------------------------------------------------------
  // Public metrics
  // ---------------------------------------------------------------------------

  getStats() {
    return {
      started_at: this.startedAt,
      total_cycles: this.totalCycles,
      total_dispatched: this.totalDispatched,
      total_stuck_recovered: this.totalStuckRecovered,
      total_quota_recoveries: this.totalQuotaRecoveries,
    };
  }
}

// =============================================================================
// helpers
// =============================================================================

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
