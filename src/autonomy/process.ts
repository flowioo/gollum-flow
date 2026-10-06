import { spawn } from 'node:child_process';
import { openSync, closeSync, writeSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

export interface ProcessResult {
  code: number | null; signal: string | null; stdout: string; stderr: string;
  reason: 'exit' | 'timeout' | 'cancelled' | 'output_limit' | 'spawn_error'; duration_ms: number; log: string;
}
export async function runProcess(options: {
  argv: string[]; cwd: string; log: string; timeout_ms: number; input?: string;
  signal?: AbortSignal; env?: NodeJS.ProcessEnv; onStart?: (pid: number) => void;
}): Promise<ProcessResult> {
  if (options.signal?.aborted) return { code: null, signal: null, stdout: '', stderr: '', reason: 'cancelled', duration_ms: 0, log: options.log };
  mkdirSync(dirname(options.log), { recursive: true });
  const fd = openSync(options.log, 'w', 0o600);
  const started = Date.now();
  return new Promise(resolve => {
    let reason: ProcessResult['reason'] = 'exit';
    let stdout = '', stderr = '', bytes = 0, finished = false;
    let killTimer: NodeJS.Timeout | undefined;
    const launcher = fileURLToPath(new URL('./process-child.js', import.meta.url));
    const child = spawn(process.execPath, [launcher, ...options.argv], {
      cwd: options.cwd, env: options.env ?? process.env, detached: process.platform !== 'win32',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const kill = (signal: NodeJS.Signals) => {
      if (!child.pid) return;
      try { process.platform === 'win32' ? child.kill(signal) : process.kill(-child.pid, signal); } catch { /* exited */ }
    };
    const stop = (why: ProcessResult['reason']) => {
      if (finished || reason !== 'exit') return;
      reason = why; kill('SIGTERM');
      killTimer = setTimeout(() => kill('SIGKILL'), 500);
    };
    const timeout = setTimeout(() => stop('timeout'), options.timeout_ms);
    const abort = () => stop('cancelled');
    options.signal?.addEventListener('abort', abort, { once: true });
    const collect = (chunk: Buffer, stream: 'stdout' | 'stderr') => {
      bytes += chunk.length;
      if (bytes <= 16 * 1024 * 1024) writeSync(fd, chunk);
      else stop('output_limit');
      const text = chunk.toString('utf8');
      if (stream === 'stdout') stdout = (stdout + text).slice(-4 * 1024 * 1024);
      else stderr = (stderr + text).slice(-128 * 1024);
    };
    child.stdout.on('data', c => collect(c, 'stdout'));
    child.stderr.on('data', c => collect(c, 'stderr'));
    child.stdin.on('error', () => { /* terminated before consuming input */ });
    child.on('spawn', () => {
      try { options.onStart?.(child.pid!); child.stdin.end(options.input ?? ''); }
      catch (error) { stderr += String(error); stop('cancelled'); }
    });
    child.on('error', error => { stderr += error.message; reason = 'spawn_error'; });
    child.on('close', (code, signal) => {
      finished = true;
      clearTimeout(timeout); if (killTimer) clearTimeout(killTimer);
      // A shell/host can exit before its children; never leave its process group behind.
      kill('SIGKILL');
      options.signal?.removeEventListener('abort', abort); closeSync(fd);
      resolve({ code, signal, stdout, stderr, reason, duration_ms: Date.now() - started, log: options.log });
    });
  });
}
