/**
 * Simple authentication middleware for API routes
 * Uses environment variable secrets - no database required
 */
import type { VercelRequest, VercelResponse } from "@vercel/node";

export interface AuthResult {
  valid: boolean;
  error?: string;
}

/**
 * Get header value from request
 */
function getHeader(req: VercelRequest, name: string): string | null {
  const value = req.headers[name.toLowerCase()];
  if (Array.isArray(value)) return value[0];
  return value || null;
}

/**
 * Verify API key from request headers
 * Checks against OPENRUNDOWN_API_KEY environment variable
 */
export function verifyApiKey(req: VercelRequest): AuthResult {
  const apiKey = process.env.OPENRUNDOWN_API_KEY || process.env.UNMUTE_API_KEY;
  
  if (!apiKey) {
    console.error("[Auth] OPENRUNDOWN_API_KEY not configured");
    return {
      valid: false,
      error: "API key not configured on server",
    };
  }
  
  // Get key from headers (x-api-key or Authorization: Bearer)
  const xApiKey = getHeader(req, "x-api-key");
  const authHeader = getHeader(req, "authorization");
  
  let providedKey: string | null = null;
  
  if (xApiKey) {
    providedKey = xApiKey;
  } else if (authHeader?.startsWith("Bearer ")) {
    providedKey = authHeader.slice(7);
  }
  
  if (!providedKey) {
    return {
      valid: false,
      error: "Missing API key. Provide x-api-key header or Authorization: Bearer token",
    };
  }
  
  if (providedKey !== apiKey) {
    return {
      valid: false,
      error: "Invalid API key",
    };
  }
  
  return { valid: true };
}

/**
 * Verify cron secret for Vercel cron jobs
 * Checks against CRON_SECRET environment variable
 */
export function verifyCronSecret(req: VercelRequest): AuthResult {
  const cronSecret = process.env.CRON_SECRET;
  
  if (!cronSecret) {
    console.error("[Auth] CRON_SECRET not configured");
    return {
      valid: false,
      error: "Cron secret not configured",
    };
  }
  
  // Vercel sends Authorization header for cron jobs
  const authHeader = getHeader(req, "authorization");
  
  if (authHeader === `Bearer ${cronSecret}`) {
    return { valid: true };
  }
  
  // Also check x-cron-secret for manual testing
  const xCronSecret = getHeader(req, "x-cron-secret");
  
  if (xCronSecret === cronSecret) {
    return { valid: true };
  }
  
  return {
    valid: false,
    error: "Invalid cron secret",
  };
}

/**
 * Send unauthorized response
 */
export function sendUnauthorized(res: VercelResponse, error: string): void {
  res.status(401).json({ error, success: false });
}

/**
 * Send error response
 */
export function sendError(res: VercelResponse, error: string, status: number = 500): void {
  res.status(status).json({ error, success: false });
}

/**
 * Send success response
 */
export function sendSuccess(res: VercelResponse, data: unknown): void {
  const payload = typeof data === 'object' && data !== null 
    ? { ...data, success: true }
    : { data, success: true };
  res.status(200).json(payload);
}
