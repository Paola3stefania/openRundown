/**
 * JSON file-based storage implementation
 * Wraps existing file-based logic for classifications and groupings
 */

import type { IStorage, GitHubReactions } from "../interface.js";
import type { ClassifiedThread, Group, UngroupedThread, StorageStats } from "../types.js";
import type { DocumentationContent } from "../../export/documentationFetcher.js";
import type { ProductFeature } from "../../export/types.js";
import type { GitHubIssue, IssuesCache } from "../../connectors/github/client.js";
import { readFile, writeFile, mkdir, readdir } from "fs/promises";
import { existsSync } from "fs";
import { join } from "path";
import { getConfig } from "../../config/index.js";

export class JsonStorage implements IStorage {
  private resultsDir: string;

  constructor() {
    const config = getConfig();
    this.resultsDir = join(process.cwd(), config.paths.resultsDir || "results");
  }

  async upsertChannel(channelId: string, channelName?: string, guildId?: string): Promise<void> {
    // JSON storage doesn't need explicit channel tracking
    // Channels are implicit in file names
  }

  async saveDiscordMessage(message: {
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
  }): Promise<void> {
    await this.saveDiscordMessages([message]);
  }

  async saveDiscordMessages(messages: Array<{
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
  }>): Promise<void> {
    // JSON storage for Discord messages is handled in the fetch handler
    // which writes directly to cache files. This is a no-op for JSON storage
    // as the messages are already saved to JSON cache files in the fetch handler.
    // If we're using JSON storage, it means DB is not available, and the
    // fetch handler will handle JSON caching directly.
  }

  async saveClassifiedThread(thread: ClassifiedThread): Promise<void> {
    await this.saveClassifiedThreads([thread]);
  }

  async saveClassifiedThreads(threads: ClassifiedThread[]): Promise<void> {
    if (threads.length === 0) return;

    await mkdir(this.resultsDir, { recursive: true });

    // Group threads by channel
    const threadsByChannel = new Map<string, ClassifiedThread[]>();
    for (const thread of threads) {
      if (!threadsByChannel.has(thread.channel_id)) {
        threadsByChannel.set(thread.channel_id, []);
      }
      threadsByChannel.get(thread.channel_id)!.push(thread);
    }

    // Save each channel's threads
    for (const [channelId, channelThreads] of threadsByChannel) {
      // Find existing file for this channel
      const existingFiles = await readdir(this.resultsDir).catch(() => []);
      const matchingFiles = existingFiles
        .filter(f => f.startsWith(`discord-classified-`) && f.includes(channelId) && f.endsWith('.json'));

      let outputPath: string;
      let existingThreads: ClassifiedThread[] = [];

      // Find file with most threads
      let bestFile: string | null = null;
      let maxThreads = 0;

      for (const file of matchingFiles) {
        try {
          const filePath = join(this.resultsDir, file);
          const content = await readFile(filePath, "utf-8");
          const parsed = JSON.parse(content);
          const threadCount = parsed.classified_threads?.length || 0;

          if (threadCount > maxThreads) {
            maxThreads = threadCount;
            bestFile = file;
          }
        } catch {
          continue;
        }
      }

      if (bestFile) {
        outputPath = join(this.resultsDir, bestFile);
        try {
          const content = await readFile(outputPath, "utf-8");
          const parsed = JSON.parse(content);
          existingThreads = parsed.classified_threads || [];
        } catch {
          // If file can't be read, create new one
          outputPath = join(this.resultsDir, `discord-classified-${channelId}-${Date.now()}.json`);
        }
      } else {
        outputPath = join(this.resultsDir, `discord-classified-${channelId}-${Date.now()}.json`);
      }

      // Merge threads
      interface LegacyThreadFormat {
        thread?: {
          thread_id: string;
          thread_name?: string;
          message_count?: number;
          first_message_id?: string;
          first_message_author?: string;
          first_message_timestamp?: string;
          first_message_url?: string;
          classified_at?: string;
          classified_status?: string;
        };
        thread_id?: string;
        issues?: Array<{
          number: number;
          title: string;
          state: string;
          url: string;
          similarity_score: number;
        }>;
      }
      
      const threadMap = new Map<string, ClassifiedThread | LegacyThreadFormat>();
      for (const thread of existingThreads) {
        const threadData = thread as ClassifiedThread | LegacyThreadFormat;
        const threadId = ('thread' in threadData && threadData.thread ? threadData.thread.thread_id : undefined) || threadData.thread_id;
        if (threadId) threadMap.set(threadId, threadData);
      }
      for (const thread of channelThreads) {
        const legacyThread: LegacyThreadFormat = {
          thread: {
            thread_id: thread.thread_id,
            thread_name: thread.thread_name,
            message_count: thread.message_count,
            first_message_id: thread.first_message_id,
            first_message_author: thread.first_message_author,
            first_message_timestamp: thread.first_message_timestamp,
            first_message_url: thread.first_message_url,
            classified_status: thread.status,
          },
          issues: thread.issues,
        };
        threadMap.set(thread.thread_id, legacyThread);
      }

      const mergedThreads = Array.from(threadMap.values());

      // Save to file
      await writeFile(outputPath, JSON.stringify({
        channel_id: channelId,
        analysis_date: new Date().toISOString(),
        summary: {
          total_threads_in_file: mergedThreads.length,
          newly_classified: channelThreads.length,
          previously_classified: existingThreads.length,
        },
        classified_threads: mergedThreads,
      }, null, 2), "utf-8");
    }
  }

  async getClassifiedThreads(channelId: string): Promise<ClassifiedThread[]> {
    const existingFiles = await readdir(this.resultsDir).catch(() => []);
    const matchingFiles = existingFiles
      .filter(f => f.startsWith(`discord-classified-`) && f.includes(channelId) && f.endsWith('.json'));

    // Find file with most threads
    let bestFile: string | null = null;
    let maxThreads = 0;

    for (const file of matchingFiles) {
      try {
        const filePath = join(this.resultsDir, file);
        const content = await readFile(filePath, "utf-8");
        const parsed = JSON.parse(content);
        const threadCount = parsed.classified_threads?.length || 0;

        if (threadCount > maxThreads) {
          maxThreads = threadCount;
          bestFile = file;
        }
      } catch {
        continue;
      }
    }

    if (!bestFile) {
      return [];
    }

    const filePath = join(this.resultsDir, bestFile);
    const content = await readFile(filePath, "utf-8");
    const parsed = JSON.parse(content);
    const threads = parsed.classified_threads || [];

    interface LegacyThreadFormat {
      thread?: {
        thread_id: string;
        thread_name?: string;
        message_count?: number;
        first_message_id?: string;
        first_message_author?: string;
        first_message_timestamp?: string;
        first_message_url?: string;
        classified_at?: string;
        classified_status?: string;
      };
      thread_id?: string;
      issues?: Array<{
        number: number;
        title: string;
        state: string;
        url: string;
        similarity_score: number;
      }>;
    }
    
    return threads.map((t: ClassifiedThread | LegacyThreadFormat): ClassifiedThread => {
      const isLegacy = 'thread' in t && t.thread;
      if (isLegacy) {
        const legacy = t as LegacyThreadFormat;
        return {
          thread_id: legacy.thread!.thread_id,
          channel_id: channelId,
          thread_name: legacy.thread!.thread_name,
          message_count: legacy.thread!.message_count || 1,
          first_message_id: legacy.thread!.first_message_id || legacy.thread!.thread_id,
          first_message_author: legacy.thread!.first_message_author,
          first_message_timestamp: legacy.thread!.first_message_timestamp,
          first_message_url: legacy.thread!.first_message_url,
          classified_at: legacy.thread!.classified_at || new Date().toISOString(),
          status: (legacy.thread!.classified_status as "pending" | "classifying" | "completed" | "failed") || "completed",
          issues: legacy.issues || [],
        };
      } else {
        return t as ClassifiedThread;
      }
    });
  }

  async getClassifiedThread(threadId: string): Promise<ClassifiedThread | null> {
    interface LegacyThreadFormat {
      thread?: {
        thread_id: string;
        thread_name?: string;
        message_count?: number;
        first_message_id?: string;
        first_message_author?: string;
        first_message_timestamp?: string;
        first_message_url?: string;
        classified_at?: string;
        classified_status?: string;
      };
      thread_id?: string;
      issues?: Array<{
        number: number;
        title: string;
        state: string;
        url: string;
        similarity_score: number;
      }>;
    }
    
    // Search all classification files
    const existingFiles = await readdir(this.resultsDir).catch(() => []);
    const classificationFiles = existingFiles.filter(f => f.startsWith(`discord-classified-`) && f.endsWith('.json'));

    for (const file of classificationFiles) {
      try {
        const filePath = join(this.resultsDir, file);
        const content = await readFile(filePath, "utf-8");
        const parsed = JSON.parse(content);
        const threads = parsed.classified_threads || [];

        for (const t of threads) {
          const threadData = t as ClassifiedThread | LegacyThreadFormat;
          const isLegacy = 'thread' in threadData && threadData.thread;
          let tId: string;
          if (isLegacy) {
            const legacy = threadData as LegacyThreadFormat;
            tId = legacy.thread!.thread_id;
          } else {
            tId = (threadData as ClassifiedThread).thread_id;
          }
          
          if (tId === threadId) {
            if (isLegacy) {
              const legacy = threadData as LegacyThreadFormat;
              return {
                thread_id: tId,
                channel_id: parsed.channel_id,
                thread_name: legacy.thread!.thread_name,
                message_count: legacy.thread!.message_count || 1,
                first_message_id: legacy.thread!.first_message_id || tId,
                first_message_author: legacy.thread!.first_message_author,
                first_message_timestamp: legacy.thread!.first_message_timestamp,
                first_message_url: legacy.thread!.first_message_url,
                classified_at: legacy.thread!.classified_at || new Date().toISOString(),
                status: (legacy.thread!.classified_status as "pending" | "classifying" | "completed" | "failed") || "completed",
                issues: legacy.issues || [],
              };
            } else {
              return threadData as ClassifiedThread;
            }
          }
        }
      } catch {
        continue;
      }
    }

    return null;
  }

  async saveGroup(group: Group): Promise<void> {
    await this.saveGroups([group]);
  }

  async saveGroups(groups: Group[]): Promise<void> {
    if (groups.length === 0) return;

    await mkdir(this.resultsDir, { recursive: true });

    // Group by channel
    const groupsByChannel = new Map<string, Group[]>();
    for (const group of groups) {
      if (!groupsByChannel.has(group.channel_id)) {
        groupsByChannel.set(group.channel_id, []);
      }
      groupsByChannel.get(group.channel_id)!.push(group);
    }

    for (const [channelId, channelGroups] of groupsByChannel) {
      // Find existing grouping file
      const existingFiles = await readdir(this.resultsDir).catch(() => []);
      const existingFile = existingFiles
        .filter(f => f.startsWith(`grouping-`) && f.includes(channelId) && f.endsWith('.json'))
        .sort()
        .reverse()[0];

      let outputPath: string;
      let existingGroups: Group[] = [];

      if (existingFile) {
        outputPath = join(this.resultsDir, existingFile);
        try {
          const content = await readFile(outputPath, "utf-8");
          const parsed = JSON.parse(content);
          existingGroups = parsed.groups || [];
        } catch {
          outputPath = join(this.resultsDir, `grouping-${channelId}-${Date.now()}.json`);
        }
      } else {
        outputPath = join(this.resultsDir, `grouping-${channelId}-${Date.now()}.json`);
      }

      // Merge groups
      const groupMap = new Map<string, Group>();
      for (const group of existingGroups) {
        groupMap.set(group.id, group);
      }
      for (const group of channelGroups) {
        groupMap.set(group.id, group);
      }

      const mergedGroups = Array.from(groupMap.values());

      await writeFile(outputPath, JSON.stringify({
        timestamp: new Date().toISOString(),
        channel_id: channelId,
        grouping_method: "issue-based",
        stats: {
          total_groups_in_file: mergedGroups.length,
        },
        groups: mergedGroups,
      }, null, 2), "utf-8");
    }
  }

  async getGroup(groupId: string): Promise<Group | null> {
    interface LegacyGroupFormat {
      id?: string;
      github_issue?: {
        number?: number;
        title?: string;
      };
      suggested_title?: string;
      avg_similarity?: number;
      thread_count?: number;
      threads?: Array<{
        thread_id: string;
        thread_name?: string;
        similarity_score: number;
      }>;
      is_cross_cutting?: boolean;
      status?: string;
      created_at?: string;
      updated_at?: string;
      exported_at?: string;
      linear_issue_id?: string;
      linear_issue_url?: string;
      linear_issue_identifier?: string;
      linear_project_ids?: string[];
      affects_features?: Array<{ id: string; name: string }>;
    }
    
    // Search all grouping files
    const existingFiles = await readdir(this.resultsDir).catch(() => []);
    const groupingFiles = existingFiles.filter(f => f.startsWith(`grouping-`) && f.endsWith('.json'));

    for (const file of groupingFiles) {
      try {
        const filePath = join(this.resultsDir, file);
        const content = await readFile(filePath, "utf-8");
        const parsed = JSON.parse(content);
        const groups = parsed.groups || [];

        for (const g of groups) {
          const groupData = g as Group | LegacyGroupFormat;
          if (groupData.id === groupId) {
            const isLegacy = 'github_issue' in groupData && groupData.github_issue && !('github_issue_number' in groupData);
            if (isLegacy) {
              const legacy = groupData as LegacyGroupFormat;
              return {
                id: legacy.id || "",
                channel_id: parsed.channel_id,
                github_issue_number: legacy.github_issue?.number,
                suggested_title: legacy.suggested_title || legacy.github_issue?.title || "Untitled Group",
                avg_similarity: legacy.avg_similarity || 0,
                thread_count: legacy.thread_count || legacy.threads?.length || 0,
                is_cross_cutting: legacy.is_cross_cutting || false,
                status: (legacy.status as "pending" | "exported") || "pending",
                created_at: legacy.created_at || parsed.timestamp || new Date().toISOString(),
                updated_at: legacy.updated_at || parsed.timestamp || new Date().toISOString(),
                exported_at: legacy.exported_at,
                linear_issue_id: legacy.linear_issue_id,
                linear_issue_url: legacy.linear_issue_url,
                linear_issue_identifier: legacy.linear_issue_identifier,
                linear_project_ids: legacy.linear_project_ids,
                affects_features: legacy.affects_features,
                threads: legacy.threads?.map(t => ({
                  thread_id: t.thread_id,
                  thread_name: t.thread_name,
                  similarity_score: t.similarity_score,
                })) || [],
              };
            } else {
              return groupData as Group;
            }
          }
        }
      } catch {
        continue;
      }
    }
    
    return null;
  }
  
  async updateGroupStatus(groupId: string, status: "pending" | "exported"): Promise<void> {
    const existingFiles = await readdir(this.resultsDir).catch(() => []);
    const groupingFiles = existingFiles.filter(f => f.startsWith(`grouping-`) && f.endsWith('.json'));

    for (const file of groupingFiles) {
      try {
        const filePath = join(this.resultsDir, file);
        const content = await readFile(filePath, "utf-8");
        const parsed = JSON.parse(content);
        const groups = parsed.groups || [];

        let found = false;
        for (const g of groups) {
          if (g.id === groupId) {
            g.status = status;
            g.updated_at = new Date().toISOString();
            if (status === "exported") {
              g.exported_at = new Date().toISOString();
            }
            found = true;
            break;
          }
        }

        if (found) {
          await writeFile(filePath, JSON.stringify(parsed, null, 2), "utf-8");
          return;
        }
      } catch {
        continue;
      }
    }

    throw new Error(`Group ${groupId} not found`);
  }

  async addGroup(group: Group): Promise<void> {
    const outputPath = join(this.resultsDir, `grouping-${group.channel_id}-${Date.now()}.json`);
    await writeFile(outputPath, JSON.stringify({
      timestamp: new Date().toISOString(),
      channel_id: group.channel_id,
      grouping_method: "manual",
      stats: {
        totalThreads: 0,
        groupedThreads: 0,
        ungroupedThreads: 0,
        uniqueIssues: 0,
        multiThreadGroups: 0,
        singleThreadGroups: 0,
      },
      groups: [group],
    }, null, 2), "utf-8");
  }

  async getGroups(channelId: string, options?: { status?: "pending" | "exported" }): Promise<Group[]> {
    const existingFiles = await readdir(this.resultsDir).catch(() => []);
    const matchingFiles = existingFiles.filter(f => f.startsWith(`grouping-`) && f.includes(channelId) && f.endsWith('.json'));
    
    let bestFile: string | null = null;
    let maxGroups = 0;

    for (const file of matchingFiles) {
      try {
        const filePath = join(this.resultsDir, file);
        const content = await readFile(filePath, "utf-8");
        const parsed = JSON.parse(content);
        const groupCount = parsed.groups?.length || 0;

        if (groupCount > maxGroups) {
          maxGroups = groupCount;
          bestFile = file;
        }
      } catch {
        continue;
      }
    }

    if (!bestFile) {
      return [];
    }

    const filePath = join(this.resultsDir, bestFile);
    const content = await readFile(filePath, "utf-8");
    const parsed = JSON.parse(content);
    let groups = parsed.groups || [];

    if (options?.status) {
      groups = groups.filter((g: Group | LegacyGroupFormat) => ('status' in g ? (g as Group).status === options.status : false));
    }

    interface LegacyGroupFormat {
      id?: string;
      github_issue?: {
        number?: number;
        title?: string;
      };
      suggested_title?: string;
      avg_similarity?: number;
      thread_count?: number;
      threads?: Array<{
        thread_id: string;
        thread_name?: string;
        similarity_score: number;
      }>;
      is_cross_cutting?: boolean;
      status?: string;
      created_at?: string;
      updated_at?: string;
      exported_at?: string;
      linear_issue_id?: string;
      linear_issue_url?: string;
      linear_issue_identifier?: string;
      linear_project_ids?: string[];
      affects_features?: Array<{ id: string; name: string }>;
    }
    
    return groups.map((g: Group | LegacyGroupFormat): Group => {
      const isLegacy = 'github_issue' in g && g.github_issue && !('github_issue_number' in g);
      if (isLegacy) {
        const legacy = g as LegacyGroupFormat;
        return {
          id: legacy.id || "",
          channel_id: channelId,
          github_issue_number: legacy.github_issue?.number,
          suggested_title: legacy.suggested_title || legacy.github_issue?.title || "Untitled Group",
          avg_similarity: legacy.avg_similarity || 0,
          thread_count: legacy.thread_count || legacy.threads?.length || 0,
          is_cross_cutting: legacy.is_cross_cutting || false,
          status: (legacy.status as "pending" | "exported") || "pending",
          created_at: legacy.created_at || parsed.timestamp || new Date().toISOString(),
          updated_at: legacy.updated_at || parsed.timestamp || new Date().toISOString(),
          exported_at: legacy.exported_at,
          linear_issue_id: legacy.linear_issue_id,
          linear_issue_url: legacy.linear_issue_url,
          linear_issue_identifier: legacy.linear_issue_identifier,
          linear_project_ids: legacy.linear_project_ids,
          affects_features: legacy.affects_features,
          threads: legacy.threads?.map(t => ({
            thread_id: t.thread_id,
            thread_name: t.thread_name,
            similarity_score: t.similarity_score,
          })) || [],
        };
      } else {
        return g as Group;
      }
    });
  }

  async markGroupAsExported(groupId: string, linearIssueId: string, linearIssueUrl: string, projectIds?: string[]): Promise<void> {
    const group = await this.getGroup(groupId);
    if (!group) {
      throw new Error(`Group ${groupId} not found`);
    }

    group.status = "exported";
    group.exported_at = new Date().toISOString();
    group.linear_issue_id = linearIssueId;
    group.linear_issue_url = linearIssueUrl;
    group.linear_project_ids = projectIds;
    group.updated_at = new Date().toISOString();

    await this.saveGroup(group);
  }

  async saveUngroupedThread(thread: UngroupedThread): Promise<void> {
    await this.saveUngroupedThreads([thread]);
  }

  async saveUngroupedThreads(threads: UngroupedThread[]): Promise<void> {
    if (threads.length === 0) return;

    await mkdir(this.resultsDir, { recursive: true });

    // Group by channel
    const threadsByChannel = new Map<string, UngroupedThread[]>();
    for (const thread of threads) {
      if (!threadsByChannel.has(thread.channel_id)) {
        threadsByChannel.set(thread.channel_id, []);
      }
      threadsByChannel.get(thread.channel_id)!.push(thread);
    }

    for (const [channelId, channelThreads] of threadsByChannel) {
      // Find existing grouping file (ungrouped threads are stored with groups)
      const existingFiles = await readdir(this.resultsDir).catch(() => []);
      const existingFile = existingFiles
        .filter(f => f.startsWith(`grouping-`) && f.includes(channelId) && f.endsWith('.json'))
        .sort()
        .reverse()[0];

      let outputPath: string;
      let existingUngrouped: UngroupedThread[] = [];

      if (existingFile) {
        outputPath = join(this.resultsDir, existingFile);
        try {
          const content = await readFile(outputPath, "utf-8");
          const parsed = JSON.parse(content);
          existingUngrouped = parsed.ungrouped_threads || [];
        } catch {
          outputPath = join(this.resultsDir, `grouping-${channelId}-${Date.now()}.json`);
        }
      } else {
        outputPath = join(this.resultsDir, `grouping-${channelId}-${Date.now()}.json`);
      }

      // Merge ungrouped threads
      const threadMap = new Map<string, UngroupedThread>();
      for (const thread of existingUngrouped) {
        threadMap.set(thread.thread_id, thread);
      }
      for (const thread of channelThreads) {
        threadMap.set(thread.thread_id, thread);
      }

      const mergedUngrouped = Array.from(threadMap.values());

      // Load existing groups if file exists
      let existingGroups: Group[] = [];
      if (existingFile) {
        try {
          const content = await readFile(outputPath, "utf-8");
          const parsed = JSON.parse(content);
          existingGroups = parsed.groups || [];
        } catch {
          // Ignore
        }
      }

      await writeFile(outputPath, JSON.stringify({
        timestamp: new Date().toISOString(),
        channel_id: channelId,
        grouping_method: "issue-based",
        stats: {
          total_ungrouped_in_file: mergedUngrouped.length,
        },
        groups: existingGroups,
        ungrouped_threads: mergedUngrouped,
      }, null, 2), "utf-8");
    }
  }

  async getUngroupedThreads(channelId: string): Promise<UngroupedThread[]> {
    const existingFiles = await readdir(this.resultsDir).catch(() => []);
    const existingFile = existingFiles
      .filter(f => f.startsWith(`grouping-`) && f.includes(channelId) && f.endsWith('.json'))
      .sort()
      .reverse()[0];

    if (!existingFile) {
      return [];
    }

    const filePath = join(this.resultsDir, existingFile);
    const content = await readFile(filePath, "utf-8");
    const parsed = JSON.parse(content);
    const ungrouped = parsed.ungrouped_threads || [];

    return ungrouped.map((t: UngroupedThread | { thread_id?: string; thread_name?: string; url?: string; author?: string; timestamp?: string; reason?: string; top_issue?: unknown; export_status?: string; exported_at?: string; linear_issue_id?: string; linear_issue_url?: string; linear_issue_identifier?: string }) => ({
      thread_id: t.thread_id,
      channel_id: channelId,
      thread_name: t.thread_name,
      url: t.url,
      author: t.author,
      timestamp: t.timestamp,
      reason: t.reason,
      top_issue: t.top_issue,
    }));
  }

  async getStats(channelId: string): Promise<StorageStats> {
    const threads = await this.getClassifiedThreads(channelId);
    const groups = await this.getGroups(channelId);
    const ungrouped = await this.getUngroupedThreads(channelId);

    const uniqueIssues = new Set<number>();
    for (const thread of threads) {
      for (const issue of thread.issues) {
        uniqueIssues.add(issue.number);
      }
    }

    const multiThreadGroups = groups.filter(g => g.thread_count > 1).length;
    const singleThreadGroups = groups.filter(g => g.thread_count === 1).length;

    return {
      totalThreads: threads.length,
      groupedThreads: groups.reduce((sum, g) => sum + g.thread_count, 0),
      ungroupedThreads: ungrouped.length,
      uniqueIssues: uniqueIssues.size,
      multiThreadGroups,
      singleThreadGroups,
    };
  }

  async isAvailable(): Promise<boolean> {
    try {
      await mkdir(this.resultsDir, { recursive: true });
      return true;
    } catch {
      return false;
    }
  }

  async saveDocumentation(doc: DocumentationContent): Promise<void> {
    await this.saveDocumentationMultiple([doc]);
  }

  async saveDocumentationMultiple(docs: DocumentationContent[]): Promise<void> {
    if (docs.length === 0) return;

    await mkdir(this.resultsDir, { recursive: true });

    const cacheFile = join(this.resultsDir, "documentation-cache.json");
    
    // Load existing cache
    let cache: Record<string, DocumentationContent> = {};
    if (existsSync(cacheFile)) {
      try {
        const content = await readFile(cacheFile, "utf-8");
        cache = JSON.parse(content);
      } catch {
        // If file is corrupted, start fresh
        cache = {};
      }
    }

    // Update cache with new docs
    for (const doc of docs) {
      cache[doc.url] = doc;
    }

    // Save back to file
    await writeFile(cacheFile, JSON.stringify(cache, null, 2), "utf-8");
  }

  async getDocumentation(url: string): Promise<DocumentationContent | null> {
    const cacheFile = join(this.resultsDir, "documentation-cache.json");
    
    if (!existsSync(cacheFile)) {
      return null;
    }

    try {
      const content = await readFile(cacheFile, "utf-8");
      const cache: Record<string, DocumentationContent> = JSON.parse(content);
      return cache[url] || null;
    } catch {
      return null;
    }
  }

  async getDocumentationMultiple(urls: string[]): Promise<DocumentationContent[]> {
    if (urls.length === 0) return [];

    const cacheFile = join(this.resultsDir, "documentation-cache.json");
    
    if (!existsSync(cacheFile)) {
      return [];
    }

    try {
      const content = await readFile(cacheFile, "utf-8");
      const cache: Record<string, DocumentationContent> = JSON.parse(content);
      
      const results: DocumentationContent[] = [];
      for (const url of urls) {
        if (cache[url]) {
          results.push(cache[url]);
        }
      }
      return results;
    } catch {
      return [];
    }
  }

  async getAllCachedDocumentation(): Promise<DocumentationContent[]> {
    const cacheFile = join(this.resultsDir, "documentation-cache.json");
    
    if (!existsSync(cacheFile)) {
      return [];
    }

    try {
      const content = await readFile(cacheFile, "utf-8");
      const cache: Record<string, DocumentationContent> = JSON.parse(content);
      return Object.values(cache);
    } catch {
      return [];
    }
  }

  async clearDocumentationCache(): Promise<void> {
    const cacheFile = join(this.resultsDir, "documentation-cache.json");
    if (existsSync(cacheFile)) {
      await writeFile(cacheFile, JSON.stringify({}, null, 2), "utf-8");
    }
  }

  async saveFeatures(urls: string[], features: ProductFeature[], docCount: number): Promise<void> {
    const cacheFile = join(this.resultsDir, "features-cache.json");
    await mkdir(this.resultsDir, { recursive: true });
    
    // Sort URLs for consistent comparison
    const sortedUrls = [...urls].sort();
    
    const cached = {
      urls: sortedUrls,
      features,
      extracted_at: new Date().toISOString(),
      documentation_count: docCount,
    };
    
    await writeFile(cacheFile, JSON.stringify(cached, null, 2), "utf-8");
  }

  async getFeatures(urls: string[]): Promise<{ features: ProductFeature[]; extracted_at: string; documentation_count: number } | null> {
    const cacheFile = join(this.resultsDir, "features-cache.json");
    
    if (!existsSync(cacheFile)) {
      return null;
    }

    try {
      const content = await readFile(cacheFile, "utf-8");
      const cached: { urls: string[]; features: ProductFeature[]; extracted_at: string; documentation_count: number } = JSON.parse(content);
      
      // Check if URLs match (order doesn't matter)
      const cachedUrls = new Set(cached.urls.map(u => u.toLowerCase().trim()));
      const requestedUrls = new Set(urls.map(u => u.toLowerCase().trim()));
      
      if (cachedUrls.size !== requestedUrls.size) {
        return null;
      }
      
      for (const url of requestedUrls) {
        if (!cachedUrls.has(url)) {
          return null;
        }
      }
      
      return {
        features: cached.features,
        extracted_at: cached.extracted_at,
        documentation_count: cached.documentation_count,
      };
    } catch {
      return null;
    }
  }

  async clearFeaturesCache(): Promise<void> {
    const cacheFile = join(this.resultsDir, "features-cache.json");
    if (existsSync(cacheFile)) {
      await writeFile(cacheFile, JSON.stringify({ urls: [], features: [], extracted_at: "", documentation_count: 0 }, null, 2), "utf-8");
    }
  }

  async saveClassificationHistoryEntry(channelId: string, messageId: string, threadId?: string): Promise<void> {
    // For JSON storage, classification history is saved via saveClassificationHistory function
    // This method is a no-op for JSON storage as it uses the file-based approach
    // The actual saving happens in classificationHistory.ts
  }

  async getClassificationHistory(channelId: string): Promise<Array<{ message_id: string; thread_id?: string; classified_at: string }>> {
    // For JSON storage, classification history is loaded via loadClassificationHistory function
    // This method loads from the JSON file
    const { loadClassificationHistory } = await import("../cache/classificationHistory.js");
    const history = await loadClassificationHistory(this.resultsDir);
    
    const messageIds = history.channel_classifications[channelId] || [];
    return messageIds.map(msgId => {
      const msg = history.messages[msgId];
      const thread = msg ? Object.values(history.threads || {}).find(t => 
        history.messages[msgId] && Object.keys(history.messages).includes(msgId)
      ) : null;
      
      return {
        message_id: msgId,
        thread_id: thread?.thread_id,
        classified_at: msg?.classified_at || new Date().toISOString(),
      };
    });
  }

  async saveGitHubIssue(issue: {
    number: number;
    title: string;
    url: string;
    state?: string;
    body?: string;
    labels?: string[];
    author?: string;
    created_at?: string;
    updated_at?: string;
  }): Promise<void> {
    await this.saveGitHubIssues([issue]);
  }

  async saveGitHubIssues(issues: Array<{
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
  }>): Promise<void> {
    // For JSON storage, GitHub issues are stored in the cache file
    // This method is a no-op as issues are saved via the cache file in fetch_github_issues
  }


  async getGitHubIssues(options?: {
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
  }>> {
    // For JSON storage, load from the cache file
    const config = getConfig();
    const cachePath = join(process.cwd(), config.paths.cacheDir || "cache", "github-issues-cache.json");
    
    if (!existsSync(cachePath)) {
      return [];
    }

    try {
      const content = await readFile(cachePath, "utf-8");
      const cache: IssuesCache = JSON.parse(content);
      
      let issues = cache.issues || [];
      
      // Apply filters if provided
      if (options?.state) {
        issues = issues.filter(i => i.state === options.state);
      }
      
      // Note: inGroup and matchedToThreads are not stored in JSON cache
      // These would need to be computed from groups/threads if needed
      
      return issues.map(issue => ({
        number: issue.number,
        title: issue.title,
        url: issue.html_url,
        state: issue.state,
        body: issue.body,
        labels: issue.labels?.map((l: string | { name: string }) => typeof l === 'string' ? l : l.name) || [],
        author: issue.user?.login,
        created_at: issue.created_at,
        updated_at: issue.updated_at,
        in_group: false, // Not stored in JSON cache
        matched_to_threads: false, // Not stored in JSON cache
      }));
    } catch {
      return [];
    }
  }

  async saveExportResult(result: {
    id: string;
    channelId?: string;
    pmTool: string;
    sourceFile?: string;
    success: boolean;
    featuresExtracted: number;
    featuresMapped: number;
    issuesCreated?: number;
    issuesUpdated?: number;
    issuesSkipped?: number;
    errors?: string[];
    exportMappings?: {
      group_export_mappings?: Array<{ group_id: string; id: string; url: string; identifier?: string }>;
      ungrouped_thread_export_mappings?: Array<{ thread_id: string; id: string; url: string; identifier?: string }>;
      ungrouped_issue_export_mappings?: Array<{ issue_number: number; id: string; url: string; identifier?: string }>;
    };
    closedItemsCount?: {
      groups?: number;
      ungrouped_threads?: number;
      ungrouped_threads_closed?: number;
      ungrouped_threads_resolved?: number;
      ungrouped_issues?: number;
    };
    closedItemsFile?: string;
  }): Promise<void> {
    await mkdir(this.resultsDir, { recursive: true });
    
    const exportResultData = {
      ...result,
      timestamp: new Date().toISOString(),
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    
    const exportResultsPath = join(this.resultsDir, `export-result-${result.id}.json`);
    await writeFile(exportResultsPath, JSON.stringify(exportResultData, null, 2), "utf-8");
  }

  async getExportResults(channelId?: string, options?: { limit?: number; pmTool?: string }): Promise<Array<{
    id: string;
    channelId?: string;
    pmTool: string;
    sourceFile?: string;
    success: boolean;
    featuresExtracted: number;
    featuresMapped: number;
    issuesCreated?: number;
    issuesUpdated?: number;
    issuesSkipped?: number;
    errors?: string[];
    exportMappings?: {
      group_export_mappings?: Array<{ group_id: string; id: string; url: string; identifier?: string }>;
      ungrouped_thread_export_mappings?: Array<{ thread_id: string; id: string; url: string; identifier?: string }>;
      ungrouped_issue_export_mappings?: Array<{ issue_number: number; id: string; url: string; identifier?: string }>;
    };
    closedItemsCount?: {
      groups?: number;
      ungrouped_threads?: number;
      ungrouped_threads_closed?: number;
      ungrouped_threads_resolved?: number;
      ungrouped_issues?: number;
    };
    closedItemsFile?: string;
    createdAt: string;
    updatedAt: string;
  }>> {
    type ExportMappings = {
      group_export_mappings?: Array<{ group_id: string; id: string; url: string; identifier?: string }>;
      ungrouped_thread_export_mappings?: Array<{ thread_id: string; id: string; url: string; identifier?: string }>;
      ungrouped_issue_export_mappings?: Array<{ issue_number: number; id: string; url: string; identifier?: string }>;
    };
    type ClosedItemsCount = {
      groups?: number;
      ungrouped_threads?: number;
      ungrouped_threads_closed?: number;
      ungrouped_threads_resolved?: number;
      ungrouped_issues?: number;
    };

    try {
      const files = await readdir(this.resultsDir);
      const exportResultFiles = files
        .filter(f => f.startsWith('export-result-') && f.endsWith('.json'))
        .map(f => join(this.resultsDir, f));

      const results: Array<{
        id: string;
        channelId?: string;
        pmTool: string;
        sourceFile?: string;
        success: boolean;
        featuresExtracted: number;
        featuresMapped: number;
        issuesCreated?: number;
        issuesUpdated?: number;
        issuesSkipped?: number;
        errors?: string[];
        exportMappings?: ExportMappings;
        closedItemsCount?: ClosedItemsCount;
        closedItemsFile?: string;
        createdAt: string;
        updatedAt: string;
      }> = [];
      
      for (const filePath of exportResultFiles) {
        try {
          const content = await readFile(filePath, "utf-8");
          const data = JSON.parse(content);
          
          // Filter by channelId and pmTool if provided
          if (channelId && data.channelId !== channelId) continue;
          if (options?.pmTool && data.pmTool !== options.pmTool) continue;
          
          results.push({
            id: data.id,
            channelId: data.channelId,
            pmTool: data.pmTool,
            sourceFile: data.sourceFile,
            success: data.success,
            featuresExtracted: data.featuresExtracted,
            featuresMapped: data.featuresMapped,
            issuesCreated: data.issuesCreated,
            issuesUpdated: data.issuesUpdated,
            issuesSkipped: data.issuesSkipped,
            errors: data.errors ?? [],
            exportMappings: data.exportMappings,
            closedItemsCount: data.closedItemsCount,
            closedItemsFile: data.closedItemsFile,
            createdAt: data.created_at || data.timestamp || data.createdAt,
            updatedAt: data.updated_at || data.updatedAt || data.createdAt,
          });
        } catch (err) {
          // Skip invalid files
          continue;
        }
      }
      
      // Sort by createdAt descending and limit
      results.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
      return options?.limit ? results.slice(0, options.limit) : results;
    } catch {
      return [];
    }
  }
}

