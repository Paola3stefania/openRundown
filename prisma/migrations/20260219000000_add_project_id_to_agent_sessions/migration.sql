-- Add project_id column to agent_sessions for multi-project scoping
ALTER TABLE "agent_sessions" ADD COLUMN "project_id" TEXT NOT NULL DEFAULT 'default';

-- Index for efficient per-project session lookups
CREATE INDEX "agent_sessions_project_id_started_at_idx" ON "agent_sessions"("project_id", "started_at" DESC);
