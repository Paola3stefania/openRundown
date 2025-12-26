/**
 * LLM-based semantic classification using embeddings
 * Uses OpenAI embeddings API to understand semantic meaning and connect related concepts
 * Includes persistent disk cache for issue embeddings to avoid redundant API calls
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { join } from "path";
import { createHash } from "crypto";
import type { GitHubIssue, DiscordMessage, ClassifiedMessage } from "./classifier.js";
import { logWarn } from "../../mcp/logger.js";
import { getConfig } from "../../config/index.js";

// Progress logging to stderr (doesn't interfere with MCP JSON-RPC on stdout)
function logProgress(message: string) {
  console.error(`[Progress] ${message}`);
}

// Embedding vector type (OpenAI returns 1536-dimensional vectors)
type Embedding = number[];

interface EmbeddingCache {
  [key: string]: Embedding;
}

// Persistent cache structure for disk storage
interface PersistentEmbeddingEntry {
  embedding: Embedding;
  contentHash: string; // Hash of issue content to detect changes
  createdAt: string;
}

interface PersistentEmbeddingCache {
  version: number;
  model: string;
  entries: { [issueNumber: string]: PersistentEmbeddingEntry };
}

const CACHE_VERSION = 1;
const EMBEDDING_MODEL = "text-embedding-3-small";

/**
 * Get the path to the embeddings cache file
 */
function getEmbeddingsCachePath(): string {
  const config = getConfig();
  const cacheDir = join(process.cwd(), config.paths.cacheDir);
  
  // Ensure cache directory exists
  if (!existsSync(cacheDir)) {
    mkdirSync(cacheDir, { recursive: true });
  }
  
  return join(cacheDir, "issue-embeddings-cache.json");
}

/**
 * Create a hash of issue content to detect changes
 */
function hashIssueContent(issue: GitHubIssue): string {
  const content = createIssueText(issue);
  return createHash("md5").update(content).digest("hex");
}

/**
 * Load persistent embedding cache from disk
 */
function loadPersistentCache(): PersistentEmbeddingCache {
  const cachePath = getEmbeddingsCachePath();
  
  if (!existsSync(cachePath)) {
    return { version: CACHE_VERSION, model: EMBEDDING_MODEL, entries: {} };
  }
  
  try {
    const data = readFileSync(cachePath, "utf-8");
    const cache = JSON.parse(data) as PersistentEmbeddingCache;
    
    // Check version and model compatibility
    if (cache.version !== CACHE_VERSION || cache.model !== EMBEDDING_MODEL) {
      logProgress("Embedding cache version/model mismatch, starting fresh");
      return { version: CACHE_VERSION, model: EMBEDDING_MODEL, entries: {} };
    }
    
    return cache;
  } catch (error) {
    logProgress("Failed to load embedding cache, starting fresh");
    return { version: CACHE_VERSION, model: EMBEDDING_MODEL, entries: {} };
  }
}

/**
 * Save persistent embedding cache to disk
 */
function savePersistentCache(cache: PersistentEmbeddingCache): void {
  const cachePath = getEmbeddingsCachePath();
  
  try {
    writeFileSync(cachePath, JSON.stringify(cache, null, 2), "utf-8");
    logProgress(`Saved ${Object.keys(cache.entries).length} issue embeddings to cache`);
  } catch (error) {
    logWarn("Failed to save embedding cache:", error);
  }
}

/**
 * Get OpenAI API key from environment
 */
function getOpenAIApiKey(): string | null {
  return process.env.OPENAI_API_KEY || null;
}

/**
 * Check if LLM-based classification is available and enabled
 */
export function isLLMClassificationAvailable(): boolean {
  return getOpenAIApiKey() !== null;
}

/**
 * Create embeddings for text using OpenAI API with retry logic
 */
export async function createEmbedding(text: string, apiKey: string, retries = 3): Promise<Embedding> {
  // Truncate text to OpenAI's limit (8191 tokens, ~6000 words)
  const maxLength = 6000;
  const truncatedText = text.length > maxLength ? text.substring(0, maxLength) : text;

  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      const response = await fetch("https://api.openai.com/v1/embeddings", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model: "text-embedding-3-small", // Cost-effective model with good performance
          input: truncatedText,
        }),
      });

      if (!response.ok) {
        let errorData: any;
        try {
          errorData = await response.json();
        } catch {
          const errorText = await response.text();
          errorData = { error: { message: errorText } };
        }
        
        // Handle rate limit errors with exponential backoff
        if (response.status === 429 && attempt < retries - 1) {
          // Check if error message contains retry-after info
          let delay = Math.pow(2, attempt) * 2000; // Exponential backoff: 2s, 4s, 8s
          
          // Try to extract retry-after from response header
          const retryAfter = response.headers.get("retry-after");
          if (retryAfter) {
            delay = parseInt(retryAfter) * 1000;
          } else if (errorData?.error?.message) {
            // Try to extract delay from error message (e.g., "Please try again in 13ms")
            const match = errorData.error.message.match(/try again in (\d+)(ms|s)/i);
            if (match) {
              const value = parseInt(match[1]);
              delay = match[2].toLowerCase() === 's' ? value * 1000 : value;
              // Add a small buffer
              delay = Math.max(delay + 1000, 2000);
            }
          }
          
          await new Promise(resolve => setTimeout(resolve, delay));
          continue;
        }
        
        throw new Error(`OpenAI API error: ${response.status} ${JSON.stringify(errorData)}`);
      }

      const data = await response.json();
      return data.data[0].embedding;
    } catch (error) {
      if (attempt === retries - 1) {
        throw error;
      }
      // Retry with exponential backoff for other errors
      const delay = Math.pow(2, attempt) * 1000;
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }
  
  throw new Error("Failed to create embedding after retries");
}

/**
 * Calculate cosine similarity between two embedding vectors
 */
function cosineSimilarity(a: Embedding, b: Embedding): number {
  if (a.length !== b.length) {
    throw new Error("Embedding vectors must have the same length");
  }

  let dotProduct = 0;
  let normA = 0;
  let normB = 0;

  for (let i = 0; i < a.length; i++) {
    dotProduct += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }

  const denominator = Math.sqrt(normA) * Math.sqrt(normB);
  if (denominator === 0) return 0;

  // Cosine similarity ranges from -1 to 1, normalize to 0-100 for consistency
  const similarity = dotProduct / denominator;
  return Math.max(0, (similarity + 1) * 50); // Convert from [-1, 1] to [0, 100]
}

/**
 * Create a combined text representation of an issue for embedding
 */
function createIssueText(issue: GitHubIssue): string {
  const parts = [
    issue.title,
    issue.body || "",
    ...issue.labels.map(label => label.name),
  ];
  return parts.join("\n\n");
}

/**
 * Match Discord message with GitHub issues using semantic embeddings
 * Note: This function is now mainly used for single-message classification.
 * For batch processing, use classifyMessagesSemantic which is more efficient.
 */
export async function matchMessageToIssuesSemantic(
  message: DiscordMessage,
  issues: GitHubIssue[],
  embeddingCache: EmbeddingCache = {}
): Promise<ClassifiedMessage> {
  const apiKey = getOpenAIApiKey();
  if (!apiKey) {
    throw new Error("OPENAI_API_KEY environment variable is required for semantic classification");
  }

  // Skip empty messages
  if (!message.content || message.content.trim().length === 0) {
    return {
      message,
      relatedIssues: [],
    };
  }

  // Create or retrieve message embedding
  const messageCacheKey = `msg:${message.id}`;
  let messageEmbedding: Embedding;
  if (embeddingCache[messageCacheKey]) {
    messageEmbedding = embeddingCache[messageCacheKey];
  } else {
    messageEmbedding = await createEmbedding(message.content, apiKey);
    embeddingCache[messageCacheKey] = messageEmbedding;
  }

  // Create embeddings for all issues and calculate similarities
  // For efficiency, issues should ideally be pre-computed, but we handle both cases
  const similarities = await Promise.all(
    issues.map(async (issue) => {
      const issueCacheKey = `issue:${issue.number}`;
      let issueEmbedding: Embedding;

      if (embeddingCache[issueCacheKey]) {
        issueEmbedding = embeddingCache[issueCacheKey];
      } else {
        const issueText = createIssueText(issue);
        issueEmbedding = await createEmbedding(issueText, apiKey);
        embeddingCache[issueCacheKey] = issueEmbedding;
      }

      const similarityScore = cosineSimilarity(messageEmbedding, issueEmbedding);

      return {
        issue,
        similarityScore,
        matchedTerms: [], // Not applicable for semantic matching
      };
    })
  );

  // Sort by similarity and return top matches
  const relatedIssues = similarities
    .sort((a, b) => b.similarityScore - a.similarityScore)
    .slice(0, 5); // Top 5 matches

  return {
    message,
    relatedIssues,
  };
}

/**
 * Pre-compute embeddings for all issues (more efficient than computing per message)
 * Uses persistent disk cache to avoid re-embedding unchanged issues
 */
async function precomputeIssueEmbeddings(
  issues: GitHubIssue[],
  apiKey: string,
  embeddingCache: EmbeddingCache
): Promise<void> {
  // Load persistent cache from disk
  const persistentCache = loadPersistentCache();
  
  // Determine which issues need new embeddings
  const issuesToEmbed: GitHubIssue[] = [];
  let cachedCount = 0;
  
  for (const issue of issues) {
    const issueKey = `issue:${issue.number}`;
    const cachedEntry = persistentCache.entries[issue.number.toString()];
    const currentHash = hashIssueContent(issue);
    
    if (cachedEntry && cachedEntry.contentHash === currentHash) {
      // Use cached embedding (content hasn't changed)
      embeddingCache[issueKey] = cachedEntry.embedding;
      cachedCount++;
    } else {
      // Need to compute new embedding
      issuesToEmbed.push(issue);
    }
  }
  
  const totalIssues = issues.length;
  logProgress(`Found ${cachedCount}/${totalIssues} issues in embedding cache, ${issuesToEmbed.length} need embedding`);
  
  if (issuesToEmbed.length === 0) {
    logProgress("All issue embeddings loaded from cache!");
    return;
  }
  
  // Process issues in smaller batches to respect rate limits
  const issueBatchSize = 10;
  const delayMs = 1000;
  let processedCount = 0;
  let cacheModified = false;

  logProgress(`Computing embeddings for ${issuesToEmbed.length} issues...`);

  for (let i = 0; i < issuesToEmbed.length; i += issueBatchSize) {
    const batch = issuesToEmbed.slice(i, i + issueBatchSize);
    
    for (const issue of batch) {
      const issueCacheKey = `issue:${issue.number}`;
      try {
        const issueText = createIssueText(issue);
        const embedding = await createEmbedding(issueText, apiKey);
        
        // Store in memory cache
        embeddingCache[issueCacheKey] = embedding;
        
        // Store in persistent cache
        persistentCache.entries[issue.number.toString()] = {
          embedding,
          contentHash: hashIssueContent(issue),
          createdAt: new Date().toISOString(),
        };
        cacheModified = true;
        
        await new Promise(resolve => setTimeout(resolve, 100));
      } catch (error) {
        if (error instanceof Error && error.message.includes("429")) {
          await new Promise(resolve => setTimeout(resolve, 5000));
          try {
            const issueText = createIssueText(issue);
            const embedding = await createEmbedding(issueText, apiKey);
            embeddingCache[issueCacheKey] = embedding;
            persistentCache.entries[issue.number.toString()] = {
              embedding,
              contentHash: hashIssueContent(issue),
              createdAt: new Date().toISOString(),
            };
            cacheModified = true;
          } catch (retryError) {
            continue;
          }
        } else {
          continue;
        }
      }
    }

    processedCount = Math.min(i + issueBatchSize, issuesToEmbed.length);
    logProgress(`Embedded ${processedCount}/${issuesToEmbed.length} new issues (${Math.round((processedCount / issuesToEmbed.length) * 100)}%)`);

    // Save cache after each batch to avoid losing progress if process breaks
    if (cacheModified) {
      savePersistentCache(persistentCache);
      cacheModified = false; // Reset flag after saving
    }

    if (i + issueBatchSize < issuesToEmbed.length) {
      await new Promise(resolve => setTimeout(resolve, delayMs));
    }
  }
  
  logProgress(`Completed: ${cachedCount} from cache + ${issuesToEmbed.length} newly embedded = ${totalIssues} total`);
}

/**
 * Classify multiple Discord messages using semantic embeddings
 * Processes messages in batches to handle rate limits efficiently
 */
export async function classifyMessagesSemantic(
  messages: DiscordMessage[],
  issues: GitHubIssue[],
  minSimilarity = 20
): Promise<ClassifiedMessage[]> {
  const apiKey = getOpenAIApiKey();
  if (!apiKey) {
    throw new Error("OPENAI_API_KEY environment variable is required for semantic classification");
  }

  // Shared embedding cache to avoid recalculating embeddings
  const embeddingCache: EmbeddingCache = {};

  // Pre-compute all issue embeddings first (more efficient)
  await precomputeIssueEmbeddings(issues, apiKey, embeddingCache);

  // Now process messages - issue embeddings are already cached
  // Process messages sequentially to avoid rate limits
  const delayMs = 200; // 200ms delay between messages

  const totalMessages = messages.length;
  let processedMessages = 0;
  logProgress(`Classifying ${totalMessages} messages...`);

  const results: ClassifiedMessage[] = [];

  for (const msg of messages) {
    try {
      // Get or create message embedding
      const messageCacheKey = `msg:${msg.id}`;
      if (!embeddingCache[messageCacheKey]) {
        embeddingCache[messageCacheKey] = await createEmbedding(msg.content, apiKey);
      }
      const messageEmbedding = embeddingCache[messageCacheKey];

      // Compare with all issue embeddings (already cached)
      const similarities = issues.map((issue) => {
        const issueCacheKey = `issue:${issue.number}`;
        const issueEmbedding = embeddingCache[issueCacheKey];
        const similarityScore = cosineSimilarity(messageEmbedding, issueEmbedding);

        return {
          issue,
          similarityScore,
          matchedTerms: [], // Not applicable for semantic matching
        };
      });

      // Sort by similarity and get top matches
      const relatedIssues = similarities
        .sort((a, b) => b.similarityScore - a.similarityScore)
        .slice(0, 5); // Top 5 matches

      results.push({
        message: msg,
        relatedIssues,
      });

      processedMessages++;
      if (processedMessages % 10 === 0 || processedMessages === totalMessages) {
        logProgress(`Classified ${processedMessages}/${totalMessages} messages (${Math.round((processedMessages / totalMessages) * 100)}%)`);
      }

      // Small delay between messages to respect rate limits
      await new Promise(resolve => setTimeout(resolve, delayMs));
    } catch (error) {
      // If rate limited, wait longer before continuing
      if (error instanceof Error && error.message.includes("429")) {
        await new Promise(resolve => setTimeout(resolve, 5000));
        // Retry this message
        try {
          const messageCacheKey = `msg:${msg.id}`;
          if (!embeddingCache[messageCacheKey]) {
            embeddingCache[messageCacheKey] = await createEmbedding(msg.content, apiKey);
          }
          const messageEmbedding = embeddingCache[messageCacheKey];

          const similarities = issues.map((issue) => {
            const issueCacheKey = `issue:${issue.number}`;
            const issueEmbedding = embeddingCache[issueCacheKey];
            const similarityScore = cosineSimilarity(messageEmbedding, issueEmbedding);

            return {
              issue,
              similarityScore,
              matchedTerms: [],
            };
          });

          const relatedIssues = similarities
            .sort((a, b) => b.similarityScore - a.similarityScore)
            .slice(0, 5);

          results.push({
            message: msg,
            relatedIssues,
          });
        } catch (retryError) {
          // Skip this message if it still fails after retry
          continue;
        }
      } else {
        // Skip this message on other errors
        continue;
      }
    }
  }

  logProgress(`Completed classifying all ${totalMessages} messages`);

  // Filter by minimum similarity
  const filteredResults = results.filter(result => {
    const filteredIssues = result.relatedIssues.filter(
      match => match.similarityScore >= minSimilarity
    );
    if (filteredIssues.length > 0) {
      result.relatedIssues = filteredIssues;
      return true;
    }
    return false;
  });

  return filteredResults;
}

