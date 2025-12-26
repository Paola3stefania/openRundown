#!/usr/bin/env node
import "dotenv/config";
import {
  Client,
  GatewayIntentBits,
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
    const guilds = discord.guilds.cache.map((guild) => ({
      id: guild.id,
      name: guild.name,
      memberCount: guild.memberCount,
    }));

    console.log("Discord Servers (Guilds):");
    console.log("=".repeat(70));
    
    if (guilds.length === 0) {
      console.log("No servers found. Make sure the bot is invited to at least one server.");
    } else {
      guilds.forEach((guild, index) => {
        console.log(`\n[${index + 1}] ${guild.name}`);
        console.log(`    ID: ${guild.id}`);
        console.log(`    Members: ${guild.memberCount}`);
      });
    }
    
    console.log("\n" + "=".repeat(70));
    console.log(`\nFound ${guilds.length} server(s)\n`);

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




