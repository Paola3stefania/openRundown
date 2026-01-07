/**
 * Linear Status Sync
 * Syncs GitHub issue states with Linear tickets
 * One-way sync: GitHub -> Linear
 * 
 * Logic:
 * 1. Get all open Linear tickets (state != done/canceled)
 * 2. For each ticket, find connected GitHub issues and PRs
 * 3. Mark as Done if:
 *    - ALL connected GitHub issues are closed, OR
 *    - ANY PR in description is merged
 */

import { PrismaClient } from "@prisma/client";
import { LinearIntegration } from "../export/linear/client.js";
import { log, logError } from "../mcp/logger.js";
import { getConfig } from "../config/index.js";
import { GitHubTokenManager } from "../connectors/github/tokenManager.js";
// Reuse functions from prBasedSync
import { 
  savePRsToDatabase
} from "./prBasedSync.js";
// Import GitHubPR from client (same source as prBasedSync)
import type { GitHubPR } from "../connectors/github/client.js";

// ============================================================================
// Constants
// ============================================================================

const ISSUE_STATES = {
  OPEN: "open",
  CLOSED: "closed",
  UNKNOWN: "unknown",
} as const;

const LINEAR_STATUS = {
  DONE: "done",
  PENDING: "pending",
} as const;

const SYNC_ACTIONS = {
  MARKED_DONE: "marked_done",
  MARKED_REVIEW: "marked_review",
  UNCHANGED: "unchanged",
  SKIPPED: "skipped",
  ERROR: "error",
} as const;

const BATCH_SIZE = 50; // For batching API calls
const CONCURRENCY_LIMIT = 5; // Max parallel API calls

// ============================================================================
// Types
// ============================================================================

export interface SyncSummary {
  totalLinearTickets: number;
  synced: number;
  markedDone: number;
  markedReview: number;
  skippedNoLinks: number;
  unchanged: number;
  errors: number;
  unarchivedCount: number;
  details: SyncDetail[];
}

interface SyncDetail {
    linearIdentifier: string;
  action: typeof SYNC_ACTIONS[keyof typeof SYNC_ACTIONS];
    reason: string;
    githubIssues: Array<{ number: number; state: string }>;
    prs: Array<{ url: string; merged: boolean }>;
}

interface GitHubIssueUrl {
  owner: string;
  repo: string;
  number: number;
}

interface GitHubPRUrl extends GitHubIssueUrl {
  url: string;
}

interface LinearConfig {
  apiKey: string;
  teamId: string;
  apiUrl: string;
}

interface SyncOptions {
  dryRun?: boolean;
  force?: boolean;
}

interface SyncDependencies {
  prisma: PrismaClient;
  linear: LinearIntegration;
  linearConfig: LinearConfig;
  tokenManager: GitHubTokenManager | null;
  config: ReturnType<typeof getConfig>;
}

// ============================================================================
// URL Extraction Utilities
// ============================================================================

const GITHUB_ISSUE_PATTERN = /https:\/\/github\.com\/([^\/]+)\/([^\/]+)\/issues\/(\d+)/g;
const GITHUB_PR_PATTERN = /https:\/\/github\.com\/([^\/]+)\/([^\/]+)\/pull\/(\d+)/g;

function extractGitHubIssueUrls(text: string): GitHubIssueUrl[] {
  const results: GitHubIssueUrl[] = [];
  let match;
  
  // Reset regex state
  GITHUB_ISSUE_PATTERN.lastIndex = 0;
  
  while ((match = GITHUB_ISSUE_PATTERN.exec(text)) !== null) {
    results.push({
      owner: match[1],
      repo: match[2],
      number: parseInt(match[3], 10),
    });
  }
  
  return results;
}

function extractGitHubPRUrls(text: string): GitHubPRUrl[] {
  const results: GitHubPRUrl[] = [];
  let match;
  
  // Reset regex state
  GITHUB_PR_PATTERN.lastIndex = 0;
  
  while ((match = GITHUB_PR_PATTERN.exec(text)) !== null) {
    results.push({
      owner: match[1],
      repo: match[2],
      number: parseInt(match[3], 10),
      url: match[0],
    });
  }
  
  return results;
}

// ============================================================================
// GitHub API Utilities
// ============================================================================

/**
 * Analyze issue comments to determine if waiting for user closure confirmation
 * Uses LLM to understand context from comment embeddings
 * Caches results in database to avoid repeated LLM calls
 */
async function analyzeCommentsForClosureConfirmation(
  issueNumber: number,
  prisma: PrismaClient
): Promise<{ waitingForConfirmation: boolean; reason: string }> {
  try {
    // Get issue with comments and cached analysis from database
    const issue = await prisma.gitHubIssue.findUnique({
      where: { issueNumber },
      select: {
        issueTitle: true,
        issueBody: true,
        issueComments: true,
        waitingForClosureConfirmation: true,
        closureConfirmationReason: true,
        commentsAnalyzedAt: true,
        commentCountAtAnalysis: true,
        issueUpdatedAt: true,
      },
    });

    if (!issue) {
      return { waitingForConfirmation: false, reason: "Issue not found in database" };
    }

    // Parse comments from JSON
    interface IssueComment {
      body?: string;
      user?: { login?: string };
      created_at?: string;
    }

    const comments = Array.isArray(issue.issueComments)
      ? (issue.issueComments as unknown[]).map((c: unknown) => c as IssueComment)
      : [];

    if (comments.length === 0) {
      return { waitingForConfirmation: false, reason: "No comments found" };
    }

    // Check if we have a cached analysis that's still valid
    // Re-analyze ONLY if:
    // 1. No cached analysis exists, OR
    // 2. Number of comments increased (new comments were added)
    const currentCommentCount = comments.length;
    const previousCommentCount = issue.commentCountAtAnalysis ?? 0;
    
    // Only re-analyze if comment count increased (new comments added)
    const hasNewComments = currentCommentCount > previousCommentCount;
    const needsReanalysis = 
      issue.waitingForClosureConfirmation === null ||
      !issue.commentsAnalyzedAt ||
      hasNewComments;

    if (!needsReanalysis && issue.waitingForClosureConfirmation !== null) {
      // Use cached result
      log(`[Sync] Using cached comment analysis for issue #${issueNumber}: ${issue.waitingForClosureConfirmation ? "waiting" : "not waiting"}`);
      return {
        waitingForConfirmation: issue.waitingForClosureConfirmation,
        reason: issue.closureConfirmationReason || "Cached analysis",
      };
    }

    // Need to analyze - build context from issue and comments
    const issueText = `${issue.issueTitle}\n\n${issue.issueBody || ""}`;
    const commentsText = comments
      .map((c, idx) => `Comment ${idx + 1} by ${c.user?.login || "unknown"}:\n${c.body || ""}`)
      .join("\n\n---\n\n");

    const fullContext = `Issue:\n${issueText}\n\nComments:\n${commentsText}`;

    // Use LLM to analyze if waiting for closure confirmation
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
      log("[Sync] OPENAI_API_KEY not set, skipping comment analysis");
      return { waitingForConfirmation: false, reason: "OpenAI API key not configured" };
    }

    log(`[Sync] Analyzing comments for issue #${issueNumber} using LLM...`);

    const response = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        messages: [
          {
            role: "system",
            content: `You are analyzing GitHub issue comments to determine if the issue owner/maintainer is waiting for the user/contributor to confirm that the issue is resolved before closing it.

Look for patterns like:
- "waiting for closure confirmation"
- "waiting for you to close"
- "please confirm if this is resolved"
- "let me know if this fixes it"
- "can you verify this works"
- "please test and confirm"
- PR is merged but issue owner is waiting for user to confirm resolution
- Issue owner asking user to close the issue after testing

Return JSON: {"waiting": true/false, "reason": "brief explanation"}`,
          },
          {
            role: "user",
            content: fullContext,
          },
        ],
        response_format: { type: "json_object" },
        temperature: 0.3,
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      logError(`[Sync] OpenAI API error: ${response.status} ${errorText}`);
      return { waitingForConfirmation: false, reason: `API error: ${response.status}` };
    }

    const result = await response.json() as {
      choices?: Array<{ message?: { content?: string } }>;
    };

    const content = result.choices?.[0]?.message?.content;
    if (!content) {
      return { waitingForConfirmation: false, reason: "No response from LLM" };
    }

    try {
      const analysis = JSON.parse(content) as { waiting?: boolean; reason?: string };
      const waitingForConfirmation = analysis.waiting === true;
      const reason = analysis.reason || "Analyzed comments";

      // Cache the result in database, including comment count
      await prisma.gitHubIssue.update({
        where: { issueNumber },
        data: {
          waitingForClosureConfirmation: waitingForConfirmation,
          closureConfirmationReason: reason,
          commentsAnalyzedAt: new Date(),
          commentCountAtAnalysis: currentCommentCount, // Store comment count for comparison
        },
      });

      log(`[Sync] Cached comment analysis for issue #${issueNumber}: ${waitingForConfirmation ? "waiting" : "not waiting"}`);

      return {
        waitingForConfirmation,
        reason,
      };
    } catch (parseError) {
      logError(`[Sync] Failed to parse LLM response: ${content}`, parseError);
      return { waitingForConfirmation: false, reason: "Failed to parse LLM response" };
    }
  } catch (error) {
    logError(`[Sync] Error analyzing comments for issue #${issueNumber}:`, error);
    return { waitingForConfirmation: false, reason: error instanceof Error ? error.message : String(error) };
  }
}


// ============================================================================
// Linear API Utilities
// ============================================================================

async function checkAndUnarchiveIssue(
  linearId: string,
  linearConfig: LinearConfig,
  linear: LinearIntegration
): Promise<boolean> {
  try {
    const checkQuery = `
      query CheckIssueArchived($id: String!) {
        issue(id: $id) {
          id
          archivedAt
          project { id }
          cycle { id }
        }
      }
    `;
    
    const checkResponse = await fetch(linearConfig.apiUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: linearConfig.apiKey,
      },
      body: JSON.stringify({ 
        query: checkQuery,
        variables: { id: linearId }
      }),
    });
    
    const checkData = await checkResponse.json() as { data?: { issue?: { archivedAt?: string; project?: { id: string }; cycle?: { id: string } } } };
    const issue = checkData.data?.issue;
    
    if (!issue?.archivedAt) {
      return false; // Not archived, nothing to do
    }
    
    // Remove problematic project/cycle before unarchiving
    // Note: We need to use GraphQL directly since updateIssue doesn't support projectId/cycleId
    if (issue.project || issue.cycle) {
      try {
        const updateQuery = `
          mutation UpdateIssue($id: String!, $input: IssueUpdateInput!) {
            issueUpdate(id: $id, input: $input) {
              success
            }
          }
        `;
        
        const updateInput: { projectId?: string | null; cycleId?: string | null } = {};
        if (issue.project) updateInput.projectId = null;
        if (issue.cycle) updateInput.cycleId = null;
        
        const response = await fetch(linearConfig.apiUrl, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: linearConfig.apiKey,
          },
          body: JSON.stringify({
            query: updateQuery,
            variables: { id: linearId, input: updateInput },
          }),
        });
        
        const data = await response.json() as { data?: { issueUpdate?: { success?: boolean } } };
        if (!data.data?.issueUpdate?.success) {
          log(`[Sync] Warning: Could not remove project/cycle from ${linearId}`);
        }
      } catch (e) {
        log(`[Sync] Warning: Could not remove project/cycle from ${linearId}`);
      }
    }
    
    // Unarchive the issue
    const unarchiveQuery = `
      mutation UnarchiveIssue($id: String!) {
        issueUnarchive(id: $id) {
          success
        }
      }
    `;
    
    const response = await fetch(linearConfig.apiUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: linearConfig.apiKey,
      },
      body: JSON.stringify({ 
        query: unarchiveQuery,
        variables: { id: linearId }
      }),
    });
    
    const data = await response.json() as { data?: { issueUnarchive?: { success?: boolean } } };
    return data.data?.issueUnarchive?.success === true;
  } catch (error) {
    logError(`[Sync] Error checking/unarchiving issue ${linearId}:`, error);
    return false;
  }
}

// ============================================================================
// Batch Processing Utilities
// ============================================================================

async function processInBatches<T, R>(
  items: T[],
  processor: (item: T) => Promise<R>,
  concurrencyLimit: number = CONCURRENCY_LIMIT
): Promise<R[]> {
  const results: R[] = [];
  
  for (let i = 0; i < items.length; i += concurrencyLimit) {
    const batch = items.slice(i, i + concurrencyLimit);
    const batchResults = await Promise.all(batch.map(processor));
    results.push(...batchResults);
  }
  
  return results;
}

// ============================================================================
// Sync Logic - Separated into focused functions
// ============================================================================

async function unarchiveExportedIssues(
  deps: SyncDependencies
): Promise<number> {
  const { prisma, linear, linearConfig } = deps;
  
  log(`[Sync] Checking for archived exported issues...`);
  
  const [exportedIssues, exportedGroups] = await Promise.all([
    prisma.gitHubIssue.findMany({
      where: { linearIssueId: { not: null } },
      select: { linearIssueId: true },
    }),
    prisma.group.findMany({
      where: { linearIssueId: { not: null } },
      select: { linearIssueId: true },
    }),
  ]);
  
  const allExportedIds = [
    ...exportedIssues.map(i => i.linearIssueId).filter((id): id is string => id !== null),
    ...exportedGroups.map(g => g.linearIssueId).filter((id): id is string => id !== null),
  ];
  
  if (allExportedIds.length === 0) {
    return 0;
  }
  
  // Process in batches to avoid rate limits
  const results = await processInBatches(
    allExportedIds,
    (id) => checkAndUnarchiveIssue(id, linearConfig, linear),
    CONCURRENCY_LIMIT
  );
  
  const unarchivedCount = results.filter(Boolean).length;
  
  if (unarchivedCount > 0) {
    log(`[Sync] Unarchived ${unarchivedCount} exported issues`);
  }
  
  return unarchivedCount;
}

async function getIssueStatesFromDB(
  issueNumbers: number[],
  dbIssues: Array<{ issueNumber: number; issueState: string | null }>,
  prisma: PrismaClient
): Promise<Array<{ number: number; state: string }>> {
  const issueStates: Array<{ number: number; state: string }> = [];
  
  for (const issueNumber of issueNumbers) {
    // First check the already-fetched DB issues
    const dbIssue = dbIssues.find(i => i.issueNumber === issueNumber);
    if (dbIssue) {
      issueStates.push({
        number: issueNumber,
        state: dbIssue.issueState || ISSUE_STATES.UNKNOWN,
      });
      continue;
    }
    
    // Check DB for issues from URL extraction
    const cachedIssue = await prisma.gitHubIssue.findUnique({
      where: { issueNumber },
      select: { issueState: true },
    });
    
    issueStates.push({
      number: issueNumber,
      state: cachedIssue?.issueState || ISSUE_STATES.UNKNOWN,
    });
  }
  
  return issueStates;
}

/**
 * Fetch PR details and save to database (reusing logic from prBasedSync)
 */
async function fetchAndSavePR(
  owner: string,
  repo: string,
  prNumber: number,
  tokenManager: GitHubTokenManager,
  prisma: PrismaClient,
  linkedIssueNumbers: number[]
): Promise<{ url: string; merged: boolean } | null> {
  try {
    const token = await tokenManager.getCurrentToken();
    const response = await fetch(
      `https://api.github.com/repos/${owner}/${repo}/pulls/${prNumber}`,
      {
        headers: {
          Accept: "application/vnd.github.v3+json",
          Authorization: `Bearer ${token}`,
        },
      }
    );
    
    tokenManager.updateRateLimitFromResponse(response, token);
    
    if (!response.ok) {
      if (response.status === 404) {
        return null;
      }
      return null;
    }
    
    const pr = await response.json() as GitHubPR;
    
    // Save/update PR in database using shared function from prBasedSync
    await savePRsToDatabase([pr], prisma, linkedIssueNumbers);
    
    return { url: pr.html_url, merged: pr.merged };
  } catch (error) {
    logError(`Failed to fetch PR #${prNumber}:`, error);
    return null;
  }
}

/**
 * Sync PRs from URLs and save to database (reusing logic from prBasedSync)
 */
async function syncAndCheckPRStates(
  prUrls: GitHubPRUrl[],
  tokenManager: GitHubTokenManager | null,
  prisma: PrismaClient,
  linkedIssueNumbers: number[]
): Promise<Array<{ url: string; merged: boolean }>> {
  if (prUrls.length === 0 || !tokenManager) {
    return [];
  }
  
  return processInBatches(
    prUrls,
    async (prUrl) => {
      const result = await fetchAndSavePR(
        prUrl.owner,
        prUrl.repo,
        prUrl.number,
        tokenManager,
        prisma,
        linkedIssueNumbers
      );
      
      if (!result) {
        return { url: prUrl.url, merged: false };
      }
      
      return result;
    },
    CONCURRENCY_LIMIT
  );
}

function shouldMarkDone(
  issueStates: Array<{ number: number; state: string }>,
  prStates: Array<{ url: string; merged: boolean }>
): { shouldMark: boolean; reason: string; mergedPRsWithOpenIssues: boolean } {
  const hasIssues = issueStates.length > 0;
  const allIssuesClosed = hasIssues && issueStates.every(i => i.state === ISSUE_STATES.CLOSED);
  
  const hasPRs = prStates.length > 0;
  const anyPRMerged = hasPRs && prStates.some(p => p.merged);
  const hasOpenIssues = hasIssues && issueStates.some(i => i.state === ISSUE_STATES.OPEN);
  
  // Special case: PR merged but issue still open - need to check comments
  const mergedPRsWithOpenIssues = anyPRMerged && hasOpenIssues && !allIssuesClosed;
  
  if (allIssuesClosed && anyPRMerged) {
    return {
      shouldMark: true,
      reason: `All ${issueStates.length} issues closed AND ${prStates.filter(p => p.merged).length} PR(s) merged`,
      mergedPRsWithOpenIssues: false,
    };
  }
  
  if (allIssuesClosed) {
    return {
      shouldMark: true,
      reason: `All ${issueStates.length} GitHub issue(s) closed`,
      mergedPRsWithOpenIssues: false,
    };
  }
  
  // If PR is merged but issue is still open, don't mark as done yet - check comments first
  if (anyPRMerged && !allIssuesClosed) {
    return {
      shouldMark: false,
      reason: `${prStates.filter(p => p.merged).length} PR(s) merged but ${issueStates.filter(i => i.state === ISSUE_STATES.OPEN).length} issue(s) still open - checking comments`,
      mergedPRsWithOpenIssues: true,
    };
  }
  
  // Not ready - build reason
  const reasons: string[] = [];
  if (hasIssues) {
    const openCount = issueStates.filter(i => i.state !== ISSUE_STATES.CLOSED).length;
    reasons.push(`${openCount}/${issueStates.length} issues still open`);
  }
  if (hasPRs && !anyPRMerged) {
    reasons.push(`0/${prStates.length} PRs merged`);
  }
  
  return {
    shouldMark: false,
    reason: reasons.join(", ") || "No closed issues or merged PRs",
    mergedPRsWithOpenIssues: false,
  };
}

async function processTicket(
  ticket: { id: string; identifier: string; title?: string; description?: string },
  deps: SyncDependencies,
  doneStateId: string,
  reviewStateId: string | null,
  dryRun: boolean
): Promise<SyncDetail> {
  const { prisma, linear, linearConfig, config, tokenManager } = deps;
    const identifier = ticket.identifier;
    
    try {
      const description = ticket.description || "";
      const title = ticket.title || "";
      const fullText = `${title}\n${description}`;
      
    // Find connected GitHub issues from DB
      const dbIssues = await prisma.gitHubIssue.findMany({
        where: { linearIssueId: ticket.id },
        select: {
          issueNumber: true,
          issueState: true,
          issueTitle: true,
        },
      });
      
    // Extract URLs from Linear description (fallback for PRs not in DB yet)
      const issueUrls = extractGitHubIssueUrls(fullText);
      const prUrls = extractGitHubPRUrls(fullText);
      
      // Combine issue numbers (dedupe)
      const allIssueNumbers = new Set<number>();
      dbIssues.forEach(i => allIssueNumbers.add(i.issueNumber));
      
    // Add issues from URLs (only if from configured repo)
      for (const issueUrl of issueUrls) {
        if (issueUrl.owner === config.github.owner && issueUrl.repo === config.github.repo) {
          allIssueNumbers.add(issueUrl.number);
        }
      }
      
    // Get PRs from database - find PRs linked to the GitHub issues (not directly to Linear)
      const dbPRs = await prisma.gitHubPullRequest.findMany({
        where: {
          linkedIssues: {
            some: {
              issueNumber: { in: Array.from(allIssueNumbers) },
            },
          },
        },
        select: {
          prNumber: true,
          prUrl: true,
          prState: true,
          prMerged: true,
          prAuthor: true, // Need author for assignee mapping
        },
      });
      
    // Skip if no connections
      if (allIssueNumbers.size === 0 && dbPRs.length === 0 && prUrls.length === 0) {
      return {
          linearIdentifier: identifier,
        action: SYNC_ACTIONS.SKIPPED,
          reason: "No GitHub issues or PRs linked",
          githubIssues: [],
          prs: [],
      };
    }
    
    // Get issue states
    const issueStates = await getIssueStatesFromDB(Array.from(allIssueNumbers), dbIssues, prisma);
    
    // Note: PR-based sync (setting to In Progress and assignment) is handled by sync_pr_based_status
    // This sync only handles marking issues as Done when all issues are closed or PRs are merged
    
    // Combine PR states from DB and URLs (prefer DB, fallback to URL parsing)
    // Note: PRs from URLs will be fetched and saved to DB, updating their merged status
    const prStatesFromDB = dbPRs.map(pr => ({
      url: pr.prUrl,
      merged: pr.prMerged,
    }));
    
    // Only check PRs from URLs if not already in DB
    // This will fetch PR details and save to DB, updating merged status if changed
    const prUrlsToCheck = prUrls.filter(prUrl => 
      !dbPRs.some(dbPR => dbPR.prUrl === prUrl.url)
    );
    const prStatesFromUrls = await syncAndCheckPRStates(
      prUrlsToCheck,
      tokenManager,
      prisma,
      Array.from(allIssueNumbers)
    );
    
    const prStates = [...prStatesFromDB, ...prStatesFromUrls];
    
    // Determine action
    const decision = shouldMarkDone(issueStates, prStates);
    
    // Special handling: PR merged but issue still open - check comments
    if (decision.mergedPRsWithOpenIssues && reviewStateId) {
      const openIssueNumbers = issueStates
        .filter(i => i.state === ISSUE_STATES.OPEN)
        .map(i => i.number);
      
      if (openIssueNumbers.length > 0) {
        // Check comments for the first open issue (or all if needed)
        const analysis = await analyzeCommentsForClosureConfirmation(openIssueNumbers[0], prisma);
        
        if (analysis.waitingForConfirmation) {
          // Set to Review status
          if (!dryRun) {
            await linear.updateIssueStateAndAssignee(
              ticket.id,
              reviewStateId,
              undefined
            );
            
            log(`[Sync] ${identifier}: -> Review (PR merged, waiting for user confirmation: ${analysis.reason})`);
          }
          
          return {
            linearIdentifier: identifier,
            action: SYNC_ACTIONS.MARKED_REVIEW,
            reason: dryRun 
              ? `[DRY RUN] PR merged, waiting for closure confirmation: ${analysis.reason}`
              : `PR merged, waiting for closure confirmation: ${analysis.reason}`,
            githubIssues: issueStates,
            prs: prStates,
          };
        }
      }
    }
    
    if (decision.shouldMark) {
      if (!dryRun) {
        // Update state to Done (no assignment - that's handled by PR-based sync)
        await linear.updateIssueStateAndAssignee(
          ticket.id,
          doneStateId,
          undefined
        );
        
        // Update DB records
        await prisma.gitHubIssue.updateMany({
          where: { issueNumber: { in: dbIssues.map(i => i.issueNumber) } },
              data: {
            linearStatus: LINEAR_STATUS.DONE,
                linearStatusSyncedAt: new Date(),
              },
            });
          }
      
      log(`[Sync] ${dryRun ? "[DRY RUN] " : ""}${identifier}: -> Done (${decision.reason})`);
        
      return {
          linearIdentifier: identifier,
        action: SYNC_ACTIONS.MARKED_DONE,
        reason: dryRun ? `[DRY RUN] ${decision.reason}` : decision.reason,
          githubIssues: issueStates,
          prs: prStates,
      };
    }
    
    return {
          linearIdentifier: identifier,
      action: SYNC_ACTIONS.UNCHANGED,
      reason: decision.reason,
          githubIssues: issueStates,
          prs: prStates,
    };
      
    } catch (error) {
      logError(`[Sync] Error processing ${identifier}:`, error);
    return {
        linearIdentifier: identifier,
      action: SYNC_ACTIONS.ERROR,
        reason: error instanceof Error ? error.message : String(error),
        githubIssues: [],
        prs: [],
    };
  }
}

// ============================================================================
// Main Entry Point
// ============================================================================

export async function syncLinearStatus(options: SyncOptions = {}): Promise<SyncSummary> {
  const { dryRun = false } = options;
  
  const config = getConfig();
  const prisma = new PrismaClient();
  
  try {
    // Validate configuration
    const linearConfig: LinearConfig = {
      apiKey: process.env.PM_TOOL_API_KEY || "",
      teamId: process.env.PM_TOOL_TEAM_ID || "",
      apiUrl: "https://api.linear.app/graphql",
    };
    
    if (!linearConfig.apiKey) {
      throw new Error("PM_TOOL_API_KEY is required for Linear sync");
    }
    
    const linear = new LinearIntegration({
      type: "linear",
      api_key: linearConfig.apiKey,
      team_id: linearConfig.teamId,
      api_url: linearConfig.apiUrl,
    });
    
    // Get workflow states
    const workflowStates = await linear.getWorkflowStates(linearConfig.teamId);
    const doneState = workflowStates.find(
      s => s.type === "completed" || s.name.toLowerCase() === "done"
    );
    
    if (!doneState) {
      throw new Error("Could not find 'Done' workflow state in Linear");
    }
    
    // Find Review state (common names: "Review", "In Review", "Reviewing")
    const reviewState = workflowStates.find(
      s => s.name.toLowerCase().includes("review") || s.name.toLowerCase() === "review"
    );
    
    log(`[Sync] Found Done state: ${doneState.name} (${doneState.id})`);
    if (reviewState) {
      log(`[Sync] Found Review state: ${reviewState.name} (${reviewState.id})`);
    } else {
      log(`[Sync] Warning: No Review state found. Review status updates will be skipped.`);
    }
    
    // Initialize token manager lazily
    const tokenManager = await GitHubTokenManager.fromEnvironment();
    
    // Build dependencies
    const deps: SyncDependencies = {
      prisma,
      linear,
      linearConfig,
      tokenManager,
      config,
    };
    
    // Step 1: Unarchive any exported issues that got archived
    const unarchivedCount = await unarchiveExportedIssues(deps);
    
    // Step 2: Get all open Linear tickets
    log(`[Sync] Fetching open Linear tickets...`);
    const openLinearTickets = await linear.getOpenIssues(linearConfig.teamId);
    log(`[Sync] Found ${openLinearTickets.length} open Linear tickets`);
    
    // Step 3: Process each ticket
    const details: SyncDetail[] = [];
    
    for (const ticket of openLinearTickets) {
      const result = await processTicket(ticket, deps, doneState.id, reviewState?.id || null, dryRun);
      details.push(result);
    }
    
    // Build summary
    const summary: SyncSummary = {
      totalLinearTickets: openLinearTickets.length,
      synced: details.filter(d => d.action === SYNC_ACTIONS.MARKED_DONE || d.action === SYNC_ACTIONS.MARKED_REVIEW).length,
      markedDone: details.filter(d => d.action === SYNC_ACTIONS.MARKED_DONE).length,
      markedReview: details.filter(d => d.action === SYNC_ACTIONS.MARKED_REVIEW).length,
      skippedNoLinks: details.filter(d => d.action === SYNC_ACTIONS.SKIPPED).length,
      unchanged: details.filter(d => d.action === SYNC_ACTIONS.UNCHANGED).length,
      errors: details.filter(d => d.action === SYNC_ACTIONS.ERROR).length,
      unarchivedCount,
      details,
    };
  
  log(`[Sync] Complete: ${summary.markedDone} marked done, ${summary.markedReview} marked review, ${summary.unchanged} unchanged, ${summary.skippedNoLinks} skipped (no links), ${summary.errors} errors`);
  
  return summary;
    
  } finally {
    await prisma.$disconnect();
  }
}
