/**
 * Maps groups to features using semantic similarity
 * Used during export to determine which Linear projects/issues should be created
 */

import { log } from "../mcp/logger.js";
import { createEmbedding } from "../core/classify/semantic.js";

interface Feature {
  id: string;
  name: string;
  description?: string;
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
  features: Feature[]
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

  // Step 1: Compute embeddings for all features
  const featureEmbeddings = new Map<string, Embedding>();
  for (const feature of features) {
    const featureText = `${feature.name}${feature.description ? `: ${feature.description}` : ""}`;
    try {
      const embedding = await createEmbedding(featureText, apiKey);
      featureEmbeddings.set(feature.id, embedding);
    } catch (error) {
      log(`Failed to create embedding for feature ${feature.name}: ${error instanceof Error ? error.message : String(error)}`);
    }
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
    
    // Find matching features
    const affectedFeatures: Array<{ id: string; similarity: number }> = [];
    
    for (const feature of features) {
      const featureEmb = featureEmbeddings.get(feature.id);
      if (!featureEmb) continue;
      
      const similarity = cosineSimilarity(groupEmbedding, featureEmb);
      
      if (similarity >= 0.5) { // Feature match threshold
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
    
    mappedGroups.push({
      ...group,
      affects_features: affectsFeatures,
      is_cross_cutting: affectsFeatures.length > 1,
    });
  }
  
  log(`Mapped ${groups.length} groups to features. ${mappedGroups.filter(g => g.is_cross_cutting).length} cross-cutting groups.`);
  
  return mappedGroups;
}

/**
 * Map classified data to features (legacy function for workflow.ts)
 * @deprecated This function is kept for backward compatibility but may not be fully implemented
 */
export async function mapToFeatures(
  features: Feature[],
  classifiedData: any
): Promise<any[]> {
  // TODO: Implement this function if needed
  // For now, return empty array to avoid breaking the build
  log("mapToFeatures is deprecated and not fully implemented");
  return [];
}
