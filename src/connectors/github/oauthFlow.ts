/**
 * GitHub OAuth Flow Handler
 * Generates tokens via OAuth - tokens are kept in memory only (no persistence)
 */

import { createServer, type Server } from "http";
import { parse } from "url";
import { exec } from "child_process";
import { promisify } from "util";

const execAsync = promisify(exec);

/**
 * Escape HTML entities to prevent XSS
 */
function escapeHtml(text: string): string {
  const htmlEntities: Record<string, string> = {
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  };
  return text.replace(/[&<>"']/g, (char) => htmlEntities[char] || char);
}

/**
 * Run OAuth flow and automatically get a new token
 * Returns the new token or null if failed
 */
export async function getNewTokenViaOAuth(
  clientId: string,
  clientSecret: string,
  port = 3000
): Promise<string | null> {
  return new Promise((resolve, reject) => {
    let resolved = false;
    let server: Server | null = null;
    let timeoutHandle: NodeJS.Timeout | null = null;

    const cleanup = () => {
      if (timeoutHandle) {
        clearTimeout(timeoutHandle);
        timeoutHandle = null;
      }
      if (server) {
        server.close();
        server = null;
      }
    };

    const safeResolve = (value: string) => {
      if (!resolved) {
        resolved = true;
        cleanup();
        resolve(value);
      }
    };

    const safeReject = (error: Error) => {
      if (!resolved) {
        resolved = true;
        cleanup();
        reject(error);
      }
    };

    const REDIRECT_URI = `http://localhost:${port}/callback`;
    const authUrl = `https://github.com/login/oauth/authorize?client_id=${clientId}&scope=public_repo&redirect_uri=${encodeURIComponent(REDIRECT_URI)}`;

    console.error(`[OAuth] Starting OAuth flow for client ID: ${clientId.substring(0, 12)}...`);
    console.error(`[OAuth] Authorization URL: ${authUrl}`);
    console.error(`[OAuth] Opening browser for authorization...`);

    // Open browser
    const platform = process.platform;
    let openCommand: string;
    if (platform === "darwin") {
      openCommand = "open";
    } else if (platform === "linux") {
      openCommand = "xdg-open";
    } else if (platform === "win32") {
      openCommand = "start";
    } else {
      console.error(`[OAuth] Unsupported platform. Please visit: ${authUrl}`);
      safeReject(new Error("Unsupported platform"));
      return;
    }

    execAsync(`${openCommand} "${authUrl}"`).catch((error) => {
      console.error(`[OAuth] Could not open browser automatically: ${error instanceof Error ? error.message : String(error)}`);
      console.error(`[OAuth] Please visit: ${authUrl}`);
      // Don't reject - user can still manually visit the URL
    });

    // Create server to handle callback
    server = createServer(async (req, res) => {
      if (resolved) return; // Already handled

      const { query } = parse(req.url || "", true);
      const code = query.code as string;

      if (!code) {
        res.writeHead(400);
        res.end("Missing authorization code");
        return;
      }

      try {
        // Exchange code for token
        const tokenResponse = await fetch("https://github.com/login/oauth/access_token", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Accept: "application/json",
          },
          body: JSON.stringify({
            client_id: clientId,
            client_secret: clientSecret,
            code,
          }),
        });

        const tokenData = await tokenResponse.json();

        if (tokenData.error) {
          res.writeHead(400);
          res.end(`Error: ${tokenData.error_description || tokenData.error}`);
          safeReject(new Error(tokenData.error_description || tokenData.error));
          return;
        }

        const accessToken = tokenData.access_token;

        // Verify token works
        const userResponse = await fetch("https://api.github.com/user", {
          headers: {
            Authorization: `Bearer ${accessToken}`,
            Accept: "application/vnd.github.v3+json",
          },
        });

        if (!userResponse.ok) {
          const errorText = await userResponse.text();
          const statusText = userResponse.statusText;
          const status = userResponse.status;
          console.error(`[OAuth] Token verification failed: ${status} ${statusText}`);
          console.error(`[OAuth] Error response: ${errorText}`);
          throw new Error(`Failed to verify token: ${status} ${statusText}. ${errorText}`);
        }

        const userData = await userResponse.json();
        const safeLogin = escapeHtml(String(userData.login || "unknown"));

        res.writeHead(200, { "Content-Type": "text/html" });
        res.end(`
          <html>
            <head><title>Token Generated</title></head>
            <body style="font-family: sans-serif; padding: 40px; max-width: 600px; margin: 0 auto;">
              <h1>Token Generated Successfully!</h1>
              <p>Authorized as: <strong>${safeLogin}</strong></p>
              <p>The token will be used for this session (in memory only).</p>
              <p style="color: #666; margin-top: 30px;">You can close this window.</p>
            </body>
          </html>
        `);

        console.error(`[OAuth] Token generated successfully for ${userData.login}`);

        // Token is returned to caller - no persistence needed (kept in memory only)
        // Give time for response to be sent before closing
        setTimeout(() => {
          safeResolve(accessToken);
        }, 500);
      } catch (error) {
        res.writeHead(500);
        res.end(`Error: ${error instanceof Error ? error.message : String(error)}`);
        console.error("[OAuth] Error:", error);
        safeReject(error instanceof Error ? error : new Error(String(error)));
      }
    });

    server.on("error", (error) => {
      console.error(`[OAuth] Server error: ${error.message}`);
      safeReject(error);
    });

    server.listen(port, () => {
      console.error(`[OAuth] Server listening on http://localhost:${port}`);
      console.error(`[OAuth] Waiting for authorization...`);
    });

    // Timeout after 5 minutes
    timeoutHandle = setTimeout(() => {
      console.error(`[OAuth] Timeout: No authorization received for client ${clientId.substring(0, 8)}...`);
      safeReject(new Error("OAuth timeout: no authorization received within 5 minutes"));
    }, 5 * 60 * 1000);
  });
}

