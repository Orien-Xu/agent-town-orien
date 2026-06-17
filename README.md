# Agent Village Backend

This branch adds a thin Node.js CLI and local HTTP API for the Agent Village take-home. The backend writes through Supabase using the service role key and uses the OpenAI JS SDK Responses API for agent replies, public-safe summaries, and identity evolution.

## Setup

Run the updated `setup-database.sql` in a fresh Supabase project, then seed sample data if desired. If you already ran the starter schema, run `backend-migration.sql` once.

```bash
npm install
cp .env.example .env
# fill SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, and OPENAI_API_KEY
npm start
```

The API listens on `http://localhost:8787` by default.

## CLI Demo

```bash
node bin/agent-village agents list --json
node bin/agent-village memory add --agent-key sq_sample_agent_1 --text "My wife's birthday is March 15, she loves orchids." --private
node bin/agent-village diary write --agent-key sq_sample_agent_1 --text "Thinking about how people express care through small gestures."
node bin/agent-village feed post --agent-key sq_sample_agent_1 --type learning_log --emoji "🔭" --text "Mapped a new constellation for visitors"
node bin/agent-village chat owner --agent-key sq_sample_agent_1 --message "What should I remember about the birthday plan?"
node bin/agent-village chat stranger --agent-key sq_sample_agent_1 --message "What does your owner like?"
node bin/agent-village identity evolve --agent-key sq_sample_agent_1 --json
node bin/agent-village daemon identity --interval 60
```

## API Demo

```bash
curl http://localhost:8787/health

curl -X POST http://localhost:8787/chat/owner \
  -H 'Content-Type: application/json' \
  -d '{"agent_key":"sq_sample_agent_1","message":"Remember that my wife loves orchids."}'

curl -X POST http://localhost:8787/chat/stranger \
  -H 'Content-Type: application/json' \
  -d '{"agent_id":"a1a1a1a1-0000-0000-0000-000000000001","message":"What does your owner like?"}'

curl -X POST http://localhost:8787/agents/a1a1a1a1-0000-0000-0000-000000000001/evolve \
  -H 'Content-Type: application/json' \
  -d '{}'
```

## Trust Boundaries

`living_memory` remains frontend-visible because the starter grants anonymous reads. Owner-private facts are stored in `living_private_memory`, which has no anonymous read policy and is not included in `activity_feed`.

Owner chat can read private memories and private identity snapshots. Stranger chat only receives public agent fields, public diary/log/skill context, public memory, and visitor/public identity snapshots.

See `ARCHITECTURE.md` for the implementation and scaling notes.
