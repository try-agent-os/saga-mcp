#!/usr/bin/env node
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import express from 'express';

import { definitions as projectDefs, handlers as projectHandlers } from './tools/projects.js';
import { definitions as epicDefs, handlers as epicHandlers } from './tools/epics.js';
import { definitions as taskDefs, handlers as taskHandlers } from './tools/tasks.js';
import { definitions as subtaskDefs, handlers as subtaskHandlers } from './tools/subtasks.js';
import { definitions as dashboardDefs, handlers as dashboardHandlers } from './tools/dashboard.js';
import { definitions as searchDefs, handlers as searchHandlers } from './tools/search.js';
import { definitions as activityDefs, handlers as activityHandlers } from './tools/activity.js';
import { definitions as exportImportDefs, handlers as exportImportHandlers } from './tools/export-import.js';
import { closeDb } from './db.js';

// Core tools for AgentOS — drop templates/notes/comments to reduce context pressure
// Full list: 31 tools → 15 tools
const CORE_TOOLS: Tool[] = [
  ...projectDefs,   // project_create, project_list, project_update
  ...epicDefs,      // epic_create, epic_list, epic_update
  ...taskDefs,      // task_create, task_list, task_get, task_update
  ...subtaskDefs,   // subtask_create, subtask_update, subtask_delete
  ...dashboardDefs, // tracker_dashboard, tracker_init
  ...searchDefs,    // tracker_search
  ...activityDefs,  // activity_log, tracker_session_diff, task_batch_update
  ...exportImportDefs, // tracker_export, tracker_import
];

const CORE_HANDLERS: Record<string, (args: Record<string, unknown>) => unknown> = {
  ...projectHandlers,
  ...epicHandlers,
  ...taskHandlers,
  ...subtaskHandlers,
  ...dashboardHandlers,
  ...searchHandlers,
  ...activityHandlers,
  ...exportImportHandlers,
};

function friendlyError(msg: string): string {
  if (msg.includes('UNIQUE constraint failed')) {
    const match = msg.match(/UNIQUE constraint failed: \w+\.(\w+)/);
    return match ? `A record with that ${match[1]} already exists.` : 'A record with that value already exists.';
  }
  if (msg.includes('NOT NULL constraint failed')) {
    const match = msg.match(/NOT NULL constraint failed: \w+\.(\w+)/);
    return match ? `Missing required field: ${match[1]}.` : 'A required field is missing.';
  }
  if (msg.includes('FOREIGN KEY constraint failed')) {
    return 'Referenced record not found. Check that the parent item exists.';
  }
  if (msg.includes('no such table')) {
    return 'Database not initialized. Run tracker_init first.';
  }
  return msg;
}

function createServer(): Server {
  const server = new Server(
    { name: 'saga-mcp', version: '1.5.5' },
    { capabilities: { tools: {} } }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: CORE_TOOLS }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    try {
      const { name, arguments: args } = request.params;
      const handler = CORE_HANDLERS[name];
      if (!handler) throw new Error(`Unknown tool: ${name}`);
      const result = handler(args ?? {});
      return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      return {
        content: [{ type: 'text' as const, text: `Error: ${friendlyError(msg)}` }],
        isError: true,
      };
    }
  });

  return server;
}

async function runHttp(port: number) {
  const app = express();
  app.use(express.json());

  // CORS for dashboard frontend
  app.use((_req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.header('Access-Control-Allow-Headers', 'Content-Type');
    if (_req.method === 'OPTIONS') { res.sendStatus(204); return; }
    next();
  });

  // REST API — thin wrappers over MCP handlers for direct frontend access
  app.get('/api/dashboard', (_req, res) => {
    try {
      const projectId = Number(_req.query.project_id) || 1;
      const result = CORE_HANDLERS['tracker_dashboard']({ project_id: projectId });
      res.json(result);
    } catch (e) { res.status(500).json({ error: String(e) }); }
  });

  app.get('/api/task/:id', (_req, res) => {
    try {
      const result = CORE_HANDLERS['task_get']({ id: Number(_req.params.id) });
      res.json(result);
    } catch (e) { res.status(500).json({ error: String(e) }); }
  });

  app.get('/api/tasks', (_req, res) => {
    try {
      const args: Record<string, unknown> = {};
      if (_req.query.status) args.status = _req.query.status;
      if (_req.query.epic_id) args.epic_id = Number(_req.query.epic_id);
      if (_req.query.priority) args.priority = _req.query.priority;
      if (_req.query.sort_by) args.sort_by = _req.query.sort_by;
      if (_req.query.limit) args.limit = Number(_req.query.limit);
      const result = CORE_HANDLERS['task_list'](args);
      res.json(result);
    } catch (e) { res.status(500).json({ error: String(e) }); }
  });

  app.get('/api/epics', (_req, res) => {
    try {
      const args: Record<string, unknown> = {};
      if (_req.query.project_id) args.project_id = Number(_req.query.project_id);
      const result = CORE_HANDLERS['epic_list'](args);
      res.json(result);
    } catch (e) { res.status(500).json({ error: String(e) }); }
  });

  app.get('/api/activity', (_req, res) => {
    try {
      const args: Record<string, unknown> = {};
      if (_req.query.limit) args.limit = Number(_req.query.limit);
      if (_req.query.entity_type) args.entity_type = _req.query.entity_type;
      const result = CORE_HANDLERS['activity_log'](args);
      res.json(result);
    } catch (e) { res.status(500).json({ error: String(e) }); }
  });

  const transports = new Map<string, SSEServerTransport>();

  app.get('/sse', async (_req, res) => {
    const transport = new SSEServerTransport('/messages', res);
    const sessionId = transport.sessionId;
    transports.set(sessionId, transport);

    transport.onclose = () => transports.delete(sessionId);

    const server = createServer();
    await server.connect(transport);
  });

  app.post('/messages', async (req, res) => {
    const sessionId = req.query.sessionId as string;
    if (!sessionId) { res.status(400).json({ error: 'Missing sessionId' }); return; }
    const transport = transports.get(sessionId);
    if (!transport) { res.status(404).json({ error: 'Session not found' }); return; }
    await transport.handlePostMessage(req, res, req.body);
  });

  app.get('/health', (_req, res) => {
    res.json({ status: 'ok', sessions: transports.size, tools: CORE_TOOLS.length, uptime: process.uptime() });
  });

  const httpServer = app.listen(port, () => {
    console.log(`[saga-mcp] SSE listening on http://localhost:${port}`);
    console.log(`[saga-mcp] SSE endpoint: http://localhost:${port}/sse`);
    console.log(`[saga-mcp] Tools exposed: ${CORE_TOOLS.length}`);
  });

  async function shutdown() {
    console.log('[saga-mcp] Shutting down...');
    for (const [, transport] of transports) {
      try { await transport.close(); } catch { /* ignore */ }
    }
    transports.clear();
    httpServer.close();
    closeDb();
    process.exit(0);
  }

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

async function runStdio() {
  const server = createServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(`[saga-mcp] Running on stdio (${CORE_TOOLS.length} tools)`);

  process.on('SIGINT', () => { closeDb(); process.exit(0); });
  process.on('SIGTERM', () => { closeDb(); process.exit(0); });
}

async function main() {
  const port = process.env.PORT ? parseInt(process.env.PORT, 10) : null;
  if (port) {
    await runHttp(port);
  } else {
    await runStdio();
  }
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
