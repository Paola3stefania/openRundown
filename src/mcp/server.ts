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
import { detectProjectId } from "../config/project.js";

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

discord.once("clientReady", () => {
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
  name: "openrundown",
  version: "1.0.0",
  },
  {
    instructions: [
      "OpenRundown provides project context and session memory for AI agents.",
      "",
      "At the START of every conversation:",
      "1. Call get_agent_briefing to understand the current project state (active issues, recent decisions, open items, user signals from Discord/GitHub)",
      "2. Call get_session_history to see what previous agent sessions worked on and what open items remain",
      "3. Use this context to inform your responses — avoid duplicating past work or revisiting resolved decisions",
      "",
      "During meaningful work sessions:",
      "1. Call start_agent_session at the beginning with the scope of work (e.g., ['agent-auth', 'mcp-tools'])",
      "2. Call update_agent_session periodically to record progress mid-session",
      "3. Call end_agent_session when done, recording: decisions_made, files_edited, open_items, issues_referenced, and a summary",
      "",
      "This session data powers the next agent's briefing — what you record here is what the next agent will know.",
    ].join("\n"),
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
    name: "sync_classify_and_export",
    description: "Complete issue-centric workflow: 1) Fetch GitHub issues, 2) Check Discord messages, 3) Compute ALL embeddings (issues, threads, features, groups), 4) Group related issues, 5) Match Discord threads to issues, 6) Label issues, 7) Match to features (ungrouped issues, grouped issues, AND groups), 8) Export to Linear, 9) Sync Linear status, 10) Sync PR-based status. All steps are incremental and use embeddings for matching. Requires DATABASE_URL and OPENAI_API_KEY.",
    inputSchema: {
      type: "object",
      properties: {
        channel_id: {
          type: "string",
          description: "Discord channel ID. If not provided, uses DISCORD_DEFAULT_CHANNEL_ID.",
        },
        min_similarity: {
          type: "number",
          description: "Minimum similarity threshold for thread-to-issue matching (0-100 scale, default 50).",
          minimum: 0,
          maximum: 100,
          default: 50,
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
        dry_run: {
          type: "boolean",
          description: "If true, shows what would be exported without actually creating issues in Linear. Useful for testing.",
          default: false,
        },
        update_projects: {
          type: "boolean",
          description: "If true, updates existing Linear issues with their correct project (feature) assignments. Use this to fix issues that were exported before project mapping was added. (Deprecated: use 'update' instead)",
          default: false,
        },
        update: {
          type: "boolean",
          description: "If true, updates existing Linear issues with all differences from database (projects, labels, priority, titles). Compares database state with Linear and updates any differences.",
          default: false,
        },
        update_all_titles: {
          type: "boolean",
          description: "One-time migration: If true, updates ALL existing Linear issues with last comment info in titles. Only updates titles, skips other fields. Format: 'X days ago - Title' (e.g., '1 week ago - Title').",
          default: false,
        },
        update_descriptions: {
          type: "boolean",
          description: "If true, forces update of descriptions to add recommended assignees section based on code ownership. Updates descriptions even if they appear unchanged, to ensure the 'Owner/Recommended Assignee' section is present.",
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
    name: "validate_export_sync",
    description: "Compare our database export tracking with actual Linear issues. Fetches all Linear issues and compares with our database to find: 1) Orphans (in DB but deleted from Linear), 2) Untracked (in Linear but not in our DB), 3) In sync (matching). Useful for debugging export issues.",
    inputSchema: {
      type: "object",
      properties: {
        fix_orphans: {
          type: "boolean",
          description: "If true, reset export status for orphaned items so they can be re-exported. Default: false (report only).",
          default: false,
        },
      },
    },
  },
  {
    name: "export_stats",
    description: "Get comprehensive statistics and reporting about the system state. Returns statistics about GitHub issues (total, open, grouped, ungrouped, labeled, matched to features, exported), groups (total, with features, exported), features, Discord messages/threads, embeddings, and export/sync status. Useful for monitoring and understanding the current state of the system.",
    inputSchema: {
      type: "object",
      properties: {},
      required: [],
    },
  },
  {
    name: "remove_linear_duplicates",
    description: "Find and remove duplicate Linear issues by searching for issues with the same title. Groups issues by normalized title (case-insensitive) and identifies duplicates. In dry-run mode, shows what would be deleted. In actual mode, deletes duplicates keeping the oldest issue (or the one with more information).",
    inputSchema: {
      type: "object",
      properties: {
        dry_run: {
          type: "boolean",
          description: "If true, only shows what would be deleted without actually deleting. Default: true (safe mode).",
          default: true,
        },
        team_name: {
          type: "string",
          description: "Linear team name to check for duplicates. If not provided, uses PM_TOOL_TEAM_ID from config.",
        },
        show_all_titles: {
          type: "boolean",
          description: "If true, shows all issue titles grouped by normalized title to help identify near-duplicates. Default: false.",
          default: false,
        },
      },
      required: [],
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
    name: "match_database_groups_to_features",
    description: "[Issue-centric] Match database groups to product features using semantic similarity (embeddings). Updates the affectsFeatures field in the groups table. Groups are matched based on their aggregated content (title + all issues in the group). Requires OPENAI_API_KEY.",
    inputSchema: {
      type: "object",
      properties: {
        min_similarity: {
          type: "number",
          description: "Minimum similarity threshold for feature matching (0.0-1.0 scale, default 0.5)",
          minimum: 0,
          maximum: 1,
          default: 0.5,
        },
        force: {
          type: "boolean",
          description: "If true, re-match all groups even if they already have affectsFeatures set. If false (default), only match groups without features.",
          default: false,
        },
      },
      required: [],
    },
  },
  {
    name: "match_ungrouped_issues_to_features",
    description: "[Issue-centric] Match ungrouped issues to product features using semantic similarity (embeddings). Updates the affectsFeatures field in the github_issues table. Ungrouped issues are inferred from GitHubIssue table where groupId is null (issues that weren't grouped during grouping). They reuse embeddings from the github_issues table. Requires OPENAI_API_KEY.",
    inputSchema: {
      type: "object",
      properties: {
        min_similarity: {
          type: "number",
          description: "Minimum similarity threshold for feature matching (0.0-1.0 scale, default 0.5)",
          minimum: 0,
          maximum: 1,
          default: 0.5,
        },
        force: {
          type: "boolean",
          description: "If true, re-match all ungrouped issues even if they already have affectsFeatures set. If false (default), only match issues without features.",
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
    name: "match_issues_to_threads",
    description: "[Issue-centric] Match GitHub issues to Discord threads using embedding similarity. Saves matches to issue_thread_matches table. Can run with lower threshold than grouping to find more related discussions. Requires OPENAI_API_KEY for embedding computation.",
    inputSchema: {
      type: "object",
      properties: {
        min_similarity: {
          type: "number",
          description: "Minimum similarity threshold (0-100) for matching issues to threads. Default: 50 (lower than grouping to find more discussions).",
          default: 50,
        },
        include_closed: {
          type: "boolean",
          description: "Include closed GitHub issues (default: false, only open issues)",
          default: false,
        },
        force: {
          type: "boolean",
          description: "If true, recompute all matches. If false (default), only match issues that don't have matches yet.",
          default: false,
        },
        channel_id: {
          type: "string",
          description: "Discord channel ID to match threads from. If not specified, uses all classified threads.",
        },
      },
      required: [],
    },
  },
  {
    name: "sync_linear_status",
    description: "[Issue-centric] Sync GitHub issue states with Linear tickets. Checks if GitHub issues are closed or have merged PRs, then updates Linear ticket status accordingly. One-way sync: GitHub -> Linear. Supports grouped issues (marks Linear as Done only when ALL linked issues are closed).",
    inputSchema: {
      type: "object",
      properties: {
        dry_run: {
          type: "boolean",
          description: "If true, show what would be updated without actually changing Linear (default: false)",
          default: false,
        },
        force: {
          type: "boolean",
          description: "If true, re-check all issues including those already marked as 'done'. If false (default), only checks issues not in 'done' state.",
          default: false,
        },
      },
      required: [],
    },
  },
  {
    name: "sync_pr_based_status",
    description: "[Issue-centric] Sync Linear issue status and assignee based on open PRs connected to GitHub issues. Checks for open PRs and updates Linear issues to 'In Progress' status with assigned user. Only assigns if PR author is an organization engineer. Maps organization engineer GitHub usernames to Linear user IDs.",
    inputSchema: {
      type: "object",
      properties: {
        dry_run: {
          type: "boolean",
          description: "If true, show what would be updated without actually changing Linear (default: false)",
          default: false,
        },
        user_mappings: {
          type: "array",
          description: "Array of user mappings: [{githubUsername: string, linearUserId: string}]. Maps organization engineer GitHub usernames to Linear user IDs.",
          items: {
            type: "object",
            properties: {
              githubUsername: { type: "string" },
              linearUserId: { type: "string" },
            },
            required: ["githubUsername", "linearUserId"],
          },
        },
        organization_engineers: {
          type: "array",
          description: "Array of organization engineer GitHub usernames. Only PRs from these users will trigger assignment.",
          items: {
            type: "string",
          },
        },
        default_assignee_id: {
          type: "string",
          description: "Default Linear user ID to assign if PR author is an organization engineer but no mapping is found",
        },
      },
      required: [],
    },
  },
  {
    name: "sync_combined",
    description: "Combined sync workflow: Runs both PR-based sync and Linear status sync in sequence. Step 1: PR-based sync sets Linear issues to 'In Progress' when open PRs are found and assigns users. Step 2: Linear status sync marks Linear issues as 'Done' when issues are closed or PRs are merged.",
    inputSchema: {
      type: "object",
      properties: {
        dry_run: {
          type: "boolean",
          description: "If true, show what would be updated without actually changing Linear (default: false)",
          default: false,
        },
        force: {
          type: "boolean",
          description: "If true, re-check all issues including those already marked as 'done'. If false (default), only checks issues not in 'done' state.",
          default: false,
        },
        user_mappings: {
          type: "array",
          description: "Array of user mappings: [{githubUsername: string, linearUserId: string}]. Maps organization engineer GitHub usernames to Linear user IDs.",
          items: {
            type: "object",
            properties: {
              githubUsername: { type: "string" },
              linearUserId: { type: "string" },
            },
            required: ["githubUsername", "linearUserId"],
          },
        },
        organization_engineers: {
          type: "array",
          description: "Array of organization engineer GitHub usernames. Only PRs from these users will trigger assignment.",
          items: { type: "string" },
        },
        default_assignee_id: {
          type: "string",
          description: "Default Linear user ID to assign if PR author is an organization engineer but no mapping is found",
        },
      },
      required: [],
    },
  },
  {
    name: "sync_engineer_comments",
    description: "Sync Linear issues based on engineer comments. When a Better Auth engineer comments on a GitHub issue, assign that engineer and set the Linear issue to 'In Progress'. Uses members.csv for engineer list and mappings.",
    inputSchema: {
      type: "object",
      properties: {
        dry_run: {
          type: "boolean",
          description: "If true, show what would be updated without actually changing Linear (default: false)",
          default: false,
        },
        user_mappings: {
          type: "array",
          description: "Array of user mappings: [{githubUsername: string, linearUserId: string}]. Maps organization engineer GitHub usernames to Linear user IDs.",
          items: {
            type: "object",
            properties: {
              githubUsername: { type: "string" },
              linearUserId: { type: "string" },
            },
            required: ["githubUsername", "linearUserId"],
          },
        },
        organization_engineers: {
          type: "array",
          description: "Array of organization engineer GitHub usernames. Comments from these users will trigger assignment.",
          items: { type: "string" },
        },
      },
      required: [],
    },
  },
  {
    name: "audit_and_fix_incorrectly_assigned",
    description: "Audit and fix Linear issues that are incorrectly in Review/In Progress status without valid PR links. Uses stricter matching logic to verify PR links, then reverts incorrectly assigned issues to Todo/Backlog state and clears assignees. This fixes false positives from previous syncs.",
    inputSchema: {
      type: "object",
      properties: {
        dry_run: {
          type: "boolean",
          description: "If true, show what would be fixed without actually changing Linear (default: false)",
          default: false,
        },
        user_mappings: {
          type: "array",
          description: "Array of user mappings: [{githubUsername: string, linearUserId: string}]. Maps organization engineer GitHub usernames to Linear user IDs.",
          items: {
            type: "object",
            properties: {
              githubUsername: { type: "string" },
              linearUserId: { type: "string" },
            },
            required: ["githubUsername", "linearUserId"],
          },
        },
        organization_engineers: {
          type: "array",
          description: "Array of organization engineer GitHub usernames. Only PRs from these users will trigger assignment.",
          items: { type: "string" },
        },
        default_assignee_id: {
          type: "string",
          description: "Default Linear user ID to assign if PR author is an organization engineer but no mapping is found",
        },
      },
      required: [],
    },
  },
  {
    name: "classify_linear_issues",
    description: "Fetch all issues from the configured Linear team and classify them with existing projects (features) or create new projects if needed. Requires PM_TOOL_API_KEY and PM_TOOL_TEAM_ID.",
    inputSchema: {
      type: "object",
      properties: {
        team_name: {
          type: "string",
          description: "Linear team name to fetch issues from (default: 'OpenRundown')",
          default: "OpenRundown",
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
          description: "Linear team name to fetch issues from (default: 'OpenRundown')",
          default: "OpenRundown",
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
    name: "compute_group_embeddings",
    description: "Compute and update embeddings for database groups. Groups are matched based on their aggregated content (suggestedTitle + all issues in the group). This pre-computes embeddings for all groups, which improves performance for group-to-feature matching operations. By default, only computes embeddings for groups that don't have embeddings or have changed content. Set force=true to recompute all embeddings from scratch. Requires OPENAI_API_KEY.",
    inputSchema: {
      type: "object",
      properties: {
        force: {
          type: "boolean",
          description: "If true, recompute all group embeddings from scratch. If false (default), only compute embeddings for groups that don't have embeddings or have changed content.",
          default: false,
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
  {
    name: "analyze_code_ownership",
    description: "Analyze codebase commit history to determine code ownership by engineers. Calculates what percentage of code belongs to each engineer, then maps to features for recommended assignees. This enables automatic assignment suggestions in Linear issues based on who has worked on related code.",
    inputSchema: {
      type: "object",
      properties: {
        force: {
          type: "boolean",
          description: "If true, re-analyze even if recent analysis exists. If false (default), skip if analysis is less than 24 hours old.",
          default: false,
        },
        since: {
          type: "string",
          description: "ISO date string to analyze commits since (e.g., '2024-01-01T00:00:00Z'). If not provided, analyzes all commits.",
        },
        calculate_feature_ownership: {
          type: "boolean",
          description: "If true (default), also calculate feature-level ownership after file analysis. This maps file ownership to features for better assignee recommendations.",
          default: true,
        },
      },
      required: [],
    },
  },
  {
    name: "view_feature_ownership",
    description: "View feature ownership table showing all features and the percentage of code owned by each engineer. Displays as a formatted table with engineer names, ownership percentages, file counts, and total lines.",
    inputSchema: {
      type: "object",
      properties: {
        format: {
          type: "string",
          enum: ["table", "json"],
          description: "Output format: 'table' (markdown table, default) or 'json' (structured data)",
          default: "table",
        },
      },
      required: [],
    },
  },
  // ============================================================================
  // PR Fix Tools - Learning and Fix Generation
  // ============================================================================
  {
    name: "seed_pr_learnings",
    description: "One-time seeding: fetch all historical closed issues with merged PRs and populate the PRLearning table. This bootstraps the learning system with past fixes so investigate_issue has examples from day 1. Requires DATABASE_URL and GITHUB_TOKEN.",
    inputSchema: {
      type: "object",
      properties: {
        since: {
          type: "string",
          description: "ISO date to fetch issues from (e.g., '2023-01-01'). Defaults to all time.",
        },
        limit: {
          type: "number",
          description: "Max number of issues to process. Defaults to all.",
        },
        dry_run: {
          type: "boolean",
          description: "Show what would be seeded without actually storing.",
          default: false,
        },
        batch_size: {
          type: "number",
          description: "Number of issues to process per batch (for rate limiting). Default: 50.",
          default: 50,
        },
      },
      required: [],
    },
  },
  {
    name: "learn_from_pr",
    description: "Learn from a merged PR: store the issue+PR+diff+feedback for future reference. Can be triggered manually or via webhook when PRs are merged. Requires DATABASE_URL and GITHUB_TOKEN.",
    inputSchema: {
      type: "object",
      properties: {
        pr_number: {
          type: "number",
          description: "PR number to learn from.",
        },
        force: {
          type: "boolean",
          description: "Re-learn even if already processed.",
          default: false,
        },
      },
      required: ["pr_number"],
    },
  },
  {
    name: "investigate_issue",
    description: "Investigate a GitHub issue: gather full context (title, body, comments, labels), triage to determine issue type (bug vs config vs feature vs question), and find similar historical fixes from the learning database. Returns recommendation on whether to attempt a fix. Requires DATABASE_URL and GITHUB_TOKEN.",
    inputSchema: {
      type: "object",
      properties: {
        issue_number: {
          type: "number",
          description: "GitHub issue number to investigate.",
        },
        repo: {
          type: "string",
          description: "Repository in format 'owner/repo'. Defaults to GITHUB_REPO_URL from config.",
        },
        include_discord: {
          type: "boolean",
          description: "Include matched Discord threads in context.",
          default: true,
        },
        max_similar_fixes: {
          type: "number",
          description: "Max number of similar historical fixes to return.",
          default: 5,
        },
      },
      required: ["issue_number"],
    },
  },
  {
    name: "open_pr_with_fix",
    description: "Create a draft PR with a generated fix. Takes the fix code as input, creates a branch, commits changes, pushes, and opens a draft PR. Updates Linear with the result if configured. Requires LOCAL_REPO_PATH, DATABASE_URL, and GITHUB_TOKEN with repo scope. REQUIREMENTS: (1) Commit must be one-liner (max 100 chars), (2) Must include unit tests (.test.ts or .spec.ts file), (3) PRs are always opened as draft.",
    inputSchema: {
      type: "object",
      properties: {
        issue_number: {
          type: "number",
          description: "GitHub issue number this fix addresses.",
        },
        issue_title: {
          type: "string",
          description: "Title of the GitHub issue.",
        },
        repo: {
          type: "string",
          description: "Repository in format 'owner/repo'. Defaults to GITHUB_REPO_URL from config.",
        },
        triage_result: {
          type: "string",
          enum: ["bug", "config", "feature", "question", "unclear"],
          description: "Triage result from investigate_issue.",
        },
        triage_confidence: {
          type: "number",
          description: "Triage confidence from investigate_issue (0.0 - 1.0).",
        },
        triage_reasoning: {
          type: "string",
          description: "Reasoning from triage.",
        },
        file_changes: {
          type: "array",
          items: {
            type: "object",
            properties: {
              path: { type: "string", description: "File path relative to repo root" },
              content: { type: "string", description: "New file content (full file)" },
              operation: { type: "string", enum: ["modify", "create", "delete"] },
            },
            required: ["path", "content", "operation"],
          },
          description: "Array of file changes to apply. MUST include at least one test file (.test.ts or .spec.ts).",
        },
        commit_message: {
          type: "string",
          description: "Commit message - MUST be one-liner, max 100 chars (e.g., 'fix(auth): resolve null pointer in session handler'). Put details in pr_body instead.",
        },
        pr_title: {
          type: "string",
          description: "PR title following project conventions.",
        },
        pr_body: {
          type: "string",
          description: "PR description/body. Include all details here since commit must be one-liner.",
        },
        linear_issue_id: {
          type: "string",
          description: "Optional Linear issue ID to add a comment about the PR.",
        },
        assignee: {
          type: "string",
          description: "GitHub username to assign the issue to after PR is created.",
        },
      },
      required: ["issue_number", "issue_title", "triage_result", "triage_confidence", "file_changes", "commit_message", "pr_title", "pr_body"],
    },
  },
  {
    name: "fix_github_issue",
    description: "Full workflow tool to investigate and fix a GitHub issue. Can be called in two modes: (1) Investigation only - returns issue context, triage, similar fixes, and project rules for the AI to generate a fix; (2) Full fix - takes the generated fix and opens a draft PR. Orchestrates investigate_issue + open_pr_with_fix into a single call.",
    inputSchema: {
      type: "object",
      properties: {
        issue_number: {
          type: "number",
          description: "GitHub issue number to investigate/fix.",
        },
        repo: {
          type: "string",
          description: "Repository in format 'owner/repo'. Defaults to GITHUB_REPO_URL from config.",
        },
        linear_issue_id: {
          type: "string",
          description: "Optional Linear issue ID to update with results.",
        },
        fix: {
          type: "object",
          description: "Optional fix to apply. If not provided, returns investigation results only.",
          properties: {
            file_changes: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  path: { type: "string", description: "File path relative to repo root" },
                  content: { type: "string", description: "New file content (full file)" },
                  operation: { type: "string", enum: ["modify", "create", "delete"] },
                },
                required: ["path", "content", "operation"],
              },
              description: "Array of file changes to apply.",
            },
            commit_message: { type: "string", description: "Commit message following project conventions." },
            pr_title: { type: "string", description: "PR title following project conventions." },
            pr_body: { type: "string", description: "PR description/body." },
          },
          required: ["file_changes", "commit_message", "pr_title", "pr_body"],
        },
        skip_investigation: {
          type: "boolean",
          description: "Skip investigation phase (use when you've already investigated).",
          default: false,
        },
        force_attempt: {
          type: "boolean",
          description: "Attempt fix even if not recommended by triage.",
          default: false,
        },
      },
      required: ["issue_number"],
    },
  },

  // ========================================================================
  // Agent Briefing System
  // ========================================================================
  {
    name: "get_agent_briefing",
    description: "Get a structured project context briefing optimized for agent consumption. Returns a compact JSON payload (~300-500 tokens) with active issues, user signals, recent decisions, codebase notes, and activity metrics. Call this at the start of a session to understand the current project state. IMPORTANT: Always pass 'project' — detect it from the workspace git remote (owner/repo) or folder name.",
    inputSchema: {
      type: "object",
      properties: {
        scope: {
          type: "string",
          description: "Optional focus area to filter the briefing (e.g., 'auth', 'billing', 'agent-auth'). When provided, only issues/signals/decisions related to this area are included.",
        },
        since: {
          type: "string",
          description: "Optional ISO timestamp to look back from. Defaults to last 14 days. Use the timestamp from a previous session to see only what changed.",
        },
        project: {
          type: "string",
          description: "Project identifier — use 'owner/repo' from the workspace git remote origin, or the workspace folder name if no remote. The MCP server cannot detect your workspace, so always pass this.",
        },
      },
      required: [],
    },
  },
  {
    name: "start_agent_session",
    description: "Start a new agent session for tracking purposes. Returns a session ID that should be passed to end_agent_session when the session completes. IMPORTANT: Always pass 'project' — detect it from the workspace git remote (owner/repo) or folder name.",
    inputSchema: {
      type: "object",
      properties: {
        scope: {
          type: "array",
          items: { type: "string" },
          description: "Areas the agent plans to work on (e.g., ['agent-auth', 'mcp-tools.ts']).",
        },
        project: {
          type: "string",
          description: "Project identifier — use 'owner/repo' from the workspace git remote origin, or the workspace folder name if no remote. The MCP server cannot detect your workspace, so always pass this.",
        },
      },
      required: [],
    },
  },
  {
    name: "end_agent_session",
    description: "End an agent session and record what was accomplished. Stores files edited, decisions made, open items, and issues referenced so future briefings can highlight changes.",
    inputSchema: {
      type: "object",
      properties: {
        session_id: {
          type: "string",
          description: "Session ID returned by start_agent_session.",
        },
        files_edited: {
          type: "array",
          items: { type: "string" },
          description: "List of files edited during this session.",
        },
        decisions_made: {
          type: "array",
          items: { type: "string" },
          description: "Key decisions made during this session (e.g., 'split mcp-tools into separate files').",
        },
        open_items: {
          type: "array",
          items: { type: "string" },
          description: "Items left open that need follow-up.",
        },
        issues_referenced: {
          type: "array",
          items: { type: "string" },
          description: "Issue IDs referenced during the session (e.g., ['#423', '#451']).",
        },
        tools_used: {
          type: "array",
          items: { type: "string" },
          description: "MCP tools used during the session.",
        },
        summary: {
          type: "string",
          description: "Brief summary of what was accomplished.",
        },
      },
      required: ["session_id"],
    },
  },
  {
    name: "update_agent_session",
    description: "Incrementally update a running agent session. Merges new data with existing session data (arrays are deduplicated). Use this to record progress mid-session without ending it.",
    inputSchema: {
      type: "object",
      properties: {
        session_id: {
          type: "string",
          description: "Session ID returned by start_agent_session.",
        },
        scope: {
          type: "array",
          items: { type: "string" },
          description: "Additional scope areas discovered during work.",
        },
        files_edited: {
          type: "array",
          items: { type: "string" },
          description: "Additional files edited.",
        },
        decisions_made: {
          type: "array",
          items: { type: "string" },
          description: "Additional decisions made.",
        },
        open_items: {
          type: "array",
          items: { type: "string" },
          description: "Additional open items.",
        },
        issues_referenced: {
          type: "array",
          items: { type: "string" },
          description: "Additional issues referenced.",
        },
        tools_used: {
          type: "array",
          items: { type: "string" },
          description: "Additional tools used.",
        },
        summary: {
          type: "string",
          description: "Updated session summary (replaces previous).",
        },
      },
      required: ["session_id"],
    },
  },
  {
    name: "get_session_history",
    description: "Get recent agent session history for the current project. Shows what agents worked on in past sessions, including files edited, decisions made, and open items. Useful for understanding recent context and picking up where the last session left off.",
    inputSchema: {
      type: "object",
      properties: {
        limit: {
          type: "number",
          description: "Number of recent sessions to return (default: 5).",
        },
        session_id: {
          type: "string",
          description: "Optional specific session ID to retrieve (ignores project filter).",
        },
        project: {
          type: "string",
          description: "Optional project identifier to filter sessions. Defaults to the auto-detected current project.",
        },
      },
      required: [],
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

        // Initialize token manager (supports multiple comma-separated tokens and GitHub App)
        const { GitHubTokenManager } = await import("../connectors/github/tokenManager.js");
        const tokenManager = await GitHubTokenManager.fromEnvironment();
        
        if (!tokenManager) {
          throw new Error("GITHUB_TOKEN or GitHub App configuration is required. Configure one or both for automatic rate limit rotation. Tokens: GITHUB_TOKEN=token1,token2. GitHub App: GITHUB_APP_ID, GITHUB_APP_INSTALLATION_ID, GITHUB_APP_PRIVATE_KEY_PATH.");
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
          
          const issues = (await response.json()) as Array<{ number: number; pull_request?: { url: string; html_url: string; diff_url: string; patch_url: string } | null }>;
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

    case "compute_group_embeddings": {
      if (!process.env.OPENAI_API_KEY) {
        throw new Error("OPENAI_API_KEY is required for computing group embeddings.");
      }

      const { computeAndSaveGroupEmbeddings } = await import("../storage/db/embeddings.js");
      
      const force = (args?.force === true);
      
      console.error("[Embeddings] Starting group embeddings computation...");
      if (force) {
        console.error("[Embeddings] Force mode enabled - will recompute all group embeddings from scratch");
      } else {
        console.error("[Embeddings] Incremental mode - will only compute embeddings for groups that don't have them or have changed content");
      }
      
      const result = await computeAndSaveGroupEmbeddings(process.env.OPENAI_API_KEY, undefined, force);

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              success: true,
              message: `Group embeddings computed: ${result.computed} computed, ${result.cached} cached, ${result.total} total`,
              computed: result.computed,
              cached: result.cached,
              total: result.total,
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
        // Check database first if configured, then fall back to file cache
        let existingCache: DiscordCache | null = null;
        let sinceDate: string | undefined = undefined;

        if (incremental) {
          // Try database first
          const { hasDatabaseConfig: hasDbConfigFetch, getStorage: getStorageFetch } = await import("../storage/factory.js");
          if (hasDbConfigFetch()) {
            try {
              const storage = getStorageFetch();
              const dbAvailable = await storage.isAvailable();
              if (dbAvailable) {
                const dbSinceDate = await storage.getMostRecentDiscordMessageDate(actualChannelId);
                if (dbSinceDate) {
                  sinceDate = dbSinceDate;
                  console.error(`[FetchDiscord] Using database for incremental fetch. Most recent message: ${sinceDate}`);
                }
              }
            } catch (dbError) {
              console.error(`[FetchDiscord] Failed to check database for incremental date:`, dbError);
            }
          }

          // Fall back to file cache if no database date found
          if (!sinceDate) {
          try {
            const foundCachePath = await findDiscordCacheFile(actualChannelId);
            if (foundCachePath) {
              existingCache = await loadDiscordCache(foundCachePath);
              sinceDate = getMostRecentMessageDate(existingCache);
                if (sinceDate) {
                  console.error(`[FetchDiscord] Using file cache for incremental fetch. Most recent message: ${sinceDate}`);
                }
            }
          } catch (error) {
            // Cache doesn't exist or invalid
            }
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
      const tokenManager = await GitHubTokenManager.fromEnvironment();
      
      if (!tokenManager) {
        throw new Error("GITHUB_TOKEN or GitHub App configuration is required. Configure one or both for automatic rate limit rotation. Tokens: GITHUB_TOKEN=token1,token2. GitHub App: GITHUB_APP_ID, GITHUB_APP_INSTALLATION_ID, GITHUB_APP_PRIVATE_KEY_PATH.");
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

    case "sync_classify_and_export": {
      // Issue-centric workflow: GitHub issues are primary, Discord threads attached as context
      // All steps are incremental (only process new/unprocessed items)
      // All matching uses embeddings
      const { channel_id, min_similarity = 50 } = args as {
        channel_id?: string;
        min_similarity?: number;
      };

      const config = getConfig();
      const actualChannelId = channel_id || config.discord.defaultChannelId;

      if (!actualChannelId) {
        throw new Error("Channel ID is required. Provide channel_id parameter or set DISCORD_DEFAULT_CHANNEL_ID in environment variables.");
      }

      // Verify prerequisites
      const { hasDatabaseConfig, getStorage } = await import("../storage/factory.js");
      if (!hasDatabaseConfig()) {
        throw new Error("DATABASE_URL is required for issue-centric workflow.");
      }
      const storage = getStorage();
      if (!await storage.isAvailable()) {
        throw new Error("Database is not available.");
      }

      const apiKey = process.env.OPENAI_API_KEY;
      if (!apiKey) {
        throw new Error("OPENAI_API_KEY is required for embeddings-based matching.");
      }

      const { prisma } = await import("../storage/db/prisma.js");
      const results: {
        steps: Array<{ step: string; status: string; result?: Record<string, unknown>; error?: string }>;
        summary: Record<string, unknown>;
      } = { steps: [], summary: {} };

      // Local cosine similarity function
      const cosineSimilarity = (a: number[], b: number[]): number => {
        if (a.length !== b.length) return 0;
        let dotProduct = 0, normA = 0, normB = 0;
        for (let i = 0; i < a.length; i++) {
          dotProduct += a[i] * b[i];
          normA += a[i] * a[i];
          normB += b[i] * b[i];
        }
        const denom = Math.sqrt(normA) * Math.sqrt(normB);
        return denom === 0 ? 0 : dotProduct / denom;
      };

      try {
        // =====================================================================
        // STEP 1: Sync GitHub issues (incremental)
        // =====================================================================
        console.error("[Sync] Step 1: Fetching new GitHub issues...");
        
        const existingIssues = await prisma.gitHubIssue.findMany({
          select: { issueNumber: true, issueUpdatedAt: true },
          orderBy: { issueUpdatedAt: "desc" },
          take: 1,
        });
        const sinceDate = existingIssues[0]?.issueUpdatedAt?.toISOString();
        
        const { GitHubTokenManager } = await import("../connectors/github/tokenManager.js");
        const tokenManager = await GitHubTokenManager.fromEnvironment();
        if (!tokenManager) {
          throw new Error("GITHUB_TOKEN is required.");
        }

        const newIssues = await fetchAllGitHubIssues(tokenManager, true, undefined, undefined, sinceDate, undefined, true);
        
        if (newIssues.length > 0) {
          const issuesToSave = newIssues.map((issue) => ({
            number: issue.number, title: issue.title, url: issue.html_url, state: issue.state,
            body: issue.body || undefined, labels: issue.labels.map((l) => l.name),
            author: issue.user.login, created_at: issue.created_at, updated_at: issue.updated_at,
            comments: issue.comments || [], assignees: issue.assignees || [],
            milestone: issue.milestone || null, reactions: issue.reactions || null,
          }));
          await storage.saveGitHubIssues(issuesToSave);
        }

        const totalIssues = await prisma.gitHubIssue.count();
        const openIssues = await prisma.gitHubIssue.count({ where: { issueState: "open" } });
          results.steps.push({
          step: "fetch_github_issues",
            status: "success",
          result: { total: totalIssues, open: openIssues, new_synced: newIssues.length },
        });

        // =====================================================================
        // STEP 2: Check Discord messages in database
        // =====================================================================
        console.error("[Sync] Step 2: Checking Discord messages...");
        const discordCount = await storage.getDiscordMessageCount(actualChannelId);
        results.steps.push({
          step: "check_discord",
          status: discordCount > 0 ? "success" : "warning",
            result: {
            total: discordCount,
            message: discordCount > 0 ? "Messages available" : "Run fetch_discord_messages first",
            },
          });

        // =====================================================================
        // STEP 3: Compute embeddings (incremental - only new)
        // Ensure ALL embeddings are computed: issues, threads, features, groups
        // =====================================================================
        console.error("[Sync] Step 3: Computing embeddings for new issues, threads, features, and groups...");
        const { 
          computeAndSaveIssueEmbeddings, 
          computeAndSaveThreadEmbeddings,
          computeAndSaveFeatureEmbeddings,
          computeAndSaveGroupEmbeddings,
        } = await import("../storage/db/embeddings.js");
        
        const issueEmbResult = await computeAndSaveIssueEmbeddings(apiKey, undefined, false);
        const threadEmbResult = await computeAndSaveThreadEmbeddings(apiKey, { channelId: actualChannelId });
        
        // Compute feature embeddings (required for feature matching)
        console.error("[Sync] Step 3: Computing feature embeddings...");
        const featureEmbResult = await computeAndSaveFeatureEmbeddings(apiKey, undefined, false);
        
        // Compute group embeddings (required for group feature matching)
        console.error("[Sync] Step 3: Computing group embeddings...");
        const groupEmbResult = await computeAndSaveGroupEmbeddings(apiKey, undefined, false);
        
          results.steps.push({
          step: "compute_embeddings",
          status: "success",
            result: {
            issues: { computed: issueEmbResult.computed, cached: issueEmbResult.cached },
            threads: { computed: threadEmbResult.computed, cached: threadEmbResult.cached },
            features: { computed: featureEmbResult.computed, cached: featureEmbResult.cached },
            groups: { computed: groupEmbResult.computed, cached: groupEmbResult.cached },
            },
          });

        // =====================================================================
        // STEP 4: Group GitHub issues (incremental - only ungrouped)
        // =====================================================================
        console.error("[Sync] Step 4: Grouping ungrouped GitHub issues...");
        const ungroupedIssues = await prisma.gitHubIssue.findMany({
          where: { issueState: "open", groupId: null },
          select: { issueNumber: true },
        });

        let groupsCreated = 0;
        let issuesGrouped = 0;

        if (ungroupedIssues.length > 0) {
          // Load embeddings for ungrouped issues
          const issueEmbs = await prisma.issueEmbedding.findMany({
            where: { issueNumber: { in: ungroupedIssues.map(i => i.issueNumber) } },
          });
          const embMap = new Map(issueEmbs.map(e => [e.issueNumber, e.embedding as number[]]));

          // Simple clustering: group issues with similarity >= 80%
          const grouped = new Set<number>();
          const newGroups: number[][] = [];

          for (const issue of ungroupedIssues) {
            if (grouped.has(issue.issueNumber)) continue;
            const emb1 = embMap.get(issue.issueNumber);
            if (!emb1) continue;

            const group = [issue.issueNumber];
            grouped.add(issue.issueNumber);

            for (const other of ungroupedIssues) {
              if (grouped.has(other.issueNumber)) continue;
              const emb2 = embMap.get(other.issueNumber);
              if (!emb2) continue;

              const sim = cosineSimilarity(emb1, emb2) * 100;
              if (sim >= 80) {
                group.push(other.issueNumber);
                grouped.add(other.issueNumber);
              }
            }

            if (group.length > 1) {
              newGroups.push(group);
            }
          }

          // Save groups to database
          for (const group of newGroups) {
            const groupId = `issue-group-${group[0]}-${Date.now()}`;
            const firstIssue = await prisma.gitHubIssue.findUnique({
              where: { issueNumber: group[0] },
              select: { issueTitle: true },
            });

            await prisma.group.create({
              data: {
                id: groupId,
                channelId: actualChannelId,
                githubIssueNumber: group[0],
                suggestedTitle: firstIssue?.issueTitle || `Group ${group[0]}`,
                threadCount: 0,
                status: "pending",
              },
            });

            // Link issues to group
            for (const issueNum of group) {
              await prisma.gitHubIssue.update({
                where: { issueNumber: issueNum },
                data: { groupId }, // inGroup is redundant - groupId not null = in group
              });
            }

            groupsCreated++;
            issuesGrouped += group.length;
          }
        }

        results.steps.push({
          step: "group_issues",
          status: "success",
          result: { ungrouped_checked: ungroupedIssues.length, groups_created: groupsCreated, issues_grouped: issuesGrouped },
        });

        // =====================================================================
        // STEP 5: Match Discord threads to issues (incremental - embeddings)
        // =====================================================================
        console.error("[Sync] Step 5: Matching Discord threads to issues...");
        
        // Get issues not yet matched to threads
        const unmatchedIssues = await prisma.gitHubIssue.findMany({
          where: { issueState: "open", matchedToThreads: false },
          select: { issueNumber: true },
        });

        let matchesCreated = 0;

        if (unmatchedIssues.length > 0 && discordCount > 0) {
          const issueEmbs = await prisma.issueEmbedding.findMany({
            where: { issueNumber: { in: unmatchedIssues.map(i => i.issueNumber) } },
          });
          const threadEmbs = await prisma.threadEmbedding.findMany({
            include: { thread: { select: { threadName: true, firstMessageUrl: true } } },
          });

          for (const issueEmb of issueEmbs) {
            const issueVec = issueEmb.embedding as number[];
            const matches: Array<{ threadId: string; similarity: number; threadName: string | null }> = [];

            for (const threadEmb of threadEmbs) {
              const threadVec = threadEmb.embedding as number[];
              const sim = cosineSimilarity(issueVec, threadVec) * 100;
              if (sim >= min_similarity) {
                matches.push({ threadId: threadEmb.threadId, similarity: sim, threadName: threadEmb.thread?.threadName || null });
              }
            }

            if (matches.length > 0) {
              // Save top matches
              for (const match of matches.slice(0, 5)) {
                await prisma.issueThreadMatch.upsert({
                  where: { issueNumber_threadId: { issueNumber: issueEmb.issueNumber, threadId: match.threadId } },
                  create: {
                    issueNumber: issueEmb.issueNumber,
                    threadId: match.threadId,
                    threadName: match.threadName,
                    similarityScore: match.similarity,
                    matchMethod: "embedding",
                  },
                  update: { similarityScore: match.similarity },
                });
                matchesCreated++;
              }

              await prisma.gitHubIssue.update({
                where: { issueNumber: issueEmb.issueNumber },
                data: { matchedToThreads: true },
              });
            }
          }
        }

        results.steps.push({
          step: "match_threads",
          status: "success",
          result: { issues_checked: unmatchedIssues.length, matches_created: matchesCreated },
        });

        // =====================================================================
        // STEP 6: Label issues (incremental - only unlabeled)
        // Uses batch LLM labeling for efficiency
        // =====================================================================
        console.error("[Sync] Step 6: Labeling unlabeled issues...");
        
        const unlabeledIssues = await prisma.gitHubIssue.findMany({
          where: { issueState: "open", detectedLabels: { isEmpty: true } },
          select: { issueNumber: true, issueTitle: true, issueBody: true },
          take: 20, // Batch limit for LLM calls
        });

        let issuesLabeled = 0;
        const validLabels = ["security", "bug", "regression", "urgent", "enhancement", "documentation", "assistance"];

        if (unlabeledIssues.length > 0) {
          // Process in batches of 10 for LLM
          const batchSize = 10;
          for (let i = 0; i < unlabeledIssues.length; i += batchSize) {
            const batch = unlabeledIssues.slice(i, i + batchSize);
            
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
                  messages: [{
                    role: "system",
                    content: `You are an issue classifier. For each issue, output ONLY valid labels from: ${validLabels.join(", ")}. Format: [1] label1, label2\n[2] label1`,
                  }, {
                    role: "user",
                    content: batchContent,
                  }],
                  temperature: 0,
                  max_tokens: 500,
                }),
              });
              
              if (response.ok) {
                const data = await response.json() as { choices: Array<{ message: { content: string } }> };
                const text = data.choices[0]?.message?.content || "";
                
                // Parse labels for each issue
                for (let j = 0; j < batch.length; j++) {
                  const pattern = new RegExp(`\\[${j + 1}\\]\\s*([^\\[\\n]+)`, "i");
                  const match = text.match(pattern);
                  if (match) {
                    const labels = match[1].split(",").map(l => l.trim().toLowerCase()).filter(l => validLabels.includes(l));
                    if (labels.length > 0) {
                      await prisma.gitHubIssue.update({
                        where: { issueNumber: batch[j].issueNumber },
                        data: { detectedLabels: labels },
                      });
                      issuesLabeled++;
                    }
                  }
                }
              }
            } catch (err) {
              console.error(`[Sync] Failed to label batch:`, err);
            }
          }
        }

        results.steps.push({
          step: "label_issues",
          status: "success",
          result: { unlabeled_checked: unlabeledIssues.length, issues_labeled: issuesLabeled },
        });

        // =====================================================================
        // STEP 7: Match to features (incremental - embeddings)
        // Order: 1) Ungrouped issues first, 2) Then groups
        // =====================================================================
        console.error("[Sync] Step 7: Matching to features (ungrouped issues first, then groups)...");
        
        // STEP 7a: Match ungrouped issues to features first
        console.error("[Sync] Step 7a: Matching ungrouped issues to features...");
        const unmatchedUngroupedIssues = await prisma.gitHubIssue.findMany({
          where: { 
            issueState: "open", 
            groupId: null, // Ungrouped issues
            affectsFeatures: { equals: [] },
          },
          select: { issueNumber: true },
          take: 50,
        });

        let ungroupedFeaturesMatched = 0;

        if (unmatchedUngroupedIssues.length > 0) {
          const features = await prisma.feature.findMany({
            include: { embedding: true },
          });

          if (features.length > 0) {
            const issueEmbs = await prisma.issueEmbedding.findMany({
              where: { issueNumber: { in: unmatchedUngroupedIssues.map(i => i.issueNumber) } },
            });

            for (const issueEmb of issueEmbs) {
              const issueVec = issueEmb.embedding as number[];
              const matchedFeatures: Array<{ id: string; name: string }> = [];

              for (const feature of features) {
                if (!feature.embedding) continue;
                const featureVec = feature.embedding.embedding as number[];
                const sim = cosineSimilarity(issueVec, featureVec);
                if (sim >= 0.5) {
                  matchedFeatures.push({ id: feature.id, name: feature.name });
                }
              }

              if (matchedFeatures.length > 0) {
                await prisma.gitHubIssue.update({
                  where: { issueNumber: issueEmb.issueNumber },
                  data: { affectsFeatures: matchedFeatures },
                });
                ungroupedFeaturesMatched++;
              }
            }
          }
        }

        // STEP 7b: Match grouped issues to features (issues that are in groups)
        console.error("[Sync] Step 7b: Matching grouped issues to features...");
        const unmatchedGroupedIssues = await prisma.gitHubIssue.findMany({
          where: { 
            issueState: "open", 
            groupId: { not: null }, // Issues in groups
            affectsFeatures: { equals: [] },
          },
          select: { issueNumber: true },
          take: 50,
        });

        let groupedIssuesFeaturesMatched = 0;

        if (unmatchedGroupedIssues.length > 0) {
          const features = await prisma.feature.findMany({
            include: { embedding: true },
          });

          if (features.length > 0) {
            const issueEmbs = await prisma.issueEmbedding.findMany({
              where: { issueNumber: { in: unmatchedGroupedIssues.map(i => i.issueNumber) } },
            });

            for (const issueEmb of issueEmbs) {
              const issueVec = issueEmb.embedding as number[];
              const matchedFeatures: Array<{ id: string; name: string }> = [];

              for (const feature of features) {
                if (!feature.embedding) continue;
                const featureVec = feature.embedding.embedding as number[];
                const sim = cosineSimilarity(issueVec, featureVec);
                if (sim >= 0.5) {
                  matchedFeatures.push({ id: feature.id, name: feature.name });
                }
              }

              if (matchedFeatures.length > 0) {
                await prisma.gitHubIssue.update({
                  where: { issueNumber: issueEmb.issueNumber },
                  data: { affectsFeatures: matchedFeatures },
                });
                groupedIssuesFeaturesMatched++;
              }
            }
          }
        }

        // STEP 7c: Match groups to features (group-level matching)
        // Actually call match_database_groups_to_features to match groups
        console.error("[Sync] Step 7c: Matching groups to features...");
        let groupsMatched = 0;
        let groupsChecked = 0;
        
        try {
          // Get unexported groups (groups without features or force=true)
          const allGroups = await prisma.group.findMany({
            include: {
              githubIssues: {
                select: {
                  issueNumber: true,
                  issueTitle: true,
                  issueBody: true,
                  issueLabels: true,
                },
              },
            },
          });
          
          groupsChecked = allGroups.length;
          
          // Filter groups that need matching (no affectsFeatures or empty)
          const groupsToMatch = allGroups.filter(group => {
            const features = group.affectsFeatures as unknown[];
            return !features || !Array.isArray(features) || features.length === 0;
          });
          
          if (groupsToMatch.length > 0) {
            // Load feature embeddings
            const featuresWithEmbeddings = await prisma.feature.findMany({
              include: { embedding: true },
            });
            
            // Load group embeddings (should already be computed in Step 3)
            const groupEmbeddings = await prisma.groupEmbedding.findMany({
              where: { groupId: { in: groupsToMatch.map(g => g.id) } },
            });
            const groupEmbMap = new Map(groupEmbeddings.map(ge => [ge.groupId, ge.embedding as number[]]));
            
            // Build feature embedding map
            const featureEmbeddingMap = new Map<string, number[]>();
            for (const feature of featuresWithEmbeddings) {
              if (feature.embedding?.embedding) {
                featureEmbeddingMap.set(feature.id, feature.embedding.embedding as number[]);
              }
            }
            
            // Match each group to features
            for (const group of groupsToMatch) {
              const groupEmb = groupEmbMap.get(group.id);
              if (!groupEmb) {
                console.error(`[Sync] No embedding found for group ${group.id}, skipping`);
                continue;
              }
              
              const matchedFeatures: Array<{ id: string; name: string }> = [];
              
              for (const feature of featuresWithEmbeddings) {
                if (!feature.embedding) continue;
                const featureVec = feature.embedding.embedding as number[];
                const sim = cosineSimilarity(groupEmb, featureVec);
                if (sim >= 0.5) {
                  matchedFeatures.push({ id: feature.id, name: feature.name });
                }
              }
              
              if (matchedFeatures.length > 0) {
                await prisma.group.update({
                  where: { id: group.id },
                  data: { affectsFeatures: matchedFeatures },
                });
                groupsMatched++;
              }
            }
          }
        } catch (groupMatchError) {
          console.error(`[Sync] Error matching groups to features:`, groupMatchError);
          results.steps.push({
            step: "match_groups_to_features",
            status: "error",
            error: groupMatchError instanceof Error ? groupMatchError.message : String(groupMatchError),
          });
        }

        results.steps.push({
          step: "match_features",
          status: "success",
          result: { 
            ungrouped_issues_checked: unmatchedUngroupedIssues.length, 
            ungrouped_issues_matched: ungroupedFeaturesMatched,
            grouped_issues_checked: unmatchedGroupedIssues.length,
            grouped_issues_matched: groupedIssuesFeaturesMatched,
            groups_checked: groupsChecked,
            groups_matched: groupsMatched,
          },
        });

        // =====================================================================
        // STEP 8: Export unexported issues to PM tool (Linear)
        // =====================================================================
        console.error("[Sync] Step 8: Exporting unexported issues to Linear...");
        
        let issuesExported = 0;
        let exportSkipped = false;
        let exportError: string | undefined;

        const pmApiKey = process.env.PM_TOOL_API_KEY;
        const pmTeamId = process.env.PM_TOOL_TEAM_ID;

        if (!pmApiKey || !pmTeamId) {
          exportSkipped = true;
          exportError = "PM_TOOL_API_KEY or PM_TOOL_TEAM_ID not configured";
        } else {
          try {
            // Get unexported open issues
            const unexportedIssues = await prisma.gitHubIssue.findMany({
              where: { 
                issueState: "open", 
                OR: [
                  { exportStatus: null },
                  { exportStatus: "pending" },
                ],
              },
              select: { 
                issueNumber: true, 
                issueTitle: true, 
                issueBody: true, 
                issueUrl: true,
                issueLabels: true,
                detectedLabels: true,
                affectsFeatures: true,
              },
              take: 20, // Batch limit
            });

            if (unexportedIssues.length > 0) {
              const { exportIssuesToPMTool } = await import("../export/groupingExporter.js");
              
              const pmToolConfig = {
                type: "linear" as const,
                api_key: pmApiKey,
                team_id: pmTeamId,
              };

              const exportResult = await exportIssuesToPMTool(pmToolConfig, {
                include_closed: false,
                channelId: actualChannelId,
                update: true, // Update existing Linear issues (including titles with last comment info)
              });

              issuesExported = exportResult.issues_exported?.created || 0;
            }
          } catch (err) {
            exportError = err instanceof Error ? err.message : String(err);
          }
        }

        results.steps.push({
          step: "export_to_linear",
          status: exportSkipped ? "skipped" : (exportError ? "error" : "success"),
          result: exportSkipped 
            ? { message: exportError }
            : { issues_exported: issuesExported },
          ...(exportError && !exportSkipped ? { error: exportError } : {}),
        });

        // =====================================================================
        // STEP 9: Sync Linear status (mark done if GitHub issues closed)
        // =====================================================================
        console.error("[Sync] Step 9: Syncing Linear status...");
        
        let ticketsMarkedDone = 0;
        let syncError: string | undefined;

        if (!pmApiKey) {
          results.steps.push({
            step: "sync_linear_status",
            status: "skipped",
            result: { message: "PM_TOOL_API_KEY not configured" },
          });
        } else {
          try {
            const { syncLinearStatus } = await import("../sync/linearStatusSync.js");
            const syncResult = await syncLinearStatus({ dryRun: false });
            ticketsMarkedDone = syncResult.markedDone || 0;
            
            results.steps.push({
              step: "sync_linear_status",
              status: "success",
              result: {
                tickets_checked: syncResult.totalLinearTickets || 0,
                tickets_marked_done: ticketsMarkedDone,
                tickets_marked_review: syncResult.markedReview || 0,
              },
            });
          } catch (err) {
            syncError = err instanceof Error ? err.message : String(err);
            results.steps.push({
              step: "sync_linear_status",
              status: "error",
              error: syncError,
            });
          }
        }

        // =====================================================================
        // STEP 10: Sync PR-based status (set In Progress when PRs are open)
        // =====================================================================
        console.error("[Sync] Step 10: Syncing PR-based Linear status...");
        
        let prSyncUpdated = 0;
        let prSyncError: string | undefined;

        if (!pmApiKey || !pmTeamId) {
          results.steps.push({
            step: "sync_pr_status",
            status: "skipped",
            result: { message: "PM_TOOL_API_KEY or PM_TOOL_TEAM_ID not configured" },
          });
        } else {
          try {
            const { syncPRBasedStatus } = await import("../sync/prBasedSync.js");
            const prSyncResult = await syncPRBasedStatus({ 
              dryRun: false,
              // Note: userMappings, organizationEngineers, defaultAssigneeId could be passed as options
              // For now, using defaults (can be configured via environment or tool options)
            });
            prSyncUpdated = prSyncResult.updated || 0;
            
            results.steps.push({
              step: "sync_pr_status",
              status: "success",
              result: {
                total_issues: prSyncResult.totalIssues || 0,
                updated: prSyncResult.updated || 0,
                set_to_in_progress: prSyncResult.setToInProgress || 0,
                set_to_review: prSyncResult.setToReview || 0,
                unchanged: prSyncResult.unchanged || 0,
                skipped: prSyncResult.skipped || 0,
                errors: prSyncResult.errors || 0,
              },
            });
          } catch (err) {
            prSyncError = err instanceof Error ? err.message : String(err);
            results.steps.push({
              step: "sync_pr_status",
              status: "error",
              error: prSyncError,
            });
          }
        }

        // =====================================================================
        // SUMMARY
        // =====================================================================
        results.summary = {
          github_issues: { total: totalIssues, open: openIssues, new_synced: newIssues.length },
          discord_messages: discordCount,
          embeddings: { 
            issues: issueEmbResult.computed + issueEmbResult.cached, 
            threads: threadEmbResult.computed + threadEmbResult.cached,
            features: featureEmbResult.computed + featureEmbResult.cached,
            groups: groupEmbResult.computed + groupEmbResult.cached,
          },
          grouping: { groups_created: groupsCreated, issues_grouped: issuesGrouped },
          thread_matching: { matches_created: matchesCreated },
          labeling: { issues_labeled: issuesLabeled },
          feature_matching: { 
            ungrouped_issues_matched: ungroupedFeaturesMatched,
            grouped_issues_matched: groupedIssuesFeaturesMatched,
            groups_matched: groupsMatched,
            total_issues_matched: ungroupedFeaturesMatched + groupedIssuesFeaturesMatched,
          },
          export: { issues_exported: issuesExported, skipped: exportSkipped },
          linear_sync: { 
            tickets_marked_done: ticketsMarkedDone,
            pr_sync_updated: prSyncUpdated,
          },
        };

        return {
          content: [{
              type: "text",
              text: JSON.stringify({
                success: true,
              message: "Issue-centric sync complete. All steps incremental with embeddings.",
                ...results,
              }, null, 2),
          }],
        };

      } catch (error) {
        results.steps.push({
          step: "error",
          status: "failed",
          error: error instanceof Error ? error.message : String(error),
        });

        return {
          content: [{
              type: "text",
              text: JSON.stringify({
                success: false,
                message: "Sync failed",
                error: error instanceof Error ? error.message : String(error),
                ...results,
              }, null, 2),
          }],
        };
      }
    }

    case "export_to_pm_tool": {
      const { 
        use_issue_centric = true, // Default to issue-centric approach (always use DB)
        channel_id,
        include_closed,
        dry_run = false,
        update_projects = false,
        update = false,
        update_all_titles = false,
        update_descriptions = false,
      } = args as {
        use_issue_centric?: boolean;
        channel_id?: string;
        include_closed?: boolean;
        dry_run?: boolean;
        update_projects?: boolean;
        update?: boolean;
        update_all_titles?: boolean;
        update_descriptions?: boolean;
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

        // Check database availability - use database if available, JSON file as fallback
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
          console.error(`[Export] Database not available - will save export results to JSON file as fallback`);
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
        // Support both update (new) and update_projects (legacy) - update takes precedence
        const updateFlag = update || update_projects;
        result = await exportIssuesToPMTool(pmToolConfig, {
          include_closed: include_closed ?? false,
          channelId: actualChannelId,
          dry_run: dry_run,
          update: updateFlag,
          update_projects: update_projects, // Keep for backward compatibility
          update_all_titles: update_all_titles,
          update_descriptions: update_descriptions,
        });

        if (!result) {
          throw new Error("Export failed: No result returned from export operation");
        }

        // Save export results - database preferred, JSON file as fallback
        const timestamp = Date.now();
        const exportResultId = `export-${pmToolConfig.type}-${timestamp}`;
        let exportResultsPath: string | undefined;
        
        if (dbAvailable) {
          // Save to database (preferred)
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
            // If database save fails, fall back to JSON file
            const errorMessage = dbError instanceof Error ? dbError.message : String(dbError);
            console.error(`[Export] Failed to save export result to database: ${errorMessage}, falling back to JSON file`);
            dbAvailable = false; // Force JSON fallback
          }
        }
        
        if (!dbAvailable) {
          // Fallback: Save to JSON file only if database is not available
          exportResultsPath = join(resultsDir, `export-${pmToolConfig.type}-${timestamp}.json`);
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
          
          await mkdir(resultsDir, { recursive: true });
          await writeFile(exportResultsPath, JSON.stringify(exportResultData, null, 2), "utf-8");
          console.error(`[Export] Saved export result to JSON file: ${exportResultsPath}`);
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
                ...(dbAvailable ? { database_record: exportResultId } : {}),
                ...(exportResultsPath ? { results_saved_to: exportResultsPath } : {}),
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

    case "validate_export_sync": {
      const { fix_orphans = false } = args as { fix_orphans?: boolean };

      try {
        // Check required config
        if (!process.env.PM_TOOL_API_KEY) {
          throw new Error("PM_TOOL_API_KEY is required");
        }
        if (!process.env.PM_TOOL_TEAM_ID) {
          throw new Error("PM_TOOL_TEAM_ID is required");
        }

        const { hasDatabaseConfig, getStorage } = await import("../storage/factory.js");
        if (!hasDatabaseConfig()) {
          throw new Error("DATABASE_URL is required");
        }

        const { prisma } = await import("../storage/db/prisma.js");
        const teamId = process.env.PM_TOOL_TEAM_ID;

        console.error("[ValidateSync] Fetching all Linear issues...");

        // Fetch ALL Linear issues (including archived) with pagination
        const allLinearIssues: Array<{ id: string; identifier: string; title: string }> = [];
        let hasNextPage = true;
        let cursor: string | null = null;

        while (hasNextPage) {
          const query = `
            query GetAllTeamIssues($teamId: String!, $first: Int!, $after: String) {
              team(id: $teamId) {
                issues(first: $first, after: $after, includeArchived: true) {
                  nodes { id identifier title }
                  pageInfo { hasNextPage endCursor }
                }
              }
            }
          `;

          const response = await fetch("https://api.linear.app/graphql", {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "Authorization": process.env.PM_TOOL_API_KEY!,
            },
            body: JSON.stringify({ query, variables: { teamId, first: 100, after: cursor } }),
          });

          const result = await response.json() as {
            data?: {
              team?: {
                issues?: {
                  nodes?: Array<{ id: string; identifier: string; title: string }>;
                  pageInfo?: { hasNextPage: boolean; endCursor: string };
                };
              };
            };
          };

          const nodes = result.data?.team?.issues?.nodes || [];
          allLinearIssues.push(...nodes);
          hasNextPage = result.data?.team?.issues?.pageInfo?.hasNextPage || false;
          cursor = result.data?.team?.issues?.pageInfo?.endCursor || null;
        }

        console.error(`[ValidateSync] Found ${allLinearIssues.length} Linear issues`);
        const linearIssueIds = new Set(allLinearIssues.map(i => i.id));
        const linearIdentifiers = new Map(allLinearIssues.map(i => [i.id, i.identifier]));

        // Get our exported items from DB
        const ourExportedIssues = await prisma.gitHubIssue.findMany({
          where: { linearIssueId: { not: null } },
          select: { issueNumber: true, issueTitle: true, linearIssueId: true, linearIssueIdentifier: true },
        });

        const ourExportedGroups = await prisma.group.findMany({
          where: { linearIssueId: { not: null } },
          select: { id: true, suggestedTitle: true, linearIssueId: true, linearIssueIdentifier: true },
        });

        // Find orphans (in our DB but not in Linear)
        const orphanIssues = ourExportedIssues.filter(i => !linearIssueIds.has(i.linearIssueId!));
        const orphanGroups = ourExportedGroups.filter(g => !linearIssueIds.has(g.linearIssueId!));

        // Find in-sync items
        const syncedIssues = ourExportedIssues.filter(i => linearIssueIds.has(i.linearIssueId!));
        const syncedGroups = ourExportedGroups.filter(g => linearIssueIds.has(g.linearIssueId!));

        // Find untracked (in Linear but not in our DB)
        const ourLinearIds = new Set([
          ...ourExportedIssues.map(i => i.linearIssueId),
          ...ourExportedGroups.map(g => g.linearIssueId),
        ]);
        const untrackedLinear = allLinearIssues.filter(i => !ourLinearIds.has(i.id));

        const summary = {
          linear_total: allLinearIssues.length,
          our_db: {
            exported_issues: ourExportedIssues.length,
            exported_groups: ourExportedGroups.length,
            total: ourExportedIssues.length + ourExportedGroups.length,
          },
          in_sync: {
            issues: syncedIssues.length,
            groups: syncedGroups.length,
            total: syncedIssues.length + syncedGroups.length,
          },
          orphans: {
            issues: orphanIssues.length,
            groups: orphanGroups.length,
            total: orphanIssues.length + orphanGroups.length,
            sample_issues: orphanIssues.slice(0, 5).map(i => ({
              issue_number: i.issueNumber,
              linear_identifier: i.linearIssueIdentifier,
            })),
            sample_groups: orphanGroups.slice(0, 5).map(g => ({
              group_id: g.id,
              linear_identifier: g.linearIssueIdentifier,
            })),
          },
          untracked_in_linear: {
            count: untrackedLinear.length,
            sample: untrackedLinear.slice(0, 10).map(i => ({
              identifier: i.identifier,
              title: i.title.substring(0, 50),
            })),
          },
        };

        let fixResult = null;

        // Fix orphans if requested
        if (fix_orphans && (orphanIssues.length > 0 || orphanGroups.length > 0)) {
          console.error(`[ValidateSync] Fixing ${orphanIssues.length} orphaned issues and ${orphanGroups.length} orphaned groups...`);

          if (orphanIssues.length > 0) {
            await prisma.gitHubIssue.updateMany({
              where: { issueNumber: { in: orphanIssues.map(i => i.issueNumber) } },
              data: {
                exportStatus: null,
                exportedAt: null,
                linearIssueId: null,
                linearIssueUrl: null,
                linearIssueIdentifier: null,
              },
            });
          }

          if (orphanGroups.length > 0) {
            await prisma.group.updateMany({
              where: { id: { in: orphanGroups.map(g => g.id) } },
              data: {
                status: "pending",
                exportedAt: null,
                linearIssueId: null,
                linearIssueUrl: null,
                linearIssueIdentifier: null,
              },
            });
          }

          fixResult = {
            issues_reset: orphanIssues.length,
            groups_reset: orphanGroups.length,
            message: "Orphans reset. Run export again to re-export them.",
          };
        }

        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              success: true,
              summary,
              fix_result: fixResult,
              message: orphanIssues.length + orphanGroups.length > 0
                ? `Found ${orphanIssues.length + orphanGroups.length} orphans. ${fix_orphans ? "Fixed!" : "Use fix_orphans=true to reset them."}`
                : "All exported items are in sync with Linear!",
            }, null, 2),
          }],
        };

      } catch (error) {
        throw new Error(`Validation failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    case "remove_linear_duplicates": {
      const { dry_run = true, team_name, show_all_titles = false } = args as { dry_run?: boolean; team_name?: string; show_all_titles?: boolean };

      try {
        // Check required config
        if (!process.env.PM_TOOL_API_KEY) {
          throw new Error("PM_TOOL_API_KEY is required");
        }

        const { LinearIntegration } = await import("../export/linear/client.js");
        const pmToolConfig = {
          type: "linear" as const,
          api_key: process.env.PM_TOOL_API_KEY,
          team_id: process.env.PM_TOOL_TEAM_ID || undefined,
        };

        const linearTool = new LinearIntegration(pmToolConfig);

        // Get team ID
        let teamId = process.env.PM_TOOL_TEAM_ID;
        if (team_name && !teamId) {
          // Try to find team by name
          const teams = await linearTool.listTeams();
          const team = teams.find(t => t.name.toLowerCase() === team_name.toLowerCase());
          if (team) {
            teamId = team.id;
          } else {
            throw new Error(`Team "${team_name}" not found. Available teams: ${teams.map(t => t.name).join(", ")}`);
          }
        }

        if (!teamId) {
          throw new Error("PM_TOOL_TEAM_ID is required or provide team_name");
        }

        console.error(`[RemoveDuplicates] Fetching active Linear issues for team ${teamId} (excluding archived)...`);

        // Fetch active issues from the team (exclude archived to reduce fetch time)
        // Use GraphQL directly to get all issues with pagination
        const allIssues: Array<{
          id: string;
          identifier: string;
          url: string;
          title: string;
          description?: string;
          state: string;
        }> = [];

        let hasNextPage = true;
        let cursor: string | null = null;
        const pageSize = 100;

        while (hasNextPage) {
          const query = `
            query GetTeamIssues($teamId: String!, $first: Int!, $after: String) {
              team(id: $teamId) {
                issues(first: $first, after: $after, includeArchived: false) {
                  nodes {
                    id
                    identifier
                    url
                    title
                    description
                    state {
                      name
                    }
                  }
                  pageInfo {
                    hasNextPage
                    endCursor
                  }
                }
              }
            }
          `;

          const response = await fetch("https://api.linear.app/graphql", {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "Authorization": process.env.PM_TOOL_API_KEY!,
            },
            body: JSON.stringify({
              query,
              variables: { teamId, first: pageSize, after: cursor },
            }),
          });

          const result = await response.json() as {
            data?: {
              team?: {
                issues?: {
                  nodes?: Array<{
                    id: string;
                    identifier: string;
                    url: string;
                    title: string;
                    description?: string | null;
                    state?: { name: string };
                  }>;
                  pageInfo?: { hasNextPage: boolean; endCursor: string | null };
                };
              };
            };
            errors?: Array<{ message: string }>;
          };

          if (result.errors) {
            throw new Error(`GraphQL errors: ${result.errors.map(e => e.message).join(", ")}`);
          }

          const nodes = result.data?.team?.issues?.nodes || [];
          allIssues.push(...nodes.map(i => ({
            id: i.id,
            identifier: i.identifier,
            url: i.url,
            title: i.title,
            description: i.description || undefined,
            state: i.state?.name || "Unknown",
          })));

          hasNextPage = result.data?.team?.issues?.pageInfo?.hasNextPage || false;
          cursor = result.data?.team?.issues?.pageInfo?.endCursor || null;

          if (hasNextPage) {
            console.error(`[RemoveDuplicates] Fetched ${allIssues.length} issues so far, fetching more...`);
          }
        }

        console.error(`[RemoveDuplicates] Found ${allIssues.length} total issues (including archived)`);
        
        // Debug: Show state distribution
        const stateCounts = new Map<string, number>();
        for (const issue of allIssues) {
          stateCounts.set(issue.state, (stateCounts.get(issue.state) || 0) + 1);
        }
        console.error(`[RemoveDuplicates] Issues by state: ${Array.from(stateCounts.entries()).map(([state, count]) => `${state}: ${count}`).join(", ")}`);

        // Normalize title for comparison (lowercase, trim, remove extra spaces, remove punctuation differences)
        // More aggressive normalization to catch more duplicates including those with different punctuation
        const normalizeTitle = (title: string): string => {
          if (!title) return "";
          return title
            .toLowerCase()
            .trim() // Trim at start
            .normalize("NFD") // Normalize Unicode characters (é -> e + ´)
            .replace(/[\u0300-\u036f]/g, "") // Remove diacritics
            .replace(/\s+/g, " ") // Multiple spaces to single space
            .replace(/[.,!?;:'"`\-_()\[\]{}]/g, "") // Remove punctuation and special chars
            .replace(/\s+/g, " ") // Clean up spaces again
            .trim(); // Trim at end (important - removes leading/trailing spaces after punctuation removal)
        };

        // Group issues by normalized title
        const titleGroups = new Map<string, Array<typeof allIssues[0]>>();
        for (const issue of allIssues) {
          const normalized = normalizeTitle(issue.title);
          if (!titleGroups.has(normalized)) {
            titleGroups.set(normalized, []);
          }
          titleGroups.get(normalized)!.push(issue);
        }
        
        // Debug: Show some example titles to verify we're getting all issues
        console.error(`[RemoveDuplicates] Sample titles (first 10): ${allIssues.slice(0, 10).map(i => `"${i.title}" (${i.state})`).join(", ")}`);

        // Find duplicates (groups with more than 1 issue)
        const duplicates: Array<{
          title: string;
          normalized_title: string;
          issues: Array<{
            id: string;
            identifier: string;
            url: string;
            title: string;
            state: string;
            description_length: number;
          }>;
          keep: {
            id: string;
            identifier: string;
            reason: string;
          };
          remove: Array<{
            id: string;
            identifier: string;
            url: string;
          }>;
        }> = [];

        for (const [normalizedTitle, issues] of titleGroups.entries()) {
          if (issues.length > 1) {
            // Sort issues: prefer open issues, then by description length (more info), then by identifier (older)
            const sorted = [...issues].sort((a, b) => {
              // Prefer open issues over closed
              const aOpen = a.state.toLowerCase() !== "done" && a.state.toLowerCase() !== "canceled";
              const bOpen = b.state.toLowerCase() !== "done" && b.state.toLowerCase() !== "canceled";
              if (aOpen !== bOpen) {
                return aOpen ? -1 : 1;
              }
              // Prefer issues with more description
              const aDescLen = a.description?.length || 0;
              const bDescLen = b.description?.length || 0;
              if (aDescLen !== bDescLen) {
                return bDescLen - aDescLen;
              }
              // Prefer older issues (lower identifier number)
              return a.identifier.localeCompare(b.identifier);
            });

            const keep = sorted[0];
            const remove = sorted.slice(1);

            duplicates.push({
              title: keep.title,
              normalized_title: normalizedTitle,
              issues: sorted.map(i => ({
                id: i.id,
                identifier: i.identifier,
                url: i.url,
                title: i.title,
                state: i.state,
                description_length: i.description?.length || 0,
              })),
              keep: {
                id: keep.id,
                identifier: keep.identifier,
                reason: sorted.length > 1 && sorted[0].state.toLowerCase() !== "done" && sorted[0].state.toLowerCase() !== "canceled"
                  ? "Open issue"
                  : sorted[0].description && sorted[0].description.length > (sorted[1]?.description?.length || 0)
                    ? "More detailed description"
                    : "Oldest issue",
              },
              remove: remove.map(i => ({
                id: i.id,
                identifier: i.identifier,
                url: i.url,
              })),
            });
          }
        }

        console.error(`[RemoveDuplicates] Found ${duplicates.length} sets of duplicates (${duplicates.reduce((sum, d) => sum + d.remove.length, 0)} issues to remove)`);
        console.error(`[RemoveDuplicates] Total title groups: ${titleGroups.size}, Groups with duplicates: ${duplicates.length}`);

        // If show_all_titles is true, show all titles grouped by normalized title
        if (show_all_titles) {
          // Show groups with 2+ issues first, then all others
          const duplicateGroups = Array.from(titleGroups.entries())
            .filter(([_, issues]) => issues.length > 1)
            .map(([normalized, issues]) => ({
              normalized_title: normalized,
              count: issues.length,
              issues: issues.map(i => ({
                identifier: i.identifier,
                title: i.title,
                state: i.state,
                url: i.url,
              })),
            }))
            .sort((a, b) => b.count - a.count);

          const singleGroups = Array.from(titleGroups.entries())
            .filter(([_, issues]) => issues.length === 1)
            .map(([normalized, issues]) => ({
              normalized_title: normalized,
              count: 1,
              issues: issues.map(i => ({
                identifier: i.identifier,
                title: i.title,
                state: i.state,
                url: i.url,
              })),
            }))
            .slice(0, 50); // Limit to first 50 for readability

          return {
            content: [{
              type: "text",
              text: JSON.stringify({
                success: true,
                debug_mode: true,
                message: `Showing all ${allIssues.length} issues grouped by normalized title.`,
                total_issues: allIssues.length,
                duplicate_groups: duplicateGroups,
                sample_single_groups: singleGroups,
                note: "Groups with count > 1 are exact duplicates. Check 'duplicate_groups' array above.",
              }, null, 2),
            }],
          };
        }

        if (dry_run && duplicates.length === 0) {
          // If no duplicates found, show a helpful message with some sample titles
          const sampleTitles = Array.from(titleGroups.entries())
            .slice(0, 20)
            .map(([normalized, issues]) => ({
              normalized: normalized,
              count: issues.length,
              titles: issues.map(i => i.title),
            }));

          return {
            content: [{
              type: "text",
              text: JSON.stringify({
                success: true,
                dry_run: true,
                message: `Found 0 exact duplicates. Showing sample of normalized titles for debugging.`,
                total_issues: allIssues.length,
                total_title_groups: titleGroups.size,
                sample_titles: sampleTitles,
                note: "If you see duplicates in Linear, they might have slightly different titles. Use show_all_titles=true to see all titles grouped.",
              }, null, 2),
            }],
          };
        }

        if (dry_run) {
          const titleGroupsArray = Array.from(titleGroups.entries())
            .map(([normalized, issues]) => ({
              normalized_title: normalized,
              count: issues.length,
              issues: issues.map(i => ({
                identifier: i.identifier,
                title: i.title,
                state: i.state,
                url: i.url,
              })),
            }))
            .sort((a, b) => b.count - a.count); // Sort by count (most duplicates first)

          return {
            content: [{
              type: "text",
              text: JSON.stringify({
                success: true,
                debug_mode: true,
                message: `Showing all ${allIssues.length} issues grouped by normalized title. Look for groups with count > 1.`,
                total_issues: allIssues.length,
                title_groups: titleGroupsArray,
                duplicates_found: duplicates.length,
                note: "Groups with count > 1 are exact duplicates. Similar titles with count = 1 might be near-duplicates.",
              }, null, 2),
            }],
          };
        }

        if (dry_run) {
          return {
            content: [{
              type: "text",
              text: JSON.stringify({
                success: true,
                dry_run: true,
                message: `Found ${duplicates.length} sets of duplicates. ${duplicates.reduce((sum, d) => sum + d.remove.length, 0)} issues would be removed.`,
                total_duplicate_sets: duplicates.length,
                total_issues_to_remove: duplicates.reduce((sum, d) => sum + d.remove.length, 0),
                duplicates: duplicates.map(d => ({
                  title: d.title,
                  keep: d.keep,
                  remove: d.remove,
                  all_issues: d.issues,
                })),
                note: "Set dry_run=false to actually remove duplicates",
              }, null, 2),
            }],
          };
        }

        // Actually delete duplicates
        const deleted: Array<{ id: string; identifier: string; url: string }> = [];
        const errors: Array<{ id: string; identifier: string; error: string }> = [];

        const DELAY_BETWEEN_REQUESTS = 500; // 500ms delay to avoid rate limiting
        let processed = 0;
        const totalToProcess = duplicates.reduce((sum, d) => sum + d.remove.length, 0);

        for (const dup of duplicates) {
          for (const issueToRemove of dup.remove) {
            processed++;
            try {
              // First archive (soft delete) - required before permanent deletion
              const archiveQuery = `
                mutation ArchiveIssue($id: String!) {
                  issueArchive(id: $id) {
                    success
                  }
                }
              `;

              const archiveResponse = await fetch("https://api.linear.app/graphql", {
                method: "POST",
                headers: {
                  "Content-Type": "application/json",
                  "Authorization": process.env.PM_TOOL_API_KEY!,
                },
                body: JSON.stringify({
                  query: archiveQuery,
                  variables: { id: issueToRemove.id },
                }),
              });

              const archiveResult = await archiveResponse.json() as {
                data?: { issueArchive?: { success: boolean } };
                errors?: Array<{ message: string }>;
              };

              // Log full archive API response including HTTP status
              console.error(`[RemoveDuplicates] [${processed}/${totalToProcess}] Archive API request for ${issueToRemove.identifier} (ID: ${issueToRemove.id}):`);
              console.error(`  HTTP Status: ${archiveResponse.status} ${archiveResponse.statusText}`);
              console.error(`  Response: ${JSON.stringify(archiveResult, null, 2)}`);

              if (!archiveResult.data?.issueArchive?.success) {
                const errorMsg = archiveResult.errors?.map(e => e.message).join(", ") || "Unknown error";
                const fullError = `[${processed}/${totalToProcess}] Failed to archive ${issueToRemove.identifier}: ${errorMsg}`;
                errors.push({ id: issueToRemove.id, identifier: issueToRemove.identifier, error: fullError });
                console.error(`[RemoveDuplicates] ${fullError}`);
                continue;
              }

              // Wait longer between archive and delete (1 second to ensure archiving completes)
              await new Promise(resolve => setTimeout(resolve, 1000));

              // Now permanently delete
              const deleteQuery = `
                mutation DeleteIssue($id: String!) {
                  issueDelete(id: $id) {
                    success
                  }
                }
              `;

              const deleteResponse = await fetch("https://api.linear.app/graphql", {
                method: "POST",
                headers: {
                  "Content-Type": "application/json",
                  "Authorization": process.env.PM_TOOL_API_KEY!,
                },
                body: JSON.stringify({
                  query: deleteQuery,
                  variables: { id: issueToRemove.id },
                }),
              });

              const deleteResult = await deleteResponse.json() as {
                data?: { issueDelete?: { success: boolean } };
                errors?: Array<{ message: string }>;
              };

              // Log full delete API response including HTTP status
              console.error(`[RemoveDuplicates] [${processed}/${totalToProcess}] Delete API request for ${issueToRemove.identifier} (ID: ${issueToRemove.id}):`);
              console.error(`  HTTP Status: ${deleteResponse.status} ${deleteResponse.statusText}`);
              console.error(`  Response: ${JSON.stringify(deleteResult, null, 2)}`);

              if (deleteResult.data?.issueDelete?.success) {
                deleted.push(issueToRemove);
                console.error(`[RemoveDuplicates] [${processed}/${totalToProcess}] Permanently deleted ${issueToRemove.identifier}: ${issueToRemove.url}`);
              } else {
                const errorMsg = deleteResult.errors?.map(e => e.message).join(", ") || JSON.stringify(deleteResult);
                const fullError = `[${processed}/${totalToProcess}] Failed to permanently delete ${issueToRemove.identifier} (was archived): ${errorMsg}`;
                errors.push({ id: issueToRemove.id, identifier: issueToRemove.identifier, error: fullError });
                console.error(`[RemoveDuplicates] ${fullError}`);
              }

              // Delay between issues to respect rate limits
              if (processed < totalToProcess) {
                await new Promise(resolve => setTimeout(resolve, DELAY_BETWEEN_REQUESTS));
              }
            } catch (error) {
              const errorMsg = error instanceof Error ? error.message : String(error);
              const fullError = `[${processed}/${totalToProcess}] Error deleting ${issueToRemove.identifier}: ${errorMsg}`;
              errors.push({ id: issueToRemove.id, identifier: issueToRemove.identifier, error: fullError });
              console.error(`[RemoveDuplicates] ${fullError}`, error);
            }
          }
        }

        // Update database to remove references to deleted issues
        if (deleted.length > 0) {
          try {
            const { prisma } = await import("../storage/db/prisma.js");
            const deletedIds = new Set(deleted.map(d => d.id));

            // Update GitHub issues
            await prisma.gitHubIssue.updateMany({
              where: { linearIssueId: { in: Array.from(deletedIds) } },
              data: {
                exportStatus: "pending",
                exportedAt: null,
                linearIssueId: null,
                linearIssueUrl: null,
                linearIssueIdentifier: null,
              },
            });

            // Update groups
            await prisma.group.updateMany({
              where: { linearIssueId: { in: Array.from(deletedIds) } },
              data: {
                status: "pending",
                exportedAt: null,
                linearIssueId: null,
                linearIssueUrl: null,
                linearIssueIdentifier: null,
              },
            });

            console.error(`[RemoveDuplicates] Updated database to remove references to ${deleted.length} deleted issues`);
          } catch (error) {
            console.error(`[RemoveDuplicates] Error updating database:`, error);
          }
        }

        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              success: true,
              dry_run: false,
              message: `Removed ${deleted.length} duplicate issues. ${errors.length} errors.`,
              total_duplicate_sets: duplicates.length,
              deleted: deleted.map(d => ({
                identifier: d.identifier,
                url: d.url,
              })),
              errors: errors.length > 0 ? errors : undefined,
              kept: duplicates.map(d => d.keep),
            }, null, 2),
          }],
        };

      } catch (error) {
        throw new Error(`Remove duplicates failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    case "export_stats": {
      try {
        const { hasDatabaseConfig, getStorage } = await import("../storage/factory.js");
        if (!hasDatabaseConfig()) {
          throw new Error("Database is required for statistics. Please configure DATABASE_URL.");
        }

        const storage = getStorage();
        const dbAvailable = await storage.isAvailable();
        if (!dbAvailable) {
          throw new Error("Database is not available. Please check your DATABASE_URL configuration.");
        }

        const { prisma } = await import("../storage/db/prisma.js");

        console.error("[Stats] Gathering comprehensive statistics...");

        // GitHub Issues Statistics
        const totalIssues = await prisma.gitHubIssue.count();
        const openIssues = await prisma.gitHubIssue.count({ where: { issueState: "open" } });
        const closedIssues = await prisma.gitHubIssue.count({ where: { issueState: "closed" } });
        
        const groupedIssues = await prisma.gitHubIssue.count({ where: { groupId: { not: null } } });
        const ungroupedIssues = await prisma.gitHubIssue.count({ where: { groupId: null } });
        
        const labeledIssues = await prisma.gitHubIssue.count({ 
          where: { 
            detectedLabels: { isEmpty: false },
          },
        });
        
        const issuesWithFeatures = await prisma.gitHubIssue.count({
          where: {
            affectsFeatures: { not: { equals: [] } },
          },
        });
        
        const exportedIssues = await prisma.gitHubIssue.count({ 
          where: { linearIssueId: { not: null } },
        });
        
        const matchedToThreads = await prisma.gitHubIssue.count({
          where: { matchedToThreads: true },
        });

        // Groups Statistics
        const totalGroups = await prisma.group.count();
        const groupsWithFeatures = await prisma.group.count({
          where: {
            affectsFeatures: { not: { equals: [] } },
          },
        });
        const exportedGroups = await prisma.group.count({
          where: { linearIssueId: { not: null } },
        });
        const pendingGroups = await prisma.group.count({
          where: { status: "pending" },
        });

        // Features Statistics
        const totalFeatures = await prisma.feature.count();
        const featuresWithEmbeddings = await prisma.feature.count({
          where: { embedding: { isNot: null } },
        });

        // Discord Statistics
        const totalDiscordMessages = await prisma.discordMessage.count();
        const totalThreads = await prisma.classifiedThread.count();
        
        // Thread Matches
        const threadMatches = await prisma.issueThreadMatch.count();

        // Embeddings Statistics
        const issueEmbeddings = await prisma.issueEmbedding.count();
        const threadEmbeddings = await prisma.threadEmbedding.count();
        const featureEmbeddings = await prisma.featureEmbedding.count();
        const groupEmbeddings = await prisma.groupEmbedding.count();

        // Export Status Breakdown
        const pendingExportIssues = await prisma.gitHubIssue.count({
          where: {
            issueState: "open",
            OR: [
              { exportStatus: null },
              { exportStatus: "pending" },
            ],
          },
        });

        const stats = {
          github_issues: {
            total: totalIssues,
            open: openIssues,
            closed: closedIssues,
            grouped: groupedIssues,
            ungrouped: ungroupedIssues,
            labeled: labeledIssues,
            matched_to_features: issuesWithFeatures,
            matched_to_threads: matchedToThreads,
            exported: exportedIssues,
            pending_export: pendingExportIssues,
          },
          groups: {
            total: totalGroups,
            with_features: groupsWithFeatures,
            exported: exportedGroups,
            pending: pendingGroups,
          },
          features: {
            total: totalFeatures,
            with_embeddings: featuresWithEmbeddings,
          },
          discord: {
            messages: totalDiscordMessages,
            threads: totalThreads,
            thread_matches: threadMatches,
          },
          embeddings: {
            issues: issueEmbeddings,
            threads: threadEmbeddings,
            features: featureEmbeddings,
            groups: groupEmbeddings,
          },
          completion_rates: {
            issues_labeled: totalIssues > 0 ? ((labeledIssues / totalIssues) * 100).toFixed(1) + "%" : "0%",
            issues_matched_to_features: totalIssues > 0 ? ((issuesWithFeatures / totalIssues) * 100).toFixed(1) + "%" : "0%",
            issues_exported: openIssues > 0 ? ((exportedIssues / openIssues) * 100).toFixed(1) + "%" : "0%",
            groups_with_features: totalGroups > 0 ? ((groupsWithFeatures / totalGroups) * 100).toFixed(1) + "%" : "0%",
            groups_exported: totalGroups > 0 ? ((exportedGroups / totalGroups) * 100).toFixed(1) + "%" : "0%",
          },
        };

        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              success: true,
              message: "Statistics retrieved successfully",
              stats,
              timestamp: new Date().toISOString(),
            }, null, 2),
          }],
        };

      } catch (error) {
        logError("Export stats failed:", error);
        throw new Error(`Export stats failed: ${error instanceof Error ? error.message : String(error)}`);
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

        // STEP 5b: Match threads to issues using embeddings (direct comparison)
        const threadMatchThreshold = min_similarity / 100; // Use same threshold
        const issueThreadsMap = new Map<number, Array<{ threadId: string; threadName: string | null; similarity: number }>>();
        const newMatches: Array<{ threadId: string; issueNumber: number; similarity: number; issueTitle: string; issueUrl: string; matchMethod: string }> = [];

        console.error(`[GroupIssues] Matching threads to issues using embeddings...`);
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
                matchMethod: "embedding",
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
                  matchMethod: match.matchMethod, // embedding_with_code when code context used
                  messageCount: threadDetail?.messageCount || 0,
                  firstMessageAt: threadDetail?.firstMessageTimestamp || null,
                },
                update: {
                  similarityScore: match.similarity,
                  matchMethod: match.matchMethod,
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

          // Update issues to mark them as grouped (inGroup is redundant - groupId not null = in group)
          await prisma.gitHubIssue.updateMany({
            where: { issueNumber: { in: group.issues } },
            data: { groupId: group.id },
          });
        }

        // Mark ungrouped issues (inGroup is redundant - groupId null = not in group)
        await prisma.gitHubIssue.updateMany({
          where: { issueNumber: { in: ungroupedIssues } },
          data: { groupId: null },
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

    case "match_ungrouped_issues_to_features": {
      const {
        min_similarity = 0.5,
        force = false,
      } = args as {
        min_similarity?: number;
        force?: boolean;
      };

      try {
        if (!process.env.OPENAI_API_KEY) {
          throw new Error("OPENAI_API_KEY is required for ungrouped issue feature matching.");
        }

        // Verify database is available
        const { hasDatabaseConfig, getStorage } = await import("../storage/factory.js");
        if (!hasDatabaseConfig()) {
          throw new Error("Database is required for ungrouped issue feature matching. Please configure DATABASE_URL.");
        }

        const storage = getStorage();
        const dbAvailable = await storage.isAvailable();
        if (!dbAvailable) {
          throw new Error("Database is not available. Please check your DATABASE_URL configuration.");
        }

        const { prisma } = await import("../storage/db/prisma.js");

        // STEP 1: Load features from database
        console.error(`[Ungrouped Issue Feature Matching] Loading features from database...`);
        const dbFeatures = await prisma.feature.findMany({
          include: {
            embedding: true,
          },
        });
        console.error(`[Ungrouped Issue Feature Matching] Found ${dbFeatures.length} features`);

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

        // STEP 2: Load ungrouped issues from database (inferred from GitHubIssue table where groupId is null)
        console.error(`[Ungrouped Issue Feature Matching] Loading ungrouped issues from database...`);
        const allDbUngroupedIssues = await prisma.gitHubIssue.findMany({
          where: { 
            groupId: null, // Issues not in any group (inGroup is redundant - groupId null = not in group)
          },
          select: {
            issueNumber: true,
            issueTitle: true,
            issueBody: true,
            issueLabels: true,
            affectsFeatures: true,
          },
        });
        
        // Filter based on force flag - if not force, only match issues without features
        const allUngroupedIssues = force 
          ? allDbUngroupedIssues 
          : allDbUngroupedIssues.filter(issue => {
              const features = issue.affectsFeatures as unknown[];
              return !features || !Array.isArray(features) || features.length === 0;
            });
        console.error(`[Ungrouped Issue Feature Matching] Found ${allUngroupedIssues.length} ungrouped issues to match (${allDbUngroupedIssues.length} total, force=${force})`);

        if (allUngroupedIssues.length === 0) {
          return {
            content: [{
              type: "text",
              text: JSON.stringify({
                success: true,
                message: force 
                  ? "No ungrouped issues found in database. Run group_github_issues first."
                  : "All ungrouped issues already have features matched. Use force=true to re-match.",
                stats: { total_issues: 0, matched: 0, skipped: 0 },
              }, null, 2),
            }],
          };
        }

        // STEP 3: Ensure issue embeddings exist (ungrouped issues can reuse embeddings from GitHubIssue table)
        console.error(`[Ungrouped Issue Feature Matching] Ensuring issue embeddings exist...`);
        const { computeAndSaveIssueEmbeddings } = await import("../storage/db/embeddings.js");
        await computeAndSaveIssueEmbeddings(process.env.OPENAI_API_KEY, undefined, false);

        // STEP 4: Load feature embeddings (compute if missing)
        console.error(`[Ungrouped Issue Feature Matching] Loading feature embeddings...`);
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
        console.error(`[Ungrouped Issue Feature Matching] Loaded ${featureEmbeddingMap.size} feature embeddings`);

        // STEP 5: Load code-to-feature mappings for additional matching
        console.error(`[Ungrouped Issue Feature Matching] Loading code-to-feature mappings...`);
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
        console.error(`[Ungrouped Issue Feature Matching] Found code mappings for ${codeToFeatureMap.size} features`);

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

        // STEP 6: Match each ungrouped issue to features
        console.error(`[Ungrouped Issue Feature Matching] Matching ${allUngroupedIssues.length} ungrouped issues to features...`);
        let matchedCount = 0;
        let skippedCount = 0;
        const matchResults: Array<{ issueNumber: number; features: Array<{ id: string; name: string; similarity: number }> }> = [];

        // Load issue embeddings (ungrouped issues reuse embeddings from IssueEmbedding table)
        const issueEmbeddings = await prisma.issueEmbedding.findMany({
          where: { issueNumber: { in: allUngroupedIssues.map(i => i.issueNumber) } },
        });
        const issueEmbeddingMap = new Map<number, number[]>();
        for (const emb of issueEmbeddings) {
          issueEmbeddingMap.set(emb.issueNumber, emb.embedding as number[]);
        }

        for (const issue of allUngroupedIssues) {
          const issueEmb = issueEmbeddingMap.get(issue.issueNumber);
          
          if (!issueEmb) {
            console.error(`[Ungrouped Issue Feature Matching] No embedding for ungrouped issue #${issue.issueNumber}, skipping`);
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

          // Update ungrouped issue in database (using GitHubIssue table)
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
            console.error(`[Ungrouped Issue Feature Matching] Matched ${matchedCount}/${allUngroupedIssues.length} issues...`);
          }
        }

        console.error(`[Ungrouped Issue Feature Matching] Completed: ${matchedCount} matched, ${skippedCount} skipped`);

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
              message: `Matched ${matchedCount} ungrouped issues to features`,
              stats: {
                total_issues: allUngroupedIssues.length,
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
        logError("Ungrouped issue feature matching failed:", error);
        throw new Error(`Ungrouped issue feature matching failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    case "match_database_groups_to_features": {
      const {
        min_similarity = 0.5,
        force = false,
      } = args as {
        min_similarity?: number;
        force?: boolean;
      };

      try {
        if (!process.env.OPENAI_API_KEY) {
          throw new Error("OPENAI_API_KEY is required for group feature matching.");
        }

        // Verify database is available
        const { hasDatabaseConfig, getStorage } = await import("../storage/factory.js");
        if (!hasDatabaseConfig()) {
          throw new Error("Database is required for group feature matching. Please configure DATABASE_URL.");
        }

        const storage = getStorage();
        const dbAvailable = await storage.isAvailable();
        if (!dbAvailable) {
          throw new Error("Database is not available. Please check your DATABASE_URL configuration.");
        }

        const { prisma } = await import("../storage/db/prisma.js");

        // STEP 1: Load features from database
        console.error(`[Group Feature Matching] Loading features from database...`);
        const dbFeatures = await prisma.feature.findMany({
          include: {
            embedding: true,
          },
        });
        console.error(`[Group Feature Matching] Found ${dbFeatures.length} features`);

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

        // STEP 2: Load groups from database
        console.error(`[Group Feature Matching] Loading groups from database...`);
        const allDbGroups = await prisma.group.findMany({
          include: {
            githubIssues: {
              select: {
                issueNumber: true,
                issueTitle: true,
                issueBody: true,
                issueLabels: true,
              },
            },
          },
        });
        
        // Filter groups based on force flag - if not force, only match groups without features
        const allGroups = force 
          ? allDbGroups 
          : allDbGroups.filter(group => {
              const features = group.affectsFeatures as unknown[];
              return !features || !Array.isArray(features) || features.length === 0;
            });
        console.error(`[Group Feature Matching] Found ${allGroups.length} groups to match (${allDbGroups.length} total, force=${force})`);

        if (allGroups.length === 0) {
          return {
            content: [{
              type: "text",
              text: JSON.stringify({
                success: true,
                message: force 
                  ? "No groups found in database. Run group_github_issues first."
                  : "All groups already have features matched. Use force=true to re-match.",
                stats: { total_groups: 0, matched: 0, skipped: 0 },
              }, null, 2),
            }],
          };
        }

        // STEP 3: Compute/load group embeddings
        console.error(`[Group Feature Matching] Computing group embeddings...`);
        const { computeAndSaveGroupEmbeddings } = await import("../storage/db/embeddings.js");
        const embeddingResult = await computeAndSaveGroupEmbeddings(process.env.OPENAI_API_KEY, undefined, false);
        console.error(`[Group Feature Matching] Group embeddings: ${embeddingResult.computed} computed, ${embeddingResult.cached} cached`);

        // STEP 4: Load feature embeddings (compute if missing)
        console.error(`[Group Feature Matching] Loading feature embeddings...`);
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
        console.error(`[Group Feature Matching] Loaded ${featureEmbeddingMap.size} feature embeddings`);

        // STEP 5: Load code-to-feature mappings for additional matching
        console.error(`[Group Feature Matching] Loading code-to-feature mappings...`);
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
        console.error(`[Group Feature Matching] Found code mappings for ${codeToFeatureMap.size} features`);

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

        // STEP 6: Match each group to features
        console.error(`[Group Feature Matching] Matching ${allGroups.length} groups to features...`);
        let matchedCount = 0;
        let skippedCount = 0;
        const matchResults: Array<{ groupId: string; features: Array<{ id: string; name: string; similarity: number }> }> = [];

        // Reload group embeddings
        const groupEmbeddings = await prisma.groupEmbedding.findMany({
          where: { groupId: { in: allGroups.map(g => g.id) } },
        });
        const groupEmbeddingMap = new Map<string, number[]>();
        for (const emb of groupEmbeddings) {
          groupEmbeddingMap.set(emb.groupId, emb.embedding as number[]);
        }

        for (const group of allGroups) {
          const groupEmb = groupEmbeddingMap.get(group.id);
          
          if (!groupEmb) {
            console.error(`[Group Feature Matching] No embedding for group ${group.id}, skipping`);
            skippedCount++;
            continue;
          }

          // Calculate similarity to each feature
          const featureMatches: Array<{ id: string; name: string; similarity: number; codeBoosted: boolean }> = [];

          for (const feature of featuresWithEmbeddings) {
            const featureEmb = featureEmbeddingMap.get(feature.id);
            if (!featureEmb) continue;

            let similarity = cosineSimilarity(groupEmb, featureEmb);
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

          // Update group in database
          await prisma.group.update({
            where: { id: group.id },
            data: {
              affectsFeatures: affectsFeatures,
            },
          });

          matchedCount++;
          matchResults.push({
            groupId: group.id,
            features: topFeatures.map(f => ({ id: f.id, name: f.name, similarity: Math.round(f.similarity * 100) / 100 })),
          });

          // Log progress every 10 groups
          if (matchedCount % 10 === 0) {
            console.error(`[Group Feature Matching] Matched ${matchedCount}/${allGroups.length} groups...`);
          }
        }

        console.error(`[Group Feature Matching] Completed: ${matchedCount} matched, ${skippedCount} skipped`);

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
              message: `Matched ${matchedCount} groups to features`,
              stats: {
                total_groups: allGroups.length,
                matched: matchedCount,
                skipped: skippedCount,
                features_used: featureSummary.size,
              },
              feature_distribution: Object.fromEntries(
                [...featureSummary.entries()].sort((a, b) => b[1] - a[1]).slice(0, 20)
              ),
              sample_matches: matchResults.slice(0, 10).map(r => ({
                group: r.groupId,
                top_feature: r.features[0]?.name || "General",
                similarity: r.features[0]?.similarity || 0,
              })),
            }, null, 2),
          }],
        };

      } catch (error) {
        logError("Group feature matching failed:", error);
        throw new Error(`Group feature matching failed: ${error instanceof Error ? error.message : String(error)}`);
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
        const validLabels = ["security", "bug", "regression", "urgent", "enhancement", "documentation", "assistance"];
        
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
- security: Security vulnerabilities, auth bypasses, data leaks, XSS, CSRF, injection
- bug: Software defects, errors, crashes, things not working, unexpected behavior, "not found" errors
- regression: Something that worked before but broke after update/release
- urgent: Critical issues, production outages, blockers
- enhancement: Feature requests, improvements, suggestions, new functionality
- documentation: Documentation issues, missing docs, unclear docs, doc improvements
- assistance: Questions, help requests, "how to" questions, guidance needed

Rules:
1. Return one line per issue: "[number] label1, label2"
2. If regression, also include bug
3. EVERY issue must have at least one label - pick the best fit
4. Error messages like "not found", "failed", "error" are usually bugs
5. "How to", "Guidance", "Help" are assistance
6. "docs:", "documentation", "clarify" are documentation

Example output:
[1] bug
[2] security
[3] regression, bug
[4] enhancement
[5] documentation
[6] assistance`
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
            
            const data = await response.json() as { choices?: Array<{ message?: { content?: string } }> };
            const result = data.choices?.[0]?.message?.content?.trim() || "";
            
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

    case "match_issues_to_threads": {
      const {
        min_similarity = 50,
        include_closed = false,
        force = false,
        channel_id,
      } = args as {
        min_similarity?: number;
        include_closed?: boolean;
        force?: boolean;
        channel_id?: string;
      };

      try {
        const apiKey = process.env.OPENAI_API_KEY;
        if (!apiKey) {
          throw new Error("OPENAI_API_KEY is required for computing embeddings.");
        }

        // Verify database is available
        const { hasDatabaseConfig, getStorage } = await import("../storage/factory.js");
        if (!hasDatabaseConfig()) {
          throw new Error("Database is required. Please configure DATABASE_URL.");
        }

        const storage = getStorage();
        const dbAvailable = await storage.isAvailable();
        if (!dbAvailable) {
          throw new Error("Database is not available. Please check your DATABASE_URL configuration.");
        }

        const { prisma } = await import("../storage/db/prisma.js");

        console.error(`[MatchIssues] Starting issue-to-thread matching (threshold: ${min_similarity}%)...`);

        // STEP 1: Load GitHub issues
        console.error(`[MatchIssues] Loading GitHub issues...`);
        const issueFilter: { issueState?: string; matchedToThreads?: boolean } = {};
        if (!include_closed) {
          issueFilter.issueState = "open";
        }
        if (!force) {
          // Only process issues without matches
          issueFilter.matchedToThreads = false;
        }

        const allIssues = await prisma.gitHubIssue.findMany({
          where: issueFilter,
          select: {
            issueNumber: true,
            issueTitle: true,
            issueUrl: true,
          },
        });

        if (allIssues.length === 0) {
          return {
            content: [{
              type: "text",
              text: JSON.stringify({
                success: true,
                message: force 
                  ? "No issues found in database."
                  : "All issues already have thread matches. Use force=true to re-match.",
                stats: { issues_processed: 0, matches_found: 0, issues_matched: 0 },
              }, null, 2),
            }],
          };
        }
        console.error(`[MatchIssues] Found ${allIssues.length} issues to process`);

        // STEP 2: Compute/load issue embeddings
        console.error(`[MatchIssues] Computing issue embeddings...`);
        const { computeAndSaveIssueEmbeddings } = await import("../storage/db/embeddings.js");
        const embeddingResult = await computeAndSaveIssueEmbeddings(apiKey, undefined, false);
        console.error(`[MatchIssues] Issue embeddings: ${embeddingResult.computed} computed, ${embeddingResult.cached} cached`);

        // Load issue embeddings
        const issueEmbeddings = await prisma.issueEmbedding.findMany({
          where: {
            issueNumber: { in: allIssues.map(i => i.issueNumber) },
          },
        });
        console.error(`[MatchIssues] Loaded ${issueEmbeddings.length} issue embeddings`);

        // Create issue embedding map
        const issueEmbeddingMap = new Map<number, number[]>();
        for (const emb of issueEmbeddings) {
          issueEmbeddingMap.set(emb.issueNumber, emb.embedding as number[]);
        }

        // STEP 3: Compute/load thread embeddings
        console.error(`[MatchIssues] Computing thread embeddings...`);
        const { computeAndSaveThreadEmbeddings } = await import("../storage/db/embeddings.js");
        const threadEmbeddingOpts = channel_id ? { channelId: channel_id } : {};
        const threadEmbResult = await computeAndSaveThreadEmbeddings(apiKey, threadEmbeddingOpts);
        console.error(`[MatchIssues] Thread embeddings: ${threadEmbResult.computed} computed, ${threadEmbResult.cached} cached`);

        // Load thread embeddings
        const threadEmbeddingQuery = channel_id 
          ? { thread: { channelId: channel_id } }
          : {};
        const threadEmbeddings = await prisma.threadEmbedding.findMany({
          where: threadEmbeddingQuery,
          include: {
            thread: {
              select: {
                threadId: true,
                threadName: true,
                firstMessageUrl: true,
                messageCount: true,
                firstMessageTimestamp: true,
              },
            },
          },
        });
        console.error(`[MatchIssues] Loaded ${threadEmbeddings.length} thread embeddings`);

        if (threadEmbeddings.length === 0) {
          return {
            content: [{
              type: "text",
              text: JSON.stringify({
                success: false,
                message: "No thread embeddings found. Run classify_messages first to create classified threads.",
                stats: { issues_processed: 0, matches_found: 0, issues_matched: 0 },
              }, null, 2),
            }],
          };
        }

        // STEP 4: Match issues to threads using cosine similarity
        console.error(`[MatchIssues] Matching issues to threads...`);

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

        const threshold = min_similarity / 100;
        const newMatches: Array<{
          issueNumber: number;
          threadId: string;
          threadName: string | null;
          threadUrl: string | null;
          similarity: number;
          messageCount: number;
          firstMessageAt: Date | null;
        }> = [];

        // Compare each thread to each issue
        for (const threadEmb of threadEmbeddings) {
          const threadVector = threadEmb.embedding as number[];
          
          for (const issue of allIssues) {
            const issueVector = issueEmbeddingMap.get(issue.issueNumber);
            if (!issueVector) continue;

            const similarity = cosineSimilarity(threadVector, issueVector);
            
            if (similarity >= threshold) {
              newMatches.push({
                issueNumber: issue.issueNumber,
                threadId: threadEmb.threadId,
                threadName: threadEmb.thread.threadName,
                threadUrl: threadEmb.thread.firstMessageUrl,
                similarity: similarity * 100, // Convert to percentage
                messageCount: threadEmb.thread.messageCount,
                firstMessageAt: threadEmb.thread.firstMessageTimestamp,
              });
            }
          }
        }

        console.error(`[MatchIssues] Found ${newMatches.length} matches above ${min_similarity}% threshold`);

        // STEP 5: Save matches to database
        if (newMatches.length > 0) {
          console.error(`[MatchIssues] Saving matches to database...`);
          
          let savedCount = 0;
          let errorCount = 0;

          for (const match of newMatches) {
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
                  threadName: match.threadName,
                  threadUrl: match.threadUrl,
                  similarityScore: match.similarity,
                  matchMethod: "embedding",
                  messageCount: match.messageCount,
                  firstMessageAt: match.firstMessageAt,
                },
                update: {
                  similarityScore: match.similarity,
                  threadName: match.threadName,
                  messageCount: match.messageCount,
                },
              });
              savedCount++;
            } catch (matchError) {
              console.error(`[MatchIssues] Error saving match ${match.issueNumber} -> ${match.threadId}:`, matchError);
              errorCount++;
            }
          }

          // Update issues to mark them as matched
          const matchedIssueNumbers = [...new Set(newMatches.map(m => m.issueNumber))];
          await prisma.gitHubIssue.updateMany({
            where: { issueNumber: { in: matchedIssueNumbers } },
            data: { matchedToThreads: true },
          });

          console.error(`[MatchIssues] Saved ${savedCount} matches, ${errorCount} errors`);
          console.error(`[MatchIssues] Updated ${matchedIssueNumbers.length} issues as matched`);

          // Group matches by issue for summary
          const matchesByIssue = new Map<number, number>();
          for (const m of newMatches) {
            matchesByIssue.set(m.issueNumber, (matchesByIssue.get(m.issueNumber) || 0) + 1);
          }

          // Top issues by match count
          const topIssues = [...matchesByIssue.entries()]
            .sort((a, b) => b[1] - a[1])
            .slice(0, 10)
            .map(([issueNum, count]) => {
              const issue = allIssues.find(i => i.issueNumber === issueNum);
              return {
                issue_number: issueNum,
                title: issue?.issueTitle?.substring(0, 60) || "Unknown",
                thread_matches: count,
              };
            });

          return {
            content: [{
              type: "text",
              text: JSON.stringify({
                success: true,
                message: `Matched ${matchedIssueNumbers.length} issues to ${newMatches.length} thread associations`,
                stats: {
                  issues_processed: allIssues.length,
                  issues_with_embeddings: issueEmbeddingMap.size,
                  threads_searched: threadEmbeddings.length,
                  matches_found: newMatches.length,
                  issues_matched: matchedIssueNumbers.length,
                  matches_saved: savedCount,
                  errors: errorCount,
                },
                threshold_used: min_similarity,
                top_matched_issues: topIssues,
              }, null, 2),
            }],
          };
        } else {
          return {
            content: [{
              type: "text",
              text: JSON.stringify({
                success: true,
                message: "No matches found above threshold",
                stats: {
                  issues_processed: allIssues.length,
                  issues_with_embeddings: issueEmbeddingMap.size,
                  threads_searched: threadEmbeddings.length,
                  matches_found: 0,
                  issues_matched: 0,
                },
                threshold_used: min_similarity,
                suggestion: `Try lowering min_similarity (currently ${min_similarity}%) to find more matches`,
              }, null, 2),
            }],
          };
        }

      } catch (error) {
        logError("Issue-thread matching failed:", error);
        throw new Error(`Issue-thread matching failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    case "sync_linear_status": {
      const { dry_run = false, force = false } = args as {
        dry_run?: boolean;
        force?: boolean;
      };

      try {
        const config = getConfig();
        
        // Check required environment variables
        if (!process.env.PM_TOOL_API_KEY) {
          throw new Error("PM_TOOL_API_KEY is required for Linear sync");
        }
        
        if (!process.env.PM_TOOL_TEAM_ID) {
          throw new Error("PM_TOOL_TEAM_ID is required for Linear sync");
        }

        // Verify database is available
        const { hasDatabaseConfig, getStorage } = await import("../storage/factory.js");
        if (!hasDatabaseConfig()) {
          throw new Error("Database is required. Please configure DATABASE_URL.");
        }

        const storage = getStorage();
        const dbAvailable = await storage.isAvailable();
        if (!dbAvailable) {
          throw new Error("Database is not available. Please check your DATABASE_URL configuration.");
        }

        console.error(`[Sync] Starting Linear status sync (dry_run: ${dry_run}, force: ${force})...`);

        // Import and run the sync
        const { syncLinearStatus } = await import("../sync/linearStatusSync.js");
        const summary = await syncLinearStatus({ dryRun: dry_run, force });

        console.error(`[Sync] Completed: ${summary.markedDone} marked done, ${summary.unchanged} unchanged, ${summary.skippedNoLinks} skipped, ${summary.errors} errors`);

        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              success: summary.errors === 0,
              dry_run,
              message: dry_run 
                ? `[DRY RUN] Would mark ${summary.markedDone} Linear tickets as Done`
                : `Marked ${summary.markedDone} Linear tickets as Done`,
              summary: {
                total_linear_tickets: summary.totalLinearTickets,
                marked_done: summary.markedDone,
                unchanged: summary.unchanged,
                skipped_no_links: summary.skippedNoLinks,
                errors: summary.errors,
              },
              details: summary.details.slice(0, 50), // Limit details to first 50
              ...(summary.details.length > 50 && {
                note: `Showing first 50 of ${summary.details.length} details`,
              }),
            }, null, 2),
          }],
        };

      } catch (error) {
        logError("Linear status sync failed:", error);
        throw new Error(`Linear status sync failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    case "sync_pr_based_status": {
      const { dry_run = false, user_mappings, organization_engineers, default_assignee_id } = args as {
        dry_run?: boolean;
        user_mappings?: Array<{ githubUsername: string; linearUserId: string }>;
        organization_engineers?: string[];
        default_assignee_id?: string;
      };

      try {
        const config = getConfig();
        
        // Check required environment variables
        if (!process.env.PM_TOOL_API_KEY) {
          throw new Error("PM_TOOL_API_KEY is required for PR-based sync");
        }
        
        if (!process.env.PM_TOOL_TEAM_ID) {
          throw new Error("PM_TOOL_TEAM_ID is required for PR-based sync");
        }

        // Verify database is available
        const { hasDatabaseConfig, getStorage } = await import("../storage/factory.js");
        if (!hasDatabaseConfig()) {
          throw new Error("Database is required. Please configure DATABASE_URL.");
        }

        const storage = getStorage();
        const dbAvailable = await storage.isAvailable();
        if (!dbAvailable) {
          throw new Error("Database is not available. Please check your DATABASE_URL configuration.");
        }

        console.error(`[PR Sync] Starting PR-based Linear sync (dry_run: ${dry_run})...`);

        // Import and run the sync
        const { syncPRBasedStatus } = await import("../sync/prBasedSync.js");
        const summary = await syncPRBasedStatus({ 
          dryRun: dry_run, 
          userMappings: user_mappings,
          organizationEngineers: organization_engineers,
          defaultAssigneeId: default_assignee_id,
        });

        console.error(`[PR Sync] Completed: ${summary.updated} updated (${summary.setToInProgress} In Progress, ${summary.setToReview} Review), ${summary.unchanged} unchanged, ${summary.skipped} skipped, ${summary.errors} errors`);

        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              success: summary.errors === 0,
              dry_run,
              message: dry_run 
                ? `[DRY RUN] Would update ${summary.updated} Linear issues (${summary.setToInProgress} In Progress, ${summary.setToReview} Review)`
                : `Updated ${summary.updated} Linear issues (${summary.setToInProgress} In Progress, ${summary.setToReview} Review)`,
              summary: {
                total_issues: summary.totalIssues,
                updated: summary.updated,
                set_to_in_progress: summary.setToInProgress,
                set_to_review: summary.setToReview,
                unchanged: summary.unchanged,
                skipped: summary.skipped,
                errors: summary.errors,
              },
              details: summary.details.slice(0, 50), // Limit details to first 50
              ...(summary.details.length > 50 && {
                note: `Showing first 50 of ${summary.details.length} details`,
              }),
            }, null, 2),
          }],
        };

      } catch (error) {
        logError("PR-based sync failed:", error);
        throw new Error(`PR-based sync failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    case "sync_engineer_comments": {
      const { dry_run = false, user_mappings, organization_engineers } = args as {
        dry_run?: boolean;
        user_mappings?: Array<{ githubUsername: string; linearUserId: string }>;
        organization_engineers?: string[];
      };

      try {
        if (!process.env.PM_TOOL_API_KEY || !process.env.PM_TOOL_TEAM_ID) {
          throw new Error("PM_TOOL_API_KEY and PM_TOOL_TEAM_ID must be configured");
        }

        const { syncEngineerComments } = await import("../sync/commentSync.js");
        
        const result = await syncEngineerComments({
          dryRun: dry_run,
          userMappings: user_mappings,
          organizationEngineers: organization_engineers,
        });

        console.error(`[CommentSync] Completed: ${result.updated} updated, ${result.unchanged} unchanged, ${result.skipped} skipped, ${result.errors} errors`);

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                success: true,
                ...result,
              }, null, 2),
            },
          ],
        };
      } catch (error) {
        logError("Comment sync failed:", error);
        throw new Error(`Comment sync failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    case "audit_and_fix_incorrectly_assigned": {
      const { dry_run = false, user_mappings, organization_engineers, default_assignee_id } = args as {
        dry_run?: boolean;
        user_mappings?: Array<{ githubUsername: string; linearUserId: string }>;
        organization_engineers?: string[];
        default_assignee_id?: string;
      };

      try {
        const config = getConfig();
        
        // Check required environment variables
        if (!process.env.PM_TOOL_API_KEY) {
          throw new Error("PM_TOOL_API_KEY is required for audit");
        }
        
        if (!process.env.PM_TOOL_TEAM_ID) {
          throw new Error("PM_TOOL_TEAM_ID is required for audit");
        }

        // Verify database is available
        const { hasDatabaseConfig, getStorage } = await import("../storage/factory.js");
        if (!hasDatabaseConfig()) {
          throw new Error("Database is required. Please configure DATABASE_URL.");
        }

        const storage = getStorage();
        const dbAvailable = await storage.isAvailable();
        if (!dbAvailable) {
          throw new Error("Database is not available. Please check your DATABASE_URL configuration.");
        }

        console.error(`[Audit] Starting audit and fix for incorrectly assigned issues (dry_run: ${dry_run})...`);

        // Import and run the audit
        const { auditAndFixIncorrectlyAssignedIssues } = await import("../sync/prBasedSync.js");
        const result = await auditAndFixIncorrectlyAssignedIssues({ 
          dryRun: dry_run, 
          userMappings: user_mappings,
          organizationEngineers: organization_engineers,
          defaultAssigneeId: default_assignee_id,
        });

        console.error(`[Audit] Completed: checked ${result.totalChecked}, found ${result.incorrectlyAssigned} incorrectly assigned, ${dry_run ? 'would fix' : 'fixed'} ${result.fixed}, ${result.errors} errors`);

        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              success: result.errors === 0,
              dry_run,
              message: dry_run 
                ? `[DRY RUN] Would fix ${result.incorrectlyAssigned} incorrectly assigned Linear issues`
                : `Fixed ${result.fixed} incorrectly assigned Linear issues`,
              summary: {
                total_checked: result.totalChecked,
                incorrectly_assigned: result.incorrectlyAssigned,
                fixed: result.fixed,
                errors: result.errors,
              },
              details: result.details.slice(0, 100), // Limit details to first 100
              ...(result.details.length > 100 && {
                note: `Showing first 100 of ${result.details.length} details`,
              }),
            }, null, 2),
          }],
        };

      } catch (error) {
        logError("Audit and fix failed:", error);
        throw new Error(`Audit and fix failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    case "sync_combined": {
      const { dry_run = false, force = false, user_mappings, organization_engineers, default_assignee_id } = args as {
        dry_run?: boolean;
        force?: boolean;
        user_mappings?: Array<{ githubUsername: string; linearUserId: string }>;
        organization_engineers?: string[];
        default_assignee_id?: string;
      };

      try {
        const config = getConfig();
        
        // Check required environment variables
        if (!process.env.PM_TOOL_API_KEY) {
          throw new Error("PM_TOOL_API_KEY is required for combined sync");
        }
        
        if (!process.env.PM_TOOL_TEAM_ID) {
          throw new Error("PM_TOOL_TEAM_ID is required for combined sync");
        }

        // Verify database is available
        const { hasDatabaseConfig, getStorage } = await import("../storage/factory.js");
        if (!hasDatabaseConfig()) {
          throw new Error("Database is required. Please configure DATABASE_URL.");
        }

        const storage = getStorage();
        const dbAvailable = await storage.isAvailable();
        if (!dbAvailable) {
          throw new Error("Database is not available. Please check your DATABASE_URL configuration.");
        }

        console.error(`[Combined Sync] Starting combined sync workflow (dry_run: ${dry_run})...`);

        // Import and run the combined sync
        const { runCombinedSync } = await import("../sync/combinedSync.js");
        const result = await runCombinedSync({
          dryRun: dry_run,
          force,
          userMappings: user_mappings,
          organizationEngineers: organization_engineers,
          defaultAssigneeId: default_assignee_id,
        });

        console.error(`[Combined Sync] Workflow complete: ${result.summary.totalUpdated} total updates (${result.summary.issuesSetToInProgress} In Progress, ${result.summary.ticketsMarkedAsDone} Done, ${result.summary.ticketsMarkedAsReview} Review)`);

        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              success: result.success,
              dry_run: result.dryRun,
              message: result.dryRun
                ? `[DRY RUN] Would update ${result.summary.totalUpdated} Linear issues (${result.summary.issuesSetToInProgress} In Progress, ${result.summary.ticketsMarkedAsDone} Done, ${result.summary.ticketsMarkedAsReview} Review)`
                : `Updated ${result.summary.totalUpdated} Linear issues (${result.summary.issuesSetToInProgress} In Progress, ${result.summary.ticketsMarkedAsDone} Done, ${result.summary.ticketsMarkedAsReview} Review)`,
              summary: result.summary,
              pr_sync: {
                total_issues: result.prSync.totalIssues,
                updated: result.prSync.updated,
                set_to_in_progress: result.prSync.setToInProgress,
                set_to_review: result.prSync.setToReview,
                unchanged: result.prSync.unchanged,
                skipped: result.prSync.skipped,
                errors: result.prSync.errors,
              },
              linear_sync: {
                total_tickets: result.linearSync.totalLinearTickets,
                marked_done: result.linearSync.markedDone,
                marked_review: result.linearSync.markedReview || 0,
                unchanged: result.linearSync.unchanged,
                skipped_no_links: result.linearSync.skippedNoLinks,
                errors: result.linearSync.errors,
              },
            }, null, 2),
          }],
        };

      } catch (error) {
        logError("Combined sync failed:", error);
        throw new Error(`Combined sync failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    case "classify_linear_issues": {
      const { team_name = "OpenRundown", limit = 250, create_projects = true } = args as {
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
      const { team_name = "OpenRundown", limit = 100, dry_run = false } = args as {
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

            const data = await response.json() as { choices?: Array<{ message?: { content?: string } }> };
            const result = data.choices?.[0]?.message?.content?.trim() || "";

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

                          const updateData = await updateResponse.json() as { data?: { issueUpdate?: { success?: boolean } }; errors?: Array<{ message: string }> };
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

    case "analyze_code_ownership": {
      const { force = false, since, calculate_feature_ownership = true } = args as {
        force?: boolean;
        since?: string;
        calculate_feature_ownership?: boolean;
      };

      try {
        const { analyzeCodeOwnership, calculateFeatureOwnership } = await import("../analysis/codeOwnership.js");
        
        console.error("[CodeOwnership] Starting code ownership analysis...");
        const result = await analyzeCodeOwnership(force, since);
        
        if (calculate_feature_ownership) {
          console.error("[CodeOwnership] Calculating feature-level ownership...");
          await calculateFeatureOwnership();
        }

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                success: true,
                message: "Code ownership analysis complete",
                files_analyzed: result.filesAnalyzed,
                engineers_found: result.engineersFound,
                feature_ownership_calculated: calculate_feature_ownership,
              }, null, 2),
            },
          ],
        };
      } catch (error) {
        logError("Code ownership analysis failed:", error);
        throw new Error(`Code ownership analysis failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    case "view_feature_ownership": {
      const { format = "table" } = args as {
        format?: "table" | "json";
      };

      try {
        const { getAllFeatureOwnership, formatFeatureOwnershipTable } = await import("../analysis/codeOwnership.js");
        
        if (format === "json") {
          const data = await getAllFeatureOwnership();
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify({
                  success: true,
                  features: data,
                }, null, 2),
              },
            ],
          };
        } else {
          const table = await formatFeatureOwnershipTable();
          return {
            content: [
              {
                type: "text",
                text: table,
              },
            ],
          };
        }
      } catch (error) {
        logError("Failed to view feature ownership:", error);
        throw new Error(`Failed to view feature ownership: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    // ========================================================================
    // PR Fix Tools - Learning and Fix Generation
    // ========================================================================

    case "seed_pr_learnings": {
      const { since, limit, dry_run = false, batch_size = 50 } = args as {
        since?: string;
        limit?: number;
        dry_run?: boolean;
        batch_size?: number;
      };

      try {
        const { seedPRLearnings } = await import("../learning/prLearning.js");
        
        console.error("[PRLearning] Starting seed_pr_learnings...");
        const result = await seedPRLearnings({
          since,
          limit,
          dryRun: dry_run,
          batchSize: batch_size,
        });

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                success: true,
                message: dry_run ? "Dry run complete" : "Seeding complete",
                total_issues_found: result.totalIssuesFound,
                issues_with_prs: result.issuesWithPRs,
                pr_learnings_created: result.prLearningsCreated,
                pr_learnings_skipped: result.prLearningsSkipped,
                errors_count: result.errors.length,
                errors: result.errors.slice(0, 10), // Show first 10 errors
                time_elapsed_seconds: Math.round(result.timeElapsed / 1000),
              }, null, 2),
            },
          ],
        };
      } catch (error) {
        logError("seed_pr_learnings failed:", error);
        throw new Error(`seed_pr_learnings failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    case "learn_from_pr": {
      const { pr_number, force = false } = args as {
        pr_number: number;
        force?: boolean;
      };

      if (!pr_number) {
        throw new Error("pr_number is required");
      }

      try {
        const { learnFromPR } = await import("../learning/prLearning.js");
        
        console.error(`[PRLearning] Learning from PR #${pr_number}...`);
        const created = await learnFromPR(pr_number, force);

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                success: true,
                pr_number,
                learning_created: created,
                message: created 
                  ? `Successfully learned from PR #${pr_number}` 
                  : `PR #${pr_number} was already processed or has no linked issues`,
              }, null, 2),
            },
          ],
        };
      } catch (error) {
        logError("learn_from_pr failed:", error);
        throw new Error(`learn_from_pr failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    case "investigate_issue": {
      const { issue_number, repo, include_discord = true, max_similar_fixes = 5 } = args as {
        issue_number: number;
        repo?: string;
        include_discord?: boolean;
        max_similar_fixes?: number;
      };

      if (!issue_number) {
        throw new Error("issue_number is required");
      }

      try {
        const { investigateIssue } = await import("../learning/investigateIssue.js");
        
        console.error(`[Investigate] Investigating issue #${issue_number}...`);
        const result = await investigateIssue({
          issueNumber: issue_number,
          repo,
          includeDiscord: include_discord,
          maxSimilarFixes: max_similar_fixes,
        });

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                success: true,
                issue_number,
                issue_title: result.issueContext.title,
                issue_url: result.issueContext.url,
                issue_state: result.issueContext.state,
                triage: {
                  result: result.triage.result,
                  confidence: result.triage.confidence,
                  reasoning: result.triage.reasoning,
                },
                similar_fixes_count: result.similarFixes.length,
                similar_fixes: result.similarFixes.map(f => ({
                  issue: `#${f.issueNumber}`,
                  pr: `#${f.prNumber}`,
                  pr_url: f.prUrl,
                  similarity: f.similarity.toFixed(3),
                  fix_patterns: f.fixPatterns,
                  files_changed: f.prFilesChanged.slice(0, 5),
                })),
                recommendation: result.recommendation,
                should_attempt_fix: result.shouldAttemptFix,
                already_investigated: result.alreadyInvestigated,
                // Include context for fix generation
                context: {
                  title: result.issueContext.title,
                  body: result.issueContext.body?.substring(0, 2000),
                  labels: result.issueContext.labels,
                  author: result.issueContext.author,
                  comments_count: result.issueContext.comments.length,
                  latest_comments: result.issueContext.comments.slice(-3).map(c => ({
                    author: c.author,
                    body: c.body.substring(0, 500),
                    is_org_member: c.isOrganizationMember,
                  })),
                  discord_threads: result.issueContext.discordThreads?.slice(0, 3),
                },
              }, null, 2),
            },
          ],
        };
      } catch (error) {
        logError("investigate_issue failed:", error);
        throw new Error(`investigate_issue failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    case "open_pr_with_fix": {
      const {
        issue_number,
        issue_title,
        repo,
        triage_result,
        triage_confidence,
        triage_reasoning,
        file_changes,
        commit_message,
        pr_title,
        pr_body,
        linear_issue_id,
        assignee,
      } = args as {
        issue_number: number;
        issue_title: string;
        repo?: string;
        triage_result: string;
        triage_confidence: number;
        triage_reasoning?: string;
        file_changes: Array<{ path: string; content: string; operation: string }>;
        commit_message: string;
        pr_title: string;
        pr_body: string;
        linear_issue_id?: string;
        assignee?: string;
      };

      if (!issue_number || !issue_title || !triage_result || !file_changes || !commit_message || !pr_title || !pr_body) {
        throw new Error("Missing required parameters");
      }

      try {
        const { openPRWithFix } = await import("../learning/openPRWithFix.js");
        
        console.error(`[OpenPR] Creating PR for issue #${issue_number}...`);
        const result = await openPRWithFix({
          issueNumber: issue_number,
          issueTitle: issue_title,
          issueRepo: repo,
          triageResult: triage_result,
          triageConfidence: triage_confidence,
          triageReasoning: triage_reasoning,
          fileChanges: file_changes.map(f => ({
            path: f.path,
            content: f.content,
            operation: f.operation as "modify" | "create" | "delete",
          })),
          commitMessage: commit_message,
          prTitle: pr_title,
          prBody: pr_body,
          linearIssueId: linear_issue_id,
          assignee: assignee,
        });

        if (result.success) {
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify({
                  success: true,
                  message: `Draft PR created successfully!`,
                  pr_number: result.prNumber,
                  pr_url: result.prUrl,
                  branch_name: result.branchName,
                  files_changed: result.filesChanged,
                  linear_comment_id: result.linearCommentId,
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
                  error: result.error,
                  branch_name: result.branchName,
                }, null, 2),
              },
            ],
          };
        }
      } catch (error) {
        logError("open_pr_with_fix failed:", error);
        throw new Error(`open_pr_with_fix failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    case "fix_github_issue": {
      const {
        issue_number,
        repo,
        linear_issue_id,
        fix,
        skip_investigation = false,
        force_attempt = false,
      } = args as {
        issue_number: number;
        repo?: string;
        linear_issue_id?: string;
        fix?: {
          file_changes: Array<{ path: string; content: string; operation: string }>;
          commit_message: string;
          pr_title: string;
          pr_body: string;
        };
        skip_investigation?: boolean;
        force_attempt?: boolean;
      };

      if (!issue_number) {
        throw new Error("issue_number is required");
      }

      try {
        const { fixIssueWorkflow } = await import("../learning/fixIssueWorkflow.js");
        
        console.error(`[Workflow] Starting fix workflow for issue #${issue_number}...`);
        
        const result = await fixIssueWorkflow({
          issueNumber: issue_number,
          repo,
          linearIssueId: linear_issue_id,
          fix: fix ? {
            fileChanges: fix.file_changes.map(f => ({
              path: f.path,
              content: f.content,
              operation: f.operation as "modify" | "create" | "delete",
            })),
            commitMessage: fix.commit_message,
            prTitle: fix.pr_title,
            prBody: fix.pr_body,
          } : undefined,
          skipInvestigation: skip_investigation,
          forceAttempt: force_attempt,
        });

        // Format response based on phase
        if (result.phase === "investigation") {
          // Return investigation results for AI to generate fix
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify({
                  phase: "investigation",
                  success: true,
                  message: "Investigation complete. Use this context to generate a fix, then call again with the fix parameter.",
                  
                  // Issue context
                  issue: {
                    number: result.investigation?.issueContext.number,
                    title: result.investigation?.issueContext.title,
                    body: result.investigation?.issueContext.body?.substring(0, 3000),
                    labels: result.investigation?.issueContext.labels,
                    state: result.investigation?.issueContext.state,
                    author: result.investigation?.issueContext.author,
                    url: result.investigation?.issueContext.url,
                    comments_count: result.investigation?.issueContext.comments.length,
                    latest_comments: result.investigation?.issueContext.comments.slice(-3).map(c => ({
                      author: c.author,
                      body: c.body.substring(0, 500),
                      is_org_member: c.isOrganizationMember,
                    })),
                  },
                  
                  // Triage
                  triage: {
                    result: result.investigation?.triage.result,
                    confidence: result.investigation?.triage.confidence,
                    reasoning: result.investigation?.triage.reasoning,
                  },
                  
                  // Similar fixes for reference
                  similar_fixes: result.investigation?.similarFixes.slice(0, 3).map(f => ({
                    issue_number: f.issueNumber,
                    issue_title: f.issueTitle,
                    pr_number: f.prNumber,
                    pr_title: f.prTitle,
                    pr_url: f.prUrl,
                    files_changed: f.prFilesChanged,
                    fix_patterns: f.fixPatterns,
                    diff_preview: f.prDiff.substring(0, 1500),
                  })),
                  
                  // Project rules
                  project_rules: result.projectRules ? {
                    base_branch: result.projectRules.baseBranch,
                    branch_naming: result.projectRules.branchNaming,
                    commit_format: result.projectRules.commitFormat,
                    pr_title_format: result.projectRules.prTitleFormat,
                    types: result.projectRules.types,
                    code_style: result.projectRules.codeStyle,
                  } : null,
                  
                  // Fix guidance
                  fix_guidance: result.fixGuidance,
                  
                  // Recommendation
                  recommendation: result.investigation?.recommendation,
                  should_attempt_fix: result.investigation?.shouldAttemptFix,
                }, null, 2),
              },
            ],
          };
        } else if (result.phase === "fix_created") {
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify({
                  phase: "fix_created",
                  success: true,
                  message: "Draft PR created successfully!",
                  pr: {
                    number: result.pr?.number,
                    url: result.pr?.url,
                    branch_name: result.pr?.branchName,
                    files_changed: result.pr?.filesChanged,
                  },
                  triage: result.investigation ? {
                    result: result.investigation.triage.result,
                    confidence: result.investigation.triage.confidence,
                  } : null,
                }, null, 2),
              },
            ],
          };
        } else if (result.phase === "no_fix") {
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify({
                  phase: "no_fix",
                  success: true,
                  message: "Fix not attempted based on triage results.",
                  reason: result.noFixReason,
                  triage: result.investigation ? {
                    result: result.investigation.triage.result,
                    confidence: result.investigation.triage.confidence,
                    reasoning: result.investigation.triage.reasoning,
                  } : null,
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
                  phase: "error",
                  success: false,
                  error: result.error,
                }, null, 2),
              },
            ],
          };
        }
      } catch (error) {
        logError("fix_github_issue failed:", error);
        throw new Error(`fix_github_issue failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    // ====================================================================
    // Agent Briefing System handlers
    // ====================================================================

    case "get_agent_briefing": {
      try {
        const { hasDatabaseConfig } = await import("../storage/factory.js");
        if (!hasDatabaseConfig()) {
          throw new Error("Database is required for agent briefings. Please configure DATABASE_URL.");
        }

        const { distillBriefing } = await import("../briefing/distill.js");
        const { getLastSession, closeStaleSessions } = await import("../briefing/sessions.js");

        const scope = args?.scope as string | undefined;
        const since = args?.since as string | undefined;
        const project = args?.project as string | undefined;
        const projectId = project ?? detectProjectId();

        const staleClosed = await closeStaleSessions(projectId);

        console.error(`[Briefing] Generating agent briefing for project "${projectId}"${scope ? ` (scope: ${scope})` : ""}...`);

        const briefing = await distillBriefing({ scope, since, project: projectId });
        const lastSession = await getLastSession(projectId);

        const result = {
          briefing,
          lastSession: lastSession
            ? {
                sessionId: lastSession.sessionId,
                endedAt: lastSession.endedAt,
                scope: lastSession.scope,
                summary: lastSession.summary,
                openItems: lastSession.openItems,
              }
            : null,
          ...(staleClosed > 0 && { staleSessionsClosed: staleClosed }),
        };

        console.error(`[Briefing] Generated briefing: ${briefing.activeIssues.length} issues, ${briefing.userSignals.length} signals, ${briefing.decisions.length} decisions${staleClosed ? `, ${staleClosed} stale session(s) auto-closed` : ""}`);

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(result, null, 2),
            },
          ],
        };
      } catch (error) {
        logError("get_agent_briefing failed:", error);
        throw new Error(`get_agent_briefing failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    case "start_agent_session": {
      try {
        const { hasDatabaseConfig } = await import("../storage/factory.js");
        if (!hasDatabaseConfig()) {
          throw new Error("Database is required for session tracking. Please configure DATABASE_URL.");
        }

        const { startSession } = await import("../briefing/sessions.js");
        const scope = (args?.scope as string[] | undefined) ?? [];
        const project = args?.project as string | undefined;
        const projectId = project ?? detectProjectId();

        console.error(`[Session] Starting new agent session for project "${projectId}" (scope: ${scope.join(", ") || "none"})...`);
        const session = await startSession(scope, projectId);
        console.error(`[Session] Started session: ${session.sessionId}`);

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(session, null, 2),
            },
          ],
        };
      } catch (error) {
        logError("start_agent_session failed:", error);
        throw new Error(`start_agent_session failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    case "end_agent_session": {
      try {
        const { hasDatabaseConfig } = await import("../storage/factory.js");
        if (!hasDatabaseConfig()) {
          throw new Error("Database is required for session tracking. Please configure DATABASE_URL.");
        }

        const { endSession } = await import("../briefing/sessions.js");
        const sessionId = args?.session_id as string;
        if (!sessionId) throw new Error("session_id is required");

        console.error(`[Session] Ending session: ${sessionId}...`);
        const session = await endSession(sessionId, {
          filesEdited: args?.files_edited as string[] | undefined,
          decisionsMade: args?.decisions_made as string[] | undefined,
          openItems: args?.open_items as string[] | undefined,
          issuesReferenced: args?.issues_referenced as string[] | undefined,
          toolsUsed: args?.tools_used as string[] | undefined,
          summary: args?.summary as string | undefined,
        });
        console.error(`[Session] Ended session: ${sessionId}`);

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(session, null, 2),
            },
          ],
        };
      } catch (error) {
        logError("end_agent_session failed:", error);
        throw new Error(`end_agent_session failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    case "update_agent_session": {
      try {
        const { hasDatabaseConfig } = await import("../storage/factory.js");
        if (!hasDatabaseConfig()) {
          throw new Error("Database is required for session tracking. Please configure DATABASE_URL.");
        }

        const { updateSession } = await import("../briefing/sessions.js");
        const sessionId = args?.session_id as string;
        if (!sessionId) throw new Error("session_id is required");

        console.error(`[Session] Updating session: ${sessionId}...`);
        const session = await updateSession(sessionId, {
          scope: args?.scope as string[] | undefined,
          filesEdited: args?.files_edited as string[] | undefined,
          decisionsMade: args?.decisions_made as string[] | undefined,
          openItems: args?.open_items as string[] | undefined,
          issuesReferenced: args?.issues_referenced as string[] | undefined,
          toolsUsed: args?.tools_used as string[] | undefined,
          summary: args?.summary as string | undefined,
        });
        console.error(`[Session] Updated session: ${sessionId}`);

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(session, null, 2),
            },
          ],
        };
      } catch (error) {
        logError("update_agent_session failed:", error);
        throw new Error(`update_agent_session failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    case "get_session_history": {
      try {
        const { hasDatabaseConfig } = await import("../storage/factory.js");
        if (!hasDatabaseConfig()) {
          throw new Error("Database is required for session history. Please configure DATABASE_URL.");
        }

        const { getRecentSessions, getSession } = await import("../briefing/sessions.js");
        const sessionId = args?.session_id as string | undefined;
        const limit = (args?.limit as number | undefined) ?? 5;
        const project = args?.project as string | undefined;
        const projectId = project ?? detectProjectId();

        if (sessionId) {
          console.error(`[Session] Fetching session: ${sessionId}...`);
          const session = await getSession(sessionId);
          if (!session) throw new Error(`Session not found: ${sessionId}`);
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify(session, null, 2),
              },
            ],
          };
        }

        console.error(`[Session] Fetching last ${limit} sessions for project "${projectId}"...`);
        const sessions = await getRecentSessions(limit, projectId);
        console.error(`[Session] Found ${sessions.length} sessions`);

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({ sessions, count: sessions.length }, null, 2),
            },
          ],
        };
      } catch (error) {
        logError("get_session_history failed:", error);
        throw new Error(`get_session_history failed: ${error instanceof Error ? error.message : String(error)}`);
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
  const projectId = detectProjectId();
  console.error(`[OpenRundown] Project: ${projectId}`);

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
