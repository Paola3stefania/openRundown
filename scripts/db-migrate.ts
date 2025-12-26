/**
 * Database migration script
 * Runs SQL migrations to set up the database schema
 */

import { readFile } from "fs/promises";
import { join } from "path";
import { query, initDatabase, checkConnection } from "../src/storage/db/client.js";

async function runMigrations() {
  console.log("🔧 Setting up PostgreSQL database for UNMute MCP...\n");

  // Check if database is configured
  const hasDatabase = !!(
    process.env.DATABASE_URL ||
    (process.env.DB_HOST && process.env.DB_NAME)
  );

  if (!hasDatabase) {
    console.error("❌ No database configuration found!");
    console.error("\nPlease set one of the following:");
    console.error("  - DATABASE_URL=postgresql://user:password@localhost:5432/unmute_mcp");
    console.error("  - Or set DB_HOST, DB_PORT, DB_NAME, DB_USER, DB_PASSWORD");
    process.exit(1);
  }

  // Test connection
  console.log("📡 Testing database connection...");
  try {
    initDatabase();
    const isConnected = await checkConnection();
    if (!isConnected) {
      throw new Error("Could not connect to database");
    }
    console.log("✅ Database connection successful!\n");
  } catch (error: any) {
    console.error("❌ Failed to connect to database:", error.message);
    console.error("\nPlease check your DATABASE_URL or DB_* environment variables.");
    process.exit(1);
  }

  // Read migration file
  const migrationPath = join(process.cwd(), "db", "migrations", "001_initial_schema.sql");
  console.log(`📄 Reading migration file: ${migrationPath}`);
  
  let migrationSQL: string;
  try {
    migrationSQL = await readFile(migrationPath, "utf-8");
  } catch (error: any) {
    console.error(`❌ Failed to read migration file: ${error.message}`);
    process.exit(1);
  }

  // Execute the entire SQL file at once
  // PostgreSQL can handle multiple statements separated by semicolons
  // This is safer than splitting, especially for functions and triggers
  console.log(`📝 Executing SQL migration file...\n`);

  try {
    await query(migrationSQL);
    console.log(`✅ Migration executed successfully!\n`);
    
    // Verify tables were created
    const tablesResult = await query(`
      SELECT table_name 
      FROM information_schema.tables 
      WHERE table_schema = 'public' 
      ORDER BY table_name
    `);
    
    const tables = tablesResult.rows.map((r: any) => r.table_name);
    console.log(`📊 Created ${tables.length} tables:`);
    tables.forEach((table: string) => {
      console.log(`   ✅ ${table}`);
    });
    
    console.log(`\n✨ Database setup complete!`);
    console.log(`\nYou can now use PostgreSQL storage by setting DATABASE_URL in your .env file.`);
  } catch (error: any) {
    // Some errors are expected (e.g., table already exists)
    if (error.message.includes("already exists") || error.code === "42P07" || error.code === "42710") {
      console.log(`⚠️  Some objects already exist (this is normal if you've run migrations before)`);
      console.log(`✅ Migration completed (idempotent)`);
    } else {
      console.error(`❌ Migration error: ${error.message}`);
      console.error(`\nFull error:`, error);
      process.exit(1);
    }
  }
}

runMigrations().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});

