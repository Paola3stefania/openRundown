/**
 * PostgreSQL database client for UNMute MCP
 * Handles all database operations for classifications and groupings
 */

import pg from "pg";
const { Pool } = pg;

let pool: pg.Pool | null = null;

export interface DatabaseConfig {
  host?: string;
  port?: number;
  database?: string;
  user?: string;
  password?: string;
  connectionString?: string;
}

/**
 * Initialize database connection pool
 */
export function initDatabase(config?: DatabaseConfig): pg.Pool {
  if (pool) {
    return pool;
  }

  const dbConfig: pg.PoolConfig = {
    connectionString: config?.connectionString || process.env.DATABASE_URL,
    host: config?.host || process.env.DB_HOST,
    port: config?.port || parseInt(process.env.DB_PORT || "5432"),
    database: config?.database || process.env.DB_NAME,
    user: config?.user || process.env.DB_USER,
    password: config?.password || process.env.DB_PASSWORD,
    max: 20, // Maximum number of clients in the pool
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 2000,
  };

  pool = new Pool(dbConfig);

  pool.on("error", (err) => {
    console.error("Unexpected error on idle client", err);
  });

  return pool;
}

/**
 * Get database pool (initializes if needed)
 */
export function getPool(): pg.Pool {
  if (!pool) {
    return initDatabase();
  }
  return pool;
}

/**
 * Close database connection
 */
export async function closeDatabase(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = null;
  }
}

/**
 * Run a database query
 */
export async function query<T extends pg.QueryResultRow = any>(
  text: string,
  params?: any[]
): Promise<pg.QueryResult<T>> {
  const db = getPool();
  return db.query<T>(text, params);
}

/**
 * Run a transaction
 */
export async function transaction<T>(
  callback: (client: pg.PoolClient) => Promise<T>
): Promise<T> {
  const db = getPool();
  const client = await db.connect();
  
  try {
    await client.query("BEGIN");
    const result = await callback(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Check if database is connected
 */
export async function checkConnection(): Promise<boolean> {
  try {
    await query("SELECT 1");
    return true;
  } catch {
    return false;
  }
}

