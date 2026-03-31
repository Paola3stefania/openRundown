-- CreateTable
CREATE TABLE "x_posts" (
    "id" TEXT NOT NULL,
    "author_id" TEXT NOT NULL,
    "author_username" TEXT NOT NULL,
    "author_name" TEXT,
    "author_followers" INTEGER NOT NULL DEFAULT 0,
    "content" TEXT NOT NULL,
    "hashtags" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "urls" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "like_count" INTEGER NOT NULL DEFAULT 0,
    "retweet_count" INTEGER NOT NULL DEFAULT 0,
    "reply_count" INTEGER NOT NULL DEFAULT 0,
    "quote_count" INTEGER NOT NULL DEFAULT 0,
    "lang" TEXT,
    "conversation_id" TEXT,
    "in_reply_to_user_id" TEXT,
    "query" TEXT,
    "posted_at" TIMESTAMP(3) NOT NULL,
    "fetched_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "x_posts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "x_watch_configs" (
    "id" TEXT NOT NULL,
    "project_id" TEXT NOT NULL DEFAULT 'default',
    "type" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "x_watch_configs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "x_posts_posted_at_idx" ON "x_posts"("posted_at" DESC);
CREATE INDEX "x_posts_author_username_idx" ON "x_posts"("author_username");
CREATE INDEX "x_posts_hashtags_idx" ON "x_posts" USING GIN ("hashtags");
CREATE INDEX "x_posts_query_idx" ON "x_posts"("query");

-- CreateIndex
CREATE UNIQUE INDEX "x_watch_configs_project_id_type_value_key" ON "x_watch_configs"("project_id", "type", "value");
CREATE INDEX "x_watch_configs_project_id_idx" ON "x_watch_configs"("project_id");
