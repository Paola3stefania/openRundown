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
      embedding: embedding as Prisma.InputJsonValue,
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
      embedding: embedding as Prisma.InputJsonValue,
      contentHash,
      model,
    },
    create: {
      documentationUrl: url,
      embedding: embedding as Prisma.InputJsonValue,
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
      embedding: embedding as Prisma.InputJsonValue,
      contentHash,
      model,
    },
    create: {
      featureId,
      embedding: embedding as Prisma.InputJsonValue,
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
                embedding: embedding as Prisma.InputJsonValue,
                contentHash,
                model,
              },
              create: {
                sectionId: section.id,
                documentationUrl: section.url,
                embedding: embedding as Prisma.InputJsonValue,
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
                embedding: embedding as Prisma.InputJsonValue,
                contentHash,
                model,
              },
              create: {
                documentationUrl: doc.url,
                embedding: embedding as Prisma.InputJsonValue,
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
                embedding: embedding as Prisma.InputJsonValue,
                contentHash,
                model,
              },
              create: {
                featureId: feature.id,
                embedding: embedding as Prisma.InputJsonValue,
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
 * Save thread embedding
 */
export async function saveThreadEmbedding(
  threadId: string,
  embedding: Embedding,
  contentHash: string
): Promise<void> {
  const model = getEmbeddingModel();
  await prisma.threadEmbedding.upsert({
    where: { threadId },
    update: {
      embedding: embedding as Prisma.InputJsonValue,
      contentHash,
      model,
    },
    create: {
      threadId,
      embedding: embedding as Prisma.InputJsonValue,
      contentHash,
      model,
    },
  });
}

/**
 * Get thread embedding
 */
export async function getThreadEmbedding(threadId: string): Promise<Embedding | null> {
  const model = getEmbeddingModel();
  const result = await prisma.threadEmbedding.findUnique({
    where: { threadId },
    select: { embedding: true, model: true },
  });

  if (!result || result.model !== model) {
    return null;
  }

  return result.embedding as Embedding;
}

/**
 * Compute and save embeddings for all Discord message threads
 */
export async function computeAndSaveThreadEmbeddings(
  apiKey: string,
  options?: {
    channelId?: string;
    onProgress?: (processed: number, total: number) => void;
  }
): Promise<{ computed: number; cached: number; total: number }> {
  const onProgress = options?.onProgress;
  
  // Get all classified threads (optionally filtered by channel)
  const allThreads = await prisma.classifiedThread.findMany({
    where: options?.channelId ? { channelId: options.channelId } : undefined,
    select: {
      threadId: true,
      threadName: true,
    },
    orderBy: { threadId: "asc" },
  });

  const model = getEmbeddingModel();

  // Check which threads already have embeddings
  const existingEmbeddings = await prisma.threadEmbedding.findMany({
    where: { model },
    select: {
      threadId: true,
      contentHash: true,
    },
  });

  const existingHashes = new Map<string, string>();
  for (const row of existingEmbeddings) {
    existingHashes.set(row.threadId, row.contentHash);
  }

  // Get all messages for threads to build content
  const threadsToEmbed: Array<{ threadId: string; threadName: string | null; content: string }> = [];
  
  for (const thread of allThreads) {
    // Get all messages for this thread
    const messages = await prisma.discordMessage.findMany({
      where: { threadId: thread.threadId },
      select: { content: true },
      orderBy: { createdAt: "asc" },
    });

    if (messages.length === 0) {
      continue; // Skip threads with no messages
    }

    // Build thread content by combining all messages
    const threadContent = messages.map(m => m.content).join('\n');
    const currentHash = hashContent(threadContent);
    const existingHash = existingHashes.get(thread.threadId);

    if (!existingHash || existingHash !== currentHash) {
      threadsToEmbed.push({
        threadId: thread.threadId,
        threadName: thread.threadName,
        content: threadContent,
      });
    }
  }

  // Also handle standalone messages (messages not in threads)
  // Treat each standalone message as a single-message thread (using message ID as thread ID)
  const standaloneMessages = await prisma.discordMessage.findMany({
    where: { 
      threadId: null,
      // Only get messages that are not already classified as threads
      // (i.e., their message ID is not already a thread ID)
      id: {
        notIn: allThreads.map(t => t.threadId),
      },
      // Filter by channel if specified
      ...(options?.channelId ? { channelId: options.channelId } : {}),
    },
    select: { 
      id: true,
      content: true,
      channelId: true,
      createdAt: true,
      authorUsername: true,
      url: true,
    },
    orderBy: { createdAt: "asc" },
  });

  console.error(`[Embeddings] Found ${standaloneMessages.length} standalone messages`);

  let standaloneCached = 0;
  let threadsNeedingEmbedding = threadsToEmbed.length;
  
  // For standalone messages, we need to ensure they exist in ClassifiedThread table
  // (required by foreign key constraint in ThreadEmbedding)
  // First, check which standalone messages already have ClassifiedThread entries
  const standaloneThreadIds = standaloneMessages.map(m => m.id);
  const existingStandaloneThreads = await prisma.classifiedThread.findMany({
    where: { threadId: { in: standaloneThreadIds } },
    select: { threadId: true },
  });
  const existingStandaloneThreadIds = new Set(existingStandaloneThreads.map(t => t.threadId));

  // Batch create ClassifiedThread entries for standalone messages that don't have them
  // Use individual upserts instead of createMany to handle special characters better
  if (standaloneMessages.length > 0) {
    const messagesToCreate = standaloneMessages.filter(m => !existingStandaloneThreadIds.has(m.id));
    
    if (messagesToCreate.length > 0) {
      console.error(`[Embeddings] Creating ${messagesToCreate.length} ClassifiedThread entries for standalone messages`);
      
      // Use individual upserts with error handling for problematic messages
      let createdCount = 0;
      let failedCount = 0;
      
      // Helper function to safely sanitize string for database
      function sanitizeForDB(str: string, maxLength: number = 100): string {
        if (!str) return '';
        return str
          .replace(/\\/g, '') // Remove backslashes (can cause escape sequence issues)
          .replace(/\0/g, '') // Remove null bytes
          .replace(/[\x00-\x08\x0B-\x0C\x0E-\x1F\x7F]/g, '') // Remove control characters
          .replace(/[\uFFFE-\uFFFF]/g, '') // Remove invalid UTF-16 characters
          .normalize('NFKC') // Normalize unicode
          .substring(0, maxLength)
          .trim();
      }
      
      for (const message of messagesToCreate) {
        try {
          // Use a simple thread name without including message content to avoid escape sequence issues
          // The content will still be embedded, just not in the thread name
          const threadName = `Standalone Message ${message.id.substring(0, 8)}`;
          
          // Sanitize author username if present
          const sanitizedAuthor = message.authorUsername ? sanitizeForDB(message.authorUsername, 50) : null;
          
          await prisma.classifiedThread.upsert({
            where: { threadId: message.id },
            update: {},
            create: {
              threadId: message.id,
              channelId: message.channelId,
              threadName: threadName,
              messageCount: 1,
              firstMessageId: message.id,
              firstMessageAuthor: sanitizedAuthor,
              firstMessageTimestamp: message.createdAt,
              firstMessageUrl: message.url || null,
              status: "completed",
              matchStatus: null,
            },
          });
          createdCount++;
        } catch (error) {
          console.error(`[Embeddings] Failed to create ClassifiedThread for standalone message ${message.id}:`, error instanceof Error ? error.message : error);
          failedCount++;
          // Continue with other messages
        }
      }
      
      if (failedCount > 0) {
        console.error(`[Embeddings] Created ${createdCount} ClassifiedThread entries, ${failedCount} failed`);
      }
    }
  }

  // Now process standalone messages for embedding
  for (const message of standaloneMessages) {
    // Use message ID as thread ID for standalone messages (consistent with classification)
    const threadId = message.id;
    const messageContent = message.content;
    const currentHash = hashContent(messageContent);
    const existingHash = existingHashes.get(threadId);

    if (!existingHash || existingHash !== currentHash) {
      threadsToEmbed.push({
        threadId: threadId,
        threadName: `Standalone Message: ${messageContent.substring(0, 50)}...`,
        content: messageContent,
      });
    } else {
      standaloneCached++;
    }
  }

  const totalItems = allThreads.length + standaloneMessages.length;
  const threadCached = allThreads.length - threadsNeedingEmbedding;
  const totalCached = threadCached + standaloneCached;
  
  console.error(`[Embeddings] Found ${allThreads.length} threads and ${standaloneMessages.length} standalone messages, ${threadsToEmbed.length} need embeddings`);

  // Process in batches using batch embedding API
  const batchSize = 25; // Threads can be long, use smaller batches
  let processed = 0;
  let cached = totalCached;
  let retryCount = 0;

  for (let i = 0; i < threadsToEmbed.length; i += batchSize) {
    const batch = threadsToEmbed.slice(i, i + batchSize);

    try {
      // Prepare texts for batch embedding
      const textsToEmbed = batch.map((thread) => thread.content);

      // Batch create embeddings
      const embeddings = await createEmbeddings(textsToEmbed, apiKey);

      // Batch save all embeddings in a single transaction
      await prisma.$transaction(async (tx: Omit<typeof prisma, "$connect" | "$disconnect" | "$on" | "$transaction" | "$use" | "$extends">) => {
        await Promise.all(
          embeddings.map((embedding, j) => {
            const thread = batch[j];
            const contentText = textsToEmbed[j];
            const contentHash = hashContent(contentText);
            return tx.threadEmbedding.upsert({
              where: { threadId: thread.threadId },
              update: {
                embedding: embedding as Prisma.InputJsonValue,
                contentHash,
                model,
              },
              create: {
                threadId: thread.threadId,
                embedding: embedding as Prisma.InputJsonValue,
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
        onProgress(processed, threadsToEmbed.length);
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
      for (const thread of batch) {
        try {
          const embedding = await createEmbedding(thread.content, apiKey);
          const contentHash = hashContent(thread.content);

          await saveThreadEmbedding(thread.threadId, embedding, contentHash);
          processed++;

          if (onProgress) {
            onProgress(processed, threadsToEmbed.length);
          }

          // Small delay to respect rate limits
          await new Promise((resolve) => setTimeout(resolve, 100));
        } catch (individualError) {
          console.error(`[Embeddings] Failed to embed thread ${thread.threadId}:`, individualError);
        }
      }
    }

    // Small delay between batches to respect rate limits
    if (i + batchSize < threadsToEmbed.length) {
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  }

  console.error(`[Embeddings] Completed thread embeddings: ${processed}/${threadsToEmbed.length} computed, ${cached} cached`);
  return { computed: processed, cached, total: totalItems };
}

/**
 * Compute and save embeddings for all GitHub issues
 */
export async function computeAndSaveIssueEmbeddings(
  apiKey: string,
  onProgress?: (processed: number, total: number) => void
): Promise<{ computed: number; cached: number; total: number }> {
  // Get all issues
  const allIssues = await prisma.gitHubIssue.findMany({
    select: {
      issueNumber: true,
      issueTitle: true,
      issueBody: true,
      issueLabels: true,
    },
    orderBy: { issueNumber: "asc" },
  });

  const model = getEmbeddingModel();

  // Check which issues already have embeddings
  const existingEmbeddings = await prisma.issueEmbedding.findMany({
    where: { model },
    select: {
      issueNumber: true,
      contentHash: true,
    },
  });

  const existingHashes = new Map<number, string>();
  for (const row of existingEmbeddings) {
    existingHashes.set(row.issueNumber, row.contentHash);
  }

  // Compute content hashes and find issues that need embeddings
  // Build issue text in same format as used in classification: title + body + labels
  const issuesToEmbed: Array<{ issueNumber: number; issueTitle: string; issueBody: string | null; issueLabels: string[]; content: string }> = [];
  for (const issue of allIssues) {
    const issueText = [
      issue.issueTitle,
      issue.issueBody || "",
      ...issue.issueLabels.sort(),
    ].join("\n\n");
    
    const currentHash = hashContent(issueText);
    const existingHash = existingHashes.get(issue.issueNumber);

    if (!existingHash || existingHash !== currentHash) {
      issuesToEmbed.push({
        issueNumber: issue.issueNumber,
        issueTitle: issue.issueTitle,
        issueBody: issue.issueBody,
        issueLabels: issue.issueLabels,
        content: issueText,
      });
    }
  }

  console.error(`[Embeddings] Found ${allIssues.length} issues, ${issuesToEmbed.length} need embeddings`);

  // Process in batches using batch embedding API
  // Issues (title + body) are typically shorter than documentation, so can use larger batches
  const batchSize = 50;
  let processed = 0;
  let cached = allIssues.length - issuesToEmbed.length;
  let retryCount = 0;

  for (let i = 0; i < issuesToEmbed.length; i += batchSize) {
    const batch = issuesToEmbed.slice(i, i + batchSize);

    try {
      // Prepare texts for batch embedding
      const textsToEmbed = batch.map((issue) => issue.content);

      // Batch create embeddings
      const embeddings = await createEmbeddings(textsToEmbed, apiKey);

      // Batch save all embeddings in a single transaction
      await prisma.$transaction(async (tx: Omit<typeof prisma, "$connect" | "$disconnect" | "$on" | "$transaction" | "$use" | "$extends">) => {
        await Promise.all(
          embeddings.map((embedding, j) => {
            const issue = batch[j];
            const contentText = textsToEmbed[j];
            const contentHash = hashContent(contentText);
            return tx.issueEmbedding.upsert({
              where: { issueNumber: issue.issueNumber },
              update: {
                embedding: embedding as Prisma.InputJsonValue,
                contentHash,
                model,
              },
              create: {
                issueNumber: issue.issueNumber,
                embedding: embedding as Prisma.InputJsonValue,
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
        onProgress(processed, issuesToEmbed.length);
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
      for (const issue of batch) {
        try {
          const embedding = await createEmbedding(issue.content, apiKey);
          const contentHash = hashContent(issue.content);

          await prisma.issueEmbedding.upsert({
            where: { issueNumber: issue.issueNumber },
            update: {
              embedding: embedding as Prisma.InputJsonValue,
              contentHash,
              model,
            },
            create: {
              issueNumber: issue.issueNumber,
              embedding: embedding as Prisma.InputJsonValue,
              contentHash,
              model,
            },
          });
          processed++;

          if (onProgress) {
            onProgress(processed, issuesToEmbed.length);
          }

          // Small delay to respect rate limits
          await new Promise((resolve) => setTimeout(resolve, 100));
        } catch (individualError) {
          console.error(`[Embeddings] Failed to embed issue ${issue.issueNumber}:`, individualError);
        }
      }
    }

    // Small delay between batches to respect rate limits
    if (i + batchSize < issuesToEmbed.length) {
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  }

  console.error(`[Embeddings] Completed issue embeddings: ${processed}/${issuesToEmbed.length} computed, ${cached} cached`);
  return { computed: processed, cached, total: allIssues.length };
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
    skipThreads?: boolean;
    skipIssues?: boolean;
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

  if (!options?.skipThreads) {
    await computeAndSaveThreadEmbeddings(apiKey, {});
  }

  if (!options?.skipIssues) {
    await computeAndSaveIssueEmbeddings(apiKey);
  }

  console.error("[Embeddings] Completed all embedding computations");
}
