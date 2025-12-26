/**
 * Main workflow for exporting classified messages/issues to PM tools
 */

import { log, logError } from "../logger.js";
import { fetchDocumentation, fetchMultipleDocumentation } from "./documentation-fetcher.js";
import { extractFeaturesFromDocumentation } from "./feature-extractor.js";
import { mapToFeatures } from "./feature-mapper.js";
import { createPMTool, validatePMToolConfig } from "./pm-tool-factory.js";
import { PMToolConfig, PMToolIssue, ProductFeature, FeatureMapping } from "./types.js";
import { join } from "path";
import { readFile } from "fs/promises";
import { existsSync } from "fs";

export interface ExportWorkflowResult {
  success: boolean;
  features_extracted: number;
  features_mapped: number;
  issues_exported?: {
    created: number;
    updated: number;
    skipped: number;
  };
  errors?: string[];
}

/**
 * Main export workflow
 */
export async function runExportWorkflow(
  documentationUrls: string[],
  classifiedDataPath: string,
  pmToolConfig: PMToolConfig,
  options?: {
    skipFeatureExtraction?: boolean;
    existingFeatures?: ProductFeature[];
  }
): Promise<ExportWorkflowResult> {
  const result: ExportWorkflowResult = {
    success: false,
    features_extracted: 0,
    features_mapped: 0,
    errors: [],
  };

  try {
    // Step 1: Validate PM tool configuration
    const validation = validatePMToolConfig(pmToolConfig);
    if (!validation.valid) {
      throw new Error(validation.error || "Invalid PM tool configuration");
    }

    // Step 2: Extract features from documentation (or use existing)
    let features: ProductFeature[];
    
    if (options?.skipFeatureExtraction && options?.existingFeatures) {
      log("Using existing features, skipping extraction");
      features = options.existingFeatures;
    } else {
      log(`Fetching documentation from ${documentationUrls.length} URL(s)...`);
      const documentation = await fetchMultipleDocumentation(documentationUrls);
      
      if (documentation.length === 0) {
        throw new Error("No documentation was successfully fetched");
      }

      log("Extracting features from documentation using LLM...");
      features = await extractFeaturesFromDocumentation(documentation);
      result.features_extracted = features.length;
    }

    // Step 3: Load classified data
    if (!existsSync(classifiedDataPath)) {
      throw new Error(`Classified data file not found: ${classifiedDataPath}`);
    }

    log(`Loading classified data from ${classifiedDataPath}...`);
    const classifiedDataContent = await readFile(classifiedDataPath, "utf-8");
    const classifiedData = JSON.parse(classifiedDataContent);

    // Step 4: Map to features
    log("Mapping Discord messages/issues to features...");
    const featureMappings = await mapToFeatures(features, classifiedData);
    result.features_mapped = featureMappings.length;

    // Step 5: Convert to PM tool issues
    log("Converting to PM tool issues...");
    const pmIssues = convertToPMToolIssues(featureMappings);

    // Step 6: Export to PM tool
    log(`Exporting ${pmIssues.length} issues to ${pmToolConfig.type}...`);
    const pmTool = createPMTool(pmToolConfig);
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
    logError("Export workflow failed:", error);
    result.success = false;
    result.errors = result.errors || [];
    result.errors.push(error instanceof Error ? error.message : String(error));
    return result;
  }
}

/**
 * Convert feature mappings to PM tool issues
 * Each mapping represents one problem/request that may relate to multiple GitHub issues and Discord threads
 */
function convertToPMToolIssues(mappings: FeatureMapping[]): PMToolIssue[] {
  const issues: PMToolIssue[] = [];

  for (const mapping of mappings) {
    const feature = mapping.feature;

    // Generate canonical title from grouped discussions
    // For now, use feature name - could be enhanced with LLM summarization
    const title = generateIssueTitle(mapping);

    // Build description with problem summary and sources
    const description = buildIssueDescription(mapping);

    issues.push({
      title,
      description,
      feature_id: feature.id,
      feature_name: feature.name,
      project_id: feature.id, // Linear project ID (will be created/linked per feature)
      source: mapping.discord_threads.length > 0 ? "discord" : "github",
      source_url: mapping.discord_threads[0]?.first_message_url || mapping.github_issues[0]?.issue_url || "",
      source_id: generateSourceId(mapping),
      labels: feature.category ? [feature.category] : [],
      priority: feature.priority,
      metadata: {
        total_mentions: mapping.total_mentions,
        discord_threads: mapping.discord_threads.map(t => ({
          thread_name: t.thread_name,
          thread_url: t.first_message_url,
        })),
        github_issues: mapping.github_issues.map(i => ({
          issue_number: i.issue_number,
          issue_url: i.issue_url,
          issue_title: i.issue_title,
        })),
        last_mentioned: mapping.last_mentioned,
      },
    });
  }

  return issues;
}

/**
 * Generate canonical title for grouped issue
 * TODO: Could use LLM to summarize multiple discussions into one title
 */
function generateIssueTitle(mapping: FeatureMapping): string {
  // For now, use the most recent GitHub issue title if available
  // Otherwise use first Discord thread name
  if (mapping.github_issues.length > 0) {
    return mapping.github_issues[0].issue_title;
  }
  if (mapping.discord_threads.length > 0) {
    return mapping.discord_threads[0].thread_name;
  }
  return `Issue in ${mapping.feature.name}`;
}

/**
 * Build issue description with problem summary and sources
 */
function buildIssueDescription(mapping: FeatureMapping): string {
  const parts: string[] = [];
  
  // Problem description (could be enhanced with LLM summarization)
  parts.push("## Problem Description");
  parts.push(mapping.feature.description);
  parts.push("");

  // Sources section will be added by LinearIntegration.formatDescription()
  // This is just the base description
  
  return parts.join("\n");
}

/**
 * Generate unique source ID for this grouped issue
 * Used for tracking and avoiding duplicates
 */
function generateSourceId(mapping: FeatureMapping): string {
  // Combine feature ID with hash of related issue/thread IDs
  const relatedIds = [
    ...mapping.github_issues.map(i => `gh-${i.issue_number}`),
    ...mapping.discord_threads.map(t => `discord-${t.thread_id}`),
  ].sort().join("-");
  
  // Create deterministic hash (simple hash for now)
  const hash = relatedIds.split("").reduce((acc, char) => {
    return ((acc << 5) - acc) + char.charCodeAt(0);
  }, 0).toString(36);
  
  return `feature-${mapping.feature.id}-${hash}`;
}

