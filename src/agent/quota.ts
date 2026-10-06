/**
 * Quota Detection & Auto-Recovery
 *
 * Solves: API quota exhaustion (e.g. Claude/Codex 5-hour cooldown)
 *
 * Flow:
 *   1. Worker hits quota error (HTTP 429 / specific error pattern)
 *      → quota.recordExhaustion({ provider, error, recoveryMs })
 *      → mark all RUNNING tasks as WAITING with wake_at = now + recoveryMs
 *      → pause scheduler dispatch
 *
 *   2. Time passes. Scheduler loop periodically calls quota.tick()
 *      → if status=exhausted AND now >= recovery_at:
 *         → mark status=ok
 *         → release waiting tasks (wake_at <= now)
 *         → emit QUOTA_RECOVERED event
 *
 *   3. Resume normal operation
 *
 * Why singleton (id=1)?
 *   - Quota is a system-wide property, not per-task
 *   - Multiple processes must agree on quota state
 *   - CAS on the singleton row gives us safe cross-process coordination
 */

import type { Store } from '../workflow/store/store.js';

// =============================================================================
// Types
// =============================================================================

export type QuotaStatus = 'ok' | 'exhausted' | 'recovering';

export interface QuotaState {
  status: QuotaStatus;
  provider: string | null;
  exhausted_at: string | null;
  recovery_at: string | null;
  error_message: string | null;
  hit_count: number;
  updated_at: string;
}

/**
 * Default cooldown when provider doesn't tell us exactly when quota recovers.
 * 5hr = the typical Claude/Codex weekly rolling window.
 */
export const DEFAULT_QUOTA_RECOVERY_MS = 5 * 60 * 60 * 1000;

/**
 * Patterns that suggest quota exhaustion across providers.
 * V0.1: keep this small and explicit. Add as we encounter real errors.
 */
export const QUOTA_ERROR_PATTERNS: Array<{ pattern: RegExp; provider: string }> = [
  { pattern: /rate[_ ]limit/i, provider: 'unknown' },
  { pattern: /quota[_ ]exceeded/i, provider: 'unknown' },
  { pattern: /429/, provider: 'unknown' },
  { pattern: /\bcapacity\b/i, provider: 'openai' },
  { pattern: /too many requests/i, provider: 'unknown' },
  { pattern: /exceeded your (current )?quota/i, provider: 'anthropic' },
  { pattern: /5[- ]hour/i, provider: 'anthropic' },
  { pattern: /usage[_ ]limit/i, provider: 'unknown' },
  { pattern: /billing[_ ]hard[_ ]limit/i, provider: 'unknown' },
];

/**
 * Try to infer if an error message indicates quota exhaustion.
 * Returns { isQuota: true, provider: 'xxx' } or { isQuota: false }.
 */
export function detectQuotaError(
  message: string,
): { isQuota: true; provider: string } | { isQuota: false } {
  for (const { pattern, provider } of QUOTA_ERROR_PATTERNS) {
    if (pattern.test(message)) {
      return { isQuota: true, provider };
    }
  }
  return { isQuota: false };
}

// =============================================================================
// CRUD
// =============================================================================

/**
 * Read current quota state. Always returns a row (singleton).
 */
export function getQuotaState(store: Store): QuotaState {
  const row = store.raw()
    .prepare('SELECT * FROM quota_state WHERE id = 1')
    .get() as {
      status: QuotaStatus;
      provider: string | null;
      exhausted_at: string | null;
      recovery_at: string | null;
      error_message: string | null;
      hit_count: number;
      updated_at: string;
    };
  return {
    status: row.status,
    provider: row.provider,
    exhausted_at: row.exhausted_at,
    recovery_at: row.recovery_at,
    error_message: row.error_message,
    hit_count: row.hit_count,
    updated_at: row.updated_at,
  };
}

/**
 * Record a quota exhaustion event.
 *
 * Side effects:
 *   1. Update quota_state row (status=exhausted, recovery_at, etc.)
 *   2. Pause all RUNNING/RECOVERING tasks → WAITING with wake_at = recovery_at
 *   3. Emit QUOTA_EXHAUSTED event
 *
 * Returns the new quota state.
 */
export function recordExhaustion(
  store: Store,
  args: {
    provider: string;
    error: string;
    recoveryMs?: number;
    actor?: string;
  },
): QuotaState {
  const recoveryMs = args.recoveryMs ?? DEFAULT_QUOTA_RECOVERY_MS;
  const now = new Date();
  const recoveryAt = new Date(now.getTime() + recoveryMs);

  store.transaction(() => {
    const current = getQuotaState(store);

    // CAS update quota_state
    const newHitCount = current.hit_count + 1;
    store.raw()
      .prepare(`
        UPDATE quota_state
        SET status = 'exhausted',
            provider = ?,
            exhausted_at = ?,
            recovery_at = ?,
            error_message = ?,
            hit_count = ?,
            updated_at = ?
        WHERE id = 1
      `)
      .run(
        args.provider,
        now.toISOString(),
        recoveryAt.toISOString(),
        args.error.slice(0, 1000),
        newHitCount,
        now.toISOString(),
      );

    // Pause all RUNNING/RECOVERING/VERIFYING tasks → WAITING
    const wakeAtIso = recoveryAt.toISOString();
    const paused = store.raw()
      .prepare(`
        UPDATE tasks
        SET status = 'WAITING',
            wait_reason = 'quota',
            version = version + 1,
            updated_at = ?,
            owner = NULL, lease_until = NULL,
            wake_at = ?,
            summary = COALESCE(summary, '') || ' [paused: quota exhausted]'
        WHERE status IN ('RUNNING', 'RECOVERING', 'VERIFYING')
      `)
      .run(now.toISOString(), wakeAtIso);

    // Release leases (in case any RUNNING had owner/lease set)
    store.raw()
      .prepare(`
        UPDATE tasks
        SET owner = NULL,
            lease_until = NULL
        WHERE wait_reason = 'quota' AND wake_at = ? AND owner IS NOT NULL
      `)
      .run(wakeAtIso);

    store.emit({
      event: 'QUOTA_EXHAUSTED',
      actor: args.actor ?? 'quota-detector',
      payload: {
        provider: args.provider,
        error: args.error.slice(0, 500),
        recovery_at: recoveryAt.toISOString(),
        recovery_ms: recoveryMs,
        paused_tasks: paused.changes,
        hit_count: newHitCount,
      },
    });
  });

  return getQuotaState(store);
}

/**
 * Force-clear quota state. Use for manual recovery or testing.
 */
export function clearQuota(
  store: Store,
  args: { actor?: string; reason?: string } = {},
): QuotaState {
  store.transaction(() => {
    store.raw()
      .prepare(`
        UPDATE quota_state
        SET status = 'ok',
            recovery_at = NULL,
            updated_at = ?
        WHERE id = 1
      `)
      .run(new Date().toISOString());

    store.emit({
      event: 'QUOTA_CLEARED',
      actor: args.actor ?? 'manual',
      payload: { reason: args.reason ?? 'manual clear' },
    });
  });

  return getQuotaState(store);
}

// =============================================================================
// Recovery tick
// =============================================================================

export interface QuotaTickResult {
  recovered: boolean;
  released_tasks: number;
  previous_status: QuotaStatus;
  current_status: QuotaStatus;
  recovery_at: string | null;
}

/**
 * Tick: check if quota has recovered. If yes, mark OK and release waiting tasks.
 *
 * Idempotent: safe to call every scheduler tick.
 *
 * Releases tasks where:
 *   - quota is exhausted
 *   - now >= recovery_at
 *   - task is WAITING with wake_at <= recovery_at (paused due to quota)
 *
 * Returns: { recovered, released_tasks, ... }
 */
export function tickQuotaRecovery(store: Store, now: Date = new Date()): QuotaTickResult {
  const state = getQuotaState(store);

  if (state.status === 'ok') {
    return {
      recovered: false,
      released_tasks: 0,
      previous_status: state.status,
      current_status: state.status,
      recovery_at: state.recovery_at,
    };
  }

  // status === 'exhausted' or 'recovering'
  if (!state.recovery_at) {
    // Malformed state: exhausted but no recovery_at. Just clear it.
    clearQuota(store, { actor: 'quota-tick', reason: 'malformed exhausted state without recovery_at' });
    return {
      recovered: true,
      released_tasks: 0,
      previous_status: state.status,
      current_status: 'ok',
      recovery_at: null,
    };
  }

  if (new Date(state.recovery_at) > now) {
    // Not yet recovered.
    return {
      recovered: false,
      released_tasks: 0,
      previous_status: state.status,
      current_status: state.status,
      recovery_at: state.recovery_at,
    };
  }

  // RECOVERED! Release waiting tasks whose wake_at <= recovery_at
  let released = 0;
  store.transaction(() => {
    const result = store.raw()
      .prepare(`
        UPDATE tasks
        SET status = 'PENDING',
            wait_reason = NULL,
            version = version + 1,
            updated_at = ?,
            wake_at = NULL,
            summary = COALESCE(summary, '') || ' [resumed after quota recovery]'
        WHERE status = 'WAITING'
          AND wait_reason = 'quota'
          AND wake_at IS NOT NULL
          AND wake_at <= ?
      `)
      .run(now.toISOString(), state.recovery_at);
    released = Number(result.changes);

    store.raw()
      .prepare(`
        UPDATE quota_state
        SET status = 'ok',
            recovery_at = NULL,
            updated_at = ?
        WHERE id = 1
      `)
      .run(now.toISOString());

    store.emit({
      event: 'QUOTA_RECOVERED',
      actor: 'quota-tick',
      payload: {
        provider: state.provider,
        hit_count: state.hit_count,
        released_tasks: released,
        recovery_at: state.recovery_at,
        recovered_at: now.toISOString(),
        downtime_seconds: state.exhausted_at
          ? Math.round((now.getTime() - new Date(state.exhausted_at).getTime()) / 1000)
          : null,
      },
    });
  });

  return {
    recovered: true,
    released_tasks: released,
    previous_status: state.status,
    current_status: 'ok',
    recovery_at: state.recovery_at,
  };
}

// =============================================================================
// Convenience: scheduler gate
// =============================================================================

/**
 * Should the scheduler dispatch new tasks right now?
 * If quota is exhausted AND recovery is far in the future, the answer is no.
 *
 * Used by the 24/7 loop to skip picks when in quota cooldown.
 */
export function canDispatch(store: Store): { ok: boolean; reason?: string; resume_at?: string } {
  const state = getQuotaState(store);
  if (state.status === 'ok') return { ok: true };
  if (!state.recovery_at) return { ok: true }; // weird state, allow
  if (new Date(state.recovery_at) <= new Date()) return { ok: true }; // ready
  return {
    ok: false,
    reason: `quota exhausted (${state.provider ?? 'unknown'}), recovering at ${state.recovery_at}`,
    resume_at: state.recovery_at,
  };
}
