import {
  addMessage,
  addPrivateMemory,
  addPublicMemory,
  claimJob,
  completeJob,
  createConversation,
  createSubscription,
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
  listAgents,
  listRecentJobs,
  listSubscriptions,
  publishEvent,
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
  strangerChatInstructions,
} from './prompts.js';

function usageError(message) {
  const error = new Error(message);
  error.code = 'usage_error';
  error.exitCode = 2;
  return error;
}

const PUBLIC_REACTION_EVENT_TYPES = new Set([
  'diary_posted',
  'public_feed_posted',
  'public_memory_added',
]);

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

export async function resolveAgentForContext({ context, agentKey, agentId }) {
  if (context === 'owner') return getAgentByKey(agentKey);
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

export async function chatWithAgent({ context, agentKey, agentId, message, externalUserId = null }) {
  if (!['owner', 'stranger'].includes(context)) {
    throw usageError(`Unsupported chat context: ${context}`);
  }
  if (!message) throw usageError('Missing message.');

  const agent = await resolveAgentForContext({ context, agentKey, agentId });
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

  if (context === 'owner') {
    await addPrivateMemory(agent.id, `Owner said: ${message}`, 'owner_chat');
    await publishAgentEvent({
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

  await publishAgentEvent({
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

  return { agent, conversation, message: reply, context };
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

export async function processJob(job, logger = console) {
  logger.log?.(`processing job ${job.id} (${job.job_type})`);
  if (job.job_type === 'evolve_identity') return processEvolveIdentityJob(job);
  if (job.job_type === 'write_diary') return processWriteDiaryJob(job);
  if (job.job_type === 'react_to_public_event') return processPublicReactionJob(job);
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
