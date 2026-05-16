import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import { getDb } from '../db.js';
import { logActivity } from '../helpers/activity-logger.js';
import type { ToolHandler } from '../types.js';

export const definitions: Tool[] = [
  {
    name: 'tracker_export',
    description:
      'Export a full project as nested JSON. Includes all epics, tasks, subtasks, comments, dependencies, and related notes. Useful for backup, migration, or sharing.',
    annotations: { title: 'Export Project', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    inputSchema: {
      type: 'object',
      properties: {
        project_id: {
          type: 'integer',
          description: 'Project ID to export (omit if only one project exists)',
        },
      },
    },
  },
  {
    name: 'tracker_import',
    description:
      'Import a project from JSON (matching tracker_export format). Creates all entities with new IDs and remaps references. Uses a transaction for atomicity.',
    annotations: { title: 'Import Project', readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    inputSchema: {
      type: 'object',
      properties: {
        data: {
          type: 'object',
          description: 'Full export JSON object from tracker_export',
        },
      },
      required: ['data'],
    },
  },
];

async function handleExport(args: Record<string, unknown>) {
  const db = getDb();

  let projectId = args.project_id as number | undefined;
  if (!projectId) {
    const first = await db.queryOne<{ id: number }>('SELECT id FROM projects LIMIT 1');
    if (!first) throw new Error('No projects found. Create a project first.');
    projectId = first.id;
  }

  const project = await db.queryOne<Record<string, unknown>>(
    'SELECT * FROM projects WHERE id = ?', [projectId]
  );
  if (!project) throw new Error(`Project ${projectId} not found`);

  const epics = await db.query<Record<string, unknown>>(
    'SELECT * FROM epics WHERE project_id = ? ORDER BY sort_order, created_at',
    [projectId]
  );

  const epicData = await Promise.all(epics.map(async (epic) => {
    const tasks = await db.query<Record<string, unknown>>(
      'SELECT * FROM tasks WHERE epic_id = ? ORDER BY sort_order, created_at',
      [epic.id as number]
    );

    const taskData = await Promise.all(tasks.map(async (task) => {
      const taskId = task.id as number;

      const subtasks = await db.query<Record<string, unknown>>(
        'SELECT * FROM subtasks WHERE task_id = ? ORDER BY sort_order, created_at',
        [taskId]
      );

      const comments = await db.query<Record<string, unknown>>(
        'SELECT * FROM comments WHERE task_id = ? ORDER BY created_at ASC',
        [taskId]
      );

      const deps = await db.query<{ depends_on_task_id: number }>(
        'SELECT depends_on_task_id FROM task_dependencies WHERE task_id = ?',
        [taskId]
      );

      return {
        _original_id: task.id,
        title: task.title,
        description: task.description,
        status: task.status,
        priority: task.priority,
        sort_order: task.sort_order,
        assigned_to: task.assigned_to,
        estimated_hours: task.estimated_hours,
        actual_hours: task.actual_hours,
        due_date: task.due_date,
        source_ref: task.source_ref,
        tags: task.tags,
        metadata: task.metadata,
        depends_on: deps.map((d) => d.depends_on_task_id),
        subtasks: subtasks.map((s) => ({
          title: s.title,
          status: s.status,
          sort_order: s.sort_order,
        })),
        comments: comments.map((c) => ({
          author: c.author,
          content: c.content,
          created_at: c.created_at,
        })),
      };
    }));

    return {
      _original_id: epic.id,
      name: epic.name,
      description: epic.description,
      status: epic.status,
      priority: epic.priority,
      sort_order: epic.sort_order,
      branch: epic.branch,
      tags: epic.tags,
      metadata: epic.metadata,
      tasks: taskData,
    };
  }));

  // Collect notes linked to this project, its epics, or its tasks
  const notes: Array<Record<string, unknown>> = [];

  notes.push(...await db.query<Record<string, unknown>>(
    `SELECT * FROM notes WHERE related_entity_type = 'project' AND related_entity_id = ?`,
    [projectId]
  ));

  const epicIds = epics.map((e) => e.id as number);
  if (epicIds.length > 0) {
    const placeholders = epicIds.map(() => '?').join(',');
    notes.push(...await db.query<Record<string, unknown>>(
      `SELECT * FROM notes WHERE related_entity_type = 'epic' AND related_entity_id IN (${placeholders})`,
      epicIds
    ));
  }

  const allTaskIds: number[] = [];
  for (const epic of epics) {
    const tasks = await db.query<{ id: number }>(
      'SELECT id FROM tasks WHERE epic_id = ?', [epic.id as number]
    );
    allTaskIds.push(...tasks.map((t) => t.id));
  }
  if (allTaskIds.length > 0) {
    const placeholders = allTaskIds.map(() => '?').join(',');
    notes.push(...await db.query<Record<string, unknown>>(
      `SELECT * FROM notes WHERE related_entity_type = 'task' AND related_entity_id IN (${placeholders})`,
      allTaskIds
    ));
  }

  // Include unlinked notes
  notes.push(...await db.query<Record<string, unknown>>(
    'SELECT * FROM notes WHERE related_entity_type IS NULL'
  ));

  const noteData = notes.map((n) => ({
    title: n.title,
    content: n.content,
    note_type: n.note_type,
    related_entity_type: n.related_entity_type,
    _original_related_entity_id: n.related_entity_id,
    tags: n.tags,
    metadata: n.metadata,
  }));

  return {
    format_version: '1.2',
    exported_at: new Date().toISOString(),
    project: {
      name: project.name,
      description: project.description,
      status: project.status,
      tags: project.tags,
      metadata: project.metadata,
      epics: epicData,
    },
    notes: noteData,
  };
}

async function handleImport(args: Record<string, unknown>) {
  const db = getDb();
  const data = args.data as Record<string, unknown>;

  const version = data.format_version as string;
  if (version !== '1.0' && version !== '1.1' && version !== '1.2') {
    throw new Error(`Unsupported format version: ${version}. Expected "1.0", "1.1", or "1.2".`);
  }

  const projectData = data.project as Record<string, unknown>;
  if (!projectData || !projectData.name) {
    throw new Error('Invalid import data: missing project or project.name');
  }

  const result = await db.transaction(async (tx) => {
    const epicIdMap = new Map<number, number>();
    const taskIdMap = new Map<number, number>();

    // 1. Create project
    const project = await tx.queryOne<Record<string, unknown>>(
      'INSERT INTO projects (name, description, status, tags, metadata) VALUES (?, ?, ?, ?, ?) RETURNING *',
      [
        projectData.name,
        projectData.description ?? null,
        projectData.status ?? 'active',
        projectData.tags ?? '[]',
        projectData.metadata ?? '{}',
      ]
    );
    if (!project) throw new Error('Failed to create imported project');

    const newProjectId = project.id as number;
    await logActivity(tx, 'project', newProjectId, 'created', null, null, null, `Project '${projectData.name}' imported`);

    // 2. Create epics and their children
    const epics = (projectData.epics as Array<Record<string, unknown>>) ?? [];
    let epicCount = 0;
    let taskCount = 0;
    let subtaskCount = 0;
    let commentCount = 0;
    let depCount = 0;

    // Collect deferred dependencies (need all tasks created first)
    const deferredDeps: Array<{ newTaskId: number; originalDeps: number[] }> = [];

    for (const epicData of epics) {
      const epic = await tx.queryOne<Record<string, unknown>>(
        `INSERT INTO epics (project_id, name, description, status, priority, sort_order, branch, tags, metadata)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING *`,
        [
          newProjectId,
          epicData.name,
          epicData.description ?? null,
          epicData.status ?? 'planned',
          epicData.priority ?? 'medium',
          epicData.sort_order ?? 0,
          epicData.branch ?? null,
          epicData.tags ?? '[]',
          epicData.metadata ?? '{}',
        ]
      );
      if (!epic) throw new Error(`Failed to create imported epic '${epicData.name}'`);

      const newEpicId = epic.id as number;
      if (epicData._original_id != null) {
        epicIdMap.set(epicData._original_id as number, newEpicId);
      }
      epicCount++;
      await logActivity(tx, 'epic', newEpicId, 'created', null, null, null, `Epic '${epicData.name}' imported`);

      // 3. Create tasks
      const tasks = (epicData.tasks as Array<Record<string, unknown>>) ?? [];
      for (const taskData of tasks) {
        const task = await tx.queryOne<Record<string, unknown>>(
          `INSERT INTO tasks (epic_id, title, description, status, priority, sort_order,
           assigned_to, estimated_hours, actual_hours, due_date, source_ref, tags, metadata)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING *`,
          [
            newEpicId,
            taskData.title,
            taskData.description ?? null,
            taskData.status ?? 'todo',
            taskData.priority ?? 'medium',
            taskData.sort_order ?? 0,
            taskData.assigned_to ?? null,
            taskData.estimated_hours ?? null,
            taskData.actual_hours ?? null,
            taskData.due_date ?? null,
            taskData.source_ref ?? null,
            taskData.tags ?? '[]',
            taskData.metadata ?? '{}',
          ]
        );
        if (!task) throw new Error(`Failed to create imported task '${taskData.title}'`);

        const newTaskId = task.id as number;
        if (taskData._original_id != null) {
          taskIdMap.set(taskData._original_id as number, newTaskId);
        }
        taskCount++;
        await logActivity(tx, 'task', newTaskId, 'created', null, null, null, `Task '${taskData.title}' imported`);

        // Defer dependency creation
        const originalDeps = (taskData.depends_on as number[]) ?? [];
        if (originalDeps.length > 0) {
          deferredDeps.push({ newTaskId, originalDeps });
        }

        // 4. Create subtasks
        const subtasks = (taskData.subtasks as Array<Record<string, unknown>>) ?? [];
        for (const subtaskData of subtasks) {
          const subtask = await tx.queryOne<Record<string, unknown>>(
            'INSERT INTO subtasks (task_id, title, status, sort_order) VALUES (?, ?, ?, ?) RETURNING *',
            [
              newTaskId,
              subtaskData.title,
              subtaskData.status ?? 'todo',
              subtaskData.sort_order ?? 0,
            ]
          );
          if (!subtask) throw new Error(`Failed to create imported subtask '${subtaskData.title}'`);

          subtaskCount++;
          await logActivity(tx, 'subtask', subtask.id as number, 'created', null, null, null, `Subtask '${subtaskData.title}' imported`);
        }

        // 5. Create comments
        const comments = (taskData.comments as Array<Record<string, unknown>>) ?? [];
        for (const commentData of comments) {
          await tx.execute(
            'INSERT INTO comments (task_id, author, content) VALUES (?, ?, ?)',
            [newTaskId, commentData.author ?? null, commentData.content]
          );
          commentCount++;
        }
      }
    }

    // 6. Create dependencies with ID remapping
    for (const { newTaskId, originalDeps } of deferredDeps) {
      for (const origDepId of originalDeps) {
        const newDepId = taskIdMap.get(origDepId);
        if (newDepId != null) {
          await tx.execute(
            'INSERT INTO task_dependencies (task_id, depends_on_task_id) VALUES (?, ?)',
            [newTaskId, newDepId]
          );
          depCount++;
        }
      }
    }

    // 7. Create notes with ID remapping
    const importNotes = (data.notes as Array<Record<string, unknown>>) ?? [];
    let noteCount = 0;

    for (const noteData of importNotes) {
      let relatedEntityType = noteData.related_entity_type as string | null;
      let relatedEntityId: number | null = null;
      const originalId = noteData._original_related_entity_id as number | null;

      if (relatedEntityType && originalId != null) {
        if (relatedEntityType === 'project') {
          relatedEntityId = newProjectId;
        } else if (relatedEntityType === 'epic') {
          relatedEntityId = epicIdMap.get(originalId) ?? null;
          if (relatedEntityId === null) relatedEntityType = null;
        } else if (relatedEntityType === 'task') {
          relatedEntityId = taskIdMap.get(originalId) ?? null;
          if (relatedEntityId === null) relatedEntityType = null;
        }
      }

      const note = await tx.queryOne<Record<string, unknown>>(
        `INSERT INTO notes (title, content, note_type, related_entity_type, related_entity_id, tags, metadata)
         VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING *`,
        [
          noteData.title,
          noteData.content,
          noteData.note_type ?? 'general',
          relatedEntityType,
          relatedEntityId,
          noteData.tags ?? '[]',
          noteData.metadata ?? '{}',
        ]
      );
      if (!note) throw new Error(`Failed to create imported note '${noteData.title}'`);

      noteCount++;
      await logActivity(tx, 'note', note.id as number, 'created', null, null, null, `Note '${noteData.title}' imported`);
    }

    return {
      message: 'Import complete.',
      project_id: newProjectId,
      project_name: projectData.name,
      counts: { epics: epicCount, tasks: taskCount, subtasks: subtaskCount, comments: commentCount, dependencies: depCount, notes: noteCount },
    };
  });

  return result;
}

export const handlers: Record<string, ToolHandler> = {
  tracker_export: handleExport,
  tracker_import: handleImport,
};
