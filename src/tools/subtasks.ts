import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import { getDb } from '../db.js';
import { logActivity } from '../helpers/activity-logger.js';
import type { ToolHandler } from '../types.js';

export const definitions: Tool[] = [
  {
    name: 'subtask_create',
    description:
      'Create one or more subtasks (checklist items) for a task. Accepts a single title string or an array of title strings for batch creation.',
    annotations: { title: 'Create Subtask(s)', readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    inputSchema: {
      type: 'object',
      properties: {
        task_id: { type: 'integer', description: 'Parent task ID' },
        titles: {
          oneOf: [
            { type: 'string', description: 'Single subtask title' },
            { type: 'array', items: { type: 'string' }, description: 'Multiple subtask titles' },
          ],
        },
      },
      required: ['task_id', 'titles'],
    },
  },
  {
    name: 'subtask_update',
    description: 'Update a subtask title, status, or sort order.',
    annotations: { title: 'Update Subtask', readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'integer', description: 'Subtask ID' },
        title: { type: 'string' },
        status: { type: 'string', enum: ['todo', 'in_progress', 'done'] },
        sort_order: { type: 'integer' },
      },
      required: ['id'],
    },
  },
  {
    name: 'subtask_delete',
    description: 'Delete one or more subtasks. Accepts a single ID or array of IDs.',
    annotations: { title: 'Delete Subtask(s)', readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    inputSchema: {
      type: 'object',
      properties: {
        ids: {
          oneOf: [
            { type: 'integer', description: 'Single subtask ID' },
            { type: 'array', items: { type: 'integer' }, description: 'Multiple subtask IDs' },
          ],
        },
      },
      required: ['ids'],
    },
  },
];

async function handleSubtaskCreate(args: Record<string, unknown>) {
  const db = getDb();
  const taskId = args.task_id as number;
  const rawTitles = args.titles;
  const titles = Array.isArray(rawTitles) ? rawTitles as string[] : [rawTitles as string];

  const created = await db.transaction(async (tx) => {
    const rows: Record<string, unknown>[] = [];
    for (const title of titles) {
      const subtask = await tx.queryOne<Record<string, unknown>>(
        'INSERT INTO subtasks (task_id, title) VALUES (?, ?) RETURNING *',
        [taskId, title]
      );
      if (!subtask) throw new Error(`Failed to create subtask '${title}'`);
      await logActivity(tx, 'subtask', subtask.id as number, 'created', null, null, null, `Subtask '${title}' created`);
      rows.push(subtask);
    }
    return rows;
  });

  return created.length === 1 ? created[0] : created;
}

async function handleSubtaskUpdate(args: Record<string, unknown>) {
  const db = getDb();
  const id = args.id as number;

  const oldRow = await db.queryOne<Record<string, unknown>>('SELECT * FROM subtasks WHERE id = ?', [id]);
  if (!oldRow) throw new Error(`Subtask ${id} not found`);

  const updates: string[] = [];
  const params: unknown[] = [];

  if (args.title !== undefined) {
    updates.push('title = ?');
    params.push(args.title);
  }
  if (args.status !== undefined) {
    updates.push('status = ?');
    params.push(args.status);
  }
  if (args.sort_order !== undefined) {
    updates.push('sort_order = ?');
    params.push(args.sort_order);
  }

  if (updates.length === 0) throw new Error('No fields to update');

  updates.push("updated_at = datetime('now')");
  params.push(id);

  const newRow = await db.queryOne<Record<string, unknown>>(
    `UPDATE subtasks SET ${updates.join(', ')} WHERE id = ? RETURNING *`,
    params
  );
  if (!newRow) throw new Error(`Subtask ${id} not found after update`);

  if (oldRow.status !== newRow.status) {
    await logActivity(
      db, 'subtask', id, 'status_changed', 'status',
      oldRow.status as string, newRow.status as string,
      `Subtask '${newRow.title}' status: ${oldRow.status} -> ${newRow.status}`
    );
  }

  return newRow;
}

async function handleSubtaskDelete(args: Record<string, unknown>) {
  const db = getDb();
  const rawIds = args.ids;
  const ids = Array.isArray(rawIds) ? rawIds as number[] : [rawIds as number];

  const deleted = await db.transaction(async (tx) => {
    const rows: Array<{ id: number; title: unknown; deleted: true }> = [];
    for (const id of ids) {
      const row = await tx.queryOne<Record<string, unknown>>('SELECT * FROM subtasks WHERE id = ?', [id]);
      if (!row) throw new Error(`Subtask ${id} not found`);
      await tx.execute('DELETE FROM subtasks WHERE id = ?', [id]);
      await logActivity(tx, 'subtask', id, 'deleted', null, null, null, `Subtask '${row.title}' deleted`);
      rows.push({ id, title: row.title, deleted: true });
    }
    return rows;
  });

  return deleted.length === 1 ? deleted[0] : deleted;
}

export const handlers: Record<string, ToolHandler> = {
  subtask_create: handleSubtaskCreate,
  subtask_update: handleSubtaskUpdate,
  subtask_delete: handleSubtaskDelete,
};
