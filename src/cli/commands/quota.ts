/**
 * Quota CLI — manage API quota state
 *
 *   gollum quota status     Show current quota state
 *   gollum quota clear      Force-clear quota state (manual recovery)
 *   gollum quota exhaust    Manually trigger quota exhaustion (testing)
 */

import { Command } from 'commander';
import { getStore, resetStore } from '../../workflow/store/store.js';
import {
  getQuotaState,
  clearQuota,
  recordExhaustion,
  tickQuotaRecovery,
  DEFAULT_QUOTA_RECOVERY_MS,
} from '../../agent/quota.js';

export function quotaCommand(): Command {
  const cmd = new Command('quota').description('Manage API quota state');

  cmd
    .command('status')
    .description('Show current quota state')
    .action(() => {
      const store = getStore();
      const state = getQuotaState(store);
      console.log('Quota Status:');
      console.log(`  status:        ${state.status}`);
      console.log(`  provider:      ${state.provider ?? '-'}`);
      console.log(`  exhausted_at:  ${state.exhausted_at ?? '-'}`);
      console.log(`  recovery_at:   ${state.recovery_at ?? '-'}`);
      console.log(`  hit_count:     ${state.hit_count}`);
      console.log(`  error:         ${state.error_message?.slice(0, 200) ?? '-'}`);
      console.log(`  updated_at:    ${state.updated_at}`);

      if (state.status === 'exhausted' && state.recovery_at) {
        const remaining = Math.round((new Date(state.recovery_at).getTime() - Date.now()) / 1000);
        if (remaining > 0) {
          console.log(`  recovery_in:   ${remaining}s (${Math.round(remaining / 60)}min)`);
        } else {
          console.log(`  recovery_in:   PAST DUE — call 'gollum quota tick' to clear`);
        }
      }
      resetStore();
    });

  cmd
    .command('clear')
    .description('Force-clear quota state (manual recovery)')
    .option('--reason <text>', 'Reason for clearing', 'manual')
    .action((opts) => {
      const store = getStore();
      const result = clearQuota(store, { actor: 'cli', reason: opts.reason });
      console.log('✓ Quota cleared');
      console.log(`  status: ${result.status}`);
      resetStore();
    });

  cmd
    .command('exhaust')
    .description('Manually trigger quota exhaustion (testing)')
    .requiredOption('--provider <name>', 'Provider name (e.g. anthropic, codex)')
    .requiredOption('--error <msg>', 'Error message to record')
    .option('--recovery-ms <ms>', 'Recovery time in ms', (v) => parseInt(v, 10), DEFAULT_QUOTA_RECOVERY_MS)
    .action((opts) => {
      const store = getStore();
      const result = recordExhaustion(store, {
        provider: opts.provider,
        error: opts.error,
        recoveryMs: opts.recoveryMs,
        actor: 'cli-manual',
      });
      console.log('✓ Quota exhausted (manually)');
      console.log(`  provider:    ${result.provider}`);
      console.log(`  recovery_at: ${result.recovery_at}`);
      console.log(`  hit_count:   ${result.hit_count}`);
      resetStore();
    });

  cmd
    .command('tick')
    .description('Check if quota should be cleared (recovery elapsed)')
    .action(() => {
      const store = getStore();
      const result = tickQuotaRecovery(store);
      console.log('Quota tick:');
      console.log(`  recovered:       ${result.recovered}`);
      console.log(`  released_tasks:  ${result.released_tasks}`);
      console.log(`  previous_status: ${result.previous_status}`);
      console.log(`  current_status:  ${result.current_status}`);
      resetStore();
    });

  return cmd;
}
