import { ulid, type Store } from '../workflow/store/store.js';
import type { ImprovementConfig } from './config.js';
import type { HostResult, HostStage } from './host.js';

export interface ImprovementRun {
  id: string; config: string; workspace: string;
  status: 'running' | 'waiting' | 'stopped' | 'completed' | 'failed';
  phase: string; iteration: number; failures: number;
  spent_usd: number; reserved_usd: number; deadline_ms: number; wake_ms: number | null;
  owner: string | null; lease_until_ms: number | null; generation: number; stop_requested: number;
  checkpoint: string; version: number; created_at: string; updated_at: string;
}
export interface RunLease { run_id: string; owner: string; generation: number }
export interface ImprovementCall { id: string; run_id: string; stage: HostStage; status: 'started' | 'finished' | 'interrupted'; result: string | null }
export class ImprovementJournal {
  constructor(private store: Store) {}
  get(id: string): ImprovementRun { return this.store.get('improvement_runs', id); }
  call(id: string): ImprovementCall { return this.store.get('improvement_calls', id); }
  create(config: ImprovementConfig, workspace: string, now = Date.now()): ImprovementRun {
    const id = ulid(), date = new Date(now).toISOString();
    this.store.raw().prepare(`INSERT INTO improvement_runs
      (id, config, workspace, deadline_ms, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`)
      .run(id, JSON.stringify(config), workspace, now + config.max_duration_ms, date, date);
    return this.get(id);
  }
  claim(id: string, owner: string, leaseMs = 30000, now = Date.now()): RunLease {
    if (!owner || !Number.isFinite(leaseMs) || leaseMs <= 0) throw new Error('Invalid owner or lease');
    return this.store.transaction(() => {
      const run = this.get(id);
      if (!['running', 'waiting'].includes(run.status)) throw new Error('Run is terminal');
      if (run.owner && (run.lease_until_ms ?? Infinity) > now) throw new Error('Run already owned');
      const generation = run.generation + 1;
      // A lost host call may have incurred its full reservation. Never refund unknown work.
      this.store.raw().prepare("UPDATE improvement_calls SET status = 'interrupted', updated_at = ? WHERE run_id = ? AND status = 'started'")
        .run(new Date(now).toISOString(), id);
      this.store.casUpdate<ImprovementRun>('improvement_runs', id, run.version, {
        owner, generation, lease_until_ms: now + leaseMs,
        spent_usd: run.spent_usd + run.reserved_usd, reserved_usd: 0,
      });
      return { run_id: id, owner, generation };
    });
  }
  private owned(lease: RunLease, now: number): ImprovementRun {
    const run = this.get(lease.run_id);
    if (run.owner !== lease.owner || run.generation !== lease.generation || (run.lease_until_ms ?? 0) <= now) throw new Error('Stale run lease');
    return run;
  }
  heartbeat(lease: RunLease, leaseMs = 30000, now = Date.now()): void {
    if (!Number.isFinite(leaseMs) || leaseMs <= 0) throw new Error('Invalid lease duration');
    this.store.transaction(() => {
      const run = this.owned(lease, now);
      this.store.casUpdate<ImprovementRun>('improvement_runs', run.id, run.version, { lease_until_ms: now + leaseMs });
    });
  }
  checkpoint(lease: RunLease, patch: Partial<Pick<ImprovementRun, 'phase' | 'iteration' | 'failures' | 'status' | 'wake_ms'>>,
    state: Record<string, unknown>, now = Date.now()): ImprovementRun {
    return this.store.transaction(() => {
      const run = this.owned(lease, now);
      return this.store.casUpdate<ImprovementRun>('improvement_runs', run.id, run.version, { ...patch, checkpoint: JSON.stringify(state) });
    });
  }
  requestStop(id: string): void {
    this.store.transaction(() => {
      const run = this.get(id);
      this.store.casUpdate<ImprovementRun>('improvement_runs', id, run.version, { stop_requested: 1 });
    });
  }
  release(lease: RunLease, now = Date.now()): void {
    this.store.transaction(() => {
      const run = this.owned(lease, now);
      if (run.reserved_usd) throw new Error('Cannot release a running host call');
      this.store.casUpdate<ImprovementRun>('improvement_runs', run.id, run.version, { owner: null, lease_until_ms: null });
    });
  }
  beginCall(lease: RunLease, stage: HostStage, now = Date.now()): string {
    return this.store.transaction(() => {
      const run = this.owned(lease, now), config: ImprovementConfig = JSON.parse(run.config);
      if (run.status !== 'running' || run.stop_requested || run.deadline_ms <= now) throw new Error('Run is not executable');
      if (run.reserved_usd || run.spent_usd + config.cost_per_call_usd > config.max_cost_usd) throw new Error('Host budget unavailable');
      const id = ulid(), date = new Date(now).toISOString();
      this.store.raw().prepare(`INSERT INTO improvement_calls
        (id, run_id, iteration, stage, status, reserved_usd, created_at, updated_at) VALUES (?, ?, ?, ?, 'started', ?, ?, ?)`)
        .run(id, run.id, run.iteration, stage, config.cost_per_call_usd, date, date);
      this.store.casUpdate<ImprovementRun>('improvement_runs', run.id, run.version, {
        reserved_usd: config.cost_per_call_usd,
        checkpoint: JSON.stringify({ ...JSON.parse(run.checkpoint), pending_call: id }),
      });
      return id;
    });
  }
  finishCall(lease: RunLease, callId: string, result: HostResult, now = Date.now()): void {
    if (!Number.isFinite(result.cost_usd) || result.cost_usd < 0) throw new Error('Invalid host cost');
    this.store.transaction(() => {
      const run = this.owned(lease, now);
      const call = this.store.get<{ run_id: string; status: string }>('improvement_calls', callId);
      if (call.run_id !== run.id || call.status !== 'started') throw new Error('Call is not active for this run');
      this.store.raw().prepare("UPDATE improvement_calls SET status = 'finished', result = ?, updated_at = ? WHERE id = ?")
        .run(JSON.stringify(result), new Date(now).toISOString(), callId);
      this.store.casUpdate<ImprovementRun>('improvement_runs', run.id, run.version, {
        spent_usd: run.spent_usd + result.cost_usd, reserved_usd: 0,
      });
    });
  }
}
