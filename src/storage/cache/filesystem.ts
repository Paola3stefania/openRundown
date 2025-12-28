/**
 * Filesystem implementation of cache storage
 */
import { readFile, writeFile, mkdir } from "fs/promises";
import { existsSync } from "fs";
import { join, dirname } from "path";
import type { ICacheStorage } from "./interface.js";
import type { DiscordCache } from "./discordCache.js";
import type { ClassificationHistory } from "./classificationHistory.js";
import type { IssuesCache } from "../../connectors/github/client.js";

export class FilesystemCacheStorage implements ICacheStorage {
  async loadDiscordCache(cachePath: string): Promise<DiscordCache> {
    const { loadDiscordCache } = await import("./discordCache.js");
    return loadDiscordCache(cachePath);
  }

  async saveDiscordCache(cachePath: string, cache: DiscordCache): Promise<void> {
    const filePath = cachePath.startsWith("/") ? cachePath : join(process.cwd(), cachePath);
    
    // Ensure directory exists
    await mkdir(dirname(filePath), { recursive: true });
    
    await writeFile(filePath, JSON.stringify(cache, null, 2), "utf-8");
  }

  async discordCacheExists(cachePath: string): Promise<boolean> {
    const filePath = cachePath.startsWith("/") ? cachePath : join(process.cwd(), cachePath);
    return existsSync(filePath);
  }

  async loadClassificationHistory(historyPath: string): Promise<ClassificationHistory> {
    const { loadClassificationHistory } = await import("./classificationHistory.js");
    const { dirname } = await import("path");
    const resultsDir = dirname(historyPath) || "results";
    return loadClassificationHistory(resultsDir);
  }

  async saveClassificationHistory(historyPath: string, history: ClassificationHistory): Promise<void> {
    const { saveClassificationHistory: saveHistory } = await import("./classificationHistory.js");
    const { dirname, join } = await import("path");
    const resultsDir = dirname(historyPath) || "results";
    await saveHistory(history, resultsDir);
  }

  async classificationHistoryExists(historyPath: string): Promise<boolean> {
    return existsSync(historyPath);
  }

  async loadGitHubIssuesCache(cachePath: string): Promise<IssuesCache | null> {
    const filePath = cachePath.startsWith("/") ? cachePath : join(process.cwd(), cachePath);
    const content = await readFile(filePath, "utf-8");
    return JSON.parse(content);
  }

  async saveGitHubIssuesCache(cachePath: string, cache: IssuesCache): Promise<void> {
    const filePath = cachePath.startsWith("/") ? cachePath : join(process.cwd(), cachePath);
    
    // Ensure directory exists
    await mkdir(dirname(filePath), { recursive: true });
    
    await writeFile(filePath, JSON.stringify(cache, null, 2), "utf-8");
  }

  async githubIssuesCacheExists(cachePath: string): Promise<boolean> {
    const filePath = cachePath.startsWith("/") ? cachePath : join(process.cwd(), cachePath);
    return existsSync(filePath);
  }
}

// Default filesystem storage instance
export const defaultCacheStorage = new FilesystemCacheStorage();

