-- Add match_status column to classified_threads table
-- This field tracks whether a thread matched issues: 'matched', 'below_threshold', 'no_matches', or null (not classified yet)

ALTER TABLE "classified_threads" 
ADD COLUMN IF NOT EXISTS "match_status" TEXT;

-- Create index for efficient querying
CREATE INDEX IF NOT EXISTS "classified_threads_match_status_idx" ON "classified_threads"("match_status");

-- Update existing threads based on their current state:
-- Threads with issue matches -> 'matched'
-- Threads in ungrouped_threads -> set based on reason
UPDATE "classified_threads" ct
SET "match_status" = 'matched'
WHERE EXISTS (
  SELECT 1 FROM "thread_issue_matches" tim 
  WHERE tim."thread_id" = ct."thread_id"
);

-- Update threads in ungrouped_threads table
UPDATE "classified_threads" ct
SET "match_status" = ut."reason"
FROM "ungrouped_threads" ut
WHERE ut."thread_id" = ct."thread_id"
  AND ct."match_status" IS NULL;

-- Add comment to explain the field
COMMENT ON COLUMN "classified_threads"."match_status" IS 'Classification match status: matched (has matches above threshold), below_threshold (has matches but below threshold), no_matches (no matches found), or null (not classified yet)';

