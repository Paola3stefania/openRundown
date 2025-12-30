-- CreateTable
CREATE TABLE IF NOT EXISTS "channels" (
    "id" TEXT NOT NULL,
    "name" TEXT,
    "guild_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "channels_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "classified_threads" (
    "thread_id" TEXT NOT NULL,
    "channel_id" TEXT NOT NULL,
    "thread_name" TEXT,
    "message_count" INTEGER NOT NULL DEFAULT 1,
    "first_message_id" TEXT,
    "first_message_author" TEXT,
    "first_message_timestamp" TIMESTAMP(3),
    "first_message_url" TEXT,
    "classified_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "status" TEXT NOT NULL DEFAULT 'completed' CHECK (status IN ('pending', 'classifying', 'completed', 'failed')),

    CONSTRAINT "classified_threads_pkey" PRIMARY KEY ("thread_id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "thread_issue_matches" (
    "id" SERIAL NOT NULL,
    "thread_id" TEXT NOT NULL,
    "issue_number" INTEGER NOT NULL,
    "issue_title" TEXT NOT NULL,
    "issue_url" TEXT NOT NULL,
    "issue_state" TEXT,
    "similarity_score" DECIMAL(5,2) NOT NULL,
    "matched_terms" TEXT[],
    "issue_labels" TEXT[],
    "issue_author" TEXT,
    "issue_created_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "thread_issue_matches_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "groups" (
    "id" TEXT NOT NULL,
    "channel_id" TEXT NOT NULL,
    "github_issue_number" INTEGER,
    "suggested_title" TEXT NOT NULL,
    "avg_similarity" DECIMAL(5,2),
    "thread_count" INTEGER NOT NULL DEFAULT 0,
    "is_cross_cutting" BOOLEAN NOT NULL DEFAULT false,
    "status" TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'exported')),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "exported_at" TIMESTAMP(3),
    "linear_issue_id" TEXT,
    "linear_issue_url" TEXT,
    "linear_project_ids" TEXT[],
    "affects_features" JSONB NOT NULL DEFAULT '[]'::jsonb,
    "linear_issue_identifier" TEXT,

    CONSTRAINT "groups_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "group_threads" (
    "id" SERIAL NOT NULL,
    "group_id" TEXT NOT NULL,
    "thread_id" TEXT NOT NULL,
    "similarity_score" DECIMAL(5,2),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "group_threads_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "ungrouped_threads" (
    "thread_id" TEXT NOT NULL,
    "channel_id" TEXT NOT NULL,
    "reason" TEXT NOT NULL CHECK (reason IN ('no_matches', 'below_threshold')),
    "top_issue_number" INTEGER,
    "top_issue_title" TEXT,
    "top_issue_similarity" DECIMAL(5,2),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ungrouped_threads_pkey" PRIMARY KEY ("thread_id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "classification_history" (
    "id" SERIAL NOT NULL,
    "channel_id" TEXT NOT NULL,
    "message_id" TEXT,
    "thread_id" TEXT,
    "classified_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "classification_history_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "issue_embeddings" (
    "issue_number" INTEGER NOT NULL,
    "embedding" JSONB NOT NULL,
    "content_hash" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "issue_embeddings_pkey" PRIMARY KEY ("issue_number")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "documentation_cache" (
    "url" TEXT NOT NULL,
    "title" TEXT,
    "content" TEXT NOT NULL,
    "fetched_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "documentation_cache_pkey" PRIMARY KEY ("url")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "features" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "category" TEXT,
    "priority" TEXT,
    "related_keywords" TEXT[],
    "documentation_section" TEXT,
    "documentation_urls" TEXT[],
    "extracted_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "features_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "documentation_sections" (
    "id" SERIAL NOT NULL,
    "documentation_url" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "section_url" TEXT,
    "section_order" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "documentation_sections_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "documentation_section_embeddings" (
    "section_id" INTEGER NOT NULL,
    "documentation_url" TEXT NOT NULL,
    "embedding" JSONB NOT NULL,
    "content_hash" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "documentation_section_embeddings_pkey" PRIMARY KEY ("section_id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "documentation_embeddings" (
    "documentation_url" TEXT NOT NULL,
    "embedding" JSONB NOT NULL,
    "content_hash" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "documentation_embeddings_pkey" PRIMARY KEY ("documentation_url")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "feature_embeddings" (
    "feature_id" TEXT NOT NULL,
    "embedding" JSONB NOT NULL,
    "content_hash" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "feature_embeddings_pkey" PRIMARY KEY ("feature_id")
);

-- CreateIndex
CREATE INDEX IF NOT EXISTS "channels_guild_id_idx" ON "channels"("guild_id");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "classified_threads_channel_id_idx" ON "classified_threads"("channel_id");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "classified_threads_status_idx" ON "classified_threads"("status");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "thread_issue_matches_thread_id_idx" ON "thread_issue_matches"("thread_id");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "thread_issue_matches_issue_number_idx" ON "thread_issue_matches"("issue_number");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "thread_issue_matches_similarity_score_idx" ON "thread_issue_matches"("similarity_score" DESC);

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "thread_issue_matches_thread_id_issue_number_key" ON "thread_issue_matches"("thread_id", "issue_number");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "groups_channel_id_idx" ON "groups"("channel_id");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "groups_status_idx" ON "groups"("status");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "groups_github_issue_number_idx" ON "groups"("github_issue_number");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "groups_affects_features_idx" ON "groups" USING GIN ("affects_features");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "group_threads_group_id_idx" ON "group_threads"("group_id");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "group_threads_thread_id_idx" ON "group_threads"("thread_id");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "group_threads_group_id_thread_id_key" ON "group_threads"("group_id", "thread_id");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "ungrouped_threads_channel_id_idx" ON "ungrouped_threads"("channel_id");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "ungrouped_threads_reason_idx" ON "ungrouped_threads"("reason");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "classification_history_channel_id_message_id_key" ON "classification_history"("channel_id", "message_id");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "issue_embeddings_content_hash_idx" ON "issue_embeddings"("content_hash");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "issue_embeddings_model_idx" ON "issue_embeddings"("model");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "documentation_cache_fetched_at_idx" ON "documentation_cache"("fetched_at" DESC);

-- CreateIndex
CREATE INDEX IF NOT EXISTS "features_name_idx" ON "features"("name");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "features_category_idx" ON "features"("category");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "features_priority_idx" ON "features"("priority");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "features_related_keywords_idx" ON "features" USING GIN ("related_keywords");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "features_documentation_urls_idx" ON "features" USING GIN ("documentation_urls");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "features_extracted_at_idx" ON "features"("extracted_at" DESC);

-- CreateIndex
CREATE INDEX IF NOT EXISTS "documentation_sections_documentation_url_idx" ON "documentation_sections"("documentation_url");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "documentation_sections_documentation_url_section_order_idx" ON "documentation_sections"("documentation_url", "section_order");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "documentation_section_embeddings_documentation_url_idx" ON "documentation_section_embeddings"("documentation_url");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "documentation_section_embeddings_content_hash_idx" ON "documentation_section_embeddings"("content_hash");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "documentation_section_embeddings_model_idx" ON "documentation_section_embeddings"("model");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "documentation_embeddings_content_hash_idx" ON "documentation_embeddings"("content_hash");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "documentation_embeddings_model_idx" ON "documentation_embeddings"("model");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "feature_embeddings_content_hash_idx" ON "feature_embeddings"("content_hash");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "feature_embeddings_model_idx" ON "feature_embeddings"("model");

-- CreateFunction
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ language 'plpgsql';

-- CreateTrigger
CREATE TRIGGER update_channels_updated_at BEFORE UPDATE ON "channels"
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_classified_threads_updated_at BEFORE UPDATE ON "classified_threads"
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_groups_updated_at BEFORE UPDATE ON "groups"
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_ungrouped_threads_updated_at BEFORE UPDATE ON "ungrouped_threads"
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_issue_embeddings_updated_at BEFORE UPDATE ON "issue_embeddings"
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_documentation_cache_updated_at BEFORE UPDATE ON "documentation_cache"
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_features_updated_at BEFORE UPDATE ON "features"
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_doc_section_embeddings_updated_at BEFORE UPDATE ON "documentation_section_embeddings"
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_doc_embeddings_updated_at BEFORE UPDATE ON "documentation_embeddings"
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_feature_embeddings_updated_at BEFORE UPDATE ON "feature_embeddings"
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- AddForeignKey
ALTER TABLE "classified_threads" ADD CONSTRAINT "classified_threads_channel_id_fkey" FOREIGN KEY ("channel_id") REFERENCES "channels"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "thread_issue_matches" ADD CONSTRAINT "thread_issue_matches_thread_id_fkey" FOREIGN KEY ("thread_id") REFERENCES "classified_threads"("thread_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "groups" ADD CONSTRAINT "groups_channel_id_fkey" FOREIGN KEY ("channel_id") REFERENCES "channels"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "group_threads" ADD CONSTRAINT "group_threads_group_id_fkey" FOREIGN KEY ("group_id") REFERENCES "groups"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "group_threads" ADD CONSTRAINT "group_threads_thread_id_fkey" FOREIGN KEY ("thread_id") REFERENCES "classified_threads"("thread_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ungrouped_threads" ADD CONSTRAINT "ungrouped_threads_thread_id_fkey" FOREIGN KEY ("thread_id") REFERENCES "classified_threads"("thread_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ungrouped_threads" ADD CONSTRAINT "ungrouped_threads_channel_id_fkey" FOREIGN KEY ("channel_id") REFERENCES "channels"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "classification_history" ADD CONSTRAINT "classification_history_channel_id_fkey" FOREIGN KEY ("channel_id") REFERENCES "channels"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "classification_history" ADD CONSTRAINT "classification_history_thread_id_fkey" FOREIGN KEY ("thread_id") REFERENCES "classified_threads"("thread_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "documentation_sections" ADD CONSTRAINT "documentation_sections_documentation_url_fkey" FOREIGN KEY ("documentation_url") REFERENCES "documentation_cache"("url") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "documentation_section_embeddings" ADD CONSTRAINT "documentation_section_embeddings_section_id_fkey" FOREIGN KEY ("section_id") REFERENCES "documentation_sections"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "documentation_embeddings" ADD CONSTRAINT "documentation_embeddings_documentation_url_fkey" FOREIGN KEY ("documentation_url") REFERENCES "documentation_cache"("url") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "feature_embeddings" ADD CONSTRAINT "feature_embeddings_feature_id_fkey" FOREIGN KEY ("feature_id") REFERENCES "features"("id") ON DELETE CASCADE ON UPDATE CASCADE;

