/**
 * PostgreSQL database storage implementation using Prisma
 */

import type { IStorage } from "../interface.js";
import type { ClassifiedThread, Group, UngroupedThread, StorageStats } from "../types.js";
import type { DocumentationContent } from "../../export/documentationFetcher.js";
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

  async saveClassifiedThread(thread: ClassifiedThread): Promise<void> {
    await this.saveClassifiedThreads([thread]);
  }

  async saveClassifiedThreads(threads: ClassifiedThread[]): Promise<void> {
    if (threads.length === 0) return;

    await prisma.$transaction(async (tx) => {
      for (const thread of threads) {
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
    if (groups.length === 0) return;

    await prisma.$transaction(async (tx) => {
      for (const group of groups) {
        // Upsert group
        await tx.group.upsert({
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
            affectsFeatures: group.affects_features ? JSON.parse(JSON.stringify(group.affects_features)) : [],
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
            affectsFeatures: group.affects_features ? JSON.parse(JSON.stringify(group.affects_features)) : [],
          },
        });

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
      }
    });
  }

  async getGroups(channelId: string, options?: { status?: "pending" | "exported" }): Promise<Group[]> {
    const where: any = { channelId };
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

    await prisma.$transaction(async (tx) => {
      for (const thread of threads) {
        // Ensure thread exists in classified_threads
        await tx.classifiedThread.upsert({
          where: { threadId: thread.thread_id },
          update: {},
          create: {
            threadId: thread.thread_id,
            channelId: thread.channel_id,
            threadName: thread.thread_name ?? null,
            status: "completed",
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
          },
          create: {
            threadId: thread.thread_id,
            channelId: thread.channel_id,
            reason: thread.reason,
            topIssueNumber: thread.top_issue?.number ?? null,
            topIssueTitle: thread.top_issue?.title ?? null,
            topIssueSimilarity: thread.top_issue?.similarity_score ? new Decimal(thread.top_issue.similarity_score) : null,
          },
        });
      }
    });
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

  async saveFeatures(urls: string[], features: any[], docCount: number): Promise<void> {
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
  }

  async getFeatures(urls: string[]): Promise<{ features: any[]; extracted_at: string; documentation_count: number } | null> {
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
        description: f.description,
        category: f.category,
        priority: f.priority,
        related_keywords: f.relatedKeywords,
        documentation_section: f.documentationSection,
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
}
