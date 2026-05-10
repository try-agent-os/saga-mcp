#!/usr/bin/env node
// End-to-end smoke test for the dual-driver saga-mcp.
//
// Usage:
//   DATABASE_URL=postgres://… node tests/smoke.mjs            # Neon path
//   DB_PATH=/path/to/agentOS.db node tests/smoke.mjs          # SQLite path
//
// Exercises every CORE handler exposed by saga-mcp directly (no MCP transport
// in the loop — just the same handler map index.ts wires up).

import { closeDb, getDb } from '../dist/db.js';
import { handlers as projectHandlers } from '../dist/tools/projects.js';
import { handlers as epicHandlers } from '../dist/tools/epics.js';
import { handlers as taskHandlers } from '../dist/tools/tasks.js';
import { handlers as subtaskHandlers } from '../dist/tools/subtasks.js';
import { handlers as dashboardHandlers } from '../dist/tools/dashboard.js';
import { handlers as searchHandlers } from '../dist/tools/search.js';
import { handlers as activityHandlers } from '../dist/tools/activity.js';

const HANDLERS = {
  ...projectHandlers,
  ...epicHandlers,
  ...taskHandlers,
  ...subtaskHandlers,
  ...dashboardHandlers,
  ...searchHandlers,
  ...activityHandlers,
};

let pass = 0;
let fail = 0;

function assert(cond, msg) {
  if (cond) { pass++; console.log(`  PASS  ${msg}`); }
  else      { fail++; console.error(`  FAIL  ${msg}`); }
}

async function main() {
  const db = getDb();
  console.log(`Driver: ${db.driver}`);
  console.log('');

  // --- project_list -----------------------------------------------------------
  console.log('[1] project_list');
  const projects = await HANDLERS.project_list({});
  console.log(`    returned ${projects.length} project(s):`);
  for (const p of projects) {
    console.log(`      #${p.id} ${p.name} — ${p.task_count} tasks (${p.completion_pct}%)`);
  }
  assert(projects.length >= 1, 'project_list returns at least one project');

  // --- task_get -- the highest-id task -- but we only know 858 is highest in
  // Neon. SQLite may have a different max id — read it dynamically.
  console.log('\n[2] task_get (highest-id task)');
  const [{ max_id }] = await db.query('SELECT MAX(id) as max_id FROM tasks');
  const targetId = Number(max_id);
  console.log(`    target task id: ${targetId}`);
  const task = await HANDLERS.task_get({ id: targetId });
  console.log(`    title: ${task.title}`);
  console.log(`    status: ${task.status} priority: ${task.priority}`);
  console.log(`    epic: ${task.epic_name}`);
  console.log(`    subtasks: ${task.subtasks.length}, comments: ${task.comments.length}, deps: ${task.depends_on.length}`);
  assert(task.id === targetId, `task_get returned task #${targetId}`);
  assert(typeof task.title === 'string' && task.title.length > 0, 'task has a non-empty title');
  assert(Array.isArray(task.subtasks), 'task.subtasks is an array');
  assert(Array.isArray(task.comments), 'task.comments is an array');

  // --- tracker_dashboard ------------------------------------------------------
  console.log('\n[3] tracker_dashboard project_id=1');
  const dash = await HANDLERS.tracker_dashboard({ project_id: 1 });
  console.log(`    summary: ${dash.summary}`);
  console.log(`    stats: ${JSON.stringify(dash.stats)}`);
  console.log(`    epics: ${dash.epics.length}, blocked: ${dash.blocked_tasks.length}, overdue: ${dash.overdue_tasks.length}`);
  assert(dash.project && dash.project.id === 1, 'dashboard.project.id === 1');
  assert(Number(dash.stats.total_tasks) > 0, 'dashboard reports >0 total tasks');
  assert(Array.isArray(dash.epics) && dash.epics.length > 0, 'dashboard returns epics');

  // --- task_create (smoke task) ----------------------------------------------
  console.log('\n[4] task_create — smoke task');
  const smokeTitle = `postgres smoke test ${new Date().toISOString()}`;
  const created = await HANDLERS.task_create({
    epic_id: 4,
    title: smokeTitle,
    description: 'Created by tests/smoke.mjs — safe to delete.',
    priority: 'low',
  });
  console.log(`    created task id=${created.id}, title=${created.title}`);
  assert(typeof created.id === 'number' && created.id > targetId, `new task id (${created.id}) > previous max (${targetId})`);
  assert(created.title === smokeTitle, 'new task title matches');
  assert(created.status === 'todo', 'new task status is todo');

  // --- verify it's findable
  console.log('\n[5] task_get on the new task');
  const refetched = await HANDLERS.task_get({ id: created.id });
  assert(refetched.title === smokeTitle, 'refetched smoke task title matches');

  // --- task_update status change ---------------------------------------------
  console.log('\n[6] task_update — set status=in_progress');
  const updated = await HANDLERS.task_update({ id: created.id, status: 'in_progress' });
  assert(updated.status === 'in_progress', 'task is now in_progress');

  // --- subtask_create (batch) ------------------------------------------------
  console.log('\n[7] subtask_create (batch of 2)');
  const subs = await HANDLERS.subtask_create({
    task_id: created.id,
    titles: ['smoke sub A', 'smoke sub B'],
  });
  console.log(`    created subtasks: ${JSON.stringify(subs.map(s => ({ id: s.id, title: s.title })))}`);
  assert(Array.isArray(subs) && subs.length === 2, 'two subtasks created in transaction');

  // --- tracker_search --------------------------------------------------------
  console.log('\n[8] tracker_search — find smoke task by title');
  const searchRes = await HANDLERS.tracker_search({ query: 'postgres smoke test', entity_types: ['task'] });
  const hit = (searchRes.tasks ?? []).find(t => t.id === created.id);
  assert(!!hit, 'smoke task discoverable via tracker_search');

  // --- activity_log ----------------------------------------------------------
  console.log('\n[9] activity_log — see recent entries for new task');
  const activity = await HANDLERS.activity_log({ entity_type: 'task', entity_id: created.id, limit: 10 });
  console.log(`    activity rows: ${activity.length}`);
  for (const a of activity) console.log(`      ${a.created_at}  ${a.action}/${a.field_name ?? '-'}  ${a.summary}`);
  assert(activity.length >= 1, 'activity_log returns entries for the new task');

  // --- cleanup ---------------------------------------------------------------
  console.log('\n[10] cleanup — delete smoke task and its subtasks');
  if (subs.length) {
    await HANDLERS.subtask_delete({ ids: subs.map(s => s.id) });
  }
  // No task_delete handler — issue raw SQL.
  const beforeDelete = await db.query('SELECT id FROM tasks WHERE title LIKE ?', ['postgres smoke test%']);
  await db.execute('DELETE FROM tasks WHERE title LIKE ?', ['postgres smoke test%']);
  const afterDelete = await db.query('SELECT id FROM tasks WHERE title LIKE ?', ['postgres smoke test%']);
  console.log(`    deleted ${beforeDelete.length} task(s); ${afterDelete.length} remain`);
  assert(afterDelete.length === 0, 'all smoke tasks cleaned up');

  console.log('');
  console.log(`Result: ${pass} passed, ${fail} failed`);
  await closeDb();
  if (fail > 0) process.exit(1);
}

main().catch(async (err) => {
  console.error('Fatal:', err);
  try { await closeDb(); } catch { /* ignore */ }
  process.exit(1);
});
