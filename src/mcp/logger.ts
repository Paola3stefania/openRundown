/**
 * Logging utility for MCP server
 * Uses console.error for all output to avoid interfering with MCP JSON protocol on stdout
 * Optionally writes to log file if MCP_LOG_FILE env var is set
 */

import { appendFile, mkdir } from "fs/promises";
import { join, dirname } from "path";
import { existsSync } from "fs";

const LOG_FILE = process.env.MCP_LOG_FILE;
const LOG_TO_FILE = !!LOG_FILE;

// Initialize log file if enabled
if (LOG_TO_FILE && LOG_FILE) {
  const logDir = dirname(LOG_FILE);
  if (!existsSync(logDir)) {
    mkdir(logDir, { recursive: true }).catch(() => {
      // Ignore errors, will fall back to console only
    });
  }
}

async function writeToLogFile(level: string, ...args: any[]): Promise<void> {
  if (!LOG_TO_FILE || !LOG_FILE) return;
  
  try {
    const timestamp = new Date().toISOString();
    const message = args.map(arg => 
      typeof arg === 'object' ? JSON.stringify(arg, null, 2) : String(arg)
    ).join(' ');
    const logLine = `[${timestamp}] [${level}] ${message}\n`;
    await appendFile(LOG_FILE, logLine, 'utf-8');
  } catch (error) {
    // Fall back to console if file write fails
    console.error('[Logger] Failed to write to log file:', error);
  }
}

export function log(...args: any[]): void {
  // Use console.error to avoid interfering with MCP JSON protocol on stdout
  console.error(...args);
  writeToLogFile('INFO', ...args).catch(() => {});
} 

export function logError(...args: any[]): void {
  console.error(...args);
  writeToLogFile('ERROR', ...args).catch(() => {});
}

export function logWarn(...args: any[]): void {
  console.warn(...args);
  writeToLogFile('WARN', ...args).catch(() => {});
}

