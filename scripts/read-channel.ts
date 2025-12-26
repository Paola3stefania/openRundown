#!/usr/bin/env node
/**
 * Quick script to read messages from Discord channel
 * Run with: npm run read-channel
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

const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
if (!DISCORD_TOKEN) {
  console.error("Error: DISCORD_TOKEN environment variable is required");
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
    // Get first available server (or use config)
    const guilds = Array.from(discord.guilds.cache.values());
    
    if (guilds.length === 0) {
      console.log("Error: No servers found. Make sure the bot is invited to at least one server.");
      process.exit(1);
    }

    // Use the first server (can be customized via DISCORD_SERVER_ID in config)
    const targetGuild = guilds[0];
    console.log(`Using server: ${targetGuild.name} (ID: ${targetGuild.id})\n`);

    // List all channels
    const channels = targetGuild.channels.cache
      .filter(ch => 
        ch.type === ChannelType.GuildText || 
        ch.type === ChannelType.GuildAnnouncement
      );

    console.log("Available channels:");
    channels.forEach(ch => {
      console.log(`   - #${ch.name} (${ch.id})`);
    });

    // Use first channel or 'general' if available
    const targetChannel = channels.find(ch => 
      ch.name.toLowerCase() === "general" ||
      ch.name.toLowerCase() === "chat"
    ) || channels.first();

    if (!targetChannel) {
      console.log("\nError: No text channels found.");
      process.exit(1);
    }

    console.log(`\nReading messages from #${targetChannel.name}...\n`);
    console.log("=".repeat(70));

    // Fetch messages
    const channel = await discord.channels.fetch(targetChannel.id);
    
    if (!channel || 
        (!(channel instanceof TextChannel) && 
         !(channel instanceof DMChannel) && 
         !(channel instanceof NewsChannel))) {
      console.log("Error: Channel does not support messages");
      process.exit(1);
    }

    const messages = await channel.messages.fetch({ limit: 30 });
    const messageArray = Array.from(messages.values()).reverse();

    if (messageArray.length === 0) {
      console.log("No messages found in this channel.");
    } else {
      messageArray.forEach((msg, i) => {
        const date = new Date(msg.createdAt).toLocaleString();
        console.log(`\n[${i + 1}] ${msg.author.username} • ${date}`);
        if (msg.content) {
          console.log(msg.content);
        }
        if (msg.attachments.size > 0) {
          console.log(`   Attachments: ${msg.attachments.size} attachment(s)`);
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
    console.log(`Read ${messageArray.length} message(s) successfully!\n`);

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

