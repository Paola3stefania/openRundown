/**
 * Database migration endpoint
 * Runs Prisma migrations on the Vercel database
 * POST /api/tools/migrate
 * 
 * Note: Migrations also run automatically during build (see package.json build script).
 * Use this endpoint if you need to run migrations manually.
 */
import type { VercelRequest, VercelResponse } from "@vercel/node";
import { verifyApiKey, sendUnauthorized, sendError, sendSuccess } from "../lib/middleware.js";
import { execSync } from "child_process";

export default async function handler(req: VercelRequest, res: VercelResponse) {
  // Only allow POST
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed", success: false });
  }

  // Verify API key
  const auth = verifyApiKey(req);
  if (!auth.valid) {
    return sendUnauthorized(res, auth.error || "Unauthorized");
  }

  if (!process.env.DATABASE_URL) {
    return sendError(res, "DATABASE_URL environment variable is not set", 500);
  }

  try {
    console.log("[Migrate] Starting database migrations...");
    
    // Run Prisma migrations
    const output = execSync("npx prisma migrate deploy", {
      encoding: "utf-8",
      stdio: "pipe",
      env: process.env,
      cwd: process.cwd(),
    });

    console.log("[Migrate] Migrations completed successfully");
    
    const lines = output.split("\n").filter((line) => line.trim().length > 0);
    
    return sendSuccess(res, {
      message: "Database migrations completed successfully",
      output: lines,
      applied: lines.some((line) => line.includes("Applied") || line.includes("migration")),
    });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    const errorOutput = error instanceof Error && 'stdout' in error 
      ? (error as { stdout?: string }).stdout 
      : undefined;
    
    console.error("[Migrate] Migration failed:", errorMessage);
    
    return sendError(res, `Migration failed: ${errorMessage}${errorOutput ? `\n${errorOutput}` : ""}`, 500);
  }
}

