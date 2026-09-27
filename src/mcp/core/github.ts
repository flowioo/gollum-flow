/**
 * GitHub Tools for gollum MCP (V0.5)
 *
 * Exposes minimal GitHub operations needed to find and fix a bug → submit PR:
 *   github.search_issues        — 搜 open issues (good-first-issue 等)
 *   github.get_issue            — 读单个 issue（含 body / labels / state）
 *   github.create_pr_compare    — 生成 compare URL（无需 token）；实际 PR 提交靠 gh/web
 *
 * Auth: 优先 GITHUB_TOKEN (PAT)；缺失则降级到 unauthenticated（rate-limited 60/h）。
 *       create_pr_compare 不需要 token；它只生成 URL。
 *
 * 真实提 PR 仍需在 CC 里配 GITHUB_TOKEN 或 `gh auth login`。
 */

import { execSync } from 'node:child_process';

const GH_API = 'https://api.github.com';
const GH_TOKEN = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN ?? '';

function ghHeaders(): Record<string, string> {
  const h: Record<string, string> = {
    'Accept': 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'gollum-mcp/0.5',
  };
  if (GH_TOKEN) h['Authorization'] = `Bearer ${GH_TOKEN}`;
  return h;
}

export interface SearchIssuesArgs {
  query?: string;
  labels?: string[];
  language?: string;
  state?: 'open' | 'closed';
  sort?: 'updated' | 'created' | 'comments';
  order?: 'asc' | 'desc';
  per_page?: number;
  page?: number;
}

export interface GitHubIssue {
  number: number;
  title: string;
  state: 'open' | 'closed';
  html_url: string;
  repository_url: string;
  labels: string[];
  assignee: string | null;
  created_at: string;
  updated_at: string;
  body_excerpt: string;
}

export interface SearchIssuesResult {
  ok: boolean;
  total_count: number;
  issues: GitHubIssue[];
  rate_limit_remaining?: number;
  error?: string;
}

export async function githubSearchIssues(args: SearchIssuesArgs): Promise<SearchIssuesResult> {
  const labels = (args.labels ?? []).map(l => `label:"${l}"`).join(' ');
  const parts = [
    args.query ?? '',
    `is:issue`,
    `is:${args.state ?? 'open'}`,
    args.language ? `language:${args.language}` : '',
    labels,
  ].filter(Boolean);
  const q = parts.join(' ');

  const url = `${GH_API}/search/issues?q=${encodeURIComponent(q)}&sort=${args.sort ?? 'updated'}&order=${args.order ?? 'desc'}&per_page=${Math.min(args.per_page ?? 20, 100)}&page=${args.page ?? 1}`;

  try {
    const resp = await fetch(url, { headers: ghHeaders() });
    const rl = resp.headers.get('x-ratelimit-remaining');
    if (!resp.ok) {
      const text = await resp.text();
      return { ok: false, total_count: 0, issues: [], rate_limit_remaining: rl ? Number(rl) : undefined, error: `HTTP ${resp.status}: ${text.slice(0, 200)}` };
    }
    const data = await resp.json() as any;
    const issues: GitHubIssue[] = (data.items ?? []).map((it: any) => ({
      number: it.number,
      title: it.title,
      state: it.state,
      html_url: it.html_url,
      repository_url: it.repository_url,
      labels: (it.labels ?? []).map((l: any) => typeof l === 'string' ? l : l.name),
      assignee: it.assignee?.login ?? null,
      created_at: it.created_at,
      updated_at: it.updated_at,
      body_excerpt: (it.body ?? '').slice(0, 500),
    }));
    return { ok: true, total_count: data.total_count ?? issues.length, issues, rate_limit_remaining: rl ? Number(rl) : undefined };
  } catch (e: any) {
    return { ok: false, total_count: 0, issues: [], error: e.message ?? String(e) };
  }
}

export interface GetIssueArgs {
  owner: string;
  repo: string;
  issue_number: number;
}

export async function githubGetIssue(args: GetIssueArgs): Promise<{ ok: boolean; issue?: GitHubIssue & { body: string }; error?: string }> {
  const url = `${GH_API}/repos/${args.owner}/${args.repo}/issues/${args.issue_number}`;
  try {
    const resp = await fetch(url, { headers: ghHeaders() });
    if (!resp.ok) {
      return { ok: false, error: `HTTP ${resp.status}: ${await resp.text()}` };
    }
    const it = await resp.json() as any;
    return {
      ok: true,
      issue: {
        number: it.number,
        title: it.title,
        state: it.state,
        html_url: it.html_url,
        repository_url: it.repository_url,
        labels: (it.labels ?? []).map((l: any) => typeof l === 'string' ? l : l.name),
        assignee: it.assignee?.login ?? null,
        created_at: it.created_at,
        updated_at: it.updated_at,
        body_excerpt: (it.body ?? '').slice(0, 500),
        body: it.body ?? '',
      },
    };
  } catch (e: any) {
    return { ok: false, error: e.message ?? String(e) };
  }
}

export interface GetPrArgs {
  owner: string;
  repo: string;
  pr_number: number;
}

export interface GitHubPr {
  number: number;
  title: string;
  state: 'open' | 'closed';
  merged: boolean;
  html_url: string;
  head_ref: string;
  base_ref: string;
  body: string;
  created_at: string;
  updated_at: string;
  user: string | null;
}

export async function githubGetPr(args: GetPrArgs): Promise<{ ok: boolean; pr?: GitHubPr; error?: string }> {
  const url = `${GH_API}/repos/${args.owner}/${args.repo}/pulls/${args.pr_number}`;
  try {
    const resp = await fetch(url, { headers: ghHeaders() });
    if (!resp.ok) {
      return { ok: false, error: `HTTP ${resp.status}: ${await resp.text()}` };
    }
    const pr = await resp.json() as any;
    return {
      ok: true,
      pr: {
        number: pr.number,
        title: pr.title,
        state: pr.state,
        merged: !!pr.merged,
        html_url: pr.html_url,
        head_ref: pr.head?.ref ?? '',
        base_ref: pr.base?.ref ?? '',
        body: pr.body ?? '',
        created_at: pr.created_at,
        updated_at: pr.updated_at,
        user: pr.user?.login ?? null,
      },
    };
  } catch (e: any) {
    return { ok: false, error: e.message ?? String(e) };
  }
}

export interface CreatePrCompareArgs {
  owner: string;
  repo: string;
  head: string;          // e.g. "flowioo:fix/typo" — already-pushed branch on a fork
  base: string;          // e.g. "main"
  title: string;
  body?: string;
}

export interface CreatePrCompareResult {
  ok: boolean;
  compare_url: string;
  web_pr_url: string;
  note: string;
  error?: string;
}

/**
 * Generate a "compare & pull request" URL the user can click to open a PR.
 * Does NOT actually submit the PR (no API token required, no side effects).
 * If GITHUB_TOKEN is set, will also POST to /pulls to actually create the PR.
 */
export async function githubCreatePrCompare(args: CreatePrCompareArgs): Promise<CreatePrCompareResult> {
  const compareUrl = `https://github.com/${args.owner}/${args.repo}/compare/${args.base}...${encodeURIComponent(args.head)}?expand=1`;
  const webPrUrl = `https://github.com/${args.owner}/${args.repo}/pull/new/${encodeURIComponent(args.head)}`;

  const result: CreatePrCompareResult = {
    ok: true,
    compare_url: compareUrl,
    web_pr_url: webPrUrl,
    note: '',
  };

  if (GH_TOKEN) {
    // Has token: actually POST the PR
    try {
      const resp = await fetch(`${GH_API}/repos/${args.owner}/${args.repo}/pulls`, {
        method: 'POST',
        headers: { ...ghHeaders(), 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: args.title,
          head: args.head,
          base: args.base,
          body: args.body ?? '',
        }),
      });
      if (resp.ok) {
        const pr = await resp.json() as any;
        result.note = `PR submitted via API: ${pr.html_url}`;
        return result;
      }
      result.error = `API PR failed: HTTP ${resp.status}: ${(await resp.text()).slice(0, 200)}`;
    } catch (e: any) {
      result.error = e.message ?? String(e);
    }
  } else {
    result.note = 'No GITHUB_TOKEN. Generated compare URL only. User must click to open PR in browser.';
  }
  return result;
}

export interface ForkRepoArgs {
  owner: string;
  repo: string;
  org?: string;          // fork into an org, if user is a member
}

/**
 * Fork a repo using GITHUB_TOKEN. Returns HTML URL of new fork.
 * Requires token with repo scope.
 */
export async function githubForkRepo(args: ForkRepoArgs): Promise<{ ok: boolean; fork_url?: string; error?: string }> {
  if (!GH_TOKEN) {
    return { ok: false, error: 'No GITHUB_TOKEN. Cannot fork via API. User must click "Fork" on GitHub.' };
  }
  const url = `${GH_API}/repos/${args.owner}/${args.repo}/forks`;
  try {
    const resp = await fetch(url, {
      method: 'POST',
      headers: { ...ghHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify(args.org ? { organization: args.org } : {}),
    });
    if (!resp.ok) {
      return { ok: false, error: `HTTP ${resp.status}: ${(await resp.text()).slice(0, 300)}` };
    }
    const fork = await resp.json() as any;
    return { ok: true, fork_url: fork.html_url };
  } catch (e: any) {
    return { ok: false, error: e.message ?? String(e) };
  }
}

/**
 * Detect whether the local repo has a remote pointing at `owner/repo` on GitHub,
 * and whether the user is authenticated via SSH.
 */
export function githubDetectLocalRepo(cwd: string): {
  has_origin: boolean;
  origin_url?: string;
  inferred_owner?: string;
  inferred_repo?: string;
  ssh_ok: boolean;
} {
  let originUrl: string | undefined;
  let sshOk = false;
  try {
    originUrl = execSync('git config --get remote.origin.url', { cwd, encoding: 'utf-8' }).trim();
  } catch {
    return { has_origin: false, ssh_ok: false };
  }

  // Parse owner/repo from various URL formats
  let inferredOwner: string | undefined;
  let inferredRepo: string | undefined;
  const sshMatch = originUrl.match(/git@github\.com:([^/]+)\/(.+?)(?:\.git)?$/);
  const httpsMatch = originUrl.match(/github\.com\/([^/]+)\/(.+?)(?:\.git)?$/);
  if (sshMatch) { inferredOwner = sshMatch[1]; inferredRepo = sshMatch[2]; }
  else if (httpsMatch) { inferredOwner = httpsMatch[1]; inferredRepo = httpsMatch[2]; }

  // Test SSH auth
  try {
    execSync('ssh -T -o StrictHostKeyChecking=accept-new -o ConnectTimeout=5 git@github.com', {
      cwd, encoding: 'utf-8', stdio: 'pipe',
    });
    sshOk = true;
  } catch (e: any) {
    // ssh -T exits non-zero even on success ("successfully authenticated, but GitHub does not provide shell access")
    const out = (e.stdout ?? '') + (e.stderr ?? '');
    sshOk = /successfully authenticated/i.test(out);
  }

  return {
    has_origin: true,
    origin_url: originUrl,
    inferred_owner: inferredOwner,
    inferred_repo: inferredRepo,
    ssh_ok: sshOk,
  };
}