-- Multi-repo support: change GitHubIssue and GitHubPullRequest PKs from integer to
-- string "{repo}#{number}" so issues from different repos can coexist.

-- ===========================================================================
-- 1. GitHubIssue: add id (TEXT) + issue_repo, populate, swap PK
-- ===========================================================================

ALTER TABLE "github_issues" ADD COLUMN "id" TEXT;
ALTER TABLE "github_issues" ADD COLUMN "issue_repo" TEXT NOT NULL DEFAULT 'better-auth/better-auth';

UPDATE "github_issues" SET "id" = 'better-auth/better-auth#' || "issue_number"::text;

ALTER TABLE "github_issues" ALTER COLUMN "id" SET NOT NULL;

-- ===========================================================================
-- 2. GitHubPullRequest: add id (TEXT) + pr_repo, populate, swap PK
-- ===========================================================================

ALTER TABLE "github_pull_requests" ADD COLUMN "id" TEXT;
ALTER TABLE "github_pull_requests" ADD COLUMN "pr_repo" TEXT NOT NULL DEFAULT 'better-auth/better-auth';

UPDATE "github_pull_requests" SET "id" = 'better-auth/better-auth#' || "pr_number"::text;

ALTER TABLE "github_pull_requests" ALTER COLUMN "id" SET NOT NULL;

-- ===========================================================================
-- 3. Update IssueThreadMatch: add issue_id FK, drop old FK
-- ===========================================================================

ALTER TABLE "issue_thread_matches" ADD COLUMN "issue_id" TEXT;

UPDATE "issue_thread_matches" itm SET "issue_id" = gi."id"
FROM "github_issues" gi WHERE itm."issue_number" = gi."issue_number";

ALTER TABLE "issue_thread_matches" ALTER COLUMN "issue_id" SET NOT NULL;

-- Drop old FK and unique constraint
ALTER TABLE "issue_thread_matches" DROP CONSTRAINT IF EXISTS "issue_thread_matches_issue_number_fkey";
ALTER TABLE "issue_thread_matches" DROP CONSTRAINT IF EXISTS "issue_thread_matches_issue_number_thread_id_key";

-- New unique constraint with issue_id
ALTER TABLE "issue_thread_matches" ADD CONSTRAINT "issue_thread_matches_issue_id_thread_id_key" UNIQUE ("issue_id", "thread_id");

-- ===========================================================================
-- 4. Update IssueEmbedding: change PK from issue_number to issue_id
-- ===========================================================================

ALTER TABLE "issue_embeddings" ADD COLUMN "issue_id" TEXT;

UPDATE "issue_embeddings" ie SET "issue_id" = gi."id"
FROM "github_issues" gi WHERE ie."issue_number" = gi."issue_number";

ALTER TABLE "issue_embeddings" ALTER COLUMN "issue_id" SET NOT NULL;

-- Drop old PK and FK
ALTER TABLE "issue_embeddings" DROP CONSTRAINT IF EXISTS "issue_embeddings_issue_number_fkey";
ALTER TABLE "issue_embeddings" DROP CONSTRAINT IF EXISTS "issue_embeddings_pkey";

-- New PK
ALTER TABLE "issue_embeddings" ADD CONSTRAINT "issue_embeddings_pkey" PRIMARY KEY ("issue_id");

-- Drop old issue_number column from embeddings (now issue_id is the PK)
ALTER TABLE "issue_embeddings" DROP COLUMN "issue_number";

-- ===========================================================================
-- 5. Update implicit M2M join table: change A (issue PK) and B (PR PK) from INT to TEXT
-- ===========================================================================

-- Drop existing constraints on join table
ALTER TABLE "_GitHubIssueToGitHubPullRequest" DROP CONSTRAINT IF EXISTS "_GitHubIssueToGitHubPullRequest_A_fkey";
ALTER TABLE "_GitHubIssueToGitHubPullRequest" DROP CONSTRAINT IF EXISTS "_GitHubIssueToGitHubPullRequest_B_fkey";
DROP INDEX IF EXISTS "_GitHubIssueToGitHubPullRequest_AB_unique";
DROP INDEX IF EXISTS "_GitHubIssueToGitHubPullRequest_B_index";

-- Add new TEXT columns
ALTER TABLE "_GitHubIssueToGitHubPullRequest" ADD COLUMN "A_new" TEXT;
ALTER TABLE "_GitHubIssueToGitHubPullRequest" ADD COLUMN "B_new" TEXT;

-- Populate from existing data
UPDATE "_GitHubIssueToGitHubPullRequest" j SET
  "A_new" = gi."id",
  "B_new" = gpr."id"
FROM "github_issues" gi, "github_pull_requests" gpr
WHERE j."A" = gi."issue_number" AND j."B" = gpr."pr_number";

-- Drop old columns, rename new
ALTER TABLE "_GitHubIssueToGitHubPullRequest" DROP COLUMN "A";
ALTER TABLE "_GitHubIssueToGitHubPullRequest" DROP COLUMN "B";
ALTER TABLE "_GitHubIssueToGitHubPullRequest" RENAME COLUMN "A_new" TO "A";
ALTER TABLE "_GitHubIssueToGitHubPullRequest" RENAME COLUMN "B_new" TO "B";

ALTER TABLE "_GitHubIssueToGitHubPullRequest" ALTER COLUMN "A" SET NOT NULL;
ALTER TABLE "_GitHubIssueToGitHubPullRequest" ALTER COLUMN "B" SET NOT NULL;

-- ===========================================================================
-- 6. Now swap PKs on the main tables
-- ===========================================================================

-- GitHubIssue: drop old PK, set new PK
ALTER TABLE "github_issues" DROP CONSTRAINT "github_issues_pkey";
ALTER TABLE "github_issues" ADD CONSTRAINT "github_issues_pkey" PRIMARY KEY ("id");
ALTER TABLE "github_issues" ADD CONSTRAINT "github_issues_issue_repo_issue_number_key" UNIQUE ("issue_repo", "issue_number");

-- GitHubPullRequest: drop old PK, set new PK
ALTER TABLE "github_pull_requests" DROP CONSTRAINT "github_pull_requests_pkey";
ALTER TABLE "github_pull_requests" ADD CONSTRAINT "github_pull_requests_pkey" PRIMARY KEY ("id");
ALTER TABLE "github_pull_requests" ADD CONSTRAINT "github_pull_requests_pr_repo_pr_number_key" UNIQUE ("pr_repo", "pr_number");

-- ===========================================================================
-- 7. Re-create foreign keys
-- ===========================================================================

ALTER TABLE "issue_thread_matches" ADD CONSTRAINT "issue_thread_matches_issue_id_fkey"
  FOREIGN KEY ("issue_id") REFERENCES "github_issues"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "issue_embeddings" ADD CONSTRAINT "issue_embeddings_issue_id_fkey"
  FOREIGN KEY ("issue_id") REFERENCES "github_issues"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Re-create join table constraints
CREATE UNIQUE INDEX "_GitHubIssueToGitHubPullRequest_AB_unique" ON "_GitHubIssueToGitHubPullRequest"("A", "B");
CREATE INDEX "_GitHubIssueToGitHubPullRequest_B_index" ON "_GitHubIssueToGitHubPullRequest"("B");

ALTER TABLE "_GitHubIssueToGitHubPullRequest" ADD CONSTRAINT "_GitHubIssueToGitHubPullRequest_A_fkey"
  FOREIGN KEY ("A") REFERENCES "github_issues"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "_GitHubIssueToGitHubPullRequest" ADD CONSTRAINT "_GitHubIssueToGitHubPullRequest_B_fkey"
  FOREIGN KEY ("B") REFERENCES "github_pull_requests"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ===========================================================================
-- 8. Add indexes on the new repo columns
-- ===========================================================================

CREATE INDEX "github_issues_issue_repo_idx" ON "github_issues"("issue_repo");
CREATE INDEX "github_pull_requests_pr_repo_idx" ON "github_pull_requests"("pr_repo");
CREATE INDEX "issue_thread_matches_issue_id_idx" ON "issue_thread_matches"("issue_id");
