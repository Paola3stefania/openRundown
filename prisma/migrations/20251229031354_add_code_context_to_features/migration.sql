-- Add code_context column to features table
ALTER TABLE "features" 
ADD COLUMN IF NOT EXISTS "code_context" TEXT;

