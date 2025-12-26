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
          description: "Maximum number of messages to fetch. Omit to fetch all messages.",
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
          description: "Minimum similarity score to consider a match (0-100, default 20)",
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
          description: "Minimum similarity score to consider a match (0-100, default 20)",
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
    description: "Export classified Discord messages and GitHub issues to a PM tool (Linear, Jira, etc.) by extracting features from documentation and mapping conversations to features. Can use either classification results or grouping results. Uses configuration from environment variables (DOCUMENTATION_URLS, PM_TOOL_*).",
    inputSchema: {
      type: "object",
      properties: {
        classified_data_path: {
          type: "string",
          description: "Path to the classified Discord messages JSON file (defaults to latest classified file for default channel)",
        },
        grouping_data_path: {
          type: "string",
          description: "Path to the grouping results JSON file (from suggest_grouping). If provided, exports groups directly without re-mapping to features.",
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
          description: "Minimum similarity threshold for issue matching (0-100, default 60)",
          minimum: 0,
          maximum: 100,
          default: 60,
        },
        max_groups: {
          type: "number",
          description: "Maximum number of groups to return (default 50)",
          default: 50,
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
];

// Handle list tools request
mcpServer.server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools,
}));

// Handle call tool request
mcpServer.server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

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
      let discordResults: any[] = [];
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
      let githubResults: any = { total_count: 0, issues: [] };
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
      const { incremental = false } = args as { incremental?: boolean };
      const githubConfig = getConfig();
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

        const githubToken = process.env.GITHUB_TOKEN;
        const newIssues = await fetchAllGitHubIssues(githubToken, true, undefined, undefined, sinceDate);

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

        // Ensure cache directory exists
        const cacheDir = join(process.cwd(), githubConfig.paths.cacheDir);
        try {
          await mkdir(cacheDir, { recursive: true });
        } catch (error) {
          // Directory might already exist
        }

        await writeFile(cachePath, JSON.stringify(cacheData, null, 2), "utf-8");

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                success: true,
                message: incremental && newIssues.length > 0
                  ? `Updated cache with ${newIssues.length} new/updated issues`
                  : `Fetched ${finalIssues.length} issues`,
                total: cacheData.total_count,
                open: cacheData.open_count,
                closed: cacheData.closed_count,
                new_updated: incremental ? newIssues.length : finalIssues.length,
                cache_path: cachePath,
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

      const discordConfig = getConfig();
      const actualChannelId = channel_id || discordConfig.discord.defaultChannelId;

      if (!actualChannelId) {
        throw new Error("Channel ID is required. Provide channel_id parameter or set DISCORD_DEFAULT_CHANNEL_ID in environment variables.");
      }

      const cacheDir = join(process.cwd(), discordConfig.paths.cacheDir);
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

        // Fetch messages with pagination
        let fetchedMessages: any[] = [];
        let lastMessageId: string | undefined = undefined;
        let hasMore = true;
        const maxMessages = limit; // undefined = no limit (fetch all)

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
            const newMessages = messageArray.filter((msg: any) => {
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
        const formattedMessages = fetchedMessages.map((msg: any) => {
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
            attachments: msg.attachments.map((att: any) => ({
              id: att.id,
              filename: att.name,
              url: att.url,
              size: att.size,
              content_type: att.contentType || undefined,
            })),
            embeds: msg.embeds.length,
            mentions: Array.from(msg.mentions.users.keys()).map(id => String(id)),
            reactions: msg.reactions.cache.map((reaction: any) => ({
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

        // Ensure cache directory exists
        try {
          await mkdir(cacheDir, { recursive: true });
        } catch (error) {
          // Directory might already exist
        }

        await writeFile(cachePath, JSON.stringify(cacheData, null, 2), "utf-8");

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                success: true,
                message: incremental && formattedMessages.length > 0
                  ? `Updated cache with ${formattedMessages.length} new/updated messages`
                  : `Fetched ${cacheData.total_count} messages`,
                total: cacheData.total_count,
                threads: Object.keys(cacheData.threads).length,
                main_messages: cacheData.main_messages.length,
                new_updated: incremental ? formattedMessages.length : cacheData.total_count,
                cache_path: cachePath,
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

      // Check if cache exists for incremental update
      let existingDiscordCache: DiscordCache | null = null;
      let sinceDiscordDate: string | undefined = undefined;

      try {
        const foundCachePath = await findDiscordCacheFile(actualChannelId);
        if (foundCachePath) {
          existingDiscordCache = await loadDiscordCache(foundCachePath);
          sinceDiscordDate = getMostRecentMessageDate(existingDiscordCache);
        }
      } catch (error) {
        // Cache doesn't exist or invalid
      }

      // Fetch messages with pagination (incremental)
      let fetchedMessages: any[] = [];
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
          const newMessages = messageArray.filter((msg: any) => {
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
      const formattedMessages = fetchedMessages.map((msg: any) => {
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
          attachments: msg.attachments.map((att: any) => ({
            id: att.id,
            filename: att.name,
            url: att.url,
            size: att.size,
            content_type: att.contentType || undefined,
          })),
          embeds: msg.embeds.length,
          mentions: Array.from(msg.mentions.users.keys()).map(id => String(id)),
          reactions: msg.reactions.cache.map((reaction: any) => ({
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

      // Load classification history
      const resultsDir = join(process.cwd(), classifyConfig.paths.resultsDir || "results");
      const classificationHistory = await loadClassificationHistory(resultsDir);

      // Use the freshly fetched Discord cache
      const allCachedMessages = getAllMessagesFromCache(finalDiscordCache);
      
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
                // Also skip if the thread was already classified (after migration)
                // Note: "classifying" threads will be reset to "pending" later and retried
                const threadStatus = getThreadStatus(threadId, classificationHistory);
                const isThreadAlreadyClassified = !re_classify && threadStatus === "completed";

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
              // Check if this message has already been classified (either as a message or as a thread)
              const isAlreadyClassified = !re_classify && (
                classificationHistory.messages[msg.id] || 
                getThreadStatus(msg.id, classificationHistory) === "completed"
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

      // Determine output file path BEFORE processing (so we can save incrementally)
      const existingFiles = await readdir(resultsDir).catch(() => []);
      const existingClassificationFile = existingFiles
        .filter(f => f.startsWith(`discord-classified-`) && f.includes(actualChannelId) && f.endsWith('.json'))
        .sort()
        .reverse()[0]; // Most recent

      let outputPath: string;
      let existingClassifiedThreads: any[] = [];

      if (existingClassificationFile) {
        outputPath = join(resultsDir, existingClassificationFile);
        try {
          const existingContent = await readFile(outputPath, "utf-8");
          const existingData = JSON.parse(existingContent);
          existingClassifiedThreads = existingData.classified_threads || [];
          console.error(`[Classification] Will merge into existing file: ${existingClassificationFile} (${existingClassifiedThreads.length} threads)`);
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

      // Map to track all classified threads (existing + new)
      const threadMap = new Map<string, any>();
      for (const thread of existingClassifiedThreads) {
        const threadId = thread.thread?.thread_id || thread.thread_id;
        if (threadId) threadMap.set(threadId, thread);
      }

      // Helper to save current progress to JSON file
      const saveProgressToFile = async (newlyClassifiedCount: number) => {
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

        // Save intermediate status (classifying)
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
                thread_name: msg.threadName || undefined,
                message_count: messageIds.length,
                first_message_id: classifiedMsg.message.id,
                first_message_author: classifiedMsg.message.author,
                first_message_timestamp: classifiedMsg.message.timestamp,
                first_message_url: classifiedMsg.message.url,
                classified_status: "completed",
                message_ids: messageIds,
                is_standalone: !msg.threadId,
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
                    thread_name: threadMsg.threadName || undefined,
                    message_count: threadMsg.messageIds?.length || 1,
                    first_message_id: msg.id,
                    first_message_author: msg.author,
                    first_message_timestamp: msg.timestamp,
                    first_message_url: msg.url,
                    classified_status: "completed",
                    message_ids: threadMsg.messageIds || [msg.id],
                    is_standalone: !threadMsg.threadId,
                  },
                  issues: [],
                });
              }
            }
          });

          allClassified.push(...batchClassified);

          // Save progress after each batch (both history AND JSON file)
          await saveClassificationHistory(updatedHistory, resultsDir);
          await saveProgressToFile(allClassified.length);
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

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              ...result,
              output_file: outputPath,
              message: classified.length > 0 
                ? `Classified ${classified.length} new threads. Total in file: ${mergedThreads.length}. Saved to: ${outputPath}`
                : `No new threads to classify. File has ${mergedThreads.length} classified threads. File: ${outputPath}`,
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

      const results: any = {
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
            step: 1,
            name: "sync_discord",
            status: "success",
            result: {
              total_count: discordMessageCount,
              message: "Using existing cache. For full sync, run fetch_discord_messages separately.",
            },
          });
        } else {
          results.steps.push({
            step: 1,
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
          step: 2,
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
          step: failedStep,
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
          const groupingData = JSON.parse(groupingContent);
          
          // Import the export function for grouping data
          const { exportGroupingToPMTool } = await import("../export/groupingExporter.js");
          result = await exportGroupingToPMTool(groupingData, pmToolConfig);
          
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
        const linearTool = pmTool as any;

        if (typeof linearTool.listTeams !== "function") {
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
        max_groups = 50, 
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
        const history = await loadClassificationHistory(resultsDir);
        const existingGroupStats = getGroupingStats(history);
        
        console.error(`[Grouping] Existing groups: ${existingGroupStats.totalGroups} (${existingGroupStats.exportedGroups} exported, ${existingGroupStats.pendingGroups} pending)`);

        // ============================================================
        // STEP 1: Check for existing classification results
        // ============================================================
        let classificationResults: ClassificationResults | null = null;
        
        // Find classification file for this channel
        const classificationFiles = await readdir(resultsDir).catch(() => []);
        const classificationFile = classificationFiles
          .filter(f => f.startsWith(`discord-classified-`) && f.includes(actualChannelId) && f.endsWith('.json'))
          .sort()
          .reverse()[0]; // Most recent
        
        if (classificationFile && !semantic_only) {
          const classificationPath = join(resultsDir, classificationFile);
          const classificationContent = await readFile(classificationPath, "utf-8");
          const parsed = JSON.parse(classificationContent) as ClassificationResults;
          
          // Only use if it has actual data
          if (parsed.classified_threads && parsed.classified_threads.length > 0) {
            classificationResults = parsed;
            console.error(`[Grouping] Found classification results: ${parsed.classified_threads.length} threads in ${classificationFile}`);
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
            const issuesCache = JSON.parse(issuesCacheContent) as IssuesCache;
            
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
            
            // Save classification results
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
          }
        }

        // ============================================================
        // STEP 3: Group by classification results (issue-based) OR semantic
        // ============================================================
        let outputData: any;
        
        if (classificationResults && !semantic_only) {
          // Issue-based grouping: Group threads by matched GitHub issues
          console.error(`[Grouping] Grouping by matched GitHub issues...`);
          
          const groupResult = groupByClassificationResults(classificationResults, {
            minSimilarity: min_similarity,
            maxGroups: max_groups,
            topIssuesPerThread: 3,
          });
          
          // Find existing grouping file to merge with
          await mkdir(resultsDir, { recursive: true });
          const existingGroupingFiles = await readdir(resultsDir).catch(() => []);
          const existingGroupingFile = existingGroupingFiles
            .filter(f => f.startsWith(`grouping-`) && f.includes(actualChannelId) && f.endsWith('.json'))
            .sort()
            .reverse()[0];

          let outputPath: string;
          let existingGroups: any[] = [];

          if (existingGroupingFile) {
            outputPath = join(resultsDir, existingGroupingFile);
            try {
              const existingContent = await readFile(outputPath, "utf-8");
              const existingData = JSON.parse(existingContent);
              existingGroups = existingData.groups || [];
              console.error(`[Grouping] Merging with existing file: ${existingGroupingFile} (${existingGroups.length} groups)`);
            } catch {
              outputPath = join(resultsDir, `grouping-${actualChannelId}-${Date.now()}.json`);
            }
          } else {
            outputPath = join(resultsDir, `grouping-${actualChannelId}-${Date.now()}.json`);
            console.error(`[Grouping] Creating new file: ${outputPath}`);
          }
          
          // Save groups to history
          for (const group of groupResult.groups) {
            addGroup(history, {
              group_id: group.id,
              suggested_title: group.issue.title,
              similarity: group.avgSimilarity / 100, // Normalize to 0-1
              is_cross_cutting: false,
              affects_features: [],
              signal_ids: group.threads.map(t => `discord:${t.thread_id}`),
              github_issue: group.issue.number,
            });
          }
          
          await saveClassificationHistory(history, resultsDir);
          
          // Format output
          const formattedGroups = groupResult.groups.map(group => ({
            id: group.id,
            github_issue: {
              number: group.issue.number,
              title: group.issue.title,
              url: group.issue.url,
              state: group.issue.state,
              labels: group.issue.labels,
            },
            avg_similarity: Math.round(group.avgSimilarity * 10) / 10,
            thread_count: group.threads.length,
            threads: group.threads.map(t => ({
              thread_id: t.thread_id,
              thread_name: t.thread_name,
              similarity_score: Math.round(t.similarity_score * 10) / 10,
              url: t.url,
              author: t.author,
            })),
          }));
          
          // Merge with existing groups (deduplicate by group id)
          const groupMap = new Map<string, any>();
          for (const group of existingGroups) {
            groupMap.set(group.id, group);
          }
          for (const group of formattedGroups) {
            groupMap.set(group.id, group); // New groups overwrite existing
          }
          const mergedGroups = Array.from(groupMap.values());
          
          outputData = {
            timestamp: new Date().toISOString(),
            channel_id: actualChannelId,
            grouping_method: "issue-based",
            options: { min_similarity, max_groups },
            stats: {
              ...groupResult.stats,
              total_groups_in_file: mergedGroups.length,
              newly_grouped: formattedGroups.length,
              previously_grouped: existingGroups.length,
            },
            groups: mergedGroups,
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
                    newly_grouped: formattedGroups.length,
                    previously_grouped: existingGroups.length,
                    total_groups_in_history: updatedGroupStats.totalGroups,
                    exported_groups: updatedGroupStats.exportedGroups,
                    pending_groups: updatedGroupStats.pendingGroups,
                  },
                  groups_count: mergedGroups.length,
                  groups: mergedGroups,
                  output_file: outputPath,
                  message: formattedGroups.length > 0
                    ? `Added ${formattedGroups.length} new groups. Total in file: ${mergedGroups.length}. Saved to ${outputPath}`
                    : `No new groups. File has ${mergedGroups.length} groups. File: ${outputPath}`,
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
          const issuesCache = JSON.parse(issuesCacheContent) as IssuesCache;
          
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
          
          // Extract features
          let features: Feature[] = [];
          const docUrls = config.pmIntegration?.documentation_urls;
          if (docUrls && docUrls.length > 0) {
            const docs = await fetchMultipleDocumentation(docUrls);
            if (docs.length > 0) {
              const extractedFeatures = await extractFeaturesFromDocumentation(docs);
              features = extractedFeatures.map(f => ({
                id: f.id,
                name: f.name,
                description: f.description,
              }));
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
          let existingSemanticGroups: any[] = [];

          if (existingSemanticFile) {
            semanticOutputPath = join(resultsDir, existingSemanticFile);
            try {
              const existingContent = await readFile(semanticOutputPath, "utf-8");
              const existingData = JSON.parse(existingContent);
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
              is_cross_cutting: group.isCrossCutting,
              affects_features: group.affectsFeatures,
              signal_ids: group.signals.map(s => `${s.source}:${s.sourceId}`),
            });
          }
          
          await saveClassificationHistory(history, resultsDir);
          
          // Format output
          const formattedSemanticGroups = result.groups.map(group => ({
            id: group.id,
            suggested_title: group.suggestedTitle,
            similarity: Math.round(group.similarity * 100) / 100,
            is_cross_cutting: group.isCrossCutting,
            affects_features: group.affectsFeatures.map(fid => {
              const feature = features.find(f => f.id === fid);
              return feature ? { id: fid, name: feature.name } : { id: fid, name: fid };
            }),
            signals: group.signals.map(s => ({
              source: s.source,
              id: s.sourceId,
              title: s.title || s.body.substring(0, 50) + "...",
              url: s.permalink,
            })),
            canonical_issue: group.canonicalIssue ? {
              source: group.canonicalIssue.source,
              id: group.canonicalIssue.sourceId,
              title: group.canonicalIssue.title,
              url: group.canonicalIssue.permalink,
            } : null,
          }));
          
          // Merge with existing groups
          const semanticGroupMap = new Map<string, any>();
          for (const group of existingSemanticGroups) {
            semanticGroupMap.set(group.id, group);
          }
          for (const group of formattedSemanticGroups) {
            semanticGroupMap.set(group.id, group);
          }
          const mergedSemanticGroups = Array.from(semanticGroupMap.values());
          
          outputData = {
            timestamp: new Date().toISOString(),
            channel_id: actualChannelId,
            grouping_method: "semantic",
            options: { min_similarity, max_groups },
            stats: {
              ...result.stats,
              total_groups_in_file: mergedSemanticGroups.length,
              newly_grouped: formattedSemanticGroups.length,
              previously_grouped: existingSemanticGroups.length,
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
                  cross_cutting_count: mergedSemanticGroups.filter((g: any) => g.is_cross_cutting).length,
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

    default:
      throw new Error(`Unknown tool: ${name}`);
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
