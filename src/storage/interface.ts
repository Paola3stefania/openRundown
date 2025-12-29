/**
 * Storage interface - allows switching between JSON and PostgreSQL
 */

import type { ClassifiedThread, Group, UngroupedThread, StorageStats } from "./types.js";
import type { DocumentationContent } from "../export/documentationFetcher.js";
import type { ProductFeature } from "../export/types.js";

/**
 * GitHub reactions object (from GitHub API)
 */
export interface GitHubReactions {
  url?: string;
  total_count: number;
  "+1"?: number;
  "-1"?: number;
  laugh?: number;
  hooray?: number;
  confused?: number;
  heart?: number;
  rocket?: number;
  eyes?: number;
}

export interface IStorage {
  // Channel operations
  upsertChannel(channelId: string, channelName?: string, guildId?: string): Promise<void>;
  
  // Discord message operations
  saveDiscordMessage(message: {
    id: string;
    channelId: string;
    authorId: string;
    authorUsername?: string;
    authorDiscriminator?: string;
    authorBot?: boolean;
    authorAvatar?: string;
    content: string;
    createdAt: string;
    editedAt?: string | null;
    timestamp: string;
    channelName?: string;
    guildId?: string;
    guildName?: string;
    attachments?: Array<{
      id: string;
      filename: string;
      url: string;
      size: number;
      content_type?: string;
    }>;
    embeds?: number;
    mentions?: string[];
    reactions?: Array<{
      emoji: string;
      count: number;
    }>;
    threadId?: string;
    threadName?: string;
    messageReference?: {
      message_id: string;
      channel_id: string;
      guild_id?: string;
    } | null;
    url?: string;
  }): Promise<void>;
  saveDiscordMessages(messages: Array<{
    id: string;
    channelId: string;
    authorId: string;
    authorUsername?: string;
    authorDiscriminator?: string;
    authorBot?: boolean;
    authorAvatar?: string;
    content: string;
    createdAt: string;
    editedAt?: string | null;
    timestamp: string;
    channelName?: string;
    guildId?: string;
    guildName?: string;
    attachments?: Array<{
      id: string;
      filename: string;
      url: string;
      size: number;
      content_type?: string;
    }>;
    embeds?: number;
    mentions?: string[];
    reactions?: Array<{
      emoji: string;
      count: number;
    }>;
    threadId?: string;
    threadName?: string;
    messageReference?: {
      message_id: string;
      channel_id: string;
      guild_id?: string;
    } | null;
    url?: string;
  }>): Promise<void>;
  
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
  
  // Documentation cache operations
  saveDocumentation(doc: DocumentationContent): Promise<void>;
  saveDocumentationMultiple(docs: DocumentationContent[]): Promise<void>;
  getDocumentation(url: string): Promise<DocumentationContent | null>;
  getDocumentationMultiple(urls: string[]): Promise<DocumentationContent[]>;
  getAllCachedDocumentation(): Promise<DocumentationContent[]>;
  clearDocumentationCache(): Promise<void>;
  
  // Feature cache operations
  saveFeatures(urls: string[], features: ProductFeature[], docCount: number): Promise<void>;
  getFeatures(urls: string[]): Promise<{ features: ProductFeature[]; extracted_at: string; documentation_count: number } | null>;
  clearFeaturesCache(): Promise<void>;
  
  // Classification history operations
  saveClassificationHistoryEntry(channelId: string, messageId: string, threadId?: string): Promise<void>;
  getClassificationHistory(channelId: string): Promise<Array<{ message_id: string; thread_id?: string; classified_at: string }>>;
  
  // GitHub issues operations
  saveGitHubIssue(issue: {
    number: number;
    title: string;
    url: string;
    state?: string;
    body?: string;
    labels?: string[];
    author?: string;
    created_at?: string;
    updated_at?: string;
  }): Promise<void>;
  saveGitHubIssues(issues: Array<{
    number: number;
    title: string;
    url: string;
    state?: string;
    body?: string;
    labels?: string[];
    author?: string;
    created_at?: string;
    updated_at?: string;
    comments?: Array<{
      id: number;
      body: string;
      user: { login: string; avatar_url: string };
      created_at: string;
      updated_at: string;
      html_url: string;
      reactions?: GitHubReactions | null;
    }>;
    assignees?: Array<{ login: string; avatar_url: string }>;
    milestone?: { title: string; state: string } | null;
    reactions?: GitHubReactions | null;
  }>): Promise<void>;
  getGitHubIssues(options?: {
    inGroup?: boolean;
    matchedToThreads?: boolean;
    state?: string;
  }): Promise<Array<{
    number: number;
    title: string;
    url: string;
    state?: string;
    body?: string;
    labels?: string[];
    author?: string;
    created_at?: string;
    updated_at?: string;
    in_group?: boolean;
    matched_to_threads?: boolean;
  }>>;
  
  // Stats
  getStats(channelId: string): Promise<StorageStats>;
  
  // Health check
  isAvailable(): Promise<boolean>;
}

