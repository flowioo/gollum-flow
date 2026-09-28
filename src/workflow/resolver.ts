/**
 * Gollum V0.2 Resolver — Project resolution for shell hooks
 *
 * Used by:
 *   - gollum-resolver notify-cwd "$PWD"   (zsh precmd / bash PROMPT_COMMAND)
 *   - gollum-resolver current
 *   - gollum-resolver list
 *
 * Strategy: walk upward from cwd looking for `.gollum/project.yaml`,
 * fall back to the legacy V0.1 SQLite `projects` table for projects
 * created via `gollum project create`.
 */

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { getStore } from './store/store.js';

export interface ResolvedProject {
  project_id: string;
  name: string;
  repo_root: string;
  source: 'project-yaml' | 'registry-db';
}

interface ProjectYaml {
  project_id?: string;
  name?: string;
  workspace?: { type?: string; root?: string };
}

async function resolveFromYaml(cwd: string): Promise<ResolvedProject | null> {
  let p = resolve(cwd);
  while (true) {
    const yaml = join(p, '.gollum', 'project.yaml');
    if (existsSync(yaml)) {
      try {
        const data = JSON.parse(readFileSync(yaml, 'utf-8')) as ProjectYaml;
        if (data.project_id && data.name) {
          return {
            project_id: data.project_id,
            name: data.name,
            repo_root: p,
            source: 'project-yaml',
          };
        }
      } catch { /* fall through */ }
      // Legacy path: `.steward/project.yaml` (V0.2 design doc)
      const legacy = join(p, '.steward', 'project.yaml');
      if (existsSync(legacy)) {
        try {
          const data = JSON.parse(readFileSync(legacy, 'utf-8')) as ProjectYaml;
          if (data.project_id && data.name) {
            return {
              project_id: data.project_id,
              name: data.name,
              repo_root: p,
              source: 'project-yaml',
            };
          }
        } catch { /* fall through */ }
      }
    }
    const parent = dirname(p);
    if (parent === p) return null;
    p = parent;
  }
}

async function resolveFromDb(cwd: string): Promise<ResolvedProject | null> {
  try {
    const store = await getStore();
    type DbProject = { id: string; name: string; description?: string | null };
    const projects = store.list<DbProject>('projects');
    // Find a project whose repo_root contains the cwd
    for (const proj of projects) {
      // V0.1 SQLite schema has no repo_root — fall back to no match
      // V0.2 future: add repo_root column or read from .gollum/project.yaml first
      const repoRoot = (proj as { repo_root?: string }).repo_root;
      if (repoRoot && isWithin(cwd, repoRoot)) {
        return {
          project_id: proj.id,
          name: proj.name,
          repo_root: repoRoot,
          source: 'registry-db',
        };
      }
    }
  } catch { /* store not ready, fall through */ }
  return null;
}

function isWithin(child: string, parent: string): boolean {
  const c = resolve(child);
  const p = resolve(parent);
  return c === p || c.startsWith(p + '/');
}

/**
 * Resolve the project for a given cwd. Walks upward for project.yaml,
 * then queries the SQLite registry for projects by repo_root containment.
 */
export async function resolveProject(cwd: string): Promise<{
  project_id: string | null;
  source: ResolvedProject['source'] | null;
  repo_root: string | null;
  cwd: string;
}> {
  const fromYaml = await resolveFromYaml(cwd);
  if (fromYaml) {
    return {
      project_id: fromYaml.project_id,
      source: fromYaml.source,
      repo_root: fromYaml.repo_root,
      cwd,
    };
  }
  const fromDb = await resolveFromDb(cwd);
  if (fromDb) {
    return {
      project_id: fromDb.project_id,
      source: fromDb.source,
      repo_root: fromDb.repo_root,
      cwd,
    };
  }
  return { project_id: null, source: null, repo_root: null, cwd };
}

/**
 * Return the currently cached/bound project. V0.2 reads from
 * ~/.gollum/.last-project (written by shell hook).
 */
export async function currentProject(): Promise<ResolvedProject | null> {
  const cachePath = join(homedir(), '.gollum', '.last-project');
  if (!existsSync(cachePath)) return null;
  try {
    const data = JSON.parse(readFileSync(cachePath, 'utf-8')) as ResolvedProject;
    return data;
  } catch {
    return null;
  }
}

export async function listProjects(): Promise<ResolvedProject[]> {
  try {
    const store = await getStore();
    type DbProject = { id: string; name: string; description?: string | null; repo_root?: string };
    const projects = store.list<DbProject>('projects');
    return projects.map((p) => ({
      project_id: p.id,
      name: p.name,
      repo_root: p.repo_root ?? '(unknown)',
      source: 'registry-db' as const,
    }));
  } catch {
    return [];
  }
}