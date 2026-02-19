/**
 * Project auto-detection
 *
 * Determines a stable project identifier from the environment:
 *   1. OPENRUNDOWN_PROJECT env var  (explicit override)
 *   2. git remote origin  (owner/repo)
 *   3. GITHUB_OWNER + GITHUB_REPO env vars
 *   4. basename of cwd
 *
 * NOTE: When running as an MCP server, git remote detects this repo —
 * not the agent's workspace. Agents should pass `project` explicitly.
 * This detection is a fallback for CLI scripts running inside a project.
 *
 * The result is cached for the lifetime of the process.
 */

import { execSync } from "child_process";
import { basename } from "path";

let cachedProjectId: string | undefined;

/**
 * Parse "owner/repo" from a git remote URL.
 * Handles HTTPS, SSH, and git:// formats.
 */
function parseOwnerRepo(remoteUrl: string): string | null {
  const trimmed = remoteUrl.trim();
  const match = trimmed.match(/[:\/]([^/]+)\/([^/]+?)(?:\.git)?$/);
  return match ? `${match[1]}/${match[2]}` : null;
}

function detectFromGitRemote(): string | null {
  try {
    const remote = execSync("git remote get-url origin", {
      encoding: "utf-8",
      timeout: 3000,
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();

    if (!remote) return null;
    return parseOwnerRepo(remote);
  } catch {
    return null;
  }
}

function detectFromEnv(): string | null {
  const explicit = process.env.OPENRUNDOWN_PROJECT;
  if (explicit) return explicit;

  const owner = process.env.GITHUB_OWNER;
  const repo = process.env.GITHUB_REPO;
  if (owner && repo) return `${owner}/${repo}`;
  if (repo) return repo;
  return null;
}

function detectFromCwd(): string {
  return basename(process.cwd());
}

/**
 * Detect the current project identifier.
 * Result is cached — safe to call repeatedly.
 */
export function detectProjectId(): string {
  if (cachedProjectId !== undefined) return cachedProjectId;

  const id = detectFromEnv() ?? detectFromGitRemote() ?? detectFromCwd();
  cachedProjectId = id;
  return id;
}

/**
 * Override the cached project ID (useful for tests or explicit configuration).
 */
export function setProjectId(id: string): void {
  cachedProjectId = id;
}

/**
 * Clear the cached project ID so the next call re-detects.
 */
export function resetProjectId(): void {
  cachedProjectId = undefined;
}
