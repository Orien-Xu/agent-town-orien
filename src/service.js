import {
  addMessage,
  addPrivateMemory,
  addPublicMemory,
  addSkill,
  appendTaskEvent,
  claimJob,
  completeJob,
  createConversation,
  createSubscription,
  createTask,
  enqueueJob,
  failJob,
  getAgentById,
  getAgentByKey,
  getCurrentIdentity,
  getEvolutionContext,
  getEventById,
  getOwnerPrivateContext,
  getPublicContext,
  insertIdentitySnapshot,
  latestAgentRowAt,
  latestAgentActivityAt,
  listJobs,
  listAgents,
  listRecentJobs,
  listSubscriptions,
  listTasks,
  publishEvent,
  selectRows,
  updateAgentPublicIdentity,
  writeActivityEvent,
  writeDiary,
  writeLearningLog,
} from './db.js';
import { getModel, generateJson, generateText } from './openai.js';
import {
  buildChatInput,
  buildEvolutionInput,
  formatPrivateContext,
  formatPublicContext,
  identityEvolutionInstructions,
  ownerChatInstructions,
  proactiveDiaryInstructions,
  publicReactionInstructions,
  publicSummaryInstructions,
  skillDiscoveryInstructions,
  strangerChatInstructions,
} from './prompts.js';
import { getOwnerPasscode } from './config.js';

function usageError(message) {
  const error = new Error(message);
  error.code = 'usage_error';
  error.exitCode = 2;
  return error;
}

function unauthorizedError(message) {
  const error = new Error(message);
  error.code = 'unauthorized';
  error.exitCode = 1;
  return error;
}

// Stateless owner-session check: a valid passcode is the bearer credential for owner mode.
export function assertOwnerToken(token) {
  if (!token || token !== getOwnerPasscode()) {
    throw unauthorizedError('Invalid or missing owner passcode.');
  }
}

const PUBLIC_REACTION_EVENT_TYPES = new Set([
  'diary_posted',
  'public_feed_posted',
  'public_memory_added',
]);

const TASK_INTENT_PATTERN = /\b(create|start|queue|run|track|plan|make|build|work on|set up)\b[\s\S]{0,80}\b(task|todo|job|project|work item)\b|\b(task|todo|job)\b[\s\S]{0,80}\b(create|start|queue|run|track|plan|make|build|work on|set up)\b/i;
const PRIVATE_DETAIL_PATTERN = /\b(secret|private|password|token|api key|key|birthday|wife|husband|partner|child|family|address|phone|email|medical|health|bank|ssn)\b/i;
const IDENTITY_SCHEMA = {
  type: 'object',
  properties: {
    private: {
      type: 'object',
      properties: {
        summary: { type: 'string' },
        traits: { type: 'array', items: { type: 'string' } },
        status: { type: 'string' },
        bio: { type: 'string' },
      },
    },
    visitor: {
      type: 'object',
      properties: {
        summary: { type: 'string' },
        traits: { type: 'array', items: { type: 'string' } },
        status: { type: 'string' },
        bio: { type: 'string' },
      },
    },
    public: {
      type: 'object',
      properties: {
        summary: { type: 'string' },
        traits: { type: 'array', items: { type: 'string' } },
        status: { type: 'string' },
        bio: { type: 'string' },
        visitor_bio: { type: 'string' },
      },
    },
  },
  required: ['private', 'visitor', 'public'],
};

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function sinceIso(seconds) {
  return new Date(Date.now() - seconds * 1000).toISOString();
}

function eventAgentIds(event) {
  return new Set([event.source_agent_id, event.target_agent_id].filter(Boolean));
}

function truncate(text, length = 240) {
  if (!text) return '';
  return text.length > length ? `${text.slice(0, length - 1)}...` : text;
}

function isMissingTasksTable(error) {
  return error?.code === 'db_error'
    && /living_tasks|schema cache|Could not find the table|relation .*living_tasks/i.test(error.message || '');
}

function taskRequested(message) {
  return TASK_INTENT_PATTERN.test(message || '');
}

function taskTitleFromMessage(message, context) {
  if (context === 'owner' && PRIVATE_DETAIL_PATTERN.test(message || '')) {
    return 'Owner-requested private task';
  }
  const cleaned = String(message || '')
    .replace(/\s+/g, ' ')
    .replace(/^(please\s+)?(can|could|would)\s+you\s+/i, '')
    .replace(/\b(create|start|queue|run|track|plan|make|build|work on|set up)\s+(a\s+|an\s+|the\s+)?(task|todo|job|project|work item)\s*(to|for|about|called)?\s*/i, '')
    .trim();
  const fallback = context === 'owner' ? 'Owner-requested task' : 'Visitor-requested task';
  return truncate(cleaned || fallback, 120);
}

function taskEvent(state, text) {
  return {
    state,
    text,
    timestamp: new Date().toISOString(),
  };
}

function actionForJob(job, label = 'Worker job queued') {
  return {
    type: 'job_queued',
    label,
    job_id: job.id,
    job_type: job.job_type,
    status: job.status,
  };
}

function taskFromJob(job) {
  const done = job.status === 'succeeded';
  const failed = job.status === 'failed';
  const running = job.status === 'running';
  const state = done ? 'completed' : failed ? 'error' : running ? 'in_progress' : 'planning';
  const title = job.input?.public_title || 'Queued task';
  const events = [
    taskEvent('planning', `Queued: ${title}`),
  ];
  if (running) events.push(taskEvent('in_progress', 'Worker is processing this task.'));
  if (done) events.push(taskEvent('completed', job.output?.text || 'Task completed.'));
  if (failed) events.push(taskEvent('error', job.error || 'Task failed.'));
  return {
    id: job.input?.task_id || job.id,
    agent_id: job.agent_id,
    title,
    state,
    events,
    is_public: false,
    created_at: job.created_at,
    updated_at: job.updated_at,
    completed_at: job.completed_at,
  };
}

function jobVisibilityFor(actionType, eventVisibility) {
  if (actionType === 'react_to_public_event') return 'public';
  if (actionType === 'evolve_identity') return 'internal';
  return eventVisibility || 'internal';
}

function priorityFor(actionType) {
  if (actionType === 'evolve_identity') return 40;
  if (actionType === 'react_to_public_event') return 80;
  return 100;
}

function sameSubscription(a, b) {
  return a.subscriber_agent_id === b.subscriberAgentId
    && a.event_type === b.eventType
    && a.visibility === b.visibility
    && a.action_type === b.actionType;
}

function matchesSubscription(event, subscription) {
  if (!subscription.enabled) return false;
  if (subscription.event_type !== '*' && subscription.event_type !== event.event_type) return false;
  if (subscription.visibility && subscription.visibility !== event.visibility) return false;

  const filter = subscription.filter || {};
  if (filter.source_agent_id && filter.source_agent_id !== event.source_agent_id) return false;
  if (filter.target_agent_id && filter.target_agent_id !== event.target_agent_id) return false;
  if (filter.exclude_source_agent_id && filter.exclude_source_agent_id === event.source_agent_id) return false;
  if (filter.exclude_target_agent_id && filter.exclude_target_agent_id === event.target_agent_id) return false;
  if (Array.isArray(filter.event_types) && !filter.event_types.includes(event.event_type)) return false;
  if (Array.isArray(filter.exclude_event_types) && filter.exclude_event_types.includes(event.event_type)) return false;

  if (!subscription.subscriber_agent_id) return true;

  if (event.visibility === 'public') {
    return !(filter.skip_own_agent && subscription.subscriber_agent_id === event.source_agent_id);
  }

  return eventAgentIds(event).has(subscription.subscriber_agent_id);
}

async function subscriptionIsThrottled(subscription) {
  if (!subscription.subscriber_agent_id) return false;

  if (subscription.cooldown_seconds > 0) {
    const recent = await listRecentJobs({
      agentId: subscription.subscriber_agent_id,
      jobType: subscription.action_type,
      since: sinceIso(subscription.cooldown_seconds),
      statuses: ['queued', 'running', 'succeeded', 'failed'],
      limit: 100,
    });
    if (recent.some(job => job.input?.subscription_id === subscription.id)) return true;
  }

  if (subscription.max_per_day) {
    const today = await listRecentJobs({
      agentId: subscription.subscriber_agent_id,
      jobType: subscription.action_type,
      since: sinceIso(24 * 60 * 60),
      statuses: ['queued', 'running', 'succeeded', 'failed'],
      limit: 500,
    });
    const count = today.filter(job => job.input?.subscription_id === subscription.id).length;
    if (count >= subscription.max_per_day) return true;
  }

  return false;
}

export async function fanoutEvent(event) {
  const subscriptions = await listSubscriptions();
  const jobs = [];
  for (const subscription of subscriptions) {
    if (!matchesSubscription(event, subscription)) continue;
    if (await subscriptionIsThrottled(subscription)) continue;

    jobs.push(await enqueueJob({
      agentId: subscription.subscriber_agent_id,
      jobType: subscription.action_type,
      visibility: jobVisibilityFor(subscription.action_type, event.visibility),
      priority: priorityFor(subscription.action_type),
      inputEventId: event.id,
      input: {
        subscription_id: subscription.id,
        event_id: event.id,
        event_type: event.event_type,
        event_summary: event.summary,
      },
    }));
  }
  return jobs;
}

export async function publishAgentEvent(event, { fanout = true } = {}) {
  const row = await publishEvent(event);
  const jobs = fanout ? await fanoutEvent(row) : [];
  return { event: row, jobs };
}

export async function seedDefaultSubscriptions() {
  const agents = await listAgents();
  const existing = await listSubscriptions();
  const created = [];

  for (const agent of agents) {
    const defaults = [
      {
        subscriberAgentId: agent.id,
        eventType: 'diary_posted',
        visibility: 'public',
        actionType: 'react_to_public_event',
        filter: { skip_own_agent: true },
        cooldownSeconds: 15 * 60,
        maxPerDay: 4,
      },
      {
        subscriberAgentId: agent.id,
        eventType: 'public_feed_posted',
        visibility: 'public',
        actionType: 'react_to_public_event',
        filter: { skip_own_agent: true },
        cooldownSeconds: 15 * 60,
        maxPerDay: 4,
      },
      {
        subscriberAgentId: agent.id,
        eventType: 'public_memory_added',
        visibility: 'public',
        actionType: 'react_to_public_event',
        filter: { skip_own_agent: true },
        cooldownSeconds: 30 * 60,
        maxPerDay: 2,
      },
      {
        subscriberAgentId: agent.id,
        eventType: 'owner_message_received',
        visibility: 'private',
        actionType: 'evolve_identity',
        filter: {},
        cooldownSeconds: 5 * 60,
        maxPerDay: 24,
      },
      {
        subscriberAgentId: agent.id,
        eventType: 'stranger_message_received',
        visibility: 'visitor',
        actionType: 'evolve_identity',
        filter: {},
        cooldownSeconds: 10 * 60,
        maxPerDay: 12,
      },
    ];

    for (const def of defaults) {
      if (existing.some(subscription => sameSubscription(subscription, def))) continue;
      const row = await createSubscription({
        subscriber_agent_id: def.subscriberAgentId,
        event_type: def.eventType,
        visibility: def.visibility,
        action_type: def.actionType,
        filter: def.filter,
        cooldown_seconds: def.cooldownSeconds,
        max_per_day: def.maxPerDay,
      });
      existing.push(row);
      created.push(row);
    }
  }

  return { agents, created };
}

export async function resolveAgentForContext({ context, agentKey, agentId, ownerToken }) {
  if (context === 'owner') {
    // Global owner session: a valid passcode authorizes owner access to any agent by id.
    if (ownerToken) {
      assertOwnerToken(ownerToken);
      return getAgentById(agentId);
    }
    // CLI back-compat: per-agent api key.
    if (agentKey) return getAgentByKey(agentKey);
    throw unauthorizedError('Owner access requires a passcode (owner_token) or agent key.');
  }
  if (agentId) return getAgentById(agentId);
  if (agentKey) return getAgentByKey(agentKey);
  return getAgentById(agentId);
}

export async function addMemoryCommand({ agentKey, text, isPrivate }) {
  const agent = await getAgentByKey(agentKey);
  const row = isPrivate
    ? await addPrivateMemory(agent.id, text, 'manual')
    : await addPublicMemory(agent.id, text);
  const eventResult = await publishAgentEvent({
    eventType: isPrivate ? 'private_memory_added' : 'public_memory_added',
    visibility: isPrivate ? 'private' : 'public',
    sourceAgentId: agent.id,
    summary: isPrivate ? 'Private memory added.' : truncate(text),
    payload: {
      memory_id: row.id,
      source: 'manual',
    },
  });
  return { agent, row, private: Boolean(isPrivate), event: eventResult.event, jobs: eventResult.jobs };
}

export async function writeDiaryCommand({ agentKey, text }) {
  const agent = await getAgentByKey(agentKey);
  const row = await writeDiary(agent.id, text);
  const eventResult = await publishAgentEvent({
    eventType: 'diary_posted',
    visibility: 'public',
    sourceAgentId: agent.id,
    summary: truncate(text),
    payload: { diary_id: row.id },
  });
  return { agent, row, event: eventResult.event, jobs: eventResult.jobs };
}

export async function writePublicDiaryFromPrivateMemory({ agentKey, text }) {
  const agent = await getAgentByKey(agentKey);
  const publicText = await generateText({
    instructions: publicSummaryInstructions(agent),
    input: text,
    maxOutputTokens: 350,
  });
  const row = await writeDiary(agent.id, publicText);
  const eventResult = await publishAgentEvent({
    eventType: 'diary_posted',
    visibility: 'public',
    sourceAgentId: agent.id,
    summary: truncate(publicText),
    payload: {
      diary_id: row.id,
      generated_from_private_memory: true,
    },
  });
  return { agent, row, publicText, event: eventResult.event, jobs: eventResult.jobs };
}

export async function postFeedCommand({ agentKey, text, type = 'learning_log', proofUrl = null, emoji = null }) {
  const agent = await getAgentByKey(agentKey);
  let row;
  let eventType = 'public_feed_posted';
  if (type === 'diary_entry' || type === 'diary') {
    row = await writeDiary(agent.id, text);
    eventType = 'diary_posted';
  } else if (type === 'memory_added' || type === 'memory') {
    row = await addPublicMemory(agent.id, text);
    eventType = 'public_memory_added';
  } else if (type === 'learning_log' || type === 'log') {
    row = await writeLearningLog(agent.id, text, { proofUrl, emoji });
  } else {
    row = await writeActivityEvent(agent.id, text, type);
  }
  const eventResult = await publishAgentEvent({
    eventType,
    visibility: 'public',
    sourceAgentId: agent.id,
    summary: truncate(text),
    payload: {
      row_id: row.id,
      feed_type: type,
      proof_url: proofUrl,
      emoji,
    },
  });
  return { agent, row, type, event: eventResult.event, jobs: eventResult.jobs };
}

export async function discoverSkill({ agentKey = null, agentId = null }) {
  const agent = agentKey ? await getAgentByKey(agentKey) : await getAgentById(agentId);
  const context = await getPublicContext(agent.id);
  const output = await generateJson({
    instructions: skillDiscoveryInstructions(agent),
    input: [
      'Your public context (existing skills must not be duplicated):',
      formatPublicContext(agent, context),
      '',
      'Respond with a single JSON object containing "category" and "description".',
    ].join('\n'),
    maxOutputTokens: 300,
  });

  const description = (output?.description || '').trim();
  if (!description) throw usageError('Skill discovery did not return a description.');
  const category = (output?.category || 'general').toString().trim().toLowerCase() || 'general';

  const skill = await addSkill(agent.id, { category, description });
  // The activity_feed view reads living_skills directly, so the new skill shows up
  // in the public feed automatically; the event below is for observability + fan-out.
  const eventResult = await publishAgentEvent({
    eventType: 'skill_discovered',
    visibility: 'public',
    sourceAgentId: agent.id,
    summary: truncate(`${category}: ${description}`),
    payload: { skill_id: skill.id, category },
  });

  return { agent, skill, event: eventResult.event, jobs: eventResult.jobs };
}

async function queueTaskFromChat({ agent, context, message, conversation, causedByEventId }) {
  const title = taskTitleFromMessage(message, context);
  const initialEvent = taskEvent('planning', `${title} queued from ${context} chat.`);
  const actions = [];
  let task = null;
  let taskTableMissing = false;

  try {
    task = await createTask({
      agentId: agent.id,
      title,
      context: `${context}_chat`,
      conversationId: conversation.id,
      events: [initialEvent],
    });
    actions.push({
      type: 'task_created',
      label: 'Task created',
      task_id: task.id,
      title,
      state: task.state,
    });
  } catch (error) {
    if (!isMissingTasksTable(error)) throw error;
    taskTableMissing = true;
    actions.push({
      type: 'task_pending_schema',
      label: 'Task table missing',
      title,
      detail: 'Queued a worker job; run the updated migration for task cards.',
    });
  }

  const job = await enqueueJob({
    agentId: agent.id,
    jobType: 'run_task',
    visibility: context === 'owner' ? 'private' : 'visitor',
    priority: 65,
    inputEventId: causedByEventId,
    input: {
      task_id: task?.id || null,
      public_title: title,
      original_message: message,
      conversation_id: conversation.id,
      context,
      task_table_missing: taskTableMissing,
    },
  });
  actions.push(actionForJob(job, 'Task worker queued'));

  const eventResult = await publishAgentEvent({
    eventType: 'task_queued',
    visibility: context === 'owner' ? 'private' : 'visitor',
    sourceAgentId: agent.id,
    conversationId: conversation.id,
    causedByEventId,
    summary: `${title} queued.`,
    payload: {
      task_id: task?.id || null,
      job_id: job.id,
      task_table_missing: taskTableMissing,
    },
  }, { fanout: false });

  return { task, job, actions };
}

export async function listChatHistory({ context, agentKey, agentId, ownerToken, limit = 80 }) {
  if (!['owner', 'stranger'].includes(context)) {
    throw usageError(`Unsupported chat context: ${context}`);
  }
  const agent = await resolveAgentForContext({ context, agentKey, agentId, ownerToken });
  const safeLimit = Math.min(Math.max(Number(limit) || 80, 1), 200);
  const rows = await selectRows('living_messages', {
    select: 'id,conversation_id,context,role,text,metadata,created_at',
    agent_id: `eq.${agent.id}`,
    context: `eq.${context}`,
    order: 'created_at.desc',
    limit: safeLimit,
  });
  return {
    agent,
    context,
    messages: (rows || []).reverse(),
  };
}

export async function listAgentTasks({ agentId, limit = 20 }) {
  const agent = await getAgentById(agentId);
  const safeLimit = Math.min(Math.max(Number(limit) || 20, 1), 100);
  try {
    const tasks = await listTasks({ agentId: agent.id, limit: safeLimit });
    return { agent, tasks, source: 'living_tasks' };
  } catch (error) {
    if (!isMissingTasksTable(error)) throw error;
    const jobs = await listJobs({ agentId: agent.id, limit: safeLimit * 3 });
    const tasks = jobs
      .filter(job => job.job_type === 'run_task')
      .slice(0, safeLimit)
      .map(taskFromJob);
    return { agent, tasks, source: 'living_agent_jobs', missing_tasks_table: true };
  }
}

export async function chatWithAgent({ context, agentKey, agentId, ownerToken, message, externalUserId = null }) {
  if (!['owner', 'stranger'].includes(context)) {
    throw usageError(`Unsupported chat context: ${context}`);
  }
  if (!message) throw usageError('Missing message.');

  const agent = await resolveAgentForContext({ context, agentKey, agentId, ownerToken });
  const publicContext = formatPublicContext(agent, await getPublicContext(agent.id));
  const ownerContext = context === 'owner'
    ? formatPrivateContext(await getOwnerPrivateContext(agent.id))
    : null;

  const conversation = await createConversation({
    agentId: agent.id,
    context,
    externalUserId,
    title: message.slice(0, 80),
  });

  const userMessage = await addMessage({
    conversationId: conversation.id,
    agentId: agent.id,
    context,
    role: 'user',
    text: message,
  });

  const actions = [];
  const userEventResult = await publishAgentEvent({
    eventType: context === 'owner' ? 'owner_message_received' : 'stranger_message_received',
    visibility: context === 'owner' ? 'private' : 'visitor',
    targetAgentId: agent.id,
    conversationId: conversation.id,
    summary: context === 'owner' ? 'Owner sent a private message.' : truncate(message),
    payload: {
      message_id: userMessage.id,
      external_user_id: externalUserId,
    },
  });
  actions.push(...userEventResult.jobs.map(job => actionForJob(job, 'Subscription job queued')));

  if (context === 'owner') {
    await addPrivateMemory(agent.id, `Owner said: ${message}`, 'owner_chat');
    const memoryEventResult = await publishAgentEvent({
      eventType: 'private_memory_added',
      visibility: 'private',
      sourceAgentId: agent.id,
      conversationId: conversation.id,
      causedByEventId: userEventResult.event.id,
      summary: 'Private memory added from owner chat.',
      payload: {
        source: 'owner_chat',
        message_id: userMessage.id,
      },
    });
    actions.push({
      type: 'private_memory_recorded',
      label: 'Private memory stored',
      event_id: memoryEventResult.event.id,
    });
    actions.push(...memoryEventResult.jobs.map(job => actionForJob(job, 'Subscription job queued')));
  }

  if (taskRequested(message)) {
    const taskResult = await queueTaskFromChat({
      agent,
      context,
      message,
      conversation,
      causedByEventId: userEventResult.event.id,
    });
    actions.push(...taskResult.actions);
  }

  const instructions = context === 'owner'
    ? ownerChatInstructions(agent)
    : strangerChatInstructions(agent);
  const reply = await generateText({
    instructions,
    input: buildChatInput({ message, publicContext, privateContext: ownerContext }),
  });

  const agentMessage = await addMessage({
    conversationId: conversation.id,
    agentId: agent.id,
    context,
    role: 'agent',
    text: reply,
    metadata: { model: getModel() },
  });

  const replyEventResult = await publishAgentEvent({
    eventType: context === 'owner' ? 'owner_reply_sent' : 'stranger_reply_sent',
    visibility: context === 'owner' ? 'private' : 'visitor',
    sourceAgentId: agent.id,
    conversationId: conversation.id,
    causedByEventId: userEventResult.event.id,
    summary: context === 'owner' ? 'Private owner reply sent.' : truncate(reply),
    payload: {
      message_id: agentMessage.id,
      model: getModel(),
    },
  });
  actions.push(...replyEventResult.jobs.map(job => actionForJob(job, 'Subscription job queued')));

  return { agent, conversation, message: reply, context, actions };
}

function snapshotFromOutput(output, key, fallback = {}) {
  const value = output?.[key] || {};
  return {
    summary: value.summary || fallback.summary || '',
    traits: Array.isArray(value.traits) ? value.traits : [],
    status: value.status || fallback.status || '',
    bio: value.bio || fallback.bio || '',
    model: getModel(),
  };
}

export async function evolveIdentity({ agentKey, agentId, causedByEventId = null, emitEvent = true }) {
  const agent = agentKey ? await getAgentByKey(agentKey) : await getAgentById(agentId);
  if (agentId && agent.id !== agentId) {
    throw usageError('Agent key does not match the requested agent id.');
  }
  const context = await getEvolutionContext(agent.id);
  const publicContext = formatPublicContext(agent, context.publicContext);
  const privateContext = formatPrivateContext(context.ownerContext);
  const output = await generateJson({
    instructions: identityEvolutionInstructions(agent),
    input: buildEvolutionInput({ publicContext, privateContext, messages: context.messages }),
    schema: IDENTITY_SCHEMA,
    schemaName: 'identity_evolution',
  });

  const privateSnapshot = await insertIdentitySnapshot(
    agent.id,
    'private',
    snapshotFromOutput(output, 'private', { summary: agent.bio, status: agent.status, bio: agent.bio })
  );
  const visitorSnapshot = await insertIdentitySnapshot(
    agent.id,
    'visitor',
    snapshotFromOutput(output, 'visitor', { summary: agent.visitor_bio || agent.bio, status: agent.status, bio: agent.visitor_bio || agent.bio })
  );
  const publicSnapshot = await insertIdentitySnapshot(
    agent.id,
    'public',
    snapshotFromOutput(output, 'public', { summary: agent.bio, status: agent.status, bio: agent.bio })
  );

  const publicOut = output?.public || {};
  const updatedAgent = await updateAgentPublicIdentity(agent.id, {
    bio: publicOut.bio,
    visitor_bio: publicOut.visitor_bio || output?.visitor?.bio,
    status: publicOut.status,
  });

  const result = {
    agent: updatedAgent || agent,
    snapshots: {
      private: privateSnapshot,
      visitor: visitorSnapshot,
      public: publicSnapshot,
    },
  };

  if (emitEvent) {
    await publishAgentEvent({
      eventType: 'identity_evolved',
      visibility: 'internal',
      sourceAgentId: result.agent.id,
      causedByEventId,
      summary: 'Identity snapshots updated.',
      payload: {
        private_snapshot_id: privateSnapshot.id,
        visitor_snapshot_id: visitorSnapshot.id,
        public_snapshot_id: publicSnapshot.id,
        model: getModel(),
      },
    }, { fanout: false });
  }

  return result;
}

export async function shouldEvolveIdentity(agent) {
  const [privateCurrent, visitorCurrent, publicCurrent, latestActivity] = await Promise.all([
    getCurrentIdentity(agent.id, 'private'),
    getCurrentIdentity(agent.id, 'visitor'),
    getCurrentIdentity(agent.id, 'public'),
    latestAgentActivityAt(agent.id),
  ]);

  if (!privateCurrent || !visitorCurrent || !publicCurrent) return true;
  if (!latestActivity) return false;
  const newestSnapshot = [privateCurrent, visitorCurrent, publicCurrent]
    .map(snapshot => new Date(snapshot.created_at).getTime())
    .sort((a, b) => b - a)[0];
  return new Date(latestActivity).getTime() > newestSnapshot;
}

async function hasRecentJob(agentId, jobType, seconds, statuses = ['queued', 'running']) {
  const jobs = await listRecentJobs({
    agentId,
    jobType,
    since: sinceIso(seconds),
    statuses,
    limit: 50,
  });
  return jobs.length > 0;
}

async function maybeGetAgent(agentId) {
  if (!agentId) return null;
  try {
    return await getAgentById(agentId);
  } catch {
    return null;
  }
}

async function processEvolveIdentityJob(job) {
  const result = await evolveIdentity({
    agentId: job.agent_id,
    causedByEventId: job.input_event_id || job.input?.event_id || null,
  });
  return {
    agent_id: result.agent.id,
    snapshots: {
      private: result.snapshots.private.id,
      visitor: result.snapshots.visitor.id,
      public: result.snapshots.public.id,
    },
  };
}

async function processWriteDiaryJob(job) {
  const agent = await getAgentById(job.agent_id);
  const sourceEvent = await getEventById(job.input_event_id || job.input?.event_id);
  const publicContext = formatPublicContext(agent, await getPublicContext(agent.id));
  const input = [
    'Public context:',
    publicContext,
    '',
    'Scheduling reason:',
    job.input?.reason || 'The scheduler decided this agent is due for a public diary entry.',
    sourceEvent ? `\nRecent event:\n${sourceEvent.event_type}: ${sourceEvent.summary || 'no summary'}` : '',
  ].filter(Boolean).join('\n');

  const text = await generateText({
    instructions: proactiveDiaryInstructions(agent),
    input,
    maxOutputTokens: 350,
  });
  const row = await writeDiary(agent.id, text);
  const eventResult = await publishAgentEvent({
    eventType: 'diary_posted',
    visibility: 'public',
    sourceAgentId: agent.id,
    causedByEventId: sourceEvent?.id || null,
    summary: truncate(text),
    payload: {
      diary_id: row.id,
      job_id: job.id,
      proactive: true,
    },
  });

  return {
    diary_id: row.id,
    event_id: eventResult.event.id,
    fanout_jobs: eventResult.jobs.map(fanoutJob => fanoutJob.id),
    text,
  };
}

async function processPublicReactionJob(job) {
  const sourceEvent = await getEventById(job.input_event_id || job.input?.event_id);
  if (!sourceEvent) throw usageError('Reaction job is missing its source event.');
  if (sourceEvent.visibility !== 'public') throw usageError('Reaction jobs can only read public events.');
  if (!PUBLIC_REACTION_EVENT_TYPES.has(sourceEvent.event_type)) {
    return { skipped: true, reason: `No public reaction policy for ${sourceEvent.event_type}.` };
  }
  if (sourceEvent.source_agent_id && sourceEvent.source_agent_id === job.agent_id) {
    return { skipped: true, reason: 'Agent does not react to its own public event.' };
  }

  const agent = await getAgentById(job.agent_id);
  const sourceAgent = await maybeGetAgent(sourceEvent.source_agent_id);
  const publicContext = formatPublicContext(agent, await getPublicContext(agent.id));
  const input = [
    'Public event to react to:',
    `${sourceAgent?.name || 'Someone'} posted ${sourceEvent.event_type}: ${sourceEvent.summary || 'no summary'}`,
    '',
    'Your public context:',
    publicContext,
  ].join('\n');

  const text = await generateText({
    instructions: publicReactionInstructions(agent),
    input,
    maxOutputTokens: 220,
  });
  const row = await writeActivityEvent(agent.id, text, 'agent_reaction');
  const eventResult = await publishAgentEvent({
    eventType: 'agent_reaction_posted',
    visibility: 'public',
    sourceAgentId: agent.id,
    causedByEventId: sourceEvent.id,
    summary: truncate(text),
    payload: {
      activity_event_id: row.id,
      reacted_to_event_id: sourceEvent.id,
      job_id: job.id,
    },
  });

  return {
    activity_event_id: row.id,
    event_id: eventResult.event.id,
    text,
  };
}

async function processRunTaskJob(job) {
  const agent = await getAgentById(job.agent_id);
  const taskId = job.input?.task_id || null;
  const title = job.input?.public_title || 'Queued task';
  let task = null;

  if (taskId) {
    try {
      task = await appendTaskEvent(taskId, taskEvent('in_progress', `${title} started.`), {
        state: 'in_progress',
      });
    } catch (error) {
      if (!isMissingTasksTable(error)) throw error;
    }
  }

  const publicContext = formatPublicContext(agent, await getPublicContext(agent.id));
  const input = [
    'Task request from chat. The original request may contain private details.',
    `Public-safe task title: ${title}`,
    '',
    'Original request:',
    job.input?.original_message || title,
    '',
    'Public context:',
    publicContext,
    '',
    'Write one concise public-safe completion note. Do not reveal owner-private facts, exact private dates, contact details, secrets, or hidden conversation history. Do not claim you used external tools or files. Focus on what the agent did inside the village prototype.',
  ].join('\n');

  const text = await generateText({
    instructions: publicSummaryInstructions(agent),
    input,
    maxOutputTokens: 220,
  });

  if (taskId) {
    try {
      task = await appendTaskEvent(taskId, taskEvent('completed', text), {
        state: 'completed',
        completed_at: new Date().toISOString(),
      });
    } catch (error) {
      if (!isMissingTasksTable(error)) throw error;
    }
  }

  const row = await writeActivityEvent(agent.id, text, 'task_completed');
  const eventResult = await publishAgentEvent({
    eventType: 'task_completed',
    visibility: 'public',
    sourceAgentId: agent.id,
    causedByEventId: job.input_event_id || job.input?.event_id || null,
    summary: truncate(text),
    payload: {
      task_id: taskId,
      activity_event_id: row.id,
      job_id: job.id,
    },
  });

  return {
    task_id: task?.id || taskId,
    activity_event_id: row.id,
    event_id: eventResult.event.id,
    fanout_jobs: eventResult.jobs.map(fanoutJob => fanoutJob.id),
    text,
  };
}

export async function processJob(job, logger = console) {
  logger.log?.(`processing job ${job.id} (${job.job_type})`);
  if (job.job_type === 'evolve_identity') return processEvolveIdentityJob(job);
  if (job.job_type === 'write_diary') return processWriteDiaryJob(job);
  if (job.job_type === 'react_to_public_event') return processPublicReactionJob(job);
  if (job.job_type === 'run_task') return processRunTaskJob(job);
  throw usageError(`Unsupported job type: ${job.job_type}`);
}

function retryTimeFor(job) {
  if (job.attempts >= job.max_attempts) return null;
  const delaySeconds = Math.min(300, 5 * (2 ** Math.max(0, job.attempts - 1)));
  return new Date(Date.now() + delaySeconds * 1000).toISOString();
}

export async function runWorker({
  workerId = `agent-village-${process.pid}`,
  intervalSeconds = 2,
  once = false,
  lockSeconds = 120,
  logger = console,
} = {}) {
  let stopped = false;
  const stop = () => { stopped = true; };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);

  do {
    const job = await claimJob(workerId, lockSeconds);
    if (!job) {
      if (once) break;
      await sleep(intervalSeconds * 1000);
      continue;
    }

    try {
      const output = await processJob(job, logger);
      await completeJob(job.id, output);
      logger.log?.(`completed job ${job.id}`);
    } catch (error) {
      const retryAt = retryTimeFor(job);
      await failJob(job.id, error, retryAt);
      const suffix = retryAt ? `; retry after ${retryAt}` : '; no retries left';
      logger.error?.(`job ${job.id} failed: ${error.message}${suffix}`);
    }

    if (once) break;
  } while (!stopped);
}

export async function scheduleDueWorkForAgent(agent, logger = console) {
  const enqueued = [];

  if (await shouldEvolveIdentity(agent)) {
    const alreadyQueued = await hasRecentJob(agent.id, 'evolve_identity', 10 * 60, ['queued', 'running']);
    if (!alreadyQueued) {
      enqueued.push(await enqueueJob({
        agentId: agent.id,
        jobType: 'evolve_identity',
        visibility: 'internal',
        priority: 50,
        input: { reason: 'new_activity_since_identity_snapshot' },
      }));
    }
  }

  const latestDiary = await latestAgentRowAt('living_diary', agent.id);
  const diaryDue = !latestDiary || Date.now() - new Date(latestDiary).getTime() > 30 * 60 * 1000;
  if (diaryDue) {
    const alreadyQueued = await hasRecentJob(agent.id, 'write_diary', 30 * 60, ['queued', 'running']);
    if (!alreadyQueued) {
      enqueued.push(await enqueueJob({
        agentId: agent.id,
        jobType: 'write_diary',
        visibility: 'public',
        priority: 90,
        input: { reason: 'no_recent_public_diary' },
      }));
    }
  }

  if (enqueued.length) {
    logger.log?.(`scheduled ${enqueued.length} job(s) for ${agent.name}`);
  }
  return enqueued;
}

export async function runScheduler({ intervalSeconds = 60, once = false, logger = console } = {}) {
  let stopped = false;
  const stop = () => { stopped = true; };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);

  await seedDefaultSubscriptions();

  do {
    const agents = await listAgents();
    for (const agent of agents) {
      if (stopped) break;
      try {
        await scheduleDueWorkForAgent(agent, logger);
      } catch (error) {
        logger.error?.(`scheduling failed for ${agent.name}: ${error.message}`);
      }
    }
    if (once) break;
    await sleep(intervalSeconds * 1000);
  } while (!stopped);
}

export async function runIdentityDaemon({ intervalSeconds = 60, once = false, logger = console } = {}) {
  let stopped = false;
  const stop = () => { stopped = true; };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);

  do {
    const agents = await listAgents();
    for (const agent of agents) {
      if (stopped) break;
      try {
        if (await shouldEvolveIdentity(agent)) {
          logger.log(`evolving ${agent.name} (${agent.id})`);
          await evolveIdentity({ agentId: agent.id });
        } else {
          logger.log(`skipping ${agent.name}; identity is current`);
        }
      } catch (error) {
        logger.error(`identity evolution failed for ${agent.name}: ${error.message}`);
      }
    }
    if (once) break;
    await new Promise(resolve => setTimeout(resolve, intervalSeconds * 1000));
  } while (!stopped);
}
