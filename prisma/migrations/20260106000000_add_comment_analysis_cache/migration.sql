-- Add comment analysis cache fields to github_issues table
-- These fields cache LLM analysis results to avoid repeated API calls

ALTER TABLE "github_issues" 
ADD COLUMN IF NOT EXISTS "waiting_for_closure_confirmation" BOOLEAN,
ADD COLUMN IF NOT EXISTS "closure_confirmation_reason" TEXT,
ADD COLUMN IF NOT EXISTS "comments_analyzed_at" TIMESTAMP,
ADD COLUMN IF NOT EXISTS "comment_count_at_analysis" INTEGER;

-- Add index for faster lookups when checking if analysis is needed
CREATE INDEX IF NOT EXISTS "github_issues_comments_analyzed_at_idx" 
ON "github_issues" ("comments_analyzed_at") 
WHERE "comments_analyzed_at" IS NOT NULL;

