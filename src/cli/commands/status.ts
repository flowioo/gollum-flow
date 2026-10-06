import { decideResume } from '../../core/resume.js';
import { criterionList, criterionGet } from '../../core/criterion.js';
import { Command } from 'commander';
import { getStore } from '../../workflow/store/store.js';
import { resolveProject } from '../../workflow/resolver.js';
import { outcomeRemainingGap } from '../../core/outcome.js';
import { getQuotaState } from '../../agent/quota.js';
import type { Task, Outcome, Goal } from '../../workflow/model/types.js';

export function statusCommand(name: 'status' | 'resume'): Command {
  return new Command(name)
    .description('Read the current project, evidence gaps and recovery context (does not execute tasks)')
    .option('--project-id <id>', 'Explicit local project ID')
    .option('--json', 'Output structured recovery context')
    .action(async (opts) => {
      const store = getStore();
      const binding = await resolveProject(process.cwd());
      const projectId = opts.projectId ?? binding.project_id;
      if (!projectId) throw new Error('No project bound to cwd; run gollum init or supply --project-id');
      const project = store.get<{ id: string; name: string }>('projects', projectId);
      const goals = store.list<Goal>('goals', 'project_id = ?', [projectId]);
      const context = {
        workflow: 'gollum', context_source: 'sqlite',
        project, repo_root: binding.repo_root, quota: getQuotaState(store),
        execution: 'generic tasks: monitor-only; autonomous experiments use gollum improve status',
        goals: goals.map(g => ({ ...g, outcomes: store.list<Outcome>('outcomes', 'goal_id = ?', [g.id]).map(o => {
          const gap = outcomeRemainingGap(store, o.id);
          return { ...o, criteria: criterionList(store, o.id).map(c => ({ ...c, latest_evidence: criterionGet(store, c.id).latest_evidence })), remaining_gap: gap, requires_reverification: o.status === 'VERIFIED' && gap.remaining > 0,
            tasks: store.list<Task>('tasks', 'outcome_id = ? ORDER BY priority DESC, created_at ASC', [o.id])
              .map(t => ({ id: t.id, title: t.title, status: t.status, owner: t.owner,
                wake_at: t.wake_at, acceptance_criteria: t.acceptance_criteria, phase: t.phase,
                lease_until: t.lease_until, retry_count: t.retry_count, summary: t.summary,
                observation: t.last_observation, next_action: t.next_action,
                recovery: t.lease_until && new Date(t.lease_until).getTime() <= Date.now()
                  ? 'expired lease: recover, inspect workspace, then claim again'
                  : t.owner ? 'owned: do not start another executor' : 'inspect workspace before claiming' })),
          };
        }) })),
      };
      const decision = decideResume(context.goals, context.quota.status);
      if (opts.json) { console.log(JSON.stringify({ ...context, decision }, null, 2)); return; }
      console.log(`Decision: ${decision.action} — ${decision.reason}`);
      console.log(`Project: ${project.name} (${project.id})\nExecution: ${context.execution}`);
      console.log(`Quota: ${context.quota.status}`);
      for (const g of context.goals) {
        console.log(`\nGoal: ${g.title} [${g.status}]`);
        for (const o of g.outcomes) {
          console.log(`  Outcome: ${o.title} [${o.status}] remaining=${o.remaining_gap.remaining}/${o.remaining_gap.total}${o.requires_reverification ? ' — evidence stale; reverify' : ''}`);
          for (const t of o.tasks) {
            console.log(`    ${t.id} [${t.status}] ${t.title}\n      checkpoint: ${t.summary ?? '-'}\n      observed: ${t.observation ?? '-'}\n      next: ${t.next_action ?? '-'}\n      ${t.recovery}`);
          }
        }
      }
    });
}
