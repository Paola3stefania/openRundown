/**
 * Maps groups to features using semantic similarity
 * Used during export to determine which Linear projects/issues should be created
 */

import { log } from "../mcp/logger.js";
import { createEmbedding, createEmbeddings } from "../core/classify/semantic.js";
import { getFeatureEmbedding, saveFeatureEmbedding, getGroupEmbedding, saveGroupEmbedding } from "../storage/db/embeddings.js";
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
  log(`[FeatureMapper] Getting/computing embeddings for ${features.length} features...`);
  const featureEmbeddings = await getOrComputeFeatureEmbeddings(features, apiKey);
  
  // Debug: Verify embeddings were loaded
  log(`[FeatureMapper] Loaded ${featureEmbeddings.size} feature embeddings out of ${features.length} features`);
  if (featureEmbeddings.size < features.length) {
    const missingFeatures = features.filter(f => !featureEmbeddings.has(f.id));
    log(`[FeatureMapper] WARNING: Missing embeddings for ${missingFeatures.length} features: ${missingFeatures.map(f => f.name).join(", ")}`);
    log(`[FeatureMapper] These features will only match via rule-based or code-based matching, not semantic similarity`);
  } else {
    log(`[FeatureMapper] All ${features.length} features have embeddings - semantic similarity matching available`);
  }

  // Step 2: Pre-load code search and feature mappings ONCE (not per group)
  // This avoids reloading the same code search for every group
  let sharedCodeToFeatureMappings: Map<string, number> = new Map();
  const { getConfig } = await import("../config/index.js");
  const config = getConfig();
  const repositoryUrl = config.pmIntegration?.github_repo_url;
  
  // Load code search once if repository is configured
  if (repositoryUrl && groups.length > 0) {
    try {
      const { matchTextToFeaturesUsingCode } = await import("../storage/db/codeIndexer.js");
      // Use a generic query to load the code search once
      // Since code is already indexed, this will reuse existing indexed code
      const firstGroupText = groups[0].suggested_title || groups[0].github_issue?.title || "";
      if (firstGroupText) {
        const codeResult = await matchTextToFeaturesUsingCode(
          firstGroupText, // Just to trigger loading - will reuse existing code
          repositoryUrl,
          features
        );
        sharedCodeToFeatureMappings = codeResult.featureSimilarities;
        log(`[FeatureMapper] Pre-loaded code search: ${sharedCodeToFeatureMappings.size} feature mappings available for reuse`);
      }
    } catch (error) {
      log(`[FeatureMapper] Failed to pre-load code search (will load per-group): ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  
  // Step 3: Map each group to features
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
    
    // Reuse pre-loaded code-to-feature mappings (loaded once before the loop)
    // This avoids calling matchTextToFeaturesUsingCode for every group
    const codeToFeatureMappings = sharedCodeToFeatureMappings;
    
    // Compute group embedding (code context is handled via feature mappings, not included in text)
    const groupTextWithCode = groupText;
    
    // Try to get group embedding from database first (lazy loading)
    // Only reuse if content hasn't changed (check contentHash)
    const { hasDatabaseConfig, getStorage } = await import("../storage/factory.js");
    const useDatabase = hasDatabaseConfig() && await getStorage().isAvailable();
    
    // Compute contentHash for current content
    const contentHash = createHash("md5").update(groupTextWithCode).digest("hex");
    
    let groupEmbedding: Embedding | null = null;
    if (useDatabase) {
      try {
        // Check database with contentHash validation - only reuse if unchanged
        groupEmbedding = await getGroupEmbedding(group.id, contentHash);
        if (groupEmbedding) {
          log(`[FeatureMapper] Reused group embedding from database for group ${group.id} (content unchanged)`);
        } else {
          log(`[FeatureMapper] Group embedding not found or content changed for group ${group.id}, will compute`);
        }
      } catch (error) {
        // Group embedding not found, will compute below
        log(`[FeatureMapper] Group embedding not found in database for group ${group.id}, will compute`);
      }
    }
    
    // Compute embedding if not found in database or content changed
    if (!groupEmbedding) {
      try {
        log(`[FeatureMapper] Computing group embedding for group ${group.id} (text length: ${groupTextWithCode.length} chars)...`);
        groupEmbedding = await createEmbedding(groupTextWithCode, apiKey);
        log(`[FeatureMapper] Successfully computed group embedding for group ${group.id} (${groupEmbedding.length} dimensions)`);
        
        // Save to database if available
        if (useDatabase && groupEmbedding) {
          try {
            await saveGroupEmbedding(group.id, groupEmbedding, contentHash);
            log(`[FeatureMapper] Saved group embedding to database for group ${group.id}`);
          } catch (saveError) {
            log(`[FeatureMapper] Failed to save group embedding for group ${group.id}: ${saveError instanceof Error ? saveError.message : String(saveError)}`);
          }
        }
      } catch (error) {
        log(`[FeatureMapper] WARNING: Failed to create embedding for group ${group.id}: ${error instanceof Error ? error.message : String(error)}`);
        log(`[FeatureMapper] Will still attempt rule-based and code-based matching (no semantic similarity available)`);
        // Set to null - we'll still try rule-based and code-based matching below
        groupEmbedding = null;
      }
    } else {
      log(`[FeatureMapper] Reused group embedding from database for group ${group.id}`);
    }
    
    // Find matching features using semantic similarity, keyword matching, AND code-to-feature mappings
    // Even if embedding failed, we can still use rule-based and code-based matching
    const affectedFeatures: Array<{ id: string; similarity: number; ruleBased?: boolean; codeBased?: boolean }> = [];
    const allSimilarities: Array<{ id: string; name: string; similarity: number }> = [];
    
    // Build searchable text from group (for keyword matching)
    const groupSearchText = groupText.toLowerCase();
    const issueTitle = group.github_issue?.title?.toLowerCase() || "";
    const issueLabelsArray = group.github_issue?.labels || [];
    const issueLabelsNormalized = issueLabelsArray.map((l: string | { name: string }) => {
      if (typeof l === 'string') return l.toLowerCase().trim();
      if (typeof l === 'object' && l !== null && 'name' in l) return l.name.toLowerCase().trim();
      return "";
    }).filter(Boolean);
    const issueLabels = issueLabelsNormalized.join(" ");
    const allSearchText = `${groupSearchText} ${issueTitle} ${issueLabels}`.toLowerCase();
    
    for (const feature of features) {
      const featureEmb = featureEmbeddings.get(feature.id);
      let similarity = 0;
      let ruleBasedMatch = false;
      
      // Rule-based matching: Check if feature name or keywords appear in group/issue text
      const featureNameLower = feature.name.toLowerCase().trim();
      // Normalize feature name for matching (remove common prefixes/suffixes)
      const featureNameNormalized = featureNameLower
        .replace(/^feature[:\s]+/i, "")
        .replace(/[:\s]+$/, "")
        .trim();
      const featureKeywords = (feature.related_keywords || []).map(k => k.toLowerCase().trim());
      
      // Step 1: Check GitHub labels for direct feature name matching (ADDITIONAL signal)
      // If any GitHub label exactly matches or contains a feature name, boost similarity
      let labelBasedMatch = false;
      let labelSimilarity = 0;
      for (const label of issueLabelsNormalized) {
        const labelNormalized = label
          .replace(/^feature[:\s]+/i, "")
          .replace(/[:\s]+$/, "")
          .trim();
        
        // Direct exact match (e.g., "social" label matches "social" feature)
        if (labelNormalized === featureNameNormalized || label === featureNameLower) {
          labelBasedMatch = true;
          labelSimilarity = 0.95; // Very high confidence for direct label match
          log(`[DEBUG] Group ${group.id}: Label-based match - GitHub label "${label}" directly matches feature "${feature.name}"`);
          break;
        }
        
        // Partial match: Check if label contains feature name as a word (e.g., "social provider" contains "social")
        // Split label into words and check if any word matches the feature name
        const labelWords = labelNormalized.split(/[\s\-_]+/);
        if (labelWords.includes(featureNameNormalized) || labelWords.includes(featureNameLower)) {
          labelBasedMatch = true;
          labelSimilarity = 0.92; // High confidence for partial label match (slightly lower than exact)
          log(`[DEBUG] Group ${group.id}: Label-based match - GitHub label "${label}" contains feature name "${feature.name}"`);
          break;
        }
        
        // Also check if label contains feature name as substring (for cases like "social-provider" or "social_provider")
        if (labelNormalized.includes(featureNameNormalized) || label.includes(featureNameLower)) {
          // Only match if feature name is at least 3 characters (avoid false matches like "a" in "label")
          if (featureNameNormalized.length >= 3) {
            labelBasedMatch = true;
            labelSimilarity = 0.90; // High confidence for substring match
            log(`[DEBUG] Group ${group.id}: Label-based match - GitHub label "${label}" contains feature name "${feature.name}" as substring`);
            break;
          }
        }
        
        // Check if label matches any feature keywords
        for (const keyword of featureKeywords) {
          const keywordNormalized = keyword
            .replace(/^feature[:\s]+/i, "")
            .replace(/[:\s]+$/, "")
            .trim();
          if (labelNormalized === keywordNormalized || label === keyword) {
            labelBasedMatch = true;
            labelSimilarity = 0.9; // High confidence for label-keyword match
            log(`[DEBUG] Group ${group.id}: Label-based match - GitHub label "${label}" matches feature keyword "${keyword}" for feature "${feature.name}"`);
            break;
          }
          // Also check if label contains keyword as word
          const keywordWords = labelNormalized.split(/[\s\-_]+/);
          if (keywordWords.includes(keywordNormalized) || keywordWords.includes(keyword)) {
            labelBasedMatch = true;
            labelSimilarity = 0.88; // Good confidence for keyword-in-label match
            log(`[DEBUG] Group ${group.id}: Label-based match - GitHub label "${label}" contains feature keyword "${keyword}" for feature "${feature.name}"`);
            break;
          }
        }
        if (labelBasedMatch) break;
      }
      
      // Step 2: Rule-based matching - Check if feature name appears in group/issue text
      if (allSearchText.includes(featureNameLower)) {
        ruleBasedMatch = true;
        if (labelSimilarity === 0) {
          similarity = 0.9; // High confidence for exact name match
        }
        log(`[DEBUG] Group ${group.id}: Rule-based match - feature name "${feature.name}" found in group/issue text`);
      } else {
        // Check if any keywords match
        for (const keyword of featureKeywords) {
          if (keyword.length > 2 && allSearchText.includes(keyword)) {
            ruleBasedMatch = true;
            if (labelSimilarity === 0) {
              similarity = 0.8; // High confidence for keyword match
            }
            log(`[DEBUG] Group ${group.id}: Rule-based match - keyword "${keyword}" found in group/issue text`);
            break;
          }
        }
      }
      
      // Step 3: Semantic similarity (always check, combine with label/rule-based if present)
      let semanticSimilarity = 0;
      if (featureEmb && groupEmbedding) {
        semanticSimilarity = cosineSimilarity(groupEmbedding, featureEmb);
        allSimilarities.push({ id: feature.id, name: feature.name, similarity: semanticSimilarity });
      } else {
        if (!groupEmbedding) {
          log(`[DEBUG] Group ${group.id}: No group embedding available, skipping semantic similarity`);
        } else {
          log(`[DEBUG] Group ${group.id}: Feature ${feature.id} has no embedding, skipping semantic similarity`);
        }
      }
      
      // Step 4: Code-based matching (ADDITIONAL signal)
      let codeBasedMatch = false;
      let codeSimilarity = 0;
      if (codeToFeatureMappings.has(feature.id)) {
        codeBasedMatch = true;
        codeSimilarity = codeToFeatureMappings.get(feature.id) || 0;
        log(`[DEBUG] Group ${group.id}: Code-based match - feature "${feature.name}" has similarity ${codeSimilarity.toFixed(3)} from code`);
      }
      
      // Step 5: Combine all signals (label-based, rule-based, semantic, code-based)
      // Priority: label > code > semantic > rule-based text matching
      if (labelSimilarity > 0) {
        // Label match is strongest - use it as base, boost with others
        similarity = labelSimilarity;
        if (codeSimilarity > 0.5) {
          similarity = Math.max(similarity, codeSimilarity * 0.95); // Code can boost label match slightly
        }
        if (semanticSimilarity > 0.7) {
          similarity = Math.max(similarity, semanticSimilarity * 0.95); // High semantic similarity can boost
        }
      } else if (codeSimilarity > 0.5) {
        // Code match is second strongest
        similarity = codeSimilarity * 0.9;
        if (semanticSimilarity > 0) {
          similarity = Math.max(similarity, semanticSimilarity); // Use higher of code or semantic
        }
        if (ruleBasedMatch && similarity < 0.8) {
          similarity = 0.8; // Rule-based match boosts minimum to 0.8
        }
      } else if (semanticSimilarity > 0) {
        // Semantic similarity as base
        similarity = semanticSimilarity;
        if (ruleBasedMatch && similarity < 0.7) {
          similarity = 0.7; // Rule-based match boosts minimum to 0.7
        }
      } else if (ruleBasedMatch) {
        // Rule-based match only (already set above)
        allSimilarities.push({ id: feature.id, name: feature.name, similarity });
      }
      
      // Include rule-based flag if label or text matching found
      if (labelBasedMatch) {
        ruleBasedMatch = true;
      }
      
      // Add to affected features if above threshold OR if rule-based match OR if strong code match
      // This allows matching even when embeddings fail, as long as rule-based or code-based matching works
      if (similarity >= minSimilarity || ruleBasedMatch || (codeBasedMatch && codeSimilarity > 0.6)) {
        affectedFeatures.push({ 
          id: feature.id, 
          similarity, 
          ruleBased: ruleBasedMatch,
          codeBased: codeBasedMatch 
        });
      }
    }
    
    // Debug: Show top similarities even if below threshold
    allSimilarities.sort((a, b) => b.similarity - a.similarity);
    const top5All = allSimilarities.slice(0, 5);
    const maxSimilarity = allSimilarities.length > 0 ? allSimilarities[0].similarity : 0;
    const secondBestSimilarity = allSimilarities.length > 1 ? allSimilarities[1].similarity : 0;
    const similarityGap = maxSimilarity - secondBestSimilarity;
    
    log(`[FeatureMapper] Group ${group.id} top 5 similarities (threshold=${minSimilarity}, max=${maxSimilarity.toFixed(3)}): ${top5All.map(f => `${f.name}:${f.similarity.toFixed(3)}`).join(", ")}`);
    
    // Smart matching: If no features matched via strict threshold, use relative ranking
    // Accept matches if:
    // 1. Max similarity >= 0.4 AND there's a clear winner (gap >= 0.1) - indicates a strong relative match
    // 2. Max similarity >= 0.5 - moderate confidence threshold
    // 3. Rule-based or code-based matches (already handled above)
    if (affectedFeatures.length === 0 && maxSimilarity > 0) {
      const relaxedThreshold = 0.4; // Lower threshold for relative matching
      const minGapForRelativeMatch = 0.1; // Minimum gap to consider it a "clear winner"
      
      if (maxSimilarity >= relaxedThreshold && similarityGap >= minGapForRelativeMatch) {
        // Clear winner with moderate similarity - accept it
        const topFeature = allSimilarities[0];
        log(`[FeatureMapper] Group ${group.id}: Using relative ranking - top feature "${topFeature.name}" (${maxSimilarity.toFixed(3)}) is ${similarityGap.toFixed(3)} above second-best, accepting despite being below strict threshold`);
        affectedFeatures.push({
          id: topFeature.id,
          similarity: maxSimilarity,
          ruleBased: false,
          codeBased: false,
        });
      } else if (maxSimilarity >= 0.5) {
        // Moderate confidence - accept if above 0.5
        const topFeature = allSimilarities[0];
        log(`[FeatureMapper] Group ${group.id}: Accepting top feature "${topFeature.name}" with moderate confidence (${maxSimilarity.toFixed(3)} >= 0.5)`);
        affectedFeatures.push({
          id: topFeature.id,
          similarity: maxSimilarity,
          ruleBased: false,
          codeBased: false,
        });
      }
    }
    
    // Log why group matched or didn't match
    if (affectedFeatures.length === 0) {
      log(`[FeatureMapper] Group ${group.id} matched to General because:`);
      if (maxSimilarity < minSimilarity) {
        if (maxSimilarity < 0.4) {
          log(`[FeatureMapper]   - Max similarity (${maxSimilarity.toFixed(3)}) too low (< 0.4) for any matching`);
        } else if (similarityGap < 0.1) {
          log(`[FeatureMapper]   - Max similarity (${maxSimilarity.toFixed(3)}) below threshold (${minSimilarity}) and no clear winner (gap: ${similarityGap.toFixed(3)} < 0.1)`);
        } else {
          log(`[FeatureMapper]   - Max similarity (${maxSimilarity.toFixed(3)}) below threshold (${minSimilarity})`);
        }
      }
      if (!groupEmbedding) {
        log(`[FeatureMapper]   - No group embedding available (semantic matching disabled)`);
      }
      if (codeToFeatureMappings.size === 0) {
        log(`[FeatureMapper]   - No code-based matches found`);
      }
    }
    
    // Sort by similarity (code-based matches first, then rule-based, then by score) and take top matches
    affectedFeatures.sort((a, b) => {
      // Code-based matches first (strongest signal)
      if (a.codeBased && !b.codeBased) return -1;
      if (!a.codeBased && b.codeBased) return 1;
      // Rule-based matches second
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
  
  const crossCuttingCount = mappedGroups.filter(g => g.is_cross_cutting).length;
  log(`[FeatureMapper] Mapped ${groups.length} groups to features. ${crossCuttingCount} cross-cutting groups.`);
  
  // Debug: Log summary of matches
  const groupsWithMatches = mappedGroups.filter(g => 
    g.affects_features && g.affects_features.length > 0 && 
    !(g.affects_features.length === 1 && g.affects_features[0].id === "general")
  );
  const generalOnlyCount = mappedGroups.filter(g => 
    g.affects_features && 
    g.affects_features.length === 1 && 
    g.affects_features[0].id === "general"
  ).length;
  log(`[FeatureMapper] Summary: ${groupsWithMatches.length} matched to specific features, ${generalOnlyCount} matched to General only`);
  
  if (generalOnlyCount === mappedGroups.length && mappedGroups.length > 0) {
    log(`[FeatureMapper] WARNING: All groups matched to General! Check:`);
    log(`[FeatureMapper]   - Feature embeddings computed: ${featureEmbeddings.size}/${features.length}`);
    log(`[FeatureMapper]   - Similarity threshold: ${minSimilarity} (try lowering to 0.4 or 0.5)`);
    log(`[FeatureMapper]   - Group embeddings: check if group embedding computation succeeded`);
  }
  
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

  // Step 2.5: Pre-load code-to-feature mappings ONCE (not per thread)
  // This avoids calling matchTextToFeaturesUsingCode for every thread (causing excessive logging)
  let sharedCodeToFeatureMappings: Map<string, number> = new Map();
  const { getConfig } = await import("../config/index.js");
  const config = getConfig();
  const repositoryUrl = config.pmIntegration?.github_repo_url;

  if (repositoryUrl && ungroupedThreads.length > 0) {
    try {
      const { matchTextToFeaturesUsingCode } = await import("../storage/db/codeIndexer.js");
      // Use a broad query to load the code search once
      const firstThreadText = ungroupedThreads[0]?.thread_name || "";
      if (firstThreadText) {
        const codeResult = await matchTextToFeaturesUsingCode(
          firstThreadText,
          repositoryUrl,
          features
        );
        sharedCodeToFeatureMappings = codeResult.featureSimilarities;
        log(`[FeatureMapper] Pre-loaded code mappings for ungrouped threads: ${sharedCodeToFeatureMappings.size} features`);
      }
    } catch (error) {
      log(`[FeatureMapper] Failed to pre-load code mappings for threads: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

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
      // Only reuse if content hasn't changed (check contentHash)
      const threadContentHash = createHash("md5").update(threadText).digest("hex");
      let threadEmbedding: Embedding | null = null;
      if (useDatabase) {
        try {
          threadEmbedding = await getThreadEmbedding(thread.thread_id, threadContentHash);
          if (threadEmbedding) {
            // Content unchanged, reuse embedding
          } else {
            // Content changed or not found, will compute in batch
          }
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
      // Find matching features using thread embedding + code matching
      // Even if embedding failed, we can still try code-based matching
      const affectedFeatures: Array<{ id: string; similarity: number; codeBased?: boolean }> = [];

      // Reuse pre-loaded code-to-feature mappings (loaded once before the loop)
      // This avoids calling matchTextToFeaturesUsingCode for every thread
      const codeToFeatureMappings = sharedCodeToFeatureMappings;

      for (const feature of features) {
        const featureEmb = featureEmbeddings.get(feature.id);
        let similarity = 0;
        let codeBased = false;

        // Try semantic similarity if embeddings are available
        if (data.embedding && featureEmb) {
          similarity = cosineSimilarity(data.embedding, featureEmb);
        }
        
        // Use code-based matching (works even without embeddings)
        if (codeToFeatureMappings.has(feature.id)) {
          const codeSimilarity = codeToFeatureMappings.get(feature.id) || 0;
          if (codeSimilarity > 0.5) {
            // If we have semantic similarity, boost it with code
            // If no semantic similarity (embedding failed), use code similarity directly
            if (similarity > 0) {
              similarity = Math.max(similarity, codeSimilarity * 0.9); // Code match is 90% weight
            } else {
              similarity = codeSimilarity * 0.9; // Use code similarity directly
              log(`[FeatureMapper] Thread ${data.thread.thread_id}: Using code-based similarity for "${feature.name}" (${similarity.toFixed(3)}) - embedding unavailable`);
            }
            codeBased = true;
          }
        }
        
        // Include if above threshold OR if strong code match (even without semantic similarity)
        if (similarity >= minSimilarity || (codeBased && codeToFeatureMappings.get(feature.id)! > 0.6)) {
          affectedFeatures.push({ id: feature.id, similarity, codeBased });
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

  // Step 2.5: Pre-load code-to-feature mappings ONCE (not per issue)
  // This avoids calling matchTextToFeaturesUsingCode for every issue (causing excessive logging)
  let sharedCodeToFeatureMappings: Map<string, number> = new Map();
  const { getConfig } = await import("../config/index.js");
  const config = getConfig();
  const repositoryUrl = config.pmIntegration?.github_repo_url;

  if (repositoryUrl && ungroupedIssues.length > 0) {
    try {
      const { matchTextToFeaturesUsingCode } = await import("../storage/db/codeIndexer.js");
      // Use a broad query to load the code search once
      const firstIssueText = ungroupedIssues[0]?.issue_title || "";
      if (firstIssueText) {
        const codeResult = await matchTextToFeaturesUsingCode(
          firstIssueText,
          repositoryUrl,
          features
        );
        sharedCodeToFeatureMappings = codeResult.featureSimilarities;
        log(`[FeatureMapper] Pre-loaded code mappings for ungrouped issues: ${sharedCodeToFeatureMappings.size} features`);
      }
    } catch (error) {
      log(`[FeatureMapper] Failed to pre-load code mappings for issues: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

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
      // Only reuse if content hasn't changed (check contentHash)
      const issueContentHash = hashContent(issueText);
      let issueEmbedding: Embedding | null = null;
      if (useDatabase) {
        try {
          issueEmbedding = await getIssueEmbedding(issue.issue_number, issueContentHash);
          if (issueEmbedding) {
            // Content unchanged, reuse embedding
          } else {
            // Content changed or not found, will compute in batch
          }
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
      // Find matching features using issue embedding + code matching + GitHub labels
      // Even if embedding failed, we can still try code-based and label-based matching
      const affectedFeatures: Array<{ id: string; similarity: number; codeBased?: boolean; labelBased?: boolean }> = [];

      // Reuse pre-loaded code-to-feature mappings (loaded once before the loop)
      // This avoids calling matchTextToFeaturesUsingCode for every issue
      const codeToFeatureMappings = sharedCodeToFeatureMappings;

      // Normalize GitHub labels for matching
      const issueLabelsNormalized = (data.issue.issue_labels || []).map(l => l.toLowerCase().trim());

      for (const feature of features) {
        const featureEmb = featureEmbeddings.get(feature.id);
        let similarity = 0;
        let codeBased = false;
        let labelBased = false;
        
        // Step 1: Check GitHub labels for direct feature name matching (ADDITIONAL signal)
        const featureNameLower = feature.name.toLowerCase().trim();
        const featureNameNormalized = featureNameLower
          .replace(/^feature[:\s]+/i, "")
          .replace(/[:\s]+$/, "")
          .trim();
        const featureKeywords = (feature.related_keywords || []).map(k => k.toLowerCase().trim());
        
        let labelSimilarity = 0;
        for (const label of issueLabelsNormalized) {
          const labelNormalized = label
            .replace(/^feature[:\s]+/i, "")
            .replace(/[:\s]+$/, "")
            .trim();
          
          // Direct exact match (e.g., "social" label matches "social" feature)
          if (labelNormalized === featureNameNormalized || label === featureNameLower) {
            labelBased = true;
            labelSimilarity = 0.95; // Very high confidence for direct label match
            log(`[FeatureMapper] Issue ${data.issue.issue_number}: Label-based match - GitHub label "${label}" directly matches feature "${feature.name}"`);
            break;
          }
          
          // Partial match: Check if label contains feature name as a word (e.g., "social provider" contains "social")
          // Split label into words and check if any word matches the feature name
          const labelWords = labelNormalized.split(/[\s\-_]+/);
          if (labelWords.includes(featureNameNormalized) || labelWords.includes(featureNameLower)) {
            labelBased = true;
            labelSimilarity = 0.92; // High confidence for partial label match (slightly lower than exact)
            log(`[FeatureMapper] Issue ${data.issue.issue_number}: Label-based match - GitHub label "${label}" contains feature name "${feature.name}"`);
            break;
          }
          
          // Also check if label contains feature name as substring (for cases like "social-provider" or "social_provider")
          if (labelNormalized.includes(featureNameNormalized) || label.includes(featureNameLower)) {
            // Only match if feature name is at least 3 characters (avoid false matches like "a" in "label")
            if (featureNameNormalized.length >= 3) {
              labelBased = true;
              labelSimilarity = 0.90; // High confidence for substring match
              log(`[FeatureMapper] Issue ${data.issue.issue_number}: Label-based match - GitHub label "${label}" contains feature name "${feature.name}" as substring`);
              break;
            }
          }
          
          // Check if label matches any feature keywords
          for (const keyword of featureKeywords) {
            const keywordNormalized = keyword
              .replace(/^feature[:\s]+/i, "")
              .replace(/[:\s]+$/, "")
              .trim();
            if (labelNormalized === keywordNormalized || label === keyword) {
              labelBased = true;
              labelSimilarity = 0.9; // High confidence for label-keyword match
              log(`[FeatureMapper] Issue ${data.issue.issue_number}: Label-based match - GitHub label "${label}" matches feature keyword "${keyword}" for feature "${feature.name}"`);
              break;
            }
            // Also check if label contains keyword as word
            const keywordWords = labelNormalized.split(/[\s\-_]+/);
            if (keywordWords.includes(keywordNormalized) || keywordWords.includes(keyword)) {
              labelBased = true;
              labelSimilarity = 0.88; // Good confidence for keyword-in-label match
              log(`[FeatureMapper] Issue ${data.issue.issue_number}: Label-based match - GitHub label "${label}" contains feature keyword "${keyword}" for feature "${feature.name}"`);
              break;
            }
          }
          if (labelBased) break;
        }
        
        // Step 2: Semantic similarity (always check, combine with label if present)
        let semanticSimilarity = 0;
        if (data.embedding && featureEmb) {
          semanticSimilarity = cosineSimilarity(data.embedding, featureEmb);
        } else if (!data.embedding) {
          log(`[FeatureMapper] Issue ${data.issue.issue_number}: No embedding available, will try code-based and label-based matching`);
        }
        
        // Step 3: Code-based matching (ADDITIONAL signal)
        let codeSimilarity = 0;
        if (codeToFeatureMappings.has(feature.id)) {
          codeSimilarity = codeToFeatureMappings.get(feature.id) || 0;
          if (codeSimilarity > 0.5) {
            codeBased = true;
          }
        }
        
        // Step 4: Combine all signals (label-based, semantic, code-based)
        // Priority: label > code > semantic
        if (labelSimilarity > 0) {
          // Label match is strongest - use it as base, boost with others
          similarity = labelSimilarity;
          if (codeSimilarity > 0.5) {
            similarity = Math.max(similarity, codeSimilarity * 0.95); // Code can boost label match slightly
          }
          if (semanticSimilarity > 0.7) {
            similarity = Math.max(similarity, semanticSimilarity * 0.95); // High semantic similarity can boost
          }
        } else if (codeSimilarity > 0.5) {
          // Code match is second strongest
          similarity = codeSimilarity * 0.9;
          if (semanticSimilarity > 0) {
            similarity = Math.max(similarity, semanticSimilarity); // Use higher of code or semantic
          }
          log(`[FeatureMapper] Issue ${data.issue.issue_number}: Using code-based similarity for "${feature.name}" (${similarity.toFixed(3)})${semanticSimilarity > 0 ? `, boosted from semantic ${semanticSimilarity.toFixed(3)}` : ''}`);
        } else if (semanticSimilarity > 0) {
          // Semantic similarity as base
          similarity = semanticSimilarity;
        }
        
        // Include if above threshold OR if strong code match OR if label-based match (even without semantic similarity)
        if (similarity >= minSimilarity || labelBased || (codeBased && codeSimilarity > 0.6)) {
          affectedFeatures.push({ id: feature.id, similarity, codeBased, labelBased });
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
