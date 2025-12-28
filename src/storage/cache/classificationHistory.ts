/**
 * Classification and Grouping history tracking
 * Tracks which messages have been classified and grouped to avoid re-processing
 */

import { readFile, writeFile, mkdir } from "fs/promises";
import { existsSync } from "fs";
import { join } from "path";

export interface MessageClassification {
  message_id: string;
  channel_id: string;
  classified_at: string;
  issues_matched: Array<{
    issue_number: number;
    similarity_score: number;
  }>;
}

export interface ThreadClassification {
  thread_id: string;
  channel_id: string;
  classified_at: string;
  status: "pending" | "classifying" | "completed" | "failed";
  issues_matched: Array<{
    issue_number: number;
    similarity_score: number;
  }>;
}

// Grouping tracking interfaces
export interface SignalGrouping {
  signal_id: string;      // "discord:{threadId}" or "github:{issueNumber}"
  source: "discord" | "github";
  group_id: string;
  grouped_at: string;
}

export interface GroupInfo {
  group_id: string;
  created_at: string;
  status: "pending" | "exported";
  suggested_title: string;
  similarity: number;
  is_cross_cutting: boolean;
  affects_features: string[];  // Feature IDs
  signal_ids: string[];        // All signals in this group
  github_issue?: number;       // Linked GitHub issue number (for issue-based grouping)
  linear_issue_id?: string;    // If exported to Linear
  exported_at?: string;
}

export interface ClassificationHistory {
  last_updated: string;
  messages: Record<string, MessageClassification>; // message_id -> classification
  channel_classifications: Record<string, string[]>; // channel_id -> message_ids[]
  threads: Record<string, ThreadClassification>; // thread_id -> thread classification
  // Grouping tracking
  groups?: Record<string, GroupInfo>;         // group_id -> group info
  signal_groups?: Record<string, string>;     // signal_id -> group_id
}

const HISTORY_FILE = "classification-history.json";

/**
 * Get the path to the classification history file
 */
export function getHistoryPath(resultsDir: string): string {
  return join(resultsDir, HISTORY_FILE);
}

/**
 * Load classification history
 * Loads from database if available, otherwise from JSON file
 */
export async function loadClassificationHistory(resultsDir: string, channelId?: string): Promise<ClassificationHistory> {
  // Check if database is available
  const hasDatabase = !!(process.env.DATABASE_URL || (process.env.DB_HOST && process.env.DB_NAME));

  if (hasDatabase && channelId) {
    try {
      const { getStorage } = await import("../factory.js");
      const storage = getStorage();
      const dbAvailable = await storage.isAvailable();
      
      if (dbAvailable) {
        // Load classification history from database
        const dbHistory = await storage.getClassificationHistory(channelId);
        
        // Load all classified threads for this channel to get full details
        const dbThreads = await storage.getClassifiedThreads(channelId);
        
        // Convert database format to ClassificationHistory format
        const history: ClassificationHistory = {
          last_updated: new Date().toISOString(),
          messages: {},
          channel_classifications: {
            [channelId]: [],
          },
          threads: {},
        };
        
        // Build message map from history entries
        for (const entry of dbHistory) {
          if (entry.message_id) {
            history.messages[entry.message_id] = {
              message_id: entry.message_id,
              channel_id: channelId,
              classified_at: entry.classified_at,
              issues_matched: [], // Will be populated from thread if available
            };
            
            if (!history.channel_classifications[channelId].includes(entry.message_id)) {
              history.channel_classifications[channelId].push(entry.message_id);
            }
          }
        }
        
        // Build threads map from classified threads
        for (const thread of dbThreads) {
          history.threads[thread.thread_id] = {
            thread_id: thread.thread_id,
            channel_id: thread.channel_id,
            classified_at: thread.classified_at,
            status: thread.status,
            issues_matched: thread.issues.map(i => ({
              issue_number: i.number,
              similarity_score: i.similarity_score,
            })),
          };
          
          // Update message issues_matched if this is the first message
          if (thread.first_message_id && history.messages[thread.first_message_id]) {
            history.messages[thread.first_message_id].issues_matched = thread.issues.map(i => ({
              issue_number: i.number,
              similarity_score: i.similarity_score,
            }));
          }
        }
        
        return history;
      }
    } catch (error) {
      // Database load failed, fall back to JSON
      console.error("[ClassificationHistory] Database load failed, falling back to JSON:", error);
    }
  }

  // Fall back to JSON file
  const historyPath = getHistoryPath(resultsDir);

  if (!existsSync(historyPath)) {
    return {
      last_updated: new Date().toISOString(),
      messages: {},
      channel_classifications: {},
      threads: {},
    };
  }

  try {
    const content = await readFile(historyPath, "utf-8");
    return JSON.parse(content) as ClassificationHistory;
  } catch (error) {
    // If file is corrupted, return empty history
    return {
      last_updated: new Date().toISOString(),
      messages: {},
      channel_classifications: {},
      threads: {},
    };
  }
}

/**
 * Save classification history
 * Saves to database if DATABASE_URL is set, otherwise saves to JSON file
 */
export async function saveClassificationHistory(
  history: ClassificationHistory,
  resultsDir: string
): Promise<void> {
  // Check if database is available
  const hasDatabase = !!(process.env.DATABASE_URL || (process.env.DB_HOST && process.env.DB_NAME));

  if (hasDatabase) {
    // Save to database using Prisma
    try {
      const { prisma } = await import("../db/prisma.js");
      const { getStorage } = await import("../factory.js");
      const storage = getStorage();

      // First, ensure all channels exist (to satisfy foreign key constraints)
      const channelIds = new Set<string>();
      for (const [messageId, msg] of Object.entries(history.messages)) {
        channelIds.add(msg.channel_id);
      }
      for (const [threadId, thread] of Object.entries(history.threads || {})) {
        channelIds.add(thread.channel_id);
      }

      // Upsert all channels
      for (const channelId of channelIds) {
        await storage.upsertChannel(channelId);
      }

      // Save all message classifications in a transaction
      await prisma.$transaction(async (tx) => {
        for (const [messageId, msg] of Object.entries(history.messages)) {
          // Find thread_id for this message by checking threads
          let threadId: string | undefined;
          for (const [tid, thread] of Object.entries(history.threads || {})) {
            if (thread.channel_id === msg.channel_id) {
              // Check if this message is in the channel's classified messages
              const channelMsgs = history.channel_classifications[msg.channel_id] || [];
              if (channelMsgs.includes(messageId)) {
                threadId = tid;
                break;
              }
            }
          }

          await tx.classificationHistory.upsert({
            where: {
              channelId_messageId: {
                channelId: msg.channel_id,
                messageId: messageId,
              },
            },
            update: {
              threadId: threadId || null,
              classifiedAt: new Date(msg.classified_at),
            },
            create: {
              channelId: msg.channel_id,
              messageId: messageId,
              threadId: threadId || null,
              classifiedAt: new Date(msg.classified_at),
            },
          });
        }
      });
    } catch (error) {
      // If database save fails, fall back to JSON
      console.error("[ClassificationHistory] Database save failed, falling back to JSON:", error);
      await saveClassificationHistoryToFile(history, resultsDir);
    }
  } else {
    // Save to JSON file
    await saveClassificationHistoryToFile(history, resultsDir);
  }
}

/**
 * Save classification history to JSON file (fallback)
 */
async function saveClassificationHistoryToFile(
  history: ClassificationHistory,
  resultsDir: string
): Promise<void> {
  const historyPath = getHistoryPath(resultsDir);

  // Ensure results directory exists
  if (!existsSync(resultsDir)) {
    await mkdir(resultsDir, { recursive: true });
  }

  history.last_updated = new Date().toISOString();
  await writeFile(historyPath, JSON.stringify(history, null, 2), "utf-8");
}

/**
 * Check if a message has been classified
 */
export function isMessageClassified(
  messageId: string,
  history: ClassificationHistory
): boolean {
  return messageId in history.messages;
}

/**
 * Get classified message IDs for a channel
 */
export function getClassifiedMessageIds(
  channelId: string,
  history: ClassificationHistory
): Set<string> {
  const messageIds = history.channel_classifications[channelId] || [];
  return new Set(messageIds);
}

/**
 * Add a message classification to history
 */
export function addMessageClassification(
  messageId: string,
  channelId: string,
  issuesMatched: Array<{ issue_number: number; similarity_score: number }>,
  history: ClassificationHistory
): void {
  history.messages[messageId] = {
    message_id: messageId,
    channel_id: channelId,
    classified_at: new Date().toISOString(),
    issues_matched: issuesMatched,
  };

  // Add to channel classifications
  if (!history.channel_classifications[channelId]) {
    history.channel_classifications[channelId] = [];
  }

  if (!history.channel_classifications[channelId].includes(messageId)) {
    history.channel_classifications[channelId].push(messageId);
  }
}

/**
 * Filter messages to only include unclassified ones
 */
export function filterUnclassifiedMessages<T extends { id: string }>(
  messages: T[],
  history: ClassificationHistory
): T[] {
  return messages.filter((msg) => !isMessageClassified(msg.id, history));
}

/**
 * Check if a thread has been classified
 */
export function isThreadClassified(
  threadId: string,
  history: ClassificationHistory
): boolean {
  const thread = history.threads?.[threadId];
  return thread !== undefined && thread.status === "completed";
}

/**
 * Get thread classification status
 */
export function getThreadStatus(
  threadId: string,
  history: ClassificationHistory
): ThreadClassification["status"] | null {
  const thread = history.threads?.[threadId];
  return thread?.status || null;
}

/**
 * Update thread classification status
 */
export function updateThreadStatus(
  history: ClassificationHistory,
  threadId: string,
  channelId: string,
  status: ThreadClassification["status"],
  issuesMatched?: Array<{ issue_number: number; similarity_score: number }>
): void {
  if (!history.threads) {
    history.threads = {};
  }

  history.threads[threadId] = {
    thread_id: threadId,
    channel_id: channelId,
    classified_at: new Date().toISOString(),
    status,
    issues_matched: issuesMatched || history.threads[threadId]?.issues_matched || [],
  };
}

/**
 * Get all threads that need classification (pending or not started)
 */
export function getUnclassifiedThreads(
  threadIds: string[],
  history: ClassificationHistory
): string[] {
  return threadIds.filter(threadId => {
    const status = getThreadStatus(threadId, history);
    return !status || status === "pending" || status === "failed";
  });
}

/**
 * Migrate classification from standalone message (using message ID as thread ID) to a real thread
 * This handles the case when a standalone message becomes part of a thread
 * 
 * @param history Classification history to update
 * @param threadId The real thread ID
 * @param messageIds Array of message IDs in the thread
 * @param channelId The channel ID
 */
export function migrateStandaloneToThread(
  history: ClassificationHistory,
  threadId: string,
  messageIds: string[],
  channelId: string
): void {
  if (!history.threads) {
    history.threads = {};
  }

  // Check if any messages were previously classified as standalone (using their message ID as thread ID)
  const standaloneThreadEntries: Array<{ messageId: string; classification: ThreadClassification }> = [];
  
  for (const messageId of messageIds) {
    const standaloneThreadId = messageId; // When standalone, thread ID = message ID
    const standaloneClassification = history.threads[standaloneThreadId];
    
    if (standaloneClassification && standaloneClassification.status === "completed") {
      standaloneThreadEntries.push({
        messageId,
        classification: standaloneClassification,
      });
    }
  }

  // If we found standalone classifications, migrate them to the real thread
  if (standaloneThreadEntries.length > 0) {
    // Merge all issues matched from standalone classifications
    const allIssuesMatched = new Map<number, number>(); // issue_number -> max similarity_score
    
    for (const entry of standaloneThreadEntries) {
      for (const issue of entry.classification.issues_matched) {
        const existing = allIssuesMatched.get(issue.issue_number);
        if (!existing || issue.similarity_score > existing) {
          allIssuesMatched.set(issue.issue_number, issue.similarity_score);
        }
      }
    }

    // Create merged issues array
    const mergedIssues = Array.from(allIssuesMatched.entries()).map(([issue_number, similarity_score]) => ({
      issue_number,
      similarity_score,
    }));

    // Use the most recent classification date
    const mostRecentDate = standaloneThreadEntries
      .map(e => new Date(e.classification.classified_at).getTime())
      .reduce((max, date) => Math.max(max, date), 0);

    // Update the real thread with migrated classification
    history.threads[threadId] = {
      thread_id: threadId,
      channel_id: channelId,
      classified_at: new Date(mostRecentDate).toISOString(),
      status: "completed",
      issues_matched: mergedIssues,
    };

    // Optionally, we could remove the old standalone thread entries, but keeping them doesn't hurt
    // and provides a history trail
  }
}

/**
 * Check if a message in a thread was previously classified as standalone
 */
export function wasMessageStandaloneClassified(
  messageId: string,
  history: ClassificationHistory
): boolean {
  const standaloneThreadId = messageId;
  const standaloneClassification = history.threads?.[standaloneThreadId];
  return standaloneClassification?.status === "completed" || false;
}

// ============================================
// GROUPING TRACKING FUNCTIONS
// ============================================

/**
 * Check if a signal has already been grouped
 */
export function isSignalGrouped(
  signalId: string,
  history: ClassificationHistory
): boolean {
  return history.signal_groups?.[signalId] !== undefined;
}

/**
 * Get the group ID for a signal
 */
export function getSignalGroupId(
  signalId: string,
  history: ClassificationHistory
): string | null {
  return history.signal_groups?.[signalId] || null;
}

/**
 * Get group info by ID
 */
export function getGroupInfo(
  groupId: string,
  history: ClassificationHistory
): GroupInfo | null {
  return history.groups?.[groupId] || null;
}

/**
 * Filter signals to only include ungrouped ones
 */
export function filterUngroupedSignals<T extends { source: string; sourceId: string }>(
  signals: T[],
  history: ClassificationHistory
): T[] {
  return signals.filter(signal => {
    const signalId = `${signal.source}:${signal.sourceId}`;
    return !isSignalGrouped(signalId, history);
  });
}

/**
 * Add a new group to history
 */
export function addGroup(
  history: ClassificationHistory,
  group: {
    group_id: string;
    suggested_title: string;
    similarity: number;
    is_cross_cutting: boolean;
    affects_features: string[];
    signal_ids: string[];
    github_issue?: number;
  }
): void {
  if (!history.groups) {
    history.groups = {};
  }
  if (!history.signal_groups) {
    history.signal_groups = {};
  }

  // Add group info
  history.groups[group.group_id] = {
    group_id: group.group_id,
    created_at: new Date().toISOString(),
    status: "pending",
    suggested_title: group.suggested_title,
    similarity: group.similarity,
    is_cross_cutting: group.is_cross_cutting,
    affects_features: group.affects_features,
    signal_ids: group.signal_ids,
    github_issue: group.github_issue,
  };

  // Map signals to group
  for (const signalId of group.signal_ids) {
    history.signal_groups[signalId] = group.group_id;
  }
}

/**
 * Mark a group as exported
 */
export function markGroupExported(
  history: ClassificationHistory,
  groupId: string,
  linearIssueId?: string
): void {
  if (history.groups?.[groupId]) {
    history.groups[groupId].status = "exported";
    history.groups[groupId].exported_at = new Date().toISOString();
    if (linearIssueId) {
      history.groups[groupId].linear_issue_id = linearIssueId;
    }
  }
}

/**
 * Get all groups that haven't been exported yet
 */
export function getUnexportedGroups(
  history: ClassificationHistory
): GroupInfo[] {
  if (!history.groups) return [];
  return Object.values(history.groups).filter(g => g.status === "pending");
}

/**
 * Get all groups (for reporting)
 */
export function getAllGroups(
  history: ClassificationHistory
): GroupInfo[] {
  if (!history.groups) return [];
  return Object.values(history.groups);
}

/**
 * Get grouping statistics
 */
export function getGroupingStats(
  history: ClassificationHistory
): {
  totalGroups: number;
  exportedGroups: number;
  pendingGroups: number;
  totalGroupedSignals: number;
  crossCuttingGroups: number;
} {
  const groups = Object.values(history.groups || {});
  return {
    totalGroups: groups.length,
    exportedGroups: groups.filter(g => g.status === "exported").length,
    pendingGroups: groups.filter(g => g.status === "pending").length,
    totalGroupedSignals: Object.keys(history.signal_groups || {}).length,
    crossCuttingGroups: groups.filter(g => g.is_cross_cutting).length,
  };
}

