import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

let envLoaded = false;

export class ConfigError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ConfigError';
    this.code = 'config_error';
    this.exitCode = 2;
  }
}

function stripQuotes(value) {
  const trimmed = value.trim();
  if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function parseEnvFile(filePath) {
  const content = fs.readFileSync(filePath, 'utf8');
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!match) continue;
    const [, key, rawValue] = match;
    if (process.env[key] === undefined) {
      process.env[key] = stripQuotes(rawValue);
    }
  }
}

export function loadEnv() {
  if (envLoaded) return;
  envLoaded = true;

  const moduleDir = path.dirname(fileURLToPath(import.meta.url));
  const repoRoot = path.resolve(moduleDir, '..');
  const explicit = process.env.AGENT_VILLAGE_ENV;
  const candidates = explicit
    ? [explicit]
    : [path.resolve(process.cwd(), '.env'), path.resolve(repoRoot, '.env')];

  const seen = new Set();
  for (const candidate of candidates) {
    if (seen.has(candidate)) continue;
    seen.add(candidate);
    if (fs.existsSync(candidate)) parseEnvFile(candidate);
  }
}

export function requiredEnv(name) {
  loadEnv();
  const value = process.env[name];
  if (!value) throw new ConfigError(`Missing ${name}. Copy .env.example to .env or export it before running this command.`);
  return value;
}

export function optionalEnv(name, fallback) {
  loadEnv();
  return process.env[name] || fallback;
}

export function getPort() {
  const port = Number(optionalEnv('PORT', '8787'));
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new ConfigError('PORT must be a valid TCP port number.');
  }
  return port;
}

export const DEFAULT_OPENAI_MODEL = 'gpt-5.4-mini';
