/**
 * PostgreSQL database storage implementation using Prisma
 */

import type { IStorage, GitHubReactions } from "../interface.js";
import type { ClassifiedThread, Group, UngroupedThread, StorageStats } from "../types.js";
import type { DocumentationContent } from "../../export/documentationFetcher.js";
import type { ProductFeature } from "../../export/types.js";
import { prisma } from "./prisma.js";
import { Decimal } from "@prisma/client/runtime/client";

export class DatabaseStorage implements IStorage {
  async upsertChannel(channelId: string, channelName?: string, guildId?: string): Promise<void> {
    await prisma.channel.upsert({
      where: { id: channelId },
      update: {
        name: channelName ?? null,
        guildId: guildId ?? null,
      },
      create: {
        id: channelId,
        name: channelName ?? null,
        guildId: guildId ?? null,
      },
    });
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
    if (messages.length === 0) return;

    // Process messages in batches to avoid transaction timeout
    // Batch size of 500 should keep each transaction under 5 seconds
    const BATCH_SIZE = 500;
    const batches: typeof messages[] = [];
    
    for (let i = 0; i < messages.length; i += BATCH_SIZE) {
      batches.push(messages.slice(i, i + BATCH_SIZE));
    }

    // Process each batch in a separate transaction with increased timeout
    for (const batch of batches) {
      await prisma.$transaction(async (tx) => {
        // First, collect unique channels and upsert them in bulk
        const uniqueChannels = new Map<string, { channelId: string; channelName?: string; guildId?: string }>();
        for (const msg of batch) {
          if (!uniqueChannels.has(msg.channelId)) {
            uniqueChannels.set(msg.channelId, {
              channelId: msg.channelId,
              channelName: msg.channelName,
              guildId: msg.guildId,
            });
          }
        }

        // Upsert all unique channels first
        for (const channel of uniqueChannels.values()) {
          await tx.channel.upsert({
            where: { id: channel.channelId },
            update: {
              name: channel.channelName ?? null,
              guildId: channel.guildId ?? null,
            },
            create: {
              id: channel.channelId,
              name: channel.channelName ?? null,
              guildId: channel.guildId ?? null,
            },
          });
        }

        // Then upsert all messages in the batch
        for (const msg of batch) {
          await tx.discordMessage.upsert({
            where: { id: msg.id },
            update: {
              authorId: msg.authorId,
              authorUsername: msg.authorUsername ?? null,
              authorDiscriminator: msg.authorDiscriminator ?? null,
              authorBot: msg.authorBot ?? false,
              authorAvatar: msg.authorAvatar ?? null,
              content: msg.content,
              createdAt: new Date(msg.createdAt),
              editedAt: msg.editedAt ? new Date(msg.editedAt) : null,
              timestamp: msg.timestamp,
              channelName: msg.channelName ?? null,
              guildId: msg.guildId ?? null,
              guildName: msg.guildName ?? null,
              attachments: msg.attachments ? JSON.parse(JSON.stringify(msg.attachments)) : [],
              embeds: msg.embeds ?? 0,
              mentions: msg.mentions ?? [],
              reactions: msg.reactions ? JSON.parse(JSON.stringify(msg.reactions)) : [],
              threadId: msg.threadId ?? null,
              threadName: msg.threadName ?? null,
              messageReference: msg.messageReference ? JSON.parse(JSON.stringify(msg.messageReference)) : null,
              url: msg.url ?? null,
            },
            create: {
              id: msg.id,
              channelId: msg.channelId,
              authorId: msg.authorId,
              authorUsername: msg.authorUsername ?? null,
              authorDiscriminator: msg.authorDiscriminator ?? null,
              authorBot: msg.authorBot ?? false,
              authorAvatar: msg.authorAvatar ?? null,
              content: msg.content,
              createdAt: new Date(msg.createdAt),
              editedAt: msg.editedAt ? new Date(msg.editedAt) : null,
              timestamp: msg.timestamp,
              channelName: msg.channelName ?? null,
              guildId: msg.guildId ?? null,
              guildName: msg.guildName ?? null,
              attachments: msg.attachments ? JSON.parse(JSON.stringify(msg.attachments)) : [],
              embeds: msg.embeds ?? 0,
              mentions: msg.mentions ?? [],
              reactions: msg.reactions ? JSON.parse(JSON.stringify(msg.reactions)) : [],
              threadId: msg.threadId ?? null,
              threadName: msg.threadName ?? null,
              messageReference: msg.messageReference ? JSON.parse(JSON.stringify(msg.messageReference)) : null,
              url: msg.url ?? null,
            },
          });
        }
      }, {
        timeout: 30000, // 30 seconds timeout per batch (should be more than enough for 500 messages)
      });
    }
  }

  async saveClassifiedThread(thread: ClassifiedThread): Promise<void> {
    await this.saveClassifiedThreads([thread]);
  }

  async saveClassifiedThreads(threads: ClassifiedThread[]): Promise<void> {
    if (threads.length === 0) return;

    await prisma.$transaction(async (tx) => {
      for (const thread of threads) {
        // Determine match status based on issues
        let matchStatus: string | null = null;
        if (thread.issues.length > 0) {
          matchStatus = "matched";
        } else {
          matchStatus = "no_matches";
        }

        // Upsert thread
        await tx.classifiedThread.upsert({
          where: { threadId: thread.thread_id },
          update: {
            threadName: thread.thread_name ?? null,
            messageCount: thread.message_count,
            firstMessageAuthor: thread.first_message_author ?? null,
            firstMessageTimestamp: thread.first_message_timestamp ? new Date(thread.first_message_timestamp) : null,
            firstMessageUrl: thread.first_message_url ?? null,
            status: thread.status,
            matchStatus: matchStatus,
          },
          create: {
            threadId: thread.thread_id,
            channelId: thread.channel_id,
            threadName: thread.thread_name ?? null,
            messageCount: thread.message_count,
            firstMessageId: thread.first_message_id,
            firstMessageAuthor: thread.first_message_author ?? null,
            firstMessageTimestamp: thread.first_message_timestamp ? new Date(thread.first_message_timestamp) : null,
            firstMessageUrl: thread.first_message_url ?? null,
            status: thread.status,
            matchStatus: matchStatus,
          },
        });

        // Delete existing matches
        await tx.threadIssueMatch.deleteMany({
          where: { threadId: thread.thread_id },
        });

        // Insert new matches
        if (thread.issues.length > 0) {
          await tx.threadIssueMatch.createMany({
            data: thread.issues.map((issue) => ({
              threadId: thread.thread_id,
              issueNumber: issue.number,
              issueTitle: issue.title,
              issueUrl: issue.url,
              issueState: issue.state ?? null,
              similarityScore: new Decimal(issue.similarity_score),
              matchedTerms: issue.matched_terms ?? [],
              issueLabels: issue.labels ?? [],
              issueAuthor: issue.author ?? null,
              issueCreatedAt: issue.created_at ? new Date(issue.created_at) : null,
            })),
            skipDuplicates: true,
          });
        }
      }
    });
  }

  async getClassifiedThreads(channelId: string): Promise<ClassifiedThread[]> {
    const threads = await prisma.classifiedThread.findMany({
      where: { channelId },
      include: {
        issueMatches: {
          orderBy: { similarityScore: "desc" },
        },
      },
      orderBy: { classifiedAt: "desc" },
    });

    return threads.map((thread) => ({
      thread_id: thread.threadId,
      channel_id: thread.channelId,
      thread_name: thread.threadName ?? undefined,
      message_count: thread.messageCount,
      first_message_id: thread.firstMessageId ?? "",
      first_message_author: thread.firstMessageAuthor ?? undefined,
      first_message_timestamp: thread.firstMessageTimestamp?.toISOString(),
      first_message_url: thread.firstMessageUrl ?? undefined,
      classified_at: thread.classifiedAt.toISOString(),
      status: thread.status as "pending" | "classifying" | "completed" | "failed",
      match_status: thread.matchStatus as "matched" | "below_threshold" | "no_matches" | null | undefined,
      issues: thread.issueMatches.map((match) => ({
        number: match.issueNumber,
        title: match.issueTitle,
        url: match.issueUrl,
        state: match.issueState ?? "",
        similarity_score: match.similarityScore.toNumber(),
        matched_terms: match.matchedTerms,
        labels: match.issueLabels,
        author: match.issueAuthor ?? undefined,
        created_at: match.issueCreatedAt?.toISOString(),
      })),
    }));
  }

  async getClassifiedThread(threadId: string): Promise<ClassifiedThread | null> {
    const thread = await prisma.classifiedThread.findUnique({
      where: { threadId },
      include: {
        issueMatches: {
          orderBy: { similarityScore: "desc" },
        },
      },
    });

    if (!thread) {
      return null;
    }

    return {
      thread_id: thread.threadId,
      channel_id: thread.channelId,
      thread_name: thread.threadName ?? undefined,
      message_count: thread.messageCount,
      match_status: thread.matchStatus as "matched" | "below_threshold" | "no_matches" | null | undefined,
      first_message_id: thread.firstMessageId ?? "",
      first_message_author: thread.firstMessageAuthor ?? undefined,
      first_message_timestamp: thread.firstMessageTimestamp?.toISOString(),
      first_message_url: thread.firstMessageUrl ?? undefined,
      classified_at: thread.classifiedAt.toISOString(),
      status: thread.status as "pending" | "classifying" | "completed" | "failed",
      issues: thread.issueMatches.map((match) => ({
        number: match.issueNumber,
        title: match.issueTitle,
        url: match.issueUrl,
        state: match.issueState ?? "",
        similarity_score: match.similarityScore.toNumber(),
        matched_terms: match.matchedTerms,
        labels: match.issueLabels,
        author: match.issueAuthor ?? undefined,
        created_at: match.issueCreatedAt?.toISOString(),
      })),
    };
  }

  async saveGroup(group: Group): Promise<void> {
    await this.saveGroups([group]);
  }

  async saveGroups(groups: Group[]): Promise<void> {
    if (groups.length === 0) {
      console.error(`[DEBUG saveGroups] No groups to save`);
      return;
    }

    console.error(`[DEBUG saveGroups] Saving ${groups.length} groups to database`);
    
    // Debug: Check first group
    const firstGroup = groups[0];
    console.error(`[DEBUG saveGroups] First group: id=${firstGroup.id}, affects_features=${JSON.stringify(firstGroup.affects_features)}, is_cross_cutting=${firstGroup.is_cross_cutting}`);

    // Process groups in batches to avoid transaction timeout
    // Batch size of 20 groups should keep each transaction under 30 seconds
    const BATCH_SIZE = 20;
    const batches: Group[][] = [];
    
    for (let i = 0; i < groups.length; i += BATCH_SIZE) {
      batches.push(groups.slice(i, i + BATCH_SIZE));
    }

    console.error(`[DEBUG saveGroups] Processing ${batches.length} batches`);

    // Process each batch in a separate transaction with increased timeout
    for (let batchIndex = 0; batchIndex < batches.length; batchIndex++) {
      const batch = batches[batchIndex];
      console.error(`[DEBUG saveGroups] Processing batch ${batchIndex + 1}/${batches.length} with ${batch.length} groups`);
      
      try {
        await prisma.$transaction(async (tx) => {
          // Process all groups in the batch in parallel for better performance
          await Promise.all(batch.map(async (group) => {
            const affectsFeaturesData = group.affects_features ? JSON.parse(JSON.stringify(group.affects_features)) : [];
            console.error(`[DEBUG saveGroups] Upserting group ${group.id} with affectsFeatures=${JSON.stringify(affectsFeaturesData)}`);
            
            // Upsert group
            const upsertedGroup = await tx.group.upsert({
              where: { id: group.id },
              update: {
                suggestedTitle: group.suggested_title,
                avgSimilarity: group.avg_similarity ? new Decimal(group.avg_similarity) : null,
                threadCount: group.thread_count,
                isCrossCutting: group.is_cross_cutting,
                status: group.status,
                exportedAt: group.exported_at ? new Date(group.exported_at) : null,
                linearIssueId: group.linear_issue_id ?? null,
                linearIssueUrl: group.linear_issue_url ?? null,
                linearIssueIdentifier: group.linear_issue_identifier ?? null,
                linearProjectIds: group.linear_project_ids ?? [],
                affectsFeatures: affectsFeaturesData,
              },
              create: {
                id: group.id,
                channelId: group.channel_id,
                githubIssueNumber: group.github_issue_number ?? null,
                suggestedTitle: group.suggested_title,
                avgSimilarity: group.avg_similarity ? new Decimal(group.avg_similarity) : null,
                threadCount: group.thread_count,
                isCrossCutting: group.is_cross_cutting,
                status: group.status,
                exportedAt: group.exported_at ? new Date(group.exported_at) : null,
                linearIssueId: group.linear_issue_id ?? null,
                linearIssueUrl: group.linear_issue_url ?? null,
                linearIssueIdentifier: group.linear_issue_identifier ?? null,
                linearProjectIds: group.linear_project_ids ?? [],
                affectsFeatures: affectsFeaturesData,
              },
            });
            
            console.error(`[DEBUG saveGroups] Upserted group ${group.id}, affectsFeatures in DB: ${JSON.stringify(upsertedGroup.affectsFeatures)}`);

            // Delete existing group-thread relationships
            await tx.groupThread.deleteMany({
              where: { groupId: group.id },
            });

            // Insert group-thread relationships
            if (group.threads.length > 0) {
              await tx.groupThread.createMany({
                data: group.threads.map((thread) => ({
                  groupId: group.id,
                  threadId: thread.thread_id,
                  similarityScore: thread.similarity_score ? new Decimal(thread.similarity_score) : null,
                })),
                skipDuplicates: true,
              });
            }
          }));
          
          console.error(`[DEBUG saveGroups] Transaction for batch ${batchIndex + 1} completed successfully`);
        }, {
          timeout: 30000, // 30 seconds timeout per batch
        });
        
        // Verify a sample group from this batch was saved correctly (after transaction commits)
        if (batch.length > 0) {
          const sampleGroupId = batch[0].id;
          try {
            // Wait a tiny bit to ensure transaction is committed
            await new Promise(resolve => setTimeout(resolve, 100));
            const savedGroup = await prisma.group.findUnique({
              where: { id: sampleGroupId },
              select: { id: true, affectsFeatures: true, isCrossCutting: true },
            });
            console.error(`[DEBUG saveGroups] Verified batch ${batchIndex + 1} sample group ${savedGroup?.id}: affectsFeatures=${JSON.stringify(savedGroup?.affectsFeatures)}, isCrossCutting=${savedGroup?.isCrossCutting}`);
            
            if (!savedGroup) {
              console.error(`[DEBUG saveGroups] ERROR: Sample group ${sampleGroupId} not found in database after save!`);
            } else {
              // Normalize undefined/null to empty array for comparison
              const expectedFeatures = batch[0].affects_features || [];
              const actualFeatures = savedGroup.affectsFeatures || [];
              if (JSON.stringify(actualFeatures) !== JSON.stringify(expectedFeatures)) {
                console.error(`[DEBUG saveGroups] WARNING: Sample group ${sampleGroupId} affectsFeatures mismatch! Expected: ${JSON.stringify(expectedFeatures)}, Got: ${JSON.stringify(actualFeatures)}`);
              }
            }
          } catch (verifyError) {
            console.error(`[DEBUG saveGroups] Could not verify sample group: ${verifyError instanceof Error ? verifyError.message : String(verifyError)}`);
          }
        }
        
        console.error(`[DEBUG saveGroups] Completed batch ${batchIndex + 1}/${batches.length}`);
      } catch (batchError) {
        console.error(`[DEBUG saveGroups] ERROR: Failed to save batch ${batchIndex + 1}: ${batchError instanceof Error ? batchError.message : String(batchError)}`);
        console.error(`[DEBUG saveGroups] Error stack: ${batchError instanceof Error ? batchError.stack : 'N/A'}`);
        // Continue with next batch instead of failing completely
        throw batchError; // Re-throw to stop processing if critical
      }
    }
    
    console.error(`[DEBUG saveGroups] Successfully saved all ${groups.length} groups to database`);
  }

  async getGroups(channelId: string, options?: { status?: "pending" | "exported" }): Promise<Group[]> {
    const where: { channelId: string; status?: "pending" | "exported" } = { channelId };
    if (options?.status) {
      where.status = options.status;
    }

    const groups = await prisma.group.findMany({
      where,
      include: {
        groupThreads: {
          include: {
            thread: true,
          },
          orderBy: { similarityScore: "desc" },
        },
      },
      orderBy: [
        { threadCount: "desc" },
        { avgSimilarity: "desc" },
      ],
    });

    return groups.map((group) => ({
      id: group.id,
      channel_id: group.channelId,
      github_issue_number: group.githubIssueNumber ?? undefined,
      suggested_title: group.suggestedTitle,
      avg_similarity: group.avgSimilarity?.toNumber() ?? 0,
      thread_count: group.threadCount,
      is_cross_cutting: group.isCrossCutting,
      status: group.status as "pending" | "exported",
      created_at: group.createdAt.toISOString(),
      updated_at: group.updatedAt.toISOString(),
      exported_at: group.exportedAt?.toISOString(),
      linear_issue_id: group.linearIssueId ?? undefined,
      linear_issue_url: group.linearIssueUrl ?? undefined,
      linear_issue_identifier: group.linearIssueIdentifier ?? undefined,
      linear_project_ids: group.linearProjectIds,
      affects_features: (Array.isArray(group.affectsFeatures) ? group.affectsFeatures : []) as Array<{ id: string; name: string }>,
      threads: group.groupThreads.map((gt) => ({
        thread_id: gt.thread.threadId,
        thread_name: gt.thread.threadName ?? undefined,
        similarity_score: gt.similarityScore?.toNumber() ?? 0,
        url: gt.thread.firstMessageUrl ?? undefined,
        author: gt.thread.firstMessageAuthor ?? undefined,
        timestamp: gt.thread.firstMessageTimestamp?.toISOString(),
      })),
    }));
  }

  async getGroup(groupId: string): Promise<Group | null> {
    const group = await prisma.group.findUnique({
      where: { id: groupId },
      include: {
        groupThreads: {
          include: {
            thread: true,
          },
          orderBy: { similarityScore: "desc" },
        },
      },
    });

    if (!group) {
      return null;
    }

    return {
      id: group.id,
      channel_id: group.channelId,
      github_issue_number: group.githubIssueNumber ?? undefined,
      suggested_title: group.suggestedTitle,
      avg_similarity: group.avgSimilarity?.toNumber() ?? 0,
      thread_count: group.threadCount,
      is_cross_cutting: group.isCrossCutting,
      status: group.status as "pending" | "exported",
      created_at: group.createdAt.toISOString(),
      updated_at: group.updatedAt.toISOString(),
      exported_at: group.exportedAt?.toISOString(),
      linear_issue_id: group.linearIssueId ?? undefined,
      linear_issue_url: group.linearIssueUrl ?? undefined,
      linear_issue_identifier: group.linearIssueIdentifier ?? undefined,
      linear_project_ids: group.linearProjectIds,
      affects_features: (Array.isArray(group.affectsFeatures) ? group.affectsFeatures : []) as Array<{ id: string; name: string }>,
      threads: group.groupThreads.map((gt) => ({
        thread_id: gt.thread.threadId,
        thread_name: gt.thread.threadName ?? undefined,
        similarity_score: gt.similarityScore?.toNumber() ?? 0,
        url: gt.thread.firstMessageUrl ?? undefined,
        author: gt.thread.firstMessageAuthor ?? undefined,
        timestamp: gt.thread.firstMessageTimestamp?.toISOString(),
      })),
    };
  }

  async markGroupAsExported(groupId: string, linearIssueId: string, linearIssueUrl: string, projectIds?: string[]): Promise<void> {
    await prisma.group.update({
      where: { id: groupId },
      data: {
        status: "exported",
        exportedAt: new Date(),
        linearIssueId,
        linearIssueUrl,
        linearProjectIds: projectIds ?? [],
      },
    });
  }

  async saveUngroupedThread(thread: UngroupedThread): Promise<void> {
    await this.saveUngroupedThreads([thread]);
  }

  async saveUngroupedThreads(threads: UngroupedThread[]): Promise<void> {
    if (threads.length === 0) return;

    // Process threads in batches to avoid transaction timeout
    // Batch size of 500 should keep each transaction under 30 seconds
    const BATCH_SIZE = 500;
    const batches: UngroupedThread[][] = [];
    
    for (let i = 0; i < threads.length; i += BATCH_SIZE) {
      batches.push(threads.slice(i, i + BATCH_SIZE));
    }

    // Process each batch in a separate transaction with increased timeout
    for (const batch of batches) {
      await prisma.$transaction(async (tx) => {
        for (const thread of batch) {
          // Ensure thread exists in classified_threads and update match_status
          await tx.classifiedThread.upsert({
            where: { threadId: thread.thread_id },
            update: {
              matchStatus: thread.reason, // 'no_matches' or 'below_threshold'
            },
            create: {
              threadId: thread.thread_id,
              channelId: thread.channel_id,
              threadName: thread.thread_name ?? null,
              status: "completed",
              matchStatus: thread.reason, // 'no_matches' or 'below_threshold'
            },
          });

          // Upsert ungrouped thread
          await tx.ungroupedThread.upsert({
            where: { threadId: thread.thread_id },
            update: {
              reason: thread.reason,
              topIssueNumber: thread.top_issue?.number ?? null,
              topIssueTitle: thread.top_issue?.title ?? null,
              topIssueSimilarity: thread.top_issue?.similarity_score ? new Decimal(thread.top_issue.similarity_score) : null,
              affectsFeatures: thread.affects_features ? JSON.parse(JSON.stringify(thread.affects_features)) : [],
            },
            create: {
              threadId: thread.thread_id,
              channelId: thread.channel_id,
              reason: thread.reason,
              topIssueNumber: thread.top_issue?.number ?? null,
              topIssueTitle: thread.top_issue?.title ?? null,
              topIssueSimilarity: thread.top_issue?.similarity_score ? new Decimal(thread.top_issue.similarity_score) : null,
              affectsFeatures: thread.affects_features ? JSON.parse(JSON.stringify(thread.affects_features)) : [],
            },
          });
        }
      }, {
        timeout: 30000, // 30 seconds timeout per batch
      });
    }
  }

  async getUngroupedThreads(channelId: string): Promise<UngroupedThread[]> {
    const ungrouped = await prisma.ungroupedThread.findMany({
      where: { channelId },
      include: {
        thread: true,
      },
      orderBy: { updatedAt: "desc" },
    });

    return ungrouped.map((ut) => ({
      thread_id: ut.threadId,
      channel_id: ut.channelId,
      thread_name: ut.thread.threadName ?? undefined,
      url: ut.thread.firstMessageUrl ?? undefined,
      author: ut.thread.firstMessageAuthor ?? undefined,
      timestamp: ut.thread.firstMessageTimestamp?.toISOString(),
      reason: ut.reason as "no_matches" | "below_threshold",
      affects_features: (Array.isArray(ut.affectsFeatures) ? ut.affectsFeatures : []) as Array<{ id: string; name: string }>,
      top_issue: ut.topIssueNumber
        ? {
            number: ut.topIssueNumber,
            title: ut.topIssueTitle ?? "",
            similarity_score: ut.topIssueSimilarity?.toNumber() ?? 0,
          }
        : undefined,
    }));
  }

  async getStats(channelId: string): Promise<StorageStats> {
    const [totalThreads, groupsData, ungroupedCount, issuesData] = await Promise.all([
      prisma.classifiedThread.count({ where: { channelId } }),
      prisma.group.groupBy({
        by: ["id"],
        where: { channelId },
        _count: { id: true },
        _sum: { threadCount: true },
      }),
      prisma.ungroupedThread.count({ where: { channelId } }),
      prisma.threadIssueMatch.findMany({
        where: {
          thread: { channelId },
        },
        distinct: ["issueNumber"],
        select: { issueNumber: true },
      }),
    ]);

    const groupedThreads = groupsData.reduce((sum, g) => sum + (g._sum.threadCount ?? 0), 0);
    const multiThreadGroups = groupsData.filter((g) => (g._sum.threadCount ?? 0) > 1).length;
    const singleThreadGroups = groupsData.filter((g) => (g._sum.threadCount ?? 0) === 1).length;
    const uniqueIssues = issuesData.length;

    return {
      totalThreads,
      groupedThreads,
      ungroupedThreads: ungroupedCount,
      uniqueIssues,
      multiThreadGroups,
      singleThreadGroups,
    };
  }

  async isAvailable(): Promise<boolean> {
    try {
      await prisma.$queryRaw`SELECT 1`;
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

    await prisma.$transaction(async (tx) => {
      for (const doc of docs) {
        // Insert/update documentation
        await tx.documentationCache.upsert({
          where: { url: doc.url },
          update: {
            title: doc.title ?? null,
            content: doc.content,
            fetchedAt: doc.fetched_at ? new Date(doc.fetched_at) : new Date(),
          },
          create: {
            url: doc.url,
            title: doc.title ?? null,
            content: doc.content,
            fetchedAt: doc.fetched_at ? new Date(doc.fetched_at) : new Date(),
          },
        });

        // Delete existing sections and insert new ones
        await tx.documentationSection.deleteMany({
          where: { documentationUrl: doc.url },
        });

        if (doc.sections && doc.sections.length > 0) {
          await tx.documentationSection.createMany({
            data: doc.sections.map((section, index) => ({
              documentationUrl: doc.url,
              title: section.title,
              content: section.content,
              sectionUrl: section.url ?? null,
              sectionOrder: index,
            })),
          });
        }
      }
    });
  }

  async getDocumentation(url: string): Promise<DocumentationContent | null> {
    const doc = await prisma.documentationCache.findUnique({
      where: { url },
      include: {
        sections: {
          orderBy: { sectionOrder: "asc" },
        },
      },
    });

    if (!doc) {
      return null;
    }

    return {
      url: doc.url,
      title: doc.title ?? undefined,
      content: doc.content,
      sections: doc.sections.length > 0
        ? doc.sections.map((s) => ({
            title: s.title,
            content: s.content,
            url: s.sectionUrl ?? undefined,
          }))
        : undefined,
      fetched_at: doc.fetchedAt.toISOString(),
    };
  }

  async getDocumentationMultiple(urls: string[]): Promise<DocumentationContent[]> {
    if (urls.length === 0) return [];

    const docs = await prisma.documentationCache.findMany({
      where: { url: { in: urls } },
      include: {
        sections: {
          orderBy: { sectionOrder: "asc" },
        },
      },
    });

    return docs.map((doc) => ({
      url: doc.url,
      title: doc.title ?? undefined,
      content: doc.content,
      sections: doc.sections.length > 0
        ? doc.sections.map((s) => ({
            title: s.title,
            content: s.content,
            url: s.sectionUrl ?? undefined,
          }))
        : undefined,
      fetched_at: doc.fetchedAt.toISOString(),
    }));
  }

  async getAllCachedDocumentation(): Promise<DocumentationContent[]> {
    const docs = await prisma.documentationCache.findMany({
      include: {
        sections: {
          orderBy: { sectionOrder: "asc" },
        },
      },
      orderBy: { fetchedAt: "desc" },
    });

    return docs.map((doc) => ({
      url: doc.url,
      title: doc.title ?? undefined,
      content: doc.content,
      sections: doc.sections.length > 0
        ? doc.sections.map((s) => ({
            title: s.title,
            content: s.content,
            url: s.sectionUrl ?? undefined,
          }))
        : undefined,
      fetched_at: doc.fetchedAt.toISOString(),
    }));
  }

  async clearDocumentationCache(): Promise<void> {
    // Sections will be deleted automatically due to CASCADE
    await prisma.documentationCache.deleteMany({});
  }

  async saveFeatures(urls: string[], features: ProductFeature[], docCount: number): Promise<void> {
    // Sort URLs for consistent comparison
    const sortedUrls = [...urls].map((u) => u.toLowerCase().trim()).sort();

    await prisma.$transaction(async (tx) => {
      // Insert each feature as a separate row (normalized)
      for (const feature of features) {
        await tx.feature.upsert({
          where: { id: feature.id },
          update: {
            name: feature.name,
            description: feature.description ?? null,
            category: feature.category ?? null,
            priority: feature.priority ?? null,
            relatedKeywords: feature.related_keywords ?? [],
            documentationSection: feature.documentation_section ?? null,
            documentationUrls: sortedUrls,
            extractedAt: new Date(),
          },
          create: {
            id: feature.id,
            name: feature.name,
            description: feature.description ?? null,
            category: feature.category ?? null,
            priority: feature.priority ?? null,
            relatedKeywords: feature.related_keywords ?? [],
            documentationSection: feature.documentation_section ?? null,
            documentationUrls: sortedUrls,
            extractedAt: new Date(),
          },
        });
      }
    });

    // After saving features, compute embeddings if OPENAI_API_KEY is available
    // This ensures embeddings are ready when matching groups/threads to features
    if (process.env.OPENAI_API_KEY && features.length > 0) {
      try {
        const { computeAndSaveFeatureEmbeddings } = await import("./embeddings.js");
        // Only compute embeddings for newly saved features (computeAndSaveFeatureEmbeddings
        // will check which features already have embeddings and skip them)
        await computeAndSaveFeatureEmbeddings(process.env.OPENAI_API_KEY);
      } catch (error) {
        // Log but don't fail - embeddings can be computed on-demand later
        console.error(`[saveFeatures] Warning: Failed to compute feature embeddings automatically:`, error);
      }
    }
  }

  async getFeatures(urls: string[]): Promise<{ features: ProductFeature[]; extracted_at: string; documentation_count: number } | null> {
    // Sort URLs for consistent comparison
    const sortedUrls = [...urls].map((u) => u.toLowerCase().trim()).sort();

    // Query features that match all the provided URLs
    // Using Prisma's array contains operator
    const features = await prisma.feature.findMany({
      where: {
        documentationUrls: {
          hasEvery: sortedUrls,
        },
      },
      orderBy: { id: "asc" },
    });

    if (features.length === 0) {
      return null;
    }

    // Get the most recent extracted_at
    const mostRecent = await prisma.feature.findFirst({
      where: {
        documentationUrls: {
          hasEvery: sortedUrls,
        },
      },
      orderBy: { extractedAt: "desc" },
      select: { extractedAt: true },
    });

    return {
      features: features.map((f) => ({
        id: f.id,
        name: f.name,
        description: f.description ?? "",
        category: f.category ?? undefined,
        priority: f.priority as "high" | "medium" | "low" | undefined,
        related_keywords: f.relatedKeywords,
        documentation_section: f.documentationSection ?? undefined,
      })),
      extracted_at: mostRecent?.extractedAt.toISOString() ?? new Date().toISOString(),
      documentation_count: features.length,
    };
  }

  async clearFeaturesCache(): Promise<void> {
    await prisma.feature.deleteMany({});
  }

  async saveClassificationHistoryEntry(channelId: string, messageId: string, threadId?: string): Promise<void> {
    await prisma.classificationHistory.upsert({
      where: {
        channelId_messageId: {
          channelId,
          messageId,
        },
      },
      update: {
        threadId: threadId ?? null,
        classifiedAt: new Date(),
      },
      create: {
        channelId,
        messageId,
        threadId: threadId ?? null,
        classifiedAt: new Date(),
      },
    });
  }

  async getClassificationHistory(channelId: string): Promise<Array<{ message_id: string; thread_id?: string; classified_at: string }>> {
    const history = await prisma.classificationHistory.findMany({
      where: { channelId },
      orderBy: { classifiedAt: "desc" },
    });

    return history.map((entry) => ({
      message_id: entry.messageId,
      thread_id: entry.threadId ?? undefined,
      classified_at: entry.classifiedAt.toISOString(),
    }));
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
    if (issues.length === 0) return;

    // Process issues in batches to avoid transaction timeout
    // Batch size of 50 should keep each transaction under 5 seconds
    const BATCH_SIZE = 50;
    const batches: typeof issues[] = [];
    
    for (let i = 0; i < issues.length; i += BATCH_SIZE) {
      batches.push(issues.slice(i, i + BATCH_SIZE));
    }

    // Process each batch in a separate transaction with increased timeout
    for (const batch of batches) {
      await prisma.$transaction(async (tx) => {
        for (const issue of batch) {
          await tx.gitHubIssue.upsert({
            where: { issueNumber: issue.number },
            update: {
              issueTitle: issue.title,
              issueUrl: issue.url,
              issueState: issue.state ?? null,
              issueBody: issue.body ?? null,
              issueLabels: issue.labels ?? [],
              issueAuthor: issue.author ?? null,
              issueCreatedAt: issue.created_at ? new Date(issue.created_at) : null,
              issueUpdatedAt: issue.updated_at ? new Date(issue.updated_at) : null,
              issueComments: issue.comments ? (issue.comments as any) : [],
              issueAssignees: issue.assignees ? issue.assignees.map(a => a.login) : [],
              issueMilestone: issue.milestone?.title ?? null,
              issueReactions: issue.reactions ? (issue.reactions as any) : null,
            },
            create: {
              issueNumber: issue.number,
              issueTitle: issue.title,
              issueUrl: issue.url,
              issueState: issue.state ?? null,
              issueBody: issue.body ?? null,
              issueLabels: issue.labels ?? [],
              issueAuthor: issue.author ?? null,
              issueCreatedAt: issue.created_at ? new Date(issue.created_at) : null,
              issueUpdatedAt: issue.updated_at ? new Date(issue.updated_at) : null,
              issueComments: issue.comments ? (issue.comments as any) : [],
              issueAssignees: issue.assignees ? issue.assignees.map(a => a.login) : [],
              issueMilestone: issue.milestone?.title ?? null,
              issueReactions: issue.reactions ? (issue.reactions as any) : null,
            },
          });
        }
      }, {
        timeout: 30000, // 30 seconds timeout per batch (should be more than enough for 50 issues)
      });
    }
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
    const where: { inGroup?: boolean; matchedToThreads?: boolean; issueState?: string } = {};
    if (options?.inGroup !== undefined) {
      where.inGroup = options.inGroup;
    }
    if (options?.matchedToThreads !== undefined) {
      where.matchedToThreads = options.matchedToThreads;
    }
    if (options?.state) {
      where.issueState = options.state;
    }

    const issues = await prisma.gitHubIssue.findMany({
      where,
      orderBy: { issueNumber: "desc" },
    });

    return issues.map((issue) => ({
      number: issue.issueNumber,
      title: issue.issueTitle,
      url: issue.issueUrl,
      state: issue.issueState ?? undefined,
      body: issue.issueBody ?? undefined,
      labels: issue.issueLabels,
      author: issue.issueAuthor ?? undefined,
      created_at: issue.issueCreatedAt?.toISOString(),
      updated_at: issue.issueUpdatedAt?.toISOString(),
      in_group: issue.inGroup,
      matched_to_threads: issue.matchedToThreads,
    }));
  }

}
