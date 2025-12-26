/**
 * Types for PM tool integration
 * App-agnostic system for correlating Discord messages/issues to product features
 */

export interface ProductFeature {
  id: string;
  name: string;
  description: string;
  category?: string;
  documentation_section?: string;
  related_keywords: string[];
  priority?: "high" | "medium" | "low";
}

export interface FeatureMapping {
  feature: ProductFeature;
  discord_threads: Array<{
    thread_id: string;
    thread_name: string;
    message_count: number;
    first_message_url: string;
    similarity_score: number;
  }>;
  github_issues: Array<{
    issue_number: number;
    issue_title: string;
    issue_url: string;
    state: "open" | "closed";
    similarity_score: number;
  }>;
  total_mentions: number;
  last_mentioned?: string;
}

export interface PMToolIssue {
  title: string;
  description: string;
  feature_id?: string;
  feature_name?: string;
  project_id?: string; // Linear project ID (for feature grouping)
  source: "discord" | "github";
  source_url: string;
  source_id: string;
  labels?: string[];
  priority?: "high" | "medium" | "low";
  metadata?: Record<string, any>;
  linear_issue_id?: string; // Store Linear issue ID for mapping
}

export interface PMToolConfig {
  type: "linear" | "jira" | "github" | "custom";
  api_key?: string;
  api_url?: string;
  workspace_id?: string;
  team_id?: string; // Linear team ID (projects are created automatically from features)
  board_id?: string;
  // Custom fields mapping
  field_mappings?: Record<string, string>;
}

export interface ProjectMapping {
  feature_id: string;
  feature_name: string;
  linear_project_id: string;
}

export interface ExportResult {
  success: boolean;
  created_issues: number;
  updated_issues: number;
  skipped_issues: number;
  errors?: Array<{
    source_id: string;
    error: string;
  }>;
  issue_urls?: string[];
}

