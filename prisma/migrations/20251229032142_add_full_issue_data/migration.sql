-- Add full conversation data fields to github_issues table
ALTER TABLE "github_issues" 
ADD COLUMN IF NOT EXISTS "issue_comments" JSONB NOT NULL DEFAULT '[]'::jsonb,
ADD COLUMN IF NOT EXISTS "issue_assignees" TEXT[] NOT NULL DEFAULT '{}',
ADD COLUMN IF NOT EXISTS "issue_milestone" TEXT,
ADD COLUMN IF NOT EXISTS "issue_reactions" JSONB;

-- Add GIN index for efficient JSON queries on issue_comments
CREATE INDEX IF NOT EXISTS "github_issues_issue_comments_idx" 
ON "github_issues" USING GIN ("issue_comments");

-- Add GIN index for efficient array queries on issue_assignees
CREATE INDEX IF NOT EXISTS "github_issues_issue_assignees_idx" 
ON "github_issues" USING GIN ("issue_assignees");

