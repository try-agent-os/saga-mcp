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
