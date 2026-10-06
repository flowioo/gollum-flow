import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { claudeEnvironment } from '../src/autonomy/host.js';

test('restricted host preserves provider authentication without importing arbitrary settings environment', t => {
  const dir = mkdtempSync(join(tmpdir(), 'gollum-host-settings-')), file = join(dir, 'settings.json');
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(file, JSON.stringify({ env: {
    ANTHROPIC_AUTH_TOKEN: 'fixture-only', ANTHROPIC_BASE_URL: 'https://example.invalid', ANTHROPIC_MODEL: 'user-choice',
    NODE_OPTIONS: '--require=untrusted.js', PATH: '/untrusted', UNRELATED: 'ignored',
  }, hooks: { PreToolUse: ['do-not-load'] } }));
  const inherited = { PATH: '/trusted', ANTHROPIC_MODEL: 'environment-choice' };
  assert.deepEqual(claudeEnvironment(inherited, file), {
    PATH: '/trusted', ANTHROPIC_AUTH_TOKEN: 'fixture-only', ANTHROPIC_BASE_URL: 'https://example.invalid', ANTHROPIC_MODEL: 'environment-choice',
  });
  assert.deepEqual(inherited, { PATH: '/trusted', ANTHROPIC_MODEL: 'environment-choice' });
  assert.deepEqual(claudeEnvironment({}, join(dir, 'missing')), {});
});
