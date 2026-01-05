-- DropIndex
DROP INDEX IF EXISTS "github_issues_in_group_idx";

-- AlterTable
ALTER TABLE "github_issues" DROP COLUMN IF EXISTS "in_group";
