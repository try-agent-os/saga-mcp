import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import { getDb } from '../db.js';
import { buildUpdate } from '../helpers/sql-builder.js';
import { logActivity, logEntityUpdate } from '../helpers/activity-logger.js';
import type { ToolHandler } from '../types.js';

export const definitions: Tool[] = [
  {
    name: 'epic_create',
    description: 'Create an epic within a project. Epics group related tasks into a feature or workstream.',
    annotations: { title: 'Create Epic', readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    inputSchema: {
      type: 'object',
      properties: {
        project_id: { type: 'integer', description: 'Parent project ID' },
        name: { type: 'string', description: 'Epic name' },
        description: { type: 'string', description: 'Epic description' },
        status: {
          type: 'string',
          enum: ['planned', 'in_progress', 'completed', 'cancelled'],
          default: 'planned',
        },
        priority: {
          type: 'string',
          enum: ['low', 'medium', 'high', 'critical'],
          default: 'medium',
        },
        tags: { type: 'array', items: { type: 'string' } },
      },
      required: ['project_id', 'name'],
    },
  },
  {
    name: 'epic_list',
    description:
      'List epics for a project with task counts and completion stats. Optionally filter by status or priority.',
    annotations: { title: 'List Epics', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    inputSchema: {
      type: 'object',
      properties: {
        project_id: { type: 'integer', description: 'Project ID' },
        status: { type: 'string', enum: ['planned', 'in_progress', 'completed', 'cancelled'] },
        priority: { type: 'string', enum: ['low', 'medium', 'high', 'critical'] },
      },
      required: ['project_id'],
    },
  },
  {
    name: 'epic_update',
    description:
      'Update an epic. Pass only the fields you want to change. Set status to "cancelled" to soft-delete.',
    annotations: { title: 'Update Epic', readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'integer', description: 'Epic ID' },
        name: { type: 'string' },
        description: { type: 'string' },
        status: { type: 'string', enum: ['planned', 'in_progress', 'completed', 'cancelled'] },
        priority: { type: 'string', enum: ['low', 'medium', 'high', 'critical'] },
        sort_order: { type: 'integer' },
        tags: { type: 'array', items: { type: 'string' } },
      },
      required: ['id'],
    },
  },
];

async function handleEpicCreate(args: Record<string, unknown>) {
  const db = getDb();
  const projectId = args.project_id as number;
  const name = args.name as string;
  const description = (args.description as string) ?? null;
  const status = (args.status as string) ?? 'planned';
  const priority = (args.priority as string) ?? 'medium';
  const tags = JSON.stringify((args.tags as string[]) ?? []);

  const epic = await db.queryOne<Record<string, unknown>>(
    'INSERT INTO epics (project_id, name, description, status, priority, tags) VALUES (?, ?, ?, ?, ?, ?) RETURNING *',
    [projectId, name, description, status, priority, tags]
  );
  if (!epic) throw new Error('Failed to create epic');

  await logActivity(db, 'epic', epic.id as number, 'created', null, null, null, `Epic '${name}' created in project ${projectId}`);

  return epic;
}

async function handleEpicList(args: Record<string, unknown>) {
  const db = getDb();
  const projectId = args.project_id as number;
  const status = args.status as string | undefined;
  const priority = args.priority as string | undefined;

  const whereClauses = ['e.project_id = ?'];
  const params: unknown[] = [projectId];

  if (status) {
    whereClauses.push('e.status = ?');
    params.push(status);
  }
  if (priority) {
    whereClauses.push('e.priority = ?');
    params.push(priority);
  }

  const sql = `
    SELECT e.*,
      COUNT(t.id) as task_count,
      SUM(CASE WHEN t.status = 'done' THEN 1 ELSE 0 END) as done_count,
      SUM(CASE WHEN t.status = 'blocked' THEN 1 ELSE 0 END) as blocked_count,
      CASE WHEN COUNT(t.id) > 0
        THEN ROUND(SUM(CASE WHEN t.status = 'done' THEN 1 ELSE 0 END) * 100.0 / COUNT(t.id), 1)
        ELSE 0 END as completion_pct
    FROM epics e
    LEFT JOIN tasks t ON t.epic_id = e.id
    WHERE ${whereClauses.join(' AND ')}
    GROUP BY e.id
    ORDER BY e.sort_order, e.created_at
  `;

  return db.query(sql, params);
}

async function handleEpicUpdate(args: Record<string, unknown>) {
  const db = getDb();
  const id = args.id as number;

  const oldRow = await db.queryOne<Record<string, unknown>>('SELECT * FROM epics WHERE id = ?', [id]);
  if (!oldRow) throw new Error(`Epic ${id} not found`);

  const update = buildUpdate('epics', id, args, ['name', 'description', 'status', 'priority', 'sort_order', 'tags']);
  if (!update) throw new Error('No fields to update');

  const newRow = await db.queryOne<Record<string, unknown>>(update.sql, update.params);
  if (!newRow) throw new Error(`Epic ${id} not found after update`);
  await logEntityUpdate(db, 'epic', id, newRow.name as string, oldRow, newRow, ['name', 'status', 'priority']);

  return newRow;
}

export const handlers: Record<string, ToolHandler> = {
  epic_create: handleEpicCreate,
  epic_list: handleEpicList,
  epic_update: handleEpicUpdate,
};
