import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getPort, loadEnv } from './config.js';
import { listEvents, listJobs } from './db.js';
import { getModel } from './openai.js';
import {
  assertOwnerToken,
  chatWithAgent,
  discoverSkill,
  evolveIdentity,
  listAgentTasks,
  listChatHistory,
  seedDefaultSubscriptions,
  wakeAgent,
} from './service.js';
import { getOwnerPasscode } from './config.js';

loadEnv();

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function sendJson(response, status, body) {
  response.writeHead(status, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  });
  response.end(JSON.stringify(body, null, 2));
}

async function sendFile(response, filePath, contentType, sendBody = true) {
  const data = await fs.readFile(filePath);
  response.writeHead(200, {
    'Content-Type': contentType,
    'Cache-Control': 'no-store',
    'Content-Length': data.length,
  });
  response.end(sendBody ? data : undefined);
}

function sendError(response, status, error) {
  sendJson(response, status, {
    error: {
      code: error?.code || 'error',
      message: error?.message || String(error),
    },
  });
}

function statusForError(error) {
  const code = error?.code || error?.details?.code;
  const detailCode = error?.details?.code;
  if (code === 'unauthorized') return 401;
  if (code === 'invalid_json' || code === 'body_too_large' || code === 'usage_error') return 400;
  if (detailCode?.startsWith?.('missing_')) return 400;
  if (detailCode === 'invalid_agent_key' || detailCode === 'invalid_agent_id') return 404;
  // Supabase/Postgres client errors carry their HTTP status — don't mask 4xx as 500.
  if (error?.code === 'db_error' && Number.isInteger(error?.details?.status)
      && error.details.status >= 400 && error.details.status < 500) {
    return error.details.status;
  }
  return 500;
}

async function readJson(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 1024 * 1024) {
      const error = new Error('Request body is too large.');
      error.code = 'body_too_large';
      throw error;
    }
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  const raw = Buffer.concat(chunks).toString('utf8');
  try {
    return JSON.parse(raw);
  } catch {
    const error = new Error('Request body must be valid JSON.');
    error.code = 'invalid_json';
    throw error;
  }
}

function pathParts(request) {
  const url = new URL(request.url, 'http://localhost');
  return {
    url,
    pathname: url.pathname,
    parts: url.pathname.split('/').filter(Boolean),
  };
}

function intParam(value, fallback, max = 500) {
  const n = Number(value || fallback);
  if (!Number.isInteger(n) || n <= 0) return fallback;
  return Math.min(n, max);
}

async function route(request, response) {
  if (request.method === 'OPTIONS') {
    response.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    });
    response.end();
    return;
  }

  const { url, pathname, parts } = pathParts(request);

  const isStaticMethod = request.method === 'GET' || request.method === 'HEAD';

  if (isStaticMethod && (pathname === '/' || pathname === '/index.html')) {
    await sendFile(response, path.join(repoRoot, 'index.html'), 'text/html; charset=utf-8', request.method !== 'HEAD');
    return;
  }

  if (isStaticMethod && pathname.startsWith('/fonts/')) {
    const fileName = path.basename(pathname);
    if (!['Telka-Regular.woff2', 'Telka-Extended-Super.woff2'].includes(fileName)) {
      sendJson(response, 404, {
        error: {
          code: 'not_found',
          message: 'Route not found.',
        },
      });
      return;
    }
    await sendFile(response, path.join(repoRoot, 'fonts', fileName), 'font/woff2', request.method !== 'HEAD');
    return;
  }

  if (request.method === 'GET' && pathname === '/health') {
    sendJson(response, 200, {
      ok: true,
      service: 'agent-village',
      model: getModel(),
      time: new Date().toISOString(),
    });
    return;
  }

  if (request.method === 'GET' && pathname === '/events') {
    const events = await listEvents({
      agentId: url.searchParams.get('agent_id'),
      visibility: url.searchParams.get('visibility'),
      limit: intParam(url.searchParams.get('limit'), 50),
    });
    sendJson(response, 200, { events });
    return;
  }

  if (request.method === 'GET' && pathname === '/jobs') {
    const jobs = await listJobs({
      agentId: url.searchParams.get('agent_id'),
      status: url.searchParams.get('status'),
      limit: intParam(url.searchParams.get('limit'), 50),
    });
    sendJson(response, 200, { jobs });
    return;
  }

  if (request.method === 'POST' && pathname === '/subscriptions/seed') {
    const result = await seedDefaultSubscriptions();
    sendJson(response, 200, {
      agents: result.agents.length,
      created: result.created.length,
      subscription_ids: result.created.map(row => row.id),
    });
    return;
  }

  if (request.method === 'POST' && pathname === '/auth/owner') {
    const body = await readJson(request);
    assertOwnerToken(body.passcode); // throws unauthorized -> 401
    sendJson(response, 200, { ok: true, token: getOwnerPasscode() });
    return;
  }

  if (request.method === 'POST' && pathname === '/chat/owner') {
    const body = await readJson(request);
    const result = await chatWithAgent({
      context: 'owner',
      agentKey: body.agent_key,
      agentId: body.agent_id,
      ownerToken: body.owner_token,
      message: body.message,
      externalUserId: body.owner_id || null,
    });
    sendJson(response, 200, {
      agent_id: result.agent.id,
      agent_name: result.agent.name,
      conversation_id: result.conversation.id,
      context: result.context,
      message: result.message,
      actions: result.actions,
    });
    return;
  }

  if (request.method === 'POST' && pathname === '/chat/owner/history') {
    const body = await readJson(request);
    const result = await listChatHistory({
      context: 'owner',
      agentKey: body.agent_key,
      agentId: body.agent_id,
      ownerToken: body.owner_token,
      limit: intParam(body.limit, 80, 200),
    });
    sendJson(response, 200, {
      agent_id: result.agent.id,
      agent_name: result.agent.name,
      context: result.context,
      messages: result.messages,
    });
    return;
  }

  if (request.method === 'POST' && pathname === '/chat/stranger') {
    const body = await readJson(request);
    const result = await chatWithAgent({
      context: 'stranger',
      agentId: body.agent_id,
      message: body.message,
      externalUserId: body.visitor_id || null,
    });
    sendJson(response, 200, {
      agent_id: result.agent.id,
      agent_name: result.agent.name,
      conversation_id: result.conversation.id,
      context: result.context,
      message: result.message,
      actions: result.actions,
    });
    return;
  }

  if (request.method === 'POST' && pathname === '/chat/stranger/history') {
    const body = await readJson(request);
    const result = await listChatHistory({
      context: 'stranger',
      agentId: body.agent_id,
      limit: intParam(body.limit, 80, 200),
    });
    sendJson(response, 200, {
      agent_id: result.agent.id,
      agent_name: result.agent.name,
      context: result.context,
      messages: result.messages,
    });
    return;
  }

  if (request.method === 'GET' && parts.length === 3 && parts[0] === 'agents' && parts[2] === 'tasks') {
    const result = await listAgentTasks({
      agentId: parts[1],
      limit: intParam(url.searchParams.get('limit'), 20, 100),
    });
    sendJson(response, 200, {
      agent_id: result.agent.id,
      agent_name: result.agent.name,
      tasks: result.tasks,
      source: result.source,
      missing_tasks_table: Boolean(result.missing_tasks_table),
    });
    return;
  }

  if (request.method === 'POST' && parts.length === 3 && parts[0] === 'agents' && parts[2] === 'evolve') {
    const body = await readJson(request);
    const result = await evolveIdentity({
      agentId: parts[1],
      agentKey: body.agent_key || null,
    });
    sendJson(response, 200, {
      agent_id: result.agent.id,
      agent_name: result.agent.name,
      snapshots: {
        private: result.snapshots.private.id,
        visitor: result.snapshots.visitor.id,
        public: result.snapshots.public.id,
      },
    });
    return;
  }

  if (request.method === 'POST' && parts.length === 3 && parts[0] === 'agents' && parts[2] === 'wake') {
    const body = await readJson(request);
    const result = await wakeAgent({ agentId: parts[1], reason: body.reason || null });
    sendJson(response, 200, {
      agent_id: result.agent.id,
      agent_name: result.agent.name,
      job_id: result.job.id,
      status: result.job.status,
    });
    return;
  }

  if (request.method === 'POST' && parts.length === 4 && parts[0] === 'agents' && parts[2] === 'skills' && parts[3] === 'discover') {
    const body = await readJson(request);
    const result = await discoverSkill({
      agentId: parts[1],
      agentKey: body.agent_key || null,
    });
    sendJson(response, 200, {
      agent_id: result.agent.id,
      agent_name: result.agent.name,
      skill: {
        id: result.skill.id,
        category: result.skill.category,
        description: result.skill.description,
      },
    });
    return;
  }

  sendJson(response, 404, {
    error: {
      code: 'not_found',
      message: 'Route not found.',
    },
  });
}

export function createServer() {
  return http.createServer((request, response) => {
    route(request, response).catch(error => {
      sendError(response, statusForError(error), error);
    });
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const port = getPort();
  createServer().listen(port, () => {
    console.log(`agent-village API listening on http://localhost:${port}`);
  });
}
