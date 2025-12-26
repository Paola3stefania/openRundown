/**
 * Export grouping results to PM tools
 * Converts semantic grouping output to PM tool issues
 */

import { log, logError } from "../mcp/logger.js";
import { createPMTool } from "./factory.js";
import type { PMToolConfig, PMToolIssue } from "./types.js";
import type { ExportWorkflowResult } from "./workflow.js";
import { getConfig } from "../config/index.js";

interface GroupingSignal {
  source: string;
  id: string;
  title: string;
  url: string;
}

interface GroupingGroup {
  id: string;
  suggested_title?: string; // Optional - may come from github_issue.title for issue-based grouping
  github_issue?: {
    number: number;
    title: string;
    url: string;
    state: string;
    labels?: string[];
  };
  similarity?: number;
  avg_similarity?: number; // Issue-based grouping uses avg_similarity
  is_cross_cutting?: boolean;
  affects_features?: Array<{ id: string; name: string }>;
  signals?: GroupingSignal[];
  threads?: Array<{ // Issue-based grouping format
    thread_id: string;
    thread_name?: string;
    similarity_score: number;
    url?: string;
    author?: string;
  }>;
  canonical_issue?: {
    source: string;
    id: string;
    title?: string;
    url: string;
  } | null;
  // Export tracking fields
  status?: "pending" | "exported";
  exported_at?: string;
  linear_issue_id?: string;
  linear_issue_url?: string;
  linear_issue_identifier?: string; // e.g., "LIN-123"
  linear_project_ids?: string[];
}

interface GroupingData {
  timestamp: string;
  channel_id: string;
  stats: {
    totalSignals: number;
    groupedSignals: number;
    crossCuttingGroups: number;
  };
  features: Array<{ id: string; name: string }>;
  groups: GroupingGroup[];
}

/**
 * Export grouping results directly to PM tool
 * Assumes groups are already matched to features (via match_groups_to_features)
 */
export async function exportGroupingToPMTool(
  groupingData: GroupingData,
  pmToolConfig: PMToolConfig
): Promise<ExportWorkflowResult> {
  const result: ExportWorkflowResult = {
    success: false,
    features_extracted: groupingData.features?.length || 0,
    features_mapped: groupingData.groups.length,
    errors: [],
  };

  try {
    const pmTool = createPMTool(pmToolConfig);
    
    // Validate team for Linear
    if (pmToolConfig.type === "linear") {
      const linearTool = pmTool as any;
      if (typeof linearTool.validateTeam === "function") {
        await linearTool.validateTeam(true, "UNMute");
        if (linearTool.teamId && !pmToolConfig.team_id) {
          pmToolConfig.team_id = linearTool.teamId;
        }
      }
    }

    // Use features from grouping data (already matched)
    const features = groupingData.features || [{ id: "general", name: "General" }];
    
    // Use groups from grouping data (already matched to features)
    const groupsWithFeatures = groupingData.groups;

    // Create projects for features (Linear only)
    const projectMappings = new Map<string, string>(); // feature_id -> project_id
    
    if (pmToolConfig.type === "linear") {
      const linearTool = pmTool as any;
      if (typeof linearTool.createOrGetProject === "function") {
        for (const feature of features) {
          try {
            const projectId = await linearTool.createOrGetProject(
              feature.id,
              feature.name,
              `Feature: ${feature.name}`
            );
            projectMappings.set(feature.id, projectId);
            log(`Created/verified project for feature: ${feature.name}`);
          } catch (error) {
            logError(`Failed to create project for ${feature.name}:`, error);
          }
        }
      }
    }

    // Ensure all groups have suggested_title before export
    // Generate missing titles from thread titles or GitHub issue title
    for (const group of groupsWithFeatures) {
      if (!group.suggested_title) {
        // Generate title from threads or use GitHub issue title
        if (group.threads && group.threads.length > 0) {
          const threadTitles = group.threads
            .map(t => t.thread_name)
            .filter((name): name is string => !!name && name.trim().length > 0);
          
          if (threadTitles.length > 0) {
            // Use shortest thread title or GitHub issue title
            const shortestTitle = threadTitles.reduce((shortest, current) => 
              current.length < shortest.length ? current : shortest
            );
            group.suggested_title = shortestTitle.length > 100 
              ? shortestTitle.substring(0, 97) + "..." 
              : shortestTitle;
          } else {
            group.suggested_title = group.github_issue?.title || "Untitled Group";
          }
        } else {
          group.suggested_title = group.github_issue?.title || "Untitled Group";
        }
      }
    }

    // Convert groups to PM tool issues
    const pmIssues: PMToolIssue[] = [];
    const groupToIssueMap = new Map<string, { id: string; url: string; identifier?: string }>(); // group.id -> Linear issue info
    const issueToGroupMap = new Map<number, GroupingGroup>(); // pmIssues index -> group
    
    for (const group of groupsWithFeatures) {
      // Extract title - now guaranteed to exist
      const title = group.suggested_title!;
      
      // Extract similarity - handle both formats
      const similarity = group.similarity ?? (group.avg_similarity ? group.avg_similarity / 100 : 0);
      
      // Extract signals/threads - handle both formats
      // URLs should already be present from classification, but construct if missing
      // Try to extract guild_id from existing URLs first, then fall back to config
      let guildId: string | undefined;
      
      // Extract guild_id from first available URL in any thread
      if (group.threads && group.threads.length > 0) {
        for (const thread of group.threads) {
          if (thread.url) {
            // Parse Discord URL: https://discord.com/channels/{guild_id}/{channel_id}/{message_id}
            const match = thread.url.match(/discord\.com\/channels\/(\d+)\/(\d+)\/(\d+)/);
            if (match && match[1]) {
              guildId = match[1];
              break;
            }
          }
        }
      }
      
      // Fall back to config if not found in URLs
      if (!guildId) {
        const config = getConfig();
        guildId = config.discord.serverId;
      }
      
      const signals = group.signals || (group.threads ? group.threads.map(t => {
        let url = t.url || "";
        // Construct Discord thread URL if missing (need guild_id, channel_id, and message_id)
        if (!url && t.thread_id && groupingData.channel_id && guildId) {
          // Discord thread URL format: https://discord.com/channels/{guild_id}/{channel_id}/{message_id}
          // For threads, we use the thread_id as the message_id
          url = `https://discord.com/channels/${guildId}/${groupingData.channel_id}/${t.thread_id}`;
        }
        return {
          source: "discord",
          id: t.thread_id,
          title: t.thread_name || `Thread ${t.thread_id}`,
          url: url,
        };
      }) : []);
      
      // If we have a github_issue, add it as a signal (URL should always be present)
      if (group.github_issue) {
        signals.unshift({
          source: "github",
          id: group.github_issue.number.toString(),
          title: group.github_issue.title,
          url: group.github_issue.url || `https://github.com/${group.github_issue.number}`, // Fallback if URL missing
        });
      }
      
      // Ensure threads have URLs (they should already from classification)
      // But also ensure threads array has URLs for the description builder
      // Reuse guildId extracted above
      const threadsWithUrls = group.threads ? group.threads.map(t => {
        let url = t.url || "";
        // Construct URL if missing (need guild_id, channel_id, and message_id)
        if (!url && t.thread_id && groupingData.channel_id && guildId) {
          // Discord thread URL format: https://discord.com/channels/{guild_id}/{channel_id}/{message_id}
          url = `https://discord.com/channels/${guildId}/${groupingData.channel_id}/${t.thread_id}`;
        }
        return {
          ...t,
          url: url,
        };
      }) : undefined;
      
      // Build description with sources and Discord summary
      const description = buildGroupDescription({
        ...group,
        suggested_title: title,
        similarity,
        signals,
        threads: threadsWithUrls, // Pass threads with guaranteed URLs
      });
      
      // Determine project ID (use first affected feature, or none for cross-cutting)
      let projectId: string | undefined;
      const affectsFeatures = group.affects_features || [];
      if (affectsFeatures.length === 1) {
        projectId = projectMappings.get(affectsFeatures[0].id);
      }
      // For cross-cutting issues, we'll tag them but not assign to a single project
      
      // Generate labels for cross-cutting issues
      const labels: string[] = [];
      if (group.is_cross_cutting) {
        labels.push("cross-cutting");
        // Add feature names as labels
        for (const feature of affectsFeatures) {
          labels.push(feature.name.toLowerCase().replace(/\s+/g, "-"));
        }
      }
      
      // Add GitHub issue labels if available
      if (group.github_issue?.labels) {
        labels.push(...group.github_issue.labels);
      }

      const issueIndex = pmIssues.length;
      pmIssues.push({
        title,
        description,
        feature_id: affectsFeatures[0]?.id || "general",
        feature_name: affectsFeatures[0]?.name || "General",
        project_id: projectId,
        source: group.github_issue ? "github" : (group.canonical_issue?.source === "github" ? "github" : "discord"),
        source_url: group.github_issue?.url || group.canonical_issue?.url || signals[0]?.url || "",
        source_id: group.id,
        labels,
        priority: group.is_cross_cutting ? "high" : "medium", // Cross-cutting issues get higher priority
        metadata: {
          similarity,
          is_cross_cutting: group.is_cross_cutting || false,
          affects_features: affectsFeatures.map(f => f.name),
          signal_count: signals.length,
          signals,
          github_issue_number: group.github_issue?.number,
        },
      });
      issueToGroupMap.set(issueIndex, group);
    }

    // Export to PM tool
    log(`Exporting ${pmIssues.length} issues to ${pmToolConfig.type}...`);
    const exportResult = await pmTool.exportIssues(pmIssues);

    // Track which groups were exported (map source_id back to group.id)
    for (let i = 0; i < pmIssues.length; i++) {
      const issue = pmIssues[i];
      const group = issueToGroupMap.get(i);
      if (!group) continue;
      
      if (issue.linear_issue_id) {
        // Get URL from issue object (set by base class) or construct from identifier
        const issueUrl = (issue as any).linear_issue_url || 
          (issue.linear_issue_identifier ? `https://linear.app/${pmToolConfig.workspace_id || 'workspace'}/issue/${issue.linear_issue_identifier}` : '');
        
        groupToIssueMap.set(group.id, {
          id: issue.linear_issue_id,
          url: issueUrl,
          identifier: issue.linear_issue_identifier || undefined, // Linear identifier like "LIN-123"
        });
      }
    }

    result.success = true;
    result.issues_exported = {
      created: exportResult.created_issues,
      updated: exportResult.updated_issues,
      skipped: exportResult.skipped_issues,
    };

    if (exportResult.errors && exportResult.errors.length > 0) {
      result.errors = exportResult.errors.map(e => `${e.source_id}: ${e.error}`);
    }

    log(`Export complete: ${exportResult.created_issues} created, ${exportResult.updated_issues} updated, ${exportResult.skipped_issues} skipped`);

    // Return result with group export mappings for updating the JSON file
    return {
      ...result,
      group_export_mappings: Array.from(groupToIssueMap.entries()).map(([group_id, issue_info]) => ({
        group_id,
        ...issue_info,
      })),
    };
  } catch (error) {
    logError("Grouping export failed:", error);
    result.success = false;
    result.errors = result.errors || [];
    result.errors.push(error instanceof Error ? error.message : String(error));
    return result;
  }
}

/**
 * Build description for a group issue
 */
function buildGroupDescription(group: {
  suggested_title?: string;
  similarity?: number;
  is_cross_cutting?: boolean;
  affects_features?: Array<{ id: string; name: string }>;
  signals: GroupingSignal[];
  threads?: Array<{
    thread_id: string;
    thread_name?: string;
    similarity_score?: number;
    url?: string;
    author?: string;
  }>;
}): string {
  const parts: string[] = [];
  
  // Get Discord threads early (used in multiple places)
  const discordThreads = group.threads || [];
  
  // Problem summary
  parts.push("## Problem Summary");
  parts.push("");
  const signalCount = group.signals?.length || 0;
  const githubCount = (group.signals || []).filter(s => s.source === "github").length;
  const discordCount = discordThreads.length || (group.signals || []).filter(s => s.source === "discord").length;
  const similarityPercent = group.similarity ? Math.round(group.similarity * 100) : 0;
  
  // Build summary based on what's in the group
  const summaryParts: string[] = [];
  if (githubCount > 0 && discordCount > 0) {
    summaryParts.push(`${githubCount} GitHub issue${githubCount !== 1 ? 's' : ''} and ${discordCount} Discord thread${discordCount !== 1 ? 's' : ''}`);
  } else if (githubCount > 0) {
    summaryParts.push(`${githubCount} GitHub issue${githubCount !== 1 ? 's' : ''}`);
  } else if (discordCount > 0) {
    summaryParts.push(`${discordCount} Discord thread${discordCount !== 1 ? 's' : ''}`);
  }
  
  if (summaryParts.length > 0) {
    const summary = `This issue was identified from ${summaryParts.join(' and ')}`;
    if (similarityPercent > 0) {
      parts.push(`${summary} with ${similarityPercent}% similarity.`);
    } else {
      parts.push(`${summary}.`);
    }
  } else {
    parts.push("This issue was identified from related discussions.");
  }
  parts.push("");
  
  // Discord discussions summary
  if (discordThreads.length > 0) {
    parts.push("### Discord Discussions Summary");
    parts.push("");
    parts.push(`**${discordThreads.length} Discord thread${discordThreads.length !== 1 ? 's' : ''}** discussed this issue:`);
    parts.push("");
    
    // Group threads by similarity to show patterns
    const highSimilarity = discordThreads.filter(t => (t.similarity_score || 0) >= 80);
    const mediumSimilarity = discordThreads.filter(t => {
      const score = t.similarity_score || 0;
      return score >= 60 && score < 80;
    });
    
    if (highSimilarity.length > 0) {
      parts.push(`**High similarity (≥80%):** ${highSimilarity.length} thread${highSimilarity.length !== 1 ? 's' : ''}`);
      for (const thread of highSimilarity.slice(0, 5)) { // Show top 5
        const title = thread.thread_name || `Thread ${thread.thread_id}`;
        const score = thread.similarity_score ? Math.round(thread.similarity_score) : 0;
        parts.push(`- ${title} (${score}% match)${thread.url ? ` - [View](${thread.url})` : ''}`);
      }
      if (highSimilarity.length > 5) {
        parts.push(`- ... and ${highSimilarity.length - 5} more`);
      }
      parts.push("");
    }
    
    if (mediumSimilarity.length > 0) {
      parts.push(`**Medium similarity (60-79%):** ${mediumSimilarity.length} thread${mediumSimilarity.length !== 1 ? 's' : ''}`);
      if (mediumSimilarity.length <= 3) {
        for (const thread of mediumSimilarity) {
          const title = thread.thread_name || `Thread ${thread.thread_id}`;
          const score = thread.similarity_score ? Math.round(thread.similarity_score) : 0;
          parts.push(`- ${title} (${score}% match)${thread.url ? ` - [View](${thread.url})` : ''}`);
        }
      } else {
        parts.push(`- ${mediumSimilarity.length} threads with medium similarity`);
      }
      parts.push("");
    }
    
    // Common themes from thread titles
    const threadTitles = discordThreads
      .map(t => t.thread_name)
      .filter((name): name is string => !!name && name.trim().length > 0);
    
    if (threadTitles.length > 1) {
      // Extract common keywords
      const stopWords = new Set(['the', 'a', 'an', 'and', 'or', 'but', 'in', 'on', 'at', 'to', 'for', 'of', 'with', 'by', 'how', 'what', 'when', 'where', 'why', 'can', 'should', 'would']);
      const wordFreq = new Map<string, number>();
      
      for (const title of threadTitles) {
        const words = title.toLowerCase()
          .replace(/[^\w\s]/g, ' ')
          .split(/\s+/)
          .filter(w => w.length > 3 && !stopWords.has(w));
        
        for (const word of words) {
          wordFreq.set(word, (wordFreq.get(word) || 0) + 1);
        }
      }
      
      const commonWords = Array.from(wordFreq.entries())
        .filter(([_, count]) => count >= 2)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 5)
        .map(([word]) => word);
      
      if (commonWords.length > 0) {
        parts.push(`**Common themes:** ${commonWords.join(", ")}`);
        parts.push("");
      }
    }
  }
  
  // Cross-cutting notice
  if (group.is_cross_cutting && group.affects_features && group.affects_features.length > 0) {
    parts.push("### ⚠️ Cross-Cutting Issue");
    parts.push("");
    parts.push(`This affects multiple features: **${group.affects_features.map(f => f.name).join(", ")}**`);
    parts.push("");
  }
  
  // Sources - only show section if there are links
  const githubSignals = (group.signals || []).filter(s => s.source === "github");
  const discordSignals = (group.signals || []).filter(s => s.source === "discord");
  const hasAnyLinks = githubSignals.length > 0 || discordThreads.length > 0 || discordSignals.length > 0;
  
  if (hasAnyLinks) {
    parts.push("---");
    parts.push("");
    parts.push("## Related Links");
    parts.push("");
    
    // GitHub sources - always show links (URLs should always be present)
    if (githubSignals.length > 0) {
      parts.push("### GitHub Issues");
      for (const signal of githubSignals) {
        // URL should always be present, but handle gracefully if missing
        if (signal.url) {
          parts.push(`- [#${signal.id} ${signal.title}](${signal.url})`);
        } else {
          parts.push(`- #${signal.id} ${signal.title} (URL missing)`);
        }
      }
      parts.push("");
      parts.push("> 💡 **Tip:** Reference this Linear issue in your PR with `Fixes LIN-XXX` or `Closes LIN-XXX` to auto-close when merged.");
      parts.push("");
    }
    
    // Discord sources (detailed list with all threads)
    // Use threads if available (more complete info), otherwise fall back to signals
    // URLs should always be present after construction above
    if (discordThreads.length > 0) {
      parts.push("### All Discord Threads");
      parts.push("");
      for (const thread of discordThreads) {
        const title = thread.thread_name || `Thread ${thread.thread_id}`;
        const threadId = thread.thread_id || "";
        const url = thread.url || "";
        const author = thread.author ? ` by @${thread.author}` : "";
        const score = thread.similarity_score ? ` (${Math.round(thread.similarity_score)}% match)` : "";
        
        // Always show as link if URL is present (should be after construction)
        if (url) {
          parts.push(`- [${title}](${url})${author}${score}`);
        } else {
          // Fallback: show title and thread ID if URL is still missing
          parts.push(`- ${title}${author}${score}`);
        }
        
        // Always show thread ID for reference
        if (threadId) {
          parts.push(`  - Thread ID: \`${threadId}\``);
        }
      }
    } else if (discordSignals.length > 0) {
      parts.push("### All Discord Threads");
      parts.push("");
      for (const signal of discordSignals) {
        // Always show as link if URL is present
        if (signal.url) {
          parts.push(`- [${signal.title}](${signal.url})`);
        } else {
          parts.push(`- ${signal.title}`);
        }
        if (signal.id) {
          parts.push(`  - Thread ID: \`${signal.id}\``);
        }
      }
    }
  }
  
  return parts.join("\n");
}

