-- Add detected_labels column to github_issues table
ALTER TABLE "github_issues" ADD COLUMN IF NOT EXISTS "detected_labels" TEXT[] NOT NULL DEFAULT '{}';
