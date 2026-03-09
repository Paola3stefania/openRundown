/**
 * Persistent conversation memory with semantic search.
 *
 * Stores memory entries (conversation snippets, decisions, learnings) as text
 * with OpenAI embeddings in JSONB. Cosine similarity search is done in JS,
 * consistent with how the rest of OpenRundown handles embeddings.
 */

import { createHash } from "crypto";
import type { Prisma } from "@prisma/client";
import { prisma } from "./prisma.js";
import { createEmbedding } from "../../core/classify/semantic.js";
import { getConfig } from "../../config/index.js";
import { detectProjectId } from "../../config/project.js";

type Embedding = number[];

function getEmbeddingModel(): string {
  return getConfig().classification.embeddingModel;
}

function getOpenAIApiKey(): string | null {
  return process.env.OPENAI_API_KEY ?? null;
}

function hashContent(content: string): string {
  return createHash("md5").update(content).digest("hex");
}

function cosineSimilarity(a: Embedding, b: Embedding): number {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

export interface MemoryEntryResult {
  id: string;
  projectId: string;
  content: string;
  summary: string;
  tags: string[];
  source: string;
  createdAt: string;
  similarity?: number;
}

/**
 * Save a memory entry and generate its embedding.
 */
export async function saveMemory(options: {
  content: string;
  summary: string;
  tags?: string[];
  source?: string;
  projectId?: string;
}): Promise<MemoryEntryResult> {
  const projectId = options.projectId ?? detectProjectId();
  const model = getEmbeddingModel();
  const contentHash = hashContent(options.content);

  const entry = await prisma.memoryEntry.create({
    data: {
      projectId,
      content: options.content,
      summary: options.summary,
      tags: options.tags ?? [],
      source: options.source ?? "conversation",
    },
  });

  // Generate and store embedding (best-effort — don't fail the save if OpenAI is unavailable)
  const apiKey = getOpenAIApiKey();
  if (apiKey) {
    try {
      const embedding = await createEmbedding(options.content, apiKey);
      await prisma.memoryEntryEmbedding.create({
        data: {
          memoryId: entry.id,
          embedding: embedding as Prisma.InputJsonValue,
          contentHash,
          model,
        },
      });
    } catch (err) {
      console.error("[Memory] Failed to generate embedding:", err);
    }
  }

  return mapEntry(entry);
}

/**
 * Search memories semantically. Falls back to keyword search if no embeddings exist
 * or OpenAI is unavailable.
 */
export async function searchMemory(options: {
  query: string;
  limit?: number;
  projectId?: string;
  tags?: string[];
}): Promise<MemoryEntryResult[]> {
  const projectId = options.projectId ?? detectProjectId();
  const limit = options.limit ?? 5;
  const apiKey = getOpenAIApiKey();

  const tagFilter = options.tags && options.tags.length > 0
    ? { tags: { hasSome: options.tags } }
    : {};

  // Try semantic search first
  if (apiKey) {
    try {
      const queryEmbedding = await createEmbedding(options.query, apiKey);

      const entries = await prisma.memoryEntry.findMany({
        where: { projectId, ...tagFilter },
        include: { embedding: true },
        orderBy: { createdAt: "desc" },
        take: 200, // fetch more, re-rank by similarity
      });

      const withSimilarity = entries
        .map((entry) => {
          if (!entry.embedding) return { entry, similarity: 0 };
          const vec = entry.embedding.embedding as number[];
          return { entry, similarity: cosineSimilarity(queryEmbedding, vec) };
        })
        .filter((e) => e.similarity > 0.3)
        .sort((a, b) => b.similarity - a.similarity)
        .slice(0, limit);

      if (withSimilarity.length > 0) {
        return withSimilarity.map(({ entry, similarity }) => ({
          ...mapEntry(entry),
          similarity,
        }));
      }
    } catch (err) {
      console.error("[Memory] Semantic search failed, falling back to keyword:", err);
    }
  }

  // Fallback: keyword search
  const entries = await prisma.memoryEntry.findMany({
    where: {
      projectId,
      ...tagFilter,
      OR: [
        { content: { contains: options.query, mode: "insensitive" } },
        { summary: { contains: options.query, mode: "insensitive" } },
      ],
    },
    orderBy: { createdAt: "desc" },
    take: limit,
  });

  return entries.map(mapEntry);
}

/**
 * List recent memories without search.
 */
export async function getRecentMemories(options: {
  limit?: number;
  projectId?: string;
  tags?: string[];
}): Promise<MemoryEntryResult[]> {
  const projectId = options.projectId ?? detectProjectId();
  const tagFilter = options.tags && options.tags.length > 0
    ? { tags: { hasSome: options.tags } }
    : {};

  const entries = await prisma.memoryEntry.findMany({
    where: { projectId, ...tagFilter },
    orderBy: { createdAt: "desc" },
    take: options.limit ?? 10,
  });

  return entries.map(mapEntry);
}

/**
 * Delete a memory entry by id.
 */
export async function deleteMemory(id: string): Promise<boolean> {
  try {
    await prisma.memoryEntry.delete({ where: { id } });
    return true;
  } catch {
    return false;
  }
}

function mapEntry(entry: {
  id: string;
  projectId: string;
  content: string;
  summary: string;
  tags: string[];
  source: string;
  createdAt: Date;
}): MemoryEntryResult {
  return {
    id: entry.id,
    projectId: entry.projectId,
    content: entry.content,
    summary: entry.summary,
    tags: entry.tags,
    source: entry.source,
    createdAt: entry.createdAt.toISOString(),
  };
}
