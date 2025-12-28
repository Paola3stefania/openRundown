/**
 * Database migration script
 * Runs SQL migrations to set up the database schema
 */

import { readFile, readdir } from "fs/promises";
import { join } from "path";
import { query, initDatabase, checkConnection } from "../src/storage/db/client.js";
import dotenv from "dotenv";
dotenv.config();


async function runMigrations() {
  console.log("Setting up PostgreSQL database for UNMute MCP...\n");

  // Check if database is configured
  const hasDatabase = !!(
    process.env.DATABASE_URL ||
    (process.env.DB_HOST && process.env.DB_NAME)
  );

  if (!hasDatabase) {
    console.error("ERROR: No database configuration found!");
    console.error("\nPlease set one of the following:");
    console.error("  - DATABASE_URL=postgresql://user:password@localhost:5432/unmute_mcp");
    console.error("  - Or set DB_HOST, DB_PORT, DB_NAME, DB_USER, DB_PASSWORD");
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
    console.error("\nPlease check your DATABASE_URL or DB_* environment variables.");
    
    // Show what's configured
    console.error("\nCurrent configuration:");
    if (process.env.DATABASE_URL) {
      const url = process.env.DATABASE_URL;
      // Mask password in URL
      const maskedUrl = url.replace(/:([^:@]+)@/, ":****@");
      console.error(`   DATABASE_URL: ${maskedUrl}`);
    } else {
      console.error("   DATABASE_URL: (not set)");
    }
    console.error(`   DB_HOST: ${process.env.DB_HOST || "(not set)"}`);
    console.error(`   DB_PORT: ${process.env.DB_PORT || "(not set)"}`);
    console.error(`   DB_NAME: ${process.env.DB_NAME || "(not set)"}`);
    console.error(`   DB_USER: ${process.env.DB_USER || "(not set)"}`);
    console.error(`   DB_PASSWORD: ${process.env.DB_PASSWORD ? "****" : "(not set)"}`);
    
    console.error("\nTip: Make sure PostgreSQL is running and the database exists.");
    console.error("   You can test the connection with: psql $DATABASE_URL");
    process.exit(1);
  }

  // Find and run all migration files in order
  const migrationsDir = join(process.cwd(), "db", "migrations");
  console.log(`Reading migration files from: ${migrationsDir}\n`);
  
  let migrationFiles: string[];
  try {
    const files = await readdir(migrationsDir);
    migrationFiles = files
      .filter(f => f.endsWith(".sql"))
      .sort(); // Sort alphabetically (001, 002, etc.)
  } catch (error: unknown) {
    console.error(`ERROR: Failed to read migrations directory: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }

  if (migrationFiles.length === 0) {
    console.error("ERROR: No migration files found!");
    process.exit(1);
  }

  console.log(`Found ${migrationFiles.length} migration file(s):`);
  migrationFiles.forEach(f => console.log(`   - ${f}`));
  console.log("");

  // Execute each migration file
  for (const migrationFile of migrationFiles) {
    const migrationPath = join(migrationsDir, migrationFile);
    console.log(`Executing: ${migrationFile}...`);
    
    try {
      const migrationSQL = await readFile(migrationPath, "utf-8");
      await query(migrationSQL);
      console.log(`   OK: ${migrationFile} completed\n`);
    } catch (error: unknown) {
      // Some errors are expected (e.g., table already exists)
      if ((error instanceof Error && error.message.includes("already exists")) || (error && typeof error === "object" && "code" in error && (error.code === "42P07" || error.code === "42710"))) {
        console.log(`   WARNING: ${migrationFile}: Some objects already exist (skipping)`);
      } else {
        console.error(`   ERROR: ${migrationFile} failed: ${error instanceof Error ? error.message : String(error)}`);
        console.error(`\nFull error:`, error);
        process.exit(1);
      }
    }
  }
  
  // Verify tables were created
  try {
    const tablesResult = await query(`
      SELECT table_name 
      FROM information_schema.tables 
      WHERE table_schema = 'public' 
      ORDER BY table_name
    `);
    
    const tables = (tablesResult.rows as Array<{ table_name: string }>).map((r) => r.table_name);
    console.log(`Database tables (${tables.length} total):`);
    tables.forEach((table: string) => {
      console.log(`   - ${table}`);
    });
  } catch (error: unknown) {
    console.error(`WARNING: Could not verify tables: ${error instanceof Error ? error.message : String(error)}`);
  }
  
  console.log(`\nDatabase setup complete!`);
  console.log(`\nYou can now use PostgreSQL storage by setting DATABASE_URL in your .env file.`);
}

runMigrations().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});

