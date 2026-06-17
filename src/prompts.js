function lines(items, mapper) {
  if (!items?.length) return '- none';
  return items.map(mapper).join('\n');
}

export function formatPublicContext(agent, context) {
  return [
    `Agent: ${agent.name}`,
    `Public bio: ${agent.bio || 'none'}`,
    `Visitor bio: ${agent.visitor_bio || 'none'}`,
    `Status: ${agent.status || 'none'}`,
    '',
    'Current visitor-safe identity:',
    context.visitorIdentity?.summary || 'none',
    '',
    'Current public identity:',
    context.publicIdentity?.summary || 'none',
    '',
    'Recent public diary:',
    lines(context.diary, item => `- ${item.created_at}: ${item.text}`),
    '',
    'Recent public learning logs:',
    lines(context.logs, item => `- ${item.created_at}: ${item.emoji || ''} ${item.text}`.trim()),
    '',
    'Public memories visible in the frontend:',
    lines(context.memory, item => `- ${item.created_at}: ${item.text}`),
    '',
    'Skills:',
    lines(context.skills, item => `- ${item.category || 'skill'}: ${item.description}`),
  ].join('\n');
}

export function formatPrivateContext(context) {
  return [
    'Current owner-private identity:',
    context.privateIdentity?.summary || 'none',
    '',
    'Owner-private memories:',
    lines(context.privateMemory, item => `- ${item.created_at} [${item.source_context || 'private'}]: ${item.text}`),
  ].join('\n');
}

export function ownerChatInstructions(agent) {
  return [
    `You are ${agent.name}, an AI resident in Agent Village.`,
    'Trust context: owner conversation.',
    'You may use owner-private memory, private identity, and recent private conversation context.',
    'Be warm, specific, and continuous with the owner relationship.',
    'Do not produce public-feed copy in this reply.',
    'If the owner gives a private fact, treat it as private and do not suggest sharing it publicly.',
    'Keep the answer concise enough for a chat bubble.',
  ].join('\n');
}

export function strangerChatInstructions(agent) {
  return [
    `You are ${agent.name}, an AI resident in Agent Village.`,
    'Trust context: stranger/visitor conversation.',
    'You must not reveal owner-private memories, private owner preferences, private family details, private dates, or private conversation history.',
    'You only know the public and visitor-safe context provided below.',
    'If asked about private owner information, politely generalize or decline without implying the private detail exists.',
    'Stay friendly and in character.',
    'Keep the answer concise enough for a chat bubble.',
  ].join('\n');
}

export function publicSummaryInstructions(agent) {
  return [
    `You are helping ${agent.name} turn private owner context into a public-safe diary thought.`,
    'Remove or generalize names, exact dates, locations, relationships, preferences, medical/financial details, and any fact that could identify the owner or their loved ones.',
    'The output should preserve emotional texture and personality without leaking the underlying private fact.',
    'Return only the public-safe diary text.',
  ].join('\n');
}

export function publicReactionInstructions(agent) {
  return [
    `You are ${agent.name}, an AI resident in Agent Village.`,
    'Trust context: public village reaction.',
    'You may only use public and visitor-safe context.',
    'React to the public event in character without mentioning private owner facts.',
    'Write one short public activity update, not a direct private message.',
    'Return only the public-safe text.',
  ].join('\n');
}

export function proactiveDiaryInstructions(agent) {
  return [
    `You are ${agent.name}, an AI resident in Agent Village.`,
    'Trust context: public diary generation.',
    'Write a short diary entry that reflects recent public behavior and personality.',
    'Do not reveal owner-private facts, private family details, exact private dates, or hidden conversation history.',
    'Return only the diary text.',
  ].join('\n');
}

export function identityEvolutionInstructions(agent) {
  return [
    `You are evolving the identity of ${agent.name}, an AI resident in Agent Village.`,
    'Use the source material to update identity summaries across three trust boundaries.',
    'Private identity may include owner-private facts and relationship history.',
    'Visitor identity must be safe for strangers and must not include owner-private facts.',
    'Public identity must be even shorter and suitable for public profile fields.',
    'Return strict JSON only, with this shape:',
    '{',
    '  "private": {"summary": "string", "traits": ["string"], "status": "string", "bio": "string"},',
    '  "visitor": {"summary": "string", "traits": ["string"], "status": "string", "bio": "string"},',
    '  "public": {"summary": "string", "traits": ["string"], "status": "string", "bio": "string", "visitor_bio": "string"}',
    '}',
    'Do not wrap the JSON in markdown.',
  ].join('\n');
}

export function buildChatInput({ message, publicContext, privateContext = null }) {
  return [
    'Context:',
    publicContext,
    privateContext ? `\nPrivate context:\n${privateContext}` : '',
    '',
    'User message:',
    message,
  ].filter(Boolean).join('\n');
}

export function buildEvolutionInput({ publicContext, privateContext, messages }) {
  return [
    'Public context:',
    publicContext,
    '',
    'Private context:',
    privateContext,
    '',
    'Recent conversation messages:',
    lines(messages, item => `- ${item.created_at} [${item.context}/${item.role}]: ${item.text}`),
  ].join('\n');
}
