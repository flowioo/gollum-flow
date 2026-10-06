/** Deterministic resume routing; never invent work when the durable plan is finished. */
export interface ResumeTask {
  id: string; status: string; owner: string | null; lease_until: string | null; wake_at: string | null;
}
export interface ResumeOutcome {
  id: string; status: string; remaining_gap: { total: number; remaining: number }; tasks: ResumeTask[];
}
export interface ResumeGoal { status: string; outcomes: ResumeOutcome[] }
export interface ResumeDecision {
  action: 'complete' | 'no_work' | 'resume' | 'reverify' | 'wait' | 'needs_attention';
  reason: string;
  task_ids: string[];
  outcome_ids: string[];
}
export function decideResume(goals: ResumeGoal[], quotaStatus: string, now = Date.now()): ResumeDecision {
  const decision = (action: ResumeDecision['action'], reason: string, task_ids: string[] = [], outcome_ids: string[] = []): ResumeDecision => ({ action, reason, task_ids, outcome_ids });
  const active = goals.filter(g => g.status !== 'abandoned');
  if (!active.length) return decision('no_work', 'No active Gollum goal. Do not create work unless requested.');
  const outcomes = active.flatMap(g => g.outcomes);
  const tasks = outcomes.flatMap(o => o.tasks);
  if (active.every(g => g.status === 'achieved' && g.outcomes.length > 0) && outcomes.length > 0 &&
      outcomes.every(o => o.status === 'VERIFIED' && o.remaining_gap.total > 0 && o.remaining_gap.remaining === 0) &&
      tasks.every(t => t.status === 'DONE')) {
    return decision('complete', 'All Gollum work is complete. Report completion and stop; no new spec or task is required.');
  }
  if (quotaStatus !== 'ok') return decision('wait', 'Quota is unavailable; inspect cooldown before executing.');
  const runnable = outcomes.filter(o => ['NOT_STARTED', 'IN_PROGRESS'].includes(o.status)).flatMap(o => o.tasks)
    .filter(t => ['PENDING', 'WAITING', 'RUNNING', 'VERIFYING', 'RECOVERING'].includes(t.status));
  const available = runnable.filter(t => {
    if (t.owner && (!t.lease_until || !(Date.parse(t.lease_until) <= now))) return false;
    if (t.wake_at && !(Date.parse(t.wake_at) <= now)) return false;
    return true;
  });
  if (available.length) return decision('resume', 'Inspect checkpoints and workspace; reclaim expired active leases before claiming these existing tasks.', available.map(t => t.id));
  if (runnable.length) return decision('wait', 'Existing work is owned or scheduled for later; do not create duplicate work.');
  const verify = outcomes.filter(o => ['IN_PROGRESS', 'VERIFIED'].includes(o.status) &&
    o.remaining_gap.total > 0 && o.tasks.every(t => t.status === 'DONE') &&
    (o.remaining_gap.remaining > 0 || o.status !== 'VERIFIED'));
  if (verify.length) return decision('reverify', 'Implementation is done; verify the existing criteria and reconcile outcome status.', [], verify.map(o => o.id));
  return decision('needs_attention', 'No runnable task: inspect blocked/failed work, missing criteria or inconsistent completion. Do not invent a replacement plan.');
}
