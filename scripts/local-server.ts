/**
 * Local HTTP server for testing API endpoints
 * Run: npx tsx scripts/local-server.ts
 * 
 * Then call:
 *   curl http://localhost:4000/api/tools/tool -H "x-api-key: test" -d '{"tool":"list_servers"}'
 */
import "dotenv/config";
import http from "http";
import { executeToolHandler, getAvailableTools, cleanupToolExecutor } from "../api/lib/tool-executor.js";

const PORT = process.env.PORT || 4000;
const API_KEY = process.env.OPENRUNDOWN_API_KEY || process.env.UNMUTE_API_KEY || "test";

function parseBody(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch {
        reject(new Error("Invalid JSON"));
      }
    });
    req.on("error", reject);
  });
}

function sendJson(res: http.ServerResponse, data: unknown, status = 200) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(data, null, 2));
}

function verifyAuth(req: http.IncomingMessage): boolean {
  const apiKey = req.headers["x-api-key"] || req.headers["authorization"]?.replace("Bearer ", "");
  return apiKey === API_KEY;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || "/", `http://localhost:${PORT}`);
  
  console.log(`[${new Date().toISOString()}] ${req.method} ${url.pathname}`);

  // CORS
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, x-api-key, Authorization");
  
  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  try {
    // Health check
    if (url.pathname === "/" || url.pathname === "/health") {
      return sendJson(res, { status: "ok", timestamp: new Date().toISOString() });
    }

    // GET /api/tools/tool - List tools
    if (url.pathname === "/api/tools/tool" && req.method === "GET") {
      if (!verifyAuth(req)) {
        return sendJson(res, { error: "Unauthorized" }, 401);
      }
      const tools = getAvailableTools();
      return sendJson(res, {
        endpoint: "tool",
        description: "Execute any MCP tool via HTTP",
        usage: { method: "POST", body: { tool: "tool_name", args: "{ ... }" } },
        available_tools: tools,
      });
    }

    // POST /api/tools/tool - Execute tool
    if (url.pathname === "/api/tools/tool" && req.method === "POST") {
      if (!verifyAuth(req)) {
        return sendJson(res, { error: "Unauthorized" }, 401);
      }

      const body = await parseBody(req);
      const { tool, args = {} } = body as { tool?: string; args?: Record<string, unknown> };

      if (!tool) {
        return sendJson(res, { error: "Missing 'tool' in request body" }, 400);
      }

      console.log(`[TOOL] Executing: ${tool}`);
      const startTime = Date.now();

      try {
        const result = await executeToolHandler(tool, args);
        const duration = ((Date.now() - startTime) / 1000).toFixed(2);
        console.log(`[TOOL] ${tool} completed in ${duration}s`);

        return sendJson(res, {
          success: true,
          tool,
          result,
          duration_seconds: parseFloat(duration),
        });
      } catch (error) {
        console.error(`[TOOL] Error:`, error);
        return sendJson(res, {
          success: false,
          error: error instanceof Error ? error.message : String(error),
        }, 500);
      }
    }

    // POST /api/tools/sync - Convenience
    if (url.pathname === "/api/tools/sync" && req.method === "POST") {
      if (!verifyAuth(req)) {
        return sendJson(res, { error: "Unauthorized" }, 401);
      }

      const body = await parseBody(req);
      const result = await executeToolHandler("sync_and_classify", {
        channel_id: body.channel_id,
      });
      return sendJson(res, { success: true, result });
    }

    // POST /api/tools/export - Convenience
    if (url.pathname === "/api/tools/export" && req.method === "POST") {
      if (!verifyAuth(req)) {
        return sendJson(res, { error: "Unauthorized" }, 401);
      }

      const body = await parseBody(req);
      const result = await executeToolHandler("export_to_pm_tool", {
        channel_id: body.channel_id,
        include_closed: body.include_closed,
      });
      return sendJson(res, { success: true, result });
    }

    // GET /api/tools/status
    if (url.pathname === "/api/tools/status" && req.method === "GET") {
      if (!verifyAuth(req)) {
        return sendJson(res, { error: "Unauthorized" }, 401);
      }

      // Import prisma for stats
      const { PrismaClient } = await import("@prisma/client");
      const prisma = new PrismaClient();

      try {
        const [discordCount, issueCount, openCount] = await Promise.all([
          prisma.discordMessage.count(),
          prisma.gitHubIssue.count(),
          prisma.gitHubIssue.count({ where: { issueState: "open" } }),
        ]);

        return sendJson(res, {
          status: "healthy",
          statistics: { discord: discordCount, github: { total: issueCount, open: openCount } },
        });
      } finally {
        await prisma.$disconnect();
      }
    }

    // 404
    sendJson(res, { error: "Not found", path: url.pathname }, 404);

  } catch (error) {
    console.error("[ERROR]", error);
    sendJson(res, { error: error instanceof Error ? error.message : "Internal error" }, 500);
  }
});

// Cleanup on exit
process.on("SIGINT", async () => {
  console.log("\n[SERVER] Shutting down...");
  await cleanupToolExecutor();
  process.exit(0);
});

server.listen(PORT, () => {
  console.log(`
[SERVER] Local API server running at http://localhost:${PORT}

Endpoints:
  GET  /                    - Health check
  GET  /api/tools/tool      - List available tools
  POST /api/tools/tool      - Execute any tool
  POST /api/tools/sync      - Run sync_and_classify
  POST /api/tools/export    - Run export_to_pm_tool
  GET  /api/tools/status    - Get statistics

Auth: x-api-key: ${API_KEY === "test" ? "test (default)" : "<your OPENRUNDOWN_API_KEY>"}

Example:
  curl http://localhost:${PORT}/api/tools/tool \\
    -H "x-api-key: ${API_KEY}" \\
    -H "Content-Type: application/json" \\
    -d '{"tool": "list_servers"}'
`);
});

