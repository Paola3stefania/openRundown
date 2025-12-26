/**
 * Correlation and grouping logic
 * Groups related signals (Discord messages, GitHub issues) together
 * Supports both keyword-based and semantic (LLM) similarity
 * Can map groups to product features for cross-cutting analysis
 */
import type { Signal, GroupCandidate, IssueRef } from "../../types/signal.js";
import { createEmbedding, isLLMClassificationAvailable } from "../classify/semantic.js";
import { 
  getCachedEmbedding, 
  setCachedEmbedding, 
  batchSetCachedEmbeddings,
  hashContent,
  type Embedding 
} from "../../storage/cache/embeddingCache.js";

export interface CorrelationOptions {
  minSimilarity?: number;
  maxGroups?: number;
}

export interface SemanticGroupingOptions {
  minSimilarity?: number;  // 0-1 scale, default 0.6
  maxGroups?: number;      // Max groups to return, default 50
}

export interface Feature {
  id: string;
  name: string;
  description: string;
}

export interface SemanticGroup {
  id: string;
  signals: Signal[];
  similarity: number;
  suggestedTitle: string;
  affectsFeatures: string[];  // Feature IDs
  isCrossCutting: boolean;    // Affects multiple features
  canonicalIssue?: IssueRef;
}

export interface GroupingResult {
  groups: SemanticGroup[];
  ungroupedSignals: Signal[];
  stats: {
    totalSignals: number;
    groupedSignals: number;
    crossCuttingGroups: number;
    embeddingsComputed: number;
    embeddingsFromCache: number;
  };
}

// In-memory cache for current session (backed by persistent cache)
const sessionEmbeddingCache: Map<string, Embedding> = new Map();

/**
 * Calculate cosine similarity between two embedding vectors
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
  if (denominator === 0) return 0;

  // Return 0-1 scale (cosine similarity is already -1 to 1, normalize to 0-1)
  return (dotProduct / denominator + 1) / 2;
}

/**
 * Get signal content for embedding
 */
function getSignalContent(signal: Signal): string {
  return [signal.title || "", signal.body].filter(Boolean).join("\n\n");
}

/**
 * Get or compute embedding for a signal (uses persistent cache)
 */
async function getSignalEmbedding(
  signal: Signal, 
  apiKey: string,
  stats: { computed: number; cached: number }
): Promise<Embedding> {
  const cacheType = signal.source === "github" ? "issues" : "discord";
  const content = getSignalContent(signal);
  const contentHash = hashContent(content);
  
  // Check session cache first
  const sessionKey = `${signal.source}:${signal.sourceId}`;
  if (sessionEmbeddingCache.has(sessionKey)) {
    stats.cached++;
    return sessionEmbeddingCache.get(sessionKey)!;
  }
  
  // Check persistent cache
  const cached = getCachedEmbedding(cacheType, signal.sourceId, contentHash);
  if (cached) {
    sessionEmbeddingCache.set(sessionKey, cached);
    stats.cached++;
    return cached;
  }
  
  // Compute new embedding
  const embedding = await createEmbedding(content, apiKey);
  
  // Save to both caches
  sessionEmbeddingCache.set(sessionKey, embedding);
  setCachedEmbedding(cacheType, signal.sourceId, contentHash, embedding);
  
  stats.computed++;
  return embedding;
}

/**
 * Get or compute embedding for a feature
 */
async function getFeatureEmbedding(
  feature: Feature,
  apiKey: string,
  featureEmbeddings: Map<string, Embedding>
): Promise<Embedding> {
  if (featureEmbeddings.has(feature.id)) {
    return featureEmbeddings.get(feature.id)!;
  }
  
  const content = `${feature.name}\n\n${feature.description}`;
  const embedding = await createEmbedding(content, apiKey);
  featureEmbeddings.set(feature.id, embedding);
  
  return embedding;
}

/**
 * Group signals semantically and map to features
 * Hybrid approach: group by similarity, then map to features
 */
export async function groupSignalsSemantic(
  signals: Signal[],
  features: Feature[],
  options: SemanticGroupingOptions = {}
): Promise<GroupingResult> {
  const { minSimilarity = 0.6, maxGroups = 50 } = options;
  
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error("OPENAI_API_KEY required for semantic grouping");
  }
  
  const stats = { computed: 0, cached: 0 };
  const groups: SemanticGroup[] = [];
  const processed = new Set<string>();
  
  console.error(`[Grouping] Processing ${signals.length} signals...`);
  
  // Step 1: Compute embeddings for all signals
  const signalEmbeddings = new Map<string, Embedding>();
  for (const signal of signals) {
    const key = `${signal.source}:${signal.sourceId}`;
    const embedding = await getSignalEmbedding(signal, apiKey, stats);
    signalEmbeddings.set(key, embedding);
    
    // Rate limit protection
    if (stats.computed > 0 && stats.computed % 10 === 0) {
      await new Promise(r => setTimeout(r, 200));
    }
  }
  
  console.error(`[Grouping] Embeddings: ${stats.cached} cached, ${stats.computed} computed`);
  
  // Step 2: Compute embeddings for features
  const featureEmbeddings = new Map<string, Embedding>();
  for (const feature of features) {
    await getFeatureEmbedding(feature, apiKey, featureEmbeddings);
    await new Promise(r => setTimeout(r, 100)); // Rate limit
  }
  
  console.error(`[Grouping] Feature embeddings computed: ${features.length}`);
  
  // Step 3: Group signals by similarity
  for (let i = 0; i < signals.length; i++) {
    const signal = signals[i];
    const signalKey = `${signal.source}:${signal.sourceId}`;
    
    if (processed.has(signalKey)) continue;
    
    const group: Signal[] = [signal];
    processed.add(signalKey);
    
    const signalEmb = signalEmbeddings.get(signalKey)!;
    
    // Find similar signals
    for (let j = i + 1; j < signals.length; j++) {
      const otherSignal = signals[j];
      const otherKey = `${otherSignal.source}:${otherSignal.sourceId}`;
      
      if (processed.has(otherKey)) continue;
      
      const otherEmb = signalEmbeddings.get(otherKey)!;
      const similarity = cosineSimilarity(signalEmb, otherEmb);
      
      if (similarity >= minSimilarity) {
        group.push(otherSignal);
        processed.add(otherKey);
      }
    }
    
    // Only create group if multiple signals OR single signal with high feature match
    if (group.length >= 1) {
      // Calculate average group embedding for feature matching
      const groupEmbedding = calculateAverageEmbedding(
        group.map(s => signalEmbeddings.get(`${s.source}:${s.sourceId}`)!)
      );
      
      // Step 4: Map group to features
      const affectedFeatures: Array<{ id: string; similarity: number }> = [];
      
      for (const feature of features) {
        const featureEmb = featureEmbeddings.get(feature.id)!;
        const similarity = cosineSimilarity(groupEmbedding, featureEmb);
        
        if (similarity >= 0.5) { // Feature match threshold
          affectedFeatures.push({ id: feature.id, similarity });
        }
      }
      
      // Sort by similarity and take top matches
      affectedFeatures.sort((a, b) => b.similarity - a.similarity);
      const topFeatures = affectedFeatures.slice(0, 5).map(f => f.id);
      
      // Calculate group similarity (average pairwise)
      let groupSimilarity = 1.0;
      if (group.length > 1) {
        let total = 0;
        let count = 0;
        for (let k = 0; k < group.length; k++) {
          for (let l = k + 1; l < group.length; l++) {
            const emb1 = signalEmbeddings.get(`${group[k].source}:${group[k].sourceId}`)!;
            const emb2 = signalEmbeddings.get(`${group[l].source}:${group[l].sourceId}`)!;
            total += cosineSimilarity(emb1, emb2);
            count++;
          }
        }
        groupSimilarity = count > 0 ? total / count : 1.0;
      }
      
      groups.push({
        id: `group-${groups.length + 1}`,
        signals: group,
        similarity: groupSimilarity,
        suggestedTitle: generateGroupTitle(group),
        affectsFeatures: topFeatures,
        isCrossCutting: topFeatures.length > 1,
        canonicalIssue: findCanonicalIssue(group),
      });
    }
  }
  
  // Sort by number of signals (larger groups first)
  groups.sort((a, b) => b.signals.length - a.signals.length);
  
  // Limit groups
  const limitedGroups = groups.slice(0, maxGroups);
  
  // Find ungrouped signals (singles that didn't match any feature well)
  const groupedSignalIds = new Set(
    limitedGroups.flatMap(g => g.signals.map(s => `${s.source}:${s.sourceId}`))
  );
  const ungrouped = signals.filter(
    s => !groupedSignalIds.has(`${s.source}:${s.sourceId}`)
  );
  
  console.error(`[Grouping] Created ${limitedGroups.length} groups, ${limitedGroups.filter(g => g.isCrossCutting).length} cross-cutting`);
  
  return {
    groups: limitedGroups,
    ungroupedSignals: ungrouped,
    stats: {
      totalSignals: signals.length,
      groupedSignals: signals.length - ungrouped.length,
      crossCuttingGroups: limitedGroups.filter(g => g.isCrossCutting).length,
      embeddingsComputed: stats.computed,
      embeddingsFromCache: stats.cached,
    },
  };
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
 * Generate a suggested title for a group
 */
function generateGroupTitle(signals: Signal[]): string {
  // Prefer GitHub issue titles, then Discord thread names
  const githubIssue = signals.find(s => s.source === "github" && s.title);
  if (githubIssue?.title) return githubIssue.title;
  
  const discordThread = signals.find(s => s.source === "discord" && s.title);
  if (discordThread?.title) return discordThread.title;
  
  // Fallback: first 60 chars of first signal body
  const firstSignal = signals[0];
  if (firstSignal.body) {
    return firstSignal.body.substring(0, 60) + (firstSignal.body.length > 60 ? "..." : "");
  }
  
  return "Untitled Group";
}

/**
 * Group signals that are likely related to the same issue
 * Uses similarity scoring to identify potential duplicates or related items
 */
export function groupSignalsBySimilarity(
  signals: Signal[],
  options: CorrelationOptions = {}
): GroupCandidate[] {
  const { minSimilarity = 0.5, maxGroups = 10 } = options;
  const groups: GroupCandidate[] = [];
  const processed = new Set<string>();

  for (let i = 0; i < signals.length; i++) {
    if (processed.has(signals[i].sourceId)) continue;

    const group: Signal[] = [signals[i]];
    processed.add(signals[i].sourceId);

    // Find similar signals
    for (let j = i + 1; j < signals.length; j++) {
      if (processed.has(signals[j].sourceId)) continue;

      const similarity = calculateTextSimilarity(
        signals[i].body,
        signals[j].body,
        signals[i].title,
        signals[j].title
      );

      if (similarity >= minSimilarity) {
        group.push(signals[j]);
        processed.add(signals[j].sourceId);
      }
    }

    if (group.length > 1) {
      // Calculate average similarity for the group
      let totalSimilarity = 0;
      let comparisons = 0;
      for (let k = 0; k < group.length; k++) {
        for (let l = k + 1; l < group.length; l++) {
          totalSimilarity += calculateTextSimilarity(
            group[k].body,
            group[l].body,
            group[k].title,
            group[l].title
          );
          comparisons++;
        }
      }
      const avgSimilarity = comparisons > 0 ? totalSimilarity / comparisons : 0;

      // Find canonical issue (prefer GitHub issues, then most recent)
      const canonicalIssue = findCanonicalIssue(group);

      groups.push({
        signals: group,
        similarity: avgSimilarity,
        canonicalIssue,
      });
    }
  }

  // Sort by similarity and limit
  return groups
    .sort((a, b) => b.similarity - a.similarity)
    .slice(0, maxGroups);
}

/**
 * Calculate text similarity between two signals
 * Simple implementation using word overlap
 */
function calculateTextSimilarity(
  text1: string,
  text2: string,
  title1?: string,
  title2?: string
): number {
  const words1 = extractWords(text1 + " " + (title1 || ""));
  const words2 = extractWords(text2 + " " + (title2 || ""));

  if (words1.size === 0 && words2.size === 0) return 0;
  if (words1.size === 0 || words2.size === 0) return 0;

  let intersection = 0;
  for (const word of words1) {
    if (words2.has(word)) {
      intersection++;
    }
  }

  const union = words1.size + words2.size - intersection;
  return union > 0 ? intersection / union : 0;
}

function extractWords(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .replace(/[^\w\s]/g, " ")
      .split(/\s+/)
      .filter((w) => w.length > 2)
  );
}

/**
 * Find the canonical issue from a group of signals
 * Prefers GitHub issues over Discord messages, then most recent
 */
function findCanonicalIssue(signals: Signal[]): IssueRef | undefined {
  // Prefer GitHub issues
  const githubIssues = signals.filter((s) => s.source === "github");
  if (githubIssues.length > 0) {
    const mostRecent = githubIssues.sort(
      (a, b) => new Date(b.updatedAt || b.createdAt).getTime() - new Date(a.updatedAt || a.createdAt).getTime()
    )[0];
    return {
      source: "github",
      sourceId: mostRecent.sourceId,
      permalink: mostRecent.permalink,
      title: mostRecent.title,
    };
  }

  // Fallback to most recent signal
  const mostRecent = signals.sort(
    (a, b) => new Date(b.updatedAt || b.createdAt).getTime() - new Date(a.updatedAt || a.createdAt).getTime()
  )[0];
  return {
    source: mostRecent.source,
    sourceId: mostRecent.sourceId,
    permalink: mostRecent.permalink,
    title: mostRecent.title,
  };
}

/**
 * Classification result from 1-to-1 classification
 */
export interface ClassifiedThread {
  thread: {
    thread_id: string;
    thread_name?: string;
    message_count: number;
    first_message_url?: string;
    first_message_author?: string;
    first_message_timestamp?: string;
    classified_status: string;
  };
  issues: Array<{
    number: number;
    title: string;
    state: string;
    url: string;
    similarity_score: number;
    labels?: string[];
    author?: string;
  }>;
}

export interface ClassificationResults {
  channel_id: string;
  classified_threads: ClassifiedThread[];
}

export interface IssueBasedGroup {
  id: string;
  issue: {
    number: number;
    title: string;
    url: string;
    state: string;
    labels?: string[];
  };
  threads: Array<{
    thread_id: string;
    thread_name?: string;
    similarity_score: number;
    url?: string;
    author?: string;
    timestamp?: string;
  }>;
  avgSimilarity: number;
}

/**
 * Group Discord threads by their matched GitHub issues from classification results
 * Threads that matched the same issue → same group
 * This is more accurate than pure semantic similarity because it's "issue-anchored"
 */
export function groupByClassificationResults(
  classificationResults: ClassificationResults,
  options: { 
    minSimilarity?: number;  // Min similarity score for issue match (0-100, default 60)
    maxGroups?: number;      // Max groups to return
    topIssuesPerThread?: number;  // How many top issues per thread to consider (default 3)
  } = {}
): {
  groups: IssueBasedGroup[];
  stats: {
    totalThreads: number;
    groupedThreads: number;
    uniqueIssues: number;
  };
} {
  const { minSimilarity = 60, maxGroups = 50, topIssuesPerThread = 3 } = options;
  
  // Map: issue number → list of threads that matched it
  const issueToThreads = new Map<number, Array<{
    thread_id: string;
    thread_name?: string;
    similarity_score: number;
    url?: string;
    author?: string;
    timestamp?: string;
    issueData: ClassifiedThread["issues"][0];
  }>>();
  
  let totalThreads = 0;
  let groupedThreads = 0;
  
  for (const classified of classificationResults.classified_threads) {
    totalThreads++;
    
    // Take top N issues that pass similarity threshold
    const topIssues = classified.issues
      .filter(issue => issue.similarity_score >= minSimilarity)
      .slice(0, topIssuesPerThread);
    
    if (topIssues.length > 0) {
      groupedThreads++;
    }
    
    for (const issue of topIssues) {
      if (!issueToThreads.has(issue.number)) {
        issueToThreads.set(issue.number, []);
      }
      
      issueToThreads.get(issue.number)!.push({
        thread_id: classified.thread.thread_id,
        thread_name: classified.thread.thread_name,
        similarity_score: issue.similarity_score,
        url: classified.thread.first_message_url,
        author: classified.thread.first_message_author,
        timestamp: classified.thread.first_message_timestamp,
        issueData: issue,
      });
    }
  }
  
  // Convert map to groups
  const groups: IssueBasedGroup[] = [];
  
  for (const [issueNumber, threads] of issueToThreads) {
    // Sort threads by similarity (highest first)
    threads.sort((a, b) => b.similarity_score - a.similarity_score);
    
    // Get issue data from first thread (they all matched same issue)
    const issueData = threads[0].issueData;
    
    // Calculate average similarity
    const avgSimilarity = threads.reduce((sum, t) => sum + t.similarity_score, 0) / threads.length;
    
    groups.push({
      id: `issue-${issueNumber}`,
      issue: {
        number: issueNumber,
        title: issueData.title,
        url: issueData.url,
        state: issueData.state,
        labels: issueData.labels,
      },
      threads: threads.map(t => ({
        thread_id: t.thread_id,
        thread_name: t.thread_name,
        similarity_score: t.similarity_score,
        url: t.url,
        author: t.author,
        timestamp: t.timestamp,
      })),
      avgSimilarity,
    });
  }
  
  // Sort by number of threads (more threads = more important group)
  groups.sort((a, b) => b.threads.length - a.threads.length);
  
  // Limit groups
  const limitedGroups = groups.slice(0, maxGroups);
  
  console.error(`[GroupByClassification] Created ${limitedGroups.length} groups from ${totalThreads} threads (${groupedThreads} with matches)`);
  
  return {
    groups: limitedGroups,
    stats: {
      totalThreads,
      groupedThreads,
      uniqueIssues: issueToThreads.size,
    },
  };
}

/**
 * Find duplicate signals (exact or near-duplicate content)
 */
export function findDuplicates(
  signals: Signal[],
  threshold: number = 0.9
): Signal[][] {
  const duplicates: Signal[][] = [];
  const processed = new Set<string>();

  for (let i = 0; i < signals.length; i++) {
    if (processed.has(signals[i].sourceId)) continue;

    const group: Signal[] = [signals[i]];
    processed.add(signals[i].sourceId);

    for (let j = i + 1; j < signals.length; j++) {
      if (processed.has(signals[j].sourceId)) continue;

      const similarity = calculateTextSimilarity(
        signals[i].body,
        signals[j].body,
        signals[i].title,
        signals[j].title
      );

      if (similarity >= threshold) {
        group.push(signals[j]);
        processed.add(signals[j].sourceId);
      }
    }

    if (group.length > 1) {
      duplicates.push(group);
    }
  }

  return duplicates;
}

