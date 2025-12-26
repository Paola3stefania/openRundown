/**
 * Feature mapper
 * Maps Discord messages and GitHub issues to product features
 */

import { log, logWarn } from "../logger.js";
import { ProductFeature, FeatureMapping } from "./types.js";
import { createEmbedding } from "../semantic-classifier.js";

// Re-export Embedding type
type Embedding = number[];

/**
 * Map classified messages/issues to product features
 */
export async function mapToFeatures(
  features: ProductFeature[],
  classifiedData: {
    classified_threads: Array<{
      thread: {
        thread_id: string;
        thread_name: string;
        message_count: number;
        first_message_url: string;
        message_ids: string[];
      };
      issues: Array<{
        number: number;
        title: string;
        url: string;
        state: string;
        similarity_score: number;
      }>;
    }>;
  },
  apiKey?: string
): Promise<FeatureMapping[]> {
  log(`Mapping ${classifiedData.classified_threads.length} threads/issues to ${features.length} features`);

  const openaiKey = apiKey || process.env.OPENAI_API_KEY;
  
  if (!openaiKey) {
    logWarn("OPENAI_API_KEY not available, using keyword-based mapping");
    return mapToFeaturesKeywordBased(features, classifiedData);
  }

  // Use semantic similarity for better mapping
  try {
    return await mapToFeaturesSemantic(features, classifiedData, openaiKey);
  } catch (error) {
    logWarn("Semantic mapping failed, falling back to keyword-based:", error);
    return mapToFeaturesKeywordBased(features, classifiedData);
  }
}

/**
 * Map using semantic similarity (LLM embeddings)
 */
async function mapToFeaturesSemantic(
  features: ProductFeature[],
  classifiedData: any,
  apiKey: string
): Promise<FeatureMapping[]> {
  // Create embeddings for features
  const featureEmbeddings = new Map<string, number[]>();
  
  for (const feature of features) {
    const featureText = `${feature.name} ${feature.description} ${feature.related_keywords.join(" ")}`;
    try {
      const embedding = await createEmbedding(featureText, apiKey);
      featureEmbeddings.set(feature.id, embedding);
    } catch (error) {
      logWarn(`Failed to create embedding for feature ${feature.id}:`, error);
    }
  }

  // Map each thread/issue to features
  const mappings = new Map<string, FeatureMapping>();

  for (const item of classifiedData.classified_threads) {
    const thread = item.thread;
    const threadText = thread.thread_name;
    
    try {
      const threadEmbedding = await createEmbedding(threadText, apiKey);
      
      // Find best matching features
      const similarities: Array<{ feature: ProductFeature; score: number }> = [];
      
      for (const feature of features) {
        const featureEmbedding = featureEmbeddings.get(feature.id);
        if (featureEmbedding) {
          const similarity = cosineSimilarity(threadEmbedding, featureEmbedding);
          if (similarity > 0.3) { // Threshold for relevance
            similarities.push({ feature, score: similarity });
          }
        }
      }
      
      // Sort by similarity and take top 3
      similarities.sort((a, b) => b.score - a.score);
      const topFeatures = similarities.slice(0, 3);
      
      // Add to mappings
      for (const { feature, score } of topFeatures) {
        if (!mappings.has(feature.id)) {
          mappings.set(feature.id, {
            feature,
            discord_threads: [],
            github_issues: [],
            total_mentions: 0,
          });
        }
        
        const mapping = mappings.get(feature.id)!;
        mapping.discord_threads.push({
          thread_id: thread.thread_id,
          thread_name: thread.thread_name,
          message_count: thread.message_count,
          first_message_url: thread.first_message_url,
          similarity_score: score * 100, // Convert to 0-100 scale
        });
        mapping.total_mentions += thread.message_count;
        
        // Also map related GitHub issues
        for (const issue of item.issues) {
          mapping.github_issues.push({
            issue_number: issue.number,
            issue_title: issue.title,
            issue_url: issue.url,
            state: issue.state as "open" | "closed",
            similarity_score: issue.similarity_score,
          });
        }
      }
    } catch (error) {
      logWarn(`Failed to map thread ${thread.thread_id}:`, error);
    }
  }

  return Array.from(mappings.values());
}

/**
 * Map using keyword matching (fallback)
 */
function mapToFeaturesKeywordBased(
  features: ProductFeature[],
  classifiedData: any
): FeatureMapping[] {
  const mappings = new Map<string, FeatureMapping>();

  for (const item of classifiedData.classified_threads) {
    const thread = item.thread;
    const threadText = thread.thread_name.toLowerCase();
    
    // Find features with matching keywords
    for (const feature of features) {
      const featureKeywords = [
        feature.name.toLowerCase(),
        ...feature.related_keywords.map(k => k.toLowerCase()),
      ];
      
      const matches = featureKeywords.filter(keyword => 
        threadText.includes(keyword)
      );
      
      if (matches.length > 0) {
        if (!mappings.has(feature.id)) {
          mappings.set(feature.id, {
            feature,
            discord_threads: [],
            github_issues: [],
            total_mentions: 0,
          });
        }
        
        const mapping = mappings.get(feature.id)!;
        mapping.discord_threads.push({
          thread_id: thread.thread_id,
          thread_name: thread.thread_name,
          message_count: thread.message_count,
          first_message_url: thread.first_message_url,
          similarity_score: (matches.length / featureKeywords.length) * 100,
        });
        mapping.total_mentions += thread.message_count;
        
        // Map related GitHub issues
        for (const issue of item.issues) {
          mapping.github_issues.push({
            issue_number: issue.number,
            issue_title: issue.title,
            issue_url: issue.url,
            state: issue.state as "open" | "closed",
            similarity_score: issue.similarity_score,
          });
        }
      }
    }
  }

  return Array.from(mappings.values());
}

/**
 * Calculate cosine similarity between two vectors
 */
function cosineSimilarity(vecA: number[], vecB: number[]): number {
  if (vecA.length !== vecB.length) {
    return 0;
  }
  
  let dotProduct = 0;
  let normA = 0;
  let normB = 0;
  
  for (let i = 0; i < vecA.length; i++) {
    dotProduct += vecA[i] * vecB[i];
    normA += vecA[i] * vecA[i];
    normB += vecB[i] * vecB[i];
  }
  
  return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
}

