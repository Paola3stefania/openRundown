#!/usr/bin/env node
/**
 * Search both GitHub issues and Discord messages
 * Run with: npm run search-combined <query> [channel_id]
 */
import "dotenv/config";
import {
  Client,
  GatewayIntentBits,
  TextChannel,
  DMChannel,
  NewsChannel,
  ChannelType,
} from "discord.js";
import { searchGitHubIssues, formatGitHubIssue } from "../src/github-integration.js";
import { getConfig } from "../src/config.js";

const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
if (!DISCORD_TOKEN) {
  console.error("Error: DISCORD_TOKEN environment variable is required");
  process.exit(1);
}
const config = getConfig();

const query = process.argv[2] || "stripe";
const channelId = process.argv[3] || config.discord.defaultChannelId || "";

if (!channelId) {
  console.error("Error: Channel ID is required. Set DISCORD_DEFAULT_CHANNEL_ID in .env or pass as argument.");
  console.error("Usage: npm run search-combined [query] [channel_id]");
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
  console.log(`Searching for: "${query}"\n`);
  console.log("=".repeat(70));

  try {
    // Search GitHub Issues
    console.log("\nGITHUB ISSUES:\n");
    try {
      const githubToken = process.env.GITHUB_TOKEN;
      const results = await searchGitHubIssues(query, githubToken, config.github.owner, config.github.repo);
      
      if (results.total_count === 0) {
        console.log("No GitHub issues found.");
      } else {
        console.log(`Found ${results.total_count} issue(s):\n`);
        results.items.slice(0, 10).forEach((issue, index) => {
          console.log(`${index + 1}. #${issue.number}: ${issue.title}`);
          console.log(`   State: ${issue.state} | Author: ${issue.user.login}`);
          console.log(`   URL: ${issue.html_url}`);
          if (issue.labels.length > 0) {
            console.log(`   Labels: ${issue.labels.map((l) => l.name).join(", ")}`);
          }
          console.log("");
        });
        
        if (results.total_count > 10) {
          console.log(`... and ${results.total_count - 10} more issues\n`);
        }
      }
    } catch (error) {
      console.error("Error: Error searching GitHub:", error instanceof Error ? error.message : error);
    }

    console.log("=".repeat(70));

    // Search Discord Messages
    console.log("\nDISCORD MESSAGES:\n");
    try {
      const channel = await discord.channels.fetch(channelId);
      
      if (!channel || 
          (!(channel instanceof TextChannel) && 
           !(channel instanceof DMChannel) && 
           !(channel instanceof NewsChannel))) {
        console.log("Error: Channel does not support messages");
      } else {
        const channelName = channel instanceof TextChannel || channel instanceof NewsChannel
          ? `#${channel.name}`
          : "DM";
        
        console.log(`Searching in ${channelName}...\n`);
        
        const messages = await channel.messages.fetch({ limit: 100 });
        const queryLower = query.toLowerCase();

        const matchingMessages = Array.from(messages.values())
          .filter((msg) => msg.content.toLowerCase().includes(queryLower))
          .slice(0, 10);

        if (matchingMessages.length === 0) {
          console.log("No Discord messages found.");
        } else {
          console.log(`Found ${matchingMessages.length} message(s):\n`);
          matchingMessages.forEach((msg, index) => {
            const date = new Date(msg.createdAt).toLocaleString();
            console.log(`${index + 1}. ${msg.author.username} (${date})`);
            console.log(`   ${msg.content.substring(0, 200)}${msg.content.length > 200 ? "..." : ""}`);
            console.log("");
          });
        }
      }
    } catch (error) {
      console.error("Error: Error searching Discord:", error instanceof Error ? error.message : error);
    }

    console.log("=".repeat(70));
    console.log("\nSearch complete!\n");

  } catch (error) {
    console.error("Error: Error:", error instanceof Error ? error.message : error);
  } finally {
    await discord.destroy();
    process.exit(0);
  }
});

discord.login(DISCORD_TOKEN).catch((error) => {
  console.error("Error: Failed to login:", error.message);
  process.exit(1);
});


