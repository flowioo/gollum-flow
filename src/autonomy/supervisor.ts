import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import type { Store } from '../workflow/store/store.js';
import { ImprovementJournal, type ImprovementRun } from './journal.js';
import { runProcess } from './process.js';

interface Watcher {
  id: string; owner: string | null; lease_until_ms: number | null; generation: number;
  restarts: number; last_error: string | null; version: number; created_at: string; updated_at: string;
}

/** Persistent, single-owner watchdog for one improvement run, separate from the generic task monitor. */
export async function superviseImprovement(store: Store, id: string, options: {
  worker_argv: string[]; env?: NodeJS.ProcessEnv; signal?: AbortSignal;
  max_restarts?: number; restart_delay_ms?: number;
  onProgress?: (run: ImprovementRun) => void;
}): Promise<void> {
  const journal = new ImprovementJournal(store), run = journal.get(id);
  if (!['running', 'waiting'].includes(run.status)) return;
  const owner = randomUUID(), leaseMs = 30000;
  const limit = options.max_restarts ?? 3;
  if (!Number.isSafeInteger(limit) || limit < 0 || !options.worker_argv.length) throw new Error('Invalid improvement supervisor configuration');
  store.transaction(() => {
    const now = Date.now(), date = new Date(now).toISOString();
    store.raw().prepare('INSERT OR IGNORE INTO improvement_watchers (id, created_at, updated_at) VALUES (?, ?, ?)').run(id, date, date);
    const current = store.get<Watcher>('improvement_watchers', id);
    if (current.owner && (current.lease_until_ms ?? Infinity) > now) throw new Error('Improvement run already supervised');
    store.casUpdate<Watcher>('improvement_watchers', id, current.version, {
      owner, generation: current.generation + 1, lease_until_ms: now + leaseMs,
    });
  });
  let lost = false;
  let childStarted = 0;
  let stopObserved = 0;
  let lastProgress = '';
  const cancellation = new AbortController();
  let child: AbortController | undefined;
  const stop = () => { journal.requestStop(id); cancellation.abort(); };
  options.signal?.addEventListener('abort', stop, { once: true });
  if (options.signal?.aborted) stop();
  const updateWatcher = (patch: Partial<Watcher>) => store.transaction(() => {
    const current = store.get<Watcher>('improvement_watchers', id);
    if (current.owner !== owner || (current.lease_until_ms ?? 0) <= Date.now()) throw new Error('Stale improvement supervisor lease');
    return store.casUpdate<Watcher>('improvement_watchers', id, current.version, patch);
  });
  const heartbeat = setInterval(() => {
    try {
      updateWatcher({ lease_until_ms: Date.now() + leaseMs });
      const current = journal.get(id);
      const progress = `${current.status}/${current.phase}/${current.iteration}/${current.spent_usd}`;
      if (progress !== lastProgress) { lastProgress = progress; options.onProgress?.(current); }
      if (current.stop_requested || current.deadline_ms <= Date.now()) {
        cancellation.abort();
        stopObserved ||= Date.now();
        if (Date.now() - stopObserved > 3000) child?.abort();
      }
      // A controller can be alive but blocked. Stop its group before allowing a replacement.
      if (Date.now() - childStarted > 5000 && current.owner && (current.lease_until_ms ?? 0) <= Date.now()) child?.abort();
    } catch { lost = true; cancellation.abort(); child?.abort(); }
  }, 1000);
  try {
    while (!cancellation.signal.aborted) {
      const current = journal.get(id);
      if (!['running', 'waiting'].includes(current.status)) return;
      if (current.stop_requested || current.deadline_ms <= Date.now()) return;
      // Do not race a still-valid controller after a supervisor restart.
      if (current.owner && (current.lease_until_ms ?? Infinity) > Date.now()) {
        await delay(500, undefined, { signal: cancellation.signal }).catch(() => {}); continue;
      }
      const watcher = store.get<Watcher>('improvement_watchers', id);
      if (watcher.restarts > limit) return;
      child = new AbortController();
      childStarted = Date.now();
      const result = await runProcess({ argv: options.worker_argv, cwd: current.workspace,
        env: options.env, signal: child.signal, timeout_ms: Math.max(1, current.deadline_ms - Date.now()),
        log: join(current.workspace, 'logs', `supervisor-${watcher.generation}-${watcher.restarts}.log`) });
      child = undefined;
      if (lost) throw new Error('Lost improvement supervisor lease');
      if (!['running', 'waiting'].includes(journal.get(id).status) || cancellation.signal.aborted) return;
      const updated = updateWatcher({ restarts: watcher.restarts + 1,
        last_error: `Controller exited before run termination: ${result.reason}, code=${result.code}` });
      if (updated.restarts > limit) {
        journal.requestStop(id);
        return;
      }
      await delay(options.restart_delay_ms ?? 1000, undefined, { signal: cancellation.signal }).catch(() => {});
    }
  } finally {
    if (!lost) {
      // A killed controller cannot finalize its run. Wait out its fenced lease before doing so.
      const settleDeadline = Date.now() + leaseMs + 1000;
      while (Date.now() < settleDeadline) {
        const current = journal.get(id);
        if (!['running', 'waiting'].includes(current.status) || (!current.stop_requested && current.deadline_ms > Date.now())) break;
        if (current.owner && (current.lease_until_ms ?? Infinity) > Date.now()) { await delay(250); continue; }
        try {
          const lease = journal.claim(id, owner);
          journal.checkpoint(lease, { status: 'stopped' }, { ...JSON.parse(current.checkpoint), reason:
            store.get<Watcher>('improvement_watchers', id).last_error ?? 'Stopped by cancellation or wall time budget' });
          journal.release(lease);
        } catch { /* A concurrent recovery acquired the lease; its stop flag remains set. */ }
        break;
      }
    }
    clearInterval(heartbeat); options.signal?.removeEventListener('abort', stop);
    if (!lost) { try { updateWatcher({ owner: null, lease_until_ms: null }); } catch { /* owned by a replacement */ } }
  }
}
