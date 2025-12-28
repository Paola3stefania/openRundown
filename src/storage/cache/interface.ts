/**
 * Storage interface for caching layer
 * Allows swapping filesystem implementation with database or other storage backends
 */
import type { DiscordCache } from "./discordCache.js";
import type { ClassificationHistory } from "./classificationHistory.js";
import type { IssuesCache } from "../../connectors/github/client.js";

export interface ICacheStorage {
  /**
   * Discord message cache operations
   */
  loadDiscordCache(cachePath: string): Promise<DiscordCache>;
  saveDiscordCache(cachePath: string, cache: DiscordCache): Promise<void>;
  discordCacheExists(cachePath: string): Promise<boolean>;

  /**
   * Classification history operations
   */
  loadClassificationHistory(historyPath: string): Promise<ClassificationHistory>;
  saveClassificationHistory(historyPath: string, history: ClassificationHistory): Promise<void>;
  classificationHistoryExists(historyPath: string): Promise<boolean>;

  /**
   * GitHub issues cache operations
   */
  loadGitHubIssuesCache(cachePath: string): Promise<IssuesCache | null>;
  saveGitHubIssuesCache(cachePath: string, cache: IssuesCache): Promise<void>;
  githubIssuesCacheExists(cachePath: string): Promise<boolean>;
}

