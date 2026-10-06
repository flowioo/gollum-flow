import { resolve, isAbsolute } from 'node:path';

export interface CommandSpec { argv: string[]; timeout_ms?: number }
export interface ImprovementConfig {
  repo: string;
  objective: string;
  checks: CommandSpec[];
  probe_command: string[];
  test_directory: string;
  allowed_paths: string[];
  protected_paths: string[];
  dependency_dirs: string[];
  host: { kind: 'claude' | 'command'; executable: string; args: string[] };
  max_iterations: number;
  max_failures: number;
  max_duration_ms: number;
  call_timeout_ms: number;
  max_cost_usd: number;
  cost_per_call_usd: number;
  cooldown_ms: number;
  apply: boolean;
}

export function safeRelative(path: string): boolean {
  return !!path && !isAbsolute(path) && !path.includes('\\') && !path.includes('\0') &&
    path.split('/').every(p => !!p && p !== '..' && p !== '.' && p !== '.git') && !path.startsWith('-');
}
function argv(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || !value.length || value.some(v => typeof v !== 'string' || !v || v.includes('\0'))) {
    throw new Error(`${label} must be a nonempty argv array`);
  }
  return value as string[];
}
function positive(value: unknown, fallback: number, label: string, integer = false): number {
  const n = value === undefined ? fallback : value;
  if (typeof n !== 'number' || !Number.isFinite(n) || n <= 0 || (integer && !Number.isSafeInteger(n))) throw new Error(`Invalid ${label}`);
  return n;
}
function paths(value: unknown, fallback: string[], label: string): string[] {
  const result = value ?? fallback;
  if (!Array.isArray(result) || result.some(p => typeof p !== 'string' || !safeRelative(p))) throw new Error(`Invalid ${label}`);
  return result;
}
export function parseConfig(input: unknown, base = process.cwd()): ImprovementConfig {
  if (!input || typeof input !== 'object') throw new Error('Expected a configuration object');
  const x = input as Record<string, any>;
  if (typeof x.repo !== 'string' || !x.repo || typeof x.objective !== 'string' || !x.objective.trim()) throw new Error('repo and objective are required');
  if (!Array.isArray(x.checks) || !x.checks.length) throw new Error('At least one independent check is required');
  const host = x.host ?? { kind: 'claude', executable: 'claude', args: [] };
  if (!['claude', 'command'].includes(host.kind) || typeof host.executable !== 'string' || !host.executable) throw new Error('Invalid host');
  if (host.args !== undefined && (!Array.isArray(host.args) || host.args.some((a: unknown) => typeof a !== 'string'))) throw new Error('Invalid host args');
  const probe = argv(x.probe_command, 'probe_command');
  if (!probe.some(a => a.includes('{test}'))) throw new Error('probe_command must contain {test}');
  const config: ImprovementConfig = {
    repo: resolve(base, x.repo), objective: x.objective.trim(),
    checks: x.checks.map((c: any) => ({ argv: argv(c?.argv, 'check.argv'), timeout_ms: positive(c?.timeout_ms, 120000, 'check.timeout_ms') })),
    probe_command: probe, test_directory: x.test_directory ?? 'tests',
    allowed_paths: paths(x.allowed_paths, ['src'], 'allowed_paths'),
    protected_paths: paths(x.protected_paths, ['package.json', 'package-lock.json', 'tsconfig.json', 'tests'], 'protected_paths'),
    dependency_dirs: paths(x.dependency_dirs, ['node_modules'], 'dependency_dirs'),
    host: { kind: host.kind, executable: host.executable, args: host.args ?? [] },
    max_iterations: positive(x.max_iterations, 3, 'max_iterations', true),
    max_failures: positive(x.max_failures, 3, 'max_failures', true),
    max_duration_ms: positive(x.max_duration_ms, 1800000, 'max_duration_ms'),
    call_timeout_ms: positive(x.call_timeout_ms, 300000, 'call_timeout_ms'),
    max_cost_usd: positive(x.max_cost_usd, 3, 'max_cost_usd'),
    cost_per_call_usd: positive(x.cost_per_call_usd, 0.5, 'cost_per_call_usd'),
    cooldown_ms: positive(x.cooldown_ms, 60000, 'cooldown_ms'),
    apply: x.apply === true,
  };
  if (!safeRelative(config.test_directory) || !config.allowed_paths.length) throw new Error('Test directory and allowed paths are required');
  if (config.cost_per_call_usd > config.max_cost_usd) throw new Error('Per-call cost exceeds total budget');
  return config;
}
export const withinPaths = (path: string, prefixes: string[]) => prefixes.some(p => path === p || path.startsWith(p + '/'));
