-- Create export_results table to track export runs
CREATE TABLE IF NOT EXISTS "export_results" (
    "id" TEXT NOT NULL,
    "channel_id" TEXT,
    "pm_tool" TEXT NOT NULL,
    "source_file" TEXT,
    "success" BOOLEAN NOT NULL DEFAULT false,
    "features_extracted" INTEGER DEFAULT 0,
    "features_mapped" INTEGER DEFAULT 0,
    "issues_created" INTEGER DEFAULT 0,
    "issues_updated" INTEGER DEFAULT 0,
    "issues_skipped" INTEGER DEFAULT 0,
    "errors" JSONB DEFAULT '[]',
    "export_mappings" JSONB, -- Stores group_export_mappings, ungrouped_thread_export_mappings, etc.
    "closed_items_count" JSONB, -- Stores closed_items_count data
    "closed_items_file" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "export_results_pkey" PRIMARY KEY ("id")
);

-- Create indexes
CREATE INDEX IF NOT EXISTS "export_results_channel_id_idx" ON "export_results"("channel_id");
CREATE INDEX IF NOT EXISTS "export_results_pm_tool_idx" ON "export_results"("pm_tool");
CREATE INDEX IF NOT EXISTS "export_results_success_idx" ON "export_results"("success");
CREATE INDEX IF NOT EXISTS "export_results_created_at_idx" ON "export_results"("created_at" DESC);

