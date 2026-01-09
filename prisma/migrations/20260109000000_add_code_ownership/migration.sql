-- CreateTable: Code ownership (file-level)
CREATE TABLE "code_ownership" (
    "id" TEXT NOT NULL,
    "file_path" TEXT NOT NULL,
    "engineer" TEXT NOT NULL,
    "lines_added" INTEGER NOT NULL DEFAULT 0,
    "lines_deleted" INTEGER NOT NULL DEFAULT 0,
    "commits_count" INTEGER NOT NULL DEFAULT 0,
    "ownership_percent" DECIMAL(5,2) NOT NULL,
    "last_commit_sha" TEXT,
    "last_commit_date" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "code_ownership_pkey" PRIMARY KEY ("id")
);

-- CreateIndex: Unique constraint on file_path and engineer
CREATE UNIQUE INDEX "code_ownership_file_path_engineer_key" ON "code_ownership"("file_path", "engineer");

-- CreateIndex: Index on file_path
CREATE INDEX "code_ownership_file_path_idx" ON "code_ownership"("file_path");

-- CreateIndex: Index on engineer
CREATE INDEX "code_ownership_engineer_idx" ON "code_ownership"("engineer");

-- CreateIndex: Index on ownership_percent (descending)
CREATE INDEX "code_ownership_ownership_percent_idx" ON "code_ownership"("ownership_percent" DESC);

-- CreateTable: Feature ownership (feature-level, aggregated from file ownership)
CREATE TABLE "feature_ownership" (
    "id" TEXT NOT NULL,
    "feature_id" TEXT NOT NULL,
    "engineer" TEXT NOT NULL,
    "ownership_percent" DECIMAL(5,2) NOT NULL,
    "files_count" INTEGER NOT NULL DEFAULT 0,
    "total_lines" INTEGER NOT NULL DEFAULT 0,
    "last_updated" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "feature_ownership_pkey" PRIMARY KEY ("id")
);

-- CreateIndex: Unique constraint on feature_id and engineer
CREATE UNIQUE INDEX "feature_ownership_feature_id_engineer_key" ON "feature_ownership"("feature_id", "engineer");

-- CreateIndex: Index on feature_id
CREATE INDEX "feature_ownership_feature_id_idx" ON "feature_ownership"("feature_id");

-- CreateIndex: Index on engineer
CREATE INDEX "feature_ownership_engineer_idx" ON "feature_ownership"("engineer");

-- CreateIndex: Index on ownership_percent (descending)
CREATE INDEX "feature_ownership_ownership_percent_idx" ON "feature_ownership"("ownership_percent" DESC);

-- AddForeignKey: Link feature_ownership to features table
ALTER TABLE "feature_ownership" ADD CONSTRAINT "feature_ownership_feature_id_fkey" FOREIGN KEY ("feature_id") REFERENCES "features"("id") ON DELETE CASCADE ON UPDATE CASCADE;
