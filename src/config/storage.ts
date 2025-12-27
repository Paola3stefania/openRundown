/**
 * Storage configuration
 */

export type StorageBackend = "json" | "database" | "auto";

export interface StorageConfig {
  backend: StorageBackend;
  defaultLimit?: {
    issues?: number;
    messages?: number;
  };
}

/**
 * Get storage configuration from environment variables
 * 
 * STORAGE_BACKEND: "json" | "database" | "auto" (default: "auto")
 * - "json": Always use JSON files (useful for testing)
 * - "database": Always use PostgreSQL (will fail if not configured)
 * - "auto": Use database if DATABASE_URL is set, otherwise JSON (default)
 * 
 * Default behavior: Auto-detect - use PostgreSQL if configured, otherwise JSON
 * For testing, set: STORAGE_BACKEND=json
 */
export function getStorageConfig(): StorageConfig {
  const backend = (process.env.STORAGE_BACKEND as StorageBackend) || "auto";
  
  // Validate
  if (backend !== "json" && backend !== "database" && backend !== "auto") {
    console.warn(`[Config] Invalid STORAGE_BACKEND="${backend}", using "auto"`);
    return { backend: "auto" };
  }
  
  // Parse default limits from environment (for try-it-out mode when DB is not configured)
  const defaultLimit: StorageConfig["defaultLimit"] = {};
  if (process.env.DEFAULT_FETCH_LIMIT_ISSUES) {
    const issuesLimit = parseInt(process.env.DEFAULT_FETCH_LIMIT_ISSUES, 10);
    if (!isNaN(issuesLimit) && issuesLimit > 0) {
      defaultLimit.issues = issuesLimit;
    }
  }
  if (process.env.DEFAULT_FETCH_LIMIT_MESSAGES) {
    const messagesLimit = parseInt(process.env.DEFAULT_FETCH_LIMIT_MESSAGES, 10);
    if (!isNaN(messagesLimit) && messagesLimit > 0) {
      defaultLimit.messages = messagesLimit;
    }
  }
  
  // Set defaults if not specified (100 for each)
  if (Object.keys(defaultLimit).length === 0) {
    defaultLimit.issues = 100;
    defaultLimit.messages = 100;
  } else {
    // Fill in missing defaults
    if (!defaultLimit.issues) defaultLimit.issues = 100;
    if (!defaultLimit.messages) defaultLimit.messages = 100;
  }
  
  return { backend, defaultLimit };
}

