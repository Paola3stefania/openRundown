-- Add Linear sync status fields to github_issues table
ALTER TABLE "github_issues" ADD COLUMN IF NOT EXISTS "linear_status" TEXT;
ALTER TABLE "github_issues" ADD COLUMN IF NOT EXISTS "linear_status_synced_at" TIMESTAMP(3);
ALTER TABLE "github_issues" ADD COLUMN IF NOT EXISTS "closed_by_pr" TEXT;
ALTER TABLE "github_issues" ADD COLUMN IF NOT EXISTS "closed_by_pr_merged_at" TIMESTAMP(3);

-- Create indexes for Linear sync fields
CREATE INDEX IF NOT EXISTS "github_issues_linear_status_idx" ON "github_issues"("linear_status");
CREATE INDEX IF NOT EXISTS "github_issues_linear_issue_id_idx" ON "github_issues"("linear_issue_id");

