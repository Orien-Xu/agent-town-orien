import {
  addMessage,
  addPrivateMemory,
  addPublicMemory,
  createConversation,
  getAgentById,
  getAgentByKey,
  getCurrentIdentity,
  getEvolutionContext,
  getOwnerPrivateContext,
  getPublicContext,
  insertIdentitySnapshot,
  latestAgentActivityAt,
  listAgents,
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
  publicSummaryInstructions,
  strangerChatInstructions,
} from './prompts.js';

function usageError(message) {
  const error = new Error(message);
  error.code = 'usage_error';
  error.exitCode = 2;
  return error;
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
  return { agent, row, private: Boolean(isPrivate) };
}

export async function writeDiaryCommand({ agentKey, text }) {
  const agent = await getAgentByKey(agentKey);
  const row = await writeDiary(agent.id, text);
  return { agent, row };
}

export async function writePublicDiaryFromPrivateMemory({ agentKey, text }) {
  const agent = await getAgentByKey(agentKey);
  const publicText = await generateText({
    instructions: publicSummaryInstructions(agent),
    input: text,
    maxOutputTokens: 350,
  });
  const row = await writeDiary(agent.id, publicText);
  return { agent, row, publicText };
}

export async function postFeedCommand({ agentKey, text, type = 'learning_log', proofUrl = null, emoji = null }) {
  const agent = await getAgentByKey(agentKey);
  let row;
  if (type === 'diary_entry' || type === 'diary') {
    row = await writeDiary(agent.id, text);
  } else if (type === 'memory_added' || type === 'memory') {
    row = await addPublicMemory(agent.id, text);
  } else if (type === 'learning_log' || type === 'log') {
    row = await writeLearningLog(agent.id, text, { proofUrl, emoji });
  } else {
    row = await writeActivityEvent(agent.id, text, type);
  }
  return { agent, row, type };
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

  await addMessage({
    conversationId: conversation.id,
    agentId: agent.id,
    context,
    role: 'user',
    text: message,
  });

  if (context === 'owner') {
    await addPrivateMemory(agent.id, `Owner said: ${message}`, 'owner_chat');
  }

  const instructions = context === 'owner'
    ? ownerChatInstructions(agent)
    : strangerChatInstructions(agent);
  const reply = await generateText({
    instructions,
    input: buildChatInput({ message, publicContext, privateContext: ownerContext }),
  });

  await addMessage({
    conversationId: conversation.id,
    agentId: agent.id,
    context,
    role: 'agent',
    text: reply,
    metadata: { model: getModel() },
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

export async function evolveIdentity({ agentKey, agentId }) {
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

  return {
    agent: updatedAgent || agent,
    snapshots: {
      private: privateSnapshot,
      visitor: visitorSnapshot,
      public: publicSnapshot,
    },
  };
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
