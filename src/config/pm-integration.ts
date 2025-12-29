/**
 * PM Tool integration configuration
 */
export interface PMToolConfig {
  type?: "linear" | "jira" | "github" | "custom";
  api_key?: string;
  api_url?: string;
  workspace_id?: string;
  team_id?: string;
  board_id?: string;
}

export interface FeatureExtractionConfig {
  enabled: boolean;
  auto_update: boolean;
}

export interface PMIntegrationConfig {
  enabled: boolean;
  documentation_urls?: string[];
  github_repo_url?: string; // GitHub repository URL (e.g., https://github.com/better-auth/better-auth)
  feature_extraction?: FeatureExtractionConfig;
  pm_tool?: PMToolConfig;
}

export function getPMIntegrationConfig(): PMIntegrationConfig {
  return {
    // PM integration is enabled if PM_TOOL_TYPE is set
    enabled: !!process.env.PM_TOOL_TYPE,
    documentation_urls: process.env.DOCUMENTATION_URLS
      ? process.env.DOCUMENTATION_URLS.split(",")
          .map(url => url.trim())
          .map(url => url.endsWith(":") ? url.slice(0, -1) : url) // Remove trailing colons
          .filter(url => url.length > 0)
      : undefined,
    github_repo_url: process.env.GITHUB_REPO_URL?.trim() || undefined,
    feature_extraction: {
      enabled: process.env.FEATURE_EXTRACTION_ENABLED !== "false",
      auto_update: process.env.FEATURE_AUTO_UPDATE === "true",
    },
    pm_tool: process.env.PM_TOOL_TYPE
      ? {
          type: process.env.PM_TOOL_TYPE as "linear" | "jira" | "github" | "custom",
          api_key: process.env.PM_TOOL_API_KEY,
          api_url: process.env.PM_TOOL_API_URL,
          workspace_id: process.env.PM_TOOL_WORKSPACE_ID,
          team_id: process.env.PM_TOOL_TEAM_ID,
          board_id: process.env.PM_TOOL_BOARD_ID,
        }
      : undefined,
  };
}

