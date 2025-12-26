#!/usr/bin/env node
/**
 * Fetch Discord messages from a channel and save them to a JSON cache file
 * Supports incremental updates - only fetches messages since last fetch
 * Fetches ALL messages with pagination (no limit) unless --limit is specified
 * Run with: npm run fetch-discord [channel_id] [--limit N] [--incremental]
 */
import "dotenv/config";
import { writeFile, mkdir, access } from "fs/promises";
import { join } from "path";
import {
  Client,
  GatewayIntentBits,
  TextChannel,
  DMChannel,
  NewsChannel,
  Message,
} from "discord.js";
import { getConfig } from "../src/config.js";
import {
  loadDiscordCache,
  getMostRecentMessageDate,
  mergeMessagesByThread,
  organizeMessagesByThread,
  getAllMessagesFromCache,
  type DiscordMessage,
  type DiscordCache,
} from "../src/discord-cache.js";

const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
if (!DISCORD_TOKEN) {
  console.error("Error: DISCORD_TOKEN environment variable is required");
  process.exit(1);
}

const config = getConfig();

// Parse arguments
const args = process.argv.slice(2);
const forceIncremental = args.includes("--incremental") || args.includes("-i");
const forceFull = args.includes("--full") || args.includes("-f");
const limitIndex = args.indexOf("--limit");
const limit = limitIndex !== -1 && args[limitIndex + 1] ? parseInt(args[limitIndex + 1]) : undefined;
const nonFlagArgs = args.filter(arg => !arg.startsWith("--") && !arg.startsWith("-"));
const channelId = nonFlagArgs[0] || config.discord.defaultChannelId;

if (!channelId) {
  console.error("Error: Channel ID is required. Set DISCORD_DEFAULT_CHANNEL_ID in .env or pass as argument.");
  console.error("Usage: npm run fetch-discord [channel_id] [limit] [--incremental]");
  process.exit(1);
}

// Determine cache file path
const cacheDir = join(process.cwd(), "discord");
const cacheFileName = `discord-messages-${channelId}.json`;
const cacheFilePath = join(cacheDir, cacheFileName);

const discord = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.DirectMessages,
  ],
});

function formatDiscordMessage(msg: Message, channel: TextChannel | NewsChannel | DMChannel): DiscordMessage {
  const channelName = channel instanceof TextChannel || channel instanceof NewsChannel
    ? channel.name
    : "DM";
  
  const guildId = channel instanceof TextChannel || channel instanceof NewsChannel
    ? channel.guild?.id
    : undefined;
  
  const guildName = channel instanceof TextChannel || channel instanceof NewsChannel
    ? channel.guild?.name
    : undefined;

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
    channel_id: channel.id,
    channel_name: channelName,
    guild_id: guildId,
    guild_name: guildName,
    attachments: msg.attachments.map(att => ({
      id: att.id,
      filename: att.name,
      url: att.url,
      size: att.size,
      content_type: att.contentType || undefined,
    })),
    embeds: msg.embeds.length,
    mentions: Array.from(msg.mentions.users.keys()),
    reactions: msg.reactions.cache.map(reaction => ({
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
}

discord.once("ready", async () => {
  console.log(`Logged in as ${discord.user?.tag}\n`);

  try {
    // Always check if cache exists first
    let existingCache: DiscordCache | null = null;
    let sinceDate: string | undefined = undefined;
    let actuallyIncremental = false;

    try {
      await access(cacheFilePath);
      existingCache = await loadDiscordCache(cacheFilePath);
      
      // If cache exists and not forcing full fetch, use incremental mode by default
      if (existingCache && !forceFull) {
        actuallyIncremental = true;
        sinceDate = getMostRecentMessageDate(existingCache);
        
        if (sinceDate) {
          console.log(`Cache found: ${existingCache.total_count} messages. Incremental update: Fetching messages since ${sinceDate}\n`);
          const threadCount = existingCache.threads ? Object.keys(existingCache.threads).length : 0;
          console.log(`Existing cache: ${existingCache.total_count} messages (${threadCount} threads, ${existingCache.main_messages?.length || 0} main)\n`);
        } else {
          console.log("Cache exists but is empty, fetching all messages...\n");
          actuallyIncremental = false;
        }
      } else if (existingCache && forceFull) {
        console.log(`Cache exists (${existingCache.total_count} messages) but --full flag set, fetching all messages...\n`);
        actuallyIncremental = false;
      }
    } catch (error) {
      console.log("No existing cache found, fetching all messages...\n");
      actuallyIncremental = false;
    }

    // Override with explicit --incremental flag if set
    if (forceIncremental) {
      actuallyIncremental = true;
      if (existingCache && !sinceDate) {
        sinceDate = getMostRecentMessageDate(existingCache);
      }
    }

    if (!actuallyIncremental) {
      if (limit) {
        console.log(`Fetching last ${limit} messages from Discord channel ${channelId}...\n`);
      } else {
        console.log(`Fetching ALL messages from Discord channel ${channelId} (with pagination)...\n`);
      }
    }

    // Fetch channel
    const channel = await discord.channels.fetch(channelId);
    
    if (!channel || 
        (!(channel instanceof TextChannel) && 
         !(channel instanceof DMChannel) && 
         !(channel instanceof NewsChannel))) {
      console.error("Error: Channel does not support messages");
      process.exit(1);
    }

    const channelName = channel instanceof TextChannel || channel instanceof NewsChannel
      ? `#${channel.name}`
      : "DM";

    console.log(`Fetching messages from ${channelName}...\n`);

    // Fetch messages with pagination
    let fetchedMessages: Message[] = [];
    let lastMessageId: string | undefined = undefined;
    let hasMore = true;
    const maxMessages = limit; // undefined = no limit (fetch all)

    console.log("Fetching messages...");
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
      if (actuallyIncremental && sinceDate) {
        const sinceTime = new Date(sinceDate).getTime();
        const newMessages = messageArray.filter(msg => {
          const createdTime = msg.createdAt.getTime();
          const editedTime = msg.editedAt ? msg.editedAt.getTime() : 0;
          // Include if created or edited after sinceDate
          return createdTime >= sinceTime || editedTime >= sinceTime;
        });

        if (newMessages.length === 0) {
          // Check if we've gone past the sinceDate (messages are sorted newest first)
          // If the newest message in this batch is older than sinceDate, we're done
          const newestInBatch = messageArray[0];
          const newestTime = Math.max(
            newestInBatch.createdAt.getTime(),
            newestInBatch.editedAt ? newestInBatch.editedAt.getTime() : 0
          );
          if (newestTime < sinceTime) {
            // No more messages after sinceDate
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

      // Log progress every 1000 messages or at the end
      if (fetchedMessages.length % 1000 === 0 || !hasMore || (maxMessages && fetchedMessages.length >= maxMessages)) {
        console.log(`   Fetched ${fetchedMessages.length} messages...`);
      }
    }

    console.log(`\nTotal messages fetched: ${fetchedMessages.length}\n`);

    // Format messages
    const formattedMessages = fetchedMessages.map(msg => formatDiscordMessage(msg, channel));

    // Merge with existing cache if doing incremental update, or organize by thread
    let cacheData: DiscordCache;
    if (existingCache && formattedMessages.length > 0) {
      console.log(`Merging ${formattedMessages.length} new/updated messages with existing cache...`);
      cacheData = mergeMessagesByThread(existingCache, formattedMessages);
      const threadCount = Object.keys(cacheData.threads).length;
      console.log(`Total after merge: ${cacheData.total_count} messages (${threadCount} threads, ${cacheData.main_messages.length} main)\n`);
    } else if (existingCache && formattedMessages.length === 0) {
      console.log("\nNo new or updated messages found. Using existing cache.\n");
      cacheData = existingCache;
    } else {
      // Organize messages by thread
      const { threads, mainMessages } = organizeMessagesByThread(formattedMessages);
      const totalCount = formattedMessages.length;
      const dates = formattedMessages.map(m => new Date(m.created_at).getTime());
      const oldestDate = dates.length > 0 ? new Date(Math.min(...dates)).toISOString() : null;
      const newestDate = dates.length > 0 ? new Date(Math.max(...dates)).toISOString() : null;

      cacheData = {
        fetched_at: new Date().toISOString(),
        channel_id: channel.id,
        channel_name: channelName,
        total_count: totalCount,
        oldest_message_date: oldestDate,
        newest_message_date: newestDate,
        threads,
        main_messages: mainMessages,
      };
      
      const threadCount = Object.keys(threads).length;
      console.log(`Organized ${totalCount} messages into ${threadCount} threads and ${mainMessages.length} main messages\n`);
    }

    // Ensure cache directory exists
    try {
      await mkdir(cacheDir, { recursive: true });
    } catch (error) {
      // Directory might already exist, that's fine
    }

    await writeFile(cacheFilePath, JSON.stringify(cacheData, null, 2), "utf-8");

    console.log("Successfully saved messages to:", cacheFilePath);
    console.log(`   Total: ${cacheData.total_count}`);
    console.log(`   Threads: ${Object.keys(cacheData.threads).length}`);
    console.log(`   Main messages: ${cacheData.main_messages.length}`);
    console.log(`   Oldest: ${cacheData.oldest_message_date || "N/A"}`);
    console.log(`   Newest: ${cacheData.newest_message_date || "N/A"}`);
    if (actuallyIncremental && formattedMessages.length > 0) {
      console.log(`   New/Updated: ${formattedMessages.length}\n`);
    } else {
      console.log("");
    }

  } catch (error) {
    console.error("Error:", error instanceof Error ? error.message : error);
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

