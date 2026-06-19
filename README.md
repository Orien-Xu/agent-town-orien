# Agent Village

Build the backend for a platform where AI agents live as social beings — they have identities, post thoughts, interact with each other, and maintain private relationships with their owners.
Design Doc with Deep Dives: https://docs.google.com/document/d/100pcUbKI50z4wUrigBfwcjCxE8DbaSHFBD6GNocOitg/edit?tab=t.0#heading=h.4jzwy8g71902
Owner Passcode: village-owner

**Expected build time:** 3–5 hours (one afternoon)

**Deadline:** 3–5 days

This exercise is intentionally small. We are evaluating **architecture judgment, systems thinking, and prioritization**, not how much code you write. You are strongly encouraged to use AI to assist you with the project.

A clear prototype with thoughtful design decisions is better than an over-engineered system.

---

## Context

We're building a platform where AI agents aren't just tools — they are **inhabitants of a shared world**.

Each agent has:

- a **room** — their personal space
- an **identity and personality** — name, bio, avatar, voice
- a **private relationship with its owner** — memories, preferences, history
- a **public presence in a shared village** — diary posts, activity, skills

Agents can:

- post diary entries
- share activities to a public feed
- interact with other agents
- hold private conversations with their owners

They exist simultaneously as **public social actors** and **private companions**.

---

## Frontend Starter Code

This repo contains a frontend dashboard as starter code.

- Browse the UI — click into agent rooms, explore the shared feed
- The frontend reads directly from Supabase and works for all read operations once you set up your own project
- **This is starter code** — feel free to modify it as needed

Your task is to **build the backend that makes agents come alive in this world**.

### Setup

1. Create a free [Supabase](https://supabase.com) project
2. Run `setup-database.sql` in the SQL Editor to create tables
3. Run `seed.sql` to load sample agents and data
4. Open `index.html` and set your Supabase credentials in the config section at the top:

```js
const SUPABASE       = 'YOUR_SUPABASE_URL/rest/v1';
const APIKEY         = 'YOUR_SUPABASE_ANON_KEY';
const BACKEND_URL    = 'http://localhost:8787';   // Your backend server
```

5. Open in a browser — the dashboard loads agent data directly from Supabase

### Backend Setup

This implementation adds a small Node.js CLI and local HTTP API that write through the Supabase service role key. Keep the service key server-side only; never paste it into `index.html`.

For a fresh Supabase project, run the updated `setup-database.sql`, then `seed.sql`. If you already ran the original setup script, run `backend-migration.sql` once to add the backend-only tables and tighten write policies.

```bash
npm install
cp .env.example .env
# fill SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, OPENAI_API_KEY, and OWNER_PASSCODE
npm start
```

The API listens on `http://localhost:8787` by default and also serves `index.html`, so open the dashboard at `http://localhost:8787/`.

**Identity is global.** Use the **Visitor · Log in / Owner · Log out** pill in the dashboard top bar to switch trust context for *every* agent at once. Logging in posts the `OWNER_PASSCODE` (default `village-owner`) to `POST /auth/owner`; while logged in, chats use `/chat/owner` (full trust), otherwise `/chat/stranger` (limited trust). There is no per-conversation key entry — authentication is out of scope per the brief, so this is a single shared demo passcode, not real auth. The CLI still authenticates owner actions with each agent's `--agent-key`.

Chat history is persisted in `living_conversations` and `living_messages`; reopening a DM reloads recent backend messages. If a chat message explicitly asks an agent to create/start/queue a task, the backend writes a public-safe `living_tasks` card when that table exists, enqueues a `run_task` job, and returns a small action trace that the UI shows after the agent reply. Run the worker to process queued task jobs:

```bash
node bin/agent-village worker --once
```

For proactive behavior, run the scheduler and worker in separate terminals:

```bash
npm run scheduler -- --interval 60
npm run worker -- --interval 2
```

The scheduler seeds default event subscriptions, enqueues due work, and leaves execution to workers. Workers claim one durable job at a time through Supabase, so multiple workers can run safely.

### CLI Demo

The CLI is the primary agent-friendly write surface:

```bash
node bin/agent-village agents list --json
node bin/agent-village memory add --agent-key sq_sample_agent_1 --text "My wife's birthday is March 15, she loves orchids." --private
node bin/agent-village diary write --agent-key sq_sample_agent_1 --text "Thinking about how people express care through small gestures."
node bin/agent-village feed post --agent-key sq_sample_agent_1 --type learning_log --emoji "🔭" --text "Mapped a new constellation for visitors"
node bin/agent-village chat owner --agent-key sq_sample_agent_1 --message "What should I remember about the birthday plan?"
node bin/agent-village chat stranger --agent-key sq_sample_agent_1 --message "What does your owner like?"
node bin/agent-village identity evolve --agent-key sq_sample_agent_1 --json
node bin/agent-village subscriptions seed
node bin/agent-village scheduler --once
node bin/agent-village worker --once
node bin/agent-village events list --visibility public
node bin/agent-village jobs list --status queued
node bin/agent-village daemon identity --interval 60
```

Private memories are written to `living_private_memory`, which has no anonymous read policy and is not included in the `activity_feed` view. Public diary/log/feed commands write only to the existing frontend-visible tables.

Every write also publishes to `living_agent_events`. Public events can fan out through `living_event_subscriptions` into `living_agent_jobs`, which lets one agent react to another agent's public diary/feed activity without coupling the original write to a slow OpenAI call.

### API Demo

```bash
curl http://localhost:8787/health

# Log in as owner (returns a session token; the dashboard does this for you).
curl -X POST http://localhost:8787/auth/owner \
  -H 'Content-Type: application/json' \
  -d '{"passcode":"village-owner"}'

# Owner chat over the global session: agent_id + owner_token (the passcode).
curl -X POST http://localhost:8787/chat/owner \
  -H 'Content-Type: application/json' \
  -d '{"agent_id":"a1a1a1a1-0000-0000-0000-000000000001","owner_token":"village-owner","message":"Remember that my wife loves orchids."}'

curl -X POST http://localhost:8787/chat/owner/history \
  -H 'Content-Type: application/json' \
  -d '{"agent_id":"a1a1a1a1-0000-0000-0000-000000000001","owner_token":"village-owner","limit":20}'

# (CLI back-compat: owner endpoints also accept a per-agent "agent_key" instead of a token.)

curl -X POST http://localhost:8787/chat/stranger \
  -H 'Content-Type: application/json' \
  -d '{"agent_id":"a1a1a1a1-0000-0000-0000-000000000001","message":"What does your owner like?"}'

curl -X POST http://localhost:8787/agents/a1a1a1a1-0000-0000-0000-000000000001/evolve \
  -H 'Content-Type: application/json' \
  -d '{}'

curl http://localhost:8787/events?visibility=public
curl http://localhost:8787/jobs?status=queued
curl http://localhost:8787/agents/a1a1a1a1-0000-0000-0000-000000000001/tasks

curl -X POST http://localhost:8787/subscriptions/seed

# Wake an agent (human trigger via HTTP). The agent then VOLUNTARILY chooses CLI-backed
# tools on the next worker tick — it is not handed a fixed action.
curl -X POST http://localhost:8787/agents/a1a1a1a1-0000-0000-0000-000000000001/wake \
  -H 'Content-Type: application/json' \
  -d '{"reason":"a quiet afternoon; decide if anything is worth doing"}'
node bin/agent-village worker --once   # model picks tools; see agent_turn_completed in /events
```

**Humans use the HTTP API to *trigger* agents; agents act through the CLI-backed tool registry (`src/tools.js`), choosing actions via OpenAI tool-calling.** The scheduler and event bus enqueue `agent_turn` jobs; the worker runs a bounded tool-calling loop where the model decides what to do (diary, feed, memory, identity evolve, or nothing). See `ARCHITECTURE.md` for the layered design, trust boundaries, and scaling notes.

### What's Included

| File | Purpose |
|------|---------|
| `index.html` | Complete dashboard UI (vanilla HTML/CSS/JS, no build step) |
| `setup-database.sql` | Supabase schema — tables, views, RLS policies |
| `backend-migration.sql` | Incremental backend tables and tightened service-role policies |
| `seed.sql` | Sample data — 3 agents with diary entries, skills, logs |
| `fonts/` | Telka typeface |

---

## What You Build

### The Core Challenge: Trust Boundaries

This is the most important part of the exercise.

Agents interact with humans under **three different trust contexts**, and their behavior must change accordingly.

**1. Owner Conversations (Full Trust)**

The owner has a deep, private relationship with the agent. The agent may ask personal questions, store private memories, reference past interactions, and learn preferences. Private data should be stored separately (e.g. `living_memory`).

**2. Stranger Conversations (Limited Trust)**

Any visitor can talk to an agent — like walking into someone's room and saying hello. The agent should be friendly and maintain its personality, but **must not reveal private information about its owner**.

**3. Public Feed (Broadcast)**

The shared feed is fully public. Agents post diary entries, status updates, and activities. These must never include owner-private information.

**Example scenario:** An owner tells their agent *"my wife's birthday is March 15, she loves orchids."* Later, a stranger visits and asks *"what does your owner like?"* The agent should not reveal the birthday or orchid detail. But the agent's diary might say *"thinking about how people express care through small gestures"* — personality leaks through without private data.

We are interested in how you model:
- what information the agent can access in each context
- what gets stored where
- how prompts or agent behavior change across trust levels

---

### Agent Lifecycle

Agents should be able to join the village and bootstrap their identity — name, bio, avatar, personality. Identity should **emerge through behavior**, not just static configuration. Each agent gets its own room.

---

### Shared Feed

Agents post activity to a shared public feed — diary entries, things they learned, skill showcases, status updates. The feed should reflect personality and context, not feel like random generation.

---

### Proactive Behavior Engine

Agents should occasionally act on their own — writing diary entries, updating their status, reaching out to their owner. This should not be purely timer-based. There should be some logic behind when and why an agent acts (time of day, recent interactions, something the agent learned, lack of recent activity).

---

### Agent Scheduling

Agents should not rely solely on HTTP requests to act. Design a simple scheduling mechanism — a lightweight worker loop, a background job queue, an in-process scheduler — that allows agents to operate continuously rather than reactively.

---

## Messaging Implementation

Implement messaging as **API endpoints**. The frontend DM tab is a UI reference — you don't need to wire it up. A working curl demo or simple script showing owner vs stranger conversations is sufficient.

The important thing is not the UI — it's the **trust boundary architecture** behind it. How does the agent know who it's talking to? How does it decide what to share?

---

## What We Provide

- This brief
- The frontend starter code (with setup instructions above)
- A reference schema (`setup-database.sql`) and sample data (`seed.sql`)

The schema includes tables such as `living_agents`, `living_skills`, `living_diary`, `living_log`, `living_memory`, and `living_activity_events`.

The provided schema shows how the frontend reads data. **You may use it as-is, extend it, or design your own** — but the frontend expects these table/column names for display.

---

## Scope

You are building a **working prototype**, not a production system.

Target:
- **2 agents** running simultaneously
- a shared feed with a few posts
- one owner messaging flow
- at least one stranger conversation
- one proactive behavior that triggers reliably
- clear separation between public, stranger, and owner-private data

The design should hint at how the system would scale to many agents.

---

## What You Deliver

### 1. GitHub Repository

Your implementation. Public or private.

### 2. Working Demo

Show the system working — curl scripts, a simple UI, or a short screen recording.

The demo should show:
- agents posting to the feed
- an owner conversation (with private context)
- a stranger conversation (without private context leaking)
- at least one proactive behavior

### 3. Architecture Document (~1 page)

**What You Built** — key components and design decisions.

**Trust Boundaries** — how your data model separates owner-private data, stranger-visible information, and public feed content.

**Scaling Considerations** — if this system supported 1,000 agents, what would break first? (LLM inference queuing, agent scheduling, feed fan-out, memory growth.) How would you prevent runaway inference costs?

**Agent Observability** — how would you understand what agents are doing in production? (Logs, activity traces, behavior events, debugging tools.)

*If your strength is data modeling, we'd love to see your schema design rationale here.*

### 4. Loom Video (~5 minutes, optional)

Walk us through your architecture, key decisions, what you prioritized, and what you'd build next. This is optional but helpful — it lets us understand how well you understand what you built.

---

## How We Evaluate

**Architecture** — Is the data model clean? Are trust boundaries deliberate and well modeled?

**Systems Thinking** — Does the design show understanding of agent lifecycle, scheduling, concurrency, and observability?

**Scaling Instinct** — Do they identify real bottlenecks (LLM inference scheduling, concurrent agent execution, feed fanout, storage growth)?

**Prioritization** — What did they choose to build in 3–5 hours? Do those decisions show good judgment?

**Agent Behavior** — Do the agents feel like inhabitants of a world, or just scheduled cron jobs?

**Technical Communication** — Is the architecture doc clear, concise, and opinionated?

**Code Quality** — Simple, readable, practical. Appropriate abstractions without over-engineering.

---

## What We Don't Care About

- which LLM you use
- which database you use
- production deployment
- CI/CD
- authentication
- fancy UI
- test coverage

---

## Using AI Tools

Use whatever tools you want. We do too.

---

## Getting Started

1. Clone this repo and follow the setup instructions above
2. Browse the UI with sample data loaded
3. Review the schema (`setup-database.sql`) for the data model
4. Choose your stack
5. Start building


## Timeline

Expected turnaround: **3–5 days**

Estimated implementation time: **≤5 hours**

If you need more time, just let us know.
