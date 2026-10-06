import type { Task } from '../workflow/model/types.js';

/** A fenced claim's token is a generation identifier, not an authentication secret. */
export function assertTaskLease(task: Task, token?: string): void {
  if (!task.lease_token) return; // legacy/manual callers remain compatible
  if (token !== task.lease_token || !task.owner || !task.lease_until ||
      new Date(task.lease_until).getTime() <= Date.now()) {
    throw new Error('STALE_LEASE: claim the task again before writing');
  }
}
