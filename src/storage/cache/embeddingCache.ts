/**
 * Shared embedding cache for semantic operations
 * Used by both classification and grouping
 * Persists embeddings to disk to avoid redundant API calls
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { join } from "path";
import { createHash } from "crypto";
import { getConfig } from "../../config/index.js";

// Embedding vector type (OpenAI returns 1536-dimensional vectors)
export type Embedding = number[];

// Cache entry with content hash for invalidation
interface EmbeddingEntry {
  embedding: Embedding;
  contentHash: string;
  createdAt: string;
}

// Persistent cache structure
interface EmbeddingCacheFile {
  version: number;
  model: string;
  entries: Record<string, EmbeddingEntry>;
}

const CACHE_VERSION = 1;
const EMBEDDING_MODEL = "text-embedding-3-small";

// In-memory cache for fast access during runtime
const memoryCache: Map<string, Embedding> = new Map();

/**
 * Get the path to an embeddings cache file
 */
function getCachePath(cacheType: "issues" | "discord"): string {
  const config = getConfig();
  const cacheDir = join(process.cwd(), config.paths.cacheDir);
  
  if (!existsSync(cacheDir)) {
    mkdirSync(cacheDir, { recursive: true });
  }
  
  const fileName = cacheType === "issues" 
    ? "issue-embeddings-cache.json"
    : "discord-embeddings-cache.json";
    
  return join(cacheDir, fileName);
}

/**
 * Create a hash of content for change detection
 */
export function hashContent(content: string): string {
  return createHash("md5").update(content).digest("hex");
}

/**
 * Load persistent cache from disk
 */
function loadCache(cacheType: "issues" | "discord"): EmbeddingCacheFile {
  const cachePath = getCachePath(cacheType);
  
  if (!existsSync(cachePath)) {
    return { version: CACHE_VERSION, model: EMBEDDING_MODEL, entries: {} };
  }
  
  try {
    const data = readFileSync(cachePath, "utf-8");
    const cache = JSON.parse(data) as EmbeddingCacheFile;
    
    // Check version and model compatibility
    if (cache.version !== CACHE_VERSION || cache.model !== EMBEDDING_MODEL) {
      console.error(`[EmbeddingCache] Version/model mismatch for ${cacheType}, starting fresh`);
      return { version: CACHE_VERSION, model: EMBEDDING_MODEL, entries: {} };
    }
    
    return cache;
  } catch (error) {
    console.error(`[EmbeddingCache] Failed to load ${cacheType} cache, starting fresh`);
    return { version: CACHE_VERSION, model: EMBEDDING_MODEL, entries: {} };
  }
}

/**
 * Save cache to disk
 */
function saveCache(cacheType: "issues" | "discord", cache: EmbeddingCacheFile): void {
  const cachePath = getCachePath(cacheType);
  
  try {
    writeFileSync(cachePath, JSON.stringify(cache, null, 2), "utf-8");
  } catch (error) {
    console.error(`[EmbeddingCache] Failed to save ${cacheType} cache:`, error);
  }
}

/**
 * Get cached embedding for an item
 * Returns undefined if not cached or content changed
 */
export function getCachedEmbedding(
  cacheType: "issues" | "discord",
  id: string,
  contentHash: string
): Embedding | undefined {
  // Check memory cache first
  const memKey = `${cacheType}:${id}`;
  if (memoryCache.has(memKey)) {
    return memoryCache.get(memKey);
  }
  
  // Check disk cache
  const cache = loadCache(cacheType);
  const entry = cache.entries[id];
  
  if (entry && entry.contentHash === contentHash) {
    // Load into memory cache for faster subsequent access
    memoryCache.set(memKey, entry.embedding);
    return entry.embedding;
  }
  
  return undefined;
}

/**
 * Save embedding to cache
 */
export function setCachedEmbedding(
  cacheType: "issues" | "discord",
  id: string,
  contentHash: string,
  embedding: Embedding
): void {
  // Save to memory cache
  const memKey = `${cacheType}:${id}`;
  memoryCache.set(memKey, embedding);
  
  // Save to disk cache
  const cache = loadCache(cacheType);
  cache.entries[id] = {
    embedding,
    contentHash,
    createdAt: new Date().toISOString(),
  };
  saveCache(cacheType, cache);
}

/**
 * Batch save embeddings (more efficient for multiple items)
 */
export function batchSetCachedEmbeddings(
  cacheType: "issues" | "discord",
  items: Array<{ id: string; contentHash: string; embedding: Embedding }>
): void {
  const cache = loadCache(cacheType);
  
  for (const item of items) {
    // Save to memory cache
    const memKey = `${cacheType}:${item.id}`;
    memoryCache.set(memKey, item.embedding);
    
    // Add to disk cache
    cache.entries[item.id] = {
      embedding: item.embedding,
      contentHash: item.contentHash,
      createdAt: new Date().toISOString(),
    };
  }
  
  saveCache(cacheType, cache);
}

/**
 * Get all cached embeddings for a cache type
 * Useful for grouping operations
 */
export function getAllCachedEmbeddings(
  cacheType: "issues" | "discord"
): Map<string, Embedding> {
  const cache = loadCache(cacheType);
  const result = new Map<string, Embedding>();
  
  for (const [id, entry] of Object.entries(cache.entries)) {
    result.set(id, entry.embedding);
    // Also populate memory cache
    const memKey = `${cacheType}:${id}`;
    memoryCache.set(memKey, entry.embedding);
  }
  
  return result;
}

/**
 * Get cache statistics
 */
export function getCacheStats(cacheType: "issues" | "discord"): {
  count: number;
  cacheFile: string;
} {
  const cache = loadCache(cacheType);
  return {
    count: Object.keys(cache.entries).length,
    cacheFile: getCachePath(cacheType),
  };
}

/**
 * Clear cache (useful for testing or reset)
 */
export function clearCache(cacheType: "issues" | "discord"): void {
  const cache: EmbeddingCacheFile = {
    version: CACHE_VERSION,
    model: EMBEDDING_MODEL,
    entries: {},
  };
  saveCache(cacheType, cache);
  
  // Clear memory cache for this type
  for (const key of memoryCache.keys()) {
    if (key.startsWith(`${cacheType}:`)) {
      memoryCache.delete(key);
    }
  }
}

