-- CreateTable: GitHub Pull Requests
CREATE TABLE "github_pull_requests" (
    "pr_number" INTEGER NOT NULL,
    "pr_title" TEXT NOT NULL,
    "pr_url" TEXT NOT NULL,
    "pr_state" TEXT NOT NULL,
    "pr_merged" BOOLEAN NOT NULL DEFAULT false,
    "pr_author" TEXT NOT NULL,
    "pr_created_at" TIMESTAMP(3) NOT NULL,
    "pr_updated_at" TIMESTAMP(3) NOT NULL,
    "pr_body" TEXT,
    "pr_head_ref" TEXT,
    "pr_base_ref" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "github_pull_requests_pkey" PRIMARY KEY ("pr_number")
);

-- CreateIndex: Unique constraint on pr_url
CREATE UNIQUE INDEX "github_pull_requests_pr_url_key" ON "github_pull_requests"("pr_url");

-- CreateIndex: Index on pr_state
CREATE INDEX "github_pull_requests_pr_state_idx" ON "github_pull_requests"("pr_state");

-- CreateIndex: Index on pr_merged
CREATE INDEX "github_pull_requests_pr_merged_idx" ON "github_pull_requests"("pr_merged");

-- CreateIndex: Index on pr_author
CREATE INDEX "github_pull_requests_pr_author_idx" ON "github_pull_requests"("pr_author");

-- CreateTable: Join table for many-to-many relationship between GitHubIssue and GitHubPullRequest
-- Prisma creates implicit join tables with this naming pattern: _Model1ToModel2 (alphabetical order)
CREATE TABLE "_GitHubIssueToGitHubPullRequest" (
    "A" INTEGER NOT NULL,
    "B" INTEGER NOT NULL
);

-- CreateIndex: Index on join table foreign keys
CREATE UNIQUE INDEX "_GitHubIssueToGitHubPullRequest_AB_unique" ON "_GitHubIssueToGitHubPullRequest"("A", "B");
CREATE INDEX "_GitHubIssueToGitHubPullRequest_B_index" ON "_GitHubIssueToGitHubPullRequest"("B");

-- AddForeignKey: Link join table to GitHubIssue
ALTER TABLE "_GitHubIssueToGitHubPullRequest" ADD CONSTRAINT "_GitHubIssueToGitHubPullRequest_A_fkey" FOREIGN KEY ("A") REFERENCES "github_issues"("issue_number") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey: Link join table to GitHubPullRequest
ALTER TABLE "_GitHubIssueToGitHubPullRequest" ADD CONSTRAINT "_GitHubIssueToGitHubPullRequest_B_fkey" FOREIGN KEY ("B") REFERENCES "github_pull_requests"("pr_number") ON DELETE CASCADE ON UPDATE CASCADE;

-- Remove the openPRs JSON column if it exists (from previous schema)
ALTER TABLE "github_issues" DROP COLUMN IF EXISTS "open_prs";







