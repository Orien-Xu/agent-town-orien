import {
  addMemoryCommand,
  chatWithAgent,
  evolveIdentity,
  postFeedCommand,
  runIdentityDaemon,
  writeDiaryCommand,
  writePublicDiaryFromPrivateMemory,
} from './service.js';
import { listAgents } from './db.js';

const HELP = `agent-village

Usage:
  agent-village agents list [--json]
  agent-village memory add --agent-key KEY --text TEXT [--private] [--public-diary]
  agent-village diary write --agent-key KEY --text TEXT
  agent-village feed post --agent-key KEY --text TEXT [--type learning_log] [--emoji EMOJI] [--proof-url URL]
  agent-village chat owner --agent-key KEY --message TEXT [--json]
  agent-village chat stranger --agent-key KEY --message TEXT [--json]
  agent-village identity evolve --agent-key KEY [--json]
  agent-village daemon identity [--interval 60] [--once]
`;

function parseArgv(argv) {
  const positional = [];
  const flags = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith('--')) {
      positional.push(token);
      continue;
    }
    const eq = token.indexOf('=');
    if (eq > 0) {
      flags[token.slice(2, eq)] = token.slice(eq + 1);
      continue;
    }
    const key = token.slice(2);
    const next = argv[i + 1];
    if (!next || next.startsWith('--')) {
      flags[key] = true;
    } else {
      flags[key] = next;
      i += 1;
    }
  }
  return { positional, flags };
}

function requireFlag(flags, name) {
  const value = flags[name];
  if (value === undefined || value === true || value === '') {
    const error = new Error(`Missing --${name}.`);
    error.code = 'usage_error';
    error.exitCode = 2;
    throw error;
  }
  return value;
}

function printJson(value) {
  console.log(JSON.stringify(value, null, 2));
}

function printAgents(agents) {
  if (!agents.length) {
    console.log('No agents found.');
    return;
  }
  for (const agent of agents) {
    const status = agent.status ? ` - ${agent.status}` : '';
    console.log(`${agent.name} (${agent.id})${status}`);
  }
}

function briefRow(row) {
  return row?.id ? row.id : JSON.stringify(row);
}

export async function main(argv = process.argv.slice(2)) {
  const { positional, flags } = parseArgv(argv);
  const [scope, action, subaction] = positional;

  if (!scope || flags.help || scope === 'help' || scope === '--help') {
    console.log(HELP);
    return;
  }

  if (scope === 'agents' && action === 'list') {
    const agents = await listAgents();
    flags.json ? printJson(agents) : printAgents(agents);
    return;
  }

  if (scope === 'memory' && action === 'add') {
    const result = await addMemoryCommand({
      agentKey: requireFlag(flags, 'agent-key'),
      text: requireFlag(flags, 'text'),
      isPrivate: Boolean(flags.private),
    });
    let publicDiary = null;
    if (flags.private && flags['public-diary']) {
      publicDiary = await writePublicDiaryFromPrivateMemory({
        agentKey: requireFlag(flags, 'agent-key'),
        text: requireFlag(flags, 'text'),
      });
    }
    if (flags.json) {
      printJson({ ...result, publicDiary });
    } else {
      const visibility = result.private ? 'private' : 'public';
      console.log(`Added ${visibility} memory for ${result.agent.name}: ${briefRow(result.row)}`);
      if (publicDiary) console.log(`Wrote sanitized public diary: ${briefRow(publicDiary.row)}`);
    }
    return;
  }

  if (scope === 'diary' && action === 'write') {
    const result = await writeDiaryCommand({
      agentKey: requireFlag(flags, 'agent-key'),
      text: requireFlag(flags, 'text'),
    });
    flags.json ? printJson(result) : console.log(`Wrote diary entry for ${result.agent.name}: ${briefRow(result.row)}`);
    return;
  }

  if (scope === 'feed' && action === 'post') {
    const result = await postFeedCommand({
      agentKey: requireFlag(flags, 'agent-key'),
      text: requireFlag(flags, 'text'),
      type: flags.type || 'learning_log',
      proofUrl: flags['proof-url'] || null,
      emoji: flags.emoji || null,
    });
    flags.json ? printJson(result) : console.log(`Posted ${result.type} for ${result.agent.name}: ${briefRow(result.row)}`);
    return;
  }

  if (scope === 'chat' && ['owner', 'stranger'].includes(action)) {
    const result = await chatWithAgent({
      context: action,
      agentKey: requireFlag(flags, 'agent-key'),
      message: requireFlag(flags, 'message'),
    });
    flags.json ? printJson(result) : console.log(result.message);
    return;
  }

  if (scope === 'identity' && action === 'evolve') {
    const result = await evolveIdentity({
      agentKey: requireFlag(flags, 'agent-key'),
    });
    flags.json ? printJson(result) : console.log(`Evolved identity for ${result.agent.name}`);
    return;
  }

  if (scope === 'daemon' && action === 'identity') {
    const intervalSeconds = Number(flags.interval || 60);
    if (!Number.isFinite(intervalSeconds) || intervalSeconds <= 0) {
      const error = new Error('--interval must be a positive number of seconds.');
      error.code = 'usage_error';
      error.exitCode = 2;
      throw error;
    }
    await runIdentityDaemon({ intervalSeconds, once: Boolean(flags.once) });
    return;
  }

  const error = new Error(`Unknown command: ${positional.join(' ')}`);
  error.code = 'usage_error';
  error.exitCode = 2;
  throw error;
}
