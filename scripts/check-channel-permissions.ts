#!/usr/bin/env node
/**
 * Check which channels the bot has permission to read messages from
 * Run with: npm run check-permissions
 */
import "dotenv/config";
import {
  Client,
  GatewayIntentBits,
  ChannelType,
  TextChannel,
  NewsChannel,
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

    console.log(`Checking read permissions for ${channels.length} channels...\n`);
    console.log("=".repeat(70));

    const accessibleChannels: Array<{ name: string; id: string; type: string }> = [];
    const inaccessibleChannels: Array<{ name: string; id: string; reason: string }> = [];

    // Check each channel
    for (const channelInfo of channels) {
      try {
        const channel = await discord.channels.fetch(channelInfo.id);
        
        if (!channel || (!(channel instanceof TextChannel) && !(channel instanceof NewsChannel))) {
          inaccessibleChannels.push({
            name: channelInfo.name,
            id: channelInfo.id,
            reason: "Not a text/announcement channel",
          });
          continue;
        }

        // Try to fetch a single message to check permissions
        try {
          await channel.messages.fetch({ limit: 1 });
          accessibleChannels.push({
            name: channelInfo.name,
            id: channelInfo.id,
            type: channelInfo.type,
          });
          console.log(`#${channelInfo.name} - Accessible`);
        } catch (error: any) {
          const reason = error.code === 50001 ? "Missing Access" : 
                        error.code === 50013 ? "Missing Permissions" :
                        error.code === 50001 ? "Missing Access" :
                        error.message || "Unknown error";
          inaccessibleChannels.push({
            name: channelInfo.name,
            id: channelInfo.id,
            reason,
          });
          console.log(`Error: #${channelInfo.name} - ${reason}`);
        }
      } catch (error: any) {
        inaccessibleChannels.push({
          name: channelInfo.name,
          id: channelInfo.id,
          reason: error.message || "Failed to fetch channel",
        });
        console.log(`Error: #${channelInfo.name} - Failed to fetch`);
      }
    }

    console.log("=".repeat(70));
    console.log(`\nSummary:`);
    console.log(`   Accessible: ${accessibleChannels.length} channel(s)`);
    console.log(`   Error: Inaccessible: ${inaccessibleChannels.length} channel(s)\n`);

    if (accessibleChannels.length > 0) {
      console.log(`\nChannels you CAN read from:`);
      console.log("=".repeat(70));
      accessibleChannels.forEach((ch, index) => {
        console.log(`[${index + 1}] #${ch.name}`);
        console.log(`    ID: ${ch.id}`);
        console.log(`    Type: ${ch.type}`);
        if (index < accessibleChannels.length - 1) console.log("");
      });
    }

    if (inaccessibleChannels.length > 0) {
      console.log(`\nError: Channels you CANNOT read from:`);
      console.log("=".repeat(70));
      inaccessibleChannels.forEach((ch, index) => {
        console.log(`[${index + 1}] #${ch.name}`);
        console.log(`    ID: ${ch.id}`);
        console.log(`    Reason: ${ch.reason}`);
        if (index < inaccessibleChannels.length - 1) console.log("");
      });
    }

    console.log("\n" + "=".repeat(70));

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


