import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, readlinkSync, realpathSync } from 'node:fs';
import { resolve, join } from 'node:path';

export interface EvidenceScope {
  cwd: string;
  repo_root: string;
  head: string;
  digest: string;
}

/** Hash tracked and non-ignored untracked contents. Store hashes, never file contents. */
export function captureEvidenceScope(cwd: string): EvidenceScope | null {
  try {
    const git = (args: string[]) => execFileSync('git', args, {
      cwd, encoding: 'utf8', timeout: 5000, maxBuffer: 4 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const repo = git(['rev-parse', '--show-toplevel']).trim();
    const head = git(['rev-parse', 'HEAD']).trim();
    const files = [...new Set(git(['-C', repo, 'ls-files', '-z', '--cached', '--others', '--exclude-standard']).split('\0').filter(Boolean))].sort();
    if (files.length > 10000) return null;
    const hash = createHash('sha256');
    hash.update(head);
    let size = 0;
    for (const file of files) {
      const path = join(repo, file);
      hash.update('\0' + file + '\0');
      let stat;
      try { stat = lstatSync(path); } catch { hash.update('missing'); continue; }
      size += stat.size;
      if (size > 32 * 1024 * 1024 || stat.isDirectory()) return null;
      hash.update(String(stat.mode));
      hash.update(stat.isSymbolicLink() ? readlinkSync(path) : readFileSync(path));
    }
    return { cwd: realpathSync(resolve(cwd)), repo_root: repo, head, digest: hash.digest('hex') };
  } catch { return null; }
}

export function evidenceIsCurrent(data: Record<string, any> | null, verifier: unknown): boolean {
  if (!data?.scope) return true; // legacy/manual evidence is an explicit trust boundary
  if (data.verifier_spec !== JSON.stringify(verifier)) return false;
  const current = captureEvidenceScope(data.scope.cwd);
  return current !== null && current.digest === data.scope.digest && current.head === data.scope.head;
}
