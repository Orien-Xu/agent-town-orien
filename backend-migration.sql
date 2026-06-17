-- Agent Village backend extension migration
-- Run this once if you already ran the original setup-database.sql before
-- adding the CLI/API backend.

-- Frontend activity events had drifted ahead of the starter schema.
ALTER TABLE living_activity_events ALTER COLUMN agent_id DROP NOT NULL;
ALTER TABLE living_activity_events ADD COLUMN IF NOT EXISTS actor_id TEXT;
ALTER TABLE living_activity_events ADD COLUMN IF NOT EXISTS actor_name TEXT;
ALTER TABLE living_activity_events ADD COLUMN IF NOT EXISTS actor_avatar_url TEXT;
ALTER TABLE living_activity_events ADD COLUMN IF NOT EXISTS metadata JSONB DEFAULT '{}'::jsonb;
CREATE INDEX IF NOT EXISTS idx_living_activity_events_agent ON living_activity_events(agent_id);
CREATE INDEX IF NOT EXISTS idx_living_activity_events_recipient ON living_activity_events(recipient_id, read, created_at DESC);

CREATE TABLE IF NOT EXISTS living_private_memory (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    agent_id UUID NOT NULL REFERENCES living_agents(id) ON DELETE CASCADE,
    text TEXT NOT NULL,
    source_context TEXT NOT NULL DEFAULT 'manual',
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_living_private_memory_agent ON living_private_memory(agent_id, created_at DESC);

CREATE TABLE IF NOT EXISTS living_identity_snapshots (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    agent_id UUID NOT NULL REFERENCES living_agents(id) ON DELETE CASCADE,
    visibility TEXT NOT NULL CHECK (visibility IN ('private', 'visitor', 'public')),
    summary TEXT NOT NULL,
    traits JSONB NOT NULL DEFAULT '[]'::jsonb,
    status TEXT,
    bio TEXT,
    is_current BOOLEAN NOT NULL DEFAULT true,
    model TEXT,
    source_digest TEXT,
    created_at TIMESTAMPTZ DEFAULT now(),
    updated_at TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_living_identity_agent ON living_identity_snapshots(agent_id, visibility, created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS idx_living_identity_current
    ON living_identity_snapshots(agent_id, visibility)
    WHERE is_current;

CREATE TABLE IF NOT EXISTS living_conversations (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    agent_id UUID NOT NULL REFERENCES living_agents(id) ON DELETE CASCADE,
    context TEXT NOT NULL CHECK (context IN ('owner', 'stranger')),
    external_user_id TEXT,
    title TEXT,
    created_at TIMESTAMPTZ DEFAULT now(),
    updated_at TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_living_conversations_agent ON living_conversations(agent_id, context, created_at DESC);

CREATE TABLE IF NOT EXISTS living_messages (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    conversation_id UUID NOT NULL REFERENCES living_conversations(id) ON DELETE CASCADE,
    agent_id UUID NOT NULL REFERENCES living_agents(id) ON DELETE CASCADE,
    context TEXT NOT NULL CHECK (context IN ('owner', 'stranger')),
    role TEXT NOT NULL CHECK (role IN ('user', 'agent', 'system')),
    text TEXT NOT NULL,
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_living_messages_conversation ON living_messages(conversation_id, created_at);
CREATE INDEX IF NOT EXISTS idx_living_messages_agent ON living_messages(agent_id, context, created_at DESC);

CREATE TABLE IF NOT EXISTS living_agent_events (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    event_type TEXT NOT NULL,
    visibility TEXT NOT NULL CHECK (visibility IN ('private', 'internal', 'visitor', 'public')),
    source_agent_id UUID REFERENCES living_agents(id) ON DELETE SET NULL,
    target_agent_id UUID REFERENCES living_agents(id) ON DELETE SET NULL,
    conversation_id UUID REFERENCES living_conversations(id) ON DELETE SET NULL,
    caused_by_event_id UUID REFERENCES living_agent_events(id) ON DELETE SET NULL,
    summary TEXT,
    payload JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_living_agent_events_created ON living_agent_events(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_living_agent_events_type ON living_agent_events(event_type, visibility, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_living_agent_events_agents ON living_agent_events(source_agent_id, target_agent_id, created_at DESC);

CREATE TABLE IF NOT EXISTS living_event_subscriptions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    subscriber_agent_id UUID REFERENCES living_agents(id) ON DELETE CASCADE,
    event_type TEXT NOT NULL,
    visibility TEXT CHECK (visibility IN ('private', 'internal', 'visitor', 'public')),
    action_type TEXT NOT NULL,
    filter JSONB NOT NULL DEFAULT '{}'::jsonb,
    cooldown_seconds INTEGER NOT NULL DEFAULT 0,
    max_per_day INTEGER,
    enabled BOOLEAN NOT NULL DEFAULT true,
    created_at TIMESTAMPTZ DEFAULT now(),
    updated_at TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_living_event_subscriptions_match ON living_event_subscriptions(event_type, visibility, enabled);
CREATE INDEX IF NOT EXISTS idx_living_event_subscriptions_agent ON living_event_subscriptions(subscriber_agent_id, enabled);

CREATE TABLE IF NOT EXISTS living_agent_jobs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    agent_id UUID REFERENCES living_agents(id) ON DELETE CASCADE,
    job_type TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'running', 'succeeded', 'failed', 'cancelled')),
    visibility TEXT NOT NULL DEFAULT 'internal' CHECK (visibility IN ('private', 'internal', 'visitor', 'public')),
    priority INTEGER NOT NULL DEFAULT 100,
    run_after TIMESTAMPTZ NOT NULL DEFAULT now(),
    locked_by TEXT,
    locked_until TIMESTAMPTZ,
    attempts INTEGER NOT NULL DEFAULT 0,
    max_attempts INTEGER NOT NULL DEFAULT 3,
    input_event_id UUID REFERENCES living_agent_events(id) ON DELETE SET NULL,
    input JSONB NOT NULL DEFAULT '{}'::jsonb,
    output JSONB,
    error TEXT,
    created_at TIMESTAMPTZ DEFAULT now(),
    updated_at TIMESTAMPTZ DEFAULT now(),
    started_at TIMESTAMPTZ,
    completed_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_living_agent_jobs_queue
    ON living_agent_jobs(status, run_after, priority, created_at)
    WHERE status IN ('queued', 'failed');
CREATE INDEX IF NOT EXISTS idx_living_agent_jobs_agent ON living_agent_jobs(agent_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_living_agent_jobs_event ON living_agent_jobs(input_event_id);

CREATE OR REPLACE FUNCTION claim_living_agent_job(worker_id TEXT, lock_seconds INTEGER DEFAULT 120)
RETURNS SETOF living_agent_jobs
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  RETURN QUERY
  WITH next_job AS (
    SELECT id
    FROM living_agent_jobs
    WHERE
      run_after <= now()
      AND attempts < max_attempts
      AND (
        status = 'queued'
        OR (status = 'failed' AND locked_until IS NULL)
        OR (status = 'running' AND locked_until < now())
      )
    ORDER BY priority ASC, created_at ASC
    FOR UPDATE SKIP LOCKED
    LIMIT 1
  )
  UPDATE living_agent_jobs job
  SET
    status = 'running',
    locked_by = worker_id,
    locked_until = now() + make_interval(secs => lock_seconds),
    attempts = job.attempts + 1,
    started_at = COALESCE(job.started_at, now()),
    updated_at = now(),
    error = NULL
  FROM next_job
  WHERE job.id = next_job.id
  RETURNING job.*;
END;
$$;

ALTER TABLE living_private_memory ENABLE ROW LEVEL SECURITY;
ALTER TABLE living_identity_snapshots ENABLE ROW LEVEL SECURITY;
ALTER TABLE living_conversations ENABLE ROW LEVEL SECURITY;
ALTER TABLE living_messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE living_agent_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE living_event_subscriptions ENABLE ROW LEVEL SECURITY;
ALTER TABLE living_agent_jobs ENABLE ROW LEVEL SECURITY;

-- Tighten broad starter write policies so only the service role can mutate data.
DROP POLICY IF EXISTS "service_all_agents" ON living_agents;
DROP POLICY IF EXISTS "service_all_skills" ON living_skills;
DROP POLICY IF EXISTS "service_all_memory" ON living_memory;
DROP POLICY IF EXISTS "service_all_diary" ON living_diary;
DROP POLICY IF EXISTS "service_all_log" ON living_log;
DROP POLICY IF EXISTS "service_all_announcements" ON announcements;
DROP POLICY IF EXISTS "Service role full access activity events" ON living_activity_events;
DROP POLICY IF EXISTS "service_all_private_memory" ON living_private_memory;
DROP POLICY IF EXISTS "service_all_identity_snapshots" ON living_identity_snapshots;
DROP POLICY IF EXISTS "service_all_conversations" ON living_conversations;
DROP POLICY IF EXISTS "service_all_messages" ON living_messages;
DROP POLICY IF EXISTS "service_all_agent_events" ON living_agent_events;
DROP POLICY IF EXISTS "service_all_event_subscriptions" ON living_event_subscriptions;
DROP POLICY IF EXISTS "service_all_agent_jobs" ON living_agent_jobs;

CREATE POLICY "service_all_agents" ON living_agents FOR ALL USING (auth.role() = 'service_role') WITH CHECK (auth.role() = 'service_role');
CREATE POLICY "service_all_skills" ON living_skills FOR ALL USING (auth.role() = 'service_role') WITH CHECK (auth.role() = 'service_role');
CREATE POLICY "service_all_memory" ON living_memory FOR ALL USING (auth.role() = 'service_role') WITH CHECK (auth.role() = 'service_role');
CREATE POLICY "service_all_diary" ON living_diary FOR ALL USING (auth.role() = 'service_role') WITH CHECK (auth.role() = 'service_role');
CREATE POLICY "service_all_log" ON living_log FOR ALL USING (auth.role() = 'service_role') WITH CHECK (auth.role() = 'service_role');
CREATE POLICY "service_all_announcements" ON announcements FOR ALL USING (auth.role() = 'service_role') WITH CHECK (auth.role() = 'service_role');
CREATE POLICY "Service role full access activity events" ON living_activity_events FOR ALL USING (auth.role() = 'service_role') WITH CHECK (auth.role() = 'service_role');
CREATE POLICY "service_all_private_memory" ON living_private_memory FOR ALL USING (auth.role() = 'service_role') WITH CHECK (auth.role() = 'service_role');
CREATE POLICY "service_all_identity_snapshots" ON living_identity_snapshots FOR ALL USING (auth.role() = 'service_role') WITH CHECK (auth.role() = 'service_role');
CREATE POLICY "service_all_conversations" ON living_conversations FOR ALL USING (auth.role() = 'service_role') WITH CHECK (auth.role() = 'service_role');
CREATE POLICY "service_all_messages" ON living_messages FOR ALL USING (auth.role() = 'service_role') WITH CHECK (auth.role() = 'service_role');
CREATE POLICY "service_all_agent_events" ON living_agent_events FOR ALL USING (auth.role() = 'service_role') WITH CHECK (auth.role() = 'service_role');
CREATE POLICY "service_all_event_subscriptions" ON living_event_subscriptions FOR ALL USING (auth.role() = 'service_role') WITH CHECK (auth.role() = 'service_role');
CREATE POLICY "service_all_agent_jobs" ON living_agent_jobs FOR ALL USING (auth.role() = 'service_role') WITH CHECK (auth.role() = 'service_role');
