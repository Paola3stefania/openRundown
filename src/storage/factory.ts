/**
 * Storage factory - creates the appropriate storage backend
 * 
 * Default behavior: Auto-detect
 * - If DATABASE_URL is set → use PostgreSQL
 * - Otherwise → use JSON files
 * 
 * Override: Set STORAGE_BACKEND=json for testing
 */

import type { IStorage } from "./interface.js";
import type { StorageBackend } from "../config/storage.js";
import { getConfig } from "../config/index.js";
import { JsonStorage } from "./json/index.js";
import { DatabaseStorage } from "./db/index.js";

/**
 * Check if database is configured
 */
function hasDatabaseConfig(): boolean {
  return !!(
    process.env.DATABASE_URL ||
    (process.env.DB_HOST && process.env.DB_NAME)
  );
}

/**
 * Create storage instance based on configuration
 * 
 * - "json": Always use JSON files (useful for testing)
 * - "database": Always use PostgreSQL (will fail if not configured)
 * - "auto": Use database if DATABASE_URL is set, otherwise JSON (default)
 * 
 * Default behavior: Auto-detect - use PostgreSQL if configured, otherwise JSON
 */
export function createStorage(backend?: StorageBackend): IStorage {
  // Use config if backend not specified
  const config = getConfig();
  const storageBackend = backend || config.storage.backend;
  
  if (storageBackend === "json") {
    console.error("[Storage] Using JSON file backend (override)");
    return new JsonStorage();
  }
  
  if (storageBackend === "database") {
    if (!hasDatabaseConfig()) {
      throw new Error("STORAGE_BACKEND=database but no DATABASE_URL or DB_* variables set");
    }
    console.error("[Storage] Using PostgreSQL backend");
    return new DatabaseStorage();
  }
  
  // Auto: Check for database, fallback to JSON
  if (hasDatabaseConfig()) {
    console.error("[Storage] Using PostgreSQL backend (auto-detected)");
    return new DatabaseStorage();
  }
  
  console.error("[Storage] Using JSON file backend (no database configured)");
  return new JsonStorage();
}

/**
 * Get storage instance from config (convenience function)
 */
export function getStorage(): IStorage {
  return createStorage();
}

