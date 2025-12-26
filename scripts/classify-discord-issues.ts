#!/usr/bin/env node
/**
 * Classify Discord messages by matching them with GitHub issues
 * 
 * Usage:
 *   npm run classify-issues                           # Uses all defaults from .env
 *   npm run classify-issues [limit]                   # Uses default channel, custom limit
 *   npm run classify-issues [channel_id] [limit] [minSimilarity] [output_file]
 * 
 * If channel_id is not provided, uses DISCORD_DEFAULT_CHANNEL_ID from .env
 */
import "dotenv/config";
import { writeFile, mkdir } from "fs/promises";
import { join } from "path";
import { existsSync } from "fs";
import {
  Client,
  GatewayIntentBits,
  TextChannel,
  DMChannel,
  NewsChannel,
} from "discord.js";
import { 
  classifyMessagesWithCache, 
  type DiscordMessage,
  type GitHubIssue 
} from "../src/issue-classifier.js";
import { loadIssuesFromCache } from "../src/github-integration.js";
import { loadDiscordCache, getAllMessagesFromCache } from "../src/discord-cache.js";
import { getConfig } from "../src/config.js";

const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
if (!DISCORD_TOKEN) {
  console.error("Error: DISCORD_TOKEN environment variable is required");
  process.exit(1);
}
const config = getConfig();

// Parse arguments: [channel_id] [limit] [minSimilarity] [output_file]
// If first arg is a number, treat it as limit instead of channel_id
let channelId: string | undefined;
let limit: number;
let minSimilarity: number;
let outputFile: string | undefined;

if (process.argv[2]) {
  // Check if first arg is a number (limit) or string (channel_id)
  const firstArg = process.argv[2];
  if (/^\d+$/.test(firstArg)) {
    // It's a number, treat as limit (using default channel)
    channelId = config.discord.defaultChannelId || undefined;
    limit = parseInt(firstArg) || 30;
    minSimilarity = parseInt(process.argv[3]) || 20;
    outputFile = process.argv[4];
  } else {
    // It's a channel ID
    channelId = firstArg;
    limit = parseInt(process.argv[3]) || 30;
    minSimilarity = parseInt(process.argv[4]) || 20;
    outputFile = process.argv[5];
  }
} else {
  // No arguments, use all defaults
  channelId = config.discord.defaultChannelId || undefined;
  limit = 30;
  minSimilarity = 20;
  outputFile = undefined;
}

if (!channelId) {
  console.error("Error: Channel ID is required. Set DISCORD_DEFAULT_CHANNEL_ID in .env or pass as argument.");
  console.error("Usage: npm run classify-issues [channel_id] [limit] [minSimilarity] [output_file]");
  console.error("   OR: npm run classify-issues [limit] [minSimilarity] [output_file] (uses default channel)");
  process.exit(1);
}

const discord = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.DirectMessages,
  ],
});

discord.once("ready", async () => {
  console.log(`Logged in as ${discord.user?.tag}\n`);

  try {
    const channel = await discord.channels.fetch(channelId);
    
    if (!channel || 
        (!(channel instanceof TextChannel) && 
         !(channel instanceof DMChannel) && 
         !(channel instanceof NewsChannel))) {
      console.log("Error:Channel does not support messages");
      process.exit(1);
    }

    const channelName = channel instanceof TextChannel || channel instanceof NewsChannel
      ? `#${channel.name}`
      : "DM";
    
    const guildId = channel instanceof TextChannel || channel instanceof NewsChannel
      ? channel.guild.id
      : "@me";

    console.log(`Reading messages from ${channelName}...\n`);

    // Try to load from cache first
    const discordCachePath = join(process.cwd(), "discord", `discord-messages-${channelId}.json`);
    let discordMessages: DiscordMessage[] = [];
    let useCache = false;

    if (existsSync(discordCachePath)) {
      try {
        console.log("Loading Discord messages from cache...");
        const discordCache = await loadDiscordCache(discordCachePath);
        const allCachedMessages = getAllMessagesFromCache(discordCache);
        
        // Get the most recent N messages (sorted newest first, then reverse to get oldest first)
        const sortedMessages = allCachedMessages
          .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())
          .slice(0, limit)
          .reverse();

        // Convert cached format to DiscordMessage format
        discordMessages = sortedMessages.map((msg) => ({
          id: msg.id,
          author: msg.author.username,
          content: msg.content,
          timestamp: msg.created_at,
          url: msg.url || `https://discord.com/channels/${guildId}/${channelId}/${msg.id}`,
        }));

        console.log(`   Found ${allCachedMessages.length} total cached messages`);
        console.log(`   Using last ${discordMessages.length} messages from cache\n`);
        useCache = true;
      } catch (error) {
        console.log(`   Error loading cache: ${error instanceof Error ? error.message : error}`);
        console.log("   Falling back to fetching from Discord API...\n");
      }
    }

    // Fallback to fetching from API if cache doesn't exist or failed
    if (!useCache) {
    const messages = await channel.messages.fetch({ limit });
    const messageArray = Array.from(messages.values()).reverse();

      console.log(`Fetched ${messageArray.length} messages from Discord API. Analyzing...\n`);

    // Convert to DiscordMessage format
      discordMessages = messageArray.map((msg) => ({
      id: msg.id,
      author: msg.author.username,
      content: msg.content,
      timestamp: msg.createdAt.toISOString(),
      url: `https://discord.com/channels/${guildId}/${channelId}/${msg.id}`,
    }));
    }

    // Load issues from cache
    const cachePath = join(process.cwd(), config.paths.cacheDir, config.paths.issuesCacheFile);
    let issues: GitHubIssue[] = [];
    
    if (existsSync(cachePath)) {
      console.log("Loading issues from cache...");
      try {
        const cache = await loadIssuesFromCache(cachePath);
        issues = cache.issues;
        const cacheAge = new Date(cache.fetched_at);
        const ageHours = Math.floor((Date.now() - cacheAge.getTime()) / (1000 * 60 * 60));
        console.log(`   Found ${issues.length} issues (${cache.open_count} open, ${cache.closed_count} closed)`);
        console.log(`   Cache age: ${ageHours} hours\n`);
      } catch (error) {
        console.error(`   Error loading cache: ${error instanceof Error ? error.message : error}`);
        console.log("   Run 'npm run fetch-issues' to create the cache.\n");
        process.exit(1);
      }
    } else {
      console.error(`Error: Issues cache not found at: ${cachePath}`);
      console.log("   Run 'npm run fetch-issues' to fetch and cache all issues first.\n");
      process.exit(1);
    }

    // Classify messages
    const useSemantic = config.classification?.useSemantic ?? false;
    const method = useSemantic ? "semantic (LLM-based)" : "keyword-based";
    console.log(`Matching messages with GitHub issues using ${method} classification...\n`);
    console.log("=".repeat(70));

    const classified = await classifyMessagesWithCache(discordMessages, issues, minSimilarity, useSemantic);

    if (classified.length === 0) {
      console.log(`No messages matched with GitHub issues (similarity threshold: ${minSimilarity}%)\n`);
    } else {
      console.log(`\nFound ${classified.length} message(s) related to GitHub issues:\n`);

      classified.forEach((classifiedMsg, index) => {
        const date = new Date(classifiedMsg.message.timestamp).toLocaleString();
        
        console.log(`\n[${index + 1}] ${classifiedMsg.message.author} (${date})`);
        console.log(`Message: ${classifiedMsg.message.content.substring(0, 150)}${classifiedMsg.message.content.length > 150 ? "..." : ""}`);
        console.log(`URL: ${classifiedMsg.message.url}`);
        console.log(`\n   Related GitHub Issues (${classifiedMsg.relatedIssues.length}):`);
        
        classifiedMsg.relatedIssues.forEach((match, issueIndex) => {
          console.log(`   ${issueIndex + 1}. #${match.issue.number}: ${match.issue.title}`);
          console.log(` Similarity: ${match.similarityScore.toFixed(1)}%`);
          console.log(` Matched terms: ${match.matchedTerms.join(", ") || "none"}`);
          console.log(` URL: ${match.issue.html_url}`);
          console.log(`      State: ${match.issue.state}`);
        });
        
        console.log("-".repeat(70));
      });
    }

    console.log("\n" + "=".repeat(70));
    console.log(`\nSummary:`);
    console.log(`   Total messages analyzed: ${discordMessages.length}`);
    console.log(`   Messages linked to issues: ${classified.length}`);
    console.log(`   Coverage: ${((classified.length / discordMessages.length) * 100).toFixed(1)}%\n`);

    // Prepare output data
    const outputData = {
      channel_id: channelId,
      channel_name: channelName,
      analysis_date: new Date().toISOString(),
      summary: {
        total_messages: discordMessages.length,
        classified_count: classified.length,
        coverage_percentage: parseFloat(((classified.length / discordMessages.length) * 100).toFixed(1)),
      },
      classified_messages: classified.map((classifiedMsg) => ({
        message: {
          id: classifiedMsg.message.id,
          author: classifiedMsg.message.author,
          content: classifiedMsg.message.content,
          timestamp: classifiedMsg.message.timestamp,
          url: classifiedMsg.message.url,
        },
        related_issues: classifiedMsg.relatedIssues.map((match) => ({
          number: match.issue.number,
          title: match.issue.title,
          state: match.issue.state,
          url: match.issue.html_url,
          similarity_score: match.similarityScore,
          matched_terms: match.matchedTerms,
          labels: match.issue.labels.map((l) => l.name),
          author: match.issue.user.login,
          created_at: match.issue.created_at,
        })),
      })),
    };

    // Ensure results directory exists
    const resultsDir = join(process.cwd(), "results");
    try {
      await mkdir(resultsDir, { recursive: true });
    } catch (error) {
      // Directory might already exist, that's fine
    }

    // Save to file if output path is provided
    if (outputFile) {
      const filePath = outputFile.startsWith("/") 
        ? outputFile 
        : join(resultsDir, outputFile);
      
      await writeFile(filePath, JSON.stringify(outputData, null, 2), "utf-8");
      console.log(`\nResults saved to: ${filePath}\n`);
    } else {
      // Save to default location in results folder
      const safeChannelName = channelName.replace("#", "").replace(/[^a-z0-9]/gi, "-");
      const timestamp = Date.now();
      const defaultPath = join(
        resultsDir,
        `discord-classified-${safeChannelName}-${channelId}-${timestamp}.json`
      );
      await writeFile(defaultPath, JSON.stringify(outputData, null, 2), "utf-8");
      console.log(`\nResults saved to: ${defaultPath}\n`);
    }

  } catch (error) {
    console.error("Error: Error:", error instanceof Error ? error.message : error);
    if (error instanceof Error && error.stack) {
      console.error(error.stack);
    }
  } finally {
    await discord.destroy();
    process.exit(0);
  }
});

discord.login(DISCORD_TOKEN).catch((error) => {
  console.error("Error: Failed to login:", error.message);
  process.exit(1);
});

