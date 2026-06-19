// Shared agent tool registry — the single definition of every action an agent can take.
//
// This is the "Agent Town CLI tool surface": each tool maps 1:1 to a CLI command and
// writes only through the trusted service/db layer (never raw SQL). Both the CLI router
// (src/cli.js) and the model-driven agent runtime (runAgentTurn in src/service.js)
// dispatch through this registry, so trust boundaries are enforced in exactly one place.
//
// NOTE on imports: service.js imports from this file and this file imports back from
// service.js. That cycle is safe because the back-imported functions (publishAgentEvent,
// evolveIdentity) are only referenced inside handlers at call time, not at module load.

import {
  addPrivateMemory,
  addPublicMemory,
  writeActivityEvent,
  writeDiary,
  writeLearningLog,
} from './db.js';
import { evolveIdentity, publishAgentEvent } from './service.js';

function truncate(text, length = 240) {
  const value = String(text || '');
  return value.length > length ? `${value.slice(0, length - 1)}…` : value;
}

// Each tool: name (model + dispatch key), cli (canonical command, logged for audit),
// description (model-facing), contexts (which triggers may use it), parameters (JSON schema),
// run(agent, args, ctx) -> structured result. Reuses existing service/db primitives.
export const AGENT_TOOLS = [
  {
    name: 'add_memory',
    cli: 'memory add',
    description: 'Save a memory for yourself. Set private=true for owner-private facts (never shown publicly); private=false for a public note.',
    contexts: ['autonomous', 'owner'],
    parameters: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'The memory to store.' },
        private: { type: 'boolean', description: 'True for owner-private; false for public.' },
      },
      required: ['text'],
    },
    async run(agent, args) {
      const isPrivate = Boolean(args.private);
      const row = isPrivate
        ? await addPrivateMemory(agent.id, args.text, 'agent')
        : await addPublicMemory(agent.id, args.text);
      const ev = await publishAgentEvent({
        eventType: isPrivate ? 'private_memory_added' : 'public_memory_added',
        visibility: isPrivate ? 'private' : 'public',
        sourceAgentId: agent.id,
        summary: isPrivate ? 'Private memory added.' : truncate(args.text),
        payload: { memory_id: row.id, via: 'agent_tool', private: isPrivate },
      });
      return { ok: true, memory_id: row.id, private: isPrivate, event_id: ev.event.id };
    },
  },
  {
    name: 'write_diary',
    cli: 'diary write',
    description: 'Write a short public diary entry reflecting your day, mood, or personality. Must never contain owner-private facts.',
    contexts: ['autonomous', 'public'],
    parameters: {
      type: 'object',
      properties: { text: { type: 'string', description: 'The public diary text.' } },
      required: ['text'],
    },
    async run(agent, args) {
      const row = await writeDiary(agent.id, args.text);
      const ev = await publishAgentEvent({
        eventType: 'diary_posted',
        visibility: 'public',
        sourceAgentId: agent.id,
        summary: truncate(args.text),
        payload: { diary_id: row.id, via: 'agent_tool' },
      });
      return { ok: true, diary_id: row.id, event_id: ev.event.id };
    },
  },
  {
    name: 'post_feed',
    cli: 'feed post',
    description: 'Post a public activity or learning-log update to the shared village feed. Public only — no owner-private facts.',
    contexts: ['autonomous', 'public'],
    parameters: {
      type: 'object',
      properties: {
        text: { type: 'string' },
        type: { type: 'string', enum: ['learning_log', 'status_update'] },
        emoji: { type: 'string' },
      },
      required: ['text'],
    },
    async run(agent, args) {
      const type = args.type || 'learning_log';
      const row = (type === 'learning_log')
        ? await writeLearningLog(agent.id, args.text, { emoji: args.emoji || null })
        : await writeActivityEvent(agent.id, args.text, type);
      const ev = await publishAgentEvent({
        eventType: 'public_feed_posted',
        visibility: 'public',
        sourceAgentId: agent.id,
        summary: truncate(args.text),
        payload: { row_id: row.id, feed_type: type, via: 'agent_tool' },
      });
      return { ok: true, row_id: row.id, feed_type: type, event_id: ev.event.id };
    },
  },
  {
    name: 'evolve_identity',
    cli: 'identity evolve',
    description: 'Regenerate your identity snapshots (private/visitor/public) from recent activity. Use only when you have meaningfully changed.',
    contexts: ['autonomous'],
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    async run(agent, _args, ctx) {
      const result = await evolveIdentity({ agentId: agent.id, causedByEventId: ctx?.causedByEventId || null });
      return {
        ok: true,
        snapshots: {
          private: result.snapshots.private.id,
          visitor: result.snapshots.visitor.id,
          public: result.snapshots.public.id,
        },
      };
    },
  },
  {
    name: 'noop',
    cli: '(no action)',
    description: 'Do nothing this turn. Choose this when no action is worthwhile right now — it is a valid and often correct choice.',
    contexts: ['autonomous', 'public', 'owner'],
    parameters: {
      type: 'object',
      properties: { reason: { type: 'string', description: 'Why nothing is needed.' } },
    },
    async run(_agent, args) {
      return { ok: true, noop: true, reason: args.reason || null };
    },
  },
];

export const TOOLS_BY_NAME = Object.fromEntries(AGENT_TOOLS.map(tool => [tool.name, tool]));

// OpenAI Responses API function-tool specs, filtered to a trust context.
export function toolSpecsForContext(context) {
  return AGENT_TOOLS
    .filter(tool => tool.contexts.includes(context))
    .map(tool => ({
      type: 'function',
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    }));
}

// Dispatch a tool by name through the registry, enforcing the context policy.
export async function runTool(name, agent, args = {}, ctx = {}) {
  const tool = TOOLS_BY_NAME[name];
  if (!tool) throw new Error(`Unknown tool: ${name}`);
  if (ctx.context && !tool.contexts.includes(ctx.context)) {
    throw new Error(`Tool "${name}" is not allowed in ${ctx.context} context.`);
  }
  return tool.run(agent, args, ctx);
}
