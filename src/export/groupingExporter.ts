/**
 * Export grouping results to PM tools
 * Converts semantic grouping output to PM tool issues
 */

import { log, logError } from "../mcp/logger.js";
import { createPMTool } from "./factory.js";
import type { PMToolConfig, PMToolIssue } from "./types.js";
import type { ExportWorkflowResult } from "./workflow.js";

interface GroupingSignal {
  source: string;
  id: string;
  title: string;
  url: string;
}

interface GroupingGroup {
  id: string;
  suggested_title: string;
  similarity: number;
  is_cross_cutting: boolean;
  affects_features: Array<{ id: string; name: string }>;
  signals: GroupingSignal[];
  canonical_issue?: {
    source: string;
    id: string;
    title?: string;
    url: string;
  } | null;
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
 * Groups are already mapped to features, so no additional extraction needed
 */
export async function exportGroupingToPMTool(
  groupingData: GroupingData,
  pmToolConfig: PMToolConfig
): Promise<ExportWorkflowResult> {
  const result: ExportWorkflowResult = {
    success: false,
    features_extracted: groupingData.features.length,
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

    // Create projects for features (Linear only)
    const projectMappings = new Map<string, string>(); // feature_id -> project_id
    
    if (pmToolConfig.type === "linear") {
      const linearTool = pmTool as any;
      if (typeof linearTool.createOrGetProject === "function") {
        for (const feature of groupingData.features) {
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

    // Convert groups to PM tool issues
    const pmIssues: PMToolIssue[] = [];
    
    for (const group of groupingData.groups) {
      // Build description with sources
      const description = buildGroupDescription(group);
      
      // Determine project ID (use first affected feature, or none for cross-cutting)
      let projectId: string | undefined;
      if (group.affects_features.length === 1) {
        projectId = projectMappings.get(group.affects_features[0].id);
      }
      // For cross-cutting issues, we'll tag them but not assign to a single project
      
      // Generate labels for cross-cutting issues
      const labels: string[] = [];
      if (group.is_cross_cutting) {
        labels.push("cross-cutting");
        // Add feature names as labels
        for (const feature of group.affects_features) {
          labels.push(feature.name.toLowerCase().replace(/\s+/g, "-"));
        }
      }

      pmIssues.push({
        title: group.suggested_title,
        description,
        feature_id: group.affects_features[0]?.id || "general",
        feature_name: group.affects_features[0]?.name || "General",
        project_id: projectId,
        source: group.canonical_issue?.source === "github" ? "github" : "discord",
        source_url: group.canonical_issue?.url || group.signals[0]?.url || "",
        source_id: group.id,
        labels,
        priority: group.is_cross_cutting ? "high" : "medium", // Cross-cutting issues get higher priority
        metadata: {
          similarity: group.similarity,
          is_cross_cutting: group.is_cross_cutting,
          affects_features: group.affects_features.map(f => f.name),
          signal_count: group.signals.length,
          signals: group.signals,
        },
      });
    }

    // Export to PM tool
    log(`Exporting ${pmIssues.length} issues to ${pmToolConfig.type}...`);
    const exportResult = await pmTool.exportIssues(pmIssues);

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

    return result;
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
function buildGroupDescription(group: GroupingGroup): string {
  const parts: string[] = [];
  
  // Problem summary
  parts.push("## Problem Summary");
  parts.push("");
  parts.push(`This issue was identified from ${group.signals.length} related discussions with ${Math.round(group.similarity * 100)}% similarity.`);
  parts.push("");
  
  // Cross-cutting notice
  if (group.is_cross_cutting) {
    parts.push("### ⚠️ Cross-Cutting Issue");
    parts.push("");
    parts.push(`This affects multiple features: **${group.affects_features.map(f => f.name).join(", ")}**`);
    parts.push("");
  }
  
  // Sources
  parts.push("---");
  parts.push("");
  parts.push("## Sources");
  parts.push("");
  
  // Discord sources
  const discordSignals = group.signals.filter(s => s.source === "discord");
  if (discordSignals.length > 0) {
    parts.push("### Discord Discussions");
    for (const signal of discordSignals) {
      parts.push(`- [${signal.title}](${signal.url})`);
    }
    parts.push("");
  }
  
  // GitHub sources
  const githubSignals = group.signals.filter(s => s.source === "github");
  if (githubSignals.length > 0) {
    parts.push("### Related GitHub Issues");
    for (const signal of githubSignals) {
      parts.push(`- [#${signal.id} ${signal.title}](${signal.url})`);
    }
    parts.push("");
  }
  
  return parts.join("\n");
}

