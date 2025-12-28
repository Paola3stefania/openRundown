/**
 * Export grouping results to PM tools
 * Converts semantic grouping output to PM tool issues
 */

import { log, logError } from "../mcp/logger.js";
import { createPMTool } from "./factory.js";
import type { PMToolConfig, PMToolIssue } from "./types.js";
import type { ExportWorkflowResult } from "./workflow.js";
import { getConfig } from "../config/index.js";
import { join } from "path";

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
  ungrouped_threads?: Array<{
    thread_id: string;
    thread_name?: string;
    url?: string;
    author?: string;
    timestamp?: string;
    reason: "no_matches" | "below_threshold";
    top_issue?: {
      number: number;
      title: string;
      similarity_score: number;
    };
  }>;
}

/**
 * Generate a proper title for a group using LLM
 * Creates concise, descriptive titles following PR naming conventions
 */
async function generateGroupTitleWithLLM(group: GroupingGroup): Promise<string> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    // Fallback to non-LLM title if API key not available
    return generateFallbackTitle(group);
  }

  // Collect content from GitHub issues and threads
  const contentParts: string[] = [];
  
  if (group.github_issue) {
    contentParts.push(`GitHub Issue #${group.github_issue.number}: ${group.github_issue.title}`);
  }
  
  if (group.threads && group.threads.length > 0) {
    const threadInfo = group.threads
      .map(t => t.thread_name || `Thread ${t.thread_id}`)
      .slice(0, 5) // Limit to first 5 threads to avoid token limits
      .join(", ");
    contentParts.push(`Discord Threads: ${threadInfo}`);
  }

  if (contentParts.length === 0) {
    return generateFallbackTitle(group);
  }

  const contentToAnalyze = contentParts.join("\n\n");

  try {
    const response = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        messages: [
          {
            role: "system",
            content: `You are a technical writer creating concise issue titles. Generate a single, clear title (max 100 characters) that summarizes the problem or feature request.

Follow these guidelines:
- Be specific and actionable
- Use present tense ("Fix bug" not "Fixed bug")
- If it's a bug fix, start with "fix:"
- If it's a feature, start with "feat:"
- If it's documentation, start with "docs:"
- Keep it under 100 characters
- Don't include issue numbers or IDs
- Focus on the core problem or request

Return ONLY the title text, nothing else.`
          },
          {
            role: "user",
            content: `Generate a concise title for this group:\n\n${contentToAnalyze}`
          }
        ],
        temperature: 0.3,
        max_tokens: 150,
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      logError(`OpenAI API error for title generation: ${response.status} ${errorText}`);
      return generateFallbackTitle(group);
    }

    const data = await response.json();
    const title = data.choices[0]?.message?.content?.trim();
    
    if (title && title.length > 0 && title.length <= 150) {
      // Truncate if slightly over limit
      return title.length > 100 ? title.substring(0, 97) + "..." : title;
    }
    
    return generateFallbackTitle(group);
  } catch (error) {
    logError("Error generating title with LLM:", error);
    return generateFallbackTitle(group);
  }
}

/**
 * Generate a fallback title when LLM is unavailable or fails
 */
function generateFallbackTitle(group: GroupingGroup): string {
  // Priority 1: GitHub issue title
  if (group.github_issue?.title && group.github_issue.title.trim()) {
    return group.github_issue.title.length > 100 
      ? group.github_issue.title.substring(0, 97) + "..." 
      : group.github_issue.title;
  }
  
  // Priority 2: Thread titles
  if (group.threads && group.threads.length > 0) {
    const threadTitles = group.threads
      .map(t => t.thread_name)
      .filter((name): name is string => !!name && name.trim().length > 0);
    
    if (threadTitles.length > 0) {
      const shortestTitle = threadTitles.reduce((shortest, current) => 
        current.length < shortest.length ? current : shortest
      );
      return shortestTitle.length > 100 
        ? shortestTitle.substring(0, 97) + "..." 
        : shortestTitle;
    }
  }
  
  return "Untitled Group";
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
        // Ensure "general" feature is always in the list
        const hasGeneral = features.some(f => f.id === "general");
        if (!hasGeneral) {
          features.push({ id: "general", name: "General" });
        }
        
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
            // Continue with other features even if one fails
          }
        }
      }
    }

    // Always generate proper titles using LLM for all groups
    // This ensures consistent, well-formatted titles following PR naming conventions
    log(`Generating titles for ${groupsWithFeatures.length} groups using LLM...`);
    for (const group of groupsWithFeatures) {
      // Always generate title using LLM to ensure proper naming conventions
      // Check if current title looks like an ID - if so, definitely regenerate
      const currentTitle = group.suggested_title;
      const looksLikeId = currentTitle && /^[a-z]{2,10}-\d{10,}$/i.test(currentTitle.trim());
      
      // Always regenerate using LLM (even if title exists) to ensure consistency
      // Only skip if title exists, doesn't look like ID, and we want to preserve it
      // For now, always regenerate to ensure proper format
      try {
        group.suggested_title = await generateGroupTitleWithLLM(group);
      } catch (error) {
        logError(`Failed to generate title for group ${group.id}, using fallback:`, error);
        group.suggested_title = generateFallbackTitle(group);
      }
    }
    log(`Title generation complete`);

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
      
      // Determine project ID (use first affected feature, or "general" if none)
      const affectsFeatures = group.affects_features || [];
      
      // Ensure we have at least one feature (default to "general")
      const primaryFeature = affectsFeatures[0] || { id: "general", name: "General" };
      const featureId = primaryFeature.id;
      
      // Get project ID for the primary feature
      // Always get project ID for single-feature issues, or for issues with no features (use "general")
      // For cross-cutting issues (multiple features), we'll tag them but not assign to a single project
      let projectId: string | undefined;
      if (affectsFeatures.length <= 1) {
        // Single feature or no features - use the project for that feature (or "general")
        projectId = projectMappings.get(featureId);
      }
      // For cross-cutting issues (multiple features), projectId remains undefined
      
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
        feature_id: featureId,
        feature_name: primaryFeature.name,
        project_id: projectId,
        source: group.github_issue ? "github" : (group.canonical_issue?.source === "github" ? "github" : "discord"),
        source_url: group.github_issue?.url || group.canonical_issue?.url || signals[0]?.url || "",
        source_id: group.id,
        labels,
        priority: group.is_cross_cutting ? "high" : "medium", // Cross-cutting issues get higher priority
        // Pass existing Linear issue ID if group already has one (from previous export)
        linear_issue_id: group.linear_issue_id,
        linear_issue_identifier: group.linear_issue_identifier,
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

    // STEP 2: Export ungrouped threads (threads that didn't match any issues)
    const ungroupedThreads = groupingData.ungrouped_threads || [];
    log(`Preparing ${ungroupedThreads.length} ungrouped threads for export...`);
    
    for (const ungroupedThread of ungroupedThreads) {
      // Generate title for ungrouped thread
      const threadTitle = ungroupedThread.thread_name || `Discord Thread ${ungroupedThread.thread_id}`;
      const title = ungroupedThread.thread_name 
        ? `[Ungrouped] ${threadTitle}`
        : `[Ungrouped Thread] ${ungroupedThread.thread_id}`;
      
      // Build description
      const descriptionParts: string[] = [];
      descriptionParts.push("## Problem Summary");
      descriptionParts.push("");
      descriptionParts.push(`This Discord thread did not match any GitHub issues.`);
      descriptionParts.push("");
      
      if (ungroupedThread.reason === "below_threshold" && ungroupedThread.top_issue) {
        descriptionParts.push(`**Closest match:** GitHub issue #${ungroupedThread.top_issue.number} "${ungroupedThread.top_issue.title}" (${Math.round(ungroupedThread.top_issue.similarity_score)}% similarity, below threshold)`);
        descriptionParts.push("");
      } else {
        descriptionParts.push(`**Reason:** No matching GitHub issues found.`);
        descriptionParts.push("");
      }
      
      descriptionParts.push("---");
      descriptionParts.push("");
      descriptionParts.push("## Discord Thread");
      descriptionParts.push("");
      if (ungroupedThread.url) {
        descriptionParts.push(`- [View Thread](${ungroupedThread.url})`);
      }
      if (ungroupedThread.author) {
        descriptionParts.push(`- **Author:** @${ungroupedThread.author}`);
      }
      if (ungroupedThread.timestamp) {
        descriptionParts.push(`- **Created:** ${new Date(ungroupedThread.timestamp).toLocaleString()}`);
      }
      
      // Assign to "General" project
      const generalProjectId = projectMappings.get("general");
      
      const ungroupedThreadIssueIndex = pmIssues.length;
      pmIssues.push({
        title,
        description: descriptionParts.join("\n"),
        feature_id: "general",
        feature_name: "General",
        project_id: generalProjectId,
        source: "discord",
        source_url: ungroupedThread.url || "",
        source_id: `ungrouped-thread-${ungroupedThread.thread_id}`,
        labels: ["ungrouped", "discord-thread"],
        priority: "low",
        metadata: {
          thread_id: ungroupedThread.thread_id,
          reason: ungroupedThread.reason,
          top_issue: ungroupedThread.top_issue,
        },
      });
      
      // Store mapping for updating export status
      (ungroupedThread as any)._exportIndex = ungroupedThreadIssueIndex;
    }
    
    // STEP 3: Export ungrouped issues (GitHub issues that don't match any thread)
    log(`Finding ungrouped GitHub issues (issues not matched to any thread)...`);
    const ungroupedIssues: PMToolIssue[] = [];
    
    try {
      // Get all GitHub issues from database
      const { prisma } = await import("../storage/db/prisma.js");
      const { getStorage } = await import("../storage/factory.js");
      const storage = getStorage();
      
      // Get all issue numbers that have been matched to threads
      const matchedIssues = await prisma.threadIssueMatch.findMany({
        select: {
          issueNumber: true,
        },
        distinct: ["issueNumber"],
      });
      
      const matchedIssueNumbers = new Set(matchedIssues.map(i => i.issueNumber));
      
      // Load all issues from cache (this is our source of truth for all fetched issues)
      const config = getConfig();
      const issuesCachePath = join(process.cwd(), config.paths.cacheDir, config.paths.issuesCacheFile);
      const { readFile } = await import("fs/promises");
      const { existsSync } = await import("fs");
      
      if (!existsSync(issuesCachePath)) {
        log(`No issues cache found at ${issuesCachePath}. Skipping ungrouped issues export.`);
      } else {
        const issuesCacheContent = await readFile(issuesCachePath, "utf-8");
        const issuesCache = JSON.parse(issuesCacheContent);
        const allCachedIssues = issuesCache.issues || [];
        
        log(`Loaded ${allCachedIssues.length} issues from cache. ${matchedIssueNumbers.size} are matched to threads.`);
        
        // Find issues in cache that are NOT matched to any thread
        // These are our ungrouped issues
        for (const issue of allCachedIssues) {
          if (!matchedIssueNumbers.has(issue.number)) {
            // This issue doesn't have any thread matches - it's ungrouped
            const issueTitle = issue.title || `GitHub Issue #${issue.number}`;
            const title = `[Ungrouped Issue] ${issueTitle}`;
            
            const descriptionParts: string[] = [];
            descriptionParts.push("## Problem Summary");
            descriptionParts.push("");
            descriptionParts.push(`This GitHub issue did not match any Discord threads.`);
            descriptionParts.push("");
            
            if (issue.body) {
              descriptionParts.push("---");
              descriptionParts.push("");
              descriptionParts.push("## Issue Description");
              descriptionParts.push("");
              descriptionParts.push(issue.body);
              descriptionParts.push("");
            }
            
            descriptionParts.push("---");
            descriptionParts.push("");
            descriptionParts.push("## GitHub Issue");
            descriptionParts.push("");
            if (issue.url) {
              descriptionParts.push(`- [View Issue](${issue.url})`);
            }
            descriptionParts.push(`- **Number:** #${issue.number}`);
            if (issue.state) {
              descriptionParts.push(`- **State:** ${issue.state}`);
            }
            if (issue.labels && issue.labels.length > 0) {
              descriptionParts.push(`- **Labels:** ${issue.labels.join(", ")}`);
            }
            if (issue.author) {
              descriptionParts.push(`- **Author:** ${issue.author}`);
            }
            
            // Try to match to features based on issue content
            let featureId = "general";
            let featureName = "General";
            let projectId = projectMappings.get("general");
            
            // Simple keyword matching for feature assignment (could be enhanced with embeddings)
            if (groupingData.features && groupingData.features.length > 0) {
              const issueText = `${issue.title} ${issue.body || ""}`.toLowerCase();
              for (const feature of groupingData.features) {
                if (feature.name && issueText.includes(feature.name.toLowerCase())) {
                  featureId = feature.id;
                  featureName = feature.name;
                  projectId = projectMappings.get(feature.id);
                  break;
                }
              }
            }
            
            ungroupedIssues.push({
              title,
              description: descriptionParts.join("\n"),
              feature_id: featureId,
              feature_name: featureName,
              project_id: projectId,
              source: "github",
              source_url: issue.url || `https://github.com/issues/${issue.number}`,
              source_id: `ungrouped-issue-${issue.number}`,
              labels: ["ungrouped", "github-issue", ...(issue.labels || [])],
              priority: issue.state === "closed" ? "low" : "medium",
              metadata: {
                issue_number: issue.number,
                issue_state: issue.state,
                issue_author: issue.author,
              },
            });
            
            // Save ungrouped issue to database
            try {
              // Try to use UngroupedIssue model (should exist in Prisma client if schema is up to date)
              const ungroupedIssueModel = (prisma as any).ungroupedIssue;
              if (ungroupedIssueModel) {
                await ungroupedIssueModel.upsert({
                  where: { issueNumber: issue.number },
                  update: {
                    issueTitle: issue.title || `Issue #${issue.number}`,
                    issueUrl: issue.url || `https://github.com/issues/${issue.number}`,
                    issueState: issue.state || null,
                    issueBody: issue.body || null,
                    issueLabels: issue.labels || [],
                    issueAuthor: issue.author || null,
                    issueCreatedAt: issue.created_at ? new Date(issue.created_at) : null,
                    exportStatus: "pending",
                  },
                  create: {
                    issueNumber: issue.number,
                    issueTitle: issue.title || `Issue #${issue.number}`,
                    issueUrl: issue.url || `https://github.com/issues/${issue.number}`,
                    issueState: issue.state || null,
                    issueBody: issue.body || null,
                    issueLabels: issue.labels || [],
                    issueAuthor: issue.author || null,
                    issueCreatedAt: issue.created_at ? new Date(issue.created_at) : null,
                    exportStatus: "pending",
                  },
                });
              } else {
                // Fallback: save to GitHubIssue table if UngroupedIssue model doesn't exist yet
                // This can happen if Prisma client hasn't been regenerated after schema update
                logError(`UngroupedIssue model not available in Prisma client. Please run 'npx prisma generate'. Saving to GitHubIssue table instead.`);
                // Type assertion needed until Prisma client is regenerated
                await (prisma as any).gitHubIssue.upsert({
                  where: { issueNumber: issue.number },
                  update: {
                    issueTitle: issue.title || `Issue #${issue.number}`,
                    issueUrl: issue.url || `https://github.com/issues/${issue.number}`,
                    issueState: issue.state || null,
                    issueBody: issue.body || null,
                    issueLabels: issue.labels || [],
                    issueAuthor: issue.author || null,
                    issueCreatedAt: issue.created_at ? new Date(issue.created_at) : null,
                  },
                  create: {
                    issueNumber: issue.number,
                    issueTitle: issue.title || `Issue #${issue.number}`,
                    issueUrl: issue.url || `https://github.com/issues/${issue.number}`,
                    issueState: issue.state || null,
                    issueBody: issue.body || null,
                    issueLabels: issue.labels || [],
                    issueAuthor: issue.author || null,
                    issueCreatedAt: issue.created_at ? new Date(issue.created_at) : null,
                  },
                });
              }
            } catch (dbError) {
              logError(`Error saving ungrouped issue ${issue.number} to database:`, dbError);
              // Continue even if database save fails
            }
          }
        }
        
        log(`Found ${ungroupedIssues.length} ungrouped GitHub issues`);
      }
    } catch (error) {
      logError("Error finding ungrouped issues:", error);
      // Continue with export even if we can't find ungrouped issues
    }
    
    // Add ungrouped issues to export list
    pmIssues.push(...ungroupedIssues);
    
    // Export to PM tool
    log(`Exporting ${pmIssues.length} issues to ${pmToolConfig.type} (${groupsWithFeatures.length} groups, ${ungroupedThreads.length} ungrouped threads, ${ungroupedIssues.length} ungrouped issues)...`);
    const exportResult = await pmTool.exportIssues(pmIssues);

    // Track which items were exported and update their status
    const ungroupedThreadToIssueMap = new Map<string, { id: string; url: string; identifier?: string }>();
    const ungroupedIssueToIssueMap = new Map<number, { id: string; url: string; identifier?: string }>();
    
    for (let i = 0; i < pmIssues.length; i++) {
      const issue = pmIssues[i];
      
      // Check if this is a group
      const group = issueToGroupMap.get(i);
      if (group) {
        if (issue.linear_issue_id) {
          // Get URL from issue object (set by base class) or construct from identifier
          const issueUrl = (issue as any).linear_issue_url || 
            (issue.linear_issue_identifier ? `https://linear.app/${pmToolConfig.workspace_id || 'workspace'}/issue/${issue.linear_issue_identifier}` : '');
          
          groupToIssueMap.set(group.id, {
            id: issue.linear_issue_id,
            url: issueUrl,
            identifier: issue.linear_issue_identifier || undefined, // Linear identifier like "LIN-123"
          });
          
          // Mark group as exported
          group.status = "exported";
          group.exported_at = new Date().toISOString();
          group.linear_issue_id = issue.linear_issue_id;
          group.linear_issue_url = issueUrl;
          if (issue.linear_issue_identifier) {
            group.linear_issue_identifier = issue.linear_issue_identifier;
          }
        }
        continue;
      }
      
      // Check if this is an ungrouped thread
      if (issue.source_id && issue.source_id.startsWith("ungrouped-thread-")) {
        const threadId = issue.source_id.replace("ungrouped-thread-", "");
        if (issue.linear_issue_id) {
          const issueUrl = (issue as any).linear_issue_url || 
            (issue.linear_issue_identifier ? `https://linear.app/${pmToolConfig.workspace_id || 'workspace'}/issue/${issue.linear_issue_identifier}` : '');
          
          ungroupedThreadToIssueMap.set(threadId, {
            id: issue.linear_issue_id,
            url: issueUrl,
            identifier: issue.linear_issue_identifier || undefined,
          });
          
          // Update ungrouped thread in grouping data
          const ungroupedThread = ungroupedThreads.find(ut => ut.thread_id === threadId);
          if (ungroupedThread) {
            (ungroupedThread as any).export_status = "exported";
            (ungroupedThread as any).exported_at = new Date().toISOString();
            (ungroupedThread as any).linear_issue_id = issue.linear_issue_id;
            (ungroupedThread as any).linear_issue_url = issueUrl;
            if (issue.linear_issue_identifier) {
              (ungroupedThread as any).linear_issue_identifier = issue.linear_issue_identifier;
            }
          }
        }
        continue;
      }
      
      // Check if this is an ungrouped issue
      if (issue.source_id && issue.source_id.startsWith("ungrouped-issue-")) {
        const issueNumber = parseInt(issue.source_id.replace("ungrouped-issue-", ""), 10);
        if (!isNaN(issueNumber) && issue.linear_issue_id) {
          const issueUrl = (issue as any).linear_issue_url || 
            (issue.linear_issue_identifier ? `https://linear.app/${pmToolConfig.workspace_id || 'workspace'}/issue/${issue.linear_issue_identifier}` : '');
          
          ungroupedIssueToIssueMap.set(issueNumber, {
            id: issue.linear_issue_id,
            url: issueUrl,
            identifier: issue.linear_issue_identifier || undefined,
          });
        }
      }
    }
    
    // Update database with export status
    try {
      const { prisma } = await import("../storage/db/prisma.js");
      
      // Update ungrouped threads in database
      for (const [threadId, issueInfo] of ungroupedThreadToIssueMap.entries()) {
        try {
          // Use update with unique identifier (threadId is the primary key)
          // Type assertion needed: exportStatus exists in schema but Prisma client types may be out of sync
          // Run 'npx prisma generate' to regenerate client types
          await prisma.ungroupedThread.update({
            where: { threadId },
            data: {
              exportStatus: "exported",
              exportedAt: new Date(),
              linearIssueId: issueInfo.id,
              linearIssueUrl: issueInfo.url,
              linearIssueIdentifier: issueInfo.identifier || null,
            } as any, // Cast entire data object - exportStatus field exists in schema
          });
        } catch (error) {
          // If update fails (record might not exist), try upsert
          try {
            // Type assertion needed: exportStatus exists in schema but Prisma client types may be out of sync
            await prisma.ungroupedThread.upsert({
              where: { threadId },
              update: {
                exportStatus: "exported",
                exportedAt: new Date(),
                linearIssueId: issueInfo.id,
                linearIssueUrl: issueInfo.url,
                linearIssueIdentifier: issueInfo.identifier || null,
              } as any, // Cast entire update object
              create: {
                threadId,
                channelId: groupingData.channel_id,
                reason: "no_matches", // Default reason
                exportStatus: "exported",
                exportedAt: new Date(),
                linearIssueId: issueInfo.id,
                linearIssueUrl: issueInfo.url,
                linearIssueIdentifier: issueInfo.identifier || null,
              } as any, // Cast entire create object
            });
          } catch (upsertError) {
            logError(`Error updating ungrouped thread ${threadId} export status:`, upsertError);
          }
        }
        
        // Also update the classified_thread
        try {
          // Use update with unique identifier (threadId is the primary key)
          // Type assertion needed: exportStatus exists in schema but Prisma client types may be out of sync
          await prisma.classifiedThread.update({
            where: { threadId },
            data: {
              exportStatus: "exported",
              exportedAt: new Date(),
              linearIssueId: issueInfo.id,
              linearIssueUrl: issueInfo.url,
              linearIssueIdentifier: issueInfo.identifier || null,
            } as any, // Cast entire data object - exportStatus field exists in schema
          });
        } catch (error) {
          // If update fails, log but don't fail - thread might not be classified yet
          logError(`Error updating classified thread ${threadId} export status (thread may not exist):`, error);
        }
      }
      
      // Update ungrouped issues in database
      for (const [issueNumber, issueInfo] of ungroupedIssueToIssueMap.entries()) {
        try {
          // Try to use UngroupedIssue model (should exist in Prisma client if schema is up to date)
          const ungroupedIssueModel = (prisma as any).ungroupedIssue;
          if (ungroupedIssueModel) {
            await ungroupedIssueModel.upsert({
              where: { issueNumber },
              update: {
                exportStatus: "exported",
                exportedAt: new Date(),
                linearIssueId: issueInfo.id,
                linearIssueUrl: issueInfo.url,
                linearIssueIdentifier: issueInfo.identifier || null,
              },
              create: {
                issueNumber,
                issueTitle: `Issue #${issueNumber}`, // Will be updated when we have full issue data
                issueUrl: `https://github.com/issues/${issueNumber}`,
                exportStatus: "exported",
                exportedAt: new Date(),
                linearIssueId: issueInfo.id,
                linearIssueUrl: issueInfo.url,
                linearIssueIdentifier: issueInfo.identifier || null,
              },
            });
          } else {
            // Fallback: update GitHubIssue model export status using update (single record)
            // Type assertion needed: exportStatus exists in schema but Prisma client types may be out of sync
            await (prisma as any).gitHubIssue.update({
              where: { issueNumber },
              data: {
                exportStatus: "exported",
                exportedAt: new Date(),
                linearIssueId: issueInfo.id,
                linearIssueUrl: issueInfo.url,
                linearIssueIdentifier: issueInfo.identifier || null,
              },
            });
          }
        } catch (error) {
          logError(`Error updating ungrouped issue ${issueNumber} export status:`, error);
        }
      }
      
      log(`Updated export status in database for ${ungroupedThreadToIssueMap.size} ungrouped threads and ${ungroupedIssueToIssueMap.size} ungrouped issues`);
    } catch (error) {
      logError("Error updating export status in database:", error);
      // Continue even if database update fails
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
    log(`  - Groups: ${groupsWithFeatures.length}`);
    log(`  - Ungrouped threads: ${ungroupedThreads.length}`);
    log(`  - Ungrouped issues: ${ungroupedIssues.length}`);

    // Return result with export mappings for updating the JSON file
    return {
      ...result,
      group_export_mappings: Array.from(groupToIssueMap.entries()).map(([group_id, issue_info]) => ({
        group_id,
        ...issue_info,
      })),
      ungrouped_thread_export_mappings: Array.from(ungroupedThreadToIssueMap.entries()).map(([thread_id, issue_info]) => ({
        thread_id,
        ...issue_info,
      })),
      ungrouped_issue_export_mappings: Array.from(ungroupedIssueToIssueMap.entries()).map(([issue_number, issue_info]) => ({
        issue_number,
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
    parts.push("### Cross-Cutting Issue");
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
      parts.push("> **Tip:** Reference this Linear issue in your PR with `Fixes LIN-XXX` or `Closes LIN-XXX` to auto-close when merged.");
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

