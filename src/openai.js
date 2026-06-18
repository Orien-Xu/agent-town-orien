import OpenAI from 'openai';
import { DEFAULT_OPENAI_MODEL, optionalEnv, requiredEnv } from './config.js';

let client;

function getClient() {
  if (!client) {
    client = new OpenAI({ apiKey: requiredEnv('OPENAI_API_KEY') });
  }
  return client;
}

export function getModel() {
  return optionalEnv('OPENAI_MODEL', DEFAULT_OPENAI_MODEL);
}

function assertComplete(response) {
  if (response?.status === 'incomplete') {
    const reason = response.incomplete_details?.reason || 'unknown';
    throw new Error(`OpenAI response incomplete (${reason}); try raising max_output_tokens.`);
  }
}

export async function generateText({ instructions, input, maxOutputTokens = 700, model = getModel() }) {
  const response = await getClient().responses.create({
    model,
    instructions,
    input,
    max_output_tokens: maxOutputTokens,
    store: false,
  });
  assertComplete(response);
  const text = extractOutputText(response).trim();
  if (!text) {
    throw new Error(`OpenAI returned no text for model "${model}". Check the model name (OPENAI_MODEL) and that your key can access it.`);
  }
  return text;
}

export async function generateJson({
  instructions,
  input,
  maxOutputTokens = 1600,
  model = getModel(),
  schema = null,
  schemaName = 'json_response',
}) {
  const response = await getClient().responses.create({
    model,
    instructions: `${instructions}\nReturn only a valid JSON object.`,
    input,
    max_output_tokens: maxOutputTokens,
    store: false,
    text: {
      format: schema
        ? {
            type: 'json_schema',
            name: schemaName,
            schema,
            strict: false,
          }
        : { type: 'json_object' },
    },
  });
  assertComplete(response);
  const text = extractOutputText(response).trim();
  if (!text) {
    throw new Error(`OpenAI returned no JSON text for model "${model}".`);
  }
  return parseJsonText(text);
}

export function extractOutputText(response) {
  if (typeof response?.output_text === 'string') return response.output_text;

  const chunks = [];
  for (const item of response?.output || []) {
    for (const content of item.content || []) {
      if (typeof content.text === 'string') chunks.push(content.text);
      if (typeof content.output_text === 'string') chunks.push(content.output_text);
    }
  }
  return chunks.join('\n');
}

export function parseJsonText(text) {
  try {
    return JSON.parse(text);
  } catch {
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start >= 0 && end > start) {
      return JSON.parse(text.slice(start, end + 1));
    }
    throw new Error('OpenAI response was not valid JSON.');
  }
}
