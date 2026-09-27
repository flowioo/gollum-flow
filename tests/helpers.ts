/**
 * Test helpers — create isolated in-memory SQLite stores per test.
 */

import { Store } from '../src/workflow/store/store.js';
import { join } from 'node:path';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';

export function makeTestStore(): { store: Store; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'gollum-test-'));
  const dbPath = join(dir, 'test.db');
  const migrationDir = join(process.cwd(), 'src/workflow/store/migrations');
  const store = new Store(dbPath, migrationDir);
  return {
    store,
    cleanup: () => {
      store.close();
      // best-effort cleanup; OS will reclaim tmp dir eventually
    },
  };
}