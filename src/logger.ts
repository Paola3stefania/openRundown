/**
 * Logging utility for MCP server
 * Uses console.log for cleaner output (note: this may interfere with MCP protocol if stdout is used for JSON)
 */

export function log(...args: any[]): void {
  console.log("[LOG]", ...args);
}

export function logError(...args: any[]): void {
  console.log("[ERR]", ...args);
}

export function logWarn(...args: any[]): void {
  console.log("[WARN]", ...args);
}

