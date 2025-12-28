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

discord.once("clientReady", () => {
  discordReady = true;
});

/**
 * Safely parse JSON with better error messages
 */
function safeJsonParse<T = any>(content: string, filePath?: string): T {
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
          description: "If true, classifies all messages in the channel (ignores limit). If false (default), uses limit parameter. On first-time classification, automatically processes in batches of 200 until all threads are covered.",
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
          description: "If true, classifies all messages. If false (default), only classifies new/unclassified messages.",
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
    description: "Export classified Discord messages and GitHub issues to a PM tool (Linear, Jira, etc.). For grouping results, groups should be matched to features first using match_groups_to_features. Can use either classification results or grouping results. Uses configuration from environment variables (PM_TOOL_*).",
    inputSchema: {
      type: "object",
      properties: {
        classified_data_path: {
          type: "string",
          description: "Path to the classified Discord messages JSON file (defaults to latest classified file for default channel)",
        },
        grouping_data_path: {
          type: "string",
          description: "Path to the grouping results JSON file (from suggest_grouping). Groups should be matched to features first using match_groups_to_features.",
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
    name: "match_groups_to_features",
    description: "Match groups from grouping results to product features using semantic similarity. Updates the grouping JSON file with affects_features and is_cross_cutting. Requires OPENAI_API_KEY and documentation URLs in config.",
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

    case "fetch_github_issues": {
      const { incremental = false, limit } = args as { incremental?: boolean; limit?: number };
      const config = getConfig();
      const githubConfig = config;
      const cachePath = join(process.cwd(), githubConfig.paths.cacheDir, githubConfig.paths.issuesCacheFile);

      try {
        // Check if cache exists
        let existingCache: IssuesCache | null = null;
        let sinceDate: string | undefined = undefined;

        if (incremental) {
          try {
            if (existsSync(cachePath)) {
              existingCache = await loadIssuesFromCache(cachePath);
              sinceDate = getMostRecentIssueDate(existingCache);
            }
          } catch (error) {
            // Cache doesn't exist or invalid, will fetch all
          }
        }

        // Determine limit: use provided limit, or apply default when DB is not configured
        let actualLimit = limit;
        if (actualLimit === undefined) {
          const { hasDatabaseConfig } = await import("../storage/factory.js");
          if (!hasDatabaseConfig()) {
            // Apply default limit when DB is not configured (try-it-out mode)
            actualLimit = config.storage.defaultLimit?.issues;
          }
        }

        const githubToken = process.env.GITHUB_TOKEN;
        const newIssues = await fetchAllGitHubIssues(githubToken, true, undefined, undefined, sinceDate, actualLimit);

        // Merge with existing cache if doing incremental update
        let finalIssues: GitHubIssue[];
        if (existingCache && newIssues.length > 0) {
          finalIssues = mergeIssues(existingCache.issues, newIssues);
        } else if (existingCache && newIssues.length === 0) {
          finalIssues = existingCache.issues;
        } else {
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
              console.error(`[GitHub Issues] DATABASE_URL is set but database is not available. Falling back to JSON.`);
            } else {
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
              }));
              
              await storage.saveGitHubIssues(issuesToSave);
              console.error(`[GitHub Issues] Saved ${issuesToSave.length} issues to database.`);
              savedToDatabase = true;
            }
          } catch (dbError) {
            console.error(`[GitHub Issues] Database save error (falling back to JSON):`, dbError);
            // Fall through to JSON save
          }
        } else {
          console.error(`[GitHub Issues] DATABASE_URL not set. Using JSON storage.`);
        }

        // Save to JSON file only if database save failed or database is not configured
        if (!savedToDatabase) {
          const cacheDir = join(process.cwd(), githubConfig.paths.cacheDir);
          try {
            await mkdir(cacheDir, { recursive: true });
          } catch (error) {
            // Directory might already exist
          }

          await writeFile(cachePath, JSON.stringify(cacheData, null, 2), "utf-8");
          if (useDatabase) {
            console.error(`[GitHub Issues] Database save failed, saved to JSON cache as fallback.`);
          } else {
            console.error(`[GitHub Issues] Saved to JSON cache (database not configured).`);
          }
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
        throw new Error(`Failed to fetch GitHub issues: ${error instanceof Error ? error.message : error}`);
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

      try {
        if (existsSync(issuesCachePath)) {
          existingIssuesCache = await loadIssuesFromCache(issuesCachePath);
          sinceIssuesDate = getMostRecentIssueDate(existingIssuesCache);
        }
      } catch (error) {
        // Cache doesn't exist or invalid, will fetch all
      }

      const githubToken = process.env.GITHUB_TOKEN;
      if (!githubToken) {
        throw new Error("GITHUB_TOKEN environment variable is required for fetching issues");
      }

      const newIssues = await fetchAllGitHubIssues(githubToken, true, undefined, undefined, sinceIssuesDate);

      // Merge with existing cache if doing incremental update
      let finalIssues: GitHubIssue[];
      if (existingIssuesCache && newIssues.length > 0) {
        finalIssues = mergeIssues(existingIssuesCache.issues, newIssues);
      } else if (existingIssuesCache && newIssues.length === 0) {
        finalIssues = existingIssuesCache.issues;
      } else {
        finalIssues = newIssues;
      }

      // Save updated issues cache
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

      // Save updated Discord cache
      await mkdir(discordCacheDir, { recursive: true });
      await writeFile(discordCachePath, JSON.stringify(finalDiscordCache, null, 2), "utf-8");

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
          }
        } catch (dbError) {
          // Database not available or error, continue with JSON history only
          console.error(`[Classification] Could not load from database (continuing with JSON history):`, dbError);
        }
      }

      // Check if this is first-time classification (no classified messages or threads)
      const isFirstTimeClassification = Object.keys(classificationHistory.messages).length === 0 && 
                                       (!classificationHistory.threads || Object.keys(classificationHistory.threads).length === 0);

      // Filter out already-classified messages if re_classify is false
      let messagesToClassify = re_classify 
        ? allCachedMessages 
        : filterUnclassifiedMessages(allCachedMessages, classificationHistory);

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

                if (!isThreadAlreadyClassified) {
                  const unclassifiedThreadMessages = re_classify
                    ? threadMessages
                    : threadMessages.filter(tmsg => !classificationHistory.messages[tmsg.id]);
                  
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
              
              if (!standaloneMessagesMap.has(msg.id) && !isAlreadyClassified) {
                standaloneMessagesMap.set(msg.id, msg);
              }
            }
          }

          // Determine how many threads to process
          const totalThreads = threadGroupsMap.size + standaloneMessagesMap.size;
          let threadsToProcess = totalThreads;

          if (!classify_all) {
            if (isFirstTimeClassification) {
              // First time: process up to 200 threads
              threadsToProcess = Math.min(200, totalThreads);
            } else {
              // Subsequent runs: use the provided limit (limit applies to threads/messages)
              threadsToProcess = Math.min(limit, totalThreads);
            }
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
            const parsed = safeJsonParse(content, filePath);
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
            const existingData = safeJsonParse(existingContent, outputPath);
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

        if (existsSync(issuesCachePath)) {
          existingIssuesCache = await loadIssuesFromCache(issuesCachePath);
          sinceDate = getMostRecentIssueDate(existingIssuesCache);
        }

        const githubToken = process.env.GITHUB_TOKEN;
        if (!githubToken) {
          throw new Error("GITHUB_TOKEN environment variable is required");
        }

        const newIssues = await fetchAllGitHubIssues(githubToken, true, undefined, undefined, sinceDate);

        // Merge with existing cache
        let finalIssues: GitHubIssue[];
        if (existingIssuesCache && newIssues.length > 0) {
          finalIssues = mergeIssues(existingIssuesCache.issues, newIssues);
        } else if (existingIssuesCache && newIssues.length === 0) {
          finalIssues = existingIssuesCache.issues;
        } else {
          finalIssues = newIssues;
        }

        const issuesCacheData: IssuesCache = {
          fetched_at: new Date().toISOString(),
          total_count: finalIssues.length,
          open_count: finalIssues.filter((i) => i.state === "open").length,
          closed_count: finalIssues.filter((i) => i.state === "closed").length,
          issues: finalIssues,
        };

        const cacheDir = join(process.cwd(), config.paths.cacheDir);
        await mkdir(cacheDir, { recursive: true });
        await writeFile(issuesCachePath, JSON.stringify(issuesCacheData, null, 2), "utf-8");

        results.steps.push({
          step: "sync_github",
          name: "sync_github",
          status: "success",
          result: {
            total: issuesCacheData.total_count,
            open: issuesCacheData.open_count,
            closed: issuesCacheData.closed_count,
            new_updated: newIssues.length,
          },
        });

        // Step 3: Return summary with instruction to classify
        results.summary = {
          discord_messages: discordMessageCount,
          github_issues: issuesCacheData.total_count,
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
      const { classified_data_path, grouping_data_path } = args as {
        classified_data_path?: string;
        grouping_data_path?: string;
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
        const actualChannelId = config.discord.defaultChannelId;

        // Build PM tool configuration from config
        const pmToolConfig: PMToolConfig = {
          type: config.pmIntegration.pm_tool.type,
          api_key: config.pmIntegration.pm_tool.api_key,
          api_url: config.pmIntegration.pm_tool.api_url,
          team_id: config.pmIntegration.pm_tool.team_id,
        };

        let result;
        let sourceFile: string;
        
        // Option 1: Export from grouping results (preferred - already mapped to features)
        if (grouping_data_path) {
          if (!existsSync(grouping_data_path)) {
            throw new Error(`Grouping data file not found: ${grouping_data_path}`);
          }
          
          sourceFile = grouping_data_path;
          console.error(`[Export] Using grouping data from ${grouping_data_path}`);
          const groupingContent = await readFile(grouping_data_path, "utf-8");
          const groupingData = safeJsonParse(groupingContent, grouping_data_path);
          
          // Import the export function for grouping data
          const { exportGroupingToPMTool } = await import("../export/groupingExporter.js");
          result = await exportGroupingToPMTool(groupingData, pmToolConfig);
          
          // Update grouping JSON file with export status and suggested titles
          if (result.success) {
            // Update groups with export status
            if (result.group_export_mappings) {
              const exportMappings = new Map(result.group_export_mappings.map(m => [m.group_id, m]));
              
              for (const group of groupingData.groups) {
                const mapping = exportMappings.get(group.id);
                if (mapping) {
                  // Mark as exported
                  group.status = "exported";
                  group.exported_at = new Date().toISOString();
                  group.linear_issue_id = mapping.id;
                  group.linear_issue_url = mapping.url;
                  
                  // Store identifier if available (e.g., "LIN-123")
                  if (mapping.identifier) {
                    group.linear_issue_identifier = mapping.identifier;
                  }
                }
                
                // Ensure suggested_title is set (should already be set by exporter, but double-check)
                if (!group.suggested_title) {
                  group.suggested_title = group.github_issue?.title || "Untitled Group";
                }
              }
            }
            
            // Update ungrouped threads with export status
            if (result.ungrouped_thread_export_mappings && groupingData.ungrouped_threads) {
              const threadMappings = new Map(result.ungrouped_thread_export_mappings.map(m => [m.thread_id, m]));
              
              for (const ungroupedThread of groupingData.ungrouped_threads) {
                const mapping = threadMappings.get(ungroupedThread.thread_id);
                if (mapping) {
                  ungroupedThread.export_status = "exported";
                  ungroupedThread.exported_at = new Date().toISOString();
                  ungroupedThread.linear_issue_id = mapping.id;
                  ungroupedThread.linear_issue_url = mapping.url;
                  if (mapping.identifier) {
                    ungroupedThread.linear_issue_identifier = mapping.identifier;
                  }
                }
              }
            }
            
            // Save updated grouping data back to file
            await writeFile(grouping_data_path, JSON.stringify(groupingData, null, 2), "utf-8");
            console.error(`[Export] Updated grouping file with export status: ${grouping_data_path}`);
          }
          
        } else {
          // Option 2: Export from classification results (requires feature extraction)
          
          // Get documentation URLs from config
          if (!config.pmIntegration.documentation_urls || config.pmIntegration.documentation_urls.length === 0) {
            throw new Error("No documentation URLs configured. Set DOCUMENTATION_URLS in environment variables, or use grouping_data_path instead.");
          }
          
          // Determine classified data path
          let classifiedPath = classified_data_path;
          if (!classifiedPath) {
            if (!actualChannelId) {
              throw new Error("Channel ID is required. Provide classified_data_path or set DISCORD_DEFAULT_CHANNEL_ID in environment variables.");
            }
            classifiedPath = join(resultsDir, `discord-classified-${actualChannelId}.json`);
          }
          
          sourceFile = classifiedPath;

          // Run export workflow
          result = await runExportWorkflow(
            config.pmIntegration.documentation_urls,
            classifiedPath,
            pmToolConfig
          );
        }

        // Save export results to file
        await mkdir(resultsDir, { recursive: true });
        
        const timestamp = Date.now();
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
        };
        
        await writeFile(exportResultsPath, JSON.stringify(exportResultData, null, 2), "utf-8");

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
                results_saved_to: exportResultsPath,
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

        const resultsDir = join(process.cwd(), config.paths.resultsDir || "results");
        const history = await loadClassificationHistory(resultsDir, actualChannelId);
        const existingGroupStats = getGroupingStats(history);
        
        console.error(`[Grouping] Existing groups: ${existingGroupStats.totalGroups} (${existingGroupStats.exportedGroups} exported, ${existingGroupStats.pendingGroups} pending)`);

        // ============================================================
        // STEP 1: Check for existing classification results
        // ============================================================
        let classificationResults: ClassificationResults | null = null;
        
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
        
        if (bestFile && !semantic_only) {
          const classificationPath = join(resultsDir, bestFile);
          const classificationContent = await readFile(classificationPath, "utf-8");
          const parsed = safeJsonParse<ClassificationResults>(classificationContent, classificationPath);
          
          // Only use if it has actual data
          if (parsed.classified_threads && parsed.classified_threads.length > 0) {
            classificationResults = parsed;
            console.error(`[Grouping] Found classification results: ${parsed.classified_threads.length} threads in ${bestFile}`);
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
            
            // Load caches
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
              const existingData = safeJsonParse(existingContent, outputPath);
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
          
          // Function to save progress incrementally
          const saveProgressToFile = async (pretty = false) => {
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
              const legacyIssue = (group as unknown as { github_issue?: { title?: string } }).github_issue;
              if (legacyIssue?.title) {
                // Use GitHub issue title if available, otherwise generate from threads
                group.suggested_title = generateGroupTitleFromThreads(
                  group.threads || [],
                  legacyIssue.title
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
          const ungroupedMap = new Map<string, any>();
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
          
          await writeFile(outputPath, JSON.stringify(outputData, null, 2), "utf-8");
          
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
              const existingData = safeJsonParse(existingContent, semanticOutputPath);
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
          
          await writeFile(semanticOutputPath, JSON.stringify(outputData, null, 2), "utf-8");
          
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

    case "match_groups_to_features": {
      try {
        const { 
          grouping_data_path,
          channel_id,
          min_similarity = 0.6,
        } = args as {
          grouping_data_path?: string;
          channel_id?: string;
          min_similarity?: number;
        };

        const config = getConfig();
        const resultsDir = join(process.cwd(), config.paths.resultsDir || "results");
        
        // Find grouping file
        let groupingPath: string;
        if (grouping_data_path) {
          groupingPath = grouping_data_path;
        } else {
          const actualChannelId = channel_id || config.discord.defaultChannelId;
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

        // Load grouping data
        // Log removed to avoid interfering with MCP JSON protocol
        // console.error(`[Feature Matching] Loading grouping data from ${groupingPath}...`);
        const groupingContent = await readFile(groupingPath, "utf-8");
        const groupingData = safeJsonParse<{
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
          };
          groups: Group[];
          ungrouped_threads?: UngroupedThread[];
          features?: Array<{ id: string; name: string }>;
        }>(groupingContent, groupingPath);

        // Get features from cache or extract from documentation
        const docUrls = config.pmIntegration?.documentation_urls;
        if (!docUrls || docUrls.length === 0) {
          throw new Error("No documentation URLs configured. Set DOCUMENTATION_URLS in config.");
        }

        const { getFeaturesFromCacheOrExtract } = await import("../export/featureCache.js");
        const extractedFeatures = await getFeaturesFromCacheOrExtract(docUrls);
        const features = extractedFeatures.map(f => ({
          id: f.id,
          name: f.name,
          description: f.description,
        }));

        // Log removed to avoid interfering with MCP JSON protocol
        // console.error(`[Feature Matching] Extracted ${features.length} features from documentation`);

        // Map groups to features
        // Log removed to avoid interfering with MCP JSON protocol
        // console.error(`[Feature Matching] Mapping ${groupingData.groups.length} groups to features...`);
        const { mapGroupsToFeatures } = await import("../export/featureMapper.js");
        const groupsWithFeatures = await mapGroupsToFeatures(groupingData.groups, features, min_similarity) as Group[];

        // Update grouping data  
        groupingData.groups = groupsWithFeatures;
        groupingData.features = features.map(f => ({ id: f.id, name: f.name }));
        
        // Update timestamp fields - preserve original timestamp, update updated_at
        if (!groupingData.timestamp) {
          groupingData.timestamp = new Date().toISOString();
        }
        groupingData.updated_at = new Date().toISOString();
        
        // Update stats
        const crossCuttingCount = groupsWithFeatures.filter(g => g.is_cross_cutting).length;
        groupingData.stats = {
          ...groupingData.stats,
          cross_cutting_groups: crossCuttingCount,
          features_extracted: features.length,
          groups_matched: groupsWithFeatures.length,
        };

        // Save updated grouping file
        await writeFile(groupingPath, JSON.stringify(groupingData, null, 2), "utf-8");
        // Log removed to avoid interfering with MCP JSON protocol
        // console.error(`[Feature Matching] Updated grouping file with feature matches: ${groupingPath}`);

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                success: true,
                message: `Matched ${groupsWithFeatures.length} groups to ${features.length} features`,
                stats: {
                  total_groups: groupsWithFeatures.length,
                  cross_cutting_groups: crossCuttingCount,
                  features_extracted: features.length,
                  groups_matched: groupsWithFeatures.length,
                },
                features: features.map(f => ({ id: f.id, name: f.name })),
                output_file: groupingPath,
              }, null, 2),
            },
          ],
        };
      } catch (error) {
        logError("Feature matching failed:", error);
        throw new Error(`Feature matching failed: ${error instanceof Error ? error.message : String(error)}`);
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
                  console.error(`[Linear Classification] ✓ Matched issue ${issue.identifier} to project "${bestMatch.feature.name}" (similarity: ${bestMatch.similarity.toFixed(2)})`);
                } else {
                  console.error(`[Linear Classification] ✗ No match found for issue ${issue.identifier} (best similarity: ${top3[0]?.similarity.toFixed(2) || "N/A"}, threshold: 0.5)`);
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
            
            console.error("[Documentation Cache] Starting embedding computation...");
            await computeAllEmbeddings(process.env.OPENAI_API_KEY);

            return {
              content: [
                {
                  type: "text",
                  text: JSON.stringify({
                    success: true,
                    message: "Embeddings computed for all documentation, sections, and features",
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
            
            console.error("[Documentation Cache] Starting feature embeddings computation...");
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
