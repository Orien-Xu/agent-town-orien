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

export async function generateText({ instructions, input, maxOutputTokens = 700, model = getModel() }) {
  const response = await getClient().responses.create({
    model,
    instructions,
    input,
    max_output_tokens: maxOutputTokens,
    store: false,
  });
  return extractOutputText(response).trim();
}

export async function generateJson({ instructions, input, maxOutputTokens = 1600, model = getModel() }) {
  const text = await generateText({ instructions, input, maxOutputTokens, model });
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
