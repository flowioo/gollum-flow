import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { pathToFileURL } from 'node:url';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { runProcess } from '../dist/autonomy/process.js';

test('timeout kills the full child group and preserves bounded logs', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'gollum-process-')), marker = join(dir, 'ticks');
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const grandchild = `setInterval(()=>require('node:fs').appendFileSync(${JSON.stringify(marker)},'.'),10)`;
  const script = `require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(grandchild)}],{stdio:'inherit'}); console.log('started'); setInterval(()=>{},1000);`;
  const result = await runProcess({ argv: [process.execPath, '-e', script], cwd: dir, log: join(dir, 'out.log'), timeout_ms: 500 });
  assert.equal(result.reason, 'timeout');
  assert.match(result.stdout, /started/);
  const count = readFileSync(marker).length;
  await delay(100);
  assert.equal(readFileSync(marker).length, count, 'grandchild must stop writing after timeout');
});

test('cancellation terminates the active process and does not report success', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'gollum-cancel-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const controller = new AbortController();
  const result = await runProcess({ argv: [process.execPath, '-e', 'setInterval(()=>{},1000)'], cwd: dir,
    log: join(dir, 'out.log'), timeout_ms: 5000, signal: controller.signal,
    onStart: () => setTimeout(() => controller.abort(), 50) });
  assert.equal(result.reason, 'cancelled');
  assert.notEqual(result.code, 0);
});

test('SIGKILL of the controller stops its orphaned editing host', { skip: process.platform === 'win32' }, async t => {
  const dir = mkdtempSync(join(tmpdir(), 'gollum-orphan-'));
  const ticks = join(dir, 'ticks'), pidFile = join(dir, 'group-pid'), script = join(dir, 'controller.mjs');
  writeFileSync(script, `
import {writeFileSync} from 'node:fs';
import {runProcess} from ${JSON.stringify(pathToFileURL(join(process.cwd(), 'dist/autonomy/process.js')).href)};
await runProcess({argv:[process.execPath,'-e',${JSON.stringify(`setInterval(()=>require('node:fs').appendFileSync(${JSON.stringify(ticks)},'.'),10)`)}],
 cwd:${JSON.stringify(dir)},log:${JSON.stringify(join(dir, 'output.log'))},timeout_ms:10000,
 onStart:pid=>writeFileSync(${JSON.stringify(pidFile)},String(pid))});
`);
  const controller = spawn(process.execPath, [script], { stdio: 'ignore' });
  t.after(() => {
    controller.kill('SIGKILL');
    if (existsSync(pidFile)) { try { process.kill(-Number(readFileSync(pidFile, 'utf8')), 'SIGKILL'); } catch { /* already reaped */ } }
    rmSync(dir, { recursive: true, force: true });
  });
  const deadline = Date.now() + 3000;
  while (!existsSync(ticks) && Date.now() < deadline) await delay(20);
  assert.ok(existsSync(ticks), 'editing host must be active before killing the controller');
  const closed = once(controller, 'close');
  controller.kill('SIGKILL'); await closed;
  await delay(600);
  const count = readFileSync(ticks).length;
  await delay(150);
  assert.equal(readFileSync(ticks).length, count, 'orphaned host must stop editing after controller death');
});
