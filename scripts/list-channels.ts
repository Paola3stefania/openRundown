#!/usr/bin/env node
/**
 * List channels from Discord server
 * Run with: npm run list-channels [server_id]
 */
import "dotenv/config";
import {
  Client,
  GatewayIntentBits,
  ChannelType,
} from "discord.js";
import { getConfig } from "../src/config.js";

const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
if (!DISCORD_TOKEN) {
  console.error("Error: DISCORD_TOKEN environment variable is required");
  process.exit(1);
}
const config = getConfig();
const SERVER_ID = process.argv[2] || config.discord.serverId || "";

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
    if (!SERVER_ID) {
      console.log("Error: Server ID not provided. Set DISCORD_SERVER_ID or pass as argument.");
      process.exit(1);
    }

    const guild = discord.guilds.cache.get(SERVER_ID);
    
    if (!guild) {
      console.log(`Error: Server with ID ${SERVER_ID} not found`);
      process.exit(1);
    }

    console.log(`Server: ${guild.name}\n`);

    // Get all text channels
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
      }))
      .sort((a, b) => a.name.localeCompare(b.name));

    console.log(`Text Channels (${channels.length} total):`);
    console.log("=".repeat(70));
    
    channels.forEach((ch, index) => {
      console.log(`[${index + 1}] #${ch.name}`);
      console.log(`    ID: ${ch.id}`);
      console.log(`    Type: ${ch.type}`);
      if (index < channels.length - 1) {
        console.log("");
      }
    });

    console.log("=".repeat(70));
    console.log(`\nFound ${channels.length} channel(s) in ${guild.name}\n`);

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


