/**
 * Project auto-detection
 *
 * Determines a stable project identifier from the environment:
 *   1. git remote origin  (owner/repo)
 *   2. GITHUB_OWNER + GITHUB_REPO env vars
 *   3. basename of cwd
 *
 * The result is cached for the lifetime of the process.
 */

import { execSync } from "child_process";
import { basename } from "path";

let cachedProjectId: string | undefined;

/**
 * Parse "owner/repo" from a git remote URL.
 * Handles HTTPS, SSH, and git:// formats:
 *   https://github.com/owner/repo.git
 *   git@github.com:owner/repo.git
 *   git://github.com/owner/repo.git
 */
function parseOwnerRepo(remoteUrl: string): string | null {
  const trimmed = remoteUrl.trim();

  // SSH: git@github.com:owner/repo.git
  const sshMatch = trimmed.match(/[:\/]([^/]+)\/([^/]+?)(?:\.git)?$/);
  if (sshMatch) {
    return `${sshMatch[1]}/${sshMatch[2]}`;
  }

  return null;
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

  const id = detectFromGitRemote() ?? detectFromEnv() ?? detectFromCwd();
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
