#!/usr/bin/env node
import "dotenv/config";
import {
  Client,
  GatewayIntentBits,
  TextChannel,
  DMChannel,
  NewsChannel,
  ChannelType,
  Guild,
} from "discord.js";

const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
if (!DISCORD_TOKEN) {
  console.error("Error: DISCORD_TOKEN environment variable is required");
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

discord.once("ready", async () => {
  console.log(`Discord bot logged in as ${discord.user?.tag}\n`);

  try {
    // Get first available server (or use config to find specific one)
    console.log("Available Discord servers:\n");
    const guilds = discord.guilds.cache;
    
    if (guilds.size === 0) {
      console.log("Error: No servers found. Make sure the bot is invited to at least one server.");
      process.exit(1);
    }

    // List all servers
    const guildsArray = Array.from(guilds.values());
    guildsArray.forEach((guild, index) => {
      console.log(`  [${index + 1}] ${guild.name} (ID: ${guild.id})`);
    });

    // Use the first server (can be customized via config)
    const targetGuild: Guild = guildsArray[0];
    console.log(`\nUsing server: ${targetGuild.name} (ID: ${targetGuild.id})\n`);

    // Find channels
    console.log("Channels in the server:");
    const channels = targetGuild.channels.cache
      .filter(
        (channel) =>
          channel.type === ChannelType.GuildText ||
          channel.type === ChannelType.GuildAnnouncement
      );

    channels.forEach(channel => {
      console.log(`  - #${channel.name} (ID: ${channel.id})`);
    });

    // Try to find a general/discussion channel, or use the first one
    let targetChannel = channels.find(ch => 
      ch.name.toLowerCase().includes("general") || 
      ch.name.toLowerCase().includes("chat") ||
      ch.name.toLowerCase().includes("discussion")
    ) || channels.first();

    if (!targetChannel) {
      console.log("\nError: No text channels found in the server.");
      process.exit(1);
    }

    console.log(`\n reading messages from: #${targetChannel.name}\n`);
    console.log("=".repeat(60));

    // Fetch messages
    const channel = await discord.channels.fetch(targetChannel.id);
    
    if (!channel || 
        (!(channel instanceof TextChannel) && 
         !(channel instanceof DMChannel) && 
         !(channel instanceof NewsChannel))) {
      console.log("Error: Channel does not support messages");
      process.exit(1);
    }

    const messages = await channel.messages.fetch({ limit: 20 });
    const formattedMessages = Array.from(messages.values())
      .reverse()
      .map((msg) => ({
        author: msg.author.username,
        content: msg.content,
        timestamp: msg.createdAt.toISOString(),
        attachments: msg.attachments.size > 0 ? msg.attachments.map(a => a.name) : [],
      }));

    formattedMessages.forEach((msg, index) => {
      console.log(`\n[${index + 1}] ${msg.author} (${new Date(msg.timestamp).toLocaleString()})`);
      if (msg.content) {
        console.log(msg.content);
      }
      if (msg.attachments.length > 0) {
        console.log(`Attachments: ${msg.attachments.join(", ")}`);
      }
      if (index < formattedMessages.length - 1) {
        console.log("-".repeat(60));
      }
    });

    console.log("\n" + "=".repeat(60));
    console.log(`\nRead ${formattedMessages.length} messages successfully!`);

  } catch (error) {
    console.error("Error: Error:", error);
  } finally {
    await discord.destroy();
    process.exit(0);
  }
});

discord.login(DISCORD_TOKEN).catch((error) => {
  console.error("Failed to login:", error);
  process.exit(1);
});

