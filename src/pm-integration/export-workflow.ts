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
 */
function convertToPMToolIssues(mappings: FeatureMapping[]): PMToolIssue[] {
  const issues: PMToolIssue[] = [];

  for (const mapping of mappings) {
    const feature = mapping.feature;

    // Create a summary issue for the feature with all related discussions
    const description = [
      `## ${feature.name}`,
      feature.description,
      "",
      "### Related Discussions",
      "",
      `**Discord Threads (${mapping.discord_threads.length}):**`,
      ...mapping.discord_threads.map(thread => 
        `- [${thread.thread_name}](${thread.first_message_url}) (${thread.message_count} messages, ${thread.similarity_score.toFixed(1)}% match)`
      ),
      "",
      `**GitHub Issues (${mapping.github_issues.length}):**`,
      ...mapping.github_issues.map(issue =>
        `- [#${issue.issue_number} ${issue.issue_title}](${issue.issue_url}) (${issue.state}, ${issue.similarity_score.toFixed(1)}% match)`
      ),
    ].join("\n");

    issues.push({
      title: `Feature: ${feature.name}`,
      description,
      feature_id: feature.id,
      feature_name: feature.name,
      source: "discord", // Mixed source
      source_url: mapping.discord_threads[0]?.first_message_url || "",
      source_id: `feature-${feature.id}`,
      labels: feature.category ? [feature.category] : [],
      priority: feature.priority,
      metadata: {
        total_mentions: mapping.total_mentions,
        discord_threads_count: mapping.discord_threads.length,
        github_issues_count: mapping.github_issues.length,
        last_mentioned: mapping.last_mentioned,
      },
    });
  }

  return issues;
}

