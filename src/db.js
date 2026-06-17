import { requiredEnv } from './config.js';

export class DbError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = 'DbError';
    this.code = 'db_error';
    this.exitCode = 1;
    this.details = details;
  }
}

function restUrl() {
  const base = requiredEnv('SUPABASE_URL').replace(/\/+$/, '');
  return base.endsWith('/rest/v1') ? base : `${base}/rest/v1`;
}

function serviceHeaders(extra = {}) {
  const key = requiredEnv('SUPABASE_SERVICE_ROLE_KEY');
  return {
    apikey: key,
    Authorization: `Bearer ${key}`,
    'Content-Type': 'application/json',
    ...extra,
  };
}

function buildUrl(path, query = {}) {
  const url = new URL(`${restUrl()}/${path}`);
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined && value !== null) url.searchParams.set(key, String(value));
  }
  return url;
}

async function parseResponse(response) {
  const text = await response.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

export async function supabaseRequest(path, { method = 'GET', query, body, headers } = {}) {
  const url = buildUrl(path, query);
  const response = await fetch(url, {
    method,
    headers: serviceHeaders(headers),
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await parseResponse(response);
  if (!response.ok) {
    throw new DbError(`Supabase ${method} ${path} failed with ${response.status}.`, {
      status: response.status,
      response: data,
    });
  }
  return data;
}

export async function selectRows(table, query = {}) {
  return supabaseRequest(table, { query });
}

export async function insertRow(table, row) {
  const rows = await supabaseRequest(table, {
    method: 'POST',
    headers: { Prefer: 'return=representation' },
    body: row,
  });
  return Array.isArray(rows) ? rows[0] : rows;
}

export async function updateRows(table, query, patch) {
  return supabaseRequest(table, {
    method: 'PATCH',
    query,
    headers: { Prefer: 'return=representation' },
    body: patch,
  });
}

export async function listAgents() {
  return selectRows('living_agents', {
    select: '*',
    order: 'created_at',
  });
}

export async function getAgentByKey(agentKey) {
  if (!agentKey) throw new DbError('Missing --agent-key.', { code: 'missing_agent_key' });
  const rows = await selectRows('living_agents', {
    select: '*',
    api_key: `eq.${agentKey}`,
    limit: 1,
  });
  const agent = rows?.[0];
  if (!agent) throw new DbError('No agent found for the supplied agent key.', { code: 'invalid_agent_key' });
  return agent;
}

export async function getAgentById(agentId) {
  if (!agentId) throw new DbError('Missing agent id.', { code: 'missing_agent_id' });
  const rows = await selectRows('living_agents', {
    select: '*',
    id: `eq.${agentId}`,
    limit: 1,
  });
  const agent = rows?.[0];
  if (!agent) throw new DbError('No agent found for the supplied agent id.', { code: 'invalid_agent_id' });
  return agent;
}

export async function addPublicMemory(agentId, text) {
  return insertRow('living_memory', { agent_id: agentId, text });
}

export async function addPrivateMemory(agentId, text, source = 'manual') {
  return insertRow('living_private_memory', {
    agent_id: agentId,
    text,
    source_context: source,
  });
}

export async function writeDiary(agentId, text) {
  return insertRow('living_diary', { agent_id: agentId, text });
}

export async function writeLearningLog(agentId, text, { proofUrl = null, emoji = null } = {}) {
  return insertRow('living_log', {
    agent_id: agentId,
    text,
    proof_url: proofUrl,
    emoji,
  });
}

export async function writeActivityEvent(agentId, text, type = 'status_update') {
  return insertRow('living_activity_events', {
    agent_id: agentId,
    event_type: type,
    content: text,
  });
}

export async function createConversation({ agentId, context, externalUserId = null, title = null }) {
  return insertRow('living_conversations', {
    agent_id: agentId,
    context,
    external_user_id: externalUserId,
    title,
  });
}

export async function addMessage({ conversationId, agentId, context, role, text, metadata = {} }) {
  return insertRow('living_messages', {
    conversation_id: conversationId,
    agent_id: agentId,
    context,
    role,
    text,
    metadata,
  });
}

export async function getCurrentIdentity(agentId, visibility) {
  const rows = await selectRows('living_identity_snapshots', {
    select: '*',
    agent_id: `eq.${agentId}`,
    visibility: `eq.${visibility}`,
    is_current: 'eq.true',
    order: 'created_at.desc',
    limit: 1,
  });
  return rows?.[0] || null;
}

export async function insertIdentitySnapshot(agentId, visibility, snapshot) {
  await updateRows('living_identity_snapshots', {
    agent_id: `eq.${agentId}`,
    visibility: `eq.${visibility}`,
    is_current: 'eq.true',
  }, {
    is_current: false,
    updated_at: new Date().toISOString(),
  });

  return insertRow('living_identity_snapshots', {
    agent_id: agentId,
    visibility,
    summary: snapshot.summary || snapshot.bio || '',
    traits: snapshot.traits || [],
    status: snapshot.status || null,
    bio: snapshot.bio || null,
    is_current: true,
    model: snapshot.model || null,
    source_digest: snapshot.source_digest || null,
  });
}

export async function updateAgentPublicIdentity(agentId, patch) {
  const cleanPatch = Object.fromEntries(
    Object.entries(patch).filter(([, value]) => value !== undefined && value !== null && value !== '')
  );
  if (!Object.keys(cleanPatch).length) return null;
  cleanPatch.updated_at = new Date().toISOString();
  const rows = await updateRows('living_agents', { id: `eq.${agentId}` }, cleanPatch);
  return rows?.[0] || null;
}

export async function getPublicContext(agentId, limits = {}) {
  const [diary, logs, skills, memory, visitorIdentity, publicIdentity] = await Promise.all([
    selectRows('living_diary', {
      select: 'text,created_at',
      agent_id: `eq.${agentId}`,
      order: 'created_at.desc',
      limit: limits.diary || 8,
    }),
    selectRows('living_log', {
      select: 'text,emoji,created_at',
      agent_id: `eq.${agentId}`,
      order: 'created_at.desc',
      limit: limits.logs || 8,
    }),
    selectRows('living_skills', {
      select: 'category,description,created_at',
      agent_id: `eq.${agentId}`,
      order: 'created_at.desc',
      limit: limits.skills || 8,
    }),
    selectRows('living_memory', {
      select: 'text,created_at',
      agent_id: `eq.${agentId}`,
      order: 'created_at.desc',
      limit: limits.memory || 6,
    }),
    getCurrentIdentity(agentId, 'visitor'),
    getCurrentIdentity(agentId, 'public'),
  ]);

  return { diary, logs, skills, memory, visitorIdentity, publicIdentity };
}

export async function getOwnerPrivateContext(agentId, limits = {}) {
  const [privateMemory, privateIdentity] = await Promise.all([
    selectRows('living_private_memory', {
      select: 'text,source_context,created_at',
      agent_id: `eq.${agentId}`,
      order: 'created_at.desc',
      limit: limits.privateMemory || 12,
    }),
    getCurrentIdentity(agentId, 'private'),
  ]);
  return { privateMemory, privateIdentity };
}

export async function getEvolutionContext(agentId) {
  const [publicContext, ownerContext, messages] = await Promise.all([
    getPublicContext(agentId, { diary: 16, logs: 16, skills: 12, memory: 12 }),
    getOwnerPrivateContext(agentId, { privateMemory: 24 }),
    selectRows('living_messages', {
      select: 'context,role,text,created_at',
      agent_id: `eq.${agentId}`,
      order: 'created_at.desc',
      limit: 40,
    }),
  ]);

  return { publicContext, ownerContext, messages };
}

export async function latestAgentActivityAt(agentId) {
  const queries = [
    selectRows('living_private_memory', { select: 'created_at', agent_id: `eq.${agentId}`, order: 'created_at.desc', limit: 1 }),
    selectRows('living_diary', { select: 'created_at', agent_id: `eq.${agentId}`, order: 'created_at.desc', limit: 1 }),
    selectRows('living_log', { select: 'created_at', agent_id: `eq.${agentId}`, order: 'created_at.desc', limit: 1 }),
    selectRows('living_messages', { select: 'created_at', agent_id: `eq.${agentId}`, order: 'created_at.desc', limit: 1 }),
  ];
  const results = await Promise.all(queries);
  const timestamps = results.flat().map(row => row.created_at).filter(Boolean);
  if (!timestamps.length) return null;
  return timestamps.sort((a, b) => new Date(b) - new Date(a))[0];
}
