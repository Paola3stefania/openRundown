-- Add resolution status tracking to ungrouped_threads
ALTER TABLE "ungrouped_threads" 
ADD COLUMN IF NOT EXISTS "resolution_status" TEXT,
ADD COLUMN IF NOT EXISTS "resolved_at" TIMESTAMP(3);

CREATE INDEX IF NOT EXISTS "ungrouped_threads_resolution_status_idx" ON "ungrouped_threads"("resolution_status");

-- Add resolution status tracking to groups
ALTER TABLE "groups"
ADD COLUMN IF NOT EXISTS "resolution_status" TEXT,
ADD COLUMN IF NOT EXISTS "resolved_at" TIMESTAMP(3);

CREATE INDEX IF NOT EXISTS "groups_resolution_status_idx" ON "groups"("resolution_status");

-- Add comments
COMMENT ON COLUMN "ungrouped_threads"."resolution_status" IS 'Resolution status: closed_issue (top issue is closed), conversation_resolved (thread resolved via conversation analysis), or null (not resolved/closed)';
COMMENT ON COLUMN "groups"."resolution_status" IS 'Resolution status: closed_issue (GitHub issue is closed), or null (not closed)';

