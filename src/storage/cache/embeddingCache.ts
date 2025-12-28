/**
 * Shared embedding cache for semantic operations
 * Used by both classification and grouping
 * Persists embeddings to database (if available) or disk to avoid redundant API calls
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, statSync } from "fs";
import { join } from "path";
import { createHash } from "crypto";
import { getConfig } from "../../config/index.js";
import { prisma, checkPrismaConnection } from "../db/prisma.js";
import type { Prisma } from "@prisma/client";

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

/**
 * Get the embedding model from config
 */
function getEmbeddingModel(): string {
  const config = getConfig();
  return config.classification.embeddingModel;
}

// In-memory cache for fast access during runtime
const memoryCache: Map<string, Embedding> = new Map();

// Lazy-loaded cache files (loaded on first access, kept in memory)
const loadedCacheFiles: Map<"issues" | "discord", {
  cache: EmbeddingCacheFile;
  lastModified: number;
}> = new Map();

// Cache whether database is available (lazy initialization)
let dbAvailable: boolean | null = null;

/**
 * Check if database is available for storing embeddings
 */
async function isDatabaseAvailable(): Promise<boolean> {
  if (dbAvailable !== null) {
    return dbAvailable;
  }
  
  try {
    dbAvailable = await checkPrismaConnection();
    return dbAvailable;
  } catch {
    dbAvailable = false;
    return false;
  }
}

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
 * Load persistent cache from disk (with lazy loading - only loads when needed)
 * Uses in-memory cache to avoid repeated disk reads
 */
function loadCache(cacheType: "issues" | "discord"): EmbeddingCacheFile {
  const cachePath = getCachePath(cacheType);
  const currentModel = getEmbeddingModel();
  
  // Check if we have a cached version in memory
  const cached = loadedCacheFiles.get(cacheType);
  if (cached) {
    // Check if file has been modified since we loaded it
    try {
      if (existsSync(cachePath)) {
        const stats = statSync(cachePath);
        if (stats.mtimeMs === cached.lastModified) {
          // File hasn't changed, return cached version
          return cached.cache;
        }
      }
    } catch {
      // If we can't check mtime, use cached version anyway
      return cached.cache;
    }
  }
  
  // File not in cache or was modified, load from disk
  if (!existsSync(cachePath)) {
    const emptyCache = { version: CACHE_VERSION, model: currentModel, entries: {} };
    loadedCacheFiles.set(cacheType, { cache: emptyCache, lastModified: Date.now() });
    return emptyCache;
  }
  
  try {
    const data = readFileSync(cachePath, "utf-8");
    const cache = JSON.parse(data) as EmbeddingCacheFile;
    
    // Check version and model compatibility
    if (cache.version !== CACHE_VERSION || cache.model !== currentModel) {
      console.error(`[EmbeddingCache] Version/model mismatch for ${cacheType} (cached: ${cache.model}, current: ${currentModel}), starting fresh`);
      const emptyCache = { version: CACHE_VERSION, model: currentModel, entries: {} };
      loadedCacheFiles.set(cacheType, { cache: emptyCache, lastModified: Date.now() });
      return emptyCache;
    }
    
    // Cache in memory
    const stats = statSync(cachePath);
    loadedCacheFiles.set(cacheType, { cache, lastModified: stats.mtimeMs });
    return cache;
  } catch (error) {
    console.error(`[EmbeddingCache] Failed to load ${cacheType} cache, starting fresh`);
    const emptyCache = { version: CACHE_VERSION, model: currentModel, entries: {} };
    loadedCacheFiles.set(cacheType, { cache: emptyCache, lastModified: Date.now() });
    return emptyCache;
  }
}

/**
 * Save cache to disk (also updates in-memory cache)
 */
function saveCache(cacheType: "issues" | "discord", cache: EmbeddingCacheFile): void {
  const cachePath = getCachePath(cacheType);
  
  try {
    writeFileSync(cachePath, JSON.stringify(cache, null, 2), "utf-8");
    
    // Update in-memory cache with new mtime
    const stats = statSync(cachePath);
    loadedCacheFiles.set(cacheType, { cache, lastModified: stats.mtimeMs });
  } catch (error) {
    console.error(`[EmbeddingCache] Failed to save ${cacheType} cache:`, error);
  }
}

/**
 * Get cached embedding for an item
 * Returns undefined if not cached or content changed
 */
export async function getCachedEmbedding(
  cacheType: "issues" | "discord",
  id: string,
  contentHash: string
): Promise<Embedding | undefined> {
  // Check memory cache first
  const memKey = `${cacheType}:${id}`;
  if (memoryCache.has(memKey)) {
    return memoryCache.get(memKey);
  }
  
  // For issue embeddings, try database first if available
  if (cacheType === "issues" && await isDatabaseAvailable()) {
    try {
      const issueNumber = parseInt(id, 10);
      if (!isNaN(issueNumber)) {
        const currentModel = getEmbeddingModel();
        const result = await prisma.issueEmbedding.findUnique({
          where: { issueNumber },
          select: {
            embedding: true,
            contentHash: true,
            model: true,
          },
        });
        
        if (result && result.model === currentModel) {
          if (result.contentHash === contentHash) {
            // Content matches, use cached embedding
            const embedding = result.embedding as number[];
            memoryCache.set(memKey, embedding);
            return embedding;
          }
          // Content hash mismatch means issue changed, return undefined to re-embed
          return undefined;
        }
      }
    } catch (error) {
      // Database error, fall back to JSON cache
      console.error(`[EmbeddingCache] Database error, falling back to JSON:`, error);
    }
  }
  
  // For thread embeddings, try database first if available
  if (cacheType === "discord" && await isDatabaseAvailable()) {
    try {
      const currentModel = getEmbeddingModel();
      const result = await prisma.threadEmbedding.findUnique({
        where: { threadId: id },
        select: {
          embedding: true,
          contentHash: true,
          model: true,
        },
      });
      
      if (result && result.model === currentModel) {
        if (result.contentHash === contentHash) {
          // Content matches, use cached embedding
          const embedding = result.embedding as number[];
          memoryCache.set(memKey, embedding);
          return embedding;
        }
        // Content hash mismatch means thread changed, return undefined to re-embed
        return undefined;
      }
    } catch (error) {
      // Database error, fall back to JSON cache
      console.error(`[EmbeddingCache] Database error, falling back to JSON:`, error);
    }
  }
  
  // Fall back to disk cache (or for discord embeddings)
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
export async function setCachedEmbedding(
  cacheType: "issues" | "discord",
  id: string,
  contentHash: string,
  embedding: Embedding
): Promise<void> {
  // Save to memory cache
  const memKey = `${cacheType}:${id}`;
  memoryCache.set(memKey, embedding);
  
  // For issue embeddings, save to database first if available
  if (cacheType === "issues" && await isDatabaseAvailable()) {
    try {
      const issueNumber = parseInt(id, 10);
      if (!isNaN(issueNumber)) {
        const currentModel = getEmbeddingModel();
        await prisma.issueEmbedding.upsert({
          where: { issueNumber },
          update: {
            embedding: embedding as Prisma.InputJsonValue,
            contentHash,
            model: currentModel,
          },
          create: {
            issueNumber,
            embedding: embedding as Prisma.InputJsonValue,
            contentHash,
            model: currentModel,
          },
        });
        return; // Successfully saved to database, skip JSON cache
      }
    } catch (error) {
      // Database error, fall back to JSON cache
      console.error(`[EmbeddingCache] Database save error, falling back to JSON:`, error);
    }
  }
  
  // For thread embeddings, save to database first if available
  if (cacheType === "discord" && await isDatabaseAvailable()) {
    try {
      const currentModel = getEmbeddingModel();
      await prisma.threadEmbedding.upsert({
        where: { threadId: id },
        update: {
          embedding: embedding as Prisma.InputJsonValue,
          contentHash,
          model: currentModel,
        },
        create: {
          threadId: id,
          embedding: embedding as Prisma.InputJsonValue,
          contentHash,
          model: currentModel,
        },
      });
      return; // Successfully saved to database, skip JSON cache
    } catch (error) {
      // Database error, fall back to JSON cache
      console.error(`[EmbeddingCache] Database save error, falling back to JSON:`, error);
    }
  }
  
  // Fall back to disk cache (or for discord embeddings)
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
export async function batchSetCachedEmbeddings(
  cacheType: "issues" | "discord",
  items: Array<{ id: string; contentHash: string; embedding: Embedding }>
): Promise<void> {
  // For issue embeddings, save to database first if available
  if (cacheType === "issues" && await isDatabaseAvailable()) {
    try {
      const currentModel = getEmbeddingModel();
      const itemsToSave = items.filter(item => !isNaN(parseInt(item.id, 10)));
      
      if (itemsToSave.length > 0) {
        // Save to memory cache
        for (const item of itemsToSave) {
          const memKey = `${cacheType}:${item.id}`;
          memoryCache.set(memKey, item.embedding);
        }
        
        // Batch save in a single transaction
        await prisma.$transaction(async (tx) => {
          await Promise.all(itemsToSave.map((item) => {
            const issueNumber = parseInt(item.id, 10);
            return tx.issueEmbedding.upsert({
              where: { issueNumber },
              update: {
                embedding: item.embedding as Prisma.InputJsonValue,
                contentHash: item.contentHash,
                model: currentModel,
              },
              create: {
                issueNumber,
                embedding: item.embedding as Prisma.InputJsonValue,
                contentHash: item.contentHash,
                model: currentModel,
              },
            });
          }));
        });
        return; // Successfully saved to database, skip JSON cache
      }
    } catch (error) {
      // Database error, fall back to JSON cache
      console.error(`[EmbeddingCache] Database batch save error, falling back to JSON:`, error);
    }
  }
  
  // For thread embeddings, save to database first if available
  if (cacheType === "discord" && await isDatabaseAvailable()) {
    try {
      const currentModel = getEmbeddingModel();
      
      if (items.length > 0) {
        // Save to memory cache
        for (const item of items) {
          const memKey = `${cacheType}:${item.id}`;
          memoryCache.set(memKey, item.embedding);
        }
        
        // Batch save in a single transaction
        await prisma.$transaction(async (tx) => {
          await Promise.all(items.map((item) => {
            return tx.threadEmbedding.upsert({
              where: { threadId: item.id },
              update: {
                embedding: item.embedding as Prisma.InputJsonValue,
                contentHash: item.contentHash,
                model: currentModel,
              },
              create: {
                threadId: item.id,
                embedding: item.embedding as Prisma.InputJsonValue,
                contentHash: item.contentHash,
                model: currentModel,
              },
            });
          }));
        });
        return; // Successfully saved to database, skip JSON cache
      }
    } catch (error) {
      // Database error, fall back to JSON cache
      console.error(`[EmbeddingCache] Database batch save error, falling back to JSON:`, error);
    }
  }
  
  // Fall back to disk cache (or for discord embeddings)
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
export async function getAllCachedEmbeddings(
  cacheType: "issues" | "discord"
): Promise<Map<string, Embedding>> {
  // For issue embeddings, load from database first if available
  if (cacheType === "issues" && await isDatabaseAvailable()) {
    try {
      const currentModel = getEmbeddingModel();
      const embeddings = await prisma.issueEmbedding.findMany({
        where: { model: currentModel },
        select: {
          issueNumber: true,
          embedding: true,
        },
      });
      
      const embeddingsMap = new Map<string, Embedding>();
      for (const row of embeddings) {
        const id = row.issueNumber.toString();
        const embedding = row.embedding as number[];
        embeddingsMap.set(id, embedding);
        // Also populate memory cache
        const memKey = `${cacheType}:${id}`;
        memoryCache.set(memKey, embedding);
      }
      
      return embeddingsMap;
    } catch (error) {
      // Database error, fall back to JSON cache
      console.error(`[EmbeddingCache] Database load error, falling back to JSON:`, error);
    }
  }
  
  // For thread embeddings, load from database first if available
  if (cacheType === "discord" && await isDatabaseAvailable()) {
    try {
      const currentModel = getEmbeddingModel();
      const embeddings = await prisma.threadEmbedding.findMany({
        where: { model: currentModel },
        select: {
          threadId: true,
          embedding: true,
        },
      });
      
      const embeddingsMap = new Map<string, Embedding>();
      for (const row of embeddings) {
        const id = row.threadId;
        const embedding = row.embedding as number[];
        embeddingsMap.set(id, embedding);
        // Also populate memory cache
        const memKey = `${cacheType}:${id}`;
        memoryCache.set(memKey, embedding);
      }
      
      return embeddingsMap;
    } catch (error) {
      // Database error, fall back to JSON cache
      console.error(`[EmbeddingCache] Database load error, falling back to JSON:`, error);
    }
  }
  
  // Fall back to disk cache (or for discord embeddings)
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
export async function clearCache(cacheType: "issues" | "discord"): Promise<void> {
  // For issue embeddings, clear from database if available
  if (cacheType === "issues" && await isDatabaseAvailable()) {
    try {
      const currentModel = getEmbeddingModel();
      await prisma.issueEmbedding.deleteMany({
        where: { model: currentModel },
      });
    } catch (error) {
      console.error(`[EmbeddingCache] Database clear error:`, error);
    }
  }
  
  // Also clear JSON cache
  const cache: EmbeddingCacheFile = {
    version: CACHE_VERSION,
    model: getEmbeddingModel(),
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

