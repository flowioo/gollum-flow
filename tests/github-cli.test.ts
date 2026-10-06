/**
 * `gollum github` command contract.
 *
 * These were MCP tools before the MCP layer was removed and had no CLI entry
 * point at all, so the "fix a GitHub issue" workflow had nowhere to start. The
 * first cut of this CLI had a bug the obvious smoke test could not see: commander
 * passes declared positionals *as positional parameters*, not as an object, so
 * `gollum github search "flaky test"` silently sent an empty query to the API
 * and returned 57 million issues. It looked like it worked.
 *
 * So these tests assert the query actually reaches GitHub: a nonsense term must
 * return nothing, not the whole index.
 *
 * Network tests skip when unauthenticated. They are read-only and cheap.
 */

import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const CLI = join(ROOT, 'dist', 'cli', 'index.js');

const built = existsSync(CLI);
const skip = built ? false : 'dist/ not built — run `npm run build` first';
const networkSkip = skip || (process.env.GOLLUM_NETWORK_TESTS !== '1' && 'opt in with GOLLUM_NETWORK_TESTS=1');

let dbDir: string;
let env: NodeJS.ProcessEnv;

function gollum(args: string[]): { out: string; code: number } {
  try {
    const out = execFileSync(process.execPath, [CLI, ...args], {
      env,
      timeout: 20000,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { out, code: 0 };
  } catch (e) {
    const err = e as { stdout?: string; stderr?: string; status?: number };
    return {
      out: `${err.stdout ?? ''}${err.stderr ?? ''}`,
      code: typeof err.status === 'number' ? err.status : 1,
    };
  }
}

before(() => {
  dbDir = mkdtempSync(join(tmpdir(), 'gollum-gh-'));
  env = { ...process.env, GOLLUM_DB_PATH: join(dbDir, 'gh.db') };
  if (process.env.GOLLUM_NETWORK_TESTS !== '1') { env.GITHUB_TOKEN = 'fixture-token'; delete env.GH_TOKEN; }
});

/** Read-only GitHub calls need a token to be useful; skip the network otherwise. */
function authenticated(): boolean {
  return gollum(['github', 'auth']).code === 0;
}

test('github auth reports which credential is in use', { skip }, () => {
  const { out, code } = gollum(['github', 'auth']);
  assert.match(out, /GITHUB_TOKEN|GH_TOKEN|gh auth token|no GitHub token/);
  assert.ok(code === 0 || code === 1, `unexpected code ${code}: ${out}`);
});

test('github auth falls back to the gh CLI credential store', { skip }, () => {
  const binDir = mkdtempSync(join(tmpdir(), 'gollum-gh-bin-'));
  const gh = join(binDir, 'gh');
  writeFileSync(gh, '#!/bin/sh\nprintf "fixture-token\\n"\n');
  chmodSync(gh, 0o755);
  const previous = env;
  try {
    env = { ...env, PATH: `${binDir}:${env.PATH}`, GITHUB_TOKEN: '', GH_TOKEN: '' };
    const { out, code } = gollum(['github', 'auth']);
    assert.equal(code, 0);
    assert.match(out, /gh auth token/);
    assert.doesNotMatch(out, /fixture-token/);
  } finally { env = previous; }
});

test('github --help lists every subcommand', { skip }, () => {
  const { out, code } = gollum(['github', '--help']);
  assert.equal(code, 0, out);
  for (const sub of ['search', 'issue', 'fork', 'pr', 'repo', 'auth']) {
    assert.match(out, new RegExp(`\\b${sub}\\b`), `github --help is missing "${sub}"`);
  }
});

test('a nonsense search term returns nothing, not the whole index', { skip: networkSkip }, () => {
  // Regression: the query used to be dropped, so this matched every open issue
  // on GitHub and the command looked like it was working.
  const { out, code } = gollum([
    'github', 'search', 'zzqxv_nonexistent_term_99871zzq', '--limit', '3',
  ]);
  assert.equal(code, 0, out);
  const found = Number(/found (\d+) issue/.exec(out)?.[1] ?? '-1');
  assert.equal(found, 0, `query was ignored — GitHub returned ${found} issues for a nonsense term:\n${out.slice(0, 300)}`);
});

test('search output carries an actionable owner/repo#number', { skip: networkSkip }, () => {
  if (!authenticated()) return; // read-only calls still work unauthenticated, but be gentle
  const { out, code } = gollum(['github', 'search', 'is:issue typo', '--limit', '2']);
  assert.equal(code, 0, out);
  const refs = [...out.matchAll(/^\s{2}(\S+)\/(\S+)#(\d+)\s{2}/gm)];
  if (refs.length === 0) return; // no results right now; nothing to assert
  for (const [, owner, repo, num] of refs) {
    assert.ok(owner && repo && num, `malformed ref in output: ${owner}/${repo}#${num}`);
  }
});

test('search --json emits parseable JSON', { skip: networkSkip }, () => {
  const { out, code } = gollum(['github', 'search', 'is:issue typo', '--limit', '1', '--json']);
  assert.equal(code, 0, out);
  const parsed = JSON.parse(out);
  assert.ok(typeof parsed.ok === 'boolean');
  assert.ok(Array.isArray(parsed.issues));
  for (const i of parsed.issues) {
    assert.ok('owner' in i && 'repo' in i, 'search results must carry owner/repo so callers need not re-parse');
  }
});

test('github issue rejects a malformed owner/repo', { skip }, () => {
  const { out, code } = gollum(['github', 'issue', 'notownerrepo', '1']);
  assert.notEqual(code, 0);
  assert.match(out, /expected owner\/repo/);
});

test('github issue surfaces a 404 rather than crashing', { skip: networkSkip }, () => {
  const { out, code } = gollum(['github', 'issue', 'cli/cli', '99999999']);
  assert.notEqual(code, 0);
  assert.match(out, /could not read issue/);
  assert.doesNotMatch(out, /TypeError|Cannot read properties/);
});

test('github issue prints title, state and body', { skip: networkSkip }, () => {
  if (!authenticated()) return;
  const { out, code } = gollum(['github', 'issue', 'cli/cli', '11014']);
  assert.equal(code, 0, out);
  assert.match(out, /^#11014\s+\S/m, out.slice(0, 200));
  assert.match(out, /state: (open|closed)/);
});

test('github repo fails cleanly outside a git repo', { skip }, () => {
  const { out, code } = gollum(['github', 'repo', '-C', dbDir]);
  assert.notEqual(code, 0);
  assert.match(out, /no git remote origin/);
  assert.doesNotMatch(out, /TypeError/);
});

test('github repo infers owner/repo from origin', { skip }, () => {
  execFileSync('git', ['init', '-q', '.'], { cwd: dbDir, stdio: 'ignore' });
  execFileSync('git', ['remote', 'add', 'origin', 'git@github.com:cli/cli.git'], { cwd: dbDir, stdio: 'ignore' });
  const { out, code } = gollum(['github', 'repo', '-C', dbDir]);
  assert.equal(code, 0, out);
  assert.match(out, /repo:\s+cli\/cli/);
});

test('github pr requires head, base and title', { skip }, () => {
  // Commander reports only the first missing required option per run, so probe
  // each one separately rather than expecting all three in one message.
  const missing = (args: string[]) => gollum(args).out;
  assert.match(missing(['github', 'pr', 'cli/cli']), /head/);
  assert.match(missing(['github', 'pr', 'cli/cli', '-H', 'me:fix/x']), /base/);
  assert.match(missing(['github', 'pr', 'cli/cli', '-H', 'me:fix/x', '-B', 'main']), /title/);
});

test('the fix-issue skill is present and wired to real commands', { skip }, () => {
  const skill = join(ROOT, 'src', 'skills', 'core', 'fix-issue', 'SKILL.md');
  assert.ok(existsSync(skill), 'fix-issue/SKILL.md is missing');
  const md = readFileSync(skill, 'utf-8');
  assert.match(md, /^name:\s*gollum-fix-issue$/m);
  // The safety properties the workflow depends on.
  assert.match(md, /--draft/, 'must open the PR as a draft');
  assert.match(md, /不要自动 `gh pr ready`|不要自动 gh pr ready/, 'must not auto-mark the PR ready');
  assert.match(md, /gollum github search/);
  assert.match(md, /gollum github issue/);
  // It must be present in the built bundle too, or it will not be installed.
  assert.ok(
    existsSync(join(ROOT, 'dist', 'skills', 'core', 'fix-issue', 'SKILL.md')),
    'fix-issue is not in dist/ — run `npm run build`',
  );
});

test('the fix-issue skill extracts exactly one ULID per id', () => {
  // `gollum goal create` prints "✓ Goal created: <id>" and then the whole goal
  // as JSON, so a bare `grep -oE '[0-9A-Z]{26}'` yields the goal id *and* the
  // project id. The next command then fails with "goals not found: <id>\n<id>".
  // Rehearsing the skill end to end is the only way this shows up; assert it.
  const md = readFileSync(join(ROOT, 'src', 'skills', 'core', 'fix-issue', 'SKILL.md'), 'utf-8');
  const extractions = [...md.matchAll(/grep -oE '\[0-9A-Z\]\{26\}'(\s*\|\s*head -1)?/g)];
  assert.ok(extractions.length >= 5, `expected the id-extraction snippets, found ${extractions.length}`);
  for (const m of extractions) {
    assert.ok(m[1], `ULID extraction is missing "| head -1": ${m[0]}`);
  }
});

// --- the confirmation gate -------------------------------------------------
// A real session created a Goal with no confirmation and no plan preview: the
// agent searched, asked which issue, cloned the repo, and only then created the
// Goal — the user saw a clone and some greps and concluded "it never made a
// goal, it just started editing". `gollum goal` has create/list/show and no
// delete, so a Goal created without asking is permanent.
//
// These assertions are deliberately about ordering and required text, not about
// prose quality: the gate is only real if it is written down.

const SKILL_DIR = join(ROOT, 'src', 'skills', 'core');

function skillBody(name: string): string {
  return readFileSync(join(SKILL_DIR, name, 'SKILL.md'), 'utf-8');
}

test('every goal-creating skill has a clarity score', () => {
  for (const s of ['plan', 'fix-issue']) {
    const md = skillBody(s);
    assert.match(md, /清晰度/, `${s} does not score how clear the request is`);
    assert.match(md, /4[–-]5/, `${s} has no "clear" band`);
    assert.match(md, /2[–-]3/, `${s} has no "vague" band`);
    assert.match(md, /0[–-]1/, `${s} has no "unclear" band`);
  }
});

test('every goal-creating skill gates goal creation on user confirmation', () => {
  for (const s of ['plan', 'fix-issue']) {
    const md = skillBody(s);
    assert.match(
      md,
      /确认/,
      `${s} never mentions confirming the plan with the user`,
    );
    // The gate has to be stated as a prohibition, not just a suggestion.
    assert.match(
      md,
      /确认前[^。\n]*不(?:落库|执行)|不要在用户确认前|不落库/,
      `${s} does not state that nothing may be created before confirmation`,
    );
  }
});

test('the confirmation gate explains that goals cannot be deleted', () => {
  // This is the reason the gate exists; if gollum ever grows `goal delete`,
  // this test should be revisited rather than left to rot.
  for (const s of ['plan', 'fix-issue']) {
    assert.match(
      skillBody(s),
      /没有 ?delete|删不掉/,
      `${s} does not explain why confirmation is required (no goal delete)`,
    );
  }
});

test('plan scores five concrete dimensions, not a vibe', () => {
  const md = skillBody('plan');
  for (const dim of ['复现', '期望', '定位线索', '验收标准', '范围']) {
    assert.ok(md.includes(dim), `the clarity rubric is missing the "${dim}" dimension`);
  }
});

test('fix-issue documents the autoresearch loop: baseline, commit-then-try, revert', () => {
  const md = skillBody('fix-issue');
  assert.match(md, /baseline|基线/i, 'no baseline step — you cannot tell if a change helped');
  // The revert is only clean if every attempt is committed first.
  const commitIdx = md.search(/git add -A && git commit/);
  const resetIdx = md.search(/git reset --hard/);
  assert.ok(commitIdx > -1, 'no "commit each attempt" step, so git reset cannot revert cleanly');
  assert.ok(resetIdx > -1, 'no git reset rollback step');
  assert.ok(
    commitIdx < resetIdx,
    'rollback is described before the commit step; a revert needs something to revert to',
  );
});

test('fix-issue says what to do when the user does not answer', () => {
  const md = skillBody('fix-issue');
  assert.match(md, /没(?:有)?回应|没回|迟迟不/, 'does not handle a non-responsive user');
  assert.match(md, /探索/, 'no autonomous exploration fallback');
  assert.match(md, /回退/, 'no rollback fallback');
});
