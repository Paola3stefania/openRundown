/**
 * JSON file-based storage implementation
 * Wraps existing file-based logic for classifications and groupings
 */

import type { IStorage } from "../interface.js";
import type { ClassifiedThread, Group, UngroupedThread, StorageStats } from "../types.js";
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
      let existingThreads: any[] = [];

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
      const threadMap = new Map<string, any>();
      for (const thread of existingThreads) {
        const threadId = thread.thread?.thread_id || thread.thread_id;
        if (threadId) threadMap.set(threadId, thread);
      }
      for (const thread of channelThreads) {
        threadMap.set(thread.thread_id, {
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
        });
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

    return threads.map((t: any) => ({
      thread_id: t.thread?.thread_id || t.thread_id,
      channel_id: channelId,
      thread_name: t.thread?.thread_name,
      message_count: t.thread?.message_count || 1,
      first_message_id: t.thread?.first_message_id || t.thread_id,
      first_message_author: t.thread?.first_message_author,
      first_message_timestamp: t.thread?.first_message_timestamp,
      first_message_url: t.thread?.first_message_url,
      classified_at: t.thread?.classified_at || new Date().toISOString(),
      status: t.thread?.classified_status || "completed",
      issues: t.issues || [],
    }));
  }

  async getClassifiedThread(threadId: string): Promise<ClassifiedThread | null> {
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
          const tId = t.thread?.thread_id || t.thread_id;
          if (tId === threadId) {
            return {
              thread_id: tId,
              channel_id: parsed.channel_id,
              thread_name: t.thread?.thread_name,
              message_count: t.thread?.message_count || 1,
              first_message_id: t.thread?.first_message_id || tId,
              first_message_author: t.thread?.first_message_author,
              first_message_timestamp: t.thread?.first_message_timestamp,
              first_message_url: t.thread?.first_message_url,
              classified_at: t.thread?.classified_at || new Date().toISOString(),
              status: t.thread?.classified_status || "completed",
              issues: t.issues || [],
            };
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
      let existingGroups: any[] = [];

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
      const groupMap = new Map<string, any>();
      for (const group of existingGroups) {
        groupMap.set(group.id, group);
      }
      for (const group of channelGroups) {
        groupMap.set(group.id, {
          id: group.id,
          github_issue: group.github_issue_number ? {
            number: group.github_issue_number,
          } : undefined,
          suggested_title: group.suggested_title,
          avg_similarity: group.avg_similarity,
          thread_count: group.thread_count,
          is_cross_cutting: group.is_cross_cutting,
          status: group.status,
          created_at: group.created_at,
          updated_at: group.updated_at,
          exported_at: group.exported_at,
          linear_issue_id: group.linear_issue_id,
          linear_issue_url: group.linear_issue_url,
          linear_project_ids: group.linear_project_ids,
          threads: group.threads,
        });
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

  async getGroups(channelId: string, options?: { status?: "pending" | "exported" }): Promise<Group[]> {
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
    let groups = parsed.groups || [];

    if (options?.status) {
      groups = groups.filter((g: any) => g.status === options.status);
    }

    return groups.map((g: any) => ({
      id: g.id,
      channel_id: channelId,
      github_issue_number: g.github_issue?.number,
      suggested_title: g.suggested_title || g.github_issue?.title,
      avg_similarity: g.avg_similarity,
      thread_count: g.thread_count || g.threads?.length || 0,
      is_cross_cutting: g.is_cross_cutting || false,
      status: g.status || "pending",
      created_at: g.created_at || parsed.timestamp,
      updated_at: g.updated_at || parsed.timestamp,
      exported_at: g.exported_at,
      linear_issue_id: g.linear_issue_id,
      linear_issue_url: g.linear_issue_url,
      linear_project_ids: g.linear_project_ids,
      threads: g.threads || [],
    }));
  }

  async getGroup(groupId: string): Promise<Group | null> {
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
          if (g.id === groupId) {
            return {
              id: g.id,
              channel_id: parsed.channel_id,
              github_issue_number: g.github_issue?.number,
              suggested_title: g.suggested_title || g.github_issue?.title,
              avg_similarity: g.avg_similarity,
              thread_count: g.thread_count || g.threads?.length || 0,
              is_cross_cutting: g.is_cross_cutting || false,
              status: g.status || "pending",
              created_at: g.created_at || parsed.timestamp,
              updated_at: g.updated_at || parsed.timestamp,
              exported_at: g.exported_at,
              linear_issue_id: g.linear_issue_id,
              linear_issue_url: g.linear_issue_url,
              linear_project_ids: g.linear_project_ids,
              threads: g.threads || [],
            };
          }
        }
      } catch {
        continue;
      }
    }

    return null;
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
      let existingUngrouped: any[] = [];

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
      const threadMap = new Map<string, any>();
      for (const thread of existingUngrouped) {
        threadMap.set(thread.thread_id, thread);
      }
      for (const thread of channelThreads) {
        threadMap.set(thread.thread_id, thread);
      }

      const mergedUngrouped = Array.from(threadMap.values());

      // Load existing groups if file exists
      let existingGroups: any[] = [];
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

    return ungrouped.map((t: any) => ({
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
}

