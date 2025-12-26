/**
 * Storage configuration
 */

export type StorageBackend = "json" | "database" | "auto";

export interface StorageConfig {
  backend: StorageBackend;
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
  
  return { backend };
}

