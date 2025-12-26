/**
 * Storage interface - allows switching between JSON and PostgreSQL
 */

import type { ClassifiedThread, Group, UngroupedThread, StorageStats } from "./types.js";

export interface IStorage {
  // Channel operations
  upsertChannel(channelId: string, channelName?: string, guildId?: string): Promise<void>;
  
  // Classification operations
  saveClassifiedThread(thread: ClassifiedThread): Promise<void>;
  saveClassifiedThreads(threads: ClassifiedThread[]): Promise<void>;
  getClassifiedThreads(channelId: string): Promise<ClassifiedThread[]>;
  getClassifiedThread(threadId: string): Promise<ClassifiedThread | null>;
  
  // Group operations
  saveGroup(group: Group): Promise<void>;
  saveGroups(groups: Group[]): Promise<void>;
  getGroups(channelId: string, options?: { status?: "pending" | "exported" }): Promise<Group[]>;
  getGroup(groupId: string): Promise<Group | null>;
  markGroupAsExported(groupId: string, linearIssueId: string, linearIssueUrl: string, projectIds?: string[]): Promise<void>;
  
  // Ungrouped threads
  saveUngroupedThread(thread: UngroupedThread): Promise<void>;
  saveUngroupedThreads(threads: UngroupedThread[]): Promise<void>;
  getUngroupedThreads(channelId: string): Promise<UngroupedThread[]>;
  
  // Stats
  getStats(channelId: string): Promise<StorageStats>;
  
  // Health check
  isAvailable(): Promise<boolean>;
}

