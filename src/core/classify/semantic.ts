/**
 * LLM-based semantic classification using embeddings
 * Uses OpenAI embeddings API to understand semantic meaning and connect related concepts
 */

import type { GitHubIssue, DiscordMessage, ClassifiedMessage } from "./classifier.js";
import { logWarn } from "../../mcp/logger.js";

// Progress logging to stderr (doesn't interfere with MCP JSON-RPC on stdout)
function logProgress(message: string) {
  console.error(`[Progress] ${message}`);
}

// Embedding vector type (OpenAI returns 1536-dimensional vectors)
type Embedding = number[];

interface EmbeddingCache {
  [key: string]: Embedding;
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
 */
async function precomputeIssueEmbeddings(
  issues: GitHubIssue[],
  apiKey: string,
  embeddingCache: EmbeddingCache
): Promise<void> {
  // Process issues in smaller batches to respect rate limits
  // OpenAI TPM (tokens per minute) limits require careful pacing
  const issueBatchSize = 10; // Process 10 issues at a time to avoid TPM limits
  const delayMs = 1000; // 1 second delay between batches to respect TPM limits

  const totalIssues = issues.length;
  let processedCount = 0;
  logProgress(`Pre-computing embeddings for ${totalIssues} issues...`);

  for (let i = 0; i < issues.length; i += issueBatchSize) {
    const batch = issues.slice(i, i + issueBatchSize);
    
    // Compute embeddings for this batch of issues sequentially to avoid overwhelming the API
    for (const issue of batch) {
      const issueCacheKey = `issue:${issue.number}`;
      if (!embeddingCache[issueCacheKey]) {
        try {
          const issueText = createIssueText(issue);
          embeddingCache[issueCacheKey] = await createEmbedding(issueText, apiKey);
          // Small delay between individual requests to respect rate limits
          await new Promise(resolve => setTimeout(resolve, 100));
        } catch (error) {
          // If rate limited, wait longer before continuing
          if (error instanceof Error && error.message.includes("429")) {
            await new Promise(resolve => setTimeout(resolve, 5000));
            // Retry this issue
            try {
              const issueText = createIssueText(issue);
              embeddingCache[issueCacheKey] = await createEmbedding(issueText, apiKey);
            } catch (retryError) {
              // Skip this issue if it still fails after retry
              continue;
            }
          } else {
            // Skip this issue on other errors
            continue;
          }
        }
      }
    }

    processedCount = Math.min(i + issueBatchSize, totalIssues);
    logProgress(`Processed ${processedCount}/${totalIssues} issue embeddings (${Math.round((processedCount / totalIssues) * 100)}%)`);

    // Delay between batches to respect rate limits
    if (i + issueBatchSize < issues.length) {
      await new Promise(resolve => setTimeout(resolve, delayMs));
    }
  }
  logProgress(`Completed pre-computing all ${totalIssues} issue embeddings`);
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

