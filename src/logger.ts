/**
 * Logging utility for MCP server
 * Uses console.log for cleaner output
 */

export function log(...args: any[]): void {
  console.log(...args);
} 

export function logError(...args: any[]): void {
  console.error(...args);
}

export function logWarn(...args: any[]): void {
  console.warn(...args);
}

