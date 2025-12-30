#!/usr/bin/env node
import "dotenv/config";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  Tool,
} from "@modelcontextprotocol/sdk/types.js";
import {
  Client,
  GatewayIntentBits,
  TextChannel,
  DMChannel,
  NewsChannel,
  ChannelType,
  Message,
  Collection,
} from "discord.js";

import {
  searchGitHubIssues,
  loadIssuesFromCache,
  fetchAllGitHubIssues,
  mergeIssues,
  getMostRecentUpdateDate as getMostRecentIssueDate,
  type GitHubIssue,
  type GitHubComment,
  type IssuesCache,
} from "../connectors/github/client.js";
import { loadDiscordCache, getAllMessagesFromCache, getMostRecentMessageDate, mergeMessagesByThread, organizeMessagesByThread, getThreadContextForMessage, type DiscordCache, type DiscordMessage as CachedDiscordMessage } from "../storage/cache/discordCache.js";
import { loadClassificationHistory, saveClassificationHistory, filterUnclassifiedMessages, addMessageClassification, updateThreadStatus, getThreadStatus, migrateStandaloneToThread, filterUngroupedSignals, addGroup, getGroupingStats, type ClassificationHistory } from "../storage/cache/classificationHistory.js";
import { getConfig } from "../config/index.js";
import {
  classifyMessagesWithCache,
  type DiscordMessage,
  type ClassifiedMessage,
} from "../core/classify/classifier.js";
import { join } from "path";
import { existsSync, writeFileSync, mkdirSync } from "fs";
import { writeFile, mkdir, readdir, readFile } from "fs/promises";
import { logError } from "./logger.js";
import { runExportWorkflow } from "../export/workflow.js";
import type { PMToolConfig, ProductFeature } from "../export/types.js";
import { createPMTool } from "../export/factory.js";
import { validatePMSetup } from "../export/validation.js";
import { groupSignalsSemantic, groupByClassificationResults, type Feature, type ClassificationResults } from "../core/correlate/grouper.js";
import type { Signal } from "../types/signal.js";
import { fetchMultipleDocumentation } from "../export/documentationFetcher.js";
import { extractFeaturesFromDocumentation } from "../export/featureExtractor.js";
import type { ClassifiedThread, Group, UngroupedThread } from "../storage/types.js";

const DISCORD_TOKEN = process.env.DISCORD_TOKEN;

if (!DISCORD_TOKEN) {
  logError("DISCORD_TOKEN environment variable is required");
  process.exit(1);
}

// Create Discord client
const discord = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.DirectMessages,
  ],
});

let discordReady = false;

discord.once("ready", () => {
  discordReady = true;
});

/**
 * Safely parse JSON with better error messages
 */
function safeJsonParse<T = unknown>(content: string, filePath?: string): T {
  try {
    return JSON.parse(content) as T;
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    const fileContext = filePath ? ` in file: ${filePath}` : "";
    const preview = content.substring(0, 100).replace(/\n/g, " ");
    throw new Error(`Failed to parse JSON${fileContext}: ${errorMessage}. Content preview: ${preview}...`);
  }
}

/**
 * Find Discord cache file for a channel, handling files with timestamp suffixes
 */
async function findDiscordCacheFile(channelId: string): Promise<string | null> {
  const config = getConfig();
  const cacheDir = join(process.cwd(), config.paths.cacheDir);
  const baseFileName = `discord-messages-${channelId}.json`;
  const exactPath = join(cacheDir, baseFileName);

  // First try exact match
  if (existsSync(exactPath)) {
    return exactPath;
  }

  // If not found, try to find files that start with the base name
  try {
    const files = await readdir(cacheDir);
    const matchingFiles = files.filter(f => f.startsWith(baseFileName));
    
    if (matchingFiles.length > 0) {
      // Return the most recently modified file (if multiple exist)
      // For now, just return the first match (we could enhance this to check mtime)
      return join(cacheDir, matchingFiles[0]);
    }
  } catch (error) {
    // Directory doesn't exist or can't be read
  }

  return null;
}

// Create MCP server
const mcpServer = new McpServer(
  {
  name: "unmute-mcp",
  version: "1.0.0",
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

const tools: Tool[] = [
  {
    name: "list_servers",
    description: "List all Discord servers (guilds) the bot has access to",
    inputSchema: {
      type: "object",
      properties: {},
    },
  },
  {
    name: "list_channels",
    description: "List all text channels in a Discord server. Uses DISCORD_SERVER_ID from config if server_id is not provided.",
    inputSchema: {
      type: "object",
      properties: {
        server_id: {
          type: "string",
          description: "The Discord server (guild) ID. If not provided, uses DISCORD_SERVER_ID from config.",
        },
      },
      required: [],
    },
  },
  {
    name: "read_messages",
    description: "Read recent messages from a Discord channel. Uses DISCORD_DEFAULT_CHANNEL_ID from config if channel_id is not provided.",
    inputSchema: {
      type: "object",
      properties: {
        channel_id: {
          type: "string",
          description: "The Discord channel ID. If not provided, uses DISCORD_DEFAULT_CHANNEL_ID from config.",
        },
        limit: {
          type: "number",
          description: "Number of messages to fetch (1-100, default 50)",
          minimum: 1,
          maximum: 100,
          default: 50,
        },
      },
      required: [],
    },
  },
  {
    name: "search_messages",
    description: "Search for messages containing specific text in a channel. Uses DISCORD_DEFAULT_CHANNEL_ID from config if channel_id is not provided.",
    inputSchema: {
      type: "object",
      properties: {
        channel_id: {
          type: "string",
          description: "The Discord channel ID. If not provided, uses DISCORD_DEFAULT_CHANNEL_ID from config.",
        },
        query: {
          type: "string",
          description: "Text to search for in messages",
        },
        limit: {
          type: "number",
          description: "Number of messages to search through (1-100, default 100)",
          minimum: 1,
          maximum: 100,
          default: 100,
        },
      },
      required: ["query"],
    },
  },
  {
    name: "search_github_issues",
        description: "Search GitHub issues in the configured repository",
    inputSchema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Search query for GitHub issues (e.g., 'bug', 'feature request', 'stripe plugin')",
        },
        state: {
          type: "string",
          enum: ["open", "closed", "all"],
          description: "Filter by issue state (default: all)",
          default: "all",
        },
      },
      required: ["query"],
    },
  },
  {
    name: "search_discord_and_github",
    description: "Search both Discord messages and GitHub issues for a topic. Uses DISCORD_DEFAULT_CHANNEL_ID from config if channel_id is not provided.",
    inputSchema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Search query to search in both Discord and GitHub",
        },
        channel_id: {
          type: "string",
          description: "Discord channel ID to search in. If not provided, uses DISCORD_DEFAULT_CHANNEL_ID from config.",
        },
        discord_limit: {
          type: "number",
          description: "Number of Discord messages to search (1-100, default 50)",
          minimum: 1,
          maximum: 100,
          default: 50,
        },
        github_state: {
          type: "string",
          enum: ["open", "closed", "all"],
          description: "GitHub issue state filter (default: all)",
          default: "all",
        },
      },
      required: ["query"],
    },
  },
  {
    name: "setup_github_oauth",
    description: "Set up GitHub OAuth to automatically generate tokens. Generates OAuth URL and provides setup instructions. Requires GITHUB_OAUTH_CLIENT_ID and GITHUB_OAUTH_CLIENT_SECRET to be set.",
    inputSchema: {
      type: "object",
      properties: {
        client_id: {
          type: "string",
          description: "GitHub OAuth Client ID (optional if GITHUB_OAUTH_CLIENT_ID env var is set)",
        },
        client_secret: {
          type: "string",
          description: "GitHub OAuth Client Secret (optional if GITHUB_OAUTH_CLIENT_SECRET env var is set)",
        },
      },
      required: [],
    },
  },
  {
    name: "fetch_github_issues",
    description: "Fetch all GitHub issues and cache them. If cache exists, updates incrementally. If not, fetches all with pagination.",
    inputSchema: {
      type: "object",
      properties: {
        incremental: {
          type: "boolean",
          description: "If true and cache exists, only fetches new/updated issues. If false or no cache, fetches all issues.",
          default: true,
        },
        limit: {
          type: "number",
          description: "Maximum number of issues to fetch. Omit to fetch all issues. When database is not configured, defaults to DEFAULT_FETCH_LIMIT_ISSUES (default: 100).",
        },
      },
      required: [],
    },
  },
  {
    name: "check_github_issues_completeness",
    description: "Check if all GitHub issues have been fetched with comments. Compares database with GitHub API to verify completeness.",
    inputSchema: {
      type: "object",
      properties: {},
      required: [],
    },
  },
  {
    name: "check_discord_classification_completeness",
    description: "Check if all Discord messages in a channel have been classified. Compares total messages with classified messages/threads to verify completeness. Uses DISCORD_DEFAULT_CHANNEL_ID from config if channel_id is not provided.",
    inputSchema: {
      type: "object",
      properties: {
        channel_id: {
          type: "string",
          description: "Discord channel ID to check. If not provided, uses DISCORD_DEFAULT_CHANNEL_ID from config.",
        },
      },
      required: [],
    },
  },
  {
    name: "fetch_discord_messages",
    description: "Fetch Discord messages from a channel and cache them. If cache exists, updates incrementally. If not, fetches all with pagination. Uses DISCORD_DEFAULT_CHANNEL_ID from config if channel_id is not provided.",
    inputSchema: {
      type: "object",
      properties: {
        channel_id: {
          type: "string",
          description: "Discord channel ID to fetch messages from. If not provided, uses DISCORD_DEFAULT_CHANNEL_ID from config.",
        },
        incremental: {
          type: "boolean",
          description: "If true (default) and cache exists, only fetches new/updated messages since last fetch. If false or no cache, fetches all messages.",
          default: true,
        },
        limit: {
          type: "number",
          description: "Maximum number of messages to fetch. Omit to fetch all messages. When database is not configured, defaults to DEFAULT_FETCH_LIMIT_MESSAGES (default: 100).",
        },
      },
      required: [],
    },
  },
  {
    name: "classify_discord_messages",
    description: "Analyze Discord messages and match them with related GitHub issues based on content similarity. Results are saved to a file in the results folder. Uses DISCORD_DEFAULT_CHANNEL_ID from config if channel_id is not provided. By default, only classifies new messages that haven't been classified before.",
    inputSchema: {
      type: "object",
      properties: {
        channel_id: {
          type: "string",
          description: "Discord channel ID to analyze messages from. If not provided, uses DISCORD_DEFAULT_CHANNEL_ID from config.",
        },
        limit: {
          type: "number",
          description: "Number of messages to analyze (1-100, default 30). Set to null to classify all unclassified messages.",
          minimum: 1,
          maximum: 100,
          default: 30,
        },
        min_similarity: {
          type: "number",
          description: "Minimum similarity score to consider a match (0-100 scale, default 20). Lower values (20-40) are more inclusive for initial classification, higher values (60-80) are more strict. See README for tier recommendations.",
          minimum: 0,
          maximum: 100,
          default: 20,
        },
        re_classify: {
          type: "boolean",
          description: "If true, re-classifies messages that were already classified. If false (default), only classifies new messages.",
          default: false,
        },
        classify_all: {
          type: "boolean",
          description: "If true, classifies all unclassified messages in the channel (ignores limit). If re_classify is also true, will re-classify all messages regardless of previous classification status. If false (default), uses limit parameter. On first-time classification, automatically processes in batches of 200 until all threads are covered.",
          default: false,
        },
      },
      required: [],
    },
  },
  {
    name: "sync_and_classify",
    description: "Automated workflow: Sync Discord messages, sync GitHub issues, then classify messages with issues. Uses DISCORD_DEFAULT_CHANNEL_ID from config if channel_id is not provided.",
    inputSchema: {
      type: "object",
      properties: {
        channel_id: {
          type: "string",
          description: "Discord channel ID to sync and classify. If not provided, uses DISCORD_DEFAULT_CHANNEL_ID from config.",
        },
        classify_all: {
          type: "boolean",
          description: "If true, classifies all unclassified messages (ignores limit). If false (default), only classifies new/unclassified messages up to the default limit (30).",
          default: false,
        },
        min_similarity: {
          type: "number",
          description: "Minimum similarity score to consider a match (0-100 scale, default 20). Lower values (20-40) are more inclusive for initial classification, higher values (60-80) are more strict. See README for tier recommendations.",
          minimum: 0,
          maximum: 100,
          default: 20,
        },
      },
      required: [],
    },
  },
  {
    name: "export_to_pm_tool",
    description: "Export GitHub issues and Discord threads from the database to a PM tool (Linear, Jira, etc.). Uses issue-centric approach where GitHub issues are primary and Discord threads are attached as context. Requires DATABASE_URL to be configured. Uses configuration from environment variables (PM_TOOL_*).",
    inputSchema: {
      type: "object",
      properties: {
        channel_id: {
          type: "string",
          description: "Discord channel ID for context. If not provided, uses DISCORD_DEFAULT_CHANNEL_ID from config.",
        },
        include_closed: {
          type: "boolean",
          description: "If true, exports closed/resolved issues and threads. If false (default), only exports open/unresolved items.",
          default: false,
        },
      },
      required: [],
    },
  },
  {
    name: "list_linear_teams",
    description: "List all Linear teams in the workspace. Useful for finding team IDs to use in PM_TOOL_TEAM_ID configuration.",
    inputSchema: {
      type: "object",
      properties: {},
      required: [],
    },
  },
  {
    name: "validate_pm_setup",
    description: "Validate PM tool (Linear) export configuration. Checks environment variables, API keys, and classified data existence.",
    inputSchema: {
      type: "object",
      properties: {},
    },
  },
  {
    name: "suggest_grouping",
    description: "Group related Discord messages by their matched GitHub issues from 1-to-1 classification. If no classification exists, runs classification first. Returns groups where Discord threads are linked via shared GitHub issues. Requires OPENAI_API_KEY.",
    inputSchema: {
      type: "object",
      properties: {
        channel_id: {
          type: "string",
          description: "Discord channel ID. If not provided, uses DISCORD_DEFAULT_CHANNEL_ID from config.",
        },
        min_similarity: {
          type: "number",
          description: "Minimum similarity threshold for issue matching (0-100 scale, default 60). Only threads with similarity ≥60 are grouped with an issue. Recommended: 60 (balanced), 80 (high confidence), 40 (more inclusive). See README for tier details.",
          minimum: 0,
          maximum: 100,
          default: 60,
        },
        max_groups: {
          type: "number",
          description: "Maximum number of groups to return (optional, no limit if not specified)",
        },
        re_classify: {
          type: "boolean",
          description: "If true, re-run classification before grouping (default false)",
          default: false,
        },
        semantic_only: {
          type: "boolean",
          description: "If true, use pure semantic similarity instead of issue-based grouping (default false)",
          default: false,
        },
      },
      required: [],
    },
  },
  {
    name: "group_github_issues",
    description: "Group related GitHub issues together and connect Discord threads to them. This is issue-centric: GitHub issues are primary, Discord threads are attached as context. Creates groups of related issues (1 group = 1 Linear issue) and ungrouped issues (1 issue = 1 Linear issue). All data is read from and saved to the database.",
    inputSchema: {
      type: "object",
      properties: {
        channel_id: {
          type: "string",
          description: "Discord channel ID for matching threads. If not provided, uses DISCORD_DEFAULT_CHANNEL_ID from config.",
        },
        include_closed: {
          type: "boolean",
          description: "If true, includes closed GitHub issues. If false (default), only processes open issues.",
          default: false,
        },
        min_similarity: {
          type: "number",
          description: "Minimum similarity threshold for grouping issues (0-100 scale, default 80). Issues with similarity >= threshold are grouped together. Higher values create smaller, more focused groups.",
          minimum: 0,
          maximum: 100,
          default: 80,
        },
        force: {
          type: "boolean",
          description: "If true, re-process all issues even if already grouped. If false (default), only process new/ungrouped issues.",
          default: false,
        },
      },
      required: [],
    },
  },
  {
    name: "match_groups_to_features",
    description: "[Discord thread-centric] Match groups from grouping results to product features using semantic similarity. Updates the grouping JSON file with affects_features and is_cross_cutting. By default, skips groups that are already matched to features (resume mode). Set force=true to re-match all groups. Requires OPENAI_API_KEY and documentation URLs in config.",
    inputSchema: {
      type: "object",
      properties: {
        grouping_data_path: {
          type: "string",
          description: "Path to the grouping results JSON file. If not provided, uses the most recent grouping file for the channel.",
        },
        channel_id: {
          type: "string",
          description: "Discord channel ID. Used to find grouping file if grouping_data_path is not provided.",
        },
        min_similarity: {
          type: "number",
          description: "Minimum similarity threshold for feature matching (0.0-1.0 scale, cosine similarity, default 0.6). Only groups with similarity ≥0.6 are mapped to a feature. Recommended: 0.6 (balanced), 0.7 (high confidence), 0.3 (more inclusive). See README for tier details.",
          minimum: 0,
          maximum: 1,
          default: 0.6,
        },
        force: {
          type: "boolean",
          description: "If true, re-match all groups even if they already have affects_features set. If false (default), only match groups that don't have affects_features set yet (resume mode).",
          default: false,
        },
      },
      required: [],
    },
  },
  {
    name: "match_issues_to_features",
    description: "[Issue-centric] Match GitHub issues to product features using semantic similarity (embeddings). Updates the affectsFeatures field in the github_issues table. This is for the issue-centric flow where GitHub issues are primary. Requires OPENAI_API_KEY.",
    inputSchema: {
      type: "object",
      properties: {
        include_closed: {
          type: "boolean",
          description: "Include closed issues (default: false, only open issues)",
          default: false,
        },
        min_similarity: {
          type: "number",
          description: "Minimum similarity threshold for feature matching (0.0-1.0 scale, default 0.5)",
          minimum: 0,
          maximum: 1,
          default: 0.5,
        },
        force: {
          type: "boolean",
          description: "If true, re-match all issues even if they already have affectsFeatures set. If false (default), only match issues that don't have features yet (resume mode).",
          default: false,
        },
      },
      required: [],
    },
  },
  {
    name: "label_github_issues",
    description: "[Issue-centric] Detect and assign labels (bug, security, regression, enhancement, urgent) to GitHub issues using LLM. Updates the detectedLabels field in the github_issues table. This should be run before export to ensure proper priority assignment. Requires OPENAI_API_KEY.",
    inputSchema: {
      type: "object",
      properties: {
        include_closed: {
          type: "boolean",
          description: "Include closed issues (default: false, only open issues)",
          default: false,
        },
        force: {
          type: "boolean",
          description: "If true, re-label all issues even if they already have detectedLabels. If false (default), only label issues without detected labels.",
          default: false,
        },
      },
      required: [],
    },
  },
  {
    name: "classify_linear_issues",
    description: "Fetch all issues from Linear UNMute team and classify them with existing projects (features) or create new projects if needed. Requires PM_TOOL_API_KEY and PM_TOOL_TEAM_ID.",
    inputSchema: {
      type: "object",
      properties: {
        team_name: {
          type: "string",
          description: "Linear team name to fetch issues from (default: 'UNMute')",
          default: "UNMute",
        },
        limit: {
          type: "number",
          description: "Maximum number of issues to process (default: 250)",
          default: 250,
        },
        create_projects: {
          type: "boolean",
          description: "If true, create new projects for issues that don't match existing projects (default: true)",
          default: true,
        },
      },
      required: [],
    },
  },
  {
    name: "label_linear_issues",
    description: "Use LLM to detect and add missing labels (security, bug, regression, enhancement, urgent) to existing Linear issues. Analyzes issue titles and descriptions to automatically classify and label them. Requires PM_TOOL_API_KEY.",
    inputSchema: {
      type: "object",
      properties: {
        team_name: {
          type: "string",
          description: "Linear team name to fetch issues from (default: 'UNMute')",
          default: "UNMute",
        },
        limit: {
          type: "number",
          description: "Maximum number of issues to process (default: 100)",
          default: 100,
        },
        dry_run: {
          type: "boolean",
          description: "If true, only show what labels would be added without actually updating Linear (default: false)",
          default: false,
        },
      },
      required: [],
    },
  },
  {
    name: "compute_discord_embeddings",
    description: "Compute and update embeddings for Discord message threads. This pre-computes embeddings for all classified threads, which improves performance for classification and grouping operations. Only computes embeddings for threads that don't have embeddings or have changed content.",
    inputSchema: {
      type: "object",
      properties: {
        channel_id: {
          type: "string",
          description: "Optional channel ID to compute embeddings for threads in a specific channel. If not provided, computes for all channels.",
        },
      },
      required: [],
    },
  },
  {
    name: "compute_github_issue_embeddings",
    description: "Compute and update embeddings for GitHub issues. This pre-computes embeddings for all issues, which improves performance for classification and grouping operations. By default, only computes embeddings for issues that don't have embeddings or have changed content. Set force=true to recompute all embeddings from scratch.",
    inputSchema: {
      type: "object",
      properties: {
        force: {
          type: "boolean",
          description: "If true, recompute all embeddings from scratch. If false (default), only compute embeddings for issues that don't have embeddings or have changed content.",
          default: false,
        },
      },
      required: [],
    },
  },
  {
    name: "compute_feature_embeddings",
    description: "Compute and update embeddings for product features. This includes documentation context, related GitHub issues, Discord conversations, and code context from the repository. Code indexing will automatically try LOCAL_REPO_PATH first (if configured) for faster local code access, then fallback to GitHub API. IMPORTANT: When called from within a codebase (e.g., Better Auth repo), you can either: (1) Set LOCAL_REPO_PATH environment variable to point to the local repo, or (2) Use codebase_search to find relevant code files and pass them via the code_context parameter. Only computes embeddings for features that don't have embeddings or have changed content. Set force=true to recompute all embeddings. Requires OPENAI_API_KEY.",
    inputSchema: {
      type: "object",
      properties: {
        force: {
          type: "boolean",
          description: "Force recomputation of all feature embeddings, even if they already exist. Useful when you've added new context sources (e.g., GitHub issues, Discord conversations).",
          default: false,
        },
        code_context: {
          type: "string",
          description: "Optional code context from the repository. If provided, this will be used instead of fetching from GitHub API or local filesystem. The agent can use codebase_search to find relevant code files (search for core features, authentication, main functionality, etc.) and pass the results here. If not provided and LOCAL_REPO_PATH is set, will use local filesystem. Otherwise, will use GitHub API.",
        },
      },
      required: [],
    },
  },
  {
    name: "index_codebase",
    description: "Manually search and index code from the repository for a specific query. This is useful for pre-indexing code or re-indexing after code changes. The indexed code will be available for feature matching. Will use LOCAL_REPO_PATH if configured (faster), otherwise falls back to GITHUB_REPO_URL. Requires either LOCAL_REPO_PATH or GITHUB_REPO_URL to be configured.",
    inputSchema: {
      type: "object",
      properties: {
        search_query: {
          type: "string",
          description: "Search query to find relevant code (e.g., 'SSO authentication', 'session management'). The code matching this query will be indexed.",
          default: "",
        },
        force: {
          type: "boolean",
          description: "Force re-indexing even if code is already indexed. Useful after code changes.",
          default: false,
        },
      },
      required: ["search_query"],
    },
  },
  {
    name: "index_code_for_features",
    description: "Proactively index code for all features (similar to documentation workflow). This searches and indexes code for each feature, matches code sections to features, and saves embeddings. This should be run before computing feature embeddings to ensure code context is available. Auto-detects the current git repository root if called from within a git repo. Otherwise uses LOCAL_REPO_PATH from config, or falls back to GITHUB_REPO_URL. Can be called from any repository context - uses semantic search with LLM embeddings to find relevant code.",
    inputSchema: {
      type: "object",
      properties: {
        force: {
          type: "boolean",
          description: "Force re-indexing even if code is already indexed for features. Useful after code changes.",
          default: false,
        },
        local_repo_path: {
          type: "string",
          description: "Optional: Override the configured LOCAL_REPO_PATH. Useful when calling from a different repository context. If not provided, uses the configured LOCAL_REPO_PATH from environment.",
        },
        github_repo_url: {
          type: "string",
          description: "Optional: Override the configured GITHUB_REPO_URL. If not provided, uses the configured GITHUB_REPO_URL from environment.",
        },
        max_files: {
          type: ["number", "null"],
          description: "Maximum number of files to index per batch (default: null = process entire repository). If null, processes ALL files in the repository in chunks. If set, processes that many files total. Lower values process faster but may miss relevant code.",
          default: null,
        },
        chunk_size: {
          type: "number",
          description: "Number of files to process per chunk (default: 100). This is for batching the processing, not a total limit. Use max_files to limit total files.",
          default: 100,
          minimum: 1,
          maximum: 500,
        },
      },
    },
  },
  {
    name: "manage_documentation_cache",
    description: "Manage documentation cache - view cached docs, pre-fetch and cache documentation, extract features from cache, or clear cache. This avoids re-fetching documentation every time features are needed.",
    inputSchema: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["list", "fetch", "extract_features", "compute_embeddings", "compute_docs_embeddings", "compute_sections_embeddings", "compute_features_embeddings", "clear"],
          description: "Action to perform: 'list' (view cached docs), 'fetch' (pre-fetch and cache), 'extract_features' (extract features from cached docs), 'compute_embeddings' (compute embeddings for all: docs/sections/features), 'compute_docs_embeddings' (compute embeddings for documentation pages only), 'compute_sections_embeddings' (compute embeddings for documentation sections only), 'compute_features_embeddings' (compute embeddings for features only), 'clear' (clear cache)",
          default: "list",
        },
        urls: {
          type: "array",
          items: { type: "string" },
          description: "Documentation URLs to fetch (required for 'fetch' action). Can be URLs or local file paths.",
        },
        use_cache: {
          type: "boolean",
          description: "Whether to use cache when fetching (default: true). Set to false to force re-fetch.",
          default: true,
        },
      },
      required: ["action"],
    },
  },
];

// Handle list tools request
mcpServer.server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools,
}));

// Handle call tool request
mcpServer.server.setRequestHandler(CallToolRequestSchema, async (request) => {
  // Extract name early so it's available in catch block
  const { name, arguments: args } = request.params;
  
  try {
    if (!discordReady) {
      throw new Error("Discord client is not ready yet");
    }

    switch (name) {
    case "list_servers": {
    const guilds = discord.guilds.cache.map((guild) => ({
      id: guild.id,
      name: guild.name,
      memberCount: guild.memberCount,
    }));

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(guilds, null, 2),
        },
      ],
    };
  }

    case "list_channels": {
      const { server_id } = args as { server_id?: string };
      const channelsConfig = getConfig();
      const actualServerId = server_id || channelsConfig.discord.serverId;

      if (!actualServerId) {
        throw new Error("Server ID is required. Provide server_id parameter or set DISCORD_SERVER_ID in environment variables.");
    }

      const guild = discord.guilds.cache.get(actualServerId);
    if (!guild) {
        throw new Error(`Server with ID ${actualServerId} not found`);
    }

    const channels = guild.channels.cache
      .filter(
        (channel) =>
          channel.type === ChannelType.GuildText ||
          channel.type === ChannelType.GuildAnnouncement
      )
      .map((channel) => ({
        id: channel.id,
        name: channel.name,
        type: channel.type === ChannelType.GuildText ? "text" : "announcement",
      }));

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(channels, null, 2),
        },
      ],
    };
  }

    case "read_messages": {
      const { channel_id, limit = 50 } = args as {
        channel_id?: string;
        limit?: number;
      };

      const readConfig = getConfig();
      const actualChannelId = channel_id || readConfig.discord.defaultChannelId;

      if (!actualChannelId) {
        throw new Error("Channel ID is required. Provide channel_id parameter or set DISCORD_DEFAULT_CHANNEL_ID in environment variables.");
    }

      const channel = await discord.channels.fetch(actualChannelId);

      if (!channel) {
        throw new Error(`Channel with ID ${channel_id} not found`);
      }

      if (
        !(channel instanceof TextChannel) &&
        !(channel instanceof DMChannel) &&
        !(channel instanceof NewsChannel)
      ) {
        throw new Error("This channel type does not support messages");
      }

      const messages = await channel.messages.fetch({ limit });

      const formattedMessages = messages.map((msg) => ({
        id: msg.id,
        author: {
          id: msg.author.id,
          username: msg.author.username,
          bot: msg.author.bot,
        },
        content: msg.content,
        timestamp: msg.createdAt.toISOString(),
        attachments: msg.attachments.map((att) => ({
          name: att.name,
          url: att.url,
        })),
        embeds: msg.embeds.length,
      }));

      // Reverse to show oldest first
      formattedMessages.reverse();

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(formattedMessages, null, 2),
          },
        ],
      };
    }

    case "search_messages": {
      const { channel_id, query, limit = 100 } = args as {
        channel_id?: string;
        query: string;
        limit?: number;
      };

      const searchConfig = getConfig();
      const actualChannelId = channel_id || searchConfig.discord.defaultChannelId;

      if (!actualChannelId) {
        throw new Error("Channel ID is required. Provide channel_id parameter or set DISCORD_DEFAULT_CHANNEL_ID in environment variables.");
    }

      const channel = await discord.channels.fetch(actualChannelId);

      if (!channel) {
        throw new Error(`Channel with ID ${channel_id} not found`);
      }

      if (
        !(channel instanceof TextChannel) &&
        !(channel instanceof DMChannel) &&
        !(channel instanceof NewsChannel)
      ) {
        throw new Error("This channel type does not support messages");
      }

      const messages = await channel.messages.fetch({ limit });
      const queryLower = query.toLowerCase();

      const matchingMessages = messages
        .filter((msg) => msg.content.toLowerCase().includes(queryLower))
        .map((msg) => ({
          id: msg.id,
          author: {
            id: msg.author.id,
            username: msg.author.username,
          },
          content: msg.content,
          timestamp: msg.createdAt.toISOString(),
        }));

      // Reverse to show oldest first
      matchingMessages.reverse();

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                query,
                matchCount: matchingMessages.length,
                messages: matchingMessages,
              },
              null,
              2
            ),
          },
        ],
      };
    }

    case "search_github_issues": {
      const { query, state = "all" } = args as {
        query: string;
        state?: "open" | "closed" | "all";
      };

      const githubToken = process.env.GITHUB_TOKEN; // Optional GitHub token for higher rate limits
      const searchQuery = state === "all" ? query : `${query} state:${state}`;
      const config = getConfig();
      
      const results = await searchGitHubIssues(searchQuery, githubToken, config.github.owner, config.github.repo);
      
      const formattedResults = {
        query,
        total_count: results.total_count,
        issues: results.items.map((issue) => ({
          number: issue.number,
          title: issue.title,
          state: issue.state,
          url: issue.html_url,
          author: issue.user.login,
          created_at: issue.created_at,
          updated_at: issue.updated_at,
          labels: issue.labels.map((l) => l.name),
          body_preview: issue.body?.substring(0, 300) || "",
        })),
      };

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(formattedResults, null, 2),
          },
        ],
      };
    }

    case "search_discord_and_github": {
      const {
        query,
        channel_id,
        discord_limit = 50,
        github_state = "all",
      } = args as {
        query: string;
        channel_id?: string;
        discord_limit?: number;
        github_state?: "open" | "closed" | "all";
      };

      const searchCombinedConfig = getConfig();
      const actualChannelId = channel_id || searchCombinedConfig.discord.defaultChannelId;

      if (!actualChannelId) {
        throw new Error("Channel ID is required. Provide channel_id parameter or set DISCORD_DEFAULT_CHANNEL_ID in environment variables.");
      }

      // Search Discord messages
      interface DiscordSearchResult {
        id: string;
        author: string;
        content: string;
        timestamp: string;
        url: string;
      }
      
      let discordResults: DiscordSearchResult[] = [];
      try {
        const channel = await discord.channels.fetch(actualChannelId);
        
        if (channel && 
            (channel instanceof TextChannel || 
             channel instanceof DMChannel || 
             channel instanceof NewsChannel)) {
          const messages = await channel.messages.fetch({ limit: discord_limit });
          const queryLower = query.toLowerCase();

          const guildId = channel instanceof TextChannel || channel instanceof NewsChannel
            ? channel.guild.id
            : "@me";
          
          discordResults = messages
            .filter((msg) => msg.content.toLowerCase().includes(queryLower))
            .map((msg) => ({
              id: msg.id,
              author: msg.author.username,
              content: msg.content,
              timestamp: msg.createdAt.toISOString(),
              url: `https://discord.com/channels/${guildId}/${actualChannelId}/${msg.id}`,
            }))
            .reverse();
        }
    } catch (error) {
        // Discord search failed, continue with GitHub
      }

      // Search GitHub issues
      interface GitHubSearchResults {
        total_count: number;
        issues: Array<{
          number: number;
          title: string;
          state: string;
          url: string;
          author: string;
          created_at: string;
          labels: string[];
        }>;
      }
      
      let githubResults: GitHubSearchResults = { total_count: 0, issues: [] };
      try {
        const githubToken = process.env.GITHUB_TOKEN;
        const searchQuery = github_state === "all" ? query : `${query} state:${github_state}`;
        const config = getConfig();
        const results = await searchGitHubIssues(searchQuery, githubToken, config.github.owner, config.github.repo);
        
        githubResults = {
          total_count: results.total_count,
          issues: results.items.map((issue) => ({
            number: issue.number,
            title: issue.title,
            state: issue.state,
            url: issue.html_url,
            author: issue.user.login,
            created_at: issue.created_at,
            labels: issue.labels.map((l) => l.name),
          })),
      };
    } catch (error) {
        // GitHub search failed, continue with Discord results
      }

      const combinedResults = {
        query,
        discord: {
          channel_id: actualChannelId,
          message_count: discordResults.length,
          messages: discordResults,
        },
        github: githubResults,
      };

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(combinedResults, null, 2),
          },
        ],
      };
    }

    case "setup_github_oauth": {
      const { client_id, client_secret } = args as { client_id?: string; client_secret?: string };
      
      const CLIENT_ID = client_id || process.env.GITHUB_OAUTH_CLIENT_ID;
      const CLIENT_SECRET = client_secret || process.env.GITHUB_OAUTH_CLIENT_SECRET;
      
      if (!CLIENT_ID || !CLIENT_SECRET) {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                success: false,
                error: "Missing GitHub OAuth credentials",
                instructions: [
                  "1. Go to https://github.com/settings/developers",
                  "2. Click 'New OAuth App'",
                  "3. Fill in:",
                  "   - Application name: 'UnMute MCP'",
                  "   - Homepage URL: http://localhost:3000",
                  "   - Authorization callback URL: http://localhost:3000/callback",
                  "4. Copy the Client ID and Client Secret",
                  "5. Set environment variables:",
                  "   export GITHUB_OAUTH_CLIENT_ID='your_client_id'",
                  "   export GITHUB_OAUTH_CLIENT_SECRET='your_client_secret'",
                  "6. Or pass them as parameters to this tool",
                  "",
                  "Alternatively, run the interactive setup:",
                  "   npm run github-oauth-setup"
                ].join("\n"),
              }, null, 2),
            },
          ],
        };
      }
      
      const PORT = 3000;
      const REDIRECT_URI = `http://localhost:${PORT}/callback`;
      const authUrl = `https://github.com/login/oauth/authorize?client_id=${CLIENT_ID}&scope=public_repo&redirect_uri=${encodeURIComponent(REDIRECT_URI)}`;
      
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              success: true,
              message: "GitHub OAuth setup ready",
              instructions: [
                "To complete the OAuth flow:",
                "",
                "Option 1: Interactive Setup (Recommended)",
                "  Run: npm run github-oauth-setup",
                "  This will open your browser and handle everything automatically",
                "",
                "Option 2: Manual Setup",
                `  1. Visit this URL in your browser:`,
                `     ${authUrl}`,
                "  2. Authorize the application",
                "  3. You'll be redirected to localhost:3000/callback with a code",
                "  4. Exchange the code for a token using the GitHub API",
                "",
                "After getting your token, add it to GITHUB_TOKEN:",
                "  export GITHUB_TOKEN='your_token_here'",
                "",
                "Or if you have multiple tokens (for rotation):",
                "  export GITHUB_TOKEN='token1,token2,token3'"
              ].join("\n"),
              auth_url: authUrl,
              redirect_uri: REDIRECT_URI,
              scope: "public_repo",
            }, null, 2),
          },
        ],
      };
    }

    case "fetch_github_issues": {
      const { incremental = false, limit } = args as { incremental?: boolean; limit?: number };
      const config = getConfig();
      const githubConfig = config;
      const cachePath = join(process.cwd(), githubConfig.paths.cacheDir, githubConfig.paths.issuesCacheFile);

      try {
        console.error(`[GitHub Issues] Starting fetch_github_issues...`);
        console.error(`[GitHub Issues] Parameters: incremental=${incremental}, limit=${limit ?? 'none'}`);
        
        // Check if cache exists (for both incremental updates and resume capability)
        let existingCache: IssuesCache | null = null;
        let sinceDate: string | undefined = undefined;

        try {
          if (existsSync(cachePath)) {
            console.error(`[GitHub Issues] Found existing cache at ${cachePath}`);
            existingCache = await loadIssuesFromCache(cachePath);
            
            if (incremental) {
              sinceDate = getMostRecentIssueDate(existingCache);
              console.error(`[GitHub Issues] Incremental mode: fetching issues updated since ${sinceDate}`);
              console.error(`[GitHub Issues] Existing cache has ${existingCache.issues.length} issues`);
            } else {
              console.error(`[GitHub Issues] Full fetch mode: will resume from existing cache (${existingCache.issues.length} issues)`);
              console.error(`[GitHub Issues] Already-fetched issues will be skipped, only missing issues will be fetched`);
            }
          } else {
            if (incremental) {
              console.error(`[GitHub Issues] No existing cache found, will fetch all issues`);
            } else {
              console.error(`[GitHub Issues] No existing cache found, will fetch all issues from scratch`);
            }
          }
        } catch (error) {
          console.error(`[GitHub Issues] Cache exists but invalid, will fetch all issues`);
          // Cache doesn't exist or invalid, will fetch all
        }

        // Determine limit: use provided limit, or apply default when DB is not configured
        let actualLimit = limit;
        if (actualLimit === undefined) {
          const { hasDatabaseConfig } = await import("../storage/factory.js");
          if (!hasDatabaseConfig()) {
            // Apply default limit when DB is not configured (try-it-out mode)
            actualLimit = config.storage.defaultLimit?.issues;
            console.error(`[GitHub Issues] No database configured, applying default limit: ${actualLimit}`);
          } else {
            console.error(`[GitHub Issues] Database configured, no limit applied (will fetch all issues)`);
          }
        } else {
          console.error(`[GitHub Issues] Using provided limit: ${actualLimit}`);
        }

        // Initialize token manager (supports multiple comma-separated tokens)
        const { GitHubTokenManager } = await import("../connectors/github/tokenManager.js");
        let tokenManager = await GitHubTokenManager.fromEnvironment();
        
        // Initialize OAuth client manager (supports multiple comma-separated client IDs)
        const { OAuthClientManager } = await import("../connectors/github/oauthClientManager.js");
        const oauthClientManager = OAuthClientManager.fromEnvironment();
        if (oauthClientManager) {
          const allClients = oauthClientManager.getAllClients();
          console.error(`[GitHub Issues] OAuth client manager initialized with ${allClients.length} client(s)`);
          allClients.forEach((client, index) => {
            console.error(`[GitHub Issues]   Client ${index + 1}: ${client.clientId.substring(0, 8)}...`);
          });
        } else {
          console.error(`[GitHub Issues] No OAuth client manager configured (GITHUB_OAUTH_CLIENT_ID and GITHUB_OAUTH_CLIENT_SECRET not set)`);
        }
        
        if (!tokenManager) {
          // Try to get token via OAuth if credentials are available
          if (oauthClientManager) {
            console.error(`[GitHub Issues] No tokens found. Attempting to get token via OAuth...`);
            const { getNewTokenViaOAuth } = await import("../connectors/github/oauthFlow.js");
            
            // Try each client ID until we get a token or run out of clients
            let newToken: string | null = null;
            const allClients = oauthClientManager.getAllClients();
            let attempts = 0;
            const maxAttempts = allClients.length;
            
            while (!newToken && attempts < maxAttempts) {
              const client = oauthClientManager.getUnusedClient();
              if (!client) {
                break;
              }
              
              try {
                console.error(`[GitHub Issues] Trying OAuth client ${client.clientId.substring(0, 8)}... (attempt ${attempts + 1}/${maxAttempts})`);
                newToken = await getNewTokenViaOAuth(client.clientId, client.clientSecret);
                if (newToken) {
                  // Create token manager with the new token (in memory only)
                  tokenManager = new GitHubTokenManager([newToken]);
                  console.error(`[GitHub Issues] Successfully obtained new token via OAuth (Client ID: ${client.clientId.substring(0, 8)}...)!`);
                  break;
                }
              } catch (oauthError) {
                console.error(`[GitHub Issues] OAuth flow failed for client ${client.clientId.substring(0, 8)}...: ${oauthError}`);
                attempts++;
                // Continue to next client
              }
            }
            
            if (!newToken && attempts > 0) {
              console.error(`[GitHub Issues] All ${attempts} OAuth client(s) failed. Please check your OAuth credentials.`);
            }
          }
          
          if (!tokenManager) {
            throw new Error("GITHUB_TOKEN environment variable is required. You can provide multiple tokens separated by commas: token1,token2,token3. Or set GITHUB_OAUTH_CLIENT_ID and GITHUB_OAUTH_CLIENT_SECRET (comma-separated for multiple clients) for automatic token generation.");
          }
        }
        
        const tokenStatus = tokenManager.getStatus();
        const allTokens = tokenManager.getAllTokens();
        const hasGitHubApp = !!(process.env.GITHUB_APP_ID && process.env.GITHUB_APP_INSTALLATION_ID);
        const hasRegularToken = !!(process.env.GITHUB_TOKEN);
        
        console.error(`[GitHub Issues] Token manager initialized:`);
        console.error(`[GitHub Issues]   - Regular GITHUB_TOKEN: ${hasRegularToken ? 'Yes' : 'No'}`);
        console.error(`[GitHub Issues]   - GitHub App: ${hasGitHubApp ? 'Yes' : 'No'}`);
        console.error(`[GitHub Issues]   - Total tokens in manager: ${allTokens.length}`);
        console.error(`[GitHub Issues] Token status: ${tokenStatus.map(t => `Token ${t.index}: ${t.remaining}/${t.limit} remaining`).join(', ')}`);
        
        console.error(`[GitHub Issues] Starting to fetch issues from GitHub API...`);
        const startTime = Date.now();
        
        // Prepare existing issues for resume capability (even if not incremental, we can resume from partial cache)
        const existingIssuesForResume = existingCache?.issues || [];
        let accumulatedIssues = [...existingIssuesForResume];
        
        // Extract issue numbers from existing cache to help Phase 1 resume
        // This allows Phase 1 to skip re-collecting issue numbers we already have
        const existingIssueNumbers = existingIssuesForResume.map(issue => issue.number);
        if (existingIssueNumbers.length > 0 && !incremental) {
          console.error(`[GitHub Issues] Resume mode: ${existingIssueNumbers.length} issue numbers already known, Phase 1 will use these to avoid re-collection`);
        }
        
        // Callback to save progress incrementally after each batch
        const onBatchComplete = async (batchIssues: GitHubIssue[]) => {
          // Merge new batch with accumulated issues
          accumulatedIssues = mergeIssues(accumulatedIssues, batchIssues);
          
          // Save progress to cache file (only if not using database)
          const { hasDatabaseConfig } = await import("../storage/factory.js");
          if (!hasDatabaseConfig()) {
            const progressCache: IssuesCache = {
              fetched_at: new Date().toISOString(),
              total_count: accumulatedIssues.length,
              open_count: accumulatedIssues.filter((i) => i.state === "open").length,
              closed_count: accumulatedIssues.filter((i) => i.state === "closed").length,
              issues: accumulatedIssues,
            };
            
            try {
              const cacheDir = join(process.cwd(), githubConfig.paths.cacheDir);
              await mkdir(cacheDir, { recursive: true });
              await writeFile(cachePath, JSON.stringify(progressCache, null, 2), "utf-8");
              console.error(`[GitHub Issues] Progress saved: ${accumulatedIssues.length} issues cached`);
            } catch (error) {
              // Don't fail the whole operation if progress save fails
              console.error(`[GitHub Issues] Warning: Failed to save progress: ${error}`);
            }
          }
        };
        
        let newIssues: GitHubIssue[];
        try {
          newIssues = await fetchAllGitHubIssues(
            tokenManager, // Pass token manager instead of single token
            true, 
            undefined, 
            undefined, 
            sinceDate, 
            actualLimit,
            true, // includeComments
            existingIssuesForResume, // Pass existing issues for resume
            onBatchComplete, // Pass callback for incremental saving
            existingIssueNumbers.length > 0 && !incremental ? existingIssueNumbers : undefined // Pass issue numbers for Phase 1 resume
          );
        } catch (error) {
          // Check if error is due to all tokens being exhausted
          const errorMessage = error instanceof Error ? error.message : String(error);
          const isRateLimitError = errorMessage.includes('403') || errorMessage.includes('429') || errorMessage.includes('exhausted') || errorMessage.includes('RATE_LIMIT');
          
          if (isRateLimitError) {
            // Check if all tokens are exhausted
            const allExhausted = tokenManager.areAllTokensExhausted();
            
            if (allExhausted) {
              // All tokens exhausted - show reset times for each token type
              const resetTimes = tokenManager.getResetTimesByType();
              const hasApp = !!(process.env.GITHUB_APP_ID && process.env.GITHUB_APP_INSTALLATION_ID);
              const hasRegular = !!(process.env.GITHUB_TOKEN);
              
              let errorDetails = `[RATE_LIMIT_EXHAUSTED] All GitHub tokens exhausted.\n\n`;
              
              if (resetTimes.appTokens.length > 0) {
                errorDetails += `GitHub App tokens (${resetTimes.appTokens.length}):\n`;
                resetTimes.appTokens.forEach(token => {
                  const resetDate = new Date(token.resetAt).toISOString();
                  errorDetails += `  - Token ${token.index}: Resets at ${resetDate} (in ~${token.resetIn} minutes)\n`;
                });
              } else {
                errorDetails += `GitHub App tokens: ${hasApp ? 'configured but no tokens in cache' : 'not configured'}\n`;
              }
              
              if (resetTimes.regularTokens.length > 0) {
                errorDetails += `\nRegular tokens (${resetTimes.regularTokens.length}):\n`;
                resetTimes.regularTokens.forEach(token => {
                  const resetDate = new Date(token.resetAt).toISOString();
                  errorDetails += `  - Token ${token.index}: Resets at ${resetDate} (in ~${token.resetIn} minutes)\n`;
                });
              } else {
                errorDetails += `\nRegular tokens: ${hasRegular ? 'configured but no tokens in cache' : 'not configured'}\n`;
              }
              
              const allResetTimes = [...resetTimes.appTokens, ...resetTimes.regularTokens].map(t => t.resetAt);
              const earliestReset = allResetTimes.length > 0 ? Math.min(...allResetTimes) : Date.now();
              const earliestResetIn = Math.ceil((earliestReset - Date.now()) / 1000 / 60);
              const earliestResetDate = new Date(earliestReset).toISOString();
              
              errorDetails += `\nEarliest reset: ${earliestResetDate} (in ~${earliestResetIn} minutes)\n`;
              errorDetails += `\nNote: If tokens are from the same GitHub account, they share the same rate limit. `;
              errorDetails += `To get separate rate limits, use tokens from different GitHub accounts via GITHUB_TOKEN (comma-separated). `;
              errorDetails += `The fetch has been stopped. Progress has been saved. Please wait for rate limits to reset and try again.`;
              
              const rateLimitError = new Error(errorDetails);
              
              console.error(`[GitHub Issues] ${rateLimitError.message}`);
              throw rateLimitError;
            } else {
              // Rate limit hit but tokens available - this shouldn't happen, but handle it
              console.error(`[GitHub Issues] Rate limit error occurred: ${errorMessage}`);
              throw new Error(`[RATE_LIMIT_ERROR] ${errorMessage}. The fetch has been stopped. Progress has been saved.`);
            }
          } else {
            throw error; // Re-throw if not a rate limit error
          }
        }
        
        const fetchTime = ((Date.now() - startTime) / 1000).toFixed(2);
        console.error(`[GitHub Issues] Fetch completed in ${fetchTime}s. Fetched ${newIssues.length} issues.`);

        // Merge with existing cache if doing incremental update
        let finalIssues: GitHubIssue[];
        if (existingCache && newIssues.length > 0) {
          console.error(`[GitHub Issues] Merging ${newIssues.length} new/updated issues with ${existingCache.issues.length} existing issues...`);
          finalIssues = mergeIssues(existingCache.issues, newIssues);
          console.error(`[GitHub Issues] Merge complete: ${finalIssues.length} total issues`);
        } else if (existingCache && newIssues.length === 0) {
          console.error(`[GitHub Issues] No new/updated issues found, using existing cache (${existingCache.issues.length} issues)`);
          finalIssues = existingCache.issues;
        } else {
          console.error(`[GitHub Issues] No existing cache, using ${newIssues.length} newly fetched issues`);
          finalIssues = newIssues;
        }

        const cacheData: IssuesCache = {
          fetched_at: new Date().toISOString(),
          total_count: finalIssues.length,
          open_count: finalIssues.filter((i) => i.state === "open").length,
          closed_count: finalIssues.filter((i) => i.state === "closed").length,
          issues: finalIssues,
        };

        // Check if database is configured - save to database if available
        const { hasDatabaseConfig, getStorage } = await import("../storage/factory.js");
        const useDatabase = hasDatabaseConfig();
        
        let savedToDatabase = false;
        
        if (useDatabase) {
          // Save to database
          try {
            const storage = getStorage();
            
            // Check if database is actually available
            const dbAvailable = await storage.isAvailable();
            if (!dbAvailable) {
              throw new Error("DATABASE_URL is set but database is not available");
            }
            
            // Convert GitHub issues to database format
            const issuesToSave = finalIssues.map((issue) => ({
              number: issue.number,
              title: issue.title,
              url: issue.html_url,
              state: issue.state,
              body: issue.body || undefined,
              labels: issue.labels.map((l) => l.name),
              author: issue.user.login,
              created_at: issue.created_at,
              updated_at: issue.updated_at,
              comments: issue.comments || [],
              assignees: issue.assignees || [],
              milestone: issue.milestone || null,
              reactions: issue.reactions || null,
            }));
            
            console.error(`[GitHub Issues] Saving ${issuesToSave.length} issues to database...`);
            await storage.saveGitHubIssues(issuesToSave);
            console.error(`[GitHub Issues] Successfully saved ${issuesToSave.length} issues to database.`);
            savedToDatabase = true;
          } catch (dbError) {
            const errorMessage = dbError instanceof Error ? dbError.message : String(dbError);
            console.error(`[GitHub Issues] Database save error:`, errorMessage);
            throw new Error(`Failed to save GitHub issues to database: ${errorMessage}`);
          }
        } else {
          console.error(`[GitHub Issues] DATABASE_URL not set. Using JSON storage.`);
          
          // Save to JSON file only if database is not configured
          const cacheDir = join(process.cwd(), githubConfig.paths.cacheDir);
          try {
            await mkdir(cacheDir, { recursive: true });
          } catch (error) {
            // Directory might already exist
          }

          console.error(`[GitHub Issues] Saving ${cacheData.total_count} issues to JSON cache...`);
          await writeFile(cachePath, JSON.stringify(cacheData, null, 2), "utf-8");
          console.error(`[GitHub Issues] Successfully saved to JSON cache at ${cachePath}`);
        }

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                success: true,
                message: savedToDatabase
                  ? (incremental && newIssues.length > 0
                      ? `Updated database with ${newIssues.length} new/updated issues`
                      : `Saved ${finalIssues.length} issues to database`)
                  : (incremental && newIssues.length > 0
                      ? `Updated cache with ${newIssues.length} new/updated issues`
                      : `Fetched ${finalIssues.length} issues`),
                total: cacheData.total_count,
                open: cacheData.open_count,
                closed: cacheData.closed_count,
                new_updated: incremental ? newIssues.length : finalIssues.length,
                cache_path: savedToDatabase ? undefined : cachePath,
                storage: savedToDatabase ? "database" : "json",
              }, null, 2),
            },
          ],
        };
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        
        // If it's already a rate limit error with our special prefix, preserve it
        if (errorMessage.includes('[RATE_LIMIT')) {
          throw error; // Re-throw rate limit errors as-is
        }
        
        // For other errors, wrap with context
        throw new Error(`Failed to fetch GitHub issues: ${errorMessage}`);
      }
    }

    case "check_github_issues_completeness": {
      try {
        const config = getConfig();
        const repoOwner = config.github.owner;
        const repoName = config.github.repo;
        
        console.error(`[GitHub Issues Check] Checking completeness for ${repoOwner}/${repoName}...`);
        
        // Initialize token manager
        const { GitHubTokenManager } = await import("../connectors/github/tokenManager.js");
        const tokenManager = await GitHubTokenManager.fromEnvironment();
        if (!tokenManager) {
          throw new Error("GITHUB_TOKEN or GitHub App credentials required");
        }
        
        const token = await tokenManager.getCurrentToken();
        const headers = {
          Authorization: `Bearer ${token}`,
          Accept: "application/vnd.github.v3+json",
        };
        
        // Get total issues from GitHub API
        console.error("[GitHub Issues Check] Fetching issue counts from GitHub API...");
        let allIssueNumbers: number[] = [];
        let page = 1;
        let hasMore = true;
        
        while (hasMore) {
          const response = await fetch(
            `https://api.github.com/repos/${repoOwner}/${repoName}/issues?state=all&per_page=100&page=${page}&sort=updated&direction=desc`,
            { headers }
          );
          
          if (!response.ok) {
            throw new Error(`GitHub API error: ${response.status}`);
          }
          
          const issues = (await response.json()) as Array<{ number: number; pull_request?: unknown }>;
          const actualIssues = issues.filter(issue => !issue.pull_request);
          const issueNumbers = actualIssues.map(issue => issue.number);
          allIssueNumbers.push(...issueNumbers);
          
          if (issues.length < 100) {
            hasMore = false;
          } else {
            page++;
          }
        }
        
        const totalIssuesFromAPI = allIssueNumbers.length;
        console.error(`[GitHub Issues Check] GitHub API reports ${totalIssuesFromAPI} total issues`);
        
        // Get issues from database
        const { hasDatabaseConfig, getStorage } = await import("../storage/factory.js");
        if (!hasDatabaseConfig()) {
          throw new Error("Database not configured. This check requires a database.");
        }
        
        const storage = getStorage();
        const dbIssues = await storage.getGitHubIssues();
        const totalIssuesInDB = dbIssues.length;
        const dbIssueNumbers = new Set(dbIssues.map(i => i.number));
        
        // Check for missing issues
        const missingIssues = allIssueNumbers.filter(num => !dbIssueNumbers.has(num));

        // Query database directly for detailed stats (includes comments)
        const { prisma } = await import("../storage/db/prisma.js");
        const dbIssuesDetailed = await prisma.gitHubIssue.findMany({
          select: {
            issueNumber: true,
            issueTitle: true,
            issueState: true,
            issueComments: true,
            issueBody: true,
          },
        });
        
        const issuesWithoutCommentsDetailed = dbIssuesDetailed.filter(issue => {
          const comments = issue.issueComments;
          return !comments || !Array.isArray(comments) || comments.length === 0;
        });

        const issuesWithoutBody = dbIssuesDetailed.filter(issue => !issue.issueBody || issue.issueBody.trim().length === 0);

        const openIssues = dbIssuesDetailed.filter(i => i.issueState === "open").length;
        const closedIssues = dbIssuesDetailed.filter(i => i.issueState === "closed").length;
        const issuesWithComments = dbIssuesDetailed.filter(issue => {
          const comments = issue.issueComments;
          return comments && Array.isArray(comments) && comments.length > 0;
        });
        
        // Completeness score
        const completenessScore = totalIssuesFromAPI > 0 
          ? ((totalIssuesInDB - missingIssues.length) / totalIssuesFromAPI) * 100 
          : 100;
        
        const report = {
          repository: `${repoOwner}/${repoName}`,
          totalIssuesFromAPI,
          totalIssuesInDB,
          missingIssues: missingIssues.length,
          missingIssueNumbers: missingIssues,
          byState: {
            open: openIssues,
            closed: closedIssues,
          },
          comments: {
            withComments: issuesWithComments.length,
            withoutComments: issuesWithoutCommentsDetailed.length,
            percentageWithComments: totalIssuesInDB > 0 ? ((issuesWithComments.length / totalIssuesInDB) * 100).toFixed(1) : "0",
          },
          body: {
            withBody: totalIssuesInDB - issuesWithoutBody.length,
            withoutBody: issuesWithoutBody.length,
          },
          completenessScore: completenessScore.toFixed(1),
          status: completenessScore === 100 && issuesWithoutCommentsDetailed.length === 0 
            ? "complete" 
            : completenessScore === 100 
            ? "complete_but_missing_comments" 
            : "incomplete",
        };
        
        console.error(`[GitHub Issues Check] Completeness: ${report.completenessScore}%`);
        console.error(`[GitHub Issues Check] Status: ${report.status}`);
        
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(report, null, 2),
            },
          ],
        };
      } catch (error) {
        throw new Error(`Failed to check GitHub issues completeness: ${error instanceof Error ? error.message : error}`);
      }
    }

    case "check_discord_classification_completeness": {
      try {
        const { channel_id } = args as { channel_id?: string };
        const config = getConfig();
        const actualChannelId = channel_id || config.discord.defaultChannelId;
        
        if (!actualChannelId) {
          throw new Error("channel_id is required or DISCORD_DEFAULT_CHANNEL_ID must be set in config");
        }
        
        console.error(`[Discord Classification Check] Checking completeness for channel ${actualChannelId}...`);
        
        const { hasDatabaseConfig, getStorage } = await import("../storage/factory.js");
        const useDatabase = hasDatabaseConfig();
        const storage = useDatabase ? getStorage() : null;
        
        let totalMessages = 0;
        let totalThreads = 0;
        let classifiedThreads = 0;
        let classifiedMessages = 0;
        let unclassifiedMessages = 0;
        
        if (useDatabase && storage) {
          // Get total messages from database
          const { prisma } = await import("../storage/db/prisma.js");
          totalMessages = await prisma.discordMessage.count({
            where: { channelId: actualChannelId },
          });
          
          // Early return if no messages
          if (totalMessages === 0) {
            return {
              content: [
                {
                  type: "text",
                  text: JSON.stringify({
                    channelId: actualChannelId,
                    messages: { total: 0, classified: 0, unclassified: 0, completeness: "100.0%" },
                    threads: { total: 0, classified: 0, unclassified: 0, completeness: "100.0%" },
                    overallCompleteness: "100.0%",
                    status: "complete",
                    dataSource: "database",
                  }, null, 2),
                },
              ],
            };
          }
          
          // Count threads: messages with threadId count as 1 thread each, standalone messages (null threadId) count as individual threads
          // Run queries in parallel for better performance
          const [distinctThreadIds, standaloneMessagesCount, allMessagesWithThreads] = await Promise.all([
            // Get distinct non-null threadIds
            prisma.discordMessage.findMany({
              where: { 
                channelId: actualChannelId,
                threadId: { not: null }
              },
              select: { threadId: true },
              distinct: ['threadId'],
            }),
            // Count standalone messages
            prisma.discordMessage.count({
              where: { 
                channelId: actualChannelId,
                threadId: null
              }
            }),
            // Get all messages with thread info to map message IDs to threads
            prisma.discordMessage.findMany({
              where: { channelId: actualChannelId },
              select: { id: true, threadId: true },
            })
          ]);
          
          totalThreads = distinctThreadIds.length + standaloneMessagesCount;
          const messageIdSet = new Set(allMessagesWithThreads.map(m => m.id));
          
          // Create a Map for efficient message ID to thread ID lookups
          const messageToThreadMap = new Map<string, string>();
          allMessagesWithThreads.forEach(msg => {
            // Use threadId if exists, otherwise use message ID (standalone message)
            messageToThreadMap.set(msg.id, msg.threadId || msg.id);
          });
          
          // Get classification history and verify messages exist in database
          const classificationHistory = await storage.getClassificationHistory(actualChannelId);
          
          // Count classified messages and threads by checking message IDs
          const classifiedMessageIds = new Set<string>();
          const classifiedThreadIds = new Set<string>();
          
          classificationHistory.forEach(entry => {
            const messageId = entry.message_id;
            // Only count if message exists in database
            if (messageIdSet.has(messageId)) {
              classifiedMessageIds.add(messageId);
              
              // Use thread_id from classification history if available, otherwise look it up
              const threadId = entry.thread_id || messageToThreadMap.get(messageId) || messageId;
              classifiedThreadIds.add(threadId);
            }
          });
          
          classifiedMessages = classifiedMessageIds.size;
          classifiedThreads = classifiedThreadIds.size;
        } else {
          // Use cache files
          const { loadDiscordCache, getAllMessagesFromCache } = await import("../storage/cache/discordCache.js");
          const { loadClassificationHistory } = await import("../storage/cache/classificationHistory.js");
          const { join } = await import("path");
          
          const classifyConfig = getConfig();
          const resultsDir = join(process.cwd(), classifyConfig.paths.resultsDir || "results");
          const discordCacheDir = join(process.cwd(), classifyConfig.paths.cacheDir);
          const safeChannelName = actualChannelId.replace(/[^a-zA-Z0-9]/g, "_");
          const discordCachePath = join(discordCacheDir, `discord-${safeChannelName}-${actualChannelId}.json`);
          
          try {
            const discordCache = await loadDiscordCache(discordCachePath);
            const allMessages = getAllMessagesFromCache(discordCache);
            totalMessages = allMessages.length;
            
            // Count unique threads
            const threadIds = new Set<string>();
            allMessages.forEach(msg => {
              if (msg.thread?.id) {
                threadIds.add(msg.thread.id);
              } else {
                // Standalone message - use message ID as thread ID
                threadIds.add(msg.id);
              }
            });
            totalThreads = threadIds.size;
          } catch (error) {
            console.error(`[Discord Classification Check] Could not load cache: ${error instanceof Error ? error.message : error}`);
          }
          
          // Get classification history from JSON
          const classificationHistory = await loadClassificationHistory(resultsDir, actualChannelId);
          const classifiedMessageIds = new Set(Object.keys(classificationHistory.messages || {}));
          classifiedMessages = classifiedMessageIds.size;
          
          // Count classified threads
          if (classificationHistory.threads) {
            classifiedThreads = Object.keys(classificationHistory.threads).filter(
              threadId => classificationHistory.threads![threadId].status === "completed"
            ).length;
          }
        }
        
        unclassifiedMessages = totalMessages - classifiedMessages;
        const unclassifiedThreads = totalThreads - classifiedThreads;
        
        // Calculate completeness scores
        const messageCompleteness = totalMessages > 0 
          ? ((classifiedMessages / totalMessages) * 100).toFixed(1)
          : "100.0";
        
        const threadCompleteness = totalThreads > 0
          ? ((classifiedThreads / totalThreads) * 100).toFixed(1)
          : "100.0";
        
        const overallCompleteness = totalMessages > 0
          ? ((classifiedMessages / totalMessages) * 100).toFixed(1)
          : "100.0";
        
        const status = parseFloat(overallCompleteness) === 100 
          ? "complete"
          : parseFloat(overallCompleteness) >= 90
          ? "mostly_complete"
          : parseFloat(overallCompleteness) >= 50
          ? "in_progress"
          : "incomplete";
        
        const report = {
          channelId: actualChannelId,
          messages: {
            total: totalMessages,
            classified: classifiedMessages,
            unclassified: unclassifiedMessages,
            completeness: `${messageCompleteness}%`,
          },
          threads: {
            total: totalThreads,
            classified: classifiedThreads,
            unclassified: unclassifiedThreads,
            completeness: `${threadCompleteness}%`,
          },
          overallCompleteness: `${overallCompleteness}%`,
          status,
          dataSource: useDatabase ? "database" : "cache_files",
        };
        
        console.error(`[Discord Classification Check] Overall Completeness: ${report.overallCompleteness}`);
        console.error(`[Discord Classification Check] Status: ${report.status}`);
        console.error(`[Discord Classification Check] Messages: ${classifiedMessages}/${totalMessages} classified`);
        console.error(`[Discord Classification Check] Threads: ${classifiedThreads}/${totalThreads} classified`);
        
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(report, null, 2),
            },
          ],
        };
      } catch (error) {
        throw new Error(`Failed to check Discord classification completeness: ${error instanceof Error ? error.message : error}`);
      }
    }

    case "compute_discord_embeddings": {
      const { channel_id } = args as { channel_id?: string };
      
      if (!process.env.OPENAI_API_KEY) {
        throw new Error("OPENAI_API_KEY is required for computing embeddings.");
      }

      const { computeAndSaveThreadEmbeddings } = await import("../storage/db/embeddings.js");
      
      if (channel_id) {
        console.error(`[Embeddings] Starting Discord thread embeddings computation for channel ${channel_id}...`);
      } else {
        console.error("[Embeddings] Starting Discord thread embeddings computation for all channels...");
      }
      
      // Compute embeddings (with optional channel filter)
      const result = await computeAndSaveThreadEmbeddings(process.env.OPENAI_API_KEY, {
        channelId: channel_id,
      });
      
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              success: true,
              message: channel_id
                ? `Embeddings computed for Discord threads in channel ${channel_id}: ${result.computed} computed, ${result.cached} cached, ${result.total} total`
                : `Embeddings computed for Discord threads: ${result.computed} computed, ${result.cached} cached, ${result.total} total`,
              computed: result.computed,
              cached: result.cached,
              total: result.total,
              ...(channel_id ? { channel_id } : {}),
            }, null, 2),
          },
        ],
      };
    }

    case "compute_github_issue_embeddings": {
      if (!process.env.OPENAI_API_KEY) {
        throw new Error("OPENAI_API_KEY is required for computing embeddings.");
      }

      const { computeAndSaveIssueEmbeddings } = await import("../storage/db/embeddings.js");
      
      const force = (args?.force === true);
      
      console.error(`[Embeddings] Starting GitHub issue embeddings computation...`);
      if (force) {
        console.error(`[Embeddings] Force mode enabled - will recompute all embeddings from scratch`);
      } else {
        console.error(`[Embeddings] Incremental mode - will only compute embeddings for issues that don't have them or have changed content`);
      }
      
      const result = await computeAndSaveIssueEmbeddings(process.env.OPENAI_API_KEY, undefined, force);

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              success: true,
              message: `Embeddings computed for GitHub issues: ${result.computed} computed, ${result.cached} cached, ${result.total} total`,
              computed: result.computed,
              cached: result.cached,
              total: result.total,
            }, null, 2),
          },
        ],
      };
    }

    case "compute_feature_embeddings": {
      if (!process.env.OPENAI_API_KEY) {
        throw new Error("OPENAI_API_KEY is required for computing feature embeddings.");
      }

      const { computeAndSaveFeatureEmbeddings } = await import("../storage/db/embeddings.js");
      
      const force = (args?.force === true);
      const codeContext = (args?.code_context as string | undefined);
      
      console.error("[Embeddings] Starting feature embeddings computation...");
      if (codeContext) {
        console.error(`[Embeddings] Using provided code context from agent (${codeContext.length} characters)`);
      } else {
        console.error("[Embeddings] No code context provided - will attempt to fetch from GitHub API if GITHUB_REPO_URL is configured");
        console.error("[Embeddings] Note: For better accuracy, the agent should use codebase_search to find relevant code and pass it via code_context parameter");
      }
      console.error("[Embeddings] This will include: documentation context, related GitHub issues, Discord conversations, and code context from repository");
      if (force) {
        console.error("[Embeddings] Force mode enabled - will recompute all embeddings");
      }
      
      await computeAndSaveFeatureEmbeddings(process.env.OPENAI_API_KEY, undefined, force, codeContext);

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              success: true,
              message: codeContext 
                ? "Feature embeddings computed successfully with provided code context. Features now include documentation context, related GitHub issues, Discord conversations, and the provided code context."
                : "Feature embeddings computed successfully. Features now include documentation context, related GitHub issues, Discord conversations, and code context from repository (if configured).",
            }, null, 2),
          },
        ],
      };
    }

    case "index_codebase": {
      const { search_query, force = false, chunk_size } = args as {
        search_query: string;
        force?: boolean;
        chunk_size?: number;
      };

      if (!search_query || search_query.trim().length === 0) {
        throw new Error("search_query is required");
      }

      const { getConfig } = await import("../config/index.js");
      const config = getConfig();
      const repositoryUrl = config.pmIntegration?.github_repo_url;
      const localRepoPath = config.pmIntegration?.local_repo_path;

      if (!repositoryUrl && !localRepoPath) {
        throw new Error("Either GITHUB_REPO_URL or LOCAL_REPO_PATH must be configured to index codebase");
      }

      const { searchAndIndexCode } = await import("../storage/db/codeIndexer.js");
      
      console.error(`[CodeIndexing] Starting manual code indexing for query: "${search_query}"`);
      if (force) {
        console.error(`[CodeIndexing] Force mode enabled - will re-index even if already indexed`);
      }
      
      try {
        // Search and index code (this will use cache if not forcing)
        // Use repositoryUrl if available, otherwise use localRepoPath as fallback identifier
        const repoIdentifier = repositoryUrl || localRepoPath || "";
        const chunkSize = chunk_size ?? 100;
        const codeContext = await searchAndIndexCode(
          search_query,
          repoIdentifier,
          "", // No specific feature ID for manual indexing
          search_query,
          force,
          chunkSize
        );

        if (codeContext) {
          const fileCount = (codeContext.match(/File: /g) || []).length;
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify({
                  success: true,
                  message: `Code indexed successfully for query "${search_query}". Found ${fileCount} file(s).`,
                  code_context_length: codeContext.length,
                  file_count: fileCount,
                }, null, 2),
              },
            ],
          };
        } else {
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify({
                  success: false,
                  message: `No code found for query "${search_query}"`,
                }, null, 2),
              },
            ],
          };
        }
      } catch (error) {
        throw new Error(`Failed to index codebase: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    case "index_code_for_features": {
      const { force = false, local_repo_path, github_repo_url, chunk_size, max_files } = args as {
        force?: boolean;
        local_repo_path?: string;
        github_repo_url?: string;
        chunk_size?: number;
        max_files?: number | null;
      };

      const { getConfig } = await import("../config/index.js");
      const config = getConfig();
      
      // Get configured values (parameter > config)
      // No auto-detection - must be explicitly configured
      const repositoryUrl = github_repo_url || config.pmIntegration?.github_repo_url;
      const localRepoPath = local_repo_path || config.pmIntegration?.local_repo_path;

      if (!repositoryUrl && !localRepoPath) {
        throw new Error("Either GITHUB_REPO_URL or LOCAL_REPO_PATH must be configured to index code for features. You can provide them as parameters or set them in the MCP config (.env file).");
      }

      const { indexCodeForAllFeatures } = await import("../storage/db/codeIndexer.js");
      
      console.error(`[CodeIndexing] Starting proactive code indexing for all features...`);
      
      // Determine source of repo path for logging
      let repoPathSource = "config";
      if (local_repo_path) {
        repoPathSource = "parameter";
      } else if (config.pmIntegration?.local_repo_path) {
        repoPathSource = "config";
      }
      
      if (localRepoPath) {
        console.error(`[CodeIndexing] Using local repository path: ${localRepoPath} (source: ${repoPathSource})`);
      }
      if (repositoryUrl) {
        console.error(`[CodeIndexing] Using GitHub repository URL: ${repositoryUrl}`);
      }
      if (force) {
        console.error(`[CodeIndexing] Force mode enabled - will re-index even if already indexed`);
      }
      
      try {
        const chunkSize = chunk_size ?? 100;
        const maxFiles = max_files ?? null; // null = process entire repository in chunks
        const result = await indexCodeForAllFeatures(repositoryUrl || undefined, force, undefined, localRepoPath, chunkSize, maxFiles);
        
        // Get diagnostic info (use the same variables we already have)
        const githubRepoUrl = repositoryUrl;
        
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                success: true,
                message: `Code indexing completed for all features.`,
                indexed: result.indexed,
                matched: result.matched,
                total: result.total,
                diagnostics: {
                  local_repo_path: localRepoPath || "not configured",
                  github_repo_url: githubRepoUrl || "not configured",
                  local_repo_exists: localRepoPath ? (await import("fs")).existsSync(localRepoPath) : false,
                  repo_path_source: repoPathSource,
                },
              }, null, 2),
            },
          ],
        };
      } catch (error) {
        throw new Error(`Failed to index code for features: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    case "fetch_discord_messages": {
      const { channel_id, incremental = true, limit } = args as {
        channel_id?: string;
        incremental?: boolean;
        limit?: number;
      };

      const config = getConfig();
      const discordConfig = config.discord;
      const actualChannelId = channel_id || discordConfig.defaultChannelId;

      if (!actualChannelId) {
        throw new Error("Channel ID is required. Provide channel_id parameter or set DISCORD_DEFAULT_CHANNEL_ID in environment variables.");
      }

      const cacheDir = join(process.cwd(), config.paths.cacheDir);
      const cacheFileName = `discord-messages-${actualChannelId}.json`;
      const cachePath = join(cacheDir, cacheFileName);

      try {
        const channel = await discord.channels.fetch(actualChannelId);

        if (!channel ||
            (!(channel instanceof TextChannel) &&
             !(channel instanceof DMChannel) &&
             !(channel instanceof NewsChannel))) {
          throw new Error("Channel does not support messages");
        }

        const channelName = channel instanceof TextChannel || channel instanceof NewsChannel
          ? `#${channel.name}`
          : "DM";

        const guildId = channel instanceof TextChannel || channel instanceof NewsChannel
          ? channel.guild?.id
          : undefined;

        // Check if cache exists for incremental update
        let existingCache: DiscordCache | null = null;
        let sinceDate: string | undefined = undefined;

        if (incremental) {
          try {
            const foundCachePath = await findDiscordCacheFile(actualChannelId);
            if (foundCachePath) {
              existingCache = await loadDiscordCache(foundCachePath);
              sinceDate = getMostRecentMessageDate(existingCache);
            }
          } catch (error) {
            // Cache doesn't exist or invalid
          }
        }

        // Determine limit: use provided limit, or apply default when DB is not configured
        let actualLimit = limit;
        if (actualLimit === undefined) {
          const { hasDatabaseConfig } = await import("../storage/factory.js");
          if (!hasDatabaseConfig()) {
            // Apply default limit when DB is not configured (try-it-out mode)
            actualLimit = config.storage.defaultLimit?.messages;
          }
        }

        // Fetch messages with pagination
        let fetchedMessages: Message[] = [];
        let lastMessageId: string | undefined = undefined;
        let hasMore = true;
        const maxMessages = actualLimit; // undefined = no limit (fetch all)

        while (hasMore && (maxMessages === undefined || fetchedMessages.length < maxMessages)) {
          const options: { limit: number; before?: string } = { limit: 100 };
          if (lastMessageId) {
            options.before = lastMessageId;
          }

          const messages = await channel.messages.fetch(options);

          if (messages.size === 0) {
            hasMore = false;
            break;
          }

          const messageArray = Array.from(messages.values());

          // If incremental, filter by date (check both created_at and edited_at)
          if (incremental && sinceDate) {
            const sinceTime = new Date(sinceDate).getTime();
            const newMessages = messageArray.filter((msg: Message) => {
              const createdTime = msg.createdAt.getTime();
              const editedTime = msg.editedAt ? msg.editedAt.getTime() : 0;
              return createdTime >= sinceTime || editedTime >= sinceTime;
            });

            if (newMessages.length === 0) {
              const newestInBatch = messageArray[0];
              const newestTime = Math.max(
                newestInBatch.createdAt.getTime(),
                newestInBatch.editedAt ? newestInBatch.editedAt.getTime() : 0
              );
              if (newestTime < sinceTime) {
                hasMore = false;
                break;
              }
            }

            fetchedMessages.push(...newMessages);
          } else {
            fetchedMessages.push(...messageArray);
          }

          lastMessageId = messageArray[messageArray.length - 1].id;

          if (messages.size < 100) {
            hasMore = false;
          }
        }

        // Format messages
        const formattedMessages = fetchedMessages.map((msg: Message) => {
          return {
            id: msg.id,
            author: {
              id: msg.author.id,
              username: msg.author.username,
              discriminator: msg.author.discriminator,
              bot: msg.author.bot,
              avatar: msg.author.avatar,
            },
            content: msg.content,
            created_at: msg.createdAt.toISOString(),
            edited_at: msg.editedAt ? msg.editedAt.toISOString() : null,
            timestamp: msg.createdTimestamp.toString(),
            channel_id: actualChannelId,
            channel_name: channelName,
            guild_id: guildId,
            guild_name: channel instanceof TextChannel || channel instanceof NewsChannel
              ? channel.guild?.name
              : undefined,
            attachments: Array.from(msg.attachments.values()).map((att) => ({
              id: att.id,
              filename: att.name,
              url: att.url,
              size: att.size,
              content_type: att.contentType || undefined,
            })),
            embeds: msg.embeds.length,
            mentions: Array.from(msg.mentions.users.keys()).map(id => String(id)),
            reactions: Array.from(msg.reactions.cache.values()).map((reaction) => ({
              emoji: reaction.emoji.name || reaction.emoji.id || "",
              count: reaction.count,
            })),
            thread: msg.thread ? {
              id: msg.thread.id,
              name: msg.thread.name,
            } : undefined,
            message_reference: msg.reference ? {
              message_id: msg.reference.messageId || "",
              channel_id: msg.reference.channelId || "",
              guild_id: msg.reference.guildId || undefined,
            } : undefined,
            url: msg.url,
          };
        });

        // Merge with existing cache if doing incremental update, or organize by thread
        let cacheData: DiscordCache;

        if (existingCache && formattedMessages.length > 0) {
          cacheData = mergeMessagesByThread(existingCache, formattedMessages);
        } else if (existingCache && formattedMessages.length === 0) {
          cacheData = existingCache;
    } else {
          const { threads, mainMessages } = organizeMessagesByThread(formattedMessages);
          const totalCount = formattedMessages.length;
          const dates = formattedMessages.map(m => new Date(m.created_at).getTime());
          const oldestDate = dates.length > 0 ? new Date(Math.min(...dates)).toISOString() : null;
          const newestDate = dates.length > 0 ? new Date(Math.max(...dates)).toISOString() : null;

          cacheData = {
            fetched_at: new Date().toISOString(),
            channel_id: actualChannelId,
            channel_name: channelName,
            total_count: totalCount,
            oldest_message_date: oldestDate,
            newest_message_date: newestDate,
            threads,
            main_messages: mainMessages,
          };
        }

        // Save to database if configured (required when DATABASE_URL is set)
        const { hasDatabaseConfig, getStorage } = await import("../storage/factory.js");
        const useDatabase = hasDatabaseConfig();
        
        let savedToDatabase = false;
        
        if (useDatabase) {
          const storage = getStorage();
          
          // Check if database is actually available
          const dbAvailable = await storage.isAvailable();
          if (!dbAvailable) {
            throw new Error(`DATABASE_URL is set but database is not available. Please check your database connection.`);
          }
          
          // Ensure channel exists
          await storage.upsertChannel(actualChannelId, channelName, guildId);
          
          // Flatten messages for database storage (extract nested author, thread, message_reference)
          const flattenedMessages = formattedMessages.map(msg => ({
            id: msg.id,
            channelId: msg.channel_id,
            authorId: msg.author.id,
            authorUsername: msg.author.username,
            authorDiscriminator: msg.author.discriminator,
            authorBot: msg.author.bot,
            authorAvatar: msg.author.avatar ?? undefined,
            content: msg.content,
            createdAt: msg.created_at,
            editedAt: msg.edited_at ?? undefined,
            timestamp: msg.timestamp,
            channelName: msg.channel_name,
            guildId: msg.guild_id,
            guildName: msg.guild_name,
            attachments: msg.attachments,
            embeds: msg.embeds,
            mentions: msg.mentions,
            reactions: msg.reactions,
            threadId: msg.thread?.id,
            threadName: msg.thread?.name,
            messageReference: msg.message_reference ?? undefined,
            url: msg.url,
          }));
          
          // Save to database (required - will throw if it fails)
          await storage.saveDiscordMessages(flattenedMessages);
          savedToDatabase = true;
          console.error(`[Discord Messages] Saved ${flattenedMessages.length} messages to database.`);
        } else {
          console.error(`[Discord Messages] DATABASE_URL not set. Using JSON storage only.`);
        }

        // Only save to JSON cache if database is NOT available
        // When database is available, we use it as the primary storage
        if (!savedToDatabase) {
          try {
            await mkdir(cacheDir, { recursive: true });
          } catch (error) {
            // Directory might already exist
          }

          await writeFile(cachePath, JSON.stringify(cacheData, null, 2), "utf-8");
          console.error(`[Discord Messages] Saved to JSON cache (database not available).`);
        }

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                success: true,
                message: savedToDatabase
                  ? (incremental && formattedMessages.length > 0
                      ? `Updated database with ${formattedMessages.length} new/updated messages`
                      : `Saved ${formattedMessages.length} messages to database`)
                  : (incremental && formattedMessages.length > 0
                      ? `Updated cache with ${formattedMessages.length} new/updated messages`
                      : `Fetched ${cacheData.total_count} messages`),
                total: savedToDatabase ? formattedMessages.length : cacheData.total_count,
                threads: savedToDatabase 
                  ? new Set(formattedMessages.map(m => m.thread?.id).filter(Boolean)).size
                  : Object.keys(cacheData.threads).length,
                main_messages: savedToDatabase
                  ? formattedMessages.filter(m => !m.thread?.id).length
                  : cacheData.main_messages.length,
                new_updated: incremental ? formattedMessages.length : (savedToDatabase ? formattedMessages.length : cacheData.total_count),
                cache_path: savedToDatabase ? undefined : cachePath,
                storage: savedToDatabase ? "database" : "json",
                channel_name: channelName,
              }, null, 2),
            },
          ],
        };
      } catch (error) {
        throw new Error(`Failed to fetch Discord messages: ${error instanceof Error ? error.message : error}`);
      }
    }

    case "classify_discord_messages": {
      const { channel_id, limit = 30, min_similarity = 20, re_classify = false, classify_all = false } = args as {
        channel_id?: string;
        limit?: number;
        min_similarity?: number;
        re_classify?: boolean;
        classify_all?: boolean;
      };

      const classifyConfig = getConfig();
      const actualChannelId = channel_id || classifyConfig.discord.defaultChannelId;

      if (!actualChannelId) {
        throw new Error("Channel ID is required. Provide channel_id parameter or set DISCORD_DEFAULT_CHANNEL_ID in environment variables.");
      }

      // Calculate database availability once for reuse throughout this case
      const { getStorage, hasDatabaseConfig } = await import("../storage/factory.js");
      const storage = getStorage();
      const useDatabase = hasDatabaseConfig() && await storage.isAvailable();

      // Step 1: Fetch/sync GitHub issues (incremental) before classification
      const issuesCachePath = join(process.cwd(), classifyConfig.paths.cacheDir, classifyConfig.paths.issuesCacheFile);
      let existingIssuesCache: IssuesCache | null = null;
      let sinceIssuesDate: string | undefined = undefined;
      let existingIssuesForResume: GitHubIssue[] = [];

      // Load existing issues from database (if using database) or cache
      if (useDatabase) {
        try {
          const { prisma } = await import("../storage/db/prisma.js");
          const dbIssues = await prisma.gitHubIssue.findMany({
            select: {
              issueNumber: true,
              issueTitle: true,
              issueBody: true,
              issueUrl: true,
              issueState: true,
              issueLabels: true,
              issueAuthor: true,
              issueCreatedAt: true,
              issueUpdatedAt: true,
              issueComments: true,
              issueAssignees: true,
              issueMilestone: true,
              issueReactions: true,
            },
            orderBy: { issueNumber: "asc" },
          });

          // Convert database format to GitHubIssue format
          existingIssuesForResume = dbIssues.map((issue) => ({
            id: issue.issueNumber,
            number: issue.issueNumber,
            title: issue.issueTitle,
            body: issue.issueBody || "",
            state: (issue.issueState || "open") as "open" | "closed",
            created_at: issue.issueCreatedAt?.toISOString() || new Date().toISOString(),
            updated_at: issue.issueUpdatedAt?.toISOString() || new Date().toISOString(),
            user: {
              login: issue.issueAuthor || "unknown",
              avatar_url: "",
            },
            labels: issue.issueLabels.map((name: string) => ({ name, color: "" })),
            html_url: issue.issueUrl,
            assignees: issue.issueAssignees.map((login: string) => ({ login, avatar_url: "" })),
            milestone: issue.issueMilestone ? { title: issue.issueMilestone, state: "open" } : null,
            reactions: issue.issueReactions as GitHubIssue["reactions"],
            comments: (() => {
              if (!Array.isArray(issue.issueComments)) return [];
              const validComments: GitHubComment[] = [];
              for (const c of issue.issueComments) {
                if (
                  typeof c === 'object' &&
                  c !== null &&
                  'id' in c &&
                  'body' in c &&
                  'user' in c
                ) {
                  const comment = c as Record<string, unknown>;
                  if (
                    typeof comment.id === 'number' &&
                    typeof comment.body === 'string' &&
                    typeof (comment.user as Record<string, unknown>)?.login === 'string'
                  ) {
                    const user = comment.user as Record<string, unknown>;
                    validComments.push({
                      id: comment.id,
                      body: comment.body,
                      user: {
                        login: user.login as string,
                        avatar_url: (user.avatar_url as string) || '',
                      },
                      created_at: (comment.created_at as string) || '',
                      updated_at: (comment.updated_at as string) || '',
                      html_url: (comment.html_url as string) || '',
                      reactions: comment.reactions as GitHubComment["reactions"],
                    });
                  }
                }
              }
              return validComments;
            })(),
          }));

          // Get most recent update date for incremental fetch
          if (existingIssuesForResume.length > 0) {
            const mostRecent = existingIssuesForResume
              .map(i => new Date(i.updated_at).getTime())
              .reduce((max, time) => Math.max(max, time), 0);
            sinceIssuesDate = new Date(mostRecent).toISOString();
          }

          console.error(`[Classification] Loaded ${existingIssuesForResume.length} existing issues from database`);
        } catch (dbError) {
          console.error(`[Classification] Failed to load issues from database, will use cache:`, dbError);
        }
      }

      // Fallback to cache if database not available or empty
      if (existingIssuesForResume.length === 0) {
      try {
        if (existsSync(issuesCachePath)) {
          existingIssuesCache = await loadIssuesFromCache(issuesCachePath);
            existingIssuesForResume = existingIssuesCache.issues || [];
          sinceIssuesDate = getMostRecentIssueDate(existingIssuesCache);
            console.error(`[Classification] Loaded ${existingIssuesForResume.length} existing issues from cache`);
        }
      } catch (error) {
        // Cache doesn't exist or invalid, will fetch all
        }
      }

      // Use token manager for automatic token rotation (same logic as fetch_github_issues)
      const { GitHubTokenManager } = await import("../connectors/github/tokenManager.js");
      let tokenManager = await GitHubTokenManager.fromEnvironment();
      
      // Initialize OAuth client manager (supports multiple comma-separated client IDs)
      const { OAuthClientManager } = await import("../connectors/github/oauthClientManager.js");
      const oauthClientManager = OAuthClientManager.fromEnvironment();
      
      if (!tokenManager) {
        // Try to get token via OAuth if credentials are available
        if (oauthClientManager) {
          console.error(`[Classification] No tokens found. Attempting to get token via OAuth...`);
          const { getNewTokenViaOAuth } = await import("../connectors/github/oauthFlow.js");
          
          // Try each client ID until we get a token or run out of clients
          let newToken: string | null = null;
          const allClients = oauthClientManager.getAllClients();
          let attempts = 0;
          const maxAttempts = allClients.length;
          
          while (!newToken && attempts < maxAttempts) {
            const client = oauthClientManager.getUnusedClient();
            if (!client) {
              break;
            }
            
            try {
              console.error(`[Classification] Trying OAuth client ${client.clientId.substring(0, 8)}... (attempt ${attempts + 1}/${maxAttempts})`);
              newToken = await getNewTokenViaOAuth(client.clientId, client.clientSecret);
              if (newToken) {
                // Create token manager with the new token (in memory only)
                tokenManager = new GitHubTokenManager([newToken]);
                console.error(`[Classification] Successfully obtained new token via OAuth!`);
                break;
              }
            } catch (oauthError) {
              console.error(`[Classification] OAuth flow failed: ${oauthError}`);
              attempts++;
            }
          }
        }
        
        if (!tokenManager) {
          throw new Error("GITHUB_TOKEN environment variable is required. You can provide multiple tokens separated by commas: token1,token2,token3. Or set GITHUB_OAUTH_CLIENT_ID and GITHUB_OAUTH_CLIENT_SECRET (comma-separated for multiple clients) for automatic token generation.");
        }
      }

      // Pass existing issues to skip fetching them (more efficient)
      const newIssues = await fetchAllGitHubIssues(
        tokenManager, 
        true, 
        undefined, 
        undefined, 
        sinceIssuesDate,
        undefined, // limit
        true, // includeComments
        existingIssuesForResume // Pass existing issues to skip fetching
      );

      // Merge with existing cache if doing incremental update
      let finalIssues: GitHubIssue[];
      if (existingIssuesCache && newIssues.length > 0) {
        finalIssues = mergeIssues(existingIssuesCache.issues, newIssues);
      } else if (existingIssuesCache && newIssues.length === 0) {
        finalIssues = existingIssuesCache.issues;
      } else {
        finalIssues = newIssues;
      }

      // Save updated issues cache (only if database is not configured)
      if (!useDatabase) {
        const issuesCacheData: IssuesCache = {
          fetched_at: new Date().toISOString(),
          total_count: finalIssues.length,
          open_count: finalIssues.filter((i) => i.state === "open").length,
          closed_count: finalIssues.filter((i) => i.state === "closed").length,
          issues: finalIssues,
        };

        const issuesCacheDir = join(process.cwd(), classifyConfig.paths.cacheDir);
        await mkdir(issuesCacheDir, { recursive: true });
        await writeFile(issuesCachePath, JSON.stringify(issuesCacheData, null, 2), "utf-8");
      }

      // Step 1.5: Compute missing issue embeddings before classification
      if (process.env.OPENAI_API_KEY && useDatabase) {
        try {
          console.error("[Classification] Computing missing GitHub issue embeddings...");
          const { computeAndSaveIssueEmbeddings } = await import("../storage/db/embeddings.js");
          const issueEmbeddingResult = await computeAndSaveIssueEmbeddings(process.env.OPENAI_API_KEY);
          console.error(`[Classification] Issue embeddings: ${issueEmbeddingResult.computed} computed, ${issueEmbeddingResult.cached} cached`);
        } catch (embeddingError) {
          console.error(`[Classification] Warning: Failed to compute issue embeddings (continuing anyway):`, embeddingError);
        }
      }

      // Step 2: Fetch/sync Discord messages (incremental) before classification
      const discordCacheDir = join(process.cwd(), classifyConfig.paths.cacheDir);
      const cacheFileName = `discord-messages-${actualChannelId}.json`;
      const discordCachePath = join(discordCacheDir, cacheFileName);

      const channel = await discord.channels.fetch(actualChannelId);
      if (!channel ||
          (!(channel instanceof TextChannel) &&
           !(channel instanceof DMChannel) &&
           !(channel instanceof NewsChannel))) {
        throw new Error("Channel does not support messages");
      }

      const channelName = channel instanceof TextChannel || channel instanceof NewsChannel
        ? `#${channel.name}`
        : "DM";

      const guildId = channel instanceof TextChannel || channel instanceof NewsChannel
        ? channel.guild?.id
        : undefined;

      // Ensure channel exists in database (for foreign key constraints)
      // Do this after we have the channel name and guild ID
      let sinceDiscordDate: string | undefined = undefined;
      
      // If classify_all is true, don't use incremental fetch - we want ALL messages
      // This ensures we can classify older messages that were previously skipped
      if (!classify_all) {
      try {
        await storage.upsertChannel(actualChannelId, channelName, guildId);
        
        // Check if database is available and get most recent message date from it
        if (useDatabase) {
          // Get most recent message date from database
          const { prisma } = await import("../storage/db/prisma.js");
          const mostRecent = await prisma.discordMessage.findFirst({
            where: { channelId: actualChannelId },
            orderBy: { createdAt: "desc" },
            select: { createdAt: true },
          });
          if (mostRecent) {
            sinceDiscordDate = mostRecent.createdAt.toISOString();
            console.error(`[Classification] Using database for incremental check. Most recent message: ${sinceDiscordDate}`);
          }
        }
      } catch (error) {
        console.error(`[Classification] Failed to upsert channel or check database (continuing):`, error);
      }

      // Fallback to JSON cache if database is not available
      let existingDiscordCache: DiscordCache | null = null;
      if (!useDatabase || !sinceDiscordDate) {
        try {
          const foundCachePath = await findDiscordCacheFile(actualChannelId);
          if (foundCachePath) {
            existingDiscordCache = await loadDiscordCache(foundCachePath);
            if (!sinceDiscordDate) {
              sinceDiscordDate = getMostRecentMessageDate(existingDiscordCache);
            }
            }
          } catch (error) {
            // Cache doesn't exist or invalid
          }
        }
      } else {
        // classify_all=true: Ensure channel exists but don't set sinceDiscordDate
        // This will cause all messages to be fetched, not just new ones
        try {
          await storage.upsertChannel(actualChannelId, channelName, guildId);
          console.error(`[Classification] classify_all=true: Fetching ALL messages (not using incremental fetch)`);
        } catch (error) {
          console.error(`[Classification] Failed to upsert channel (continuing):`, error);
        }
      }
      
      // Load existing cache if available (for merging, not for incremental date)
      let existingDiscordCache: DiscordCache | null = null;
      if (!useDatabase) {
        try {
          const foundCachePath = await findDiscordCacheFile(actualChannelId);
          if (foundCachePath) {
            existingDiscordCache = await loadDiscordCache(foundCachePath);
          }
        } catch (error) {
          // Cache doesn't exist or invalid
        }
      }

      // Fetch messages with pagination (incremental)
      let fetchedMessages: Message[] = [];
      let lastMessageId: string | undefined = undefined;
      let hasMore = true;

      while (hasMore) {
        const options: { limit: number; before?: string } = { limit: 100 };
        if (lastMessageId) {
          options.before = lastMessageId;
        }

        const messages = await channel.messages.fetch(options);

        if (messages.size === 0) {
          hasMore = false;
          break;
        }

        const messageArray = Array.from(messages.values());

        // If incremental, filter by date
        if (sinceDiscordDate) {
          const sinceTime = new Date(sinceDiscordDate).getTime();
          const newMessages = messageArray.filter((msg: Message) => {
            const createdTime = msg.createdAt.getTime();
            const editedTime = msg.editedAt ? msg.editedAt.getTime() : 0;
            return createdTime >= sinceTime || editedTime >= sinceTime;
          });

          if (newMessages.length === 0) {
            const newestInBatch = messageArray[0];
            const newestTime = Math.max(
              newestInBatch.createdAt.getTime(),
              newestInBatch.editedAt ? newestInBatch.editedAt.getTime() : 0
            );
            if (newestTime < sinceTime) {
              hasMore = false;
              break;
            }
          }

          fetchedMessages.push(...newMessages);
        } else {
          fetchedMessages.push(...messageArray);
        }

        lastMessageId = messageArray[messageArray.length - 1].id;

        // Rate limiting
        await new Promise((resolve) => setTimeout(resolve, 100));
      }

      // Format messages
      const formattedMessages = fetchedMessages.map((msg: Message) => {
        return {
          id: msg.id,
          author: {
            id: msg.author.id,
            username: msg.author.username,
            discriminator: msg.author.discriminator,
            bot: msg.author.bot,
            avatar: msg.author.avatar,
          },
          content: msg.content,
          created_at: msg.createdAt.toISOString(),
          edited_at: msg.editedAt ? msg.editedAt.toISOString() : null,
          timestamp: msg.createdTimestamp.toString(),
          channel_id: actualChannelId,
          channel_name: channelName,
          guild_id: guildId,
          guild_name: channel instanceof TextChannel || channel instanceof NewsChannel
            ? channel.guild?.name
            : undefined,
          attachments: Array.from(msg.attachments.values()).map((att) => ({
            id: att.id,
            filename: att.name,
            url: att.url,
            size: att.size,
            content_type: att.contentType || undefined,
          })),
          embeds: msg.embeds.length,
          mentions: Array.from(msg.mentions.users.keys()).map(id => String(id)),
          reactions: Array.from(msg.reactions.cache.values()).map((reaction) => ({
            emoji: reaction.emoji.name || reaction.emoji.id || "",
            count: reaction.count,
          })),
          thread: msg.thread ? {
            id: msg.thread.id,
            name: msg.thread.name,
          } : undefined,
          message_reference: msg.reference ? {
            message_id: msg.reference.messageId || "",
            channel_id: msg.reference.channelId || "",
            guild_id: msg.reference.guildId || undefined,
          } : undefined,
          url: msg.url,
        };
      });

      // Merge with existing cache if doing incremental update, or organize by thread
      let finalDiscordCache: DiscordCache;

      if (existingDiscordCache && formattedMessages.length > 0) {
        finalDiscordCache = mergeMessagesByThread(existingDiscordCache, formattedMessages);
      } else if (existingDiscordCache && formattedMessages.length === 0) {
        finalDiscordCache = existingDiscordCache;
      } else {
        const { threads, mainMessages } = organizeMessagesByThread(formattedMessages);
        const totalCount = formattedMessages.length;
        const dates = formattedMessages.map(m => new Date(m.created_at).getTime());
        const oldestDate = dates.length > 0 ? new Date(Math.min(...dates)).toISOString() : null;
        const newestDate = dates.length > 0 ? new Date(Math.max(...dates)).toISOString() : null;

        finalDiscordCache = {
          fetched_at: new Date().toISOString(),
          channel_id: actualChannelId,
          channel_name: channelName,
          total_count: totalCount,
          oldest_message_date: oldestDate,
          newest_message_date: newestDate,
          threads,
          main_messages: mainMessages,
        };
      }

      // Save updated Discord cache (only if database is not configured)
      if (!useDatabase) {
        await mkdir(discordCacheDir, { recursive: true });
        await writeFile(discordCachePath, JSON.stringify(finalDiscordCache, null, 2), "utf-8");
      }

      // Load classification history (from database if available, otherwise JSON)
      const resultsDir = join(process.cwd(), classifyConfig.paths.resultsDir || "results");
      const classificationHistory = await loadClassificationHistory(resultsDir, actualChannelId);

      // Use the freshly fetched Discord cache
      const allCachedMessages = getAllMessagesFromCache(finalDiscordCache);
      
      // Check database for already-classified threads (if database is available)
      let dbClassifiedThreadIds = new Set<string>();
      if (useDatabase) {
        try {
          const dbClassifiedThreads = await storage.getClassifiedThreads(actualChannelId);
          console.error(`[Classification Debug] Loaded ${dbClassifiedThreads.length} threads from database`);
          
          for (const thread of dbClassifiedThreads) {
          dbClassifiedThreadIds.add(thread.thread_id);
          // Also mark all messages in the thread as classified
          if (thread.first_message_id) {
            classificationHistory.messages[thread.first_message_id] = {
              message_id: thread.first_message_id,
              channel_id: thread.channel_id,
              issues_matched: thread.issues.map((i) => ({ issue_number: i.number, similarity_score: i.similarity_score })),
              classified_at: thread.classified_at,
            };
          }
          // Mark thread as completed in history
          if (!classificationHistory.threads) {
            classificationHistory.threads = {};
          }
          classificationHistory.threads[thread.thread_id] = {
            thread_id: thread.thread_id,
            channel_id: thread.channel_id,
            status: thread.status,
            issues_matched: thread.issues.map((i) => ({ issue_number: i.number, similarity_score: i.similarity_score })),
            classified_at: thread.classified_at,
          };
        }
          if (dbClassifiedThreads.length > 0) {
            console.error(`[Classification] Found ${dbClassifiedThreads.length} already-classified threads in database`);
            console.error(`[Classification Debug] Sample thread IDs from database: ${Array.from(dbClassifiedThreadIds).slice(0, 5).map(id => id.substring(0, 20)).join(", ")}...`);
          }
        } catch (dbError) {
          // Database not available or error, continue with JSON history only
          console.error(`[Classification] Could not load from database (continuing with JSON history):`, dbError);
        }
      } else {
        console.error(`[Classification Debug] Database not available, using JSON history only`);
      }

      // Step 2.5: Compute missing thread embeddings before classification (if using semantic classification)
      if (process.env.OPENAI_API_KEY && useDatabase) {
        try {
          console.error(`[Classification] Computing missing Discord thread embeddings for channel ${actualChannelId}...`);
          const { computeAndSaveThreadEmbeddings } = await import("../storage/db/embeddings.js");
          const threadEmbeddingResult = await computeAndSaveThreadEmbeddings(process.env.OPENAI_API_KEY, {
            channelId: actualChannelId,
          });
          console.error(`[Classification] Thread embeddings: ${threadEmbeddingResult.computed} computed, ${threadEmbeddingResult.cached} cached`);
        } catch (embeddingError) {
          console.error(`[Classification] Warning: Failed to compute thread embeddings (continuing anyway):`, embeddingError);
        }
      }

      // Check if this is first-time classification (no classified messages or threads)
      const isFirstTimeClassification = Object.keys(classificationHistory.messages).length === 0 && 
                                       (!classificationHistory.threads || Object.keys(classificationHistory.threads).length === 0);

      // DEBUG: Log initial state
      console.error(`[Classification Debug] Initial state:`);
      console.error(`  - Total cached messages: ${allCachedMessages.length}`);
      console.error(`  - Messages in classification history: ${Object.keys(classificationHistory.messages).length}`);
      console.error(`  - Threads in classification history: ${classificationHistory.threads ? Object.keys(classificationHistory.threads).length : 0}`);
      console.error(`  - Threads in database (dbClassifiedThreadIds): ${dbClassifiedThreadIds.size}`);
      console.error(`  - re_classify: ${re_classify}`);
      console.error(`  - classify_all: ${classify_all}`);
      console.error(`  - isFirstTimeClassification: ${isFirstTimeClassification}`);

      // Filter out already-classified messages if re_classify is false
      let messagesToClassify = re_classify 
        ? allCachedMessages 
        : filterUnclassifiedMessages(allCachedMessages, classificationHistory);
      
      // DEBUG: Log filtering results
      console.error(`[Classification Debug] After filtering:`);
      console.error(`  - Messages to classify: ${messagesToClassify.length}`);
      if (!re_classify && messagesToClassify.length < allCachedMessages.length) {
        console.error(`  - Filtered out ${allCachedMessages.length - messagesToClassify.length} already-classified messages`);
      }

      // Group messages by thread FIRST (before applying limits)
      // This allows us to count threads and process them in batches
      const threadGroupsMap = new Map<string, CachedDiscordMessage[]>();
      const standaloneMessagesMap = new Map<string, CachedDiscordMessage>();

      for (const msg of messagesToClassify) {
        const threadId = msg.thread?.id;
        if (threadId) {
          // Get all messages from this thread
          const threadMessages = getThreadContextForMessage(finalDiscordCache, msg);
              
              // Only add if we haven't seen this thread yet
              if (!threadGroupsMap.has(threadId)) {
                // Check if any messages in this thread were previously classified as standalone
                // and migrate their classification to this thread
                const messageIds = threadMessages.map(m => m.id);
                migrateStandaloneToThread(
                  classificationHistory,
                  threadId,
                  messageIds,
                  actualChannelId
                );

                // Filter to only include messages we haven't classified yet (unless re_classify)
                // Also skip if the thread was already classified (after migration or in database)
                // Note: "classifying" threads will be reset to "pending" later and retried
                const threadStatus = getThreadStatus(threadId, classificationHistory);
                const isThreadAlreadyClassified = !re_classify && (
                  threadStatus === "completed" || 
                  dbClassifiedThreadIds.has(threadId)
                );

                // DEBUG: Log thread-level decision
                if (isThreadAlreadyClassified) {
                  console.error(`[Classification Debug] Skipping thread ${threadId.substring(0, 20)}... (already classified)`);
                  console.error(`  - threadStatus: ${threadStatus}`);
                  console.error(`  - in dbClassifiedThreadIds: ${dbClassifiedThreadIds.has(threadId)}`);
                }

                if (!isThreadAlreadyClassified) {
                  const unclassifiedThreadMessages = re_classify
                    ? threadMessages
                    : threadMessages.filter(tmsg => !classificationHistory.messages[tmsg.id]);
                  
                  // DEBUG: Log thread inclusion
                  if (unclassifiedThreadMessages.length > 0) {
                    console.error(`[Classification Debug] Including thread ${threadId.substring(0, 20)}... with ${unclassifiedThreadMessages.length} unclassified messages`);
                    if (!re_classify && unclassifiedThreadMessages.length < threadMessages.length) {
                      console.error(`  - Filtered out ${threadMessages.length - unclassifiedThreadMessages.length} already-classified messages from thread`);
                    }
                  }
                  
                  if (unclassifiedThreadMessages.length > 0) {
                    threadGroupsMap.set(threadId, unclassifiedThreadMessages);
                  }
                }
              }
            } else {
              // Standalone message (treat as single-message thread for consistency)
              // Check if this message has already been classified (either as a message or as a thread, or in database)
              const isAlreadyClassified = !re_classify && (
                classificationHistory.messages[msg.id] || 
                getThreadStatus(msg.id, classificationHistory) === "completed" ||
                dbClassifiedThreadIds.has(msg.id)
              );
              
              // DEBUG: Log standalone message decision
              if (isAlreadyClassified) {
                console.error(`[Classification Debug] Skipping standalone message ${msg.id.substring(0, 20)}... (already classified)`);
                console.error(`  - in classificationHistory.messages: ${!!classificationHistory.messages[msg.id]}`);
                console.error(`  - thread status: ${getThreadStatus(msg.id, classificationHistory)}`);
                console.error(`  - in dbClassifiedThreadIds: ${dbClassifiedThreadIds.has(msg.id)}`);
              }
              
              if (!standaloneMessagesMap.has(msg.id) && !isAlreadyClassified) {
                console.error(`[Classification Debug] Including standalone message ${msg.id.substring(0, 20)}...`);
                standaloneMessagesMap.set(msg.id, msg);
              }
            }
          }

          // Determine how many threads to process
          const totalThreads = threadGroupsMap.size + standaloneMessagesMap.size;
          let threadsToProcess = totalThreads;

          // DEBUG: Log thread counts
          console.error(`[Classification Debug] Thread grouping results:`);
          console.error(`  - Thread groups: ${threadGroupsMap.size}`);
          console.error(`  - Standalone messages: ${standaloneMessagesMap.size}`);
          console.error(`  - Total threads to process: ${totalThreads}`);

          if (!classify_all) {
            if (isFirstTimeClassification) {
              // First time: process up to 200 threads
              threadsToProcess = Math.min(200, totalThreads);
              console.error(`[Classification Debug] First-time classification: limiting to ${threadsToProcess} threads (max 200)`);
            } else {
              // Subsequent runs: use the provided limit (limit applies to threads/messages)
              threadsToProcess = Math.min(limit, totalThreads);
              console.error(`[Classification Debug] Subsequent run: limiting to ${threadsToProcess} threads (limit: ${limit})`);
            }
          } else {
            console.error(`[Classification Debug] classify_all=true: processing all ${threadsToProcess} threads`);
          }

          // Select threads to process (oldest first for first-time, newest first for subsequent)
          const allThreadEntries = [
            ...Array.from(threadGroupsMap.entries()).map(([threadId, msgs]) => ({
              threadId,
              messages: msgs,
              timestamp: msgs[0]?.created_at || msgs[msgs.length - 1]?.created_at,
              isThread: true,
            })),
            ...Array.from(standaloneMessagesMap.entries()).map(([msgId, msg]) => ({
              threadId: msgId,
              messages: [msg],
              timestamp: msg.created_at,
              isThread: false,
            })),
          ];

          // Sort and select threads to process
          const sortedThreadEntries = isFirstTimeClassification
            ? allThreadEntries.sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime()) // Oldest first
            : allThreadEntries.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime()); // Newest first

          const selectedThreadEntries = sortedThreadEntries.slice(0, threadsToProcess);

          // Convert back to thread groups and standalone messages
          const threadGroups = new Map<string, CachedDiscordMessage[]>();
          const standaloneMessages: CachedDiscordMessage[] = [];

          for (const entry of selectedThreadEntries) {
            if (entry.isThread) {
              threadGroups.set(entry.threadId, entry.messages);
            } else {
              standaloneMessages.push(entry.messages[0]);
            }
          }

          // Get guild ID from cache
          const cacheGuildId = allCachedMessages[0]?.guild_id || "@me";

          // Convert threads to combined messages (combine all messages in thread)
          const threadCombinedMessages: DiscordMessage[] = Array.from(threadGroups.entries()).map(([threadId, threadMsgs]) => {
            // Sort thread messages by timestamp (oldest first for context)
            const sortedThreadMsgs = [...threadMsgs].sort((a, b) => 
              new Date(a.created_at).getTime() - new Date(b.created_at).getTime()
            );

            // Get thread name from first message or cache
            const firstMsg = sortedThreadMsgs[0];
            const threadName = firstMsg.thread?.name || finalDiscordCache.threads?.[threadId]?.thread_name;

            // Combine all messages in thread with author context
            const combinedContent = sortedThreadMsgs
              .map(msg => `${msg.author.username}: ${msg.content}`)
              .join('\n\n');
            
            return {
              id: firstMsg.id, // Use first message ID as identifier
              author: firstMsg.author.username,
              content: combinedContent,
              timestamp: firstMsg.created_at,
              url: firstMsg.url || `https://discord.com/channels/${cacheGuildId}/${actualChannelId}/${firstMsg.id}`,
              // Store thread info for tracking
              threadId: threadId,
              threadName: threadName,
              messageIds: sortedThreadMsgs.map(m => m.id), // Track all message IDs in thread
            } as DiscordMessage & { threadId?: string; threadName?: string; messageIds?: string[] };
          });

          // Convert standalone messages (treat as single-message threads)
          const standaloneDiscordMessages: DiscordMessage[] = standaloneMessages.map((msg) => ({
            id: msg.id,
            author: msg.author.username,
            content: msg.content,
            timestamp: msg.created_at,
            url: msg.url || `https://discord.com/channels/${guildId}/${actualChannelId}/${msg.id}`,
            // Store thread info for tracking (standalone messages are treated as single-message threads)
            threadId: msg.id, // Use message ID as thread ID for standalone messages
            threadName: `Standalone Message: ${msg.content.substring(0, 50)}...`,
            messageIds: [msg.id], // Track the single message ID
            isStandalone: true,
          } as DiscordMessage & { threadId?: string; threadName?: string; messageIds?: string[]; isStandalone?: boolean }));

      // Combine thread messages and standalone messages
      const discordMessages: DiscordMessage[] = [...threadCombinedMessages, ...standaloneDiscordMessages];

      // Load GitHub issues from the freshly fetched cache (already cached above)
      const issues = finalIssues;

      // Update thread status to "classifying" before we start
      const updatedHistory = { ...classificationHistory };
      if (!updatedHistory.threads) {
        updatedHistory.threads = {};
      }

      // Reset threads that are in "classifying" or "failed" state back to "pending" (they might have timed out or errored)
      discordMessages.forEach((msg) => {
        const threadMsg = msg as DiscordMessage & { threadId?: string; messageIds?: string[] };
        const threadId = threadMsg.threadId || msg.id;
        const currentStatus = getThreadStatus(threadId, updatedHistory);
        if (currentStatus === "classifying" || currentStatus === "failed") {
          // Reset to pending so it can be retried (timeout recovery)
          updateThreadStatus(updatedHistory, threadId, actualChannelId, "pending");
        }
      });

      // Process messages in batches to save progress incrementally
      const BATCH_SIZE = 50; // Process 50 threads/messages at a time
      const allClassified: ClassifiedMessage[] = [];
      // Use semantic classification by default when OpenAI is available (issues are always cached now)
      const useSemantic = classifyConfig.classification.useSemantic;

      let outputPath: string | undefined;
      let existingClassifiedThreads: ClassifiedThread[] = [];
      
      // Only load existing JSON files if NOT using database
      if (!useDatabase) {
        // Determine output file path BEFORE processing (so we can save incrementally)
        // Find the file with the MOST threads to merge into (not just most recent)
        const existingFiles = await readdir(resultsDir).catch(() => []);
        const matchingFiles = existingFiles
          .filter(f => f.startsWith(`discord-classified-`) && f.includes(actualChannelId) && f.endsWith('.json'));
        
        let bestFile: string | null = null;
        let maxThreads = 0;
        
        // Find file with most threads
        for (const file of matchingFiles) {
          try {
            const filePath = join(resultsDir, file);
            const content = await readFile(filePath, "utf-8");
            const parsed = safeJsonParse<ClassificationResults>(content, filePath);
            const threadCount = parsed.classified_threads?.length || 0;
            
            if (threadCount > maxThreads) {
              maxThreads = threadCount;
              bestFile = file;
            }
          } catch {
            continue;
          }
        }
        
        if (bestFile) {
          outputPath = join(resultsDir, bestFile);
          try {
            const existingContent = await readFile(outputPath, "utf-8");
            const existingData = safeJsonParse<{ classified_threads?: ClassifiedThread[] }>(existingContent, outputPath);
            existingClassifiedThreads = existingData.classified_threads || [];
            console.error(`[Classification] Will merge into existing file: ${bestFile} (${existingClassifiedThreads.length} threads)`);
          } catch {
            // If can't read, create new
            const safeChannelName = (channelName || actualChannelId).replace("#", "").replace(/[^a-z0-9]/gi, "-");
            outputPath = join(resultsDir, `discord-classified-${safeChannelName}-${actualChannelId}-${Date.now()}.json`);
          }
        } else {
          const safeChannelName = (channelName || actualChannelId).replace("#", "").replace(/[^a-z0-9]/gi, "-");
          outputPath = join(resultsDir, `discord-classified-${safeChannelName}-${actualChannelId}-${Date.now()}.json`);
          console.error(`[Classification] Creating new file: ${outputPath}`);
        }
      } else {
        // Using database - load existing threads from database instead
        try {
          const existingThreads = await storage.getClassifiedThreads(actualChannelId);
          existingClassifiedThreads = existingThreads;
          console.error(`[Classification] Loaded ${existingThreads.length} existing threads from database`);
        } catch (dbError) {
          console.error(`[Classification] Could not load from database (continuing):`, dbError);
        }
      }

      // Map to track all classified threads (existing + new)
      // threadMap stores threads with nested structure during classification
      const threadMap = new Map<string, { thread: ClassifiedThread; issues: Array<{ number: number; title: string; url: string; state: string; similarity_score: number; matched_terms?: string[]; labels?: string[]; author?: string; created_at?: string }> }>();
      for (const thread of existingClassifiedThreads) {
        const threadId = thread.thread_id;
        if (threadId) {
          // Convert flat ClassifiedThread to nested structure for threadMap
          threadMap.set(threadId, {
            thread: {
              thread_id: thread.thread_id,
              channel_id: thread.channel_id,
              thread_name: thread.thread_name,
              message_count: thread.message_count,
              first_message_id: thread.first_message_id,
              first_message_author: thread.first_message_author,
              first_message_timestamp: thread.first_message_timestamp,
              first_message_url: thread.first_message_url,
              classified_at: thread.classified_at,
              status: thread.status,
              issues: thread.issues,
            },
            issues: thread.issues,
          });
        }
      }

      // Helper to save current progress to JSON file
      // Only save to JSON if database is NOT configured
      const saveProgressToFile = async (newlyClassifiedCount: number) => {
        // Only save to JSON file if database is NOT configured
        if (useDatabase || !outputPath) {
          return; // Data is saved to database, skip JSON file
        }
        
        const mergedThreads = Array.from(threadMap.values());
        const result = {
          channel_id: actualChannelId,
          channel_name: channelName,
          analysis_date: new Date().toISOString(),
          summary: {
            total_threads_in_file: mergedThreads.length,
            total_messages_in_cache: discordMessages.length,
            newly_classified: newlyClassifiedCount,
            previously_classified: existingClassifiedThreads.length,
          },
          classified_threads: mergedThreads,
        };
        await writeFile(outputPath, JSON.stringify(result, null, 2), "utf-8");
      };

      for (let i = 0; i < discordMessages.length; i += BATCH_SIZE) {
        const batch = discordMessages.slice(i, i + BATCH_SIZE);
        const batchNum = Math.floor(i / BATCH_SIZE) + 1;
        const totalBatches = Math.ceil(discordMessages.length / BATCH_SIZE);

        console.error(`[Classification] Processing batch ${batchNum}/${totalBatches} (${batch.length} threads)...`);

        // Mark batch threads/messages as "classifying"
        batch.forEach((msg) => {
          const threadMsg = msg as DiscordMessage & { threadId?: string; messageIds?: string[] };
          const threadId = threadMsg.threadId || msg.id;
          updateThreadStatus(updatedHistory, threadId, actualChannelId, "classifying");
        });

        // Save intermediate status (classifying) - saves to DB if configured, otherwise JSON
        await saveClassificationHistory(updatedHistory, resultsDir);

        try {
          // Classify batch
          const batchClassified = await classifyMessagesWithCache(batch, issues, min_similarity, useSemantic);

          // Update classification history and thread map with batch results
          batchClassified.forEach((classifiedMsg) => {
            const msg = classifiedMsg.message as DiscordMessage & { threadId?: string; threadName?: string; messageIds?: string[] };
            
            const issuesMatched = classifiedMsg.relatedIssues.map((match) => ({
              issue_number: match.issue.number,
              similarity_score: match.similarityScore,
            }));

            const threadId = msg.threadId || classifiedMsg.message.id;
            
            // Update thread status to completed
            updateThreadStatus(
              updatedHistory,
              threadId,
              actualChannelId,
              "completed",
              issuesMatched
            );

            // Mark all messages as classified
            const messageIds = msg.messageIds || [classifiedMsg.message.id];
            messageIds.forEach(messageId => {
              addMessageClassification(
                messageId,
                actualChannelId,
                issuesMatched,
                updatedHistory
              );
            });

            // Add to thread map for JSON output
            const relatedIssues = classifiedMsg.relatedIssues.map((match) => ({
              number: match.issue.number,
              title: match.issue.title,
              state: match.issue.state,
              url: match.issue.html_url,
              similarity_score: match.similarityScore,
              matched_terms: match.matchedTerms,
              labels: match.issue.labels.map((l) => l.name),
              author: match.issue.user.login,
              created_at: match.issue.created_at,
            }));

            threadMap.set(threadId, {
              thread: {
                thread_id: threadId,
                channel_id: actualChannelId,
                thread_name: msg.threadName || undefined,
                message_count: messageIds.length,
                first_message_id: classifiedMsg.message.id,
                first_message_author: classifiedMsg.message.author,
                first_message_timestamp: classifiedMsg.message.timestamp,
                first_message_url: classifiedMsg.message.url,
                classified_at: new Date().toISOString(),
                status: "completed",
                issues: relatedIssues,
              },
              issues: relatedIssues,
            });
          });

          // Mark threads/messages that were processed but didn't get matches as completed
          batch.forEach((msg) => {
            const threadMsg = msg as DiscordMessage & { threadId?: string; threadName?: string; messageIds?: string[] };
            const threadId = threadMsg.threadId || msg.id;
            const currentStatus = getThreadStatus(threadId, updatedHistory);
            if (currentStatus === "classifying") {
              const wasClassified = batchClassified.some(
                cm => {
                  const cmMsg = cm.message as DiscordMessage & { threadId?: string };
                  return (cmMsg.threadId || cm.message.id) === threadId;
                }
              );
              if (!wasClassified) {
                updateThreadStatus(updatedHistory, threadId, actualChannelId, "completed", []);
                
                // Mark all messages as classified (even with no matches)
                // This ensures they are tracked in history.messages to prevent re-classification
                const messageIds = threadMsg.messageIds || [msg.id];
                messageIds.forEach(messageId => {
                  addMessageClassification(
                    messageId,
                    actualChannelId,
                    [], // Empty issues_matched since no matches were found
                    updatedHistory
                  );
                });
                
                // Also add to thread map with empty issues
                threadMap.set(threadId, {
                  thread: {
                    thread_id: threadId,
                    channel_id: actualChannelId,
                    thread_name: threadMsg.threadName || undefined,
                    message_count: threadMsg.messageIds?.length || 1,
                    first_message_id: msg.id,
                    first_message_author: msg.author,
                    first_message_timestamp: msg.timestamp,
                    issues: [],
                    first_message_url: msg.url,
                    classified_at: new Date().toISOString(),
                    status: "completed",
                  },
                  issues: [],
                });
              }
            }
          });

          allClassified.push(...batchClassified);

          // Save progress after each batch
          // History saves to DB if configured, otherwise JSON
          await saveClassificationHistory(updatedHistory, resultsDir);
          // JSON file only if database not configured
          await saveProgressToFile(allClassified.length);
          
          // Save to database if configured (batch write)
          if (useDatabase) {
            try {
              // Database availability already checked at the start of the case
              // Convert batch threads to ClassifiedThread format for database
                const threadsToSave: ClassifiedThread[] = [];
                
                // Add threads from this batch that were classified
                for (const classifiedMsg of batchClassified) {
              const msg = classifiedMsg.message as DiscordMessage & { threadId?: string; threadName?: string; messageIds?: string[] };
              const threadId = msg.threadId || classifiedMsg.message.id;
              const threadData = threadMap.get(threadId);
              
              if (threadData) {
                threadsToSave.push({
                  thread_id: threadId,
                  channel_id: actualChannelId,
                  thread_name: threadData.thread.thread_name,
                  message_count: threadData.thread.message_count,
                  first_message_id: threadData.thread.first_message_id,
                  first_message_author: threadData.thread.first_message_author,
                  first_message_timestamp: threadData.thread.first_message_timestamp,
                  first_message_url: threadData.thread.first_message_url,
                  classified_at: new Date().toISOString(),
                  status: "completed",
                  issues: threadData.issues.map((issue) => ({
                    number: issue.number,
                    title: issue.title,
                    state: issue.state,
                    url: issue.url,
                    similarity_score: issue.similarity_score,
                    matched_terms: issue.matched_terms,
                    labels: issue.labels,
                    author: issue.author,
                    created_at: issue.created_at,
                  })),
                });
                }
              }
              
              // Add threads from this batch that had no matches
              for (const msg of batch) {
              const threadMsg = msg as DiscordMessage & { threadId?: string; threadName?: string; messageIds?: string[] };
              const threadId = threadMsg.threadId || msg.id;
              const threadData = threadMap.get(threadId);
              
              // Only add if not already added above and has no matches
              if (threadData && threadData.issues.length === 0 && !threadsToSave.some(t => t.thread_id === threadId)) {
                // threadData may have nested thread structure (from grouper) or be flat ClassifiedThread
                interface NestedThreadData {
                  thread: {
                    thread_id: string;
                    thread_name?: string;
                    message_count?: number;
                    first_message_id?: string;
                    first_message_author?: string;
                    first_message_timestamp?: string;
                    first_message_url?: string;
                  };
                  issues: Array<{
                    number: number;
                    title: string;
                    state: string;
                    url: string;
                    similarity_score: number;
                  }>;
                }
                
                const isNested = 'thread' in threadData && threadData.thread && typeof threadData.thread === 'object';
                if (isNested) {
                  const nestedData = threadData as NestedThreadData;
                  threadsToSave.push({
                    thread_id: threadId,
                    channel_id: actualChannelId,
                    thread_name: nestedData.thread.thread_name,
                    message_count: nestedData.thread.message_count || 1,
                    first_message_id: nestedData.thread.first_message_id || msg.id,
                    first_message_author: nestedData.thread.first_message_author,
                    first_message_timestamp: nestedData.thread.first_message_timestamp,
                    first_message_url: nestedData.thread.first_message_url,
                    classified_at: new Date().toISOString(),
                    status: "completed" as const,
                    issues: [],
                  });
                } else {
                  // Type guard to ensure it's a ClassifiedThread
                  if ('thread_id' in threadData && 'channel_id' in threadData && !('thread' in threadData)) {
                    const flatData = threadData as ClassifiedThread;
                    threadsToSave.push({
                      thread_id: threadId,
                      channel_id: actualChannelId,
                      thread_name: flatData.thread_name,
                      message_count: flatData.message_count || 1,
                      first_message_id: flatData.first_message_id || msg.id,
                      first_message_author: flatData.first_message_author,
                      first_message_timestamp: flatData.first_message_timestamp,
                      first_message_url: flatData.first_message_url,
                      classified_at: new Date().toISOString(),
                      status: "completed" as const,
                      issues: [],
                    });
                  }
                }
              }
            }
            
            // Save batch to database (all in one transaction)
            if (threadsToSave.length > 0) {
              await storage.saveClassifiedThreads(threadsToSave);
              console.error(`[Classification] Saved ${threadsToSave.length} threads to database.`);
            }
            } catch (dbError) {
              // Log database error but don't fail classification
              // Don't fall back to JSON - database is configured, so we should only use DB
              console.error(`[Classification] Database save error for batch ${batchNum} (continuing):`, dbError instanceof Error ? dbError.message : String(dbError));
            }
          }
          
          console.error(`[Classification] Batch ${batchNum}/${totalBatches} complete. Saved ${threadMap.size} total threads to file.`);

        } catch (error) {
          // Mark batch threads/messages as failed if classification errored
          batch.forEach((msg) => {
            const threadMsg = msg as DiscordMessage & { threadId?: string; messageIds?: string[] };
            const threadId = threadMsg.threadId || msg.id;
            const currentStatus = getThreadStatus(threadId, updatedHistory);
            if (currentStatus === "classifying") {
              updateThreadStatus(updatedHistory, threadId, actualChannelId, "failed");
            }
          });
          // Save progress even on error
          await saveClassificationHistory(updatedHistory, resultsDir);
          await saveProgressToFile(allClassified.length);
          throw error;
        }
      }

      const classified = allClassified;

      // Final summary (file was already saved incrementally after each batch)
      const mergedThreads = Array.from(threadMap.values());

      const result = {
        channel_id: actualChannelId,
        channel_name: channelName,
        analysis_date: new Date().toISOString(),
        summary: {
          total_threads_in_file: mergedThreads.length,
          total_messages_in_cache: discordMessages.length,
          newly_classified: classified.length,
          previously_classified: existingClassifiedThreads.length,
        },
        classified_threads: mergedThreads,
      };

      // Build response message
      let message: string;
      if (useDatabase) {
        message = classified.length > 0 
          ? `Classified ${classified.length} new threads. Total: ${mergedThreads.length}. Saved to database.`
          : `No new threads to classify. Database has ${mergedThreads.length} classified threads.`;
      } else {
        message = classified.length > 0 
          ? `Classified ${classified.length} new threads. Total in file: ${mergedThreads.length}. Saved to: ${outputPath}`
          : `No new threads to classify. File has ${mergedThreads.length} classified threads. File: ${outputPath}`;
      }

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              ...result,
              ...(useDatabase ? {} : { output_file: outputPath }),
              message,
            }, null, 2),
          },
        ],
      };
    }

    case "sync_and_classify": {
      const { channel_id, classify_all = false, min_similarity = 20 } = args as {
        channel_id?: string;
        classify_all?: boolean;
        min_similarity?: number;
      };

      const config = getConfig();
      const actualChannelId = channel_id || config.discord.defaultChannelId;

      if (!actualChannelId) {
        throw new Error("Channel ID is required. Provide channel_id parameter or set DISCORD_DEFAULT_CHANNEL_ID in environment variables.");
      }

      const results: {
        steps: Array<{ 
          step: string; 
          name?: string;
          status?: string;
          success?: boolean;
          message?: string;
          result?: Record<string, unknown>;
          error?: string;
        }>;
        summary: Record<string, unknown>;
      } = {
        steps: [],
        summary: {},
      };

      try {
        // Step 1: Sync Discord messages (incremental)
        // Note: Full Discord sync requires the fetch_discord_messages tool
        // For now, we'll check if cache exists and report status
        const discordCachePath = await findDiscordCacheFile(actualChannelId);
        let discordMessageCount = 0;
        if (discordCachePath) {
          const discordCache = await loadDiscordCache(discordCachePath);
          const allMessages = getAllMessagesFromCache(discordCache);
          discordMessageCount = allMessages.length;
          results.steps.push({
            step: "sync_discord",
            name: "sync_discord",
            status: "success",
            result: {
              total_count: discordMessageCount,
              message: "Using existing cache. For full sync, run fetch_discord_messages separately.",
            },
          });
        } else {
          results.steps.push({
            step: "sync_discord",
            name: "sync_discord",
            status: "skipped",
            result: {
              message: "No cache found. Run fetch_discord_messages first to sync messages.",
            },
          });
        }

        // Step 2: Sync GitHub issues (incremental)
        const issuesCachePath = join(process.cwd(), config.paths.cacheDir, config.paths.issuesCacheFile);
        let existingIssuesCache: IssuesCache | null = null;
        let sinceDate: string | undefined = undefined;
        let existingIssuesForResume: GitHubIssue[] = [];

        // Load existing issues from database (if using database) or cache
        const { hasDatabaseConfig: hasDbConfig, getStorage: getStorageFunc } = await import("../storage/factory.js");
        const useDatabaseForIssues = hasDbConfig() && await getStorageFunc().isAvailable();
        
        if (useDatabaseForIssues) {
          try {
            const { prisma } = await import("../storage/db/prisma.js");
            const dbIssues = await prisma.gitHubIssue.findMany({
              select: {
                issueNumber: true,
                issueTitle: true,
                issueBody: true,
                issueUrl: true,
                issueState: true,
                issueLabels: true,
                issueAuthor: true,
                issueCreatedAt: true,
                issueUpdatedAt: true,
                issueComments: true,
                issueAssignees: true,
                issueMilestone: true,
                issueReactions: true,
              },
              orderBy: { issueNumber: "asc" },
            });

            // Convert database format to GitHubIssue format
            existingIssuesForResume = dbIssues.map((issue) => ({
              id: issue.issueNumber,
              number: issue.issueNumber,
              title: issue.issueTitle,
              body: issue.issueBody || "",
              state: (issue.issueState || "open") as "open" | "closed",
              created_at: issue.issueCreatedAt?.toISOString() || new Date().toISOString(),
              updated_at: issue.issueUpdatedAt?.toISOString() || new Date().toISOString(),
              user: {
                login: issue.issueAuthor || "unknown",
                avatar_url: "",
              },
              labels: issue.issueLabels.map((name: string) => ({ name, color: "" })),
              html_url: issue.issueUrl,
              assignees: issue.issueAssignees.map((login: string) => ({ login, avatar_url: "" })),
              milestone: issue.issueMilestone ? { title: issue.issueMilestone, state: "open" } : null,
              reactions: issue.issueReactions as GitHubIssue["reactions"],
              comments: (() => {
              if (!Array.isArray(issue.issueComments)) return [];
              const validComments: GitHubComment[] = [];
              for (const c of issue.issueComments) {
                if (
                  typeof c === 'object' &&
                  c !== null &&
                  'id' in c &&
                  'body' in c &&
                  'user' in c
                ) {
                  const comment = c as Record<string, unknown>;
                  if (
                    typeof comment.id === 'number' &&
                    typeof comment.body === 'string' &&
                    typeof (comment.user as Record<string, unknown>)?.login === 'string'
                  ) {
                    const user = comment.user as Record<string, unknown>;
                  validComments.push({
                    id: comment.id,
                    body: comment.body,
                    user: {
                        login: user.login as string,
                        avatar_url: (user.avatar_url as string) || '',
                      },
                      created_at: (comment.created_at as string) || '',
                      updated_at: (comment.updated_at as string) || '',
                      html_url: (comment.html_url as string) || '',
                      reactions: comment.reactions as GitHubComment["reactions"],
                    });
                  }
                }
              }
              return validComments;
            })(),
            }));

            // Get most recent update date for incremental fetch
            if (existingIssuesForResume.length > 0) {
              const mostRecent = existingIssuesForResume
                .map(i => new Date(i.updated_at).getTime())
                .reduce((max, time) => Math.max(max, time), 0);
              sinceDate = new Date(mostRecent).toISOString();
            }

            console.error(`[Sync] Loaded ${existingIssuesForResume.length} existing issues from database`);
          } catch (dbError) {
            console.error(`[Sync] Failed to load issues from database, will use cache:`, dbError);
          }
        }

        // Fallback to cache if database not available or empty
        if (existingIssuesForResume.length === 0) {
        if (existsSync(issuesCachePath)) {
          existingIssuesCache = await loadIssuesFromCache(issuesCachePath);
            existingIssuesForResume = existingIssuesCache.issues || [];
          sinceDate = getMostRecentIssueDate(existingIssuesCache);
            console.error(`[Sync] Loaded ${existingIssuesForResume.length} existing issues from cache`);
          }
        }

        // Use token manager for automatic token rotation (same logic as fetch_github_issues)
        const { GitHubTokenManager } = await import("../connectors/github/tokenManager.js");
        let tokenManager = await GitHubTokenManager.fromEnvironment();
        
        if (!tokenManager) {
          throw new Error("GITHUB_TOKEN environment variable is required. You can provide multiple tokens separated by commas: token1,token2,token3. Or set GITHUB_APP_ID and GITHUB_APP_INSTALLATION_ID for GitHub App authentication.");
        }

        // Pass existing issues to skip fetching them (more efficient)
        const newIssues = await fetchAllGitHubIssues(
          tokenManager, 
          true, 
          undefined, 
          undefined, 
          sinceDate,
          undefined, // limit
          true, // includeComments
          existingIssuesForResume // Pass existing issues to skip fetching
        );

        // Merge with existing cache
        let finalIssues: GitHubIssue[];
        if (existingIssuesCache && newIssues.length > 0) {
          finalIssues = mergeIssues(existingIssuesCache.issues, newIssues);
        } else if (existingIssuesCache && newIssues.length === 0) {
          finalIssues = existingIssuesCache.issues;
        } else {
          finalIssues = newIssues;
        }

        // Save to database if configured, otherwise save to JSON cache
        const { hasDatabaseConfig, getStorage } = await import("../storage/factory.js");
        const useDatabase = hasDatabaseConfig();

        // Create summary stats (used regardless of storage backend)
        const issuesSummary = {
          total_count: finalIssues.length,
          open_count: finalIssues.filter((i) => i.state === "open").length,
          closed_count: finalIssues.filter((i) => i.state === "closed").length,
        };

        if (useDatabase) {
          try {
            const storage = getStorage();
            const dbAvailable = await storage.isAvailable();
            if (!dbAvailable) {
              throw new Error("DATABASE_URL is set but database is not available");
            }

            const issuesToSave = finalIssues.map((issue) => ({
              number: issue.number,
              title: issue.title,
              url: issue.html_url,
              state: issue.state,
              body: issue.body || undefined,
              labels: issue.labels.map((l) => l.name),
              author: issue.user.login,
              created_at: issue.created_at,
              updated_at: issue.updated_at,
              comments: issue.comments || [],
              assignees: issue.assignees || [],
              milestone: issue.milestone || null,
              reactions: issue.reactions || null,
            }));
            await storage.saveGitHubIssues(issuesToSave);
          } catch (error) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            throw new Error(`Failed to save GitHub issues to database: ${errorMessage}`);
          }
        } else {
          // Only save to JSON if database is not configured
          const issuesCacheData: IssuesCache = {
            fetched_at: new Date().toISOString(),
            ...issuesSummary,
            issues: finalIssues,
          };

          const cacheDir = join(process.cwd(), config.paths.cacheDir);
          await mkdir(cacheDir, { recursive: true });
          await writeFile(issuesCachePath, JSON.stringify(issuesCacheData, null, 2), "utf-8");
        }

        results.steps.push({
          step: "sync_github",
          name: "sync_github",
          status: "success",
          result: {
            total: issuesSummary.total_count,
            open: issuesSummary.open_count,
            closed: issuesSummary.closed_count,
            new_updated: newIssues.length,
          },
        });

        // Step 3: Return summary with instruction to classify
        results.summary = {
          discord_messages: discordMessageCount,
          github_issues: issuesSummary.total_count,
          message: "Sync complete. Run classify_discord_messages to classify messages.",
        };

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                success: true,
                message: "GitHub issues synced successfully. Discord messages: using existing cache. Run classify_discord_messages to classify messages.",
                note: "For full Discord sync, run fetch_discord_messages separately first.",
                ...results,
              }, null, 2),
            },
          ],
        };
      } catch (error) {
        const failedStep = results.steps.length + 1;
        results.steps.push({
          step: String(failedStep),
          status: "error",
          error: error instanceof Error ? error.message : String(error),
        });

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                success: false,
                message: "Sync failed",
                error: error instanceof Error ? error.message : String(error),
                ...results,
              }, null, 2),
            },
          ],
        };
      }
    }

    case "export_to_pm_tool": {
      const { 
        use_issue_centric = true, // Default to issue-centric approach (always use DB)
        channel_id,
        include_closed,
      } = args as {
        use_issue_centric?: boolean;
        channel_id?: string;
        include_closed?: boolean;
      };

      try {
        const config = getConfig();
        
        // Check if PM integration is enabled
        if (!config.pmIntegration?.enabled) {
          throw new Error("PM integration requires PM_TOOL_TYPE to be set in environment variables (e.g., PM_TOOL_TYPE=linear).");
        }

        // Get PM tool configuration from config
        if (!config.pmIntegration.pm_tool) {
          throw new Error("PM tool configuration not found. Set PM_TOOL_TYPE and PM_TOOL_API_KEY in environment variables.");
        }

        if (!config.pmIntegration.pm_tool.type) {
          throw new Error("PM tool type is required. Set PM_TOOL_TYPE=linear or PM_TOOL_TYPE=jira in environment variables.");
        }

        if (!config.pmIntegration.pm_tool.api_key) {
          throw new Error("PM tool API key is required. Set PM_TOOL_API_KEY in environment variables.");
        }

        const resultsDir = join(process.cwd(), config.paths.resultsDir || "results");
        const actualChannelId = channel_id || config.discord.defaultChannelId;

        // Build PM tool configuration from config
        const pmToolConfig: PMToolConfig = {
          type: config.pmIntegration.pm_tool.type,
          api_key: config.pmIntegration.pm_tool.api_key,
          api_url: config.pmIntegration.pm_tool.api_url,
          team_id: config.pmIntegration.pm_tool.team_id,
        };

        // Check database availability first - we always want to use DB when available
            const { hasDatabaseConfig, getStorage } = await import("../storage/factory.js");
        const hasDb = hasDatabaseConfig();
        let dbAvailable = false;
            
        if (hasDb) {
          try {
              const storage = getStorage();
            dbAvailable = await storage.isAvailable();
          } catch {
            console.error(`[Export] Database configured but not available`);
          }
        }

        if (!dbAvailable) {
          throw new Error("Database is required for export. Please ensure DATABASE_URL is set and the database is accessible.");
        }

        let result: Awaited<ReturnType<typeof import("../export/groupingExporter.js").exportIssuesToPMTool>> | undefined;
        let sourceFile: string = "";
        
        // Always use issue-centric export from database
        if (!actualChannelId) {
          throw new Error("channel_id is required for export. Provide channel_id or set DISCORD_DEFAULT_CHANNEL_ID in environment variables.");
        }
        
        sourceFile = `database:issues:${actualChannelId}`;
        console.error(`[Export] Using issue-centric export from database (GitHub issues primary, Discord context attached)`);
        
        const { exportIssuesToPMTool } = await import("../export/groupingExporter.js");
        result = await exportIssuesToPMTool(pmToolConfig, {
          include_closed: include_closed ?? false,
          channelId: actualChannelId,
        });

        if (!result) {
          throw new Error("Export failed: No result returned from export operation");
        }

        // Save export results to database and file
        const timestamp = Date.now();
        const exportResultId = `export-${pmToolConfig.type}-${timestamp}`;
        const exportResultsPath = join(resultsDir, `export-${pmToolConfig.type}-${timestamp}.json`);
        
        const exportResultData = {
          timestamp: new Date().toISOString(),
          pm_tool: pmToolConfig.type,
          success: result.success,
          features_extracted: result.features_extracted,
          features_mapped: result.features_mapped,
          issues_exported: result.issues_exported,
          errors: result.errors,
          source_file: sourceFile,
          closed_items_count: result.closed_items_count,
          closed_items_file: result.closed_items_file,
        };
        
        // Save to file for backup
        await mkdir(resultsDir, { recursive: true });
        await writeFile(exportResultsPath, JSON.stringify(exportResultData, null, 2), "utf-8");
        
        // Always save to database (we verified it's available above)
          try {
            const storage = getStorage();
              await storage.saveExportResult({
                id: exportResultId,
                channelId: actualChannelId,
                pmTool: pmToolConfig.type,
                sourceFile: sourceFile || undefined,
                success: result.success,
                featuresExtracted: result.features_extracted,
                featuresMapped: result.features_mapped,
                issuesCreated: result.issues_exported?.created,
                issuesUpdated: result.issues_exported?.updated,
                issuesSkipped: result.issues_exported?.skipped,
                errors: result.errors,
                exportMappings: result.group_export_mappings || result.ungrouped_thread_export_mappings || result.ungrouped_issue_export_mappings
                  ? {
                      group_export_mappings: result.group_export_mappings,
                      ungrouped_thread_export_mappings: result.ungrouped_thread_export_mappings,
                      ungrouped_issue_export_mappings: result.ungrouped_issue_export_mappings,
                    }
                  : undefined,
                closedItemsCount: result.closed_items_count,
                closedItemsFile: result.closed_items_file,
              });
              console.error(`[Export] Saved export result to database: ${exportResultId}`);
          } catch (dbError) {
          // Log but don't fail if database save fails (export already succeeded)
            const errorMessage = dbError instanceof Error ? dbError.message : String(dbError);
            console.error(`[Export] Failed to save export result to database:`, errorMessage);
        }

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                success: result.success,
                features_extracted: result.features_extracted,
                features_mapped: result.features_mapped,
                issues_exported: result.issues_exported,
                errors: result.errors,
                closed_items_count: result.closed_items_count,
                closed_items_file: result.closed_items_file,
                results_saved_to: exportResultsPath,
                database_record: exportResultId,
                message: result.success
                  ? `Successfully exported to ${pmToolConfig.type}: ${result.issues_exported?.created || 0} created, ${result.issues_exported?.updated || 0} updated`
                  : `Export failed: ${result.errors?.join(", ")}`,
              }, null, 2),
            },
          ],
        };
      } catch (error) {
        logError("Export to PM tool failed:", error);
        throw new Error(`Export failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    case "list_linear_teams": {
      try {
        const config = getConfig();

        // Check if PM tool is configured as Linear
        if (!config.pmIntegration?.pm_tool) {
          throw new Error("PM tool configuration not found. Set PM_TOOL_TYPE and PM_TOOL_API_KEY in environment variables.");
        }

        if (config.pmIntegration.pm_tool.type !== "linear") {
          throw new Error(`PM tool is not Linear (current type: ${config.pmIntegration.pm_tool.type}). This tool only works with Linear.`);
        }

        if (!config.pmIntegration.pm_tool.api_key) {
          throw new Error("Linear API key is required. Set PM_TOOL_API_KEY in environment variables.");
        }

        // Build PM tool configuration
        const pmToolConfig: PMToolConfig = {
          type: "linear",
          api_key: config.pmIntegration.pm_tool.api_key,
          api_url: config.pmIntegration.pm_tool.api_url,
          team_id: config.pmIntegration.pm_tool.team_id,
        };

        // Create Linear integration and list teams
        const pmTool = createPMTool(pmToolConfig);
        const linearTool = pmTool as import("../export/base.js").LinearPMTool & { listTeams?: () => Promise<Array<{ id: string; name: string; key: string }>> };

        if (!linearTool.listTeams) {
          throw new Error("Linear integration does not support listing teams.");
        }

        const teams = await linearTool.listTeams();

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                success: true,
                teams: teams,
                count: teams.length,
                message: teams.length > 0 
                  ? `Found ${teams.length} team(s). Use the 'id' field for PM_TOOL_TEAM_ID configuration.`
                  : "No teams found in Linear workspace.",
              }, null, 2),
            },
          ],
        };
      } catch (error) {
        logError("Failed to list Linear teams:", error);
        throw new Error(`Failed to list Linear teams: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    case "validate_pm_setup": {
      try {
        const validation = validatePMSetup();

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                success: validation.valid,
                valid: validation.valid,
                errors: validation.errors,
                warnings: validation.warnings,
                info: validation.info,
                message: validation.valid
                  ? "Setup looks good. You can proceed with export."
                  : "Setup has errors. Please fix them before exporting.",
              }, null, 2),
            },
          ],
        };
      } catch (error) {
        logError("Validation failed:", error);
        throw new Error(`Validation failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    case "suggest_grouping": {
      const { 
        channel_id, 
        min_similarity = 60, 
        max_groups, 
        re_classify = false,
        semantic_only = false,
      } = args as {
        channel_id?: string;
        min_similarity?: number;
        max_groups?: number;
        re_classify?: boolean;
        semantic_only?: boolean;
      };

      try {
        const config = getConfig();
        const actualChannelId = channel_id || config.discord.defaultChannelId;

        if (!actualChannelId) {
          throw new Error("Channel ID is required. Provide channel_id parameter or set DISCORD_DEFAULT_CHANNEL_ID.");
        }

        if (!process.env.OPENAI_API_KEY) {
          throw new Error("OPENAI_API_KEY is required for grouping.");
        }

        // Initialize database connection early to ensure useDatabase is available
        const { hasDatabaseConfig, getStorage } = await import("../storage/factory.js");
        const storage = getStorage();
        // Declare useDatabase as let and assign immediately to avoid TypeScript scope issues
        let useDatabase: boolean;
        useDatabase = hasDatabaseConfig() && await storage.isAvailable();

        const resultsDir = join(process.cwd(), config.paths.resultsDir || "results");
        const history = await loadClassificationHistory(resultsDir, actualChannelId);
        const existingGroupStats = getGroupingStats(history);
        
        console.error(`[Grouping] Existing groups: ${existingGroupStats.totalGroups} (${existingGroupStats.exportedGroups} exported, ${existingGroupStats.pendingGroups} pending)`);

        // ============================================================
        // STEP 0: Compute missing embeddings before grouping
        // ============================================================
        
        if (useDatabase) {
          try {
            // Compute missing issue embeddings
            console.error("[Grouping] Computing missing GitHub issue embeddings...");
            const { computeAndSaveIssueEmbeddings } = await import("../storage/db/embeddings.js");
            const issueEmbeddingResult = await computeAndSaveIssueEmbeddings(process.env.OPENAI_API_KEY);
            console.error(`[Grouping] Issue embeddings: ${issueEmbeddingResult.computed} computed, ${issueEmbeddingResult.cached} cached`);
            
            // Compute missing thread embeddings
            console.error(`[Grouping] Computing missing Discord thread embeddings for channel ${actualChannelId}...`);
            const { computeAndSaveThreadEmbeddings } = await import("../storage/db/embeddings.js");
            const threadEmbeddingResult = await computeAndSaveThreadEmbeddings(process.env.OPENAI_API_KEY, {
              channelId: actualChannelId,
            });
            console.error(`[Grouping] Thread embeddings: ${threadEmbeddingResult.computed} computed, ${threadEmbeddingResult.cached} cached`);
          } catch (embeddingError) {
            console.error(`[Grouping] Warning: Failed to compute embeddings (continuing anyway):`, embeddingError);
          }
        }

        // ============================================================
        // STEP 1: Check for existing classification results
        // Priority: Database (if available) > JSON files (fallback)
        // ============================================================
        let classificationResults: ClassificationResults | null = null;
        
        // First, try loading from database if available
        if (!semantic_only && useDatabase) {
          try {
            console.error(`[Grouping] Loading classification results from database...`);
            const dbThreads = await storage.getClassifiedThreads(actualChannelId);
            
            if (dbThreads && dbThreads.length > 0) {
              // Convert database format to ClassificationResults format
              const convertedThreads = dbThreads.map((thread) => ({
                thread: {
                  thread_id: thread.thread_id,
                  thread_name: thread.thread_name,
                  message_count: thread.message_count || 1,
                  first_message_url: thread.first_message_url,
                  first_message_author: thread.first_message_author,
                  first_message_timestamp: thread.first_message_timestamp,
                  classified_status: thread.status,
                },
                issues: thread.issues.map((issue) => ({
                  number: issue.number,
                  title: issue.title,
                  state: issue.state,
                  url: issue.url,
                  similarity_score: issue.similarity_score,
                  labels: issue.labels || [],
                  author: issue.author,
                })),
              }));
              
              classificationResults = {
                channel_id: actualChannelId,
                classified_threads: convertedThreads,
              };
              
              console.error(`[Grouping] Loaded ${convertedThreads.length} classified threads from database`);
            }
          } catch (dbError) {
            console.error(`[Grouping] Failed to load from database:`, dbError);
          }
        }
        
        // Fallback: Load from JSON files if database not available or empty
        if (!classificationResults && !semantic_only) {
          // Find classification file for this channel - use the one with the MOST threads
          const classificationFiles = await readdir(resultsDir).catch(() => []);
          const matchingFiles = classificationFiles
            .filter(f => f.startsWith(`discord-classified-`) && f.includes(actualChannelId) && f.endsWith('.json'));
          
          // Find file with most threads
          let bestFile: string | null = null;
          let maxThreads = 0;
          
          for (const file of matchingFiles) {
            try {
              const filePath = join(resultsDir, file);
              const content = await readFile(filePath, "utf-8");
              const parsed = safeJsonParse<ClassificationResults>(content, filePath);
              const threadCount = parsed.classified_threads?.length || 0;
              
              if (threadCount > maxThreads) {
                maxThreads = threadCount;
                bestFile = file;
              }
            } catch {
              // Skip files that can't be read
              continue;
            }
          }
          
          if (bestFile) {
            const classificationPath = join(resultsDir, bestFile);
            const classificationContent = await readFile(classificationPath, "utf-8");
            const parsed = safeJsonParse<ClassificationResults>(classificationContent, classificationPath);
            
            // Only use if it has actual data
            if (parsed.classified_threads && parsed.classified_threads.length > 0) {
              classificationResults = parsed;
              console.error(`[Grouping] Found classification results: ${parsed.classified_threads.length} threads in ${bestFile}`);
            }
          }
        }

        // ============================================================
        // STEP 2: If no classification or re_classify, run classification first
        // ============================================================
        if (!classificationResults || re_classify) {
          if (semantic_only) {
            console.error(`[Grouping] semantic_only=true, skipping classification`);
          } else {
            console.error(`[Grouping] ${re_classify ? 'Re-classifying' : 'No classification found'}. Running 1-to-1 classification first...`);
            
            // If database is empty and using database, fetch messages and issues first
            // @ts-ignore - TypeScript incorrectly flags this as used before declaration
            if (useDatabase && !classificationResults) {
              console.error(`[Grouping] Database is empty. Fetching Discord messages and GitHub issues...`);
              
              // Fetch Discord messages
              try {
                const { Client, GatewayIntentBits } = await import("discord.js");
                const discordClient = new Client({
                  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent],
                });
                await discordClient.login(DISCORD_TOKEN);
                
                const channel = await discordClient.channels.fetch(actualChannelId);
                if (!channel ||
                    (!(channel instanceof TextChannel) &&
                     !(channel instanceof DMChannel) &&
                     !(channel instanceof NewsChannel))) {
                  throw new Error("Channel does not support messages");
                }
                
                console.error(`[Grouping] Fetching Discord messages from channel ${actualChannelId}...`);
                const messages = await channel.messages.fetch({ limit: 100 });
                
                // Save messages to database
                const messagesArray = Array.from(messages.values());
                const guildId = channel instanceof TextChannel || channel instanceof NewsChannel ? channel.guild.id : undefined;
                await storage.saveDiscordMessages(messagesArray.map(msg => ({
                  id: msg.id,
                  channelId: actualChannelId,
                  authorId: msg.author.id,
                  authorUsername: msg.author.username,
                  authorDiscriminator: msg.author.discriminator,
                  authorBot: msg.author.bot,
                  authorAvatar: msg.author.avatar || undefined,
                  content: msg.content,
                  createdAt: msg.createdAt.toISOString(),
                  timestamp: msg.createdTimestamp.toString(),
                  guildId: guildId,
                  threadId: msg.thread?.id,
                  threadName: msg.thread?.name,
                  url: msg.url,
                })));
                
                console.error(`[Grouping] Fetched and saved ${messagesArray.length} Discord messages to database`);
                await discordClient.destroy();
              } catch (discordError) {
                console.error(`[Grouping] Failed to fetch Discord messages:`, discordError);
                throw new Error(`Failed to fetch Discord messages: ${discordError instanceof Error ? discordError.message : String(discordError)}`);
              }
              
              // Fetch GitHub issues
              try {
                // Use token manager for automatic token rotation (same logic as fetch_github_issues)
                const { GitHubTokenManager } = await import("../connectors/github/tokenManager.js");
                let tokenManager = await GitHubTokenManager.fromEnvironment();
                
                if (!tokenManager) {
                  throw new Error("GITHUB_TOKEN environment variable is required. You can provide multiple tokens separated by commas: token1,token2,token3. Or set GITHUB_APP_ID and GITHUB_APP_INSTALLATION_ID for GitHub App authentication.");
                }
                
                console.error(`[Grouping] Fetching GitHub issues...`);
                const newIssues = await fetchAllGitHubIssues(tokenManager, true);
                
                // Save issues to database
                await storage.saveGitHubIssues(newIssues.map(issue => ({
                  number: issue.number,
                  title: issue.title,
                  url: issue.html_url,
                  state: issue.state,
                  body: issue.body || undefined,
                  labels: issue.labels.map(l => l.name),
                  author: issue.user.login,
                  created_at: issue.created_at,
                  updated_at: issue.updated_at,
                  comments: issue.comments || [],
                  assignees: issue.assignees || [],
                  milestone: issue.milestone || null,
                  reactions: issue.reactions || null,
                })));
                
                console.error(`[Grouping] Fetched and saved ${newIssues.length} GitHub issues to database`);
              } catch (issuesError) {
                console.error(`[Grouping] Failed to fetch GitHub issues:`, issuesError);
                throw new Error(`Failed to fetch GitHub issues: ${issuesError instanceof Error ? issuesError.message : String(issuesError)}`);
              }
              
              // Compute embeddings for issues and threads
              if (process.env.OPENAI_API_KEY) {
                try {
                  console.error(`[Grouping] Computing embeddings...`);
                  const { computeAndSaveIssueEmbeddings, computeAndSaveThreadEmbeddings } = await import("../storage/db/embeddings.js");
                  
                  const issueEmbeddingResult = await computeAndSaveIssueEmbeddings(process.env.OPENAI_API_KEY);
                  console.error(`[Grouping] Issue embeddings: ${issueEmbeddingResult.computed} computed, ${issueEmbeddingResult.cached} cached`);
                  
                  const threadEmbeddingResult = await computeAndSaveThreadEmbeddings(process.env.OPENAI_API_KEY, {
                    channelId: actualChannelId,
                  });
                  console.error(`[Grouping] Thread embeddings: ${threadEmbeddingResult.computed} computed, ${threadEmbeddingResult.cached} cached`);
                } catch (embeddingError) {
                  console.error(`[Grouping] Warning: Failed to compute embeddings (continuing anyway):`, embeddingError);
                }
              }
              
              // After fetching and embeddings, reload classification results from database
              try {
                const dbThreads = await storage.getClassifiedThreads(actualChannelId);
                if (dbThreads && dbThreads.length > 0) {
                  const convertedThreads = dbThreads.map((thread) => ({
                    thread: {
                      thread_id: thread.thread_id,
                      thread_name: thread.thread_name,
                      message_count: thread.message_count || 1,
                      first_message_url: thread.first_message_url,
                      first_message_author: thread.first_message_author,
                      first_message_timestamp: thread.first_message_timestamp,
                      classified_status: thread.status,
                    },
                    issues: thread.issues.map((issue) => ({
                      number: issue.number,
                      title: issue.title,
                      state: issue.state,
                      url: issue.url,
                      similarity_score: issue.similarity_score,
                      labels: issue.labels || [],
                      author: issue.author,
                    })),
                  }));
                  
                  classificationResults = {
                    channel_id: actualChannelId,
                    classified_threads: convertedThreads,
                  };
                  console.error(`[Grouping] Loaded ${convertedThreads.length} classified threads from database after classification`);
                }
              } catch (reloadError) {
                console.error(`[Grouping] Failed to reload classification results:`, reloadError);
              }
            }
            
            // Load data for classification if still needed
            let discordCache: DiscordCache | null = null;
            let issuesCache: IssuesCache | null = null;
            
            // @ts-ignore - TypeScript incorrectly flags this as used before declaration  
            if (!classificationResults && useDatabase) {
              // Load from database
              try {
                const { prisma } = await import("../storage/db/prisma.js");
                const dbMessages = await prisma.discordMessage.findMany({
                  where: { channelId: actualChannelId },
                  orderBy: { createdAt: "desc" },
                });
                
                // Group messages by thread
                const threadMap = new Map<string, Array<typeof dbMessages[0]>>();
                const mainMessages: Array<typeof dbMessages[0]> = [];
                
                for (const msg of dbMessages) {
                  if (msg.threadId) {
                    if (!threadMap.has(msg.threadId)) {
                      threadMap.set(msg.threadId, []);
                    }
                    threadMap.get(msg.threadId)!.push(msg);
                  } else {
                    mainMessages.push(msg);
                  }
                }
                
                // Build DiscordCache structure
                const allTimestamps = dbMessages.map(m => new Date(m.createdAt).getTime());
                const oldestTimestamp = allTimestamps.length > 0 ? Math.min(...allTimestamps) : null;
                const newestTimestamp = allTimestamps.length > 0 ? Math.max(...allTimestamps) : null;
                
                discordCache = {
                  fetched_at: new Date().toISOString(),
                  channel_id: actualChannelId,
                  total_count: dbMessages.length,
                  oldest_message_date: oldestTimestamp ? new Date(oldestTimestamp).toISOString() : null,
                  newest_message_date: newestTimestamp ? new Date(newestTimestamp).toISOString() : null,
                  threads: {},
                  main_messages: mainMessages.map(m => ({
                    id: m.id,
                    author: {
                      id: m.authorId,
                      username: m.authorUsername || "",
                      discriminator: m.authorDiscriminator || "",
                      bot: m.authorBot || false,
                      avatar: m.authorAvatar,
                    },
                    content: m.content,
                    created_at: m.createdAt.toISOString(),
                    edited_at: null,
                    timestamp: m.timestamp || m.createdAt.toISOString(),
                    channel_id: actualChannelId,
                    guild_id: m.guildId || undefined,
                    attachments: [],
                    embeds: 0,
                    mentions: [],
                    reactions: [],
                    url: m.url || undefined,
                  })),
                };
                
                // Add threads
                for (const [threadId, messages] of threadMap.entries()) {
                  const threadTimestamps = messages.map(m => new Date(m.createdAt).getTime());
                  const oldestThreadTime = threadTimestamps.length > 0 ? Math.min(...threadTimestamps) : null;
                  const newestThreadTime = threadTimestamps.length > 0 ? Math.max(...threadTimestamps) : null;
                  
                  discordCache.threads[threadId] = {
                    thread_id: threadId,
                    thread_name: messages[0]?.threadName || "",
                    message_count: messages.length,
                    oldest_message_date: oldestThreadTime ? new Date(oldestThreadTime).toISOString() : null,
                    newest_message_date: newestThreadTime ? new Date(newestThreadTime).toISOString() : null,
                    messages: messages.map(m => ({
                      id: m.id,
                      author: {
                        id: m.authorId,
                        username: m.authorUsername || "",
                        discriminator: m.authorDiscriminator || "",
                        bot: m.authorBot || false,
                        avatar: m.authorAvatar,
                      },
                      content: m.content,
                      created_at: m.createdAt.toISOString(),
                      edited_at: null,
                      timestamp: m.timestamp || m.createdAt.toISOString(),
                      channel_id: actualChannelId,
                      guild_id: m.guildId || undefined,
                      attachments: [],
                      embeds: 0,
                      mentions: [],
                      reactions: [],
                      url: m.url || undefined,
                    })),
                  };
                }
                
                // Load issues
                const dbIssues = await prisma.gitHubIssue.findMany({
                  orderBy: { issueNumber: "desc" },
                });
                
                const openCount = dbIssues.filter(i => i.issueState === "open").length;
                const closedCount = dbIssues.filter(i => i.issueState === "closed").length;
                
                issuesCache = {
                  fetched_at: new Date().toISOString(),
                  total_count: dbIssues.length,
                  open_count: openCount,
                  closed_count: closedCount,
                  issues: dbIssues.map(issue => ({
                    id: issue.issueNumber,
                    number: issue.issueNumber,
                    title: issue.issueTitle,
                    html_url: issue.issueUrl,
                    state: (issue.issueState || "open") as "open" | "closed",
                    body: issue.issueBody || "",
                    labels: issue.issueLabels.map((name: string) => ({ name, color: "" })),
                    user: { 
                      login: issue.issueAuthor || "",
                      avatar_url: "",
                    },
                    created_at: issue.issueCreatedAt?.toISOString() || new Date().toISOString(),
                    updated_at: issue.issueUpdatedAt?.toISOString() || new Date().toISOString(),
                  })),
                };
                
                console.error(`[Grouping] Loaded ${dbMessages.length} messages and ${dbIssues.length} issues from database`);
              } catch (dbLoadError) {
                console.error(`[Grouping] Failed to load from database, falling back to JSON cache:`, dbLoadError);
                // Fall through to JSON cache loading
              }
            }
            
            // Fallback to JSON cache if database loading failed or not using database
            if (!discordCache || !issuesCache) {
              const discordCachePath = await findDiscordCacheFile(actualChannelId);
              if (!discordCachePath) {
                throw new Error(`No Discord cache found for channel ${actualChannelId}. Run fetch_discord_messages first.`);
              }
              discordCache = await loadDiscordCache(discordCachePath);
              
              const issuesCachePath = join(process.cwd(), config.paths.cacheDir, config.paths.issuesCacheFile);
              if (!existsSync(issuesCachePath)) {
                throw new Error("No GitHub issues cache found. Run fetch_github_issues first.");
              }
              const issuesCacheContent = await readFile(issuesCachePath, "utf-8");
              issuesCache = safeJsonParse<IssuesCache>(issuesCacheContent, issuesCachePath);
            }
            
            // Organize Discord messages by thread
            const allMessages = getAllMessagesFromCache(discordCache);
            const { threads, mainMessages } = organizeMessagesByThread(allMessages);
            
            // Convert to classifier format
            const classifierMessages: DiscordMessage[] = [];
            
            // Add threads
            for (const [threadId, threadData] of Object.entries(threads)) {
              const threadMsgs = threadData.messages;
              if (!threadMsgs || threadMsgs.length === 0) continue;
              const firstMsg = threadMsgs[0];
              const combinedContent = threadMsgs.map(m => m.content).join('\n');
              
              classifierMessages.push({
                id: firstMsg.id,
                content: combinedContent,
                author: firstMsg.author.username, // Convert author object to username string
                timestamp: firstMsg.created_at,
                url: firstMsg.url,
                threadId: threadId,
                threadName: threadData.thread_name || firstMsg.thread?.name,
                messageIds: threadMsgs.map(m => m.id),
              } as DiscordMessage & { threadId?: string; threadName?: string; messageIds?: string[] });
            }
            
            // Add standalone messages
            for (const msg of mainMessages) {
              classifierMessages.push({
                id: msg.id,
                content: msg.content,
                author: msg.author.username, // Convert author object to username string
                timestamp: msg.created_at,
                url: msg.url,
              });
            }
            
            console.error(`[Grouping] Classifying ${classifierMessages.length} threads/messages...`);
            
            // Run classification
            const classified = await classifyMessagesWithCache(
              classifierMessages, 
              issuesCache.issues, 
              min_similarity, // Use same threshold for classification
              true // Use semantic
            );
            
            // Build classification results
            const classifiedThreads = classified.map((classifiedMsg) => {
              const msg = classifiedMsg.message as DiscordMessage & { threadId?: string; threadName?: string; messageIds?: string[] };
              
              return {
                thread: {
                  thread_id: msg.threadId || classifiedMsg.message.id,
                  thread_name: msg.threadName,
                  message_count: msg.messageIds?.length || 1,
                  first_message_url: classifiedMsg.message.url,
                  first_message_author: classifiedMsg.message.author,
                  first_message_timestamp: classifiedMsg.message.timestamp,
                  classified_status: "completed",
                },
                issues: classifiedMsg.relatedIssues.map((match) => ({
                  number: match.issue.number,
                  title: match.issue.title,
                  state: match.issue.state,
                  url: match.issue.html_url,
                  similarity_score: match.similarityScore,
                  labels: match.issue.labels.map((l) => l.name),
                  author: match.issue.user.login,
                })),
              };
            });
            
            classificationResults = {
              channel_id: actualChannelId,
              classified_threads: classifiedThreads,
            };
            
            // Save classification results (only to JSON if database not configured)
            const { hasDatabaseConfig } = await import("../storage/factory.js");
            const useDatabase = hasDatabaseConfig();
            
            if (!useDatabase) {
              const classificationOutputPath = join(resultsDir, `discord-classified-${actualChannelId}.json`);
              await writeFile(classificationOutputPath, JSON.stringify({
                channel_id: actualChannelId,
                channel_name: "auto-classified",
                analysis_date: new Date().toISOString(),
                summary: {
                  total_messages: classifierMessages.length,
                  classified_count: classified.length,
                  thread_count: classifiedThreads.length,
                  coverage_percentage: classifierMessages.length > 0 ? (classified.length / classifierMessages.length) * 100 : 0,
                  newly_classified: classified.length,
                },
                classified_threads: classifiedThreads,
              }, null, 2), "utf-8");
              
              console.error(`[Grouping] Classification complete: ${classifiedThreads.length} threads. Saved to ${classificationOutputPath}`);
            } else {
              // Save to database instead
              const { getStorage } = await import("../storage/factory.js");
              const storage = getStorage();
              
              // Convert to ClassifiedThread format and save
              const threadsToSave: ClassifiedThread[] = classifiedThreads.map((thread) => ({
                thread_id: thread.thread.thread_id,
                channel_id: actualChannelId,
                thread_name: thread.thread.thread_name,
                message_count: thread.thread.message_count || 1,
                first_message_id: thread.thread.first_message_url || "",
                first_message_author: thread.thread.first_message_author,
                first_message_timestamp: thread.thread.first_message_timestamp,
                first_message_url: thread.thread.first_message_url,
                classified_at: new Date().toISOString(),
                status: "completed" as const,
                issues: thread.issues || [],
              }));
              
              if (threadsToSave.length > 0) {
                await storage.saveClassifiedThreads(threadsToSave);
                console.error(`[Grouping] Classification complete: ${classifiedThreads.length} threads. Saved to database.`);
              }
            }
          }
        }

        // ============================================================
        // STEP 3: Group by classification results (issue-based) OR semantic
        // ============================================================
        
        /**
         * Generate a suggested title for a group
         * Priority: GitHub issue title (for PR auto-closing) > Thread summary > Fallback
         * The title should be specific and clear for Linear + GitHub integration
         */
        function generateGroupTitleFromThreads(threads: Array<{ thread_name?: string }>, githubIssueTitle?: string): string {
          // Priority 1: Use GitHub issue title if available (best for PR auto-closing)
          // This ensures PRs can reference the Linear issue and auto-close it
          if (githubIssueTitle && githubIssueTitle.trim().length > 0) {
            // Truncate if too long (Linear has title length limits)
            if (githubIssueTitle.length > 100) {
              return githubIssueTitle.substring(0, 97) + "...";
            }
            return githubIssueTitle;
          }
          
          // Extract all thread titles
          const threadTitles = threads
            .map(t => t.thread_name)
            .filter((name): name is string => !!name && name.trim().length > 0);
          
          if (threadTitles.length === 0) {
            return "Untitled Group";
          }
          
          // Priority 2: If only one thread, use its title (most specific)
          if (threadTitles.length === 1) {
            const title = threadTitles[0];
            return title.length > 100 ? title.substring(0, 97) + "..." : title;
          }
          
          // Priority 3: Find common keywords across threads to create a summary
          const stopWords = new Set(['the', 'a', 'an', 'and', 'or', 'but', 'in', 'on', 'at', 'to', 'for', 'of', 'with', 'by', 'is', 'are', 'was', 'were', 'be', 'been', 'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could', 'should', 'may', 'might', 'can', 'this', 'that', 'these', 'those', 'i', 'you', 'he', 'she', 'it', 'we', 'they', 'how', 'what', 'when', 'where', 'why']);
          
          // Tokenize and count word frequencies
          const wordFreq = new Map<string, number>();
          for (const title of threadTitles) {
            const words = title.toLowerCase()
              .replace(/[^\w\s]/g, ' ')
              .split(/\s+/)
              .filter(w => w.length > 2 && !stopWords.has(w));
            
            for (const word of words) {
              wordFreq.set(word, (wordFreq.get(word) || 0) + 1);
            }
          }
          
          // Get most common words (appearing in at least 2 threads or 50% of threads)
          const minOccurrences = Math.max(2, Math.ceil(threadTitles.length * 0.5));
          const commonWords = Array.from(wordFreq.entries())
            .filter(([_, count]) => count >= minOccurrences)
            .sort((a, b) => b[1] - a[1])
            .slice(0, 5)
            .map(([word]) => word);
          
          // Try to build a title from common words
          if (commonWords.length > 0) {
            // Find the shortest thread title that contains most common words
            const scoredTitles = threadTitles.map(title => {
              const titleLower = title.toLowerCase();
              const score = commonWords.filter(word => titleLower.includes(word)).length;
              return { title, score, length: title.length };
            });
            
            scoredTitles.sort((a, b) => {
              if (b.score !== a.score) return b.score - a.score;
              return a.length - b.length; // Prefer shorter titles
            });
            
            const bestTitle = scoredTitles[0].title;
            if (bestTitle.length <= 100) {
              return bestTitle;
            }
            return bestTitle.substring(0, 97) + "...";
          }
          
          // Fallback: use the shortest thread title
          const shortestTitle = threadTitles.reduce((shortest, current) => 
            current.length < shortest.length ? current : shortest
          );
          
          return shortestTitle.length > 100 ? shortestTitle.substring(0, 97) + "..." : shortestTitle;
        }
        
        interface GroupingOutputData {
          timestamp: string;
          updated_at?: string;
          channel_id: string;
          grouping_method: string;
          stats: {
            totalThreads: number;
            groupedThreads: number;
            ungroupedThreads: number;
            uniqueIssues: number;
            multiThreadGroups: number;
            singleThreadGroups: number;
            total_groups_in_file?: number;
            total_ungrouped_in_file?: number;
            newly_grouped?: number;
            newly_ungrouped?: number;
            previously_grouped?: number;
            previously_ungrouped?: number;
            cross_cutting_groups?: number;
            features_extracted?: number;
            groups_matched?: number;
            // Semantic grouping specific stats
            totalSignals?: number;
            groupedSignals?: number;
            crossCuttingGroups?: number;
            embeddingsComputed?: number;
            embeddingsFromCache?: number;
            ungrouped_count?: number;
          };
          groups: Group[];
          ungrouped_threads?: UngroupedThread[];
          features?: Array<{ id: string; name: string }>;
          options?: Record<string, unknown>;
          ungrouped_count?: number;
        }
        
        let outputData: GroupingOutputData;
        
        if (classificationResults && !semantic_only) {
          // Issue-based grouping: Group threads by matched GitHub issues
          console.error(`[Grouping] Grouping by matched GitHub issues...`);
          
          // Get features from cache or extract from documentation for Linear project mapping
          let features: Feature[] = [];
          const docUrls = config.pmIntegration?.documentation_urls;
          if (docUrls && docUrls.length > 0) {
            try {
              const { getFeaturesFromCacheOrExtract } = await import("../export/featureCache.js");
              console.error(`[Grouping] Getting features (from cache or extracting)...`);
              const extractedFeatures = await getFeaturesFromCacheOrExtract(docUrls);
              features = extractedFeatures.map(f => ({
                id: f.id,
                name: f.name,
                description: f.description,
              }));
              console.error(`[Grouping] Using ${features.length} features`);
            } catch (error) {
              console.error(`[Grouping] Failed to get features: ${error instanceof Error ? error.message : String(error)}. Continuing without feature mapping.`);
            }
          }
          
          if (features.length === 0) {
            // Default feature if no documentation
            features = [{
              id: "general",
              name: "General",
              description: "General issues and discussions",
            }];
          }
          
          // Find existing grouping file to merge with
          await mkdir(resultsDir, { recursive: true });
          const existingGroupingFiles = await readdir(resultsDir).catch(() => []);
          const existingGroupingFile = existingGroupingFiles
            .filter(f => f.startsWith(`grouping-`) && f.includes(actualChannelId) && f.endsWith('.json'))
            .sort()
            .reverse()[0];

          let outputPath: string;
          let existingGroups: Group[] = [];
          let existingUngrouped: UngroupedThread[] = [];
          let originalTimestamp: string | undefined; // Preserve original timestamp

          if (existingGroupingFile) {
            outputPath = join(resultsDir, existingGroupingFile);
            try {
              const existingContent = await readFile(outputPath, "utf-8");
              const existingData = safeJsonParse<{
                groups?: Group[];
                ungrouped_threads?: UngroupedThread[];
                timestamp?: string;
              }>(existingContent, outputPath);
              existingGroups = existingData.groups || [];
              existingUngrouped = existingData.ungrouped_threads || [];
              originalTimestamp = existingData.timestamp; // Preserve original timestamp
              console.error(`[Grouping] Merging with existing file: ${existingGroupingFile} (${existingGroups.length} groups, ${existingUngrouped.length} ungrouped)`);
            } catch {
              outputPath = join(resultsDir, `grouping-${actualChannelId}-${Date.now()}.json`);
            }
          } else {
            outputPath = join(resultsDir, `grouping-${actualChannelId}-${Date.now()}.json`);
            console.error(`[Grouping] Creating new file: ${outputPath}`);
          }
          
          // Process threads in chunks for incremental saving
          const BATCH_SIZE = 1000; // Process 1000 threads at a time
          const allThreads = classificationResults.classified_threads;
          const totalBatches = Math.ceil(allThreads.length / BATCH_SIZE);
          
          // Accumulate groups and ungrouped threads across batches
          const allGroupsMap = new Map<string, Group>(); // issue number -> group
          const allUngroupedMap = new Map<string, UngroupedThread>(); // thread_id -> ungrouped thread
          let totalProcessed = 0;
          
          // Function to save progress incrementally (only to JSON if database not configured)
          const saveProgressToFile = async (pretty = false) => {
            // Only save to JSON file if database is NOT configured
            if (useDatabase) {
              return; // Data will be saved to database at the end, skip intermediate JSON saves
            }
            
            const mergedGroups = Array.from(allGroupsMap.values());
            const mergedUngrouped = Array.from(allUngroupedMap.values());
            
            const outputData = {
              timestamp: originalTimestamp || new Date().toISOString(), // Preserve original or create new
              updated_at: new Date().toISOString(), // Always update to current time
              channel_id: actualChannelId,
              grouping_method: "issue-based",
              options: { min_similarity, max_groups },
              stats: {
                total_threads_processed: totalProcessed,
                total_groups_in_file: mergedGroups.length,
                total_ungrouped_in_file: mergedUngrouped.length,
                progress: `${totalProcessed}/${allThreads.length}`,
              },
              groups: mergedGroups,
              ungrouped_threads: mergedUngrouped,
            };
            
            // Use compact JSON during intermediate saves (faster), pretty print only at the end
            await writeFile(outputPath, JSON.stringify(outputData, null, pretty ? 2 : 0), "utf-8");
          };
          
          // Process threads in batches
          const startTime = Date.now();
          for (let batchNum = 0; batchNum < totalBatches; batchNum++) {
            const startIdx = batchNum * BATCH_SIZE;
            const endIdx = Math.min(startIdx + BATCH_SIZE, allThreads.length);
            const batch = allThreads.slice(startIdx, endIdx);
            
            const batchStartTime = Date.now();
            console.error(`[Grouping] Processing batch ${batchNum + 1}/${totalBatches} (threads ${startIdx + 1}-${endIdx} of ${allThreads.length})...`);
            
            // Create a temporary ClassificationResults for this batch
            const batchClassificationResults: ClassificationResults = {
              channel_id: actualChannelId,
              classified_threads: batch,
            };
            
            // Group this batch
            const batchGroupResult = groupByClassificationResults(batchClassificationResults, {
              minSimilarity: min_similarity,
              maxGroups: 0, // No limit per batch, we'll limit at the end
              topIssuesPerThread: 3,
            });
            
            // Merge groups: if multiple batches have threads for the same issue, merge them
            for (const group of batchGroupResult.groups) {
              const issueNumber = group.issue.number;
              const existingGroup = allGroupsMap.get(`issue-${issueNumber}`);
              
              if (existingGroup) {
                // Merge: combine threads and recalculate average similarity
                const allThreads = [...existingGroup.threads, ...group.threads];
                const avgSimilarity = allThreads.reduce((sum, t) => sum + t.similarity_score, 0) / allThreads.length;
                
                // Regenerate title from all threads
                const suggestedTitle = generateGroupTitleFromThreads(
                  allThreads,
                  existingGroup.suggested_title || group.issue.title
                );
                
                allGroupsMap.set(`issue-${issueNumber}`, {
                  ...existingGroup,
                  suggested_title: suggestedTitle,
                  threads: allThreads,
                  thread_count: allThreads.length,
                  avg_similarity: Math.round(avgSimilarity * 10) / 10,
                  updated_at: new Date().toISOString(),
                  // Clear affects_features when new threads are added so it gets re-matched to features
                  affects_features: [],
                  is_cross_cutting: false,
                });
              } else {
                // New group - generate title from thread titles
                const mappedThreads = group.threads.map(t => ({
                  thread_id: t.thread_id,
                  thread_name: t.thread_name,
                  similarity_score: Math.round(t.similarity_score * 10) / 10,
                  url: t.url,
                  author: t.author,
                }));
                
                const suggestedTitle = generateGroupTitleFromThreads(mappedThreads, group.issue.title);
                
                allGroupsMap.set(`issue-${issueNumber}`, {
                  id: group.id,
                  channel_id: actualChannelId,
                  github_issue_number: group.issue.number,
                  suggested_title: suggestedTitle,
                  avg_similarity: Math.round(group.avgSimilarity * 10) / 10,
                  thread_count: group.threads.length,
                  is_cross_cutting: false,
                  affects_features: [], // Will be populated when matched to features
                  status: "pending" as const,
                  created_at: new Date().toISOString(),
                  updated_at: new Date().toISOString(),
                  threads: mappedThreads,
                });
              }
            }
            
            // Add ungrouped threads
            for (const ungrouped of batchGroupResult.ungroupedThreads) {
              allUngroupedMap.set(ungrouped.thread_id, {
                thread_id: ungrouped.thread_id,
                channel_id: actualChannelId,
                thread_name: ungrouped.thread_name,
                url: ungrouped.url,
                author: ungrouped.author,
                timestamp: ungrouped.timestamp,
                reason: ungrouped.reason,
                top_issue: ungrouped.top_issue,
              });
            }
            
            totalProcessed = endIdx;
            
            // Save progress every 5 batches or on last batch (reduces file I/O)
            const shouldSave = (batchNum + 1) % 5 === 0 || (batchNum + 1) === totalBatches;
            const batchTime = Date.now() - batchStartTime;
            const elapsed = Date.now() - startTime;
            const avgTimePerBatch = elapsed / (batchNum + 1);
            const remainingBatches = totalBatches - (batchNum + 1);
            const estimatedRemaining = Math.round((remainingBatches * avgTimePerBatch) / 1000);
            
            if (shouldSave) {
              // Use compact JSON for intermediate saves (faster)
              await saveProgressToFile(false);
            }
            console.error(`[Grouping] Batch ${batchNum + 1}/${totalBatches} complete (${batchTime}ms). ${allGroupsMap.size} groups, ${allUngroupedMap.size} ungrouped threads.${shouldSave ? ' (saved)' : ''}${estimatedRemaining > 0 ? ` ~${estimatedRemaining}s remaining` : ''}`);
          }
          
          // Final grouping: apply maxGroups limit and sort
          let finalGroups = Array.from(allGroupsMap.values());
          
          // Sort by thread count (descending), then by similarity
          finalGroups.sort((a, b) => {
            if (b.thread_count !== a.thread_count) {
              return b.thread_count - a.thread_count;
            }
            return b.avg_similarity - a.avg_similarity;
          });
          
          // Apply maxGroups limit
          if (max_groups && max_groups > 0) {
            finalGroups = finalGroups.slice(0, max_groups);
          }
          
          const finalUngrouped = Array.from(allUngroupedMap.values());
          
          // Merge with existing groups (from file)
          const groupMap = new Map<string, Group>();
          for (const group of existingGroups) {
            // Ensure existing groups have suggested_title (backfill for old data)
            if (!group.suggested_title) {
              // Handle legacy format with github_issue nested object
              // Type guard for legacy data format (group may have extra properties from JSON)
              const groupRecord = group as unknown as Record<string, unknown>;
              const legacyIssue = groupRecord.github_issue;
              const hasLegacyTitle = (
                typeof legacyIssue === 'object' &&
                legacyIssue !== null &&
                'title' in legacyIssue &&
                typeof (legacyIssue as Record<string, unknown>).title === 'string'
              );
              if (hasLegacyTitle) {
                const issueTitle = (legacyIssue as { title: string }).title;
                // Use GitHub issue title if available, otherwise generate from threads
                group.suggested_title = generateGroupTitleFromThreads(
                  group.threads || [],
                  issueTitle
                );
              } else if (group.threads && group.threads.length > 0) {
                group.suggested_title = generateGroupTitleFromThreads(group.threads);
              } else {
                group.suggested_title = "Untitled Group";
              }
            }
            groupMap.set(group.id, group);
          }
          for (const group of finalGroups) {
            // finalGroups already contains Group objects from allGroupsMap
            // Ensure new groups have suggested_title (should already be set, but double-check)
            if (!group.suggested_title) {
              if (group.threads && group.threads.length > 0) {
                group.suggested_title = generateGroupTitleFromThreads(group.threads);
              } else {
                group.suggested_title = "Untitled Group";
              }
            }
            groupMap.set(group.id, group); // New groups overwrite existing
          }
          const mergedGroups = Array.from(groupMap.values());
          
          // Merge ungrouped threads
          const ungroupedMap = new Map<string, UngroupedThread>();
          for (const thread of existingUngrouped) {
            ungroupedMap.set(thread.thread_id, thread);
          }
          for (const thread of finalUngrouped) {
            ungroupedMap.set(thread.thread_id, thread);
          }
          const mergedUngrouped = Array.from(ungroupedMap.values());
          
          const groupResult = {
            groups: finalGroups,
            ungroupedThreads: finalUngrouped,
            stats: {
              totalThreads: allThreads.length,
              groupedThreads: allThreads.length - finalUngrouped.length,
              ungroupedThreads: finalUngrouped.length,
              uniqueIssues: allGroupsMap.size,
              multiThreadGroups: finalGroups.filter(g => g.thread_count > 1).length,
              singleThreadGroups: finalGroups.filter(g => g.thread_count === 1).length,
            },
          };
          
          // Save groups to history
          for (const group of finalGroups) {
            addGroup(history, {
              group_id: group.id,
              suggested_title: group.suggested_title,
              similarity: group.avg_similarity / 100, // Normalize to 0-1
              is_cross_cutting: group.is_cross_cutting,
              affects_features: (group.affects_features || []).map(f => typeof f === 'string' ? f : f.id),
              signal_ids: group.threads.map((t: { thread_id: string }) => `discord:${t.thread_id}`),
              github_issue: group.github_issue_number,
            });
          }
          
          await saveClassificationHistory(history, resultsDir);
          
          // Final save with merged data (mergedGroups and mergedUngrouped already computed above)
          outputData = {
            timestamp: originalTimestamp || new Date().toISOString(), // Preserve original or create new
            updated_at: new Date().toISOString(), // Always update to current time
            channel_id: actualChannelId,
            grouping_method: "issue-based",
            options: { min_similarity, max_groups },
            stats: {
              ...groupResult.stats,
              total_groups_in_file: mergedGroups.length,
              total_ungrouped_in_file: mergedUngrouped.length,
              newly_grouped: finalGroups.length,
              newly_ungrouped: finalUngrouped.length,
              previously_grouped: existingGroups.length,
              previously_ungrouped: existingUngrouped.length,
            },
            groups: mergedGroups,
            ungrouped_threads: mergedUngrouped,
          };
          
          // Save to database if DATABASE_URL is set, otherwise save to JSON file
          if (useDatabase) {
            const storage = getStorage();
            console.error(`[Grouping] Saving ${mergedGroups.length} groups and ${mergedUngrouped.length} ungrouped threads to database...`);
            await storage.saveGroups(mergedGroups);
            await storage.saveUngroupedThreads(mergedUngrouped);
            
            // Calculate and save ungrouped issues (GitHub issues not matched to any thread)
            try {
              console.error(`[Grouping] Finding ungrouped GitHub issues...`);
              const { prisma } = await import("../storage/db/prisma.js");
              
              // Get all issue numbers that have been matched to threads
              const matchedIssues = await prisma.threadIssueMatch.findMany({
                select: {
                  issueNumber: true,
                },
                distinct: ["issueNumber"],
              });
              
              const matchedIssueNumbers = new Set(matchedIssues.map(i => i.issueNumber));
              
              // Get all GitHub issues from database
              const allIssues = await prisma.gitHubIssue.findMany({
                select: {
                  issueNumber: true,
                  issueTitle: true,
                  issueUrl: true,
                  issueState: true,
                  issueBody: true,
                  issueLabels: true,
                  issueAuthor: true,
                  issueCreatedAt: true,
                },
              });
              
              // Find issues that are NOT matched to any thread
              const ungroupedIssues = allIssues.filter(issue => !matchedIssueNumbers.has(issue.issueNumber));
              
              if (ungroupedIssues.length > 0) {
                console.error(`[Grouping] Found ${ungroupedIssues.length} ungrouped GitHub issues, saving to database...`);
                
                // Save ungrouped issues to database
                for (const issue of ungroupedIssues) {
                  await prisma.ungroupedIssue.upsert({
                    where: { issueNumber: issue.issueNumber },
                    update: {
                      issueTitle: issue.issueTitle || `Issue #${issue.issueNumber}`,
                      issueUrl: issue.issueUrl || `https://github.com/issues/${issue.issueNumber}`,
                      issueState: issue.issueState || null,
                      issueBody: issue.issueBody || null,
                      issueLabels: issue.issueLabels || [],
                      issueAuthor: issue.issueAuthor || null,
                      issueCreatedAt: issue.issueCreatedAt || null,
                      affectsFeatures: [], // Will be populated when matched to features
                    },
                    create: {
                      issueNumber: issue.issueNumber,
                      issueTitle: issue.issueTitle || `Issue #${issue.issueNumber}`,
                      issueUrl: issue.issueUrl || `https://github.com/issues/${issue.issueNumber}`,
                      issueState: issue.issueState || null,
                      issueBody: issue.issueBody || null,
                      issueLabels: issue.issueLabels || [],
                      issueAuthor: issue.issueAuthor || null,
                      issueCreatedAt: issue.issueCreatedAt || null,
                      affectsFeatures: [], // Will be populated when matched to features
                    },
                  });
                }
                
                console.error(`[Grouping] Saved ${ungroupedIssues.length} ungrouped issues to database.`);
              } else {
                console.error(`[Grouping] No ungrouped issues found.`);
              }
            } catch (ungroupedIssuesError) {
              console.error(`[Grouping] Warning: Failed to calculate/save ungrouped issues:`, ungroupedIssuesError);
              // Continue even if this fails
            }
            
            console.error(`[Grouping] Successfully saved to database.`);
          } else {
            await writeFile(outputPath, JSON.stringify(outputData, null, 2), "utf-8");
          }
          
          const updatedGroupStats = getGroupingStats(history);
          
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify({
                  success: true,
                  grouping_method: "issue-based",
                  description: "Discord threads grouped by their matched GitHub issues. Threads that matched the same issue are in the same group.",
                  stats: {
                    ...groupResult.stats,
                    total_groups_in_file: mergedGroups.length,
                    total_ungrouped_in_file: mergedUngrouped.length,
                    newly_grouped: finalGroups.length,
                    newly_ungrouped: finalUngrouped.length,
                    previously_grouped: existingGroups.length,
                    previously_ungrouped: existingUngrouped.length,
                    total_groups_in_history: updatedGroupStats.totalGroups,
                    exported_groups: updatedGroupStats.exportedGroups,
                    pending_groups: updatedGroupStats.pendingGroups,
                  },
                  groups_count: mergedGroups.length,
                  ungrouped_count: mergedUngrouped.length,
                  groups: mergedGroups,
                  ungrouped_threads: mergedUngrouped,
                  output_file: outputPath,
                  message: finalGroups.length > 0 || finalUngrouped.length > 0
                    ? `Processed ${allThreads.length} threads in ${totalBatches} batches. Added ${finalGroups.length} new groups and ${finalUngrouped.length} ungrouped threads. Total: ${mergedGroups.length} groups, ${mergedUngrouped.length} ungrouped. Saved incrementally to ${outputPath}`
                    : `No new data. File has ${mergedGroups.length} groups and ${mergedUngrouped.length} ungrouped threads. File: ${outputPath}`,
                }, null, 2),
              },
            ],
          };
        } else {
          // Fallback: Pure semantic grouping (no classification results)
          console.error(`[Grouping] Using pure semantic similarity grouping...`);
          
          // Load data for semantic grouping
          const discordCachePath = await findDiscordCacheFile(actualChannelId);
          if (!discordCachePath) {
            throw new Error(`No Discord cache found for channel ${actualChannelId}. Run fetch_discord_messages first.`);
          }
          const discordCache = await loadDiscordCache(discordCachePath);
          
          const issuesCachePath = join(process.cwd(), config.paths.cacheDir, config.paths.issuesCacheFile);
          if (!existsSync(issuesCachePath)) {
            throw new Error("No GitHub issues cache found. Run fetch_github_issues first.");
          }
          const issuesCacheContent = await readFile(issuesCachePath, "utf-8");
          const issuesCache = safeJsonParse<IssuesCache>(issuesCacheContent, issuesCachePath);
          
          // Convert to Signal format
          const signals: Signal[] = [];
          
          for (const [threadId, threadData] of Object.entries(discordCache.threads || {})) {
            const messages = threadData.messages;
            if (!messages || messages.length === 0) continue;
            
            const firstMsg = messages[0];
            const lastMsg = messages[messages.length - 1];
            const allContent = messages.map(m => m.content).join("\n");
            const guildId = firstMsg.guild_id || "";
            
            signals.push({
              source: "discord",
              sourceId: threadId,
              permalink: firstMsg.url || `https://discord.com/channels/${guildId}/${actualChannelId}/${firstMsg.id}`,
              title: threadData.thread_name || firstMsg.thread?.name || undefined,
              body: allContent,
              createdAt: firstMsg.created_at,
              updatedAt: lastMsg.created_at,
              metadata: { messageCount: messages.length },
            });
          }
          
          for (const msg of discordCache.main_messages || []) {
            const guildId = msg.guild_id || "";
            signals.push({
              source: "discord",
              sourceId: msg.id,
              permalink: msg.url || `https://discord.com/channels/${guildId}/${actualChannelId}/${msg.id}`,
              title: undefined,
              body: msg.content,
              createdAt: msg.created_at,
              updatedAt: msg.edited_at || msg.created_at,
              metadata: {},
            });
          }
          
          for (const issue of issuesCache.issues) {
            signals.push({
              source: "github",
              sourceId: issue.number.toString(),
              permalink: issue.html_url,
              title: issue.title,
              body: issue.body || "",
              createdAt: issue.created_at,
              updatedAt: issue.updated_at,
              metadata: { 
                state: issue.state,
                labels: issue.labels.map(l => l.name),
              },
            });
          }
          
          // Filter already-grouped unless re_classify
          const signalsToGroup = re_classify ? signals : filterUngroupedSignals(signals, history);
          
          if (signalsToGroup.length === 0) {
            return {
              content: [
                {
                  type: "text",
                  text: JSON.stringify({
                    success: true,
                    message: "All signals are already grouped. Use re_classify=true to re-process.",
                    stats: existingGroupStats,
                    groups_count: 0,
                  }, null, 2),
                },
              ],
            };
          }
          
          // Get features from cache or extract
          let features: Feature[] = [];
          const docUrls = config.pmIntegration?.documentation_urls;
          if (docUrls && docUrls.length > 0) {
            try {
              const { getFeaturesFromCacheOrExtract } = await import("../export/featureCache.js");
              const extractedFeatures = await getFeaturesFromCacheOrExtract(docUrls);
              features = extractedFeatures.map(f => ({
                id: f.id,
                name: f.name,
                description: f.description,
              }));
            } catch (error) {
              console.error(`[Grouping] Failed to get features: ${error instanceof Error ? error.message : String(error)}. Continuing without features.`);
            }
          }
          
          if (features.length === 0) {
            features = [{
              id: "general",
              name: "General",
              description: "General issues and discussions",
            }];
          }
          
          // Run semantic grouping
          const result = await groupSignalsSemantic(signalsToGroup, features, {
            minSimilarity: min_similarity / 100, // Convert to 0-1 scale
            maxGroups: max_groups,
          });
          
          // Find existing grouping file to merge with
          await mkdir(resultsDir, { recursive: true });
          const existingSemanticFiles = await readdir(resultsDir).catch(() => []);
          const existingSemanticFile = existingSemanticFiles
            .filter(f => f.startsWith(`grouping-`) && f.includes(actualChannelId) && f.endsWith('.json'))
            .sort()
            .reverse()[0];

          let semanticOutputPath: string;
          let existingSemanticGroups: Group[] = [];

          if (existingSemanticFile) {
            semanticOutputPath = join(resultsDir, existingSemanticFile);
            try {
              const existingContent = await readFile(semanticOutputPath, "utf-8");
              const existingData = safeJsonParse<{
                groups?: Group[];
              }>(existingContent, semanticOutputPath);
              existingSemanticGroups = existingData.groups || [];
              console.error(`[Grouping] Merging with existing file: ${existingSemanticFile} (${existingSemanticGroups.length} groups)`);
            } catch {
              semanticOutputPath = join(resultsDir, `grouping-${actualChannelId}-${Date.now()}.json`);
            }
          } else {
            semanticOutputPath = join(resultsDir, `grouping-${actualChannelId}-${Date.now()}.json`);
            console.error(`[Grouping] Creating new file: ${semanticOutputPath}`);
          }
          
          // Save groups to history
          for (const group of result.groups) {
            addGroup(history, {
              group_id: group.id,
              suggested_title: group.suggestedTitle,
              similarity: group.similarity,
              is_cross_cutting: group.isCrossCutting ?? false,
              affects_features: group.affectsFeatures,
              signal_ids: group.signals.map(s => `${s.source}:${s.sourceId}`),
            });
          }
          
          await saveClassificationHistory(history, resultsDir);
          
          // Format output - convert SemanticGroup to Group format
          const formattedSemanticGroups: Group[] = result.groups.map(group => {
            // Extract Discord thread signals
            const discordThreads = group.signals.filter(s => s.source === "discord");
            
            // Convert signals to threads array
            const threads = discordThreads.map(s => {
              // Extract thread_id from sourceId (format: "discord:thread_id" or just thread_id)
              const threadId = s.sourceId.startsWith("discord:") ? s.sourceId.substring(8) : s.sourceId;
              
              return {
                thread_id: threadId,
                thread_name: s.title || undefined,
                similarity_score: Math.round(group.similarity * 100) / 100,
                url: s.permalink || undefined,
                author: undefined, // Not available from Signal
                timestamp: s.createdAt || undefined,
              };
            });
            
            // Extract GitHub issue number from canonical issue if available
            const githubIssueNumber = group.canonicalIssue?.source === "github" 
              ? parseInt(group.canonicalIssue.sourceId.match(/\d+$/)?.[0] || "0") || undefined
              : undefined;
            
            return {
              id: group.id,
              channel_id: actualChannelId,
              github_issue_number: githubIssueNumber,
              suggested_title: group.suggestedTitle,
              avg_similarity: Math.round(group.similarity * 100) / 100,
              thread_count: threads.length,
              is_cross_cutting: group.isCrossCutting ?? false,
              status: "pending" as const,
              created_at: new Date().toISOString(),
              updated_at: new Date().toISOString(),
              affects_features: group.affectsFeatures.map(fid => {
                const feature = features.find(f => f.id === fid);
                return feature ? { id: fid, name: feature.name } : { id: fid, name: fid };
              }),
              threads: threads,
            };
          });
          
          // Merge with existing groups
          const semanticGroupMap = new Map<string, Group>();
          for (const group of existingSemanticGroups) {
            semanticGroupMap.set(group.id, group);
          }
          for (const group of formattedSemanticGroups) {
            semanticGroupMap.set(group.id, group);
          }
          const mergedSemanticGroups = Array.from(semanticGroupMap.values());
          
          outputData = {
            timestamp: new Date().toISOString(),
            updated_at: new Date().toISOString(),
            channel_id: actualChannelId,
            grouping_method: "semantic",
            options: { min_similarity, max_groups },
            stats: {
              totalThreads: result.stats.totalSignals,
              groupedThreads: result.stats.groupedSignals,
              ungroupedThreads: result.ungroupedSignals.length,
              uniqueIssues: 0,
              multiThreadGroups: mergedSemanticGroups.filter(g => g.thread_count > 1).length,
              singleThreadGroups: mergedSemanticGroups.filter(g => g.thread_count === 1).length,
              total_groups_in_file: mergedSemanticGroups.length,
              newly_grouped: formattedSemanticGroups.length,
              previously_grouped: existingSemanticGroups.length,
              cross_cutting_groups: result.stats.crossCuttingGroups,
              totalSignals: result.stats.totalSignals,
              groupedSignals: result.stats.groupedSignals,
              crossCuttingGroups: result.stats.crossCuttingGroups,
              embeddingsComputed: result.stats.embeddingsComputed,
              embeddingsFromCache: result.stats.embeddingsFromCache,
            },
            features: features.map(f => ({ id: f.id, name: f.name })),
            groups: mergedSemanticGroups,
            ungrouped_count: result.ungroupedSignals.length,
          };
          
          // Save to database if DATABASE_URL is set, otherwise save to JSON file
          if (useDatabase) {
            const storage = getStorage();
            console.error(`[Grouping] Saving ${mergedSemanticGroups.length} semantic groups to database...`);
            await storage.saveGroups(mergedSemanticGroups);
            console.error(`[Grouping] Successfully saved semantic groups to database.`);
          } else {
            await writeFile(semanticOutputPath, JSON.stringify(outputData, null, 2), "utf-8");
          }
          
          const updatedGroupStats = getGroupingStats(history);
          
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify({
                  success: true,
                  grouping_method: "semantic",
                  description: "Signals grouped by semantic similarity. Use without semantic_only=true to get issue-based grouping.",
                  stats: {
                    ...result.stats,
                    total_groups_in_file: mergedSemanticGroups.length,
                    newly_grouped: formattedSemanticGroups.length,
                    previously_grouped: existingSemanticGroups.length,
                    total_groups_in_history: updatedGroupStats.totalGroups,
                    exported_groups: updatedGroupStats.exportedGroups,
                    pending_groups: updatedGroupStats.pendingGroups,
                  },
                  groups_count: mergedSemanticGroups.length,
                  cross_cutting_count: mergedSemanticGroups.filter((g) => g.is_cross_cutting ?? false).length,
                  features_used: features.map(f => f.name),
                  groups: mergedSemanticGroups,
                  output_file: semanticOutputPath,
                  message: formattedSemanticGroups.length > 0
                    ? `Added ${formattedSemanticGroups.length} new groups. Total in file: ${mergedSemanticGroups.length}. Saved to ${semanticOutputPath}`
                    : `No new groups. File has ${mergedSemanticGroups.length} groups. File: ${semanticOutputPath}`,
                }, null, 2),
              },
            ],
          };
        }
      } catch (error) {
        logError("Grouping failed:", error);
        throw new Error(`Grouping failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    case "group_github_issues": {
      const {
        channel_id,
        include_closed = false,
        min_similarity = 80,
        force = false,
      } = args as {
        channel_id?: string;
        include_closed?: boolean;
        min_similarity?: number;
        force?: boolean;
      };

      try {
        const config = getConfig();
        const actualChannelId = channel_id || config.discord.defaultChannelId;

        if (!actualChannelId) {
          throw new Error("Channel ID is required. Provide channel_id parameter or set DISCORD_DEFAULT_CHANNEL_ID.");
        }

        if (!process.env.OPENAI_API_KEY) {
          throw new Error("OPENAI_API_KEY is required for issue grouping.");
        }

        // Verify database is available
        const { hasDatabaseConfig, getStorage } = await import("../storage/factory.js");
        if (!hasDatabaseConfig()) {
          throw new Error("Database is required for issue grouping. Please configure DATABASE_URL.");
        }
        
        const storage = getStorage();
        const dbAvailable = await storage.isAvailable();
        if (!dbAvailable) {
          throw new Error("Database is not available. Please check your DATABASE_URL configuration.");
        }

        const { prisma } = await import("../storage/db/prisma.js");

        // STEP 1: Get all GitHub issues from database
        console.error(`[GroupIssues] Loading GitHub issues from database...`);
        const allIssues = await prisma.gitHubIssue.findMany({
          where: include_closed ? {} : { issueState: "open" },
          orderBy: { issueNumber: 'desc' },
        });
        console.error(`[GroupIssues] Found ${allIssues.length} GitHub issues (${include_closed ? 'including closed' : 'open only'})`);

        if (allIssues.length === 0) {
          return {
            content: [{
              type: "text",
              text: JSON.stringify({
                success: true,
                message: "No GitHub issues found in database. Run fetch_github_issues first.",
                stats: { total_issues: 0, groups: 0, ungrouped: 0 },
              }, null, 2),
            }],
          };
        }

        // STEP 2: Compute/load issue embeddings from database
        console.error(`[GroupIssues] Computing GitHub issue embeddings...`);
        const { computeAndSaveIssueEmbeddings } = await import("../storage/db/embeddings.js");
        // Parameters: apiKey, onProgress callback (undefined), force flag
        const embeddingResult = await computeAndSaveIssueEmbeddings(process.env.OPENAI_API_KEY, undefined, force);
        console.error(`[GroupIssues] GitHub issue embeddings: ${embeddingResult.computed} computed, ${embeddingResult.cached} cached, ${embeddingResult.total} total`);

        // STEP 3: Load all issue embeddings for grouping
        const issueEmbeddings = await prisma.issueEmbedding.findMany({
          where: {
            issueNumber: { in: allIssues.map(i => i.issueNumber) },
          },
        });
        console.error(`[GroupIssues] Loaded ${issueEmbeddings.length} embeddings`);

        // Create embedding map
        const embeddingMap = new Map<number, number[]>();
        for (const emb of issueEmbeddings) {
          embeddingMap.set(emb.issueNumber, emb.embedding as number[]);
        }

        // STEP 4: Group issues by similarity using embeddings
        console.error(`[GroupIssues] Grouping issues by similarity (threshold: ${min_similarity}%)...`);
        
        // Cosine similarity function
        const cosineSimilarity = (a: number[], b: number[]): number => {
          let dotProduct = 0;
          let normA = 0;
          let normB = 0;
          for (let i = 0; i < a.length; i++) {
            dotProduct += a[i] * b[i];
            normA += a[i] * a[i];
            normB += b[i] * b[i];
          }
          return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
        };

        // Group issues using Union-Find approach
        const parent = new Map<number, number>();
        const rank = new Map<number, number>();
        
        const find = (x: number): number => {
          if (!parent.has(x)) {
            parent.set(x, x);
            rank.set(x, 0);
          }
          if (parent.get(x) !== x) {
            parent.set(x, find(parent.get(x)!));
          }
          return parent.get(x)!;
        };
        
        const union = (x: number, y: number): void => {
          const px = find(x);
          const py = find(y);
          if (px === py) return;
          
          const rx = rank.get(px) || 0;
          const ry = rank.get(py) || 0;
          
          if (rx < ry) {
            parent.set(px, py);
          } else if (rx > ry) {
            parent.set(py, px);
          } else {
            parent.set(py, px);
            rank.set(px, rx + 1);
          }
        };

        // Compare all pairs of issues
        const threshold = min_similarity / 100;
        const issuesWithEmbeddings = allIssues.filter(i => embeddingMap.has(i.issueNumber));
        
        for (let i = 0; i < issuesWithEmbeddings.length; i++) {
          for (let j = i + 1; j < issuesWithEmbeddings.length; j++) {
            const embA = embeddingMap.get(issuesWithEmbeddings[i].issueNumber)!;
            const embB = embeddingMap.get(issuesWithEmbeddings[j].issueNumber)!;
            const similarity = cosineSimilarity(embA, embB);
            
            if (similarity >= threshold) {
              union(issuesWithEmbeddings[i].issueNumber, issuesWithEmbeddings[j].issueNumber);
            }
          }
        }

        // Build groups from Union-Find
        const groupMap = new Map<number, number[]>();
        for (const issue of allIssues) {
          const root = find(issue.issueNumber);
          if (!groupMap.has(root)) {
            groupMap.set(root, []);
          }
          groupMap.get(root)!.push(issue.issueNumber);
        }

        // Separate single-issue "groups" (ungrouped) from multi-issue groups
        const groups: Array<{ id: string; issues: number[]; title: string }> = [];
        const ungroupedIssues: number[] = [];
        
        for (const [root, issueNumbers] of groupMap) {
          if (issueNumbers.length > 1) {
            // Multi-issue group
            const groupIssues = allIssues.filter(i => issueNumbers.includes(i.issueNumber));
            const title = groupIssues[0]?.issueTitle || `Group ${root}`;
            groups.push({
              id: `issue-group-${root}`,
              issues: issueNumbers,
              title,
            });
          } else {
            // Single issue - ungrouped
            ungroupedIssues.push(issueNumbers[0]);
          }
        }

        console.error(`[GroupIssues] Created ${groups.length} groups, ${ungroupedIssues.length} ungrouped issues`);

        // STEP 5: Match Discord threads to issues using embeddings
        console.error(`[GroupIssues] Matching Discord threads to issues using embeddings...`);
        
        // First, compute thread embeddings if needed
        console.error(`[GroupIssues] Computing Discord thread embeddings...`);
        const { computeAndSaveThreadEmbeddings } = await import("../storage/db/embeddings.js");
        const threadEmbeddingResult = await computeAndSaveThreadEmbeddings(process.env.OPENAI_API_KEY, {
          channelId: actualChannelId,
        });
        console.error(`[GroupIssues] Thread embeddings: ${threadEmbeddingResult.computed} computed, ${threadEmbeddingResult.cached} cached`);

        // Load all thread embeddings
        const threadEmbeddings = await prisma.threadEmbedding.findMany({
          include: {
            thread: true,
          },
        });
        console.error(`[GroupIssues] Loaded ${threadEmbeddings.length} thread embeddings`);

        // Create thread embedding map
        const threadEmbeddingMap = new Map<string, { embedding: number[]; threadName: string | null }>();
        for (const emb of threadEmbeddings) {
          threadEmbeddingMap.set(emb.threadId, {
            embedding: emb.embedding as number[],
            threadName: emb.thread.threadName,
          });
        }

        // Match threads to issues using cosine similarity
        const threadMatchThreshold = min_similarity / 100; // Use same threshold
        const issueThreadsMap = new Map<number, Array<{ threadId: string; threadName: string | null; similarity: number }>>();
        const newMatches: Array<{ threadId: string; issueNumber: number; similarity: number; issueTitle: string; issueUrl: string }> = [];

        for (const [threadId, threadData] of threadEmbeddingMap) {
          for (const issue of allIssues) {
            const issueEmb = embeddingMap.get(issue.issueNumber);
            if (!issueEmb) continue;

            const similarity = cosineSimilarity(threadData.embedding, issueEmb);
            
            if (similarity >= threadMatchThreshold) {
              // Add to map
              if (!issueThreadsMap.has(issue.issueNumber)) {
                issueThreadsMap.set(issue.issueNumber, []);
              }
              issueThreadsMap.get(issue.issueNumber)!.push({
                threadId,
                threadName: threadData.threadName,
                similarity: similarity * 100, // Convert to percentage
              });

              // Track for database save
              newMatches.push({
                threadId,
                issueNumber: issue.issueNumber,
                similarity: similarity * 100,
                issueTitle: issue.issueTitle,
                issueUrl: issue.issueUrl,
              });
            }
          }
        }

        console.error(`[GroupIssues] Found ${newMatches.length} thread-issue matches using embeddings`);

        // Save matches to issue_thread_matches table (issue-centered)
        if (newMatches.length > 0) {
          console.error(`[GroupIssues] Saving issue-thread matches to database...`);
          
          // Get thread details for message counts and timestamps
          const threadIds = [...new Set(newMatches.map(m => m.threadId))];
          const threadDetails = await prisma.classifiedThread.findMany({
            where: { threadId: { in: threadIds } },
            select: {
              threadId: true,
              threadName: true,
              firstMessageUrl: true,
              messageCount: true,
              firstMessageTimestamp: true,
            },
          });
          const threadDetailMap = new Map(threadDetails.map(t => [t.threadId, t]));

          for (const match of newMatches) {
            const threadDetail = threadDetailMap.get(match.threadId);
            try {
              await prisma.issueThreadMatch.upsert({
                where: {
                  issueNumber_threadId: {
                    issueNumber: match.issueNumber,
                    threadId: match.threadId,
                  },
                },
                create: {
                  issueNumber: match.issueNumber,
                  threadId: match.threadId,
                  threadName: threadDetail?.threadName || null,
                  threadUrl: threadDetail?.firstMessageUrl || null,
                  similarityScore: match.similarity,
                  matchMethod: "embedding",
                  messageCount: threadDetail?.messageCount || 0,
                  firstMessageAt: threadDetail?.firstMessageTimestamp || null,
                },
                update: {
                  similarityScore: match.similarity,
                  threadName: threadDetail?.threadName || null,
                  messageCount: threadDetail?.messageCount || 0,
                },
              });
            } catch (matchError) {
              console.error(`[GroupIssues] Error saving match for issue ${match.issueNumber} -> thread ${match.threadId}:`, matchError);
            }
          }
          
          // Update issues to mark them as matched to threads
          const matchedIssueNumbers = [...new Set(newMatches.map(m => m.issueNumber))];
          await prisma.gitHubIssue.updateMany({
            where: { issueNumber: { in: matchedIssueNumbers } },
            data: { matchedToThreads: true },
          });
          
          console.error(`[GroupIssues] Saved ${newMatches.length} issue-thread matches`);
        }

        // STEP 6: Save groups to database
        console.error(`[GroupIssues] Saving groups to database...`);
        
        // Ensure channel exists
        await prisma.channel.upsert({
          where: { id: actualChannelId },
          create: { id: actualChannelId },
          update: {},
        });

        // Clear existing groups if force=true
        if (force) {
          await prisma.groupThread.deleteMany({
            where: { group: { channelId: actualChannelId } },
          });
          await prisma.group.deleteMany({
            where: { channelId: actualChannelId },
          });
          console.error(`[GroupIssues] Cleared existing groups`);
        }

        // Save groups
        for (const group of groups) {
          // Collect all threads for all issues in this group
          const groupThreads: Array<{ threadId: string; similarity: number }> = [];
          for (const issueNum of group.issues) {
            const threads = issueThreadsMap.get(issueNum) || [];
            for (const t of threads) {
              if (!groupThreads.find(gt => gt.threadId === t.threadId)) {
                groupThreads.push({ threadId: t.threadId, similarity: t.similarity });
              }
            }
          }

          const avgSimilarity = groupThreads.length > 0
            ? groupThreads.reduce((sum, t) => sum + t.similarity, 0) / groupThreads.length
            : 0;

          await prisma.group.upsert({
            where: { id: group.id },
            create: {
              id: group.id,
              channelId: actualChannelId,
              suggestedTitle: group.title,
              githubIssueNumber: group.issues[0], // Primary issue
              avgSimilarity,
              threadCount: groupThreads.length,
              isCrossCutting: false,
              status: "pending",
              affectsFeatures: [],
            },
            update: {
              suggestedTitle: group.title,
              githubIssueNumber: group.issues[0],
              avgSimilarity,
              threadCount: groupThreads.length,
            },
          });

          // Update issues to mark them as grouped
          await prisma.gitHubIssue.updateMany({
            where: { issueNumber: { in: group.issues } },
            data: { inGroup: true, groupId: group.id },
          });
        }

        // Mark ungrouped issues
        await prisma.gitHubIssue.updateMany({
          where: { issueNumber: { in: ungroupedIssues } },
          data: { inGroup: false, groupId: null },
        });

        console.error(`[GroupIssues] Saved ${groups.length} groups to database`);

        // Build response with details
        const groupDetails = groups.map(g => {
          const groupIssues = allIssues.filter(i => g.issues.includes(i.issueNumber));
          const threadCount = g.issues.reduce((sum, num) => sum + (issueThreadsMap.get(num)?.length || 0), 0);
          return {
            id: g.id,
            title: g.title,
            issue_count: g.issues.length,
            issues: g.issues.map(num => {
              const issue = groupIssues.find(i => i.issueNumber === num);
              return {
                number: num,
                title: issue?.issueTitle,
                state: issue?.issueState,
              };
            }),
            discord_thread_count: threadCount,
          };
        });

        const ungroupedDetails = ungroupedIssues.slice(0, 20).map(num => {
          const issue = allIssues.find(i => i.issueNumber === num);
          const threads = issueThreadsMap.get(num) || [];
          return {
            issue_number: num,
            title: issue?.issueTitle,
            state: issue?.issueState,
            discord_thread_count: threads.length,
          };
        });

        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              success: true,
              message: `Grouped ${allIssues.length} GitHub issues: ${groups.length} groups, ${ungroupedIssues.length} ungrouped`,
              stats: {
                total_issues: allIssues.length,
                groups: groups.length,
                ungrouped: ungroupedIssues.length,
                total_issues_in_groups: groups.reduce((sum, g) => sum + g.issues.length, 0),
                discord_threads_matched: newMatches.length,
              },
              groups: groupDetails,
              ungrouped_sample: ungroupedDetails,
              ungrouped_count: ungroupedIssues.length,
            }, null, 2),
          }],
        };

      } catch (error) {
        logError("Group GitHub issues failed:", error);
        throw new Error(`Grouping failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    case "match_groups_to_features": {
      try {
        const { 
          grouping_data_path,
          channel_id,
          min_similarity = 0.6,
          force = false,
        } = args as {
          grouping_data_path?: string;
          channel_id?: string;
          min_similarity?: number;
          force?: boolean;
        };

        const config = getConfig();
        const resultsDir = join(process.cwd(), config.paths.resultsDir || "results");
        
        // Determine channel ID
        const actualChannelId = grouping_data_path 
          ? undefined // Will be determined from file if provided
          : (channel_id || config.discord.defaultChannelId);
        
        if (!grouping_data_path && !actualChannelId) {
          throw new Error("Either grouping_data_path or channel_id must be provided");
        }

        // Try to load grouping data from database first (if available), then fall back to JSON file
        let groupingData: {
          timestamp: string;
          updated_at?: string;
          channel_id: string;
          grouping_method: string;
          stats: {
            totalThreads: number;
            groupedThreads: number;
            ungroupedThreads: number;
            uniqueIssues: number;
            multiThreadGroups: number;
            singleThreadGroups: number;
            cross_cutting_groups?: number;
            features_extracted?: number;
            groups_matched?: number;
            total_groups_in_file?: number;
            total_ungrouped_in_file?: number;
            newly_grouped?: number;
            newly_ungrouped?: number;
            previously_grouped?: number;
            previously_ungrouped?: number;
            totalSignals?: number;
            groupedSignals?: number;
            crossCuttingGroups?: number;
            embeddingsComputed?: number;
            embeddingsFromCache?: number;
            ungrouped_count?: number;
            ungrouped_threads_matched?: number;
            ungrouped_issues_matched?: number;
          };
          groups: Group[];
          ungrouped_threads?: Array<UngroupedThread & { channel_id?: string }>;
          features?: Array<{ id: string; name: string }>;
        } | null = null;

        let groupingPath: string | null = null;
        let useDatabaseForStorage = false;

        // First, try loading from database if available and channel_id is known
        if (!grouping_data_path && actualChannelId) {
          try {
            const { hasDatabaseConfig, getStorage } = await import("../storage/factory.js");
            const useDatabase = hasDatabaseConfig() && await getStorage().isAvailable();
            
            if (useDatabase) {
              const storage = getStorage();
              const groups = await storage.getGroups(actualChannelId);
              const ungroupedThreads = await storage.getUngroupedThreads(actualChannelId);
              
              if (groups.length > 0 || ungroupedThreads.length > 0) {
                // Look up GitHub issue details (including state) for groups that have issue numbers
                const issueNumbers = groups.map(g => g.github_issue_number).filter((num): num is number => !!num);
                const issuesMap = new Map<number, { number: number; title: string; url: string; state: string; labels?: string[] }>();
                
                if (issueNumbers.length > 0) {
                  const { prisma } = await import("../storage/db/prisma.js");
                  const issues = await prisma.gitHubIssue.findMany({
                    where: {
                      issueNumber: { in: issueNumbers },
                    },
                    select: {
                      issueNumber: true,
                      issueTitle: true,
                      issueUrl: true,
                      issueState: true,
                      issueLabels: true,
                    },
                  });
                  
                  for (const issue of issues) {
                    issuesMap.set(issue.issueNumber, {
                      number: issue.issueNumber,
                      title: issue.issueTitle,
                      url: issue.issueUrl,
                      state: issue.issueState || "open", // Default to "open" if state is null
                      labels: issue.issueLabels,
                    });
                  }
                }
                
                // Convert database format to grouping file format (with github_issue object including state)
                type GroupWithIssue = Omit<Group, 'github_issue_number'> & {
                  github_issue?: { number: number; title: string; url: string; state: string; labels?: string[] };
                };
                const groupsWithIssueDetails: GroupWithIssue[] = groups.map(group => {
                  const { github_issue_number, ...rest } = group;
                  return {
                    ...rest,
                    github_issue: github_issue_number && issuesMap.has(github_issue_number)
                      ? issuesMap.get(github_issue_number)
                      : undefined,
                  };
                });
                
                groupingData = {
                  timestamp: new Date().toISOString(),
                  updated_at: new Date().toISOString(),
                  channel_id: actualChannelId,
                  grouping_method: "issue-based",
                  stats: {
                    totalThreads: groups.reduce((sum, g) => sum + g.thread_count, 0) + ungroupedThreads.length,
                    groupedThreads: groups.reduce((sum, g) => sum + g.thread_count, 0),
                    ungroupedThreads: ungroupedThreads.length,
                    uniqueIssues: new Set(groups.map(g => g.github_issue_number).filter(Boolean)).size,
                    multiThreadGroups: groups.filter(g => g.thread_count > 1).length,
                    singleThreadGroups: groups.filter(g => g.thread_count === 1).length,
                    total_groups_in_file: groups.length,
                    total_ungrouped_in_file: ungroupedThreads.length,
                  },
                  groups: groupsWithIssueDetails,
                  ungrouped_threads: ungroupedThreads,
                };
                useDatabaseForStorage = true;
              }
            }
          } catch (dbError) {
            // Fall through to JSON file loading
            console.error(`[Feature Matching] Failed to load from database, falling back to JSON:`, dbError);
          }
        }

        // Fall back to JSON file if database didn't have data or grouping_data_path was provided
        if (!groupingData) {
        if (grouping_data_path) {
          groupingPath = grouping_data_path;
        } else {
          if (!actualChannelId) {
            throw new Error("Either grouping_data_path or channel_id must be provided");
          }
          
          const existingGroupingFiles = await readdir(resultsDir).catch(() => []);
          const existingGroupingFile = existingGroupingFiles
            .filter(f => f.startsWith(`grouping-`) && f.includes(actualChannelId) && f.endsWith('.json'))
            .sort()
            .reverse()[0];
          
          if (!existingGroupingFile) {
            throw new Error(`No grouping file found for channel ${actualChannelId}. Run suggest_grouping first.`);
          }
          
          groupingPath = join(resultsDir, existingGroupingFile);
        }

          // Load grouping data from JSON file
        const groupingContent = await readFile(groupingPath, "utf-8");
          groupingData = safeJsonParse<{
          timestamp: string;
          updated_at?: string;
          channel_id: string;
          grouping_method: string;
          stats: {
            totalThreads: number;
            groupedThreads: number;
            ungroupedThreads: number;
            uniqueIssues: number;
            multiThreadGroups: number;
            singleThreadGroups: number;
            cross_cutting_groups?: number;
            features_extracted?: number;
            groups_matched?: number;
            total_groups_in_file?: number;
            total_ungrouped_in_file?: number;
            newly_grouped?: number;
            newly_ungrouped?: number;
            previously_grouped?: number;
            previously_ungrouped?: number;
            totalSignals?: number;
            groupedSignals?: number;
            crossCuttingGroups?: number;
            embeddingsComputed?: number;
            embeddingsFromCache?: number;
            ungrouped_count?: number;
            ungrouped_threads_matched?: number;
          };
          groups: Group[];
          ungrouped_threads?: Array<UngroupedThread & { channel_id?: string }>;
          features?: Array<{ id: string; name: string }>;
        }>(groupingContent, groupingPath);
        }

        // Get features from cache or extract from documentation
        const docUrls = config.pmIntegration?.documentation_urls;
        if (!docUrls || docUrls.length === 0) {
          throw new Error("No documentation URLs configured. Set DOCUMENTATION_URLS in config.");
        }

        const { getFeaturesFromCacheOrExtract } = await import("../export/featureCache.js");
        console.error(`[Feature Matching] Extracting features from ${docUrls.length} documentation URL(s)...`);
        const extractedFeatures = await getFeaturesFromCacheOrExtract(docUrls);
        const features = extractedFeatures.map(f => ({
          id: f.id,
          name: f.name,
          description: f.description,
          related_keywords: f.related_keywords || [],
        }));

        console.error(`[Feature Matching] Extracted ${features.length} features from documentation`);
        if (features.length > 0) {
          console.error(`[Feature Matching] Sample features: ${features.slice(0, 5).map(f => f.name).join(", ")}${features.length > 5 ? "..." : ""}`);
        }

        // Compute feature embeddings if needed (before mapping groups to features)
        // This ensures embeddings are available for semantic similarity matching
        if (process.env.OPENAI_API_KEY) {
          try {
            const { hasDatabaseConfig, getStorage } = await import("../storage/factory.js");
            const useDatabase = hasDatabaseConfig() && await getStorage().isAvailable();
            
            if (useDatabase) {
              // Features are already saved to database by getFeaturesFromCacheOrExtract
              // Now compute embeddings for any features that don't have them yet
              const { computeAndSaveFeatureEmbeddings } = await import("../storage/db/embeddings.js");
              console.error(`[Feature Matching] Computing feature embeddings if needed...`);
              const embeddingResult = await computeAndSaveFeatureEmbeddings(process.env.OPENAI_API_KEY);
              console.error(`[Feature Matching] Feature embeddings ready: ${embeddingResult.computed} computed, ${embeddingResult.cached} cached, ${embeddingResult.total} total`);
              
              // Ensure code is indexed for features (checks hashes and skips if unchanged)
              // This ensures code embeddings are available for matching groups to features
              const repositoryUrl = config.pmIntegration?.github_repo_url;
              const localRepoPath = config.pmIntegration?.local_repo_path;
              
              if (repositoryUrl || localRepoPath) {
                try {
                  // First check if code is already indexed for this repository
                  const { prisma } = await import("../storage/db/prisma.js");
                  const repoIdentifier = localRepoPath || repositoryUrl || "";
                  const existingCodeSearch = await prisma.codeSearch.findFirst({
                    where: {
                      repositoryUrl: repoIdentifier,
                    },
                    include: {
                      codeFiles: {
                        include: {
                          codeSections: {
                            include: {
                              featureMappings: true,
                            },
                          },
                        },
                      },
                    },
                    orderBy: {
                      updatedAt: "desc",
                    },
                  });
                  
                  if (existingCodeSearch && existingCodeSearch.codeFiles.length > 0) {
                    console.error(`[Feature Matching] Code already indexed for repository (${existingCodeSearch.codeFiles.length} files, ${existingCodeSearch.codeFiles.reduce((sum, f) => sum + f.codeSections.length, 0)} sections) - skipping indexing`);
                  } else {
                    // Code not indexed yet - index it
                    const { indexCodeForAllFeatures } = await import("../storage/db/codeIndexer.js");
                    console.error(`[Feature Matching] Code not yet indexed - indexing code for features (will check hashes and skip unchanged files)...`);
                    const codeIndexResult = await indexCodeForAllFeatures(
                      repositoryUrl || undefined,
                      false, // force=false: only index if needed, check hashes to skip unchanged code
                      undefined, // no progress callback
                      localRepoPath,
                      100, // chunk size
                      null // maxFiles: process all files
                    );
                    console.error(`[Feature Matching] Code indexing: ${codeIndexResult.indexed} indexed, ${codeIndexResult.matched} matched, ${codeIndexResult.total} total features`);
                  }
                } catch (codeIndexError) {
                  // If code indexing fails, continue anyway - matchTextToFeaturesUsingCode will index on-demand
                  console.error(`[Feature Matching] Warning: Failed to check/index code for features (will index on-demand):`, codeIndexError);
                }
              } else {
                console.error(`[Feature Matching] No repository configured - code indexing will be skipped (code matching will be limited)`);
              }
            } else {
              console.error(`[Feature Matching] Database not available - feature embeddings and code indexing will be computed on-demand`);
            }
          } catch (embeddingError) {
            // If embedding computation fails, continue anyway - featureMapper will compute on-demand
            console.error(`[Feature Matching] Warning: Failed to pre-compute feature embeddings (will compute on-demand):`, embeddingError);
          }
        }

        // Debug: Check groups before mapping
        console.error(`[DEBUG] Before mapping: ${groupingData.groups.length} groups`);
        const sampleBefore = groupingData.groups[0];
        if (sampleBefore) {
          console.error(`[DEBUG] Sample group before: id=${sampleBefore.id}, has affects_features=${!!sampleBefore.affects_features}, value=${JSON.stringify(sampleBefore.affects_features)}`);
        }
        
        // Map groups to features and save incrementally (in batches)
        // This ensures progress is saved even if the process fails partway through
        // By default, skip groups that already have affects_features set (resume mode)
        const { mapGroupsToFeatures, mapUngroupedThreadsToFeatures, mapUngroupedIssuesToFeatures } = await import("../export/featureMapper.js");
        const { hasDatabaseConfig: hasDbConfig, getStorage: getStorageFn } = await import("../storage/factory.js");
        const useDatabaseForIncrementalSaving = useDatabaseForStorage || (hasDbConfig() && await getStorageFn().isAvailable());
        
        // Separate groups into already-matched and unmatched
        const alreadyMatchedGroups: Group[] = [];
        const unmatchedGroups: Group[] = [];
        
        for (const group of groupingData.groups) {
          // Check if group already has affects_features set (and it's not just "general")
          const hasValidMatch = group.affects_features && 
            group.affects_features.length > 0 && 
            !(group.affects_features.length === 1 && group.affects_features[0]?.id === "general");
          
          if (!force && hasValidMatch) {
            // Group already matched, preserve it
            alreadyMatchedGroups.push(group);
          } else {
            // Group needs matching (either unmatched or force=true)
            unmatchedGroups.push(group);
          }
        }
        
        console.error(`[Feature Matching] Found ${alreadyMatchedGroups.length} already-matched groups, ${unmatchedGroups.length} groups to match`);
        console.error(`[Feature Matching] Mapping ${unmatchedGroups.length} groups to ${features.length} features (min_similarity=${min_similarity}, saving incrementally)...`);
        if (unmatchedGroups.length === 0) {
          console.error(`[Feature Matching] No groups to match - all groups already have feature matches. Use force=true to re-match.`);
        }
        
        // Process unmatched groups in batches, match each batch, then save immediately
        const BATCH_SIZE = 50; // Process 50 groups at a time
        const allGroupsWithFeatures: Group[] = [];
        let totalMatched = 0;
        let totalSaved = 0;
        
        for (let i = 0; i < unmatchedGroups.length; i += BATCH_SIZE) {
          const batch = unmatchedGroups.slice(i, i + BATCH_SIZE);
          const batchNumber = Math.floor(i / BATCH_SIZE) + 1;
          const totalBatches = Math.ceil(unmatchedGroups.length / BATCH_SIZE);
          
          console.error(`[Feature Matching] Processing batch ${batchNumber}/${totalBatches} (${batch.length} groups)...`);
          
          // Match this batch to features
          const batchWithFeatures = await mapGroupsToFeatures(batch, features, min_similarity) as Group[];
          allGroupsWithFeatures.push(...batchWithFeatures);
          totalMatched += batchWithFeatures.length;
          
          // Save this batch immediately if database is available
          if (useDatabaseForIncrementalSaving && batchWithFeatures.length > 0) {
            try {
              console.error(`[Feature Matching] Saving batch ${batchNumber} (${batchWithFeatures.length} groups) to database...`);
              const storage = getStorageFn();
              await storage.saveGroups(batchWithFeatures);
              totalSaved += batchWithFeatures.length;
              console.error(`[Feature Matching] Successfully saved batch ${batchNumber} (${totalSaved}/${totalMatched} groups saved so far)`);
            } catch (batchSaveError) {
              console.error(`[Feature Matching] ERROR: Failed to save batch ${batchNumber}: ${batchSaveError instanceof Error ? batchSaveError.message : String(batchSaveError)}`);
              // Continue processing other batches even if one fails
            }
          }
        }
        
        // Merge already-matched groups with newly matched groups
        const groupsWithFeatures = [...alreadyMatchedGroups, ...allGroupsWithFeatures];
        
        // Debug: Check what was matched
        console.error(`[DEBUG] After mapping: ${groupsWithFeatures.length} groups returned, ${totalSaved} saved to database`);
        const groupsMatchedToSpecificFeatures = groupsWithFeatures.filter(g => 
          g.affects_features && 
          g.affects_features.length > 0 && 
          !(g.affects_features.length === 1 && g.affects_features[0]?.id === "general")
        );
        console.error(`[DEBUG] Groups matched to specific features (not General): ${groupsMatchedToSpecificFeatures.length} out of ${groupsWithFeatures.length}`);
        
        const sampleGroup = groupsWithFeatures[0];
        if (sampleGroup) {
          console.error(`[DEBUG] Sample group ${sampleGroup.id}: affects_features=${JSON.stringify(sampleGroup.affects_features)}, is_cross_cutting=${sampleGroup.is_cross_cutting}`);
        }
        
        // Check if all groups matched to General
        const allGeneral = groupsWithFeatures.every(g => 
          g.affects_features && 
          g.affects_features.length === 1 && 
          g.affects_features[0]?.id === "general"
        );
        if (allGeneral && groupsWithFeatures.length > 0) {
          console.error(`[DEBUG] WARNING: ALL ${groupsWithFeatures.length} groups matched to General! This suggests:`);
          console.error(`[DEBUG]   - Similarity threshold (${min_similarity}) may be too high`);
          console.error(`[DEBUG]   - Feature embeddings may not be computed`);
          console.error(`[DEBUG]   - Group embeddings may not be computed`);
          console.error(`[DEBUG]   - Try lowering min_similarity or checking embeddings`);
        }
        
        // Log summary statistics
        const summaryCrossCuttingCount = groupsWithFeatures.filter(g => g.is_cross_cutting).length;
        console.error(`[Feature Matching] Summary: ${groupsMatchedToSpecificFeatures.length} matched to specific features, ${summaryCrossCuttingCount} cross-cutting groups`);

        // Map ungrouped threads to features (skip already-matched unless force=true)
        if (groupingData.ungrouped_threads && groupingData.ungrouped_threads.length > 0) {
          // Separate already-matched and unmatched threads
          const alreadyMatchedThreads: typeof groupingData.ungrouped_threads = [];
          const unmatchedThreads: typeof groupingData.ungrouped_threads = [];
          
          for (const thread of groupingData.ungrouped_threads) {
            const hasValidMatch = thread.affects_features && 
              thread.affects_features.length > 0 && 
              !(thread.affects_features.length === 1 && thread.affects_features[0]?.id === "general");
            
            if (!force && hasValidMatch) {
              alreadyMatchedThreads.push(thread);
            } else {
              unmatchedThreads.push(thread);
            }
          }
          
          console.error(`[Feature Matching] Found ${alreadyMatchedThreads.length} already-matched ungrouped threads, ${unmatchedThreads.length} threads to match`);
          
          if (unmatchedThreads.length > 0) {
            // Ensure channel_id is preserved for ungrouped threads
            const ungroupedThreadsWithChannelId = unmatchedThreads.map(t => ({
              ...t,
              channel_id: t.channel_id || groupingData.channel_id,
            }));
            const ungroupedThreadsWithFeatures = await mapUngroupedThreadsToFeatures(
              ungroupedThreadsWithChannelId,
              features,
              min_similarity
            );
            // Preserve channel_id in the result and merge with already-matched
            groupingData.ungrouped_threads = [
              ...alreadyMatchedThreads,
              ...ungroupedThreadsWithFeatures.map(t => ({
                ...t,
                channel_id: t.channel_id || groupingData.channel_id,
              }))
            ] as UngroupedThread[];
          } else {
            // All threads already matched, keep them as-is
            groupingData.ungrouped_threads = alreadyMatchedThreads;
          }
        }

        // Map ungrouped issues to features (if using database, skip already-matched unless force=true)
        let ungroupedIssuesMatched = 0;
        const useDatabase = hasDbConfig() && await getStorageFn().isAvailable();
        
        if (useDatabase) {
          try {
            const { prisma } = await import("../storage/db/prisma.js");
            // Load ungrouped issues from database
            const ungroupedIssues = await prisma.ungroupedIssue.findMany({
              select: {
                issueNumber: true,
                issueTitle: true,
                issueUrl: true,
                issueState: true,
                issueBody: true,
                issueLabels: true,
                issueAuthor: true,
                affectsFeatures: true,
              },
            });

            if (ungroupedIssues.length > 0) {
              // Separate already-matched and unmatched issues
              const alreadyMatchedIssues: typeof ungroupedIssues = [];
              const unmatchedIssues: typeof ungroupedIssues = [];
              
              for (const issue of ungroupedIssues) {
                const affectsFeatures = issue.affectsFeatures as Array<{ id: string; name: string }> | null;
                const hasValidMatch = affectsFeatures && 
                  affectsFeatures.length > 0 && 
                  !(affectsFeatures.length === 1 && affectsFeatures[0]?.id === "general");
                
                if (!force && hasValidMatch) {
                  alreadyMatchedIssues.push(issue);
                } else {
                  unmatchedIssues.push(issue);
                }
              }
              
              console.error(`[Feature Matching] Found ${alreadyMatchedIssues.length} already-matched ungrouped issues, ${unmatchedIssues.length} issues to match`);
              
              if (unmatchedIssues.length > 0) {
                // Convert to format expected by mapUngroupedIssuesToFeatures
                const issuesToMatch = unmatchedIssues.map(issue => ({
                  issue_number: issue.issueNumber,
                  issue_title: issue.issueTitle,
                  issue_url: issue.issueUrl || undefined,
                  issue_state: issue.issueState || undefined,
                  issue_body: issue.issueBody || undefined,
                  issue_labels: issue.issueLabels || undefined,
                  issue_author: issue.issueAuthor || undefined,
                }));

                // Map to features
                const ungroupedIssuesWithFeatures = await mapUngroupedIssuesToFeatures(
                  issuesToMatch,
                  features,
                  min_similarity
                );

                // Save back to database with affects_features
                for (const issue of ungroupedIssuesWithFeatures) {
                  await prisma.ungroupedIssue.update({
                    where: { issueNumber: issue.issue_number },
                    data: {
                      affectsFeatures: issue.affects_features ? JSON.parse(JSON.stringify(issue.affects_features)) : [],
                    },
                  });
                }

                ungroupedIssuesMatched = ungroupedIssuesWithFeatures.length;
                // Log removed to avoid interfering with MCP JSON protocol
                // console.error(`[Feature Matching] Matched ${ungroupedIssuesMatched} ungrouped issues to features`);
              } else {
                // All issues already matched
                ungroupedIssuesMatched = alreadyMatchedIssues.length;
              }
            }
          } catch (ungroupedIssuesError) {
            // Log but don't fail - ungrouped issues matching is optional
            console.error(`[Feature Matching] Warning: Failed to match ungrouped issues to features:`, ungroupedIssuesError);
          }
        }

        // Update grouping data  
        groupingData.groups = groupsWithFeatures;
        groupingData.features = features.map(f => ({ id: f.id, name: f.name }));
        
        // Groups are already saved incrementally above, but we still need to:
        // 1. Save ungrouped threads if using database
        // 2. Save to JSON file as backup if needed
        
        // Update timestamp fields - preserve original timestamp, update updated_at
        if (!groupingData.timestamp) {
          groupingData.timestamp = new Date().toISOString();
        }
        groupingData.updated_at = new Date().toISOString();
        
        // Update stats
        const crossCuttingCount = groupsWithFeatures.filter(g => g.is_cross_cutting).length;
        const ungroupedThreadsMatched = groupingData.ungrouped_threads?.filter(t => 
          t.affects_features && t.affects_features.length > 0 && 
          !(t.affects_features.length === 1 && t.affects_features[0].id === "general")
        ).length || 0;
        groupingData.stats = {
          ...groupingData.stats,
          cross_cutting_groups: crossCuttingCount,
          features_extracted: features.length,
          groups_matched: groupsWithFeatures.length,
          ungrouped_threads_matched: ungroupedThreadsMatched,
          ungrouped_issues_matched: ungroupedIssuesMatched,
        };

        // Save ungrouped threads and JSON backup (groups already saved incrementally)
        const useDatabaseForSaving = useDatabaseForStorage || (hasDbConfig() && await getStorageFn().isAvailable());
        
        if (useDatabaseForSaving) {
          // Save ungrouped threads (groups were already saved incrementally above)
          if (groupingData.ungrouped_threads && groupingData.ungrouped_threads.length > 0) {
            try {
              console.error(`[Feature Matching] Saving ${groupingData.ungrouped_threads.length} ungrouped threads to database...`);
              const storage = getStorageFn();
              await storage.saveUngroupedThreads(groupingData.ungrouped_threads);
              console.error(`[Feature Matching] Saved ungrouped threads to database successfully`);
            } catch (threadsSaveError) {
              console.error(`[Feature Matching] ERROR: Failed to save ungrouped threads: ${threadsSaveError instanceof Error ? threadsSaveError.message : String(threadsSaveError)}`);
            }
          }
          
          // Also save to JSON file as backup if groupingPath exists (optional)
          if (groupingPath && !useDatabaseForStorage) {
            console.error(`[Feature Matching] Also saving to JSON file as backup: ${groupingPath}`);
            try {
              await writeFile(groupingPath, JSON.stringify(groupingData, null, 2), "utf-8");
              console.error(`[Feature Matching] Saved to JSON file as backup`);
            } catch (jsonError) {
              console.error(`[Feature Matching] WARNING: Failed to save JSON backup: ${jsonError instanceof Error ? jsonError.message : String(jsonError)}`);
            }
          }
        } else if (groupingPath) {
          // Save to JSON file (fallback if no database)
          console.error(`[Feature Matching] Saving to JSON file (no database available): ${groupingPath}`);
          try {
            await writeFile(groupingPath, JSON.stringify(groupingData, null, 2), "utf-8");
            console.error(`[Feature Matching] Saved to JSON file successfully`);
          } catch (jsonError) {
            console.error(`[Feature Matching] ERROR: Failed to save to JSON file: ${jsonError instanceof Error ? jsonError.message : String(jsonError)}`);
            throw jsonError;
          }
        } else {
          console.error(`[Feature Matching] WARNING: No storage method available! useDatabaseForStorage=${useDatabaseForStorage}, useDatabaseForSaving=${useDatabaseForSaving}, groupingPath=${groupingPath}`);
        }
        console.error(`[Feature Matching] Updated grouping data with feature matches`);

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                success: true,
                message: `Matched ${groupsWithFeatures.length} groups, ${ungroupedThreadsMatched} ungrouped threads, and ${ungroupedIssuesMatched} ungrouped issues to ${features.length} features`,
                stats: {
                  total_groups: groupsWithFeatures.length,
                  cross_cutting_groups: crossCuttingCount,
                  features_extracted: features.length,
                  groups_matched: groupsWithFeatures.length,
                  ungrouped_threads_matched: ungroupedThreadsMatched,
                  ungrouped_issues_matched: ungroupedIssuesMatched,
                  total_ungrouped_threads: groupingData.ungrouped_threads?.length || 0,
                },
                features: features.map(f => ({ id: f.id, name: f.name })),
                output_file: useDatabaseForStorage ? "database" : groupingPath,
              }, null, 2),
            },
          ],
        };
      } catch (error) {
        logError("Feature matching failed:", error);
        throw new Error(`Feature matching failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    case "match_issues_to_features": {
      const {
        include_closed = false,
        min_similarity = 0.5,
        force = false,
      } = args as {
        include_closed?: boolean;
        min_similarity?: number;
        force?: boolean;
      };

      try {
        if (!process.env.OPENAI_API_KEY) {
          throw new Error("OPENAI_API_KEY is required for feature matching.");
        }

        // Verify database is available
        const { hasDatabaseConfig, getStorage } = await import("../storage/factory.js");
        if (!hasDatabaseConfig()) {
          throw new Error("Database is required for issue-centric feature matching. Please configure DATABASE_URL.");
        }

        const storage = getStorage();
        const dbAvailable = await storage.isAvailable();
        if (!dbAvailable) {
          throw new Error("Database is not available. Please check your DATABASE_URL configuration.");
        }

        const { prisma } = await import("../storage/db/prisma.js");

        // STEP 1: Load features from database
        console.error(`[Issue Feature Matching] Loading features from database...`);
        const dbFeatures = await prisma.feature.findMany({
          include: {
            embedding: true,
          },
        });
        console.error(`[Issue Feature Matching] Found ${dbFeatures.length} features`);

        if (dbFeatures.length === 0) {
          return {
            content: [{
              type: "text",
              text: JSON.stringify({
                success: false,
                error: "No features found in database. Run extract_features first to extract features from documentation.",
              }, null, 2),
            }],
          };
        }

        // STEP 2: Load GitHub issues from database
        console.error(`[Issue Feature Matching] Loading GitHub issues from database...`);
        const allDbIssues = await prisma.gitHubIssue.findMany({
          where: include_closed ? {} : { issueState: "open" },
          include: {
            embedding: true,
          },
          orderBy: { issueNumber: 'desc' },
        });
        
        // Filter issues based on force flag - if not force, only match issues without features
        const allIssues = force 
          ? allDbIssues 
          : allDbIssues.filter(issue => {
              const features = issue.affectsFeatures as unknown[];
              return !features || !Array.isArray(features) || features.length === 0;
            });
        console.error(`[Issue Feature Matching] Found ${allIssues.length} issues to match (${allDbIssues.length} total, force=${force})`);

        if (allIssues.length === 0) {
          return {
            content: [{
              type: "text",
              text: JSON.stringify({
                success: true,
                message: force 
                  ? "No issues found in database. Run fetch_github_issues first."
                  : "All issues already have features matched. Use force=true to re-match.",
                stats: { total_issues: 0, matched: 0, skipped: 0 },
              }, null, 2),
            }],
          };
        }

        // STEP 3: Compute/load issue embeddings
        console.error(`[Issue Feature Matching] Computing issue embeddings...`);
        const { computeAndSaveIssueEmbeddings } = await import("../storage/db/embeddings.js");
        const embeddingResult = await computeAndSaveIssueEmbeddings(process.env.OPENAI_API_KEY, undefined, false);
        console.error(`[Issue Feature Matching] Issue embeddings: ${embeddingResult.computed} computed, ${embeddingResult.cached} cached`);

        // STEP 4: Load feature embeddings (compute if missing)
        console.error(`[Issue Feature Matching] Loading feature embeddings...`);
        const { computeAndSaveFeatureEmbeddings } = await import("../storage/db/embeddings.js");
        await computeAndSaveFeatureEmbeddings(process.env.OPENAI_API_KEY);
        
        // Reload features with embeddings
        const featuresWithEmbeddings = await prisma.feature.findMany({
          include: { embedding: true },
        });
        
        // Build feature embedding map
        const featureEmbeddingMap = new Map<string, number[]>();
        for (const feature of featuresWithEmbeddings) {
          if (feature.embedding?.embedding) {
            featureEmbeddingMap.set(feature.id, feature.embedding.embedding as number[]);
          }
        }
        console.error(`[Issue Feature Matching] Loaded ${featureEmbeddingMap.size} feature embeddings`);

        // STEP 5: Load code-to-feature mappings for additional matching
        console.error(`[Issue Feature Matching] Loading code-to-feature mappings...`);
        const codeFeatureMappings = await prisma.featureCodeMapping.findMany({
          select: {
            featureId: true,
            similarity: true,
          },
        });
        
        // Build map of feature -> max code similarity
        const codeToFeatureMap = new Map<string, number>();
        for (const mapping of codeFeatureMappings) {
          const current = codeToFeatureMap.get(mapping.featureId) || 0;
          const similarity = Number(mapping.similarity);
          if (similarity > current) {
            codeToFeatureMap.set(mapping.featureId, similarity);
          }
        }
        console.error(`[Issue Feature Matching] Found code mappings for ${codeToFeatureMap.size} features`);

        // Cosine similarity function
        const cosineSimilarity = (a: number[], b: number[]): number => {
          let dotProduct = 0;
          let normA = 0;
          let normB = 0;
          for (let i = 0; i < a.length; i++) {
            dotProduct += a[i] * b[i];
            normA += a[i] * a[i];
            normB += b[i] * b[i];
          }
          return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
        };

        // STEP 6: Match each issue to features
        console.error(`[Issue Feature Matching] Matching ${allIssues.length} issues to features...`);
        let matchedCount = 0;
        let skippedCount = 0;
        const matchResults: Array<{ issueNumber: number; features: Array<{ id: string; name: string; similarity: number }> }> = [];

        // Reload issue embeddings
        const issueEmbeddings = await prisma.issueEmbedding.findMany({
          where: { issueNumber: { in: allIssues.map(i => i.issueNumber) } },
        });
        const issueEmbeddingMap = new Map<number, number[]>();
        for (const emb of issueEmbeddings) {
          issueEmbeddingMap.set(emb.issueNumber, emb.embedding as number[]);
        }

        for (const issue of allIssues) {
          const issueEmb = issueEmbeddingMap.get(issue.issueNumber);
          
          if (!issueEmb) {
            console.error(`[Issue Feature Matching] No embedding for issue #${issue.issueNumber}, skipping`);
            skippedCount++;
            continue;
          }

          // Calculate similarity to each feature
          const featureMatches: Array<{ id: string; name: string; similarity: number; codeBoosted: boolean }> = [];

          for (const feature of featuresWithEmbeddings) {
            const featureEmb = featureEmbeddingMap.get(feature.id);
            if (!featureEmb) continue;

            let similarity = cosineSimilarity(issueEmb, featureEmb);
            let codeBoosted = false;

            // Boost with code similarity if available
            const codeSimilarity = codeToFeatureMap.get(feature.id);
            if (codeSimilarity && codeSimilarity > 0.5) {
              // Blend semantic and code similarities
              similarity = Math.max(similarity, similarity * 0.7 + codeSimilarity * 0.3);
              codeBoosted = true;
            }

            if (similarity >= min_similarity) {
              featureMatches.push({
                id: feature.id,
                name: feature.name,
                similarity,
                codeBoosted,
              });
            }
          }

          // Sort by similarity and take top 5
          featureMatches.sort((a, b) => b.similarity - a.similarity);
          const topFeatures = featureMatches.slice(0, 5);

          // Default to "General" if no matches
          const affectsFeatures = topFeatures.length > 0
            ? topFeatures.map(f => ({ id: f.id, name: f.name }))
            : [{ id: "general", name: "General" }];

          // Update issue in database
          await prisma.gitHubIssue.update({
            where: { issueNumber: issue.issueNumber },
            data: {
              affectsFeatures: affectsFeatures,
            },
          });

          matchedCount++;
          matchResults.push({
            issueNumber: issue.issueNumber,
            features: topFeatures.map(f => ({ id: f.id, name: f.name, similarity: Math.round(f.similarity * 100) / 100 })),
          });

          // Log progress every 50 issues
          if (matchedCount % 50 === 0) {
            console.error(`[Issue Feature Matching] Matched ${matchedCount}/${allIssues.length} issues...`);
          }
        }

        console.error(`[Issue Feature Matching] Completed: ${matchedCount} matched, ${skippedCount} skipped`);

        // Build summary by feature
        const featureSummary = new Map<string, number>();
        for (const result of matchResults) {
          for (const feature of result.features) {
            featureSummary.set(feature.name, (featureSummary.get(feature.name) || 0) + 1);
          }
        }

        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              success: true,
              message: `Matched ${matchedCount} issues to features`,
              stats: {
                total_issues: allIssues.length,
                matched: matchedCount,
                skipped: skippedCount,
                features_used: featureSummary.size,
              },
              feature_distribution: Object.fromEntries(
                [...featureSummary.entries()].sort((a, b) => b[1] - a[1]).slice(0, 20)
              ),
              sample_matches: matchResults.slice(0, 10).map(r => ({
                issue: r.issueNumber,
                top_feature: r.features[0]?.name || "General",
                similarity: r.features[0]?.similarity || 0,
              })),
            }, null, 2),
          }],
        };

      } catch (error) {
        logError("Issue feature matching failed:", error);
        throw new Error(`Issue feature matching failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    case "label_github_issues": {
      const {
        include_closed = false,
        force = false,
      } = args as {
        include_closed?: boolean;
        force?: boolean;
      };

      try {
        const apiKey = process.env.OPENAI_API_KEY;
        if (!apiKey) {
          throw new Error("OPENAI_API_KEY is required for label detection.");
        }

        // Verify database is available
        const { hasDatabaseConfig, getStorage } = await import("../storage/factory.js");
        if (!hasDatabaseConfig()) {
          throw new Error("Database is required for issue labeling. Please configure DATABASE_URL.");
        }

        const storage = getStorage();
        const dbAvailable = await storage.isAvailable();
        if (!dbAvailable) {
          throw new Error("Database is not available. Please check your DATABASE_URL configuration.");
        }

        const { prisma } = await import("../storage/db/prisma.js");

        // Load GitHub issues from database
        console.error(`[Label Issues] Loading GitHub issues from database...`);
        const allDbIssues = await prisma.gitHubIssue.findMany({
          where: include_closed ? {} : { issueState: "open" },
          orderBy: { issueNumber: 'desc' },
        });
        
        // Filter issues based on force flag
        const allIssues = force 
          ? allDbIssues 
          : allDbIssues.filter(issue => !issue.detectedLabels || issue.detectedLabels.length === 0);
        
        console.error(`[Label Issues] Found ${allIssues.length} issues to label (${allDbIssues.length} total, force=${force})`);

        if (allIssues.length === 0) {
          return {
            content: [{
              type: "text",
              text: JSON.stringify({
                success: true,
                message: force 
                  ? "No issues found in database. Run fetch_github_issues first."
                  : "All issues already have labels. Use force=true to re-label.",
                stats: { total_issues: 0, labeled: 0, skipped: 0 },
              }, null, 2),
            }],
          };
        }

        // Valid labels
        const validLabels = ["security", "bug", "regression", "urgent", "enhancement"];
        
        // Process in batches of 10
        const batchSize = 10;
        let labeledCount = 0;
        let skippedCount = 0;
        const labelCounts = new Map<string, number>();

        for (let i = 0; i < allIssues.length; i += batchSize) {
          const batch = allIssues.slice(i, i + batchSize);
          
          // Build batch content for LLM
          const batchContent = batch.map((issue, idx) => 
            `[${idx + 1}] Title: ${issue.issueTitle}${issue.issueBody ? `\nDescription: ${issue.issueBody.substring(0, 200)}` : ""}`
          ).join("\n\n---\n\n");
          
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
                    content: `You are a technical issue classifier. Analyze each issue and return applicable labels.

Available labels:
- security: Security vulnerabilities, auth issues, data leaks, XSS, CSRF, injection
- bug: Software defects, errors, crashes, things not working
- regression: Something that worked before but broke after update/release
- urgent: Critical issues, production outages, blockers
- enhancement: Feature requests, improvements, suggestions

Rules:
1. Return one line per issue: "[number] label1, label2" or "[number] none"
2. If regression, also include bug
3. Be conservative - only label if confident
4. Questions/docs are "none"

Example output:
[1] bug
[2] security
[3] regression, bug
[4] enhancement
[5] none`
                  },
                  {
                    role: "user",
                    content: `Classify these ${batch.length} issues:\n\n${batchContent}`
                  }
                ],
                temperature: 0.1,
                max_tokens: 200,
              }),
            });
            
            if (!response.ok) {
              console.error(`[Label Issues] LLM API error for batch ${i / batchSize + 1}`);
              skippedCount += batch.length;
              continue;
            }
            
            const data = await response.json();
            const result = data.choices[0]?.message?.content?.trim() || "";
            
            // Parse results
            const lines = result.split("\n").filter((l: string) => l.trim());
            
            for (const line of lines) {
              const match = line.match(/\[(\d+)\]\s*(.+)/);
              if (match) {
                const batchIdx = parseInt(match[1], 10) - 1;
                const labelsStr = match[2].trim().toLowerCase();
                
                if (batchIdx >= 0 && batchIdx < batch.length) {
                  const issue = batch[batchIdx];
                  
                  let detectedLabels: string[] = [];
                  if (labelsStr !== "none" && labelsStr) {
                    detectedLabels = labelsStr
                      .split(",")
                      .map((l: string) => l.trim())
                      .filter((l: string) => validLabels.includes(l));
                  }
                  
                  // Update issue in database
                  await prisma.gitHubIssue.update({
                    where: { issueNumber: issue.issueNumber },
                    data: { detectedLabels },
                  });
                  
                  labeledCount++;
                  for (const label of detectedLabels) {
                    labelCounts.set(label, (labelCounts.get(label) || 0) + 1);
                  }
                }
              }
            }
            
          } catch (batchError) {
            console.error(`[Label Issues] Error processing batch:`, batchError);
            skippedCount += batch.length;
          }
          
          // Log progress
          if ((i + batchSize) % 50 === 0 || i + batchSize >= allIssues.length) {
            console.error(`[Label Issues] Processed ${Math.min(i + batchSize, allIssues.length)}/${allIssues.length} issues...`);
          }
        }

        console.error(`[Label Issues] Completed: ${labeledCount} labeled, ${skippedCount} skipped`);

        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              success: true,
              message: `Labeled ${labeledCount} issues`,
              stats: {
                total_issues: allIssues.length,
                labeled: labeledCount,
                skipped: skippedCount,
              },
              label_distribution: Object.fromEntries(
                [...labelCounts.entries()].sort((a, b) => b[1] - a[1])
              ),
            }, null, 2),
          }],
        };

      } catch (error) {
        logError("Issue labeling failed:", error);
        throw new Error(`Issue labeling failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    case "classify_linear_issues": {
      const { team_name = "UNMute", limit = 250, create_projects = true } = args as {
        team_name?: string;
        limit?: number;
        create_projects?: boolean;
      };

      try {
        const config = getConfig();
        
        // Check if PM integration is enabled and is Linear
        if (!config.pmIntegration?.enabled || config.pmIntegration.pm_tool?.type !== "linear") {
          throw new Error("Linear integration requires PM_TOOL_TYPE=linear and PM_TOOL_API_KEY to be set in environment variables.");
        }

        if (!config.pmIntegration.pm_tool?.api_key) {
          throw new Error("Linear API key is required. Set PM_TOOL_API_KEY in environment variables.");
        }

        // Build PM tool configuration
        const pmToolConfig: PMToolConfig = {
          type: "linear",
          api_key: config.pmIntegration.pm_tool.api_key,
          api_url: config.pmIntegration.pm_tool.api_url,
          team_id: config.pmIntegration.pm_tool.team_id,
        };

        // Create Linear integration instance
        const { LinearIntegration } = await import("../export/linear/client.js");
        const linearTool = new LinearIntegration(pmToolConfig);

        // Find or get the team
        let teamId = pmToolConfig.team_id;
        if (!teamId) {
          // Find team by name
          const teams = await linearTool.listTeams();
          const team = teams.find(t => t.name.toLowerCase() === team_name.toLowerCase() || t.key.toLowerCase() === team_name.toLowerCase());
          if (!team) {
            throw new Error(`Team "${team_name}" not found. Available teams: ${teams.map(t => t.name).join(", ")}`);
          }
          teamId = team.id;
        }

        // STEP 1: Sync Linear projects to features (database if configured, otherwise JSON cache)
        console.error(`[Linear Classification] Syncing Linear projects to features...`);
        const allProjects = await linearTool.listProjects();
        const { getStorage } = await import("../storage/factory.js");
        const storage = getStorage();
        
        // Convert Linear projects to features and save (storage handles DB vs JSON automatically)
        const projectFeatures = allProjects.map((project, index) => ({
          id: `linear-project-${project.id}`,
          name: project.name,
          description: `Linear project: ${project.name}`,
          category: "Linear Project",
          priority: "medium" as const,
          related_keywords: [project.name.toLowerCase()],
          documentation_section: undefined,
          documentation_urls: [], // Linear projects don't come from documentation
        }));
        
        if (projectFeatures.length > 0) {
          await storage.saveFeatures([], projectFeatures, 0);
          const { hasDatabaseConfig: checkDbConfig } = await import("../storage/factory.js");
          const storageType = checkDbConfig() ? "database" : "JSON cache";
          console.error(`[Linear Classification] Synced ${projectFeatures.length} Linear projects to features (${storageType})`);
        }

        // STEP 1b: Create Linear projects for features that don't have a corresponding Linear project
        // Check if database is configured, otherwise use JSON storage
        const { hasDatabaseConfig: checkDbConfig } = await import("../storage/factory.js");
        if (checkDbConfig()) {
          // Database: Query features from database using Prisma
          console.error(`[Linear Classification] Checking for features without Linear projects (database)...`);
          const { prisma } = await import("../storage/db/prisma.js");
          const allFeatures = await prisma.feature.findMany({
            where: {
              NOT: { id: { startsWith: "linear-project-" } },
            },
            select: { id: true, name: true, description: true, category: true, priority: true },
            orderBy: { name: "asc" },
          });

          const linearProjectNames = new Set(allProjects.map(p => p.name.toLowerCase().trim()));
          let projectsCreated = 0;

          for (const feature of allFeatures) {
            const featureNameLower = feature.name.toLowerCase().trim();
            
            // Check if a Linear project with this name already exists
            if (!linearProjectNames.has(featureNameLower)) {
              try {
                // Create Linear project for this feature
                const projectId = await linearTool.createOrGetProject(
                  feature.id,
                  feature.name,
                  feature.description || `Feature: ${feature.name}`
                );

                // Update the feature in database to link it to the Linear project
                // Since Prisma doesn't allow updating the primary key directly, we need to delete and recreate
                const existingFeature = await prisma.feature.findUnique({ where: { id: feature.id } });
                if (existingFeature) {
                  await prisma.feature.delete({ where: { id: feature.id } });
                  await prisma.feature.create({
                    data: {
                      ...existingFeature,
                      id: `linear-project-${projectId}`,
                      updatedAt: new Date(),
                    },
                  });
                }

                // Add to allProjects list so it's available for matching
                allProjects.push({ id: projectId, name: feature.name });
                linearProjectNames.add(featureNameLower);
                projectsCreated++;
                console.error(`[Linear Classification] Created Linear project "${feature.name}" for feature`);
              } catch (error) {
                console.error(`[Linear Classification] Failed to create Linear project for feature "${feature.name}":`, error);
              }
            }
          }
          
          if (projectsCreated > 0) {
            console.error(`[Linear Classification] Created ${projectsCreated} Linear projects for features`);
          }
        } else {
          // JSON: Get features from JSON cache
          console.error(`[Linear Classification] Checking for features without Linear projects (JSON cache)...`);
          try {
            // Get features from JSON cache
            const cachedFeatures = await storage.getFeatures([]);
            if (cachedFeatures && cachedFeatures.features) {
              const allFeatures = cachedFeatures.features.filter(
                (f) => !f.id || !f.id.startsWith("linear-project-")
              );
              
              const linearProjectNames = new Set(allProjects.map(p => p.name.toLowerCase().trim()));
              let projectsCreated = 0;
              
              for (const feature of allFeatures) {
                const featureNameLower = feature.name.toLowerCase().trim();
                
                // Check if a Linear project with this name already exists
                if (!linearProjectNames.has(featureNameLower)) {
                  try {
                    // Create Linear project for this feature
                    const projectId = await linearTool.createOrGetProject(
                      feature.id || `feature-${feature.name}`,
                      feature.name,
                      feature.description || `Feature: ${feature.name}`
                    );
                    
                    // Update feature in JSON cache to link it to the Linear project
                    const updatedFeature = {
                      ...feature,
                      id: `linear-project-${projectId}`,
                    };
                    await storage.saveFeatures([], [updatedFeature], 0);
                    
                    // Add to allProjects list so it's available for matching
                    allProjects.push({ id: projectId, name: feature.name });
                    linearProjectNames.add(featureNameLower);
                    projectsCreated++;
                    console.error(`[Linear Classification] Created Linear project "${feature.name}" for feature`);
                  } catch (error) {
                    console.error(`[Linear Classification] Failed to create Linear project for feature "${feature.name}":`, error);
                  }
                }
              }
              
              if (projectsCreated > 0) {
                console.error(`[Linear Classification] Created ${projectsCreated} Linear projects for features`);
              }
            }
          } catch (error) {
            console.error(`[Linear Classification] Failed to get features from JSON cache:`, error);
          }
        }

        // Ensure "General" project exists
        const generalProject = allProjects.find(p => p.name.toLowerCase() === "general");
        let generalProjectId: string | undefined;
        if (!generalProject) {
          // Create General project if it doesn't exist
          try {
            generalProjectId = await linearTool.createOrGetProject(
              "general",
              "General",
              "General project for unclassified issues"
            );
            console.error(`[Linear Classification] Created "General" project`);
          } catch (error) {
            console.error(`[Linear Classification] Failed to create General project:`, error);
          }
        } else {
          generalProjectId = generalProject.id;
        }

        // Fetch all issues from the team
        console.error(`[Linear Classification] Fetching issues from team ${team_name} (${teamId})...`);
        const issues = await linearTool.listTeamIssues(teamId, limit);
        console.error(`[Linear Classification] Found ${issues.length} issues`);

        // Build project maps
        const projectNameMap = new Map<string, { id: string; name: string }>();
        const projectIdMap = new Map<string, string>(); // project_id -> project_name
        for (const project of allProjects) {
          projectNameMap.set(project.name.toLowerCase().trim(), project);
          projectIdMap.set(project.id, project.name);
        }
        if (generalProjectId && !projectIdMap.has(generalProjectId)) {
          projectIdMap.set(generalProjectId, "General");
        }

        // Classify issues
        const results = {
          total_issues: issues.length,
          with_projects: 0,
          without_projects: 0,
          projects_created: 0,
          projects_matched: 0,
          issues_by_project: {} as Record<string, number>,
          unclassified_issues: [] as Array<{ id: string; identifier: string; title: string }>,
        };

        // STEP 2: Get all features from database (if configured) or JSON (fallback)
        let features: Array<{ 
          id: string; 
          name: string; 
          description?: string; 
          category?: string; 
          priority?: string; 
          related_keywords?: string[];
          documentation_urls?: string[];
          documentation_section?: string;
        }> = [];
        
        // Check if database is configured
        if (checkDbConfig()) {
          try {
            // Get features from database using Prisma (includes Linear projects we just synced)
            const { prisma } = await import("../storage/db/prisma.js");
            const dbFeatures = await prisma.feature.findMany({
              orderBy: { name: "asc" },
            });
            features = dbFeatures.map((row) => ({
              id: row.id,
              name: row.name,
              description: row.description || undefined,
              category: row.category || undefined,
              priority: row.priority || undefined,
              related_keywords: row.relatedKeywords || [],
              documentation_urls: row.documentationUrls || [],
              documentation_section: row.documentationSection || undefined,
            }));
            console.error(`[Linear Classification] Using ${features.length} features from database (includes ${projectFeatures.length} Linear projects)`);
            
            // Also get documentation features if available (they should already be in DB, but ensure they're there)
            if (config.pmIntegration.documentation_urls && config.pmIntegration.documentation_urls.length > 0) {
              try {
                const { getFeaturesFromCacheOrExtract } = await import("../export/featureCache.js");
                const docFeatures = await getFeaturesFromCacheOrExtract(config.pmIntegration.documentation_urls);
                // Merge documentation features (avoid duplicates)
                for (const docFeature of docFeatures) {
                  if (!features.find(f => f.id === docFeature.id)) {
                    features.push({
                      id: docFeature.id,
                      name: docFeature.name,
                      description: docFeature.description,
                      category: docFeature.category,
                      priority: docFeature.priority,
                      related_keywords: docFeature.related_keywords || [],
                      documentation_urls: (docFeature as ProductFeature & { documentation_urls?: string[] }).documentation_urls || [],
                      documentation_section: docFeature.documentation_section || undefined,
                    });
                  }
                }
                console.error(`[Linear Classification] Total ${features.length} features (${projectFeatures.length} Linear projects + ${docFeatures.length} documentation features)`);
              } catch (error) {
                console.error(`[Linear Classification] Failed to get documentation features:`, error);
              }
            }
          } catch (error) {
            console.error(`[Linear Classification] Failed to get features from database:`, error);
            // Fallback to JSON/cache
            if (config.pmIntegration.documentation_urls && config.pmIntegration.documentation_urls.length > 0) {
              try {
                const { getFeaturesFromCacheOrExtract } = await import("../export/featureCache.js");
                features = await getFeaturesFromCacheOrExtract(config.pmIntegration.documentation_urls);
                console.error(`[Linear Classification] Fallback: Using ${features.length} features from JSON cache`);
              } catch (error) {
                console.error(`[Linear Classification] Failed to get features from cache:`, error);
              }
            }
          }
        } else {
          // Database not configured - use JSON storage
          console.error(`[Linear Classification] Database not configured, using JSON storage for features`);
          if (config.pmIntegration.documentation_urls && config.pmIntegration.documentation_urls.length > 0) {
            try {
              const { getFeaturesFromCacheOrExtract } = await import("../export/featureCache.js");
              const cachedFeatures = await getFeaturesFromCacheOrExtract(config.pmIntegration.documentation_urls);
              features = cachedFeatures.map((f) => ({
                id: f.id,
                name: f.name,
                description: f.description,
                category: f.category,
                priority: f.priority,
                related_keywords: f.related_keywords || [],
                documentation_section: f.documentation_section || undefined,
              }));
              console.error(`[Linear Classification] Using ${features.length} features from JSON cache`);
            } catch (error) {
              console.error(`[Linear Classification] Failed to get features from JSON cache:`, error);
            }
          }
        }

        for (const issue of issues) {
          if (issue.projectId && issue.projectName) {
            // Issue already has a project
            results.with_projects++;
            const projectName = issue.projectName.toLowerCase().trim();
            results.issues_by_project[issue.projectName] = (results.issues_by_project[issue.projectName] || 0) + 1;
          } else {
            // Issue doesn't have a project - try to classify it
            results.without_projects++;
            
            // STEP 3: Match issue to existing projects (features)
            let matchedProjectId: string | undefined;
            
            // Try to match with existing projects using semantic similarity
            if (features.length > 0 && process.env.OPENAI_API_KEY) {
              try {
                const { createEmbedding } = await import("../core/classify/semantic.js");
                const issueText = `${issue.title} ${issue.description || ""}`.trim();
                const issueEmbedding = await createEmbedding(issueText, process.env.OPENAI_API_KEY);
                
                let bestMatch: { feature: typeof features[0]; similarity: number; projectId?: string } | null = null;
                let allSimilarities: Array<{ name: string; similarity: number; hasProject: boolean }> = [];
                
                for (const feature of features) {
                  // Check if this feature corresponds to a Linear project
                  let projectId: string | undefined;
                  if (feature.id.startsWith("linear-project-")) {
                    // Extract Linear project ID from feature ID
                    const linearProjectId = feature.id.replace("linear-project-", "");
                    projectId = linearProjectId;
                  } else {
                    // Try to find Linear project by feature name
                    const project = allProjects.find(p => p.name.toLowerCase() === feature.name.toLowerCase());
                    if (project) {
                      projectId = project.id;
                    }
                  }
                  
                  // Build feature text for embedding - include documentation content if available
                  let featureText = `${feature.name}: ${feature.description || ""}`.trim();
                  
                  // If feature has documentation URLs, fetch and include documentation content for better matching
                  const featureWithDocs = feature as ProductFeature & { documentation_urls?: string[] };
                  if (featureWithDocs.documentation_urls && featureWithDocs.documentation_urls.length > 0) {
                    try {
                      const { getStorage } = await import("../storage/factory.js");
                      const storage = getStorage();
                      
                      // Fetch documentation for all URLs
                      const docs = await storage.getDocumentationMultiple(featureWithDocs.documentation_urls);
                      
                      // Add documentation content to feature text (limit to avoid token limits)
                      const docTexts = docs
                        .map(doc => doc.content.substring(0, 2000)) // Limit each doc to 2000 chars
                        .join("\n\n");
                      
                      if (docTexts) {
                        featureText = `${feature.name}: ${feature.description || ""}\n\nDocumentation:\n${docTexts}`.trim();
                        console.error(`[Linear Classification] Using documentation for feature "${feature.name}" (${docs.length} docs, ${docTexts.length} chars)`);
                      }
                    } catch (error) {
                      // If documentation fetch fails, continue with just name/description
                      console.error(`[Linear Classification] Failed to fetch documentation for feature "${feature.name}":`, error);
                    }
                  }
                  
                  const featureEmbedding = await createEmbedding(featureText, process.env.OPENAI_API_KEY);
                  
                  // Calculate cosine similarity
                  let dotProduct = 0;
                  let normA = 0;
                  let normB = 0;
                  for (let i = 0; i < issueEmbedding.length; i++) {
                    dotProduct += issueEmbedding[i] * featureEmbedding[i];
                    normA += issueEmbedding[i] * issueEmbedding[i];
                    normB += featureEmbedding[i] * featureEmbedding[i];
                  }
                  const similarity = dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
                  
                  // Track all similarities for debugging
                  allSimilarities.push({ 
                    name: feature.name, 
                    similarity, 
                    hasProject: !!projectId 
                  });
                  
                  // Threshold 0.5 for matching, and require projectId
                  if (similarity > 0.5 && projectId && (!bestMatch || similarity > bestMatch.similarity)) {
                    bestMatch = { feature, similarity, projectId };
                  }
                }
                
                // Log top similarities for debugging
                allSimilarities.sort((a, b) => b.similarity - a.similarity);
                const top3 = allSimilarities.slice(0, 3);
                console.error(`[Linear Classification] Issue ${issue.identifier} top matches: ${top3.map(t => `${t.name} (${t.similarity.toFixed(2)}, hasProject: ${t.hasProject})`).join(", ")}`);
                
                if (bestMatch && bestMatch.projectId) {
                  matchedProjectId = bestMatch.projectId;
                  results.projects_matched++;
                  console.error(`[Linear Classification] Matched issue ${issue.identifier} to project "${bestMatch.feature.name}" (similarity: ${bestMatch.similarity.toFixed(2)})`);
                } else {
                  console.error(`[Linear Classification] No match found for issue ${issue.identifier} (best similarity: ${top3[0]?.similarity.toFixed(2) || "N/A"}, threshold: 0.5)`);
                }
              } catch (error) {
                console.error(`[Linear Classification] Failed to match issue ${issue.identifier}:`, error);
              }
            } else {
              if (features.length === 0) {
                console.error(`[Linear Classification] No features available for matching issue ${issue.identifier}`);
              }
              if (!process.env.OPENAI_API_KEY) {
                console.error(`[Linear Classification] OPENAI_API_KEY not set, skipping semantic matching for issue ${issue.identifier}`);
              }
            }
            
            // STEP 4: If no match found, assign to "General" project
            if (!matchedProjectId && generalProjectId) {
              matchedProjectId = generalProjectId;
              results.issues_by_project["General"] = (results.issues_by_project["General"] || 0) + 1;
              console.error(`[Linear Classification] Assigning issue ${issue.identifier} to "General" project (no match found)`);
            }
            
            // Link issue to project
            if (matchedProjectId) {
              try {
                await linearTool.updateIssue(issue.id, { project_id: matchedProjectId });
                const projectName = projectIdMap.get(matchedProjectId) || "Unknown";
                results.issues_by_project[projectName] = (results.issues_by_project[projectName] || 0) + 1;
              } catch (error) {
                console.error(`[Linear Classification] Failed to link issue ${issue.identifier} to project:`, error);
                results.unclassified_issues.push({
                  id: issue.id,
                  identifier: issue.identifier,
                  title: issue.title,
                });
              }
            } else {
              results.unclassified_issues.push({
                id: issue.id,
                identifier: issue.identifier,
                title: issue.title,
              });
            }
          }
        }

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                success: true,
                message: `Classified ${issues.length} Linear issues`,
                results,
              }, null, 2),
            },
          ],
        };
      } catch (error) {
        logError("Linear issue classification failed:", error);
        throw new Error(`Linear issue classification failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    case "label_linear_issues": {
      const { team_name = "UNMute", limit = 100, dry_run = false } = args as {
        team_name?: string;
        limit?: number;
        dry_run?: boolean;
      };

      try {
        const config = getConfig();
        
        // Check for required API keys
        if (!config.pmIntegration?.enabled || config.pmIntegration.pm_tool?.type !== "linear") {
          throw new Error("Linear integration requires PM_TOOL_TYPE=linear and PM_TOOL_API_KEY to be set in environment variables.");
        }

        if (!config.pmIntegration.pm_tool?.api_key) {
          throw new Error("Linear API key is required. Set PM_TOOL_API_KEY in environment variables.");
        }

        if (!process.env.OPENAI_API_KEY) {
          throw new Error("OPENAI_API_KEY is required for LLM-based label detection.");
        }

        // Build PM tool configuration
        const pmToolConfig: PMToolConfig = {
          type: "linear",
          api_key: config.pmIntegration.pm_tool.api_key,
          api_url: config.pmIntegration.pm_tool.api_url,
          team_id: config.pmIntegration.pm_tool.team_id,
        };

        // Create Linear integration instance
        const { LinearIntegration } = await import("../export/linear/client.js");
        const linearTool = new LinearIntegration(pmToolConfig);

        // Find the team
        let teamId = pmToolConfig.team_id;
        if (!teamId) {
          const teams = await linearTool.listTeams();
          const team = teams.find(t => t.name.toLowerCase() === team_name.toLowerCase() || t.key.toLowerCase() === team_name.toLowerCase());
          if (!team) {
            throw new Error(`Team "${team_name}" not found. Available teams: ${teams.map(t => t.name).join(", ")}`);
          }
          teamId = team.id;
        }

        // Initialize labels (create standard labels if they don't exist)
        console.error(`[Label Linear Issues] Initializing labels...`);
        await linearTool.initializeLabels();

        // Fetch issues from the team
        console.error(`[Label Linear Issues] Fetching issues from team "${team_name}"...`);
        const issues = await linearTool.listTeamIssues(teamId, limit);
        console.error(`[Label Linear Issues] Found ${issues.length} issues`);

        // Prepare issues for LLM classification
        const issuesToClassify = issues.map((issue, index) => ({
          index,
          linearId: issue.id,
          identifier: issue.identifier,
          title: issue.title,
          description: issue.description || "",
          existingLabels: issue.labels?.map(l => l.name) || [],
        }));

        // Use LLM to detect labels in batches
        console.error(`[Label Linear Issues] Detecting labels using LLM...`);
        
        const results = {
          total_issues: issues.length,
          issues_updated: 0,
          issues_skipped: 0,
          labels_added: 0,
          updates: [] as Array<{
            identifier: string;
            title: string;
            added_labels: string[];
            existing_labels: string[];
          }>,
          errors: [] as string[],
        };

        // Process in batches of 10
        const batchSize = 10;
        for (let i = 0; i < issuesToClassify.length; i += batchSize) {
          const batch = issuesToClassify.slice(i, i + batchSize);
          
          // Build batch content for LLM
          const batchContent = batch.map((issue, idx) => 
            `[${idx + 1}] Title: ${issue.title}${issue.description ? `\nDescription: ${issue.description.substring(0, 200)}` : ""}`
          ).join("\n\n---\n\n");

          try {
            const response = await fetch("https://api.openai.com/v1/chat/completions", {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                "Authorization": `Bearer ${process.env.OPENAI_API_KEY}`,
              },
              body: JSON.stringify({
                model: "gpt-4o-mini",
                messages: [
                  {
                    role: "system",
                    content: `You are a technical issue classifier. Analyze each issue and return applicable labels.

Available labels:
- security: Security vulnerabilities, auth issues, data leaks, XSS, CSRF, injection
- bug: Software defects, errors, crashes, things not working
- regression: Something that worked before but broke after update/release
- urgent: Critical issues, production outages, blockers
- enhancement: Feature requests, improvements, suggestions

Rules:
1. Return one line per issue: "[number] label1, label2" or "[number] none"
2. If regression, also include bug
3. Be conservative - only label if confident
4. Questions/docs are "none"

Example output:
[1] bug
[2] security
[3] regression, bug
[4] enhancement
[5] none`
                  },
                  {
                    role: "user",
                    content: `Classify these ${batch.length} issues:\n\n${batchContent}`
                  }
                ],
                temperature: 0.1,
                max_tokens: 200,
              }),
            });

            if (!response.ok) {
              const errorText = await response.text();
              console.error(`[Label Linear Issues] LLM API error: ${response.status} ${errorText}`);
              results.errors.push(`LLM API error for batch ${Math.floor(i / batchSize) + 1}: ${response.status}`);
              continue;
            }

            const data = await response.json();
            const result = data.choices[0]?.message?.content?.trim() || "";

            // Parse results
            const validLabels = ["security", "bug", "regression", "urgent", "enhancement"];
            const lines = result.split("\n").filter((l: string) => l.trim());

            for (const line of lines) {
              const match = line.match(/\[(\d+)\]\s*(.+)/);
              if (match) {
                const batchIdx = parseInt(match[1], 10) - 1;
                const labelsStr = match[2].trim().toLowerCase();

                if (batchIdx >= 0 && batchIdx < batch.length) {
                  const issue = batch[batchIdx];

                  if (labelsStr === "none" || !labelsStr) {
                    results.issues_skipped++;
                    continue;
                  }

                  const detectedLabels = labelsStr
                    .split(",")
                    .map((l: string) => l.trim())
                    .filter((l: string) => validLabels.includes(l));

                  // Filter out labels that already exist
                  const existingLower = issue.existingLabels.map(l => l.toLowerCase());
                  const newLabels = detectedLabels.filter((l: string) => !existingLower.includes(l));

                  if (newLabels.length > 0) {
                    if (!dry_run) {
                      // Get label IDs and update the issue
                      const labelIds = await linearTool.mapLabelsAsync(newLabels);
                      
                      if (labelIds.length > 0) {
                        // Get existing label IDs
                        const originalIssue = issues.find(iss => iss.id === issue.linearId);
                        const existingLabelIds = originalIssue?.labels?.map(l => l.id) || [];
                        
                        // Combine existing and new label IDs
                        const allLabelIds = [...existingLabelIds, ...labelIds];
                        
                        try {
                          // Update issue with new labels using GraphQL directly
                          const updateResponse = await fetch("https://api.linear.app/graphql", {
                            method: "POST",
                            headers: {
                              "Content-Type": "application/json",
                              "Authorization": config.pmIntegration.pm_tool.api_key!,
                            },
                            body: JSON.stringify({
                              query: `
                                mutation UpdateIssueLabels($id: String!, $labelIds: [String!]!) {
                                  issueUpdate(id: $id, input: { labelIds: $labelIds }) {
                                    success
                                  }
                                }
                              `,
                              variables: {
                                id: issue.linearId,
                                labelIds: allLabelIds,
                              },
                            }),
                          });

                          if (!updateResponse.ok) {
                            throw new Error(`Failed to update issue: ${updateResponse.status}`);
                          }

                          const updateData = await updateResponse.json();
                          if (!updateData.data?.issueUpdate?.success) {
                            throw new Error(`Failed to update issue: ${JSON.stringify(updateData.errors)}`);
                          }

                          results.issues_updated++;
                          results.labels_added += newLabels.length;
                          results.updates.push({
                            identifier: issue.identifier,
                            title: issue.title,
                            added_labels: newLabels,
                            existing_labels: issue.existingLabels,
                          });

                          console.error(`[Label Linear Issues] ${issue.identifier}: Added labels [${newLabels.join(", ")}]`);
                        } catch (updateError) {
                          results.errors.push(`Failed to update ${issue.identifier}: ${updateError instanceof Error ? updateError.message : String(updateError)}`);
                        }
                      }
                    } else {
                      // Dry run - just record what would be done
                      results.issues_updated++;
                      results.labels_added += newLabels.length;
                      results.updates.push({
                        identifier: issue.identifier,
                        title: issue.title,
                        added_labels: newLabels,
                        existing_labels: issue.existingLabels,
                      });
                      console.error(`[Label Linear Issues] [DRY RUN] ${issue.identifier}: Would add labels [${newLabels.join(", ")}]`);
                    }
                  } else {
                    results.issues_skipped++;
                  }
                }
              }
            }
          } catch (batchError) {
            console.error(`[Label Linear Issues] Error processing batch:`, batchError);
            results.errors.push(`Batch ${Math.floor(i / batchSize) + 1} failed: ${batchError instanceof Error ? batchError.message : String(batchError)}`);
          }
        }

        console.error(`[Label Linear Issues] Complete: ${results.issues_updated} issues updated, ${results.labels_added} labels added`);

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                success: true,
                dry_run,
                message: dry_run 
                  ? `[DRY RUN] Would update ${results.issues_updated} issues with ${results.labels_added} labels`
                  : `Updated ${results.issues_updated} issues with ${results.labels_added} labels`,
                results,
              }, null, 2),
            },
          ],
        };
      } catch (error) {
        logError("Linear issue labeling failed:", error);
        throw new Error(`Linear issue labeling failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    case "manage_documentation_cache": {
      const { action = "list", urls, use_cache = true } = args as {
        action?: "list" | "fetch" | "extract_features" | "compute_embeddings" | "compute_docs_embeddings" | "compute_sections_embeddings" | "compute_features_embeddings" | "clear";
        urls?: string[];
        use_cache?: boolean;
      };

      try {
        const { getStorage } = await import("../storage/factory.js");
        const storage = getStorage();
        const config = getConfig();

        switch (action) {
          case "list": {
            // List all cached documentation
            const cachedDocs = await storage.getAllCachedDocumentation();
            
            return {
              content: [
                {
                  type: "text",
                  text: JSON.stringify({
                    success: true,
                    cached_count: cachedDocs.length,
                    cached_docs: cachedDocs.map(doc => ({
                      url: doc.url,
                      title: doc.title,
                      content_length: doc.content.length,
                      sections_count: doc.sections?.length || 0,
                      fetched_at: doc.fetched_at,
                    })),
                  }, null, 2),
                },
              ],
            };
          }

          case "fetch": {
            // Pre-fetch and cache documentation
            if (!urls || urls.length === 0) {
              // Use config URLs if not provided
              const configUrls = config.pmIntegration?.documentation_urls;
              if (!configUrls || configUrls.length === 0) {
                throw new Error("No URLs provided. Set 'urls' parameter or DOCUMENTATION_URLS in environment variables.");
              }
              const docs = await fetchMultipleDocumentation(configUrls, true, use_cache);
              
              return {
                content: [
                  {
                    type: "text",
                    text: JSON.stringify({
                      success: true,
                      message: `Fetched and cached ${docs.length} documentation pages`,
                      cached_docs: docs.map(doc => ({
                        url: doc.url,
                        title: doc.title,
                        content_length: doc.content.length,
                        sections_count: doc.sections?.length || 0,
                        fetched_at: doc.fetched_at,
                      })),
                    }, null, 2),
                  },
                ],
              };
            } else {
              const docs = await fetchMultipleDocumentation(urls, true, use_cache);
              
              return {
                content: [
                  {
                    type: "text",
                    text: JSON.stringify({
                      success: true,
                      message: `Fetched and cached ${docs.length} documentation pages`,
                      cached_docs: docs.map(doc => ({
                        url: doc.url,
                        title: doc.title,
                        content_length: doc.content.length,
                        sections_count: doc.sections?.length || 0,
                        fetched_at: doc.fetched_at,
                      })),
                    }, null, 2),
                  },
                ],
              };
            }
          }

          case "extract_features": {
            // Extract features from cached documentation (or use feature cache if available)
            const docUrls = config.pmIntegration?.documentation_urls || urls || [];
            
            if (docUrls.length === 0) {
              throw new Error("No documentation URLs configured. Set DOCUMENTATION_URLS in environment variables or provide 'urls' parameter.");
            }

            if (!process.env.OPENAI_API_KEY) {
              throw new Error("OPENAI_API_KEY is required for feature extraction.");
            }

            const { getFeaturesFromCacheOrExtract, getCachedFeaturesInfo } = await import("../export/featureCache.js");
            
            // Check if features are already cached
            const cacheInfo = await getCachedFeaturesInfo(docUrls);
            if (cacheInfo) {
              console.error(`[Documentation Cache] Features already cached (${cacheInfo.feature_count} features from ${cacheInfo.documentation_count} docs, extracted at ${cacheInfo.extracted_at})`);
            }
            
            // Get features (from cache or extract)
            console.error(`[Documentation Cache] Getting features (from cache or extracting)...`);
            const features = await getFeaturesFromCacheOrExtract(docUrls);

            return {
              content: [
                {
                  type: "text",
                  text: JSON.stringify({
                    success: true,
                    message: `Got ${features.length} features (from cache or extracted)`,
                    cached: !!cacheInfo,
                    features: features.map(f => ({
                      id: f.id,
                      name: f.name,
                      description: f.description,
                      category: f.category,
                      priority: f.priority,
                    })),
                    cache_info: cacheInfo,
                  }, null, 2),
                },
              ],
            };
          }

          case "compute_embeddings": {
            // Compute embeddings for documentation, sections, and features
            if (!process.env.OPENAI_API_KEY) {
              throw new Error("OPENAI_API_KEY is required for computing embeddings.");
            }

            const { computeAllEmbeddings } = await import("../storage/db/embeddings.js");
            
            console.error("[Embeddings] Starting embedding computation for documentation, sections, and features...");
            await computeAllEmbeddings(process.env.OPENAI_API_KEY, {
              skipThreads: true,
              skipIssues: true,
            });

            return {
              content: [
                {
                  type: "text",
                  text: JSON.stringify({
                    success: true,
                    message: "Embeddings computed for all documentation, sections, and features. Use compute_discord_embeddings and compute_github_issue_embeddings for threads and issues.",
                  }, null, 2),
                },
              ],
            };
          }

          case "compute_docs_embeddings": {
            // Compute embeddings for documentation pages only
            if (!process.env.OPENAI_API_KEY) {
              throw new Error("OPENAI_API_KEY is required for computing embeddings.");
            }

            const { computeAndSaveDocumentationEmbeddings } = await import("../storage/db/embeddings.js");
            
            console.error("[Documentation Cache] Starting documentation embeddings computation...");
            await computeAndSaveDocumentationEmbeddings(process.env.OPENAI_API_KEY);

            return {
              content: [
                {
                  type: "text",
                  text: JSON.stringify({
                    success: true,
                    message: "Embeddings computed for all documentation pages",
                  }, null, 2),
                },
              ],
            };
          }

          case "compute_sections_embeddings": {
            // Compute embeddings for documentation sections only
            if (!process.env.OPENAI_API_KEY) {
              throw new Error("OPENAI_API_KEY is required for computing embeddings.");
            }

            const { computeAndSaveDocumentationSectionEmbeddings } = await import("../storage/db/embeddings.js");
            
            console.error("[Documentation Cache] Starting documentation section embeddings computation...");
            await computeAndSaveDocumentationSectionEmbeddings(process.env.OPENAI_API_KEY);

            return {
              content: [
                {
                  type: "text",
                  text: JSON.stringify({
                    success: true,
                    message: "Embeddings computed for all documentation sections",
                  }, null, 2),
                },
              ],
            };
          }

          case "compute_features_embeddings": {
            // Compute embeddings for features only
            if (!process.env.OPENAI_API_KEY) {
              throw new Error("OPENAI_API_KEY is required for computing embeddings.");
            }

            const { computeAndSaveFeatureEmbeddings } = await import("../storage/db/embeddings.js");
            
            console.error("[Embeddings] Starting feature embeddings computation...");
            await computeAndSaveFeatureEmbeddings(process.env.OPENAI_API_KEY);

            return {
              content: [
                {
                  type: "text",
                  text: JSON.stringify({
                    success: true,
                    message: "Embeddings computed for all features",
                  }, null, 2),
                },
              ],
            };
          }

          case "clear": {
            // Clear documentation cache and feature cache
            await storage.clearDocumentationCache();
            const { clearFeaturesCache } = await import("../export/featureCache.js");
            await clearFeaturesCache();
            
            return {
              content: [
                {
                  type: "text",
                  text: JSON.stringify({
                    success: true,
                    message: "Documentation cache and feature cache cleared",
                  }, null, 2),
                },
              ],
            };
          }

          default:
            throw new Error(`Unknown action: ${action}`);
        }
      } catch (error) {
        logError("Documentation cache management failed:", error);
        throw new Error(`Documentation cache management failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    default:
      throw new Error(`Unknown tool: ${name}`);
    }
  } catch (error) {
    // Catch and format errors properly for MCP client
    const errorMessage = error instanceof Error ? error.message : String(error);
    
    // Check if it's a JSON parsing error and provide more context
    if (errorMessage.includes("Unexpected token")) {
      logError("JSON parsing error:", error);
      throw new Error(`Invalid JSON data encountered: ${errorMessage}. This may indicate a corrupted or invalid file.`);
    }
    
    // Log the error for debugging
    logError(`Error handling command: ${name}`, error);
    
    // Re-throw with formatted message
    throw new Error(`Command failed: ${errorMessage}`);
  }
});

// Start the server
async function main() {
  // Start MCP server FIRST so Cursor can communicate with it
  const transport = new StdioServerTransport();
  await mcpServer.connect(transport);

  // Connect to Discord in the background (non-blocking)
  discord.login(DISCORD_TOKEN).catch((error) => {
    logError("Failed to login to Discord:", error);
  });
}

main().catch((error) => {
  logError("Failed to start server:", error);
  process.exit(1);
});
