-- Add export status tracking to classified_threads
ALTER TABLE "classified_threads" 
ADD COLUMN IF NOT EXISTS "export_status" TEXT,
ADD COLUMN IF NOT EXISTS "exported_at" TIMESTAMP(3),
ADD COLUMN IF NOT EXISTS "linear_issue_id" TEXT,
ADD COLUMN IF NOT EXISTS "linear_issue_url" TEXT,
ADD COLUMN IF NOT EXISTS "linear_issue_identifier" TEXT;

CREATE INDEX IF NOT EXISTS "classified_threads_export_status_idx" ON "classified_threads"("export_status");

-- Add export status tracking to ungrouped_threads
ALTER TABLE "ungrouped_threads"
ADD COLUMN IF NOT EXISTS "export_status" TEXT,
ADD COLUMN IF NOT EXISTS "exported_at" TIMESTAMP(3),
ADD COLUMN IF NOT EXISTS "linear_issue_id" TEXT,
ADD COLUMN IF NOT EXISTS "linear_issue_url" TEXT,
ADD COLUMN IF NOT EXISTS "linear_issue_identifier" TEXT;

CREATE INDEX IF NOT EXISTS "ungrouped_threads_export_status_idx" ON "ungrouped_threads"("export_status");

-- Create table for ungrouped issues (GitHub issues not matched to any thread)
CREATE TABLE IF NOT EXISTS "ungrouped_issues" (
    "issue_number" INTEGER NOT NULL,
    "issue_title" TEXT NOT NULL,
    "issue_url" TEXT NOT NULL,
    "issue_state" TEXT,
    "issue_body" TEXT,
    "issue_labels" TEXT[],
    "issue_author" TEXT,
    "issue_created_at" TIMESTAMP(3),
    "export_status" TEXT,
    "exported_at" TIMESTAMP(3),
    "linear_issue_id" TEXT,
    "linear_issue_url" TEXT,
    "linear_issue_identifier" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ungrouped_issues_pkey" PRIMARY KEY ("issue_number")
);

CREATE INDEX IF NOT EXISTS "ungrouped_issues_export_status_idx" ON "ungrouped_issues"("export_status");
CREATE INDEX IF NOT EXISTS "ungrouped_issues_issue_state_idx" ON "ungrouped_issues"("issue_state");

-- Add comments
COMMENT ON COLUMN "classified_threads"."export_status" IS 'Export status: pending (ready to export), exported (exported to Linear), or null (not exported yet)';
COMMENT ON COLUMN "ungrouped_threads"."export_status" IS 'Export status: pending (ready to export), exported (exported to Linear), or null (not exported yet)';
COMMENT ON COLUMN "ungrouped_issues"."export_status" IS 'Export status: pending (ready to export), exported (exported to Linear), or null (not exported yet)';

