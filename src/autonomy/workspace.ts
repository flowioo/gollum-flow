import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, chmodSync, realpathSync, cpSync, rmSync, renameSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { safeRelative, withinPaths } from './config.js';

function git(cwd: string, args: string[]): string {
  return execFileSync('git', ['-c', 'core.hooksPath=/dev/null', ...args], {
    cwd, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024,
    env: gitEnvironment(),
  });
}
function gitEnvironment(): NodeJS.ProcessEnv {
  // Caller Git index/worktree overrides must not redirect experiment operations into another checkout.
  return { ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_'))),
    GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0' };
}
function canonicalDestination(path: string): string {
  const parts: string[] = [];
  let current = resolve(path);
  while (!existsSync(current)) {
    const parent = dirname(current);
    if (parent === current) throw new Error('Cannot resolve workspace destination');
    parts.unshift(current.slice(parent.length + (parent.endsWith('/') ? 0 : 1)));
    current = parent;
  }
  return join(realpathSync(current), ...parts);
}
function files(repo: string): string[] {
  return [...new Set(git(repo, ['ls-files', '-z', '--cached', '--others', '--exclude-standard']).split('\0').filter(Boolean))];
}
export function regular(root: string, path: string): boolean {
  if (!safeRelative(path)) throw new Error(`Unsafe workspace path: ${path}`);
  let current = root;
  for (const part of path.split('/')) {
    current = join(current, part);
    let stat;
    try { stat = lstatSync(current); }
    catch (error: any) { if (error.code === 'ENOENT') return false; throw error; }
    if (stat.isSymbolicLink()) throw new Error(`Workspace symlink is not supported: ${path}`);
  }
  if (!lstatSync(current).isFile()) throw new Error(`Not a regular workspace file: ${path}`);
  return true;
}

/** Snapshot the actual checkout, including uncommitted and nonignored new files. */
export function snapshotWorkspace(source: string, destination: string): string {
  source = realpathSync(source); destination = canonicalDestination(destination);
  if (destination === source || destination.startsWith(source + '/')) throw new Error('Snapshot must be outside the source repository');
  if (existsSync(destination)) throw new Error('Snapshot destination already exists');
  const root = git(source, ['rev-parse', '--show-toplevel']).trim();
  if (realpathSync(root) !== source) throw new Error('Source must be the repository root');
  const entries = files(source).filter(path => regular(source, path));
  if (!entries.length) throw new Error('Cannot experiment on an empty repository');
  mkdirSync(destination, { recursive: true });
  for (const path of entries) {
    const target = join(destination, path);
    mkdirSync(dirname(target), { recursive: true });
    copyFileSync(join(source, path), target);
    chmodSync(target, lstatSync(join(source, path)).mode & 0o777);
  }
  git(destination, ['init', '-q']);
  git(destination, ['add', '-f', '--', ...entries]);
  return commitWorkspace(destination, 'Snapshot before autonomous experiments');
}

export function commitWorkspace(repo: string, message: string): string {
  git(repo, ['add', '-A']);
  git(repo, ['-c', 'user.name=Gollum', '-c', 'user.email=gollum@localhost', 'commit', '-q', '--no-gpg-sign', '-m', message]);
  return git(repo, ['rev-parse', 'HEAD']).trim();
}

export function createCandidate(accepted: string, destination: string): string {
  if (existsSync(destination)) throw new Error('Candidate destination already exists');
  git(accepted, ['clone', '--no-hardlinks', '--quiet', '--', resolve(accepted), resolve(destination)]);
  return git(destination, ['rev-parse', 'HEAD']).trim();
}

/** Apply only the accepted diff; reject concurrent edits instead of resetting user work. */
export function applyVerifiedChanges(previous: string, accepted: string, source: string): 'applied' | 'already_applied' {
  const base = git(previous, ['rev-parse', 'HEAD']).trim();
  const changed = git(accepted, ['diff', '--name-only', '-z', base, 'HEAD']).split('\0').filter(Boolean);
  const equal = (a: string, b: string, path: string) => {
    const left = regular(a, path), right = regular(b, path);
    return left === right && (!left || (readFileSync(join(a, path)).equals(readFileSync(join(b, path))) &&
      (lstatSync(join(a, path)).mode & 0o111) === (lstatSync(join(b, path)).mode & 0o111)));
  };
  if (changed.every(path => equal(source, accepted, path))) return 'already_applied';
  for (const path of changed) if (!equal(source, previous, path)) throw new Error(`Source changed concurrently: ${path}; accepted improvement retained in ${accepted}`);
  const patch = git(accepted, ['diff', '--binary', '--no-ext-diff', '--no-textconv', base, 'HEAD']);
  const apply = (args: string[]) => execFileSync('git', ['-c', 'core.hooksPath=/dev/null', 'apply', ...args, '-'], {
    cwd: source, input: patch, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, env: gitEnvironment(),
  });
  apply(['--check']); apply([]);
  if (!changed.every(path => equal(source, accepted, path))) throw new Error('Applied files do not match accepted improvement');
  return 'applied';
}

/** Dependencies are private copies: test/build commands cannot write into the source checkout. */
export function copyDependencies(source: string, destination: string, directories: string[]): void {
  for (const directory of directories) {
    if (!safeRelative(directory)) throw new Error('Unsafe dependency path');
    const from = join(source, directory), to = join(destination, directory);
    if (!existsSync(from) || existsSync(to)) continue;
    mkdirSync(dirname(to), { recursive: true });
    cpSync(from, to, { recursive: true, dereference: true, errorOnExist: true });
    // Keep private dependencies out of commits, independently of project ignore rules.
    const exclude = join(destination, '.git', 'info', 'exclude');
    const old = readFileSync(exclude, 'utf8');
    // Configuration restricts directory paths; escaping covers Git ignore metacharacters.
    const escaped = [...directory].map(c => '*?[]#! '.includes(c) ? '\\' + c : c).join('');
    writeFileSync(exclude, old + '\n/' + escaped + '/\n');
  }
}

export function workspaceDigest(repo: string, extra: string[] = []): string {
  const hash = createHash('sha256');
  for (const path of [...new Set([...files(repo), ...extra])].sort()) {
    if (!regular(repo, path)) continue;
    hash.update(path); hash.update('\0');
    hash.update(String(lstatSync(join(repo, path)).mode & 0o111)); hash.update('\0');
    hash.update(readFileSync(join(repo, path))); hash.update('\0');
  }
  return hash.digest('hex');
}

/** Rebuild accepted state from the trusted baseline plus only the verified paths. */
export function promoteCandidate(accepted: string, candidate: string, destination: string,
  changed: string[], expectedDigest: string, message: string): string {
  if (workspaceDigest(candidate, changed) !== expectedDigest) throw new Error('Candidate changed after verification');
  const temporary = destination + '.preparing';
  // These paths are exclusively owned by this run. Never reset or commit the user's checkout.
  if (existsSync(destination)) {
    if (workspaceDigest(destination, changed) !== expectedDigest) throw new Error('Previously promoted workspace does not match verified candidate');
    return destination;
  }
  if (existsSync(temporary)) rmSync(temporary, { recursive: true, force: true });
  createCandidate(accepted, temporary);
  for (const path of changed) {
    if (!safeRelative(path)) throw new Error('Unsafe promotion path');
    if (regular(candidate, path)) {
      mkdirSync(dirname(join(temporary, path)), { recursive: true });
      copyFileSync(join(candidate, path), join(temporary, path));
      chmodSync(join(temporary, path), lstatSync(join(candidate, path)).mode & 0o777);
      git(temporary, ['add', '-f', '--', path]);
    } else rmSync(join(temporary, path), { force: true });
  }
  commitWorkspace(temporary, message);
  renameSync(temporary, destination);
  return destination;
}

/** Compare bytes rather than trusting ignore rules or the candidate's Git index. */
export function inspectCandidate(accepted: string, candidate: string, options: {
  allowed: string[]; protected: string[]; test_path: string; test_content: string;
}): string[] {
  const baseline = files(accepted);
  const all = new Set([...baseline, ...files(candidate)]);
  all.add(options.test_path);
  const changed: string[] = [];
  for (const path of all) {
    const before = regular(accepted, path), after = regular(candidate, path);
    if (before && after && readFileSync(join(accepted, path)).equals(readFileSync(join(candidate, path))) &&
        (lstatSync(join(accepted, path)).mode & 0o111) === (lstatSync(join(candidate, path)).mode & 0o111)) continue;
    if (!before && !after) continue;
    changed.push(path);
    if (path === options.test_path) {
      if (before || !after || readFileSync(join(candidate, path), 'utf8') !== options.test_content) throw new Error('Regression test was altered or already existed');
    } else if (!withinPaths(path, options.allowed) || withinPaths(path, options.protected)) {
      throw new Error(`Change outside implementation scope: ${path}`);
    }
  }
  if (!changed.includes(options.test_path)) throw new Error('Missing regression test');
  if (!changed.some(path => path !== options.test_path)) throw new Error('No implementation improvement');
  return changed;
}
