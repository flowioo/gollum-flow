/**
 * Goal tools (DESIGN §8.3 — 5 core tools)
 *
 * 1. goal.list
 * 2. goal.get
 * 3. goal.create
 * 4. goal.update
 * 5. goal.achieve
 */

import { ulid } from 'ulid';
import { NotFoundError, type Store } from '../workflow/store/store.js';
import type { Goal } from '../workflow/model/types.js';

// =============================================================================
// 1. goal.list
// =============================================================================

export interface GoalListInput {
  project_id?: string;
  status?: Goal['status'];
}

export function goalList(store: Store, input: GoalListInput = {}): Goal[] {
  const conds: string[] = [];
  const params: unknown[] = [];
  if (input.project_id) {
    conds.push('project_id = ?');
    params.push(input.project_id);
  }
  if (input.status) {
    conds.push('status = ?');
    params.push(input.status);
  }
  const where = conds.length ? conds.join(' AND ') : '1';
  return store.list<Goal>('goals', where, params);
}

// =============================================================================
// 2. goal.get
// =============================================================================

export interface GoalGetResult {
  goal: Goal;
  outcomes: import('../workflow/model/types.js').Outcome[];
}

export function goalGet(store: Store, goal_id: string): GoalGetResult {
  const goal = store.get<Goal>('goals', goal_id);
  const outcomes = store.list<import('../workflow/model/types.js').Outcome>(
    'outcomes',
    'goal_id = ?',
    [goal_id],
  );
  return { goal, outcomes: outcomes.map(parseOutcome) };
}

// =============================================================================
// 3. goal.create
// =============================================================================

export interface GoalCreateInput {
  project_id: string;
  title: string;
  description?: string;
}

export function goalCreate(store: Store, input: GoalCreateInput): Goal {
  if (!store.tryGet('projects', input.project_id)) {
    throw new NotFoundError('projects', input.project_id);
  }
  const now = new Date().toISOString();
  const goal: Goal = {
    id: ulid(),
    project_id: input.project_id,
    title: input.title,
    description: input.description ?? null,
    status: 'active',
    version: 1,
    created_at: now,
    updated_at: now,
  };
  store.raw()
    .prepare(
      `INSERT INTO goals (id, project_id, title, description, status, version, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      goal.id,
      goal.project_id,
      goal.title,
      goal.description,
      goal.status,
      goal.version,
      goal.created_at,
      goal.updated_at,
    );
  store.emit({
    event: 'GOAL_CREATED',
    goal_id: goal.id,
    payload: { title: goal.title, project_id: goal.project_id },
  });
  return goal;
}

// =============================================================================
// Helpers
// =============================================================================

function parseOutcome(row: any): any {
  return { ...row, criteria_ids: row.criteria_ids ? JSON.parse(row.criteria_ids) : [] };
}

// =============================================================================
// Project factory (CLI needs it)
// =============================================================================

export interface ProjectCreateInput {
  name: string;
  description?: string;
}

export function projectCreate(store: Store, input: ProjectCreateInput): import('../workflow/model/types.js').Project {
  const now = new Date().toISOString();
  const project: import('../workflow/model/types.js').Project = {
    id: ulid(),
    name: input.name,
    description: input.description ?? null,
    created_at: now,
    updated_at: now,
  };
  try {
    store.raw()
      .prepare(
        `INSERT INTO projects (id, name, description, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(project.id, project.name, project.description, project.created_at, project.updated_at);
  } catch (e: any) {
    if (String(e.message).includes('UNIQUE')) {
      throw new Error(`Project name already exists: ${input.name}`);
    }
    throw e;
  }
  store.emit({
    event: 'PROJECT_CREATED',
    payload: { name: project.name, id: project.id },
  });
  return project;
}

export function projectList(store: Store): import('../workflow/model/types.js').Project[] {
  return store.list('projects');
}

export function projectGetOrCreateDefault(store: Store): import('../workflow/model/types.js').Project {
  // V0.1: singleton project (DESIGN §13 + PRD §6.4 Decision 13)
  const existing = projectList(store);
  if (existing.length > 0) return existing[0]!;
  return projectCreate(store, { name: 'default', description: 'Default singleton project' });
}

/**
 * Look a project up by its exact name. `projects.name` is UNIQUE and there is
 * no `project delete`, so re-running an init must reuse the existing row rather
 * than throw on the insert or leave a trail of dead projects behind.
 */
export function projectFindByName(
  store: Store,
  name: string,
): import('../workflow/model/types.js').Project | null {
  return projectList(store).find((p) => p.name === name) ?? null;
}