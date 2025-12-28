-- CreateTable
CREATE TABLE IF NOT EXISTS "github_issues" (
    "issue_number" INTEGER NOT NULL,
    "issue_title" TEXT NOT NULL,
    "issue_url" TEXT NOT NULL,
    "issue_state" TEXT,
    "issue_body" TEXT,
    "issue_labels" TEXT[],
    "issue_author" TEXT,
    "issue_created_at" TIMESTAMP(3),
    "issue_updated_at" TIMESTAMP(3),
    "in_group" BOOLEAN NOT NULL DEFAULT false,
    "group_id" TEXT,
    "matched_to_threads" BOOLEAN NOT NULL DEFAULT false,
    "export_status" TEXT,
    "exported_at" TIMESTAMP(3),
    "linear_issue_id" TEXT,
    "linear_issue_url" TEXT,
    "linear_issue_identifier" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "github_issues_pkey" PRIMARY KEY ("issue_number")
);

-- CreateIndex
CREATE INDEX IF NOT EXISTS "github_issues_in_group_idx" ON "github_issues"("in_group");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "github_issues_matched_to_threads_idx" ON "github_issues"("matched_to_threads");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "github_issues_export_status_idx" ON "github_issues"("export_status");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "github_issues_issue_state_idx" ON "github_issues"("issue_state");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "github_issues_group_id_idx" ON "github_issues"("group_id");

-- AddForeignKey (only if constraint doesn't exist)
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint 
        WHERE conname = 'github_issues_group_id_fkey'
    ) THEN
        ALTER TABLE "github_issues" ADD CONSTRAINT "github_issues_group_id_fkey" FOREIGN KEY ("group_id") REFERENCES "groups"("id") ON DELETE SET NULL ON UPDATE CASCADE;
    END IF;
END $$;

-- CreateTrigger (only if trigger doesn't exist)
DROP TRIGGER IF EXISTS update_github_issues_updated_at ON "github_issues";
CREATE TRIGGER update_github_issues_updated_at BEFORE UPDATE ON "github_issues"
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- Add comments
COMMENT ON COLUMN "github_issues"."export_status" IS 'Export status: pending (ready to export), exported (exported to Linear), or null (not exported yet)';
COMMENT ON COLUMN "github_issues"."in_group" IS 'Whether this issue is part of a group';
COMMENT ON COLUMN "github_issues"."matched_to_threads" IS 'Whether this issue has been matched to any Discord threads';

