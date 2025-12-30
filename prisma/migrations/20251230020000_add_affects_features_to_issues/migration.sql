-- Add affects_features column to github_issues table
ALTER TABLE "github_issues" ADD COLUMN IF NOT EXISTS "affects_features" JSONB NOT NULL DEFAULT '[]';
