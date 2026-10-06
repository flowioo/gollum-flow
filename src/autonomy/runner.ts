import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { parseConfig, safeRelative, withinPaths, type ImprovementConfig } from './config.js';
import { callHost, type HostStage, type HostResult, type ImprovementProposal } from './host.js';
import { ImprovementJournal, type ImprovementRun } from './journal.js';
import { runProcess, type ProcessResult } from './process.js';
import { applyVerifiedChanges, copyDependencies, createCandidate, inspectCandidate, promoteCandidate, regular, snapshotWorkspace, workspaceDigest } from './workspace.js';

interface Experiment {
  iteration: number; title: string; disposition: 'accepted' | 'rejected'; reason: string;
  candidate?: string; proposal?: ImprovementProposal; baseline_probe?: ProcessResult; fixed_probe?: ProcessResult;
  checks?: ProcessResult[]; review?: Record<string, unknown>; digest?: string; accepted?: string;
}
export interface ImprovementState extends Record<string, unknown> {
  accepted?: string; initial?: string; applied?: string; accepted_digest?: string; history: Experiment[]; pending_call?: string;
  candidate?: string; proposal?: ImprovementProposal; baseline_probe?: ProcessResult;
  promoted?: string;
  fixed_probe?: ProcessResult; checks?: ProcessResult[]; review?: Record<string, unknown>;
  changed?: string[]; digest?: string; reason?: string;
}
const passed = (r: ProcessResult) => r.reason === 'exit' && r.code === 0;
const promptEvidence = (r: ProcessResult) => {
  const excerpt = (text: string) => text.length <= 4000 ? text :
    `${text.slice(0, 1500)}\n[${text.length - 4000} characters omitted; full output retained in ${r.log}]\n${text.slice(-2500)}`;
  return { ...r, stdout: excerpt(r.stdout), stderr: excerpt(r.stderr) };
};
class InterruptedExperiment extends Error {}
class QuotaWait extends Error {}
class CheckpointInterrupt extends Error {}
class IntegrityError extends Error {}

export function validateProposal(value: Record<string, unknown>, config: ImprovementConfig, accepted: string): ImprovementProposal {
  for (const key of ['kind', 'title', 'hypothesis', 'test_path', 'test_content', 'acceptance', 'reason']) {
    if (typeof value[key] !== 'string') throw new Error(`Proposal has invalid ${key}`);
  }
  if (value.kind === 'stop') return value as unknown as ImprovementProposal;
  if (value.kind !== 'improvement' || !(value.title as string).trim() || !(value.hypothesis as string).trim() || !(value.acceptance as string).trim()) throw new Error('Proposal lacks a concrete hypothesis and acceptance condition');
  if (!Array.isArray(value.paths) || !value.paths.length || value.paths.some(p => typeof p !== 'string' || !safeRelative(p) || !withinPaths(p, config.allowed_paths) || withinPaths(p, config.protected_paths))) throw new Error('Proposal paths exceed implementation scope');
  const path = value.test_path as string;
  if (!safeRelative(path) || !path.startsWith(config.test_directory + '/') || !path.endsWith('.test.ts') && !path.endsWith('.test.js') && !path.endsWith('.py') && !path.endsWith('.mjs')) throw new Error('Invalid regression test path');
  if (!(value.test_content as string).trim() || (value.test_content as string).length > 128000) throw new Error('Invalid regression test content');
  if (regular(accepted, path)) throw new Error('Regression test must be new');
  return value as unknown as ImprovementProposal;
}

/** Durable, bounded experiment loop. The controller owns all checks and promotion. */
export async function runImprovement(journal: ImprovementJournal, id: string, options: {
  signal?: AbortSignal; onProgress?: (run: ImprovementRun) => void;
  // Allows integration tests to simulate a controller crash exactly after a durable transition.
  afterCheckpoint?: (run: ImprovementRun) => void;
} = {}): Promise<ImprovementRun> {
  let run = journal.get(id);
  if (!['running', 'waiting'].includes(run.status)) return run;
  const config = parseConfig(JSON.parse(run.config));
  const lease = journal.claim(id, randomUUID());
  const abort = new AbortController();
  const forwardAbort = () => abort.abort(options.signal?.reason);
  options.signal?.addEventListener('abort', forwardAbort, { once: true });
  if (options.signal?.aborted) forwardAbort();
  let leaseLost = false;
  let state: ImprovementState = { history: [], ...JSON.parse(journal.get(id).checkpoint) };
  const heartbeat = setInterval(() => {
    try {
      journal.heartbeat(lease);
      const current = journal.get(id);
      if (current.stop_requested || current.deadline_ms <= Date.now()) abort.abort();
    } catch { leaseLost = true; abort.abort(); }
  }, 1000);
  const checkpoint = (phase: string, patch: Partial<Pick<ImprovementRun, 'status' | 'wake_ms' | 'iteration' | 'failures'>> = {}) => {
    run = journal.checkpoint(lease, { phase, ...patch }, state);
    options.onProgress?.(run);
    try { options.afterCheckpoint?.(run); } catch (error) { throw new CheckpointInterrupt(String(error)); }
  };
  const stop = (reason: string, status: ImprovementRun['status'] = 'stopped') => {
    state.reason = reason; checkpoint(run.phase, { status });
  };
  const remaining = () => Math.max(1, journal.get(id).deadline_ms - Date.now());
  const command = (argv: string[], cwd: string, label: string, timeout = 120000) => runProcess({
    argv, cwd, log: join(run.workspace, 'logs', `${run.iteration}-${lease.generation}-${label}-${randomUUID()}.log`),
    timeout_ms: Math.min(timeout, remaining()), signal: abort.signal,
  });
  const checks = async (cwd: string, label: string): Promise<ProcessResult[]> => {
    const results: ProcessResult[] = [];
    for (const [index, check] of config.checks.entries()) {
      const result = await command(check.argv, cwd, `${label}-${index}`, check.timeout_ms);
      results.push(result);
      if (!passed(result)) break;
    }
    return results;
  };
  const host = async (stage: HostStage, cwd: string, prompt: string): Promise<HostResult> => {
    // beginCall and the pending ID are one transaction. Replay only a persisted result.
    const pending = state.pending_call ? journal.call(state.pending_call) : null;
    let result: HostResult;
    if (pending) {
      if (pending.run_id !== id || pending.stage !== stage) throw new Error('Host checkpoint does not match the stage');
      if (pending.status !== 'finished' || !pending.result) throw new InterruptedExperiment('Previous host call was interrupted; discard this experiment');
      result = JSON.parse(pending.result);
    } else {
      const callId = journal.beginCall(lease, stage);
      state.pending_call = callId;
      const log = join(run.workspace, 'logs', `${callId}-${stage}.log`), started = Date.now();
      try {
        result = await callHost({ config, stage, cwd, prompt, signal: abort.signal, timeout_ms: remaining(), log });
      } catch (error) {
        // An adapter failure still consumes its reservation; never strand an active call in a live controller.
        result = { result: null, cost_usd: config.cost_per_call_usd, session_id: null,
          outcome: abort.signal.aborted ? 'cancelled' : 'failed', error: String(error),
          process: { code: null, signal: null, stdout: '', stderr: String(error), reason: 'spawn_error', duration_ms: Date.now() - started, log } };
      }
      journal.finishCall(lease, callId, result);
    }
    delete state.pending_call;
    if (result.outcome === 'quota') {
      state.reason = 'Host reported quota exhaustion; retry after cooldown within the remaining budget';
      checkpoint(run.phase, { status: 'waiting', wake_ms: Date.now() + config.cooldown_ms });
      throw new QuotaWait(state.reason);
    }
    if (result.outcome !== 'ok' || !result.result) throw new Error(`Host ${stage} failed: ${result.process.reason}; ${result.error ?? result.process.stderr.slice(-2000)}`);
    return result;
  };
  const reject = (reason: string) => {
    state.history.push({ iteration: run.iteration, title: state.proposal?.title ?? 'Discovery', disposition: 'rejected', reason,
      candidate: state.candidate, proposal: state.proposal, baseline_probe: state.baseline_probe, fixed_probe: state.fixed_probe,
      checks: state.checks, review: state.review });
    state = { accepted: state.accepted, accepted_digest: state.accepted_digest, initial: state.initial, applied: state.applied, history: state.history };
    checkpoint('discover', { iteration: run.iteration + 1, failures: run.failures + 1 });
  };
  try {
    // A previous controller's process wrapper detects orphaning within 250ms.
    if (lease.generation > 1) await delay(600, undefined, { signal: abort.signal }).catch(() => {});
    run = journal.get(id);
    while (['running', 'waiting'].includes(run.status)) {
      run = journal.get(id);
      if (leaseLost) throw new Error('Lost autonomous run lease');
      if (abort.signal.aborted || run.stop_requested) { stop('Stopped by cancellation or deadline'); break; }
      if (run.deadline_ms <= Date.now()) { stop('Wall time budget exhausted'); break; }
      if (run.phase !== 'apply' && (run.iteration >= config.max_iterations || run.failures >= config.max_failures)) { stop('Experiment or failure budget exhausted'); break; }
      if (run.status === 'waiting') {
        if ((run.wake_ms ?? 0) > Date.now()) {
          await delay(Math.min(1000, run.wake_ms! - Date.now(), remaining()), undefined, { signal: abort.signal }).catch(() => {});
          continue;
        }
        checkpoint(run.phase, { status: 'running', wake_ms: null });
      }
      const isCallPhase = ['discover', 'implement', 'review'].includes(run.phase);
      if (isCallPhase && !state.pending_call && run.spent_usd + config.cost_per_call_usd > config.max_cost_usd) { stop('Host cost budget exhausted'); break; }
      try {
        switch (run.phase) {
          case 'baseline': {
            if (!state.accepted) {
              const accepted = join(run.workspace, `initial-${lease.generation}`);
              snapshotWorkspace(config.repo, accepted);
              state.accepted = accepted; state.initial = accepted;
              state.accepted_digest = workspaceDigest(accepted);
              checkpoint('baseline');
            }
            copyDependencies(config.repo, state.accepted!, config.dependency_dirs);
            state.checks = await checks(state.accepted!, 'baseline');
            if (workspaceDigest(state.accepted!) !== state.accepted_digest) throw new IntegrityError('Baseline checks modified source files');
            if (!state.checks.every(passed) || state.checks.length !== config.checks.length) {
              stop('Baseline checks failed; fix the baseline or configure valid checks before autonomous improvement', 'failed'); break;
            }
            delete state.checks; checkpoint('discover'); break;
          }
          case 'discover': {
            if (workspaceDigest(state.accepted!) !== state.accepted_digest) throw new IntegrityError('Accepted source changed outside the controller');
            const result = await host('discover', state.accepted!,
              `Objective: ${config.objective}\nInspect this repository and propose ONE concrete behavioral improvement with a new regression test that fails on the current code and passes after a real implementation fix. Return the test content in JSON; do not edit files. Allowed implementation paths: ${JSON.stringify(config.allowed_paths)}. Protected paths: ${JSON.stringify(config.protected_paths)}. Test directory: ${config.test_directory}. Probe command: ${JSON.stringify(config.probe_command)}. Fixed independent checks: ${JSON.stringify(config.checks)}. No weakening checks, fabricated proofs, test-only changes or new planning workflows. Explain how the test demonstrates the objective. If no useful improvement remains, return kind=stop and a concrete reason.\nPrevious experiments (use failures to change approach, do not repeat rejected proposals): ${JSON.stringify(state.history.map(e => ({ title: e.title, disposition: e.disposition, reason: e.reason })))}`);
            if (workspaceDigest(state.accepted!) !== state.accepted_digest) throw new IntegrityError('Discovery modified the accepted source');
            state.proposal = validateProposal(result.result!, config, state.accepted!);
            if (state.proposal.kind === 'stop') { stop(state.proposal.reason || 'Host found no further improvement', 'completed'); break; }
            checkpoint('prepare'); break;
          }
          case 'prepare': {
            const candidate = join(run.workspace, `candidate-${run.iteration}-${lease.generation}-${randomUUID()}`);
            createCandidate(state.accepted!, candidate);
            copyDependencies(config.repo, candidate, config.dependency_dirs);
            const path = join(candidate, state.proposal!.test_path);
            mkdirSync(dirname(path), { recursive: true });
            writeFileSync(path, state.proposal!.test_content, { flag: 'wx' });
            state.candidate = candidate; checkpoint('reproduce'); break;
          }
          case 'reproduce': {
            state.baseline_probe = await command(config.probe_command.map(a => a.replaceAll('{test}', state.proposal!.test_path)), state.candidate!, 'reproducer');
            if (state.baseline_probe.reason !== 'exit' || state.baseline_probe.code === 0 || state.baseline_probe.code === null || state.baseline_probe.code >= 126) throw new Error('Regression test did not produce a normal failing exit on the baseline');
            checkpoint('implement'); break;
          }
          case 'implement': {
            await host('implement', state.candidate!,
              `Objective: ${config.objective}\nImplement this specific improvement: ${JSON.stringify(state.proposal)}\nThe controller independently ran the reproducer and observed failure: ${JSON.stringify(promptEvidence(state.baseline_probe!))}. Change implementation files only within ${JSON.stringify(state.proposal!.paths)}. Never edit the regression test, existing tests, build/verification configuration, policies or Git metadata. Do not run tools outside this directory. Return a summary of the actual implementation changes; the controller will test and review them independently.`);
            checkpoint('verify'); break;
          }
          case 'verify': {
            state.changed = inspectCandidate(state.accepted!, state.candidate!, {
              allowed: state.proposal!.paths, protected: config.protected_paths,
              test_path: state.proposal!.test_path, test_content: state.proposal!.test_content,
            });
            const before = workspaceDigest(state.candidate!, state.changed);
            state.fixed_probe = await command(config.probe_command.map(a => a.replaceAll('{test}', state.proposal!.test_path)), state.candidate!, 'fixed-probe');
            if (!passed(state.fixed_probe)) throw new Error('Regression test still fails after implementation');
            state.checks = await checks(state.candidate!, 'candidate');
            if (state.checks.length !== config.checks.length || !state.checks.every(passed)) throw new Error('Independent checks failed after implementation');
            state.digest = workspaceDigest(state.candidate!, state.changed);
            if (state.digest !== before) throw new Error('Verification commands changed the candidate source');
            checkpoint('review'); break;
          }
          case 'review': {
            const result = await host('review', state.candidate!,
              `Independently review this experiment against objective: ${config.objective}. Proposal: ${JSON.stringify(state.proposal)}. Changed paths: ${JSON.stringify(state.changed)}. Read the implementation and new regression test. The controller observed baseline failure: ${JSON.stringify(promptEvidence(state.baseline_probe!))}; fixed probe: ${JSON.stringify(promptEvidence(state.fixed_probe!))}; immutable independent checks: ${JSON.stringify(state.checks!.map(promptEvidence))}. Long output may be explicitly excerpted; reject if the supplied evidence is insufficient. Reject vacuous tests, fabricated failures, syntax/import/environment failures masquerading as a reproducer, objective drift, weakened correctness, or a test-specific hack. Return accept:true only for a substantive correct improvement supported by the test. Do not edit any files.`);
            state.review = result.result!;
            if (result.result!.accept !== true || typeof result.result!.reason !== 'string' || !result.result!.reason.trim()) throw new Error(`Independent review rejected: ${result.result!.reason ?? 'invalid review response'}`);
            checkpoint('promote'); break;
          }
          case 'promote': {
            journal.heartbeat(lease);
            const destination = join(run.workspace, `accepted-${run.iteration}`);
            promoteCandidate(state.accepted!, state.candidate!, destination, state.changed!, state.digest!, state.proposal!.title);
            state.promoted = destination;
            checkpoint('verify_promoted'); break;
          }
          case 'verify_promoted': {
            // Rebuild from the exact retained source. Candidate-only ignored helpers cannot sneak into the proof.
            const destination = state.promoted!;
            copyDependencies(config.repo, destination, config.dependency_dirs);
            const digest = workspaceDigest(destination);
            const probe = await command(config.probe_command.map(a => a.replaceAll('{test}', state.proposal!.test_path)), destination, 'retained-probe');
            if (!passed(probe)) throw new Error('Regression failed on the clean retained source');
            const retainedChecks = await checks(destination, 'retained');
            if (retainedChecks.length !== config.checks.length || !retainedChecks.every(passed)) throw new Error('Independent checks failed on the clean retained source');
            if (workspaceDigest(destination) !== digest) throw new Error('Retained checks modified source files');
            state.history.push({ iteration: run.iteration, title: state.proposal!.title, disposition: 'accepted', reason: String(state.review!.reason),
              candidate: state.candidate, proposal: state.proposal, baseline_probe: state.baseline_probe, fixed_probe: state.fixed_probe,
              checks: [...state.checks!, probe, ...retainedChecks], review: state.review, digest: state.digest, accepted: destination });
            state = { initial: state.initial, applied: state.applied, accepted: destination, accepted_digest: workspaceDigest(destination), history: state.history };
            checkpoint(config.apply ? 'apply' : 'discover', { iteration: run.iteration + 1 }); break;
          }
          case 'apply': {
            journal.heartbeat(lease);
            applyVerifiedChanges(state.applied ?? state.initial!, state.accepted!, config.repo);
            state.applied = state.accepted;
            checkpoint('discover'); break;
          }
          default: throw new Error(`Unknown improvement phase: ${run.phase}`);
        }
      } catch (error) {
        if (error instanceof CheckpointInterrupt) throw error;
        if (leaseLost) throw error;
        if (error instanceof QuotaWait) continue;
        if (abort.signal.aborted) { stop('Stopped during a child process'); break; }
        if (error instanceof IntegrityError || ['baseline', 'promote', 'apply'].includes(run.phase)) { stop(String(error), 'failed'); break; }
        reject(error instanceof Error ? error.message : String(error));
      }
    }
  } finally {
    clearInterval(heartbeat);
    options.signal?.removeEventListener('abort', forwardAbort);
    if (!leaseLost && journal.get(id).reserved_usd === 0) {
      try { journal.release(lease); } catch { /* An expired lease belongs to its next owner. */ }
    }
  }
  return journal.get(id);
}
