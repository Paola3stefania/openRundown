/**
 * Import JSON cache files into PostgreSQL database
 * Imports:
 * - GitHub issues cache
 * - Issue embeddings cache
 * - Discord messages cache
 */

import { readFile } from "fs/promises";
import { join } from "path";
import { query, initDatabase, checkConnection, transaction } from "../src/storage/db/client.js";
import type { DiscordCache } from "../src/storage/cache/discordCache.js";

interface GitHubIssue {
  number: number;
  title: string;
  state: string;
  url: string;
  html_url: string;
  body: string | null;
  labels: Array<{ name: string; color: string }>;
  user: { login: string; id: number };
  created_at: string;
  updated_at: string;
  closed_at: string | null;
  [key: string]: unknown;
}

interface IssuesCache {
  fetched_at: string;
  total_count: number;
  open_count: number;
  closed_count: number;
  issues: GitHubIssue[];
}

interface EmbeddingCache {
  version: number;
  model: string;
  entries: Record<string, {
    embedding: number[];
    content_hash?: string;
  }>;
}

async function importData() {
  console.log("Importing JSON cache files into PostgreSQL database...\n");

  // Check if database is configured
  const hasDatabase = !!(
    process.env.DATABASE_URL ||
    (process.env.DB_HOST && process.env.DB_NAME)
  );

  if (!hasDatabase) {
    console.error("ERROR: No database configuration found!");
    console.error("\nPlease set DATABASE_URL in your environment.");
    process.exit(1);
  }

  // Test connection
  console.log("Testing database connection...");
  try {
    initDatabase();
    const isConnected = await checkConnection();
    if (!isConnected) {
      throw new Error("Could not connect to database");
    }
    console.log("Database connection successful!\n");
  } catch (error: unknown) {
    console.error("ERROR: Failed to connect to database:", error instanceof Error ? error.message : String(error));
    process.exit(1);
  }

  const cacheDir = join(process.cwd(), "cache");

  // Step 1: Create tables if they don't exist
  console.log("Creating tables if needed...");
  try {
    // GitHub issues table
    await query(`
      CREATE TABLE IF NOT EXISTS github_issues_cache (
        number INTEGER PRIMARY KEY,
        title TEXT NOT NULL,
        state TEXT NOT NULL,
        url TEXT NOT NULL,
        html_url TEXT NOT NULL,
        body TEXT,
        labels JSONB,
        author TEXT,
        author_id INTEGER,
        created_at TIMESTAMP,
        updated_at TIMESTAMP,
        closed_at TIMESTAMP,
        full_data JSONB NOT NULL,
        cached_at TIMESTAMP DEFAULT NOW()
      );
      
      CREATE INDEX IF NOT EXISTS idx_github_issues_state ON github_issues_cache(state);
      CREATE INDEX IF NOT EXISTS idx_github_issues_created_at ON github_issues_cache(created_at DESC);
    `);

    // Discord messages table (raw messages)
    await query(`
      CREATE TABLE IF NOT EXISTS discord_messages_cache (
        message_id TEXT PRIMARY KEY,
        channel_id TEXT NOT NULL,
        channel_name TEXT,
        thread_id TEXT,
        thread_name TEXT,
        author_id TEXT NOT NULL,
        author_username TEXT,
        content TEXT NOT NULL,
        created_at TIMESTAMP NOT NULL,
        edited_at TIMESTAMP,
        url TEXT,
        guild_id TEXT,
        guild_name TEXT,
        attachments JSONB,
        mentions TEXT[],
        reactions JSONB,
        full_data JSONB NOT NULL,
        cached_at TIMESTAMP DEFAULT NOW()
      );
      
      CREATE INDEX IF NOT EXISTS idx_discord_messages_channel ON discord_messages_cache(channel_id);
      CREATE INDEX IF NOT EXISTS idx_discord_messages_thread ON discord_messages_cache(thread_id);
      CREATE INDEX IF NOT EXISTS idx_discord_messages_created ON discord_messages_cache(created_at DESC);
    `);

    console.log("   ✓ Tables created/verified\n");
  } catch (error: unknown) {
    console.error(`ERROR: Failed to create tables: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }

  // Step 2: Import GitHub issues
  const issuesCachePath = join(cacheDir, "github-issues-cache.json");
  try {
    console.log("Importing GitHub issues...");
    const issuesContent = await readFile(issuesCachePath, "utf-8");
    const issuesCache: IssuesCache = JSON.parse(issuesContent);

    let imported = 0;
    let skipped = 0;

    await transaction(async (client) => {
      for (const issue of issuesCache.issues) {
        try {
          await client.query(
            `INSERT INTO github_issues_cache (
              number, title, state, url, html_url, body, labels,
              author, author_id, created_at, updated_at, closed_at, full_data, cached_at
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
            ON CONFLICT (number) DO UPDATE SET
              title = EXCLUDED.title,
              state = EXCLUDED.state,
              body = EXCLUDED.body,
              labels = EXCLUDED.labels,
              updated_at = EXCLUDED.updated_at,
              closed_at = EXCLUDED.closed_at,
              full_data = EXCLUDED.full_data`,
            [
              issue.number,
              issue.title,
              issue.state,
              issue.url,
              issue.html_url,
              issue.body || null,
              JSON.stringify(issue.labels || []),
              issue.user?.login || null,
              issue.user?.id || null,
              issue.created_at ? new Date(issue.created_at) : null,
              issue.updated_at ? new Date(issue.updated_at) : null,
              issue.closed_at ? new Date(issue.closed_at) : null,
              JSON.stringify(issue),
              new Date(issuesCache.fetched_at),
            ]
          );
          imported++;
        } catch (error: unknown) {
          if (error && typeof error === "object" && "code" in error && error.code === "23505") {
            // Unique constraint violation - already exists
            skipped++;
          } else {
            console.error(`   Warning: Failed to import issue #${issue.number}: ${error instanceof Error ? error.message : String(error)}`);
          }
        }
      }
    });

    console.log(`   ✓ Imported ${imported} issues, skipped ${skipped} (already exist)`);
    console.log(`   Total in cache: ${issuesCache.issues.length}\n`);
  } catch (error: unknown) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      console.log("   ⚠ GitHub issues cache file not found, skipping...\n");
    } else {
      console.error(`   ERROR: Failed to import GitHub issues: ${error instanceof Error ? error.message : String(error)}\n`);
    }
  }

  // Step 3: Import issue embeddings
  const embeddingsCachePath = join(cacheDir, "issue-embeddings-cache.json");
  try {
    console.log("Importing issue embeddings...");
    const embeddingsContent = await readFile(embeddingsCachePath, "utf-8");
    const embeddingsCache: EmbeddingCache = JSON.parse(embeddingsContent);

    let imported = 0;
    let skipped = 0;

    await transaction(async (client) => {
      for (const [issueNumberStr, entry] of Object.entries(embeddingsCache.entries)) {
        const issueNumber = parseInt(issueNumberStr, 10);
        if (isNaN(issueNumber)) continue;

        try {
          await client.query(
            `INSERT INTO issue_embeddings (
              issue_number, embedding, content_hash, model, updated_at
            ) VALUES ($1, $2, $3, $4, NOW())
            ON CONFLICT (issue_number) DO UPDATE SET
              embedding = EXCLUDED.embedding,
              content_hash = EXCLUDED.content_hash,
              model = EXCLUDED.model,
              updated_at = NOW()`,
            [
              issueNumber,
              JSON.stringify(entry.embedding),
              entry.content_hash || "",
              embeddingsCache.model || "text-embedding-3-small",
            ]
          );
          imported++;
        } catch (error: unknown) {
          if (error && typeof error === "object" && "code" in error && error.code === "23505") {
            skipped++;
          } else {
            console.error(`   Warning: Failed to import embedding for issue #${issueNumber}: ${error instanceof Error ? error.message : String(error)}`);
          }
        }
      }
    });

    console.log(`   ✓ Imported ${imported} embeddings, skipped ${skipped} (already exist)`);
    console.log(`   Total in cache: ${Object.keys(embeddingsCache.entries).length}\n`);
  } catch (error: unknown) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      console.log("   ⚠ Issue embeddings cache file not found, skipping...\n");
    } else {
      console.error(`   ERROR: Failed to import issue embeddings: ${error instanceof Error ? error.message : String(error)}\n`);
    }
  }

  // Step 4: Import Discord messages
  const discordCacheFiles = [
    "discord-messages-1296058482289676320.json", // Default channel
  ];

  // Try to find any discord-messages-*.json files
  try {
    const { readdir } = await import("fs/promises");
    const files = await readdir(cacheDir);
    const discordFiles = files.filter(f => f.startsWith("discord-messages-") && f.endsWith(".json"));
    if (discordFiles.length > 0) {
      discordCacheFiles.length = 0;
      discordCacheFiles.push(...discordFiles);
    }
  } catch {
    // Ignore if can't read directory
  }

  for (const discordFile of discordCacheFiles) {
    const discordCachePath = join(cacheDir, discordFile);
    try {
      console.log(`Importing Discord messages from ${discordFile}...`);
      const discordContent = await readFile(discordCachePath, "utf-8");
      const discordCache: DiscordCache = JSON.parse(discordContent);

      let imported = 0;
      let skipped = 0;

      await transaction(async (client) => {
        // Import messages from threads
        for (const [threadId, thread] of Object.entries(discordCache.threads || {})) {
          for (const message of thread.messages || []) {
            try {
              await client.query(
                `INSERT INTO discord_messages_cache (
                  message_id, channel_id, channel_name, thread_id, thread_name,
                  author_id, author_username, content, created_at, edited_at,
                  url, guild_id, guild_name, attachments, mentions, reactions, full_data, cached_at
                ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18)
                ON CONFLICT (message_id) DO UPDATE SET
                  content = EXCLUDED.content,
                  edited_at = EXCLUDED.edited_at,
                  full_data = EXCLUDED.full_data`,
                [
                  message.id,
                  message.channel_id,
                  message.channel_name || discordCache.channel_name || null,
                  threadId,
                  thread.thread_name || null,
                  message.author.id,
                  message.author.username,
                  message.content,
                  message.created_at ? new Date(message.created_at) : new Date(message.timestamp),
                  message.edited_at ? new Date(message.edited_at) : null,
                  message.url || null,
                  message.guild_id || null,
                  message.guild_name || null,
                  JSON.stringify(message.attachments || []),
                  message.mentions || [],
                  JSON.stringify(message.reactions || []),
                  JSON.stringify(message),
                  new Date(discordCache.fetched_at),
                ]
              );
              imported++;
            } catch (error: unknown) {
              if (error && typeof error === "object" && "code" in error && error.code === "23505") {
                skipped++;
              } else {
                console.error(`   Warning: Failed to import message ${message.id}: ${error instanceof Error ? error.message : String(error)}`);
              }
            }
          }
        }

        // Import main messages (not in threads)
        for (const message of discordCache.main_messages || []) {
          try {
            await client.query(
              `INSERT INTO discord_messages_cache (
                message_id, channel_id, channel_name, thread_id, thread_name,
                author_id, author_username, content, created_at, edited_at,
                url, guild_id, guild_name, attachments, mentions, reactions, full_data, cached_at
              ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18)
              ON CONFLICT (message_id) DO UPDATE SET
                content = EXCLUDED.content,
                edited_at = EXCLUDED.edited_at,
                full_data = EXCLUDED.full_data`,
              [
                message.id,
                message.channel_id,
                message.channel_name || discordCache.channel_name || null,
                null, // main message, not in thread
                null,
                message.author.id,
                message.author.username,
                message.content,
                message.created_at ? new Date(message.created_at) : new Date(message.timestamp),
                message.edited_at ? new Date(message.edited_at) : null,
                message.url || null,
                message.guild_id || null,
                message.guild_name || null,
                JSON.stringify(message.attachments || []),
                message.mentions || [],
                JSON.stringify(message.reactions || []),
                JSON.stringify(message),
                new Date(discordCache.fetched_at),
              ]
            );
            imported++;
          } catch (error: unknown) {
            if (error && typeof error === "object" && "code" in error && error.code === "23505") {
              skipped++;
            } else {
              console.error(`   Warning: Failed to import message ${message.id}: ${error.message}`);
            }
          }
        }
      });

      console.log(`   ✓ Imported ${imported} messages, skipped ${skipped} (already exist)`);
      console.log(`   Total in cache: ${discordCache.total_count || 0}\n`);
    } catch (error: unknown) {
      if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
        console.log(`   ⚠ Discord cache file ${discordFile} not found, skipping...\n`);
      } else {
        console.error(`   ERROR: Failed to import Discord messages: ${error instanceof Error ? error.message : String(error)}\n`);
      }
    }
  }

  // Summary
  console.log("Import complete!\n");
  console.log("Summary:");
  
  try {
    const issuesCount = await query("SELECT COUNT(*) as count FROM github_issues_cache");
    console.log(`   GitHub issues in DB: ${issuesCount.rows[0].count}`);
  } catch {
    console.log("   GitHub issues in DB: (table not found)");
  }

  try {
    const embeddingsCount = await query("SELECT COUNT(*) as count FROM issue_embeddings");
    console.log(`   Issue embeddings in DB: ${embeddingsCount.rows[0].count}`);
  } catch {
    console.log("   Issue embeddings in DB: (table not found)");
  }

  try {
    const messagesCount = await query("SELECT COUNT(*) as count FROM discord_messages_cache");
    console.log(`   Discord messages in DB: ${messagesCount.rows[0].count}`);
  } catch {
    console.log("   Discord messages in DB: (table not found)");
  }

  console.log("\nAll data has been imported into PostgreSQL!");
}

importData().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});

