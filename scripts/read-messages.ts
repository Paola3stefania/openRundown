#!/usr/bin/env node
/**
 * Read messages from Discord server
 * Run with: npm run read-messages
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
import { getConfig } from "../src/config.js";

const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
if (!DISCORD_TOKEN) {
  console.error("Error: DISCORD_TOKEN environment variable is required");
  process.exit(1);
}
const config = getConfig();
const SERVER_ID = config.discord.serverId || "";

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
      console.log("Error: Server ID not configured. Set DISCORD_SERVER_ID environment variable.");
      process.exit(1);
    }

    const guild = discord.guilds.cache.get(SERVER_ID);
    
    if (!guild) {
      console.log(`Error: Server with ID ${SERVER_ID} not found`);
      process.exit(1);
    }

    console.log(`Server: ${guild.name}\n`);

    // List all text channels
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

    console.log("Available channels:");
    console.log("=".repeat(70));
    channels.forEach((ch, index) => {
      console.log(`[${index + 1}] #${ch.name} (${ch.id})`);
    });
    console.log("=".repeat(70));

    // Get the first channel (or you can specify a channel name)
    const targetChannelName = process.argv[2] || null;
    let targetChannel = null;

    if (targetChannelName) {
      targetChannel = channels.find(ch => 
        ch.name.toLowerCase() === targetChannelName.toLowerCase()
      );
      if (!targetChannel) {
        console.log(`\nError: Channel "${targetChannelName}" not found. Using first channel instead.\n`);
        targetChannel = channels[0];
      }
    } else {
      // Use configured channel names or first available
      const channelNames = [
        config.discord.channelNames?.general,
        config.discord.channelNames?.chat,
        config.discord.channelNames?.development,
        "general",
        "chat",
        "discussion"
      ].filter(Boolean);
      
      targetChannel = channels.find(ch => 
        channelNames.some(name => ch.name.toLowerCase() === name?.toLowerCase())
      ) || channels[0];
    }

    if (!targetChannel) {
      console.log("\nError: No text channels found in the server.");
      process.exit(1);
    }

    console.log(`\nReading messages from #${targetChannel.name}...\n`);
    console.log("=".repeat(70));

    // Fetch channel and messages
    const channel = await discord.channels.fetch(targetChannel.id);
    
    if (!channel || 
        (!(channel instanceof TextChannel) && 
         !(channel instanceof DMChannel) && 
         !(channel instanceof NewsChannel))) {
      console.log("Error: Channel does not support messages");
      process.exit(1);
    }

    const limit = parseInt(process.argv[3]) || 30;
    const messages = await channel.messages.fetch({ limit });
    const messageArray = Array.from(messages.values()).reverse();

    if (messageArray.length === 0) {
      console.log("No messages found in this channel.");
    } else {
      messageArray.forEach((msg, i) => {
        const date = new Date(msg.createdAt).toLocaleString();
        console.log(`\n[${i + 1}] ${msg.author.username}${msg.author.bot ? " [BOT]" : ""} • ${date}`);
        if (msg.content) {
          console.log(msg.content);
        }
        if (msg.attachments.size > 0) {
          msg.attachments.forEach(att => {
            console.log(`   Attachment: ${att.name} (${att.url})`);
          });
        }
        if (msg.embeds.length > 0) {
          console.log(`   Embeds: ${msg.embeds.length} embed(s)`);
        }
        if (i < messageArray.length - 1) {
          console.log("-".repeat(70));
        }
      });
    }

    console.log("\n" + "=".repeat(70));
    console.log(`Read ${messageArray.length} message(s) from #${targetChannel.name}\n`);

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

