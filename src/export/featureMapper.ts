/**
 * Maps groups to features using semantic similarity
 * Used during export to determine which Linear projects/issues should be created
 */

import { log } from "../mcp/logger.js";
import { createEmbedding, createEmbeddings } from "../core/classify/semantic.js";
import { getFeatureEmbedding, saveFeatureEmbedding } from "../storage/db/embeddings.js";
import type { ProductFeature } from "./types.js";
import { createHash } from "crypto";

/**
 * Hash content using MD5 (matches hashContent from embeddings.ts)
 */
function hashContent(content: string): string {
  return createHash("md5").update(content).digest("hex");
}

interface Feature {
  id: string;
  name: string;
  description?: string;
  related_keywords?: string[];
}

interface GroupingGroup {
  id: string;
  suggested_title?: string;
  github_issue?: {
    number: number;
    title: string;
    url: string;
    state: string;
    labels?: string[];
  };
  similarity?: number;
  avg_similarity?: number;
  threads?: Array<{
    thread_id: string;
    thread_name?: string;
    similarity_score: number;
    url?: string;
    author?: string;
  }>;
  signals?: Array<{
    source: string;
    id: string;
    title: string;
    url: string;
  }>;
  affects_features?: Array<{ id: string; name: string }>;
  is_cross_cutting?: boolean;
  canonical_issue?: {
    source: string;
    id: string;
    title?: string;
    url: string;
  } | null;
}

type Embedding = number[];

/**
 * Get or compute embeddings for all features (shared helper)
 * Returns a Map of feature ID to embedding
 * Always tries to use database embeddings first when database is available
 */
async function getOrComputeFeatureEmbeddings(
  features: Feature[],
  apiKey: string
): Promise<Map<string, Embedding>> {
  const featureEmbeddings = new Map<string, Embedding>();
  const featuresToEmbed: Array<{ feature: Feature; featureText: string }> = [];
  
  // Check if database is available before attempting to retrieve embeddings
  const { hasDatabaseConfig, getStorage } = await import("../storage/factory.js");
  const useDatabase = hasDatabaseConfig() && await getStorage().isAvailable();
  
  for (const feature of features) {
    // Try to get from database first (if database is available)
    let embedding: Embedding | null = null;
    if (useDatabase) {
      try {
        embedding = await getFeatureEmbedding(feature.id);
        if (embedding) {
          featureEmbeddings.set(feature.id, embedding);
          continue; // Successfully retrieved from database, skip to next feature
        }
      } catch (error) {
        // Database error - log but continue to compute on-demand
        log(`[Feature Embedding] Could not retrieve embedding for feature ${feature.id} from DB: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    
    // Need to compute embedding (either database not available or embedding not found)
    // Note: On-demand computation won't include issue context (that's only in computeAndSaveFeatureEmbeddings)
    // This is fine for now - embeddings will be recomputed with issue context when computeAndSaveFeatureEmbeddings runs
    const name = feature.name.trim();
    const separator = name.endsWith(":") ? " " : ": ";
    const keywords = (feature.related_keywords || []).length > 0 
      ? ` Keywords: ${(feature.related_keywords || []).join(", ")}` 
      : "";
    const featureText = `${name}${feature.description ? `${separator}${feature.description}` : ""}${keywords}`;
    featuresToEmbed.push({ feature, featureText });
  }
  
  // Batch compute embeddings for features that need them
  // Features are shorter than documentation (name + description + keywords), so can use larger batches
  // Target: ~50k tokens per batch (50 features × 1000 avg tokens = 50k tokens)
  if (featuresToEmbed.length > 0) {
    const batchSize = 50;
    for (let i = 0; i < featuresToEmbed.length; i += batchSize) {
      const batch = featuresToEmbed.slice(i, i + batchSize);
      
      try {
        const texts = batch.map(item => item.featureText);
        const embeddings = await createEmbeddings(texts, apiKey);
        
        for (let j = 0; j < batch.length; j++) {
          const item = batch[j];
          const embedding = embeddings[j];
          
          featureEmbeddings.set(item.feature.id, embedding);
          
          // Save to database
          try {
            const contentHash = createHash("md5").update(item.featureText).digest("hex");
            await saveFeatureEmbedding(item.feature.id, embedding, contentHash);
          } catch (error) {
            log(`Failed to save embedding for feature ${item.feature.name}: ${error instanceof Error ? error.message : String(error)}`);
          }
        }
      } catch (error) {
        // Fall back to individual processing
        log(`Batch embedding failed, falling back to individual: ${error instanceof Error ? error.message : String(error)}`);
        for (const item of batch) {
          try {
            const embedding = await createEmbedding(item.featureText, apiKey);
            featureEmbeddings.set(item.feature.id, embedding);
            
            const contentHash = createHash("md5").update(item.featureText).digest("hex");
            await saveFeatureEmbedding(item.feature.id, embedding, contentHash);
          } catch (individualError) {
            log(`Failed to create embedding for feature ${item.feature.name}: ${individualError instanceof Error ? individualError.message : String(individualError)}`);
          }
        }
      }
    }
  }
  
  return featureEmbeddings;
}

/**
 * Calculate cosine similarity between two embeddings
 */
function cosineSimilarity(a: Embedding, b: Embedding): number {
  if (a.length !== b.length) return 0;
  
  let dotProduct = 0;
  let normA = 0;
  let normB = 0;
  
  for (let i = 0; i < a.length; i++) {
    dotProduct += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  
  const denominator = Math.sqrt(normA) * Math.sqrt(normB);
  return denominator === 0 ? 0 : dotProduct / denominator;
}

/**
 * Calculate average embedding from multiple embeddings
 */
function calculateAverageEmbedding(embeddings: Embedding[]): Embedding {
  if (embeddings.length === 0) return [];
  if (embeddings.length === 1) return embeddings[0];
  
  const dim = embeddings[0].length;
  const avg = new Array(dim).fill(0);
  
  for (const emb of embeddings) {
    for (let i = 0; i < dim; i++) {
      avg[i] += emb[i];
    }
  }
  
  for (let i = 0; i < dim; i++) {
    avg[i] /= embeddings.length;
  }
  
  return avg;
}

/**
 * Map groups to features using semantic similarity
 */
export async function mapGroupsToFeatures(
  groups: GroupingGroup[],
  features: Feature[],
  minSimilarity: number = 0.6
): Promise<GroupingGroup[]> {
  if (features.length === 0) {
    log("No features provided, skipping feature mapping");
    return groups.map(g => ({
      ...g,
      affects_features: [{ id: "general", name: "General" }],
      is_cross_cutting: false,
    }));
  }

  log(`Mapping ${groups.length} groups to ${features.length} features...`);

  // Get API key
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error("OPENAI_API_KEY environment variable is required for feature mapping");
  }

  // Step 1: Get or compute embeddings for all features
  const featureEmbeddings = await getOrComputeFeatureEmbeddings(features, apiKey);
  
  // Debug: Verify embeddings were loaded
  log(`[DEBUG] Loaded ${featureEmbeddings.size} feature embeddings out of ${features.length} features`);
  if (featureEmbeddings.size < features.length) {
    const missingFeatures = features.filter(f => !featureEmbeddings.has(f.id));
    log(`[DEBUG] Missing embeddings for features: ${missingFeatures.map(f => f.name).join(", ")}`);
  }

  // Step 2: Map each group to features
  const mappedGroups: GroupingGroup[] = [];
  
  for (const group of groups) {
    // Build group text from title, GitHub issue, and thread titles
    const groupTextParts: string[] = [];
    
    if (group.suggested_title) {
      groupTextParts.push(group.suggested_title);
    }
    
    if (group.github_issue?.title) {
      groupTextParts.push(group.github_issue.title);
    }
    
    if (group.threads && group.threads.length > 0) {
      const threadTitles = group.threads
        .map(t => t.thread_name)
        .filter((name): name is string => !!name && name.trim().length > 0);
      groupTextParts.push(...threadTitles);
    }
    
    if (group.signals && group.signals.length > 0) {
      const signalTitles = group.signals
        .map(s => s.title)
        .filter((title): title is string => !!title && title.trim().length > 0);
      groupTextParts.push(...signalTitles);
    }
    
    const groupText = groupTextParts.join(" ");
    
    if (!groupText.trim()) {
      // No text to analyze, assign to general
      mappedGroups.push({
        ...group,
        affects_features: [{ id: "general", name: "General" }],
        is_cross_cutting: false,
      });
      continue;
    }
    
    // Compute group embedding
    let groupEmbedding: Embedding;
    try {
      groupEmbedding = await createEmbedding(groupText, apiKey);
    } catch (error) {
      log(`Failed to create embedding for group ${group.id}: ${error instanceof Error ? error.message : String(error)}`);
      mappedGroups.push({
        ...group,
        affects_features: [{ id: "general", name: "General" }],
        is_cross_cutting: false,
      });
      continue;
    }
    
    // Find matching features using both semantic similarity and keyword matching
    const affectedFeatures: Array<{ id: string; similarity: number; ruleBased?: boolean }> = [];
    const allSimilarities: Array<{ id: string; name: string; similarity: number }> = [];
    
    // Build searchable text from group (for keyword matching)
    const groupSearchText = groupText.toLowerCase();
    const issueTitle = group.github_issue?.title?.toLowerCase() || "";
    const issueLabelsArray = group.github_issue?.labels || [];
    const issueLabels = issueLabelsArray.map((l: string | { name: string }) => {
      if (typeof l === 'string') return l.toLowerCase();
      if (typeof l === 'object' && l !== null && 'name' in l) return l.name.toLowerCase();
      return "";
    }).filter(Boolean).join(" ");
    const allSearchText = `${groupSearchText} ${issueTitle} ${issueLabels}`.toLowerCase();
    
    for (const feature of features) {
      const featureEmb = featureEmbeddings.get(feature.id);
      let similarity = 0;
      let ruleBasedMatch = false;
      
      // Rule-based matching: Check if feature name or keywords appear in group/issue text
      const featureNameLower = feature.name.toLowerCase();
      const featureKeywords = (feature.related_keywords || []).map(k => k.toLowerCase());
      
      // Check if feature name appears in group/issue text
      if (allSearchText.includes(featureNameLower)) {
        ruleBasedMatch = true;
        similarity = 0.9; // High confidence for exact name match
        log(`[DEBUG] Group ${group.id}: Rule-based match - feature name "${feature.name}" found in group/issue text`);
      } else {
        // Check if any keywords match
        for (const keyword of featureKeywords) {
          if (keyword.length > 2 && allSearchText.includes(keyword)) {
            ruleBasedMatch = true;
            similarity = 0.8; // High confidence for keyword match
            log(`[DEBUG] Group ${group.id}: Rule-based match - keyword "${keyword}" found in group/issue text`);
            break;
          }
        }
      }
      
      // If no rule-based match, use semantic similarity
      if (!ruleBasedMatch && featureEmb) {
        similarity = cosineSimilarity(groupEmbedding, featureEmb);
        allSimilarities.push({ id: feature.id, name: feature.name, similarity });
      } else if (ruleBasedMatch) {
        // Include rule-based matches in allSimilarities for debugging
        allSimilarities.push({ id: feature.id, name: feature.name, similarity });
      } else {
        log(`[DEBUG] Group ${group.id}: Feature ${feature.id} has no embedding, skipping`);
        continue;
      }
      
      // Add to affected features if above threshold OR if rule-based match
      if (similarity >= minSimilarity || ruleBasedMatch) {
        affectedFeatures.push({ id: feature.id, similarity, ruleBased: ruleBasedMatch });
      }
    }
    
    // Debug: Show top similarities even if below threshold
    allSimilarities.sort((a, b) => b.similarity - a.similarity);
    const top5All = allSimilarities.slice(0, 5);
    log(`[DEBUG] Group ${group.id} top 5 similarities (threshold=${minSimilarity}): ${top5All.map(f => `${f.name}:${f.similarity.toFixed(3)}`).join(", ")}`);
    
    // Sort by similarity (rule-based matches first, then by score) and take top matches
    affectedFeatures.sort((a, b) => {
      // Rule-based matches first
      if (a.ruleBased && !b.ruleBased) return -1;
      if (!a.ruleBased && b.ruleBased) return 1;
      // Then by similarity score
      return b.similarity - a.similarity;
    });
    const topFeatures = affectedFeatures.slice(0, 5);
    
    // Map to feature objects
    const affectsFeatures = topFeatures.length > 0
      ? topFeatures.map(f => {
          const feature = features.find(fe => fe.id === f.id);
          return {
            id: f.id,
            name: feature?.name || f.id,
          };
        })
      : [{ id: "general", name: "General" }];
    
    // Log rule-based matches for debugging
    const ruleBasedCount = topFeatures.filter(f => f.ruleBased).length;
    if (ruleBasedCount > 0) {
      log(`[DEBUG] Group ${group.id}: ${ruleBasedCount} rule-based match(es) found`);
    }
    
    // Debug logging
    if (topFeatures.length === 0) {
      log(`[DEBUG] Group ${group.id} matched to General (no features above threshold ${minSimilarity})`);
    } else {
      const ruleBasedMatches = topFeatures.filter(f => f.ruleBased).map(f => f.id);
      const semanticMatches = topFeatures.filter(f => !f.ruleBased).map(f => f.id);
      log(`[DEBUG] Group ${group.id} matched to ${affectsFeatures.length} features: ${affectsFeatures.map(f => f.name).join(", ")}`);
      if (ruleBasedMatches.length > 0) {
        log(`[DEBUG] Group ${group.id} rule-based matches: ${ruleBasedMatches.join(", ")}`);
      }
      log(`[DEBUG] Group ${group.id} top similarities: ${topFeatures.map(f => `${f.id}:${f.similarity.toFixed(3)}${f.ruleBased ? " (rule-based)" : ""}`).join(", ")}`);
    }
    
    mappedGroups.push({
      ...group,
      affects_features: affectsFeatures,
      is_cross_cutting: affectsFeatures.length > 1,
    });
  }
  
  log(`Mapped ${groups.length} groups to features. ${mappedGroups.filter(g => g.is_cross_cutting).length} cross-cutting groups.`);
  
  // Debug: Log summary of matches
  const groupsWithMatches = mappedGroups.filter(g => 
    g.affects_features && g.affects_features.length > 0 && 
    !(g.affects_features.length === 1 && g.affects_features[0].id === "general")
  );
  log(`[DEBUG] ${groupsWithMatches.length} out of ${mappedGroups.length} groups matched to specific features (not General)`);
  
  return mappedGroups;
}

/**
 * Map ungrouped threads to features using semantic similarity
 */
export async function mapUngroupedThreadsToFeatures(
  ungroupedThreads: Array<{
    thread_id: string;
    channel_id?: string;
    thread_name?: string;
    url?: string;
    author?: string;
    timestamp?: string;
    reason: "no_matches" | "below_threshold";
    top_issue?: {
      number: number;
      title: string;
      similarity_score: number;
    };
  }>,
  features: Feature[],
  minSimilarity: number = 0.6
): Promise<Array<{
  thread_id: string;
  channel_id?: string;
  thread_name?: string;
  url?: string;
  author?: string;
  timestamp?: string;
  reason: "no_matches" | "below_threshold";
  top_issue?: {
    number: number;
    title: string;
    similarity_score: number;
  };
  affects_features?: Array<{ id: string; name: string }>;
}>> {
  if (features.length === 0 || ungroupedThreads.length === 0) {
    return ungroupedThreads.map(thread => ({
      ...thread,
      affects_features: [{ id: "general", name: "General" }],
    }));
  }

  log(`Mapping ${ungroupedThreads.length} ungrouped threads to ${features.length} features...`);

  // Get API key
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    log("OPENAI_API_KEY not set, assigning all ungrouped threads to General");
    return ungroupedThreads.map(thread => ({
      ...thread,
      affects_features: [{ id: "general", name: "General" }],
    }));
  }

  // Step 1: Get or compute embeddings for all features
  const featureEmbeddings = await getOrComputeFeatureEmbeddings(features, apiKey);

  // Step 2: Get thread embeddings from database (if available)
  const { getThreadEmbedding, saveThreadEmbedding } = await import("../storage/db/embeddings.js");
  const { hasDatabaseConfig, getStorage } = await import("../storage/factory.js");
  const useDatabase = hasDatabaseConfig() && await getStorage().isAvailable();

  // Step 3: Map ungrouped threads to features in batches of 100
  const mappedThreads: Array<{
    thread_id: string;
    thread_name?: string;
    url?: string;
    author?: string;
    timestamp?: string;
    reason: "no_matches" | "below_threshold";
    top_issue?: {
      number: number;
      title: string;
      similarity_score: number;
    };
    affects_features?: Array<{ id: string; name: string }>;
  }> = [];
  
  const batchSize = 100;
  const totalBatches = Math.ceil(ungroupedThreads.length / batchSize);
  
  for (let batchIndex = 0; batchIndex < totalBatches; batchIndex++) {
    const batchStart = batchIndex * batchSize;
    const batchEnd = Math.min(batchStart + batchSize, ungroupedThreads.length);
    const batch = ungroupedThreads.slice(batchStart, batchEnd);
    
    log(`Processing batch ${batchIndex + 1}/${totalBatches} (${batch.length} threads)...`);
    
    // Prepare batch data: build thread texts and try to get embeddings from database
    const threadData: Array<{
      thread: typeof ungroupedThreads[0];
      threadText: string;
      embedding: Embedding | null;
    }> = [];
    
    for (const thread of batch) {
      // Build thread text from thread name and top issue (if available)
      const threadTextParts: string[] = [];
      
      if (thread.thread_name) {
        threadTextParts.push(thread.thread_name);
      }
      
      if (thread.top_issue?.title) {
        threadTextParts.push(thread.top_issue.title);
      }
      
      const threadText = threadTextParts.join(" ");
      
      if (!threadText.trim()) {
        // No text to analyze, assign to general immediately
        mappedThreads.push({
          ...thread,
          affects_features: [{ id: "general", name: "General" }],
        });
        continue;
      }
      
      // Try to get thread embedding from database first
      let threadEmbedding: Embedding | null = null;
      if (useDatabase) {
        try {
          threadEmbedding = await getThreadEmbedding(thread.thread_id);
        } catch (error) {
          // Thread embedding not found, will compute in batch
        }
      }
      
      threadData.push({
        thread,
        threadText,
        embedding: threadEmbedding,
      });
    }
    
    // Batch compute embeddings for threads that don't have them
    const threadsToEmbed: Array<{ index: number; threadText: string; threadId: string }> = [];
    threadData.forEach((data, index) => {
      if (!data.embedding) {
        threadsToEmbed.push({
          index,
          threadText: data.threadText,
          threadId: data.thread.thread_id,
        });
      }
    });
    
    if (threadsToEmbed.length > 0) {
      try {
        // Batch compute embeddings
        const texts = threadsToEmbed.map(t => t.threadText);
        const embeddings = await createEmbeddings(texts, apiKey);
        
        // Store embeddings and save to database
        for (let i = 0; i < threadsToEmbed.length; i++) {
          const item = threadsToEmbed[i];
          const embedding = embeddings[i];
          
          // Update the threadData with the computed embedding
          threadData[item.index].embedding = embedding;
          
          // Save to database if available
          if (useDatabase) {
            try {
              const contentHash = createHash("md5").update(item.threadText).digest("hex");
              await saveThreadEmbedding(item.threadId, embedding, contentHash);
            } catch (error) {
              log(`Failed to save embedding for thread ${item.threadId}: ${error instanceof Error ? error.message : String(error)}`);
            }
          }
        }
      } catch (error) {
        // Fall back to individual processing for this batch
        log(`Batch embedding failed for batch ${batchIndex + 1}, falling back to individual: ${error instanceof Error ? error.message : String(error)}`);
        for (const item of threadsToEmbed) {
          try {
            const embedding = await createEmbedding(item.threadText, apiKey);
            threadData[item.index].embedding = embedding;
            
            if (useDatabase) {
              try {
                const contentHash = createHash("md5").update(item.threadText).digest("hex");
                await saveThreadEmbedding(item.threadId, embedding, contentHash);
              } catch (saveError) {
                log(`Failed to save embedding for thread ${item.threadId}: ${saveError instanceof Error ? saveError.message : String(saveError)}`);
              }
            }
          } catch (individualError) {
            log(`Failed to create embedding for thread ${item.threadId}: ${individualError instanceof Error ? individualError.message : String(individualError)}`);
            // Mark as failed - will assign to general
            threadData[item.index].embedding = null;
          }
        }
      }
    }
    
    // Now match all threads in batch to features
    for (const data of threadData) {
      if (!data.embedding) {
        // Failed to get or compute embedding, assign to general
        mappedThreads.push({
          ...data.thread,
          affects_features: [{ id: "general", name: "General" }],
        });
        continue;
      }
      
      // Find matching features
      const affectedFeatures: Array<{ id: string; similarity: number }> = [];
      
      for (const feature of features) {
        const featureEmb = featureEmbeddings.get(feature.id);
        if (!featureEmb) continue;
        
        const similarity = cosineSimilarity(data.embedding, featureEmb);
        
        if (similarity >= minSimilarity) {
          affectedFeatures.push({ id: feature.id, similarity });
        }
      }
      
      // Sort by similarity and take top matches
      affectedFeatures.sort((a, b) => b.similarity - a.similarity);
      const topFeatures = affectedFeatures.slice(0, 5);
      
      // Map to feature objects
      const affectsFeatures = topFeatures.length > 0
        ? topFeatures.map(f => {
            const feature = features.find(fe => fe.id === f.id);
            return {
              id: f.id,
              name: feature?.name || f.id,
            };
          })
        : [{ id: "general", name: "General" }];
      
      mappedThreads.push({
        ...data.thread,
        affects_features: affectsFeatures,
      });
    }
  }
  
  log(`Mapped ${ungroupedThreads.length} ungrouped threads to features. ${mappedThreads.filter(t => t.affects_features && t.affects_features.length > 1).length} matched multiple features.`);
  
  return mappedThreads;
}

/**
 * Map ungrouped issues to features using semantic similarity
 */
export async function mapUngroupedIssuesToFeatures(
  ungroupedIssues: Array<{
    issue_number: number;
    issue_title: string;
    issue_url?: string;
    issue_state?: string;
    issue_body?: string;
    issue_labels?: string[];
    issue_author?: string;
  }>,
  features: Feature[],
  minSimilarity: number = 0.6
): Promise<Array<{
  issue_number: number;
  issue_title: string;
  issue_url?: string;
  issue_state?: string;
  issue_body?: string;
  issue_labels?: string[];
  issue_author?: string;
  affects_features?: Array<{ id: string; name: string }>;
}>> {
  if (features.length === 0 || ungroupedIssues.length === 0) {
    return ungroupedIssues.map(issue => ({
      ...issue,
      affects_features: [{ id: "general", name: "General" }],
    }));
  }

  log(`Mapping ${ungroupedIssues.length} ungrouped issues to ${features.length} features...`);

  // Get API key
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    log("OPENAI_API_KEY not set, assigning all ungrouped issues to General");
    return ungroupedIssues.map(issue => ({
      ...issue,
      affects_features: [{ id: "general", name: "General" }],
    }));
  }

  // Step 1: Get or compute embeddings for all features
  const featureEmbeddings = await getOrComputeFeatureEmbeddings(features, apiKey);

  // Step 2: Get issue embeddings from database (if available)
  const { getIssueEmbedding, saveIssueEmbedding } = await import("../storage/db/embeddings.js");
  const { hasDatabaseConfig, getStorage } = await import("../storage/factory.js");
  const useDatabase = hasDatabaseConfig() && await getStorage().isAvailable();

  // Step 3: Map ungrouped issues to features in batches of 100
  const mappedIssues: Array<{
    issue_number: number;
    issue_title: string;
    issue_url?: string;
    issue_state?: string;
    issue_body?: string;
    issue_labels?: string[];
    issue_author?: string;
    affects_features?: Array<{ id: string; name: string }>;
  }> = [];
  
  const batchSize = 100;
  const totalBatches = Math.ceil(ungroupedIssues.length / batchSize);
  
  for (let batchIndex = 0; batchIndex < totalBatches; batchIndex++) {
    const batchStart = batchIndex * batchSize;
    const batchEnd = Math.min(batchStart + batchSize, ungroupedIssues.length);
    const batch = ungroupedIssues.slice(batchStart, batchEnd);
    
    log(`Processing batch ${batchIndex + 1}/${totalBatches} (${batch.length} issues)...`);
    
    // Prepare batch data: build issue texts and try to get embeddings from database
    const issueData: Array<{
      issue: typeof ungroupedIssues[0];
      issueText: string;
      embedding: Embedding | null;
    }> = [];
    
    for (const issue of batch) {
      // Build issue text in same format as computeAndSaveIssueEmbeddings: title + body + labels
      const issueTextParts: string[] = [];
      
      if (issue.issue_title) {
        issueTextParts.push(issue.issue_title);
      }
      
      if (issue.issue_body) {
        issueTextParts.push(issue.issue_body);
      }
      
      // Add labels if available (sorted for consistency with computeAndSaveIssueEmbeddings)
      if (issue.issue_labels && issue.issue_labels.length > 0) {
        issueTextParts.push(...issue.issue_labels.sort());
      }
      
      const issueText = issueTextParts.join("\n\n");
      
      if (!issueText.trim()) {
        // No text to analyze, assign to general immediately
        mappedIssues.push({
          ...issue,
          affects_features: [{ id: "general", name: "General" }],
        });
        continue;
      }
      
      // Try to get issue embedding from database first
      let issueEmbedding: Embedding | null = null;
      if (useDatabase) {
        try {
          issueEmbedding = await getIssueEmbedding(issue.issue_number);
        } catch (error) {
          // Issue embedding not found, will compute in batch
        }
      }
      
      issueData.push({
        issue,
        issueText,
        embedding: issueEmbedding,
      });
    }
    
    // Batch compute embeddings for issues that don't have them
    const issuesToEmbed: Array<{ index: number; issueText: string; issueNumber: number }> = [];
    issueData.forEach((data, index) => {
      if (!data.embedding) {
        issuesToEmbed.push({
          index,
          issueText: data.issueText,
          issueNumber: data.issue.issue_number,
        });
      }
    });
    
    if (issuesToEmbed.length > 0) {
      try {
        // Batch compute embeddings
        const texts = issuesToEmbed.map(i => i.issueText);
        const embeddings = await createEmbeddings(texts, apiKey);
        
        // Store embeddings and save to database
        for (let i = 0; i < issuesToEmbed.length; i++) {
          const item = issuesToEmbed[i];
          const embedding = embeddings[i];
          
          // Update the issueData with the computed embedding
          issueData[item.index].embedding = embedding;
          
          // Save to database if available
          if (useDatabase) {
            try {
              const contentHash = hashContent(item.issueText);
              await saveIssueEmbedding(item.issueNumber, embedding, contentHash);
            } catch (error) {
              log(`Failed to save embedding for issue ${item.issueNumber}: ${error instanceof Error ? error.message : String(error)}`);
            }
          }
        }
      } catch (error) {
        // Fall back to individual processing for this batch
        log(`Batch embedding failed for batch ${batchIndex + 1}, falling back to individual: ${error instanceof Error ? error.message : String(error)}`);
        for (const item of issuesToEmbed) {
          try {
            const embedding = await createEmbedding(item.issueText, apiKey);
            issueData[item.index].embedding = embedding;
            
            if (useDatabase) {
              try {
                const contentHash = hashContent(item.issueText);
                await saveIssueEmbedding(item.issueNumber, embedding, contentHash);
              } catch (saveError) {
                log(`Failed to save embedding for issue ${item.issueNumber}: ${saveError instanceof Error ? saveError.message : String(saveError)}`);
              }
            }
          } catch (individualError) {
            log(`Failed to create embedding for issue ${item.issueNumber}: ${individualError instanceof Error ? individualError.message : String(individualError)}`);
            // Mark as failed - will assign to general
            issueData[item.index].embedding = null;
          }
        }
      }
    }
    
    // Now match all issues in batch to features
    for (const data of issueData) {
      if (!data.embedding) {
        // Failed to get or compute embedding, assign to general
        mappedIssues.push({
          ...data.issue,
          affects_features: [{ id: "general", name: "General" }],
        });
        continue;
      }
      
      // Find matching features
      const affectedFeatures: Array<{ id: string; similarity: number }> = [];
      
      for (const feature of features) {
        const featureEmb = featureEmbeddings.get(feature.id);
        if (!featureEmb) continue;
        
        const similarity = cosineSimilarity(data.embedding, featureEmb);
        
        if (similarity >= minSimilarity) {
          affectedFeatures.push({ id: feature.id, similarity });
        }
      }
      
      // Sort by similarity and take top matches
      affectedFeatures.sort((a, b) => b.similarity - a.similarity);
      const topFeatures = affectedFeatures.slice(0, 5);
      
      // Map to feature objects
      const affectsFeatures = topFeatures.length > 0
        ? topFeatures.map(f => {
            const feature = features.find(fe => fe.id === f.id);
            return {
              id: f.id,
              name: feature?.name || f.id,
            };
          })
        : [{ id: "general", name: "General" }];
      
      mappedIssues.push({
        ...data.issue,
        affects_features: affectsFeatures,
      });
    }
  }
  
  log(`Mapped ${ungroupedIssues.length} ungrouped issues to features. ${mappedIssues.filter(i => i.affects_features && i.affects_features.length > 1).length} matched multiple features.`);
  
  return mappedIssues;
}

/**
 * Map classified data to features (legacy function for workflow.ts)
 * @deprecated This function is kept for backward compatibility but may not be fully implemented
 */
export async function mapToFeatures(
  features: Feature[],
  classifiedData: unknown
): Promise<unknown[]> {
  // TODO: Implement this function if needed
  // For now, return empty array to avoid breaking the build
  log("mapToFeatures is deprecated and not fully implemented");
  return [];
}
