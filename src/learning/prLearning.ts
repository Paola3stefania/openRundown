/**
 * PR Learning Service
 * 
 * Fetches historical closed issues with their merged PRs to build a learning dataset.
 * This enables the investigate_issue tool to find similar past fixes and learn from them.
 */

import { PrismaClient } from "@prisma/client";
import { getConfig } from "../config/index.js";
import { GitHubTokenManager } from "../connectors/github/tokenManager.js";
import { log, logError } from "../mcp/logger.js";
import { createHash } from "crypto";

// ============================================================================
// Types
// ============================================================================

export interface SeedOptions {
  since?: string;        // ISO date to fetch issues from
  limit?: number;        // Max number of issues to process
  dryRun?: boolean;      // Show what would be seeded without storing
  batchSize?: number;    // Issues per batch (default: 50)
  repo?: string;         // Repository in format 'owner/repo'. Defaults to config.
}

export interface SeedResult {
  totalIssuesFound: number;
  issuesWithPRs: number;
  prLearningsCreated: number;
  prLearningsSkipped: number;  // Already in DB
  errors: Array<{ issueNumber: number; error: string }>;
  timeElapsed: number;
}

interface GitHubIssue {
  number: number;
  title: string;
  body: string | null;
  state: string;
  labels: Array<{ name: string }>;
  user: { login: string };
  created_at: string;
  updated_at: string;
  closed_at: string | null;
  html_url: string;
}

interface GitHubPR {
  number: number;
  title: string;
  body: string | null;
  state: string;
  merged: boolean;
  merged_at: string | null;
  user: { login: string };
  html_url: string;
  head: { ref: string };
  base: { ref: string };
}

interface GitHubPRFile {
  filename: string;
  status: string;
  additions: number;
  deletions: number;
  changes: number;
  patch?: string;
}

interface GitHubReview {
  id: number;
  user: { login: string };
  body: string | null;
  state: string;  // 'APPROVED' | 'CHANGES_REQUESTED' | 'COMMENTED' | 'DISMISSED'
  submitted_at: string;
}

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Create a content hash for deduplication
 */
function createContentHash(issueNumber: number, prNumber: number, issueRepo: string): string {
  const content = `${issueRepo}:${issueNumber}:${prNumber}`;
  return createHash("sha256").update(content).digest("hex").substring(0, 32);
}

/**
 * Detect issue type from labels
 */
function detectIssueType(labels: string[]): string {
  const labelSet = new Set(labels.map(l => l.toLowerCase()));
  
  if (labelSet.has("bug") || labelSet.has("fix") || labelSet.has("bugfix")) {
    return "bug";
  }
  if (labelSet.has("feature") || labelSet.has("enhancement") || labelSet.has("feat")) {
    return "feature";
  }
  if (labelSet.has("docs") || labelSet.has("documentation")) {
    return "docs";
  }
  if (labelSet.has("security")) {
    return "security";
  }
  if (labelSet.has("performance") || labelSet.has("perf")) {
    return "performance";
  }
  if (labelSet.has("refactor") || labelSet.has("cleanup")) {
    return "refactor";
  }
  if (labelSet.has("test") || labelSet.has("testing")) {
    return "test";
  }
  
  return "other";
}

/**
 * Detect subsystem from file paths
 */
function detectSubsystem(filePaths: string[]): string | null {
  const subsystemPatterns: Record<string, RegExp[]> = {
    "oauth": [/oauth/i, /providers?\//i],
    "sso": [/sso/i, /saml/i, /oidc/i],
    "organization": [/organization/i, /org\//i, /teams?\//i],
    "api-key": [/api-key/i, /apikey/i],
    "passkey": [/passkey/i, /webauthn/i],
    "two-factor": [/two-factor/i, /2fa/i, /totp/i, /otp/i],
    "admin": [/admin/i],
    "stripe": [/stripe/i, /payment/i],
    "adapter": [/adapter/i, /database/i, /prisma/i, /drizzle/i],
    "cli": [/cli/i, /command/i],
    "client": [/client/i, /react/i, /vue/i, /svelte/i],
    "db": [/schema/i, /migration/i, /model/i],
  };
  
  for (const [subsystem, patterns] of Object.entries(subsystemPatterns)) {
    for (const filePath of filePaths) {
      for (const pattern of patterns) {
        if (pattern.test(filePath)) {
          return subsystem;
        }
      }
    }
  }
  
  return null;
}

/**
 * Detect fix patterns from the diff
 */
function detectFixPatterns(diff: string, filePaths: string[]): string[] {
  const patterns: string[] = [];
  
  // Check for common fix patterns in diff
  if (/\+.*\bnull\b|\+.*\bundefined\b|\+.*\?\./i.test(diff)) {
    patterns.push("null_check");
  }
  if (/\+.*try\s*{|\+.*catch\s*\(|\+.*\.catch\(/i.test(diff)) {
    patterns.push("error_handling");
  }
  if (/\+.*:\s*(string|number|boolean|any)\b|\+.*<[A-Z]\w*>/i.test(diff)) {
    patterns.push("type_fix");
  }
  if (/\+.*async\s|\+.*await\s|\+.*Promise/i.test(diff)) {
    patterns.push("async_fix");
  }
  if (/\+.*if\s*\(|\+.*else\s*{|\+.*\?\s*:/i.test(diff)) {
    patterns.push("conditional_logic");
  }
  if (/\+.*return\s|\+.*throw\s/i.test(diff)) {
    patterns.push("return_fix");
  }
  if (/\+.*import\s|\+.*export\s/i.test(diff)) {
    patterns.push("import_fix");
  }
  if (/\+.*console\.|\+.*log\(|\+.*debug\(/i.test(diff)) {
    patterns.push("logging");
  }
  if (/\+.*test\(|\+.*describe\(|\+.*it\(|\+.*expect\(/i.test(diff)) {
    patterns.push("test_added");
  }
  
  // Check file types
  const hasTestFiles = filePaths.some(f => /\.test\.|\.spec\.|__tests__/i.test(f));
  if (hasTestFiles && !patterns.includes("test_added")) {
    patterns.push("test_added");
  }
  
  const hasTypeFiles = filePaths.some(f => /\.d\.ts$|types?\./i.test(f));
  if (hasTypeFiles) {
    patterns.push("type_definition");
  }
  
  return patterns;
}

/**
 * Determine review outcome from reviews
 */
function determineReviewOutcome(reviews: GitHubReview[]): string {
  if (reviews.length === 0) {
    return "merged_without_review";
  }
  
  const hasApproval = reviews.some(r => r.state === "APPROVED");
  const hasChangesRequested = reviews.some(r => r.state === "CHANGES_REQUESTED");
  
  if (hasApproval && !hasChangesRequested) {
    return "approved";
  }
  if (hasChangesRequested) {
    return "changes_requested";
  }
  
  return "commented_only";
}

/**
 * Wait helper with exponential backoff
 */
async function wait(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Retry helper with exponential backoff
 */
async function retryWithBackoff<T>(
  fn: () => Promise<T>,
  maxRetries: number = 3,
  initialDelay: number = 1000
): Promise<T> {
  let lastError: unknown;
  
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      
      // Don't retry on rate limit errors (403/429) - they need token rotation
      const errorMsg = error instanceof Error ? error.message : String(error);
      if (errorMsg.includes("403") || errorMsg.includes("429")) {
        throw error;
      }
      
      if (attempt < maxRetries) {
        const delay = initialDelay * Math.pow(2, attempt);
        log(`[PRLearning] Retry ${attempt + 1}/${maxRetries} after ${delay}ms...`);
        await wait(delay);
      }
    }
  }
  
  throw lastError;
}

// ============================================================================
// GitHub API Functions
// ============================================================================

/**
 * Fetch closed issues from GitHub
 */
async function fetchClosedIssues(
  tokenManager: GitHubTokenManager,
  owner: string,
  repo: string,
  since?: string,
  limit?: number
): Promise<GitHubIssue[]> {
  const issues: GitHubIssue[] = [];
  let page = 1;
  let hasMore = true;
  
  log(`[PRLearning] Fetching closed issues from ${owner}/${repo}...`);
  
  while (hasMore && (limit === undefined || issues.length < limit)) {
    let url = `https://api.github.com/repos/${owner}/${repo}/issues?state=closed&per_page=100&page=${page}&sort=updated&direction=desc`;
    if (since) {
      url += `&since=${encodeURIComponent(since)}`;
    }
    
    const token = await tokenManager.getCurrentToken();
    const response = await fetch(url, {
      headers: {
        Accept: "application/vnd.github.v3+json",
        Authorization: `Bearer ${token}`,
      },
    });
    
    tokenManager.updateRateLimitFromResponse(response, token);
    
    if (!response.ok) {
      if (response.status === 403 || response.status === 429) {
        // Try to rotate token
        const nextToken = await tokenManager.getNextAvailableToken();
        if (nextToken) {
          log(`[PRLearning] Rate limit hit, rotating token...`);
          continue; // Retry with new token
        }
        
        const resetHeader = response.headers.get("X-RateLimit-Reset");
        const resetTime = resetHeader ? new Date(parseInt(resetHeader) * 1000).toISOString() : "unknown";
        throw new Error(`Rate limit exceeded. Resets at: ${resetTime}`);
      }
      throw new Error(`GitHub API error: ${response.status} ${response.statusText}`);
    }
    
    const pageIssues = await response.json() as GitHubIssue[];
    
    // Filter out pull requests (they have pull_request field)
    const actualIssues = pageIssues.filter(issue => !("pull_request" in issue));
    
    if (limit !== undefined) {
      const remaining = limit - issues.length;
      issues.push(...actualIssues.slice(0, remaining));
    } else {
      issues.push(...actualIssues);
    }
    
    if (pageIssues.length < 100) {
      hasMore = false;
    } else {
      page++;
      await wait(100); // Rate limiting
    }
    
    if (page % 5 === 0) {
      log(`[PRLearning] Fetched ${issues.length} closed issues so far...`);
    }
  }
  
  log(`[PRLearning] Found ${issues.length} closed issues`);
  return issues;
}

/**
 * Find PRs that closed an issue using timeline events
 */
async function findClosingPRs(
  tokenManager: GitHubTokenManager,
  owner: string,
  repo: string,
  issueNumber: number
): Promise<number[]> {
  const prNumbers: number[] = [];
  
  try {
    const token = await tokenManager.getCurrentToken();
    
    // Use the timeline API to find cross-references and merged PRs
    const url = `https://api.github.com/repos/${owner}/${repo}/issues/${issueNumber}/timeline`;
    const response = await fetch(url, {
      headers: {
        Accept: "application/vnd.github.mockingbird-preview+json",
        Authorization: `Bearer ${token}`,
      },
    });
    
    tokenManager.updateRateLimitFromResponse(response, token);
    
    if (!response.ok) {
      return prNumbers;
    }
    
    const events = await response.json() as Array<{
      event: string;
      source?: {
        type: string;
        issue?: {
          number: number;
          pull_request?: object;
        };
      };
      commit_id?: string;
    }>;
    
    for (const event of events) {
      // Look for cross-referenced PRs
      if (event.event === "cross-referenced" && event.source?.type === "issue") {
        const sourceIssue = event.source.issue;
        if (sourceIssue && sourceIssue.pull_request) {
          prNumbers.push(sourceIssue.number);
        }
      }
      
      // Look for closed events with commit (PR merge)
      if (event.event === "closed" && event.commit_id) {
        // This issue was closed by a commit, likely a PR merge
        // We'll need to find which PR contains this commit
        // For now, we rely on cross-references
      }
    }
    
  } catch (error) {
    logError(`[PRLearning] Error fetching timeline for issue #${issueNumber}:`, error);
  }
  
  return prNumbers;
}

/**
 * Find PRs by searching for "Fixes #123" patterns
 */
async function findPRsBySearch(
  tokenManager: GitHubTokenManager,
  owner: string,
  repo: string,
  issueNumber: number
): Promise<number[]> {
  const prNumbers: number[] = [];
  
  try {
    let token = await tokenManager.getCurrentToken();
    
    // Search for PRs that mention this issue
    const searchQuery = `repo:${owner}/${repo} type:pr is:merged ${issueNumber}`;
    const url = `https://api.github.com/search/issues?q=${encodeURIComponent(searchQuery)}&per_page=20`;
    
    let response = await fetch(url, {
      headers: {
        Accept: "application/vnd.github.v3+json",
        Authorization: `Bearer ${token}`,
      },
    });
    
    tokenManager.updateRateLimitFromResponse(response, token);
    
    // Handle rate limits - Search API has 30/min limit
    if (response.status === 403 || response.status === 429) {
      const rateLimitLimit = response.headers.get('X-RateLimit-Limit');
      const isSearchLimit = rateLimitLimit === '30';
      const limitType = isSearchLimit ? 'Search API (30/min)' : 'Core API';
      
      log(`[PRLearning] ${limitType} rate limit hit for issue #${issueNumber}`);
      
      // Try rotating to another token first
      const nextToken = await tokenManager.getNextAvailableToken();
      if (nextToken && nextToken !== token) {
        log(`[PRLearning] Rotating to next available token...`);
        token = nextToken;
        
        response = await fetch(url, {
          headers: {
            Accept: "application/vnd.github.v3+json",
            Authorization: `Bearer ${token}`,
          },
        });
        tokenManager.updateRateLimitFromResponse(response, token);
        
        // If still rate limited, wait
        if (response.status === 403 || response.status === 429) {
          const retryAfter = response.headers.get('Retry-After');
          const waitTime = retryAfter ? parseInt(retryAfter) * 1000 : (isSearchLimit ? 60000 : 300000);
          log(`[PRLearning] Still rate limited. Waiting ${Math.ceil(waitTime / 1000)}s...`);
          await new Promise(resolve => setTimeout(resolve, waitTime));
          
          response = await fetch(url, {
            headers: {
              Accept: "application/vnd.github.v3+json",
              Authorization: `Bearer ${token}`,
            },
          });
          tokenManager.updateRateLimitFromResponse(response, token);
        }
      } else {
        // No other token - wait
        const retryAfter = response.headers.get('Retry-After');
        const waitTime = retryAfter ? parseInt(retryAfter) * 1000 : (isSearchLimit ? 60000 : 300000);
        log(`[PRLearning] No other tokens. Waiting ${Math.ceil(waitTime / 1000)}s...`);
        await new Promise(resolve => setTimeout(resolve, waitTime));
        
        response = await fetch(url, {
          headers: {
            Accept: "application/vnd.github.v3+json",
            Authorization: `Bearer ${token}`,
          },
        });
        tokenManager.updateRateLimitFromResponse(response, token);
      }
    }
    
    if (!response.ok) {
      return prNumbers;
    }
    
    const result = await response.json() as {
      items: Array<{ number: number; body: string | null; title: string }>;
    };
    
    // Verify each PR actually references this issue
    const issueRefPattern = /(?:closes?|fixes?|resolves?)\s*#(\d+)/gi;
    
    for (const item of result.items) {
      const text = `${item.title} ${item.body || ""}`;
      const matches = [...text.matchAll(issueRefPattern)];
      
      for (const match of matches) {
        if (parseInt(match[1]) === issueNumber) {
          prNumbers.push(item.number);
          break;
        }
      }
    }
    
  } catch (error) {
    logError(`[PRLearning] Error searching PRs for issue #${issueNumber}:`, error);
  }
  
  return prNumbers;
}

/**
 * Fetch PR details
 */
async function fetchPRDetails(
  tokenManager: GitHubTokenManager,
  owner: string,
  repo: string,
  prNumber: number
): Promise<GitHubPR | null> {
  try {
    const token = await tokenManager.getCurrentToken();
    const url = `https://api.github.com/repos/${owner}/${repo}/pulls/${prNumber}`;
    
    const response = await fetch(url, {
      headers: {
        Accept: "application/vnd.github.v3+json",
        Authorization: `Bearer ${token}`,
      },
    });
    
    tokenManager.updateRateLimitFromResponse(response, token);
    
    if (!response.ok) {
      return null;
    }
    
    return await response.json() as GitHubPR;
  } catch (error) {
    logError(`[PRLearning] Error fetching PR #${prNumber}:`, error);
    return null;
  }
}

/**
 * Fetch PR files (diff)
 */
async function fetchPRFiles(
  tokenManager: GitHubTokenManager,
  owner: string,
  repo: string,
  prNumber: number
): Promise<GitHubPRFile[]> {
  try {
    const token = await tokenManager.getCurrentToken();
    const url = `https://api.github.com/repos/${owner}/${repo}/pulls/${prNumber}/files?per_page=100`;
    
    const response = await fetch(url, {
      headers: {
        Accept: "application/vnd.github.v3+json",
        Authorization: `Bearer ${token}`,
      },
    });
    
    tokenManager.updateRateLimitFromResponse(response, token);
    
    if (!response.ok) {
      return [];
    }
    
    return await response.json() as GitHubPRFile[];
  } catch (error) {
    logError(`[PRLearning] Error fetching PR #${prNumber} files:`, error);
    return [];
  }
}

/**
 * Fetch PR reviews
 */
async function fetchPRReviews(
  tokenManager: GitHubTokenManager,
  owner: string,
  repo: string,
  prNumber: number
): Promise<GitHubReview[]> {
  try {
    const token = await tokenManager.getCurrentToken();
    const url = `https://api.github.com/repos/${owner}/${repo}/pulls/${prNumber}/reviews`;
    
    const response = await fetch(url, {
      headers: {
        Accept: "application/vnd.github.v3+json",
        Authorization: `Bearer ${token}`,
      },
    });
    
    tokenManager.updateRateLimitFromResponse(response, token);
    
    if (!response.ok) {
      return [];
    }
    
    return await response.json() as GitHubReview[];
  } catch (error) {
    logError(`[PRLearning] Error fetching PR #${prNumber} reviews:`, error);
    return [];
  }
}

// ============================================================================
// Main Seeding Function
// ============================================================================

/**
 * Seed the PRLearning table with historical closed issues and their merged PRs
 */
export async function seedPRLearnings(options: SeedOptions = {}): Promise<SeedResult> {
  const { since, limit, dryRun = false, batchSize = 50, repo: repoParam } = options;
  const startTime = Date.now();
  
  const config = getConfig();
  const prisma = new PrismaClient();
  let owner: string;
  let repo: string;

  if (repoParam) {
    const parts = repoParam.split("/");
    if (parts.length !== 2) throw new Error(`Invalid repo format: ${repoParam}. Expected owner/repo`);
    owner = parts[0];
    repo = parts[1];
  } else {
    owner = config.github.owner;
    repo = config.github.repo;
  }
  const issueRepo = `${owner}/${repo}`;
  
  const result: SeedResult = {
    totalIssuesFound: 0,
    issuesWithPRs: 0,
    prLearningsCreated: 0,
    prLearningsSkipped: 0,
    errors: [],
    timeElapsed: 0,
  };
  
  try {
    // Initialize token manager
    const tokenManager = await GitHubTokenManager.fromEnvironment();
    if (!tokenManager) {
      throw new Error("GitHub token is required for seeding. Set GITHUB_TOKEN environment variable.");
    }
    
    log(`[PRLearning] Starting seed for ${issueRepo}...`);
    if (since) {
      log(`[PRLearning] Fetching issues updated since: ${since}`);
    }
    if (limit) {
      log(`[PRLearning] Limiting to ${limit} issues`);
    }
    if (dryRun) {
      log(`[PRLearning] DRY RUN - no data will be stored`);
    }
    
    // Fetch closed issues
    const closedIssues = await fetchClosedIssues(tokenManager, owner, repo, since, limit);
    result.totalIssuesFound = closedIssues.length;
    
    // Process issues in batches
    for (let i = 0; i < closedIssues.length; i += batchSize) {
      const batch = closedIssues.slice(i, i + batchSize);
      log(`[PRLearning] Processing batch ${Math.floor(i / batchSize) + 1}/${Math.ceil(closedIssues.length / batchSize)} (${batch.length} issues)...`);
      
      for (const issue of batch) {
        try {
          // Check if already in DB
          const existing = await prisma.pRLearning.findFirst({
            where: {
              issueNumber: issue.number,
              issueRepo,
            },
          });
          
          if (existing) {
            result.prLearningsSkipped++;
            continue;
          }
          
          // Find PRs that closed this issue
          const timelinePRs = await findClosingPRs(tokenManager, owner, repo, issue.number);
          const searchPRs = await findPRsBySearch(tokenManager, owner, repo, issue.number);
          
          // Combine and deduplicate PR numbers
          const prNumbers = [...new Set([...timelinePRs, ...searchPRs])];
          
          if (prNumbers.length === 0) {
            continue; // No PRs found for this issue
          }
          
          result.issuesWithPRs++;
          
          // Process each PR
          for (const prNumber of prNumbers) {
            try {
              // Fetch PR details
              const pr = await fetchPRDetails(tokenManager, owner, repo, prNumber);
              if (!pr || !pr.merged) {
                continue; // Only interested in merged PRs
              }
              
              // Fetch PR files
              const files = await fetchPRFiles(tokenManager, owner, repo, prNumber);
              const filePaths = files.map(f => f.filename);
              
              // Build diff from patches
              const diff = files
                .filter(f => f.patch)
                .map(f => `--- ${f.filename}\n+++ ${f.filename}\n${f.patch}`)
                .join("\n\n");
              
              // Calculate lines changed
              const linesAdded = files.reduce((sum, f) => sum + f.additions, 0);
              const linesRemoved = files.reduce((sum, f) => sum + f.deletions, 0);
              
              // Fetch reviews
              const reviews = await fetchPRReviews(tokenManager, owner, repo, prNumber);
              
              // Detect issue type, subsystem, and patterns
              const issueLabels = issue.labels.map(l => l.name);
              const issueType = detectIssueType(issueLabels);
              const subsystem = detectSubsystem(filePaths);
              const fixPatterns = detectFixPatterns(diff, filePaths);
              const reviewOutcome = determineReviewOutcome(reviews);
              
              // Create content hash
              const contentHash = createContentHash(issue.number, prNumber, issueRepo);
              
              if (!dryRun) {
                // Store in database
                await prisma.pRLearning.create({
                  data: {
                    issueNumber: issue.number,
                    issueRepo,
                    issueTitle: issue.title,
                    issueBody: issue.body,
                    issueLabels,
                    issueState: issue.state,
                    prNumber,
                    prTitle: pr.title,
                    prBody: pr.body,
                    prDiff: diff,
                    prFilesChanged: filePaths,
                    prLinesAdded: linesAdded,
                    prLinesRemoved: linesRemoved,
                    prMergedAt: pr.merged_at ? new Date(pr.merged_at) : null,
                    prAuthor: pr.user.login,
                    issueType,
                    subsystem,
                    fixPatterns,
                    reviewComments: reviews.map(r => ({
                      user: r.user.login,
                      body: r.body,
                      state: r.state,
                      submitted_at: r.submitted_at,
                    })),
                    reviewOutcome,
                    contentHash,
                  },
                });
              }
              
              result.prLearningsCreated++;
              log(`[PRLearning] ${dryRun ? "[DRY RUN] Would create" : "Created"} learning: Issue #${issue.number} -> PR #${prNumber} (${issueType}, ${subsystem || "general"}, patterns: ${fixPatterns.join(", ") || "none"})`);
              
            } catch (error) {
              const errorMsg = error instanceof Error ? error.message : String(error);
              result.errors.push({ issueNumber: issue.number, error: `PR #${prNumber}: ${errorMsg}` });
              logError(`[PRLearning] Error processing PR #${prNumber} for issue #${issue.number}:`, error);
            }
            
            await wait(100); // Rate limiting between PRs
          }
          
        } catch (error) {
          const errorMsg = error instanceof Error ? error.message : String(error);
          result.errors.push({ issueNumber: issue.number, error: errorMsg });
          logError(`[PRLearning] Error processing issue #${issue.number}:`, error);
        }
      }
      
      // Delay between batches
      await wait(1000);
    }
    
    result.timeElapsed = Date.now() - startTime;
    
    log(`[PRLearning] Seed complete!`);
    log(`[PRLearning] - Total issues found: ${result.totalIssuesFound}`);
    log(`[PRLearning] - Issues with PRs: ${result.issuesWithPRs}`);
    log(`[PRLearning] - PRLearnings created: ${result.prLearningsCreated}`);
    log(`[PRLearning] - PRLearnings skipped (existing): ${result.prLearningsSkipped}`);
    log(`[PRLearning] - Errors: ${result.errors.length}`);
    log(`[PRLearning] - Time elapsed: ${Math.round(result.timeElapsed / 1000)}s`);
    
    return result;
    
  } finally {
    await prisma.$disconnect();
  }
}

/**
 * Learn from a single merged PR
 */
export async function learnFromPR(prNumber: number, force: boolean = false, repoParam?: string): Promise<boolean> {
  const config = getConfig();
  const prisma = new PrismaClient();
  let owner: string;
  let repo: string;

  if (repoParam) {
    const parts = repoParam.split("/");
    if (parts.length !== 2) throw new Error(`Invalid repo format: ${repoParam}. Expected owner/repo`);
    owner = parts[0];
    repo = parts[1];
  } else {
    owner = config.github.owner;
    repo = config.github.repo;
  }
  const issueRepo = `${owner}/${repo}`;
  
  try {
    const tokenManager = await GitHubTokenManager.fromEnvironment();
    if (!tokenManager) {
      throw new Error("GitHub token is required. Set GITHUB_TOKEN environment variable.");
    }
    
    // Fetch PR details
    const pr = await fetchPRDetails(tokenManager, owner, repo, prNumber);
    if (!pr) {
      throw new Error(`PR #${prNumber} not found`);
    }
    if (!pr.merged) {
      log(`[PRLearning] PR #${prNumber} is not merged, skipping`);
      return false;
    }
    
    // Find linked issues from PR body
    const issueRefPattern = /(?:closes?|fixes?|resolves?)\s*#(\d+)/gi;
    const text = `${pr.title} ${pr.body || ""}`;
    const matches = [...text.matchAll(issueRefPattern)];
    const issueNumbers = [...new Set(matches.map(m => parseInt(m[1])))];
    
    if (issueNumbers.length === 0) {
      log(`[PRLearning] PR #${prNumber} doesn't reference any issues, skipping`);
      return false;
    }
    
    // Fetch PR files
    const files = await fetchPRFiles(tokenManager, owner, repo, prNumber);
    const filePaths = files.map(f => f.filename);
    const diff = files
      .filter(f => f.patch)
      .map(f => `--- ${f.filename}\n+++ ${f.filename}\n${f.patch}`)
      .join("\n\n");
    const linesAdded = files.reduce((sum, f) => sum + f.additions, 0);
    const linesRemoved = files.reduce((sum, f) => sum + f.deletions, 0);
    
    // Fetch reviews
    const reviews = await fetchPRReviews(tokenManager, owner, repo, prNumber);
    
    let created = false;
    
    for (const issueNumber of issueNumbers) {
      // Check if already exists
      if (!force) {
        const existing = await prisma.pRLearning.findFirst({
          where: { issueNumber, prNumber, issueRepo },
        });
        if (existing) {
          log(`[PRLearning] Learning for issue #${issueNumber} -> PR #${prNumber} already exists, skipping`);
          continue;
        }
      }
      
      // Fetch issue details
      const token = await tokenManager.getCurrentToken();
      const issueResponse = await fetch(
        `https://api.github.com/repos/${owner}/${repo}/issues/${issueNumber}`,
        {
          headers: {
            Accept: "application/vnd.github.v3+json",
            Authorization: `Bearer ${token}`,
          },
        }
      );
      
      tokenManager.updateRateLimitFromResponse(issueResponse, token);
      
      if (!issueResponse.ok) {
        logError(`[PRLearning] Failed to fetch issue #${issueNumber}`);
        continue;
      }
      
      const issue = await issueResponse.json() as GitHubIssue;
      const issueLabels = issue.labels.map(l => l.name);
      const issueType = detectIssueType(issueLabels);
      const subsystem = detectSubsystem(filePaths);
      const fixPatterns = detectFixPatterns(diff, filePaths);
      const reviewOutcome = determineReviewOutcome(reviews);
      const contentHash = createContentHash(issueNumber, prNumber, issueRepo);
      
      await prisma.pRLearning.upsert({
        where: {
          issueNumber_prNumber_issueRepo: {
            issueNumber,
            prNumber,
            issueRepo,
          },
        },
        create: {
          issueNumber,
          issueRepo,
          issueTitle: issue.title,
          issueBody: issue.body,
          issueLabels,
          issueState: issue.state,
          prNumber,
          prTitle: pr.title,
          prBody: pr.body,
          prDiff: diff,
          prFilesChanged: filePaths,
          prLinesAdded: linesAdded,
          prLinesRemoved: linesRemoved,
          prMergedAt: pr.merged_at ? new Date(pr.merged_at) : null,
          prAuthor: pr.user.login,
          issueType,
          subsystem,
          fixPatterns,
          reviewComments: reviews.map(r => ({
            user: r.user.login,
            body: r.body,
            state: r.state,
            submitted_at: r.submitted_at,
          })),
          reviewOutcome,
          contentHash,
        },
        update: {
          issueTitle: issue.title,
          issueBody: issue.body,
          issueLabels,
          issueState: issue.state,
          prTitle: pr.title,
          prBody: pr.body,
          prDiff: diff,
          prFilesChanged: filePaths,
          prLinesAdded: linesAdded,
          prLinesRemoved: linesRemoved,
          prMergedAt: pr.merged_at ? new Date(pr.merged_at) : null,
          prAuthor: pr.user.login,
          issueType,
          subsystem,
          fixPatterns,
          reviewComments: reviews.map(r => ({
            user: r.user.login,
            body: r.body,
            state: r.state,
            submitted_at: r.submitted_at,
          })),
          reviewOutcome,
          contentHash,
        },
      });
      
      log(`[PRLearning] Created/updated learning: Issue #${issueNumber} -> PR #${prNumber}`);
      created = true;
    }
    
    return created;
    
  } finally {
    await prisma.$disconnect();
  }
}
