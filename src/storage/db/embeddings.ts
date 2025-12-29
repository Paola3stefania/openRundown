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
  onProgress?: (processed: number, total: number) => void,
  force: boolean = false
): Promise<void> {
  if (!apiKey) {
    throw new Error("OPENAI_API_KEY is required to compute feature embeddings");
  }

  console.error(`[Embeddings] Starting feature embedding computation...`);
  
  // Get all features that need embeddings
  const allFeatures = await prisma.feature.findMany({
    orderBy: { id: "asc" },
    select: {
      id: true,
      name: true,
      description: true,
      relatedKeywords: true,
      codeContext: true,
    },
  });

  if (allFeatures.length === 0) {
    console.error(`[Embeddings] No features found in database. Make sure features are saved to the database first by calling getFeaturesFromCacheOrExtract().`);
    return;
  }

  console.error(`[Embeddings] Found ${allFeatures.length} features in database`);

  // Fetch code context from GitHub repository if configured
  let codeContext = "";
  try {
    const { getConfig } = await import("../../config/index.js");
    const config = getConfig();
    const githubRepoUrl = config.pmIntegration?.github_repo_url;
    
    if (githubRepoUrl) {
      console.error(`[Embeddings] Fetching code context from GitHub repository: ${githubRepoUrl}`);
      const { parseGitHubRepoUrl, fetchRepositoryCodeContext } = await import("../../connectors/github/codeFetcher.js");
      const repoInfo = parseGitHubRepoUrl(githubRepoUrl);
      
      if (repoInfo) {
        const githubToken = process.env.GITHUB_TOKEN;
        codeContext = await fetchRepositoryCodeContext(repoInfo, githubToken, 15); // Fetch up to 15 files
        if (codeContext) {
          console.error(`[Embeddings] Fetched code context (${codeContext.length} characters) from repository`);
          // Truncate to reasonable size to avoid token limits
          if (codeContext.length > 5000) {
            codeContext = codeContext.substring(0, 5000) + "... [truncated]";
          }
        } else {
          console.error(`[Embeddings] No code context fetched from repository`);
        }
      } else {
        console.error(`[Embeddings] Failed to parse GitHub repo URL: ${githubRepoUrl}`);
      }
    }
  } catch (error) {
    console.error(`[Embeddings] Failed to fetch code context: ${error instanceof Error ? error.message : String(error)}`);
    // Continue without code context
  }

  const model = getEmbeddingModel();
  console.error(`[Embeddings] Using embedding model: ${model}`);

  // Check which features already have embeddings (unless forcing recomputation)
  const existingHashes = new Map<string, string>();
  if (!force) {
    const existingEmbeddings = await prisma.featureEmbedding.findMany({
      where: { model },
      select: {
        featureId: true,
        contentHash: true,
      },
    });

    console.error(`[Embeddings] Found ${existingEmbeddings.length} existing embeddings in database for model ${model}`);

    for (const row of existingEmbeddings) {
      existingHashes.set(row.featureId, row.contentHash);
    }
  } else {
    console.error(`[Embeddings] Force recomputation enabled - will recompute all feature embeddings`);
  }

  // Compute content hashes and find features that need embeddings
  // Also fetch related GitHub issues, documentation, threads, and code for each feature to enhance embeddings
  const featuresToEmbed: Array<{ 
    id: string; 
    name: string; 
    description: string; 
    keywords: string[]; 
    issueContext?: string; 
    codeContext?: string;
    docContext?: string;
    threadContext?: string;
    featureSpecificCodeContext?: string;
    codeContextToSave?: string;
  }> = [];
  
  for (const feature of allFeatures) {
    const keywords = Array.isArray(feature.relatedKeywords) ? feature.relatedKeywords : [];
    
    // Find groups that have this feature in their affectsFeatures (shared for both issues and threads)
    // Prisma doesn't support direct JSONB array queries, so we fetch and filter
    let relatedGroups: Array<{
      affectsFeatures: unknown;
      githubIssues: Array<{ issueTitle: string | null; issueBody: string | null; issueLabels: unknown }>;
      groupThreads: Array<{ thread: { threadId: string; threadName: string | null } | null }>;
    }> = [];
    
    try {
      const allGroups = await prisma.group.findMany({
        include: {
          githubIssues: {
            select: {
              issueTitle: true,
              issueBody: true,
              issueLabels: true,
            },
            take: 10, // Limit to top 10 issues per feature to avoid token limits
          },
          groupThreads: {
            include: {
              thread: {
                select: {
                  threadId: true,
                  threadName: true,
                },
              },
            },
          },
        },
      });

      // Filter groups that contain this feature in their affectsFeatures
      relatedGroups = allGroups.filter(group => {
        const affectsFeatures = Array.isArray(group.affectsFeatures) 
          ? group.affectsFeatures 
          : [];
        return affectsFeatures.some((f: unknown) => {
          if (typeof f === 'object' && f !== null && 'id' in f) {
            return (f as { id: string }).id === feature.id;
          }
          return false;
        });
      });
    } catch (groupsError) {
      console.error(`[Embeddings] Could not fetch groups for feature ${feature.id}: ${groupsError instanceof Error ? groupsError.message : String(groupsError)}`);
    }
    
    // Find GitHub issues related to this feature through groups
    let issueContext = "";
    try {

      // Collect issue titles, bodies (excerpts), and labels to learn from historical matches
      const issueTitles: string[] = [];
      const issueBodies: string[] = [];
      const issueLabels = new Set<string>();
      
      for (const group of relatedGroups) {
        for (const issue of group.githubIssues) {
          if (issue.issueTitle) {
            issueTitles.push(issue.issueTitle);
          }
          // Include issue body excerpts (first 300 chars) to learn from actual discussions
          if (issue.issueBody && issue.issueBody.length > 0) {
            const bodyExcerpt = issue.issueBody.substring(0, 300).replace(/\n/g, " ").trim();
            if (bodyExcerpt.length > 20) { // Only include if meaningful
              issueBodies.push(bodyExcerpt);
            }
          }
          if (issue.issueLabels && Array.isArray(issue.issueLabels)) {
            issue.issueLabels.forEach(label => issueLabels.add(label));
          }
        }
      }
      
      // Also check ungrouped issues that matched to this feature
      try {
        const allUngroupedIssues = await prisma.ungroupedIssue.findMany({
          select: {
            issueTitle: true,
            issueBody: true,
            issueLabels: true,
            affectsFeatures: true,
          },
          take: 10,
        });
        
        const relatedUngroupedIssues = allUngroupedIssues.filter(ui => {
          const affectsFeatures = Array.isArray(ui.affectsFeatures) ? ui.affectsFeatures : [];
          return affectsFeatures.some((f: unknown) => {
            if (typeof f === 'object' && f !== null && 'id' in f) {
              return (f as { id: string }).id === feature.id;
            }
            return false;
          });
        });
        
        for (const issue of relatedUngroupedIssues) {
          if (issue.issueTitle) {
            issueTitles.push(issue.issueTitle);
          }
          if (issue.issueBody && issue.issueBody.length > 0) {
            const bodyExcerpt = issue.issueBody.substring(0, 300).replace(/\n/g, " ").trim();
            if (bodyExcerpt.length > 20) {
              issueBodies.push(bodyExcerpt);
            }
          }
          if (issue.issueLabels && Array.isArray(issue.issueLabels)) {
            issue.issueLabels.forEach(label => issueLabels.add(label));
          }
        }
      } catch (ungroupedError) {
        console.error(`[Embeddings] Could not fetch ungrouped issues for feature ${feature.id}: ${ungroupedError instanceof Error ? ungroupedError.message : String(ungroupedError)}`);
      }

      if (issueTitles.length > 0) {
        issueContext = ` Related GitHub Issues: ${issueTitles.slice(0, 5).join("; ")}`;
        if (issueBodies.length > 0) {
          // Include issue body excerpts to learn from actual user discussions
          issueContext += ` Issue Content: ${issueBodies.slice(0, 3).join(" | ")}`;
        }
        if (issueLabels.size > 0) {
          issueContext += ` Labels: ${Array.from(issueLabels).slice(0, 10).join(", ")}`;
        }
      }
    } catch (error) {
      // If query fails, continue without issue context
      console.error(`[Embeddings] Could not fetch related issues for feature ${feature.id}: ${error instanceof Error ? error.message : String(error)}`);
    }
    
    // Find related Discord threads (from groups and ungrouped threads that matched to this feature)
    let threadContext = "";
    try {
      // Get threads from groups that matched to this feature
      const threadNamesFromGroups: string[] = [];
      const threadMessages: string[] = [];
      
      for (const group of relatedGroups) {
        // Get thread names from group
        if (group.groupThreads) {
          for (const gt of group.groupThreads) {
            if (gt.thread?.threadName) {
              threadNamesFromGroups.push(gt.thread.threadName);
            }
          }
        }
      }
      
      // Get ungrouped threads that matched to this feature
      const allUngroupedThreads = await prisma.ungroupedThread.findMany({
        include: {
          thread: {
            select: {
              threadName: true,
            },
          },
        },
        take: 10,
      });
      
      const relatedUngroupedThreads = allUngroupedThreads.filter(ut => {
        const affectsFeatures = Array.isArray(ut.affectsFeatures) ? ut.affectsFeatures : [];
        return affectsFeatures.some((f: unknown) => {
          if (typeof f === 'object' && f !== null && 'id' in f) {
            return (f as { id: string }).id === feature.id;
          }
          return false;
        });
      });
      
      // Collect thread names and messages from matched threads
      const allThreadNames: string[] = [...threadNamesFromGroups];
      for (const ut of relatedUngroupedThreads) {
        if (ut.thread?.threadName) {
          allThreadNames.push(ut.thread.threadName);
        }
      }
      
      // Get actual message content from threads to learn from conversations
      try {
        const threadIds = [
          ...relatedGroups.flatMap(g => g.groupThreads?.map(gt => gt.thread?.threadId).filter(Boolean) || []),
          ...relatedUngroupedThreads.map(ut => ut.threadId).filter(Boolean),
        ].filter(Boolean).slice(0, 5) as string[]; // Limit to 5 threads to avoid token limits
        
        if (threadIds.length > 0) {
          const threadMessagesData = await prisma.discordMessage.findMany({
            where: {
              threadId: { in: threadIds },
            },
            select: {
              content: true,
              authorUsername: true,
            },
            orderBy: { createdAt: "asc" },
            take: 50, // Get up to 50 messages total across threads
          });
          
          // Create conversation excerpts (combine messages from same thread)
          const conversationExcerpts = threadMessagesData
            .slice(0, 10) // Limit to 10 messages
            .map(m => `${m.authorUsername || 'User'}: ${m.content.substring(0, 200)}`)
            .join(" | ");
          
          if (conversationExcerpts.length > 0) {
            threadMessages.push(conversationExcerpts);
          }
        }
      } catch (messageError) {
        console.error(`[Embeddings] Could not fetch thread messages for feature ${feature.id}: ${messageError instanceof Error ? messageError.message : String(messageError)}`);
      }
      
      if (allThreadNames.length > 0 || threadMessages.length > 0) {
        threadContext = "";
        if (allThreadNames.length > 0) {
          threadContext += ` Related Threads: ${allThreadNames.slice(0, 5).join("; ")}`;
        }
        if (threadMessages.length > 0) {
          threadContext += ` Thread Conversations: ${threadMessages.join(" | ")}`;
        }
      }
    } catch (error) {
      console.error(`[Embeddings] Could not fetch related threads for feature ${feature.id}: ${error instanceof Error ? error.message : String(error)}`);
    }
    
    // Find documentation sections that mention this feature
    let docContext = "";
    try {
      const featureNameLower = feature.name.toLowerCase();
      const featureKeywords = keywords.map(k => k.toLowerCase());
      
      // Search documentation sections for feature name or keywords
      const allSections = await prisma.documentationSection.findMany({
        select: {
          title: true,
          content: true,
          documentationUrl: true,
        },
        take: 20, // Limit to avoid token limits
      });
      
      const relevantSections: Array<{ title: string; content: string }> = [];
      
      for (const section of allSections) {
        const sectionText = `${section.title} ${section.content}`.toLowerCase();
        
        // Check if feature name or keywords appear in section
        if (sectionText.includes(featureNameLower)) {
          relevantSections.push({ title: section.title, content: section.content.substring(0, 500) }); // Limit content length
        } else {
          // Check keywords
          for (const keyword of featureKeywords) {
            if (keyword.length > 2 && sectionText.includes(keyword)) {
              relevantSections.push({ title: section.title, content: section.content.substring(0, 500) });
              break;
            }
          }
        }
      }
      
      if (relevantSections.length > 0) {
        // Include section titles and excerpts
        const sectionExcerpts = relevantSections.slice(0, 5).map(s => 
          `${s.title}: ${s.content.substring(0, 200)}...`
        ).join(" | ");
        docContext = ` Documentation: ${sectionExcerpts}`;
      }
    } catch (error) {
      console.error(`[Embeddings] Could not fetch documentation sections for feature ${feature.id}: ${error instanceof Error ? error.message : String(error)}`);
    }
    
    // Find feature-specific code context (code files that mention the feature)
    let featureSpecificCodeContext = "";
    if (codeContext) {
      const featureNameLower = feature.name.toLowerCase();
      const featureKeywords = keywords.map(k => k.toLowerCase());
      
      // Search code context for feature name or keywords
      const codeContextLower = codeContext.toLowerCase();
      if (codeContextLower.includes(featureNameLower) || 
          featureKeywords.some(k => k.length > 2 && codeContextLower.includes(k))) {
        // Extract relevant parts of code context
        const codeLines = codeContext.split('\n');
        const relevantLines: string[] = [];
        
        for (const line of codeLines) {
          const lineLower = line.toLowerCase();
          if (lineLower.includes(featureNameLower) || 
              featureKeywords.some(k => k.length > 2 && lineLower.includes(k))) {
            relevantLines.push(line);
            if (relevantLines.length >= 10) break; // Limit to 10 relevant lines
          }
        }
        
        if (relevantLines.length > 0) {
          featureSpecificCodeContext = ` Feature-Specific Code: ${relevantLines.join(" ").substring(0, 1000)}`;
        }
      }
    }
    
    // Include code context for all features (shared repository context)
    const codeContextPart = codeContext ? ` Code Context: ${codeContext}` : "";
    // Include feature-specific code context if available (more relevant)
    const finalCodeContext = featureSpecificCodeContext || codeContextPart;
    
    const contentText = `${feature.name}${feature.description ? `: ${feature.description}` : ""}${keywords.length > 0 ? ` Keywords: ${keywords.join(", ")}` : ""}${docContext}${issueContext}${threadContext}${finalCodeContext}`;
    const currentHash = hashContent(contentText);
    const existingHash = existingHashes.get(feature.id);

    // Prepare code context to save (use feature-specific if available, otherwise general)
    const codeContextToSave = featureSpecificCodeContext ? featureSpecificCodeContext.replace(" Feature-Specific Code: ", "") : (codeContext || "");

    if (!existingHash || existingHash !== currentHash) {
      featuresToEmbed.push({
        id: feature.id,
        name: feature.name,
        description: feature.description || "",
        keywords: keywords,
        issueContext: issueContext || undefined,
        codeContext: codeContext || undefined,
        docContext: docContext || undefined,
        threadContext: threadContext || undefined,
        featureSpecificCodeContext: featureSpecificCodeContext || undefined,
        codeContextToSave: codeContextToSave || undefined,
      });
      if (!existingHash) {
        console.error(`[Embeddings] Feature "${feature.name}" (${feature.id}) has no embedding - will compute`);
        if (issueContext) {
          console.error(`[Embeddings] Feature "${feature.name}" will include ${issueContext.length > 100 ? issueContext.substring(0, 100) + "..." : issueContext} from related issues`);
        }
      } else {
        console.error(`[Embeddings] Feature "${feature.name}" (${feature.id}) content changed - will recompute (old hash: ${existingHash.substring(0, 8)}..., new hash: ${currentHash.substring(0, 8)}...)`);
      }
    }
  }

  console.error(`[Embeddings] Found ${allFeatures.length} features, ${featuresToEmbed.length} need embeddings`);
  
  if (featuresToEmbed.length === 0) {
    console.error(`[Embeddings] All features already have embeddings. Skipping computation.`);
    return;
  }

  // Process in batches using batch embedding API
  // Features are shorter than documentation (name + description + keywords), so can use larger batches
  // Target: ~50k tokens per batch (50 features × 1000 avg tokens = 50k tokens)
  const batchSize = 50;
  let processed = 0;
  let retryCount = 0;

  for (let i = 0; i < featuresToEmbed.length; i += batchSize) {
    const batch = featuresToEmbed.slice(i, i + batchSize);

    try {
      // Prepare texts for batch embedding (include all context: docs, issues, threads, code)
      const textsToEmbed = batch.map((feature) => {
        const keywords = feature.keywords.length > 0 ? ` Keywords: ${feature.keywords.join(", ")}` : "";
        const docContext = feature.docContext || "";
        const issueContext = feature.issueContext || "";
        const threadContext = feature.threadContext || "";
        // Prefer feature-specific code context over general code context
        const codeContext = feature.featureSpecificCodeContext 
          ? ` Feature-Specific Code: ${feature.featureSpecificCodeContext}`
          : (feature.codeContext ? ` Code Context: ${feature.codeContext}` : "");
        return `${feature.name}${feature.description ? `: ${feature.description}` : ""}${keywords}${docContext}${issueContext}${threadContext}${codeContext}`;
      });

      // Batch create embeddings
      console.error(`[Embeddings] Computing embeddings for batch ${Math.floor(i / batchSize) + 1} (${batch.length} features)...`);
      const embeddings = await createEmbeddings(textsToEmbed, apiKey);
      console.error(`[Embeddings] Successfully computed ${embeddings.length} embeddings`);

      // Batch save all embeddings and code context in a single transaction
      const model = getEmbeddingModel();
      console.error(`[Embeddings] Saving ${embeddings.length} embeddings and code context to database...`);
      await prisma.$transaction(async (tx: Omit<typeof prisma, "$connect" | "$disconnect" | "$on" | "$transaction" | "$use" | "$extends">) => {
        await Promise.all(
          embeddings.map(async (embedding, j) => {
            const feature = batch[j];
            const contentText = textsToEmbed[j];
            const contentHash = hashContent(contentText);
            
            // Save embedding
            await tx.featureEmbedding.upsert({
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
            
            // Save code context to Feature model if available
            if (feature.codeContextToSave) {
              await tx.feature.update({
                where: { id: feature.id },
                data: {
                  codeContext: feature.codeContextToSave,
                },
              });
              console.error(`[Embeddings] Saved code context for feature ${feature.id} (${feature.codeContextToSave.length} characters)`);
            }
          })
        );
      });
      console.error(`[Embeddings] Successfully saved ${embeddings.length} embeddings to database`);

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
          const docContext = feature.docContext || "";
          const issueContext = feature.issueContext || "";
          const threadContext = feature.threadContext || "";
          const codeContext = feature.featureSpecificCodeContext 
            ? ` Feature-Specific Code: ${feature.featureSpecificCodeContext}`
            : (feature.codeContext ? ` Code Context: ${feature.codeContext}` : "");
          const contentText = `${feature.name}${feature.description ? `: ${feature.description}` : ""}${keywords}${docContext}${issueContext}${threadContext}${codeContext}`;
          const embedding = await createEmbedding(contentText, apiKey);
          const contentHash = hashContent(contentText);

          await saveFeatureEmbedding(feature.id, embedding, contentHash);
          
          // Save code context to Feature model if available
          if (feature.codeContextToSave) {
            await prisma.feature.update({
              where: { id: feature.id },
              data: {
                codeContext: feature.codeContextToSave,
              },
            });
            console.error(`[Embeddings] Saved code context for feature ${feature.id} (${feature.codeContextToSave.length} characters)`);
          }
          
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
  
  if (processed < featuresToEmbed.length) {
    console.error(`[Embeddings] Warning: Only processed ${processed} out of ${featuresToEmbed.length} features. Some embeddings may be missing.`);
  } else {
    console.error(`[Embeddings] Successfully computed and saved embeddings for all ${processed} features.`);
  }
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
      select: { 
        content: true,
        authorUsername: true,
      },
      orderBy: { createdAt: "asc" },
    });

    if (messages.length === 0) {
      continue; // Skip threads with no messages
    }

    // Build thread content by combining all messages with author context
    // This matches the format used in classification (server.ts line 1797-1799)
    const threadContent = messages
      .map(m => `${m.authorUsername || 'Unknown'}: ${m.content}`)
      .join('\n\n');
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
 * Get issue embedding
 */
export async function saveIssueEmbedding(
  issueNumber: number,
  embedding: Embedding,
  contentHash: string
): Promise<void> {
  const model = getEmbeddingModel();
  await prisma.issueEmbedding.upsert({
    where: { issueNumber },
    update: {
      embedding: embedding as Prisma.InputJsonValue,
      contentHash,
      model,
    },
    create: {
      issueNumber,
      embedding: embedding as Prisma.InputJsonValue,
      contentHash,
      model,
    },
  });
}

export async function getIssueEmbedding(issueNumber: number): Promise<Embedding | null> {
  const model = getEmbeddingModel();
  const result = await prisma.issueEmbedding.findUnique({
    where: { issueNumber },
    select: { embedding: true, model: true },
  });

  if (!result || result.model !== model) {
    return null;
  }

  return result.embedding as Embedding;
}

/**
 * Compute and save embeddings for all GitHub issues
 */
export async function computeAndSaveIssueEmbeddings(
  apiKey: string,
  onProgress?: (processed: number, total: number) => void
): Promise<{ computed: number; cached: number; total: number }> {
  // Get all issues with full conversation data
  const allIssues = await prisma.gitHubIssue.findMany({
    select: {
      issueNumber: true,
      issueTitle: true,
      issueBody: true,
      issueLabels: true,
      issueComments: true,
      issueAssignees: true,
      issueMilestone: true,
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
  // Build issue text including full conversation: title + body + labels + comments + assignees + milestone
  const issuesToEmbed: Array<{ issueNumber: number; issueTitle: string; issueBody: string | null; issueLabels: string[]; content: string }> = [];
  for (const issue of allIssues) {
    // Extract comment texts from JSONB array
    const comments = Array.isArray(issue.issueComments) 
      ? issue.issueComments.map((c: any) => {
          if (typeof c === 'object' && c !== null && 'body' in c) {
            return `Comment by ${c.user?.login || 'unknown'}: ${c.body}`;
          }
          return '';
        }).filter(Boolean)
      : [];
    
    const issueTextParts = [
      issue.issueTitle,
      issue.issueBody || "",
      ...issue.issueLabels.sort(),
    ];
    
    // Add comments to the content
    if (comments.length > 0) {
      issueTextParts.push("\n\n--- Comments ---");
      issueTextParts.push(...comments);
    }
    
    // Add assignees if any
    if (issue.issueAssignees && issue.issueAssignees.length > 0) {
      issueTextParts.push(`\n\nAssignees: ${issue.issueAssignees.join(', ')}`);
    }
    
    // Add milestone if any
    if (issue.issueMilestone) {
      issueTextParts.push(`\n\nMilestone: ${issue.issueMilestone}`);
    }
    
    const issueText = issueTextParts.join("\n\n");
    
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
