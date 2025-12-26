/**
 * Configuration for UNMute MCP Server
 * 
 * Set these via environment variables or update the defaults below.
 */

export interface Config {
  // GitHub Configuration
  github: {
    owner: string;
    repo: string;
  };

  // Discord Configuration
  discord: {
    serverId?: string;
    defaultChannelId?: string;
    channelNames?: {
      development?: string;
      general?: string;
      chat?: string;
    };
  };

  // File Paths
  paths: {
    resultsDir: string;
    cacheDir: string;
    issuesCacheFile: string;
  };

  // Classification Configuration
  classification: {
    useSemantic: boolean; // Use LLM-based semantic classification if OPENAI_API_KEY is available
  };

  // PM Tool Integration Configuration
  pmIntegration?: {
    enabled: boolean;
      documentation_urls?: string[]; // URLs or local file paths to product documentation (URLs ending with /docs will be crawled automatically)
    feature_extraction?: {
      enabled: boolean;
      auto_update: boolean; // Automatically re-extract features when docs change
    };
    pm_tool?: {
      type?: "linear" | "jira" | "github" | "custom";
      api_key?: string;
      api_url?: string;
      workspace_id?: string;
      team_id?: string; // Linear team ID (projects are created automatically from features)
      board_id?: string;
    };
  };
}

/**
 * Get configuration from environment variables or use defaults
 */
export function getConfig(): Config {
  return {
    github: {
      owner: process.env.GITHUB_OWNER || "",
      repo: process.env.GITHUB_REPO || "",
    },
    discord: {
      serverId: process.env.DISCORD_SERVER_ID,
      defaultChannelId: process.env.DISCORD_DEFAULT_CHANNEL_ID,
      channelNames: {
        development: process.env.DISCORD_CHANNEL_DEVELOPMENT || "development",
        general: process.env.DISCORD_CHANNEL_GENERAL || "general",
        chat: process.env.DISCORD_CHANNEL_CHAT || "chat",
      },
    },
    paths: {
      resultsDir: process.env.RESULTS_DIR || "results",
      cacheDir: process.env.CACHE_DIR || "cache",
      issuesCacheFile: process.env.ISSUES_CACHE_FILE || "github-issues-cache.json",
    },
    classification: {
      // Use semantic classification if OPENAI_API_KEY is available, unless explicitly disabled
      useSemantic: process.env.USE_SEMANTIC_CLASSIFICATION !== "false" && !!process.env.OPENAI_API_KEY,
    },
    pmIntegration: {
      // PM integration is enabled if PM_TOOL_TYPE is set
      enabled: !!process.env.PM_TOOL_TYPE,
      documentation_urls: process.env.DOCUMENTATION_URLS
        ? process.env.DOCUMENTATION_URLS.split(",").map(url => url.trim()).filter(url => url.length > 0)
        : undefined,
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
    },
  };
}

/**
 * Get the default config (useful for scripts that need it without env vars)
 */
export const defaultConfig = getConfig();


