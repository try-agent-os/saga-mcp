import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import { getDb } from '../db.js';
import { logActivity } from '../helpers/activity-logger.js';
import type { ToolHandler } from '../types.js';

export const definitions: Tool[] = [
  {
    name: 'tracker_dashboard',
    description:
      'Get a comprehensive project overview in a single call. Returns: project info, all epics with task counts, overall stats (total/done/blocked/in_progress), recent activity, and recent notes. This is the best first tool to call when starting work on a project.',
    annotations: { title: 'Project Dashboard', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    inputSchema: {
      type: 'object',
      properties: {
        project_id: { type: 'integer', description: 'Project ID (omit if only one project exists)' },
      },
    },
  },
  {
    name: 'tracker_init',
    description:
      'Initialize the tracker for a project. If the database is empty, creates a project with the given name. If a project already exists, returns its info.',
    annotations: { title: 'Initialize Tracker', readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    inputSchema: {
      type: 'object',
      properties: {
        project_name: { type: 'string', description: 'Name for a new project (only used if DB is empty)' },
        project_description: { type: 'string', description: 'Description for the new project' },
      },
    },
  },
];

async function handleDashboard(args: Record<string, unknown>) {
  const db = getDb();

  let projectId = args.project_id as number | undefined;
  if (!projectId) {
    const first = await db.queryOne<{ id: number }>('SELECT id FROM projects LIMIT 1');
    if (!first) {
      return {
        message: 'No projects found. Use tracker_init or project_create to get started.',
        projects: [],
      };
    }
    projectId = first.id;
  }

  const project = await db.queryOne('SELECT * FROM projects WHERE id = ?', [projectId]);
  if (!project) throw new Error(`Project ${projectId} not found`);

  // Aggregate stats
  const stats = await db.queryOne(
    `
    WITH epic_ids AS (
      SELECT id FROM epics WHERE project_id = ?
    ),
    task_stats AS (
      SELECT
        COUNT(*) as total_tasks,
        SUM(CASE WHEN status = 'done' THEN 1 ELSE 0 END) as tasks_done,
        SUM(CASE WHEN status = 'in_progress' THEN 1 ELSE 0 END) as tasks_in_progress,
        SUM(CASE WHEN status = 'blocked' THEN 1 ELSE 0 END) as tasks_blocked,
        SUM(CASE WHEN status = 'todo' THEN 1 ELSE 0 END) as tasks_todo,
        SUM(CASE WHEN status = 'review' THEN 1 ELSE 0 END) as tasks_review,
        COALESCE(SUM(estimated_hours), 0) as total_estimated_hours,
        COALESCE(SUM(actual_hours), 0) as total_actual_hours
      FROM tasks WHERE epic_id IN (SELECT id FROM epic_ids)
    )
    SELECT
      (SELECT COUNT(*) FROM epic_ids) as total_epics,
      ts.*,
      CASE WHEN ts.total_tasks > 0
        THEN ROUND(ts.tasks_done * 100.0 / ts.total_tasks, 1)
        ELSE 0 END as completion_pct
    FROM task_stats ts
  `,
    [projectId]
  );

  // Epics with task counts
  const epics = await db.query(
    `
    SELECT e.*,
      COUNT(t.id) as task_count,
      SUM(CASE WHEN t.status = 'done' THEN 1 ELSE 0 END) as done_count,
      SUM(CASE WHEN t.status = 'blocked' THEN 1 ELSE 0 END) as blocked_count,
      CASE WHEN COUNT(t.id) > 0
        THEN ROUND(SUM(CASE WHEN t.status = 'done' THEN 1 ELSE 0 END) * 100.0 / COUNT(t.id), 1)
        ELSE 0 END as completion_pct
    FROM epics e
    LEFT JOIN tasks t ON t.epic_id = e.id
    WHERE e.project_id = ?
    GROUP BY e.id
    ORDER BY e.sort_order, e.created_at
  `,
    [projectId]
  );

  // Blocked tasks
  const blockedTasks = await db.query(
    `
    SELECT t.id, t.title, t.priority, e.name as epic_name
    FROM tasks t
    JOIN epics e ON e.id = t.epic_id
    WHERE e.project_id = ? AND t.status = 'blocked'
    ORDER BY
      CASE t.priority WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END
  `,
    [projectId]
  );

  // Overdue tasks
  const today = new Date().toISOString().slice(0, 10);
  const overdueTasks = await db.query(
    `SELECT t.id, t.title, t.due_date, t.priority, e.name as epic_name
     FROM tasks t
     JOIN epics e ON e.id = t.epic_id
     WHERE e.project_id = ? AND t.due_date < ? AND t.status NOT IN ('done')
     ORDER BY t.due_date ASC`,
    [projectId, today]
  );

  // Recent activity (last 10)
  const recentActivity = await db.query(
    'SELECT summary, action, entity_type, entity_id, created_at FROM activity_log ORDER BY created_at DESC LIMIT 10'
  );

  // Recent notes (last 5)
  const recentNotes = await db.query(
    'SELECT id, title, note_type, created_at FROM notes ORDER BY created_at DESC LIMIT 5'
  );

  // Generate natural language summary.
  // PG returns SUM() as string for bigint contexts; coerce to number for the
  // summary so concatenation and comparisons behave like SQLite did.
  const s = stats as Record<string, unknown>;
  const num = (v: unknown): number => (v == null ? 0 : Number(v));
  const totalTasks = num(s.total_tasks);
  const totalEpics = num(s.total_epics);
  const completionPct = num(s.completion_pct);
  const tasksBlocked = num(s.tasks_blocked);
  const tasksInProgress = num(s.tasks_in_progress);
  const p = project as Record<string, unknown>;
  const epicList = epics as Array<Record<string, unknown>>;

  const summaryParts: string[] = [];
  summaryParts.push(`${p.name}: ${totalTasks} tasks across ${totalEpics} epics. ${completionPct}% complete.`);

  const activeEpics = epicList.filter((e) => e.status === 'in_progress');
  if (activeEpics.length > 0) {
    const activeStr = activeEpics
      .map((e) => `${e.name} (${e.done_count}/${e.task_count} done)`)
      .join(', ');
    summaryParts.push(`Active: ${activeStr}.`);
  }

  const nextEpic = epicList.find((e) => e.status === 'planned');
  if (nextEpic) {
    summaryParts.push(`Next up: ${nextEpic.name} (${nextEpic.task_count} tasks).`);
  }

  if (tasksBlocked > 0) {
    summaryParts.push(`${tasksBlocked} blocked task(s).`);
  } else {
    summaryParts.push('No blocked tasks.');
  }

  if (overdueTasks.length > 0) {
    summaryParts.push(`${overdueTasks.length} overdue task(s).`);
  }

  if (tasksInProgress > 0) {
    summaryParts.push(`${tasksInProgress} in progress.`);
  }

  const summary = summaryParts.join(' ');

  return {
    summary,
    project,
    stats,
    epics,
    blocked_tasks: blockedTasks,
    overdue_tasks: overdueTasks,
    recent_activity: recentActivity,
    recent_notes: recentNotes,
  };
}

async function handleTrackerInit(args: Record<string, unknown>) {
  const db = getDb();

  const existing = await db.queryOne('SELECT * FROM projects LIMIT 1');
  if (existing) {
    return {
      message: 'Tracker already initialized. Returning existing project.',
      project: existing,
    };
  }

  const projectName = args.project_name as string | undefined;
  if (!projectName) {
    return {
      message: 'Database is empty. Provide a project_name to create your first project.',
      projects: [],
    };
  }

  const description = (args.project_description as string) ?? null;
  const project = await db.queryOne<Record<string, unknown>>(
    'INSERT INTO projects (name, description) VALUES (?, ?) RETURNING *',
    [projectName, description]
  );
  if (!project) throw new Error('Failed to initialize project');

  await logActivity(db, 'project', project.id as number, 'created', null, null, null, `Project '${projectName}' initialized`);

  return {
    message: `Project '${projectName}' created. Use epic_create to start adding work.`,
    project,
  };
}

export const handlers: Record<string, ToolHandler> = {
  tracker_dashboard: handleDashboard,
  tracker_init: handleTrackerInit,
};
