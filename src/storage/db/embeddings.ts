/**
 * Embedding storage operations for documentation, sections, and features
 * Using Prisma for type-safe database access
 */

import { prisma } from "./prisma.js";
import { createHash } from "crypto";
import type { DocumentationContent } from "../../export/documentationFetcher.js";
import type { ProductFeature } from "../../export/types.js";
import { createEmbedding, createEmbeddings } from "../../core/classify/semantic.js";
import { getConfig } from "../../config/index.js";
import type { Prisma } from "@prisma/client";

export type Embedding = number[];

/**
 * Get the embedding model from config
 */
function getEmbeddingModel(): string {
  const config = getConfig();
  return config.classification.embeddingModel;
}

/**
 * Create hash of content for change detection
 */
function hashContent(content: string): string {
  return createHash("md5").update(content).digest("hex");
}

/**
 * Save documentation section embedding
 */
export async function saveDocumentationSectionEmbedding(
  sectionId: number,
  documentationUrl: string,
  embedding: Embedding,
  contentHash: string
): Promise<void> {
  const model = getEmbeddingModel();
  await prisma.documentationSectionEmbedding.upsert({
    where: { sectionId },
    update: {
      documentationUrl,
      embedding: embedding as Prisma.InputJsonValue,
      contentHash,
      model,
    },
    create: {
      sectionId,
      documentationUrl,
      embedding: embedding as any,
      contentHash,
      model,
    },
  });
}

/**
 * Get documentation section embedding
 */
export async function getDocumentationSectionEmbedding(sectionId: number): Promise<Embedding | null> {
  const model = getEmbeddingModel();
  const result = await prisma.documentationSectionEmbedding.findUnique({
    where: {
      sectionId,
    },
    select: { embedding: true, model: true },
  });

  if (!result || result.model !== model) {
    return null;
  }

  return result.embedding as Embedding;
}

/**
 * Save full documentation embedding
 */
export async function saveDocumentationEmbedding(
  url: string,
  embedding: Embedding,
  contentHash: string
): Promise<void> {
  const model = getEmbeddingModel();
  await prisma.documentationEmbedding.upsert({
    where: { documentationUrl: url },
    update: {
      embedding: embedding as any,
      contentHash,
      model,
    },
    create: {
      documentationUrl: url,
      embedding: embedding as any,
      contentHash,
      model,
    },
  });
}

/**
 * Get documentation embedding
 */
export async function getDocumentationEmbedding(url: string): Promise<Embedding | null> {
  const model = getEmbeddingModel();
  const result = await prisma.documentationEmbedding.findUnique({
    where: { documentationUrl: url },
    select: { embedding: true, model: true },
  });

  if (!result || result.model !== model) {
    return null;
  }

  return result.embedding as Embedding;
}

/**
 * Save feature embedding
 */
export async function saveFeatureEmbedding(
  featureId: string,
  embedding: Embedding,
  contentHash: string
): Promise<void> {
  const model = getEmbeddingModel();
  await prisma.featureEmbedding.upsert({
    where: { featureId },
    update: {
      embedding: embedding as any,
      contentHash,
      model,
    },
    create: {
      featureId,
      embedding: embedding as any,
      contentHash,
      model,
    },
  });
}

/**
 * Get feature embedding
 */
export async function getFeatureEmbedding(featureId: string): Promise<Embedding | null> {
  const model = getEmbeddingModel();
  const result = await prisma.featureEmbedding.findUnique({
    where: { featureId },
    select: { embedding: true, model: true },
  });

  if (!result || result.model !== model) {
    return null;
  }

  return result.embedding as Embedding;
}

/**
 * Compute and save embeddings for all documentation sections
 */
export async function computeAndSaveDocumentationSectionEmbeddings(
  apiKey: string,
  onProgress?: (processed: number, total: number) => void
): Promise<void> {
  // Get all sections that need embeddings
  const allSections = await prisma.documentationSection.findMany({
    orderBy: { id: "asc" },
    select: {
      id: true,
      documentationUrl: true,
      title: true,
      content: true,
    },
  });

  const model = getEmbeddingModel();

  // Check which sections already have embeddings
  const existingEmbeddings = await prisma.documentationSectionEmbedding.findMany({
    where: { model },
    select: {
      sectionId: true,
      contentHash: true,
    },
  });

  const existingHashes = new Map<number, string>();
  for (const row of existingEmbeddings) {
    existingHashes.set(row.sectionId, row.contentHash);
  }

  // Compute content hashes and find sections that need embeddings
  const sectionsToEmbed: Array<{ id: number; url: string; title: string; content: string }> = [];
  for (const section of allSections) {
    const contentText = `${section.title}\n\n${section.content}`;
    const currentHash = hashContent(contentText);
    const existingHash = existingHashes.get(section.id);

    if (!existingHash || existingHash !== currentHash) {
      sectionsToEmbed.push({
        id: section.id,
        url: section.documentationUrl,
        title: section.title,
        content: section.content,
      });
    }
  }

  console.error(`[Embeddings] Found ${allSections.length} sections, ${sectionsToEmbed.length} need embeddings`);

  // Process in batches using batch embedding API
  const batchSize = 25;
  let processed = 0;
  let retryCount = 0;

  for (let i = 0; i < sectionsToEmbed.length; i += batchSize) {
    const batch = sectionsToEmbed.slice(i, i + batchSize);

    try {
      // Prepare texts for batch embedding
      const textsToEmbed = batch.map((section) => `${section.title}\n\n${section.content}`);

      // Batch create embeddings
      const embeddings = await createEmbeddings(textsToEmbed, apiKey);

      // Batch save all embeddings in a single transaction
      const model = getEmbeddingModel();
      await prisma.$transaction(async (tx: Omit<typeof prisma, "$connect" | "$disconnect" | "$on" | "$transaction" | "$use" | "$extends">) => {
        await Promise.all(
          embeddings.map((embedding, j) => {
            const section = batch[j];
            const contentText = textsToEmbed[j];
            const contentHash = hashContent(contentText);
            return tx.documentationSectionEmbedding.upsert({
              where: { sectionId: section.id },
              update: {
                documentationUrl: section.url,
                embedding: embedding as any,
                contentHash,
                model,
              },
              create: {
                sectionId: section.id,
                documentationUrl: section.url,
                embedding: embedding as any,
                contentHash,
                model,
              },
            });
          })
        );
      });

      processed += batch.length;
      retryCount = 0; // Reset retry count on successful batch
      if (onProgress) {
        onProgress(processed, sectionsToEmbed.length);
      }
    } catch (error) {
      // If batch fails, fall back to individual processing
      const isRateLimit = error instanceof Error && (error.message.includes("429") || error.message.includes("rate limit"));
      if (isRateLimit) {
        // Exponential backoff for rate limit errors: 1s, 2s, 4s, etc.
        retryCount++;
        const delay = Math.min(1000 * Math.pow(2, retryCount), 30000); // Max 30s
        console.error(`[Embeddings] Rate limit error (retry ${retryCount}), waiting ${delay}ms before retry...`);
        await new Promise((resolve) => setTimeout(resolve, delay));
        // Retry the batch instead of falling back to individual
        i -= batchSize; // Rewind to retry this batch
        continue;
      }
      
      retryCount = 0; // Reset retry count for non-rate-limit errors
      
      console.error(`[Embeddings] Batch embedding failed, falling back to individual:`, error);
      for (const section of batch) {
        try {
          const contentText = `${section.title}\n\n${section.content}`;
          const embedding = await createEmbedding(contentText, apiKey);
          const contentHash = hashContent(contentText);

          await saveDocumentationSectionEmbedding(section.id, section.url, embedding, contentHash);
          processed++;

          if (onProgress) {
            onProgress(processed, sectionsToEmbed.length);
          }

          // Small delay to respect rate limits
          await new Promise((resolve) => setTimeout(resolve, 100));
        } catch (individualError) {
          console.error(`[Embeddings] Failed to embed section ${section.id}:`, individualError);
        }
      }
    }

    // Small delay between batches to respect rate limits (reduced since we're batching saves)
    if (i + batchSize < sectionsToEmbed.length) {
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  }

  console.error(`[Embeddings] Completed section embeddings: ${processed}/${sectionsToEmbed.length}`);
}

/**
 * Compute and save embeddings for all documentation pages
 */
export async function computeAndSaveDocumentationEmbeddings(
  apiKey: string,
  onProgress?: (processed: number, total: number) => void
): Promise<void> {
  // Get all documentation that needs embeddings
  const allDocs = await prisma.documentationCache.findMany({
    orderBy: { url: "asc" },
    select: {
      url: true,
      title: true,
      content: true,
    },
  });

  const model = getEmbeddingModel();

  // Check which docs already have embeddings
  const existingEmbeddings = await prisma.documentationEmbedding.findMany({
    where: { model },
    select: {
      documentationUrl: true,
      contentHash: true,
    },
  });

  const existingHashes = new Map<string, string>();
  for (const row of existingEmbeddings) {
    existingHashes.set(row.documentationUrl, row.contentHash);
  }

  // Compute content hashes and find docs that need embeddings
  const docsToEmbed: Array<{ url: string; title: string; content: string }> = [];
  for (const doc of allDocs) {
    const contentText = doc.title ? `${doc.title}\n\n${doc.content}` : doc.content;
    const currentHash = hashContent(contentText);
    const existingHash = existingHashes.get(doc.url);

    if (!existingHash || existingHash !== currentHash) {
      docsToEmbed.push({
        url: doc.url,
        title: doc.title || "",
        content: doc.content,
      });
    }
  }

  console.error(`[Embeddings] Found ${allDocs.length} docs, ${docsToEmbed.length} need embeddings`);

  // Process in batches using batch embedding API
  const batchSize = 25;
  let processed = 0;
  let retryCount = 0;

  for (let i = 0; i < docsToEmbed.length; i += batchSize) {
    const batch = docsToEmbed.slice(i, i + batchSize);

    try {
      // Prepare texts for batch embedding
      const textsToEmbed = batch.map((doc) => (doc.title ? `${doc.title}\n\n${doc.content}` : doc.content));

      // Batch create embeddings
      const embeddings = await createEmbeddings(textsToEmbed, apiKey);

      // Batch save all embeddings in a single transaction
      const model = getEmbeddingModel();
      await prisma.$transaction(async (tx: Omit<typeof prisma, "$connect" | "$disconnect" | "$on" | "$transaction" | "$use" | "$extends">) => {
        await Promise.all(
          embeddings.map((embedding, j) => {
            const doc = batch[j];
            const contentText = textsToEmbed[j];
            const contentHash = hashContent(contentText);
            return tx.documentationEmbedding.upsert({
              where: { documentationUrl: doc.url },
              update: {
                embedding: embedding as any,
                contentHash,
                model,
              },
              create: {
                documentationUrl: doc.url,
                embedding: embedding as any,
                contentHash,
                model,
              },
            });
          })
        );
      });

      processed += batch.length;
      retryCount = 0; // Reset retry count on successful batch
      if (onProgress) {
        onProgress(processed, docsToEmbed.length);
      }
    } catch (error) {
      // If batch fails, fall back to individual processing
      const isRateLimit = error instanceof Error && (error.message.includes("429") || error.message.includes("rate limit"));
      if (isRateLimit) {
        // Exponential backoff for rate limit errors: 1s, 2s, 4s, etc.
        retryCount++;
        const delay = Math.min(1000 * Math.pow(2, retryCount), 30000); // Max 30s
        console.error(`[Embeddings] Rate limit error (retry ${retryCount}), waiting ${delay}ms before retry...`);
        await new Promise((resolve) => setTimeout(resolve, delay));
        // Retry the batch instead of falling back to individual
        i -= batchSize; // Rewind to retry this batch
        continue;
      }
      
      retryCount = 0; // Reset retry count for non-rate-limit errors
      console.error(`[Embeddings] Batch embedding failed, falling back to individual:`, error);
      for (const doc of batch) {
        try {
          const contentText = doc.title ? `${doc.title}\n\n${doc.content}` : doc.content;
          const embedding = await createEmbedding(contentText, apiKey);
          const contentHash = hashContent(contentText);

          await saveDocumentationEmbedding(doc.url, embedding, contentHash);
          processed++;

          if (onProgress) {
            onProgress(processed, docsToEmbed.length);
          }

          // Small delay to respect rate limits
          await new Promise((resolve) => setTimeout(resolve, 100));
        } catch (individualError) {
          console.error(`[Embeddings] Failed to embed doc ${doc.url}:`, individualError);
        }
      }
    }

    // Small delay between batches to respect rate limits (reduced since we're batching saves)
    if (i + batchSize < docsToEmbed.length) {
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  }

  console.error(`[Embeddings] Completed doc embeddings: ${processed}/${docsToEmbed.length}`);
}

/**
 * Compute and save embeddings for all features
 */
export async function computeAndSaveFeatureEmbeddings(
  apiKey: string,
  onProgress?: (processed: number, total: number) => void
): Promise<void> {
  // Get all features that need embeddings
  const allFeatures = await prisma.feature.findMany({
    orderBy: { id: "asc" },
    select: {
      id: true,
      name: true,
      description: true,
      relatedKeywords: true,
    },
  });

  const model = getEmbeddingModel();

  // Check which features already have embeddings
  const existingEmbeddings = await prisma.featureEmbedding.findMany({
    where: { model },
    select: {
      featureId: true,
      contentHash: true,
    },
  });

  const existingHashes = new Map<string, string>();
  for (const row of existingEmbeddings) {
    existingHashes.set(row.featureId, row.contentHash);
  }

  // Compute content hashes and find features that need embeddings
  const featuresToEmbed: Array<{ id: string; name: string; description: string; keywords: string[] }> = [];
  for (const feature of allFeatures) {
    const keywords = Array.isArray(feature.relatedKeywords) ? feature.relatedKeywords : [];
    const contentText = `${feature.name}${feature.description ? `: ${feature.description}` : ""}${keywords.length > 0 ? ` Keywords: ${keywords.join(", ")}` : ""}`;
    const currentHash = hashContent(contentText);
    const existingHash = existingHashes.get(feature.id);

    if (!existingHash || existingHash !== currentHash) {
      featuresToEmbed.push({
        id: feature.id,
        name: feature.name,
        description: feature.description || "",
        keywords: keywords,
      });
    }
  }

  console.error(`[Embeddings] Found ${allFeatures.length} features, ${featuresToEmbed.length} need embeddings`);

  // Process in batches using batch embedding API
  // Features are shorter than documentation (name + description + keywords), so can use larger batches
  // Target: ~50k tokens per batch (50 features × 1000 avg tokens = 50k tokens)
  const batchSize = 50;
  let processed = 0;
  let retryCount = 0;

  for (let i = 0; i < featuresToEmbed.length; i += batchSize) {
    const batch = featuresToEmbed.slice(i, i + batchSize);

    try {
      // Prepare texts for batch embedding
      const textsToEmbed = batch.map((feature) => {
        const keywords = feature.keywords.length > 0 ? ` Keywords: ${feature.keywords.join(", ")}` : "";
        return `${feature.name}${feature.description ? `: ${feature.description}` : ""}${keywords}`;
      });

      // Batch create embeddings
      const embeddings = await createEmbeddings(textsToEmbed, apiKey);

      // Batch save all embeddings in a single transaction
      const model = getEmbeddingModel();
      await prisma.$transaction(async (tx: Omit<typeof prisma, "$connect" | "$disconnect" | "$on" | "$transaction" | "$use" | "$extends">) => {
        await Promise.all(
          embeddings.map((embedding, j) => {
            const feature = batch[j];
            const contentText = textsToEmbed[j];
            const contentHash = hashContent(contentText);
            return tx.featureEmbedding.upsert({
              where: { featureId: feature.id },
              update: {
                embedding: embedding as any,
                contentHash,
                model,
              },
              create: {
                featureId: feature.id,
                embedding: embedding as any,
                contentHash,
                model,
              },
            });
          })
        );
      });

      processed += batch.length;
      retryCount = 0; // Reset retry count on successful batch
      if (onProgress) {
        onProgress(processed, featuresToEmbed.length);
      }
    } catch (error) {
      // If batch fails, fall back to individual processing
      const isRateLimit = error instanceof Error && (error.message.includes("429") || error.message.includes("rate limit"));
      if (isRateLimit) {
        // Exponential backoff for rate limit errors: 1s, 2s, 4s, etc.
        retryCount++;
        const delay = Math.min(1000 * Math.pow(2, retryCount), 30000); // Max 30s
        console.error(`[Embeddings] Rate limit error (retry ${retryCount}), waiting ${delay}ms before retry...`);
        await new Promise((resolve) => setTimeout(resolve, delay));
        // Retry the batch instead of falling back to individual
        i -= batchSize; // Rewind to retry this batch
        continue;
      }
      
      retryCount = 0; // Reset retry count for non-rate-limit errors
      
      console.error(`[Embeddings] Batch embedding failed, falling back to individual:`, error);
      for (const feature of batch) {
        try {
          const keywords = feature.keywords.length > 0 ? ` Keywords: ${feature.keywords.join(", ")}` : "";
          const contentText = `${feature.name}${feature.description ? `: ${feature.description}` : ""}${keywords}`;
          const embedding = await createEmbedding(contentText, apiKey);
          const contentHash = hashContent(contentText);

          await saveFeatureEmbedding(feature.id, embedding, contentHash);
          processed++;

          if (onProgress) {
            onProgress(processed, featuresToEmbed.length);
          }

          // Small delay to respect rate limits
          await new Promise((resolve) => setTimeout(resolve, 100));
        } catch (individualError) {
          console.error(`[Embeddings] Failed to embed feature ${feature.id}:`, individualError);
        }
      }
    }

    // Small delay between batches to respect rate limits (reduced since we're batching saves)
    if (i + batchSize < featuresToEmbed.length) {
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  }

  console.error(`[Embeddings] Completed feature embeddings: ${processed}/${featuresToEmbed.length}`);
}

/**
 * Compute embeddings for all documentation, sections, and features
 */
export async function computeAllEmbeddings(
  apiKey: string,
  options?: {
    skipDocs?: boolean;
    skipSections?: boolean;
    skipFeatures?: boolean;
  }
): Promise<void> {
  console.error("[Embeddings] Starting batch embedding computation...");

  if (!options?.skipDocs) {
    await computeAndSaveDocumentationEmbeddings(apiKey);
  }

  if (!options?.skipSections) {
    await computeAndSaveDocumentationSectionEmbeddings(apiKey);
  }

  if (!options?.skipFeatures) {
    await computeAndSaveFeatureEmbeddings(apiKey);
  }

  console.error("[Embeddings] Completed all embedding computations");
}
