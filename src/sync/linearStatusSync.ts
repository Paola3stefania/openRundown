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

// Sync summary
export interface SyncSummary {
  totalLinearTickets: number;
  synced: number;
  markedDone: number;
  skippedNoLinks: number;
  unchanged: number;
  errors: number;
  details: Array<{
    linearIdentifier: string;
    action: "marked_done" | "unchanged" | "skipped" | "error";
    reason: string;
    githubIssues: Array<{ number: number; state: string }>;
    prs: Array<{ url: string; merged: boolean }>;
  }>;
}

/**
 * Extract GitHub issue URLs from text
 * Matches: https://github.com/owner/repo/issues/123
 */
function extractGitHubIssueUrls(text: string): Array<{ owner: string; repo: string; number: number }> {
  const pattern = /https:\/\/github\.com\/([^\/]+)\/([^\/]+)\/issues\/(\d+)/g;
  const results: Array<{ owner: string; repo: string; number: number }> = [];
  let match;
  
  while ((match = pattern.exec(text)) !== null) {
    results.push({
      owner: match[1],
      repo: match[2],
      number: parseInt(match[3], 10),
    });
  }
  
  return results;
}

/**
 * Extract GitHub PR URLs from text
 * Matches: https://github.com/owner/repo/pull/123
 */
function extractGitHubPRUrls(text: string): Array<{ owner: string; repo: string; number: number; url: string }> {
  const pattern = /https:\/\/github\.com\/([^\/]+)\/([^\/]+)\/pull\/(\d+)/g;
  const results: Array<{ owner: string; repo: string; number: number; url: string }> = [];
  let match;
  
  while ((match = pattern.exec(text)) !== null) {
    results.push({
      owner: match[1],
      repo: match[2],
      number: parseInt(match[3], 10),
      url: match[0],
    });
  }
  
  return results;
}

/**
 * Check if a GitHub PR is merged
 */
async function checkPRMerged(
  owner: string,
  repo: string,
  prNumber: number,
  tokenManager: GitHubTokenManager
): Promise<{ merged: boolean; state: string }> {
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
        return { merged: false, state: "not_found" };
      }
      return { merged: false, state: "error" };
    }
    
    const pr = await response.json() as { merged: boolean; state: string };
    return { merged: pr.merged, state: pr.state };
  } catch (error) {
    logError(`Failed to check PR #${prNumber}:`, error);
    return { merged: false, state: "error" };
  }
}

/**
 * Main sync function
 * 
 * Starts from Linear tickets (not from GitHub issues)
 * 1. Get all open Linear tickets
 * 2. For each, check connected GitHub issues/PRs
 * 3. Mark Done if all issues closed OR any PR merged
 */
export async function syncLinearStatus(options: {
  dryRun?: boolean;
  force?: boolean;
}): Promise<SyncSummary> {
  const { dryRun = false } = options;
  
  const config = getConfig();
  const prisma = new PrismaClient();
  
  // Initialize Linear client
  const linearConfig = {
    type: "linear" as const,
    api_key: process.env.PM_TOOL_API_KEY || "",
    team_id: process.env.PM_TOOL_TEAM_ID || "",
    api_url: "https://api.linear.app/graphql",
  };
  
  if (!linearConfig.api_key) {
    throw new Error("PM_TOOL_API_KEY is required for Linear sync");
  }
  
  const linear = new LinearIntegration(linearConfig);
  
  // Get workflow states
  const workflowStates = await linear.getWorkflowStates(linearConfig.team_id);
  const doneState = workflowStates.find(s => s.type === "completed" || s.name.toLowerCase() === "done");
  
  if (!doneState) {
    throw new Error("Could not find 'Done' workflow state in Linear");
  }
  
  log(`[Sync] Found Done state: ${doneState.name} (${doneState.id})`);
  
  // Get all OPEN Linear tickets (not done/canceled)
  // Uses pagination to fetch all issues
  log(`[Sync] Fetching open Linear tickets...`);
  const openLinearTickets = await linear.getOpenIssues(linearConfig.team_id);
  log(`[Sync] Found ${openLinearTickets.length} open Linear tickets`);
  
  const summary: SyncSummary = {
    totalLinearTickets: openLinearTickets.length,
    synced: 0,
    markedDone: 0,
    skippedNoLinks: 0,
    unchanged: 0,
    errors: 0,
    details: [],
  };
  
  // Initialize token manager for GitHub API calls (lazy - only when needed)
  let tokenManager: GitHubTokenManager | null = null;
  
  const getTokenManager = async (): Promise<GitHubTokenManager | null> => {
    if (!tokenManager) {
      tokenManager = await GitHubTokenManager.fromEnvironment();
    }
    return tokenManager;
  };
  
  // Process each open Linear ticket
  for (const ticket of openLinearTickets) {
    const identifier = ticket.identifier;
    
    try {
      const description = ticket.description || "";
      const title = ticket.title || "";
      const fullText = `${title}\n${description}`;
      
      // Find connected GitHub issues
      // 1. From our database (issues exported with this linearIssueId)
      const dbIssues = await prisma.gitHubIssue.findMany({
        where: { linearIssueId: ticket.id },
        select: {
          issueNumber: true,
          issueState: true,
          issueTitle: true,
        },
      });
      
      // 2. From URLs in Linear description
      const issueUrls = extractGitHubIssueUrls(fullText);
      const prUrls = extractGitHubPRUrls(fullText);
      
      // Combine issue numbers (dedupe)
      const allIssueNumbers = new Set<number>();
      dbIssues.forEach(i => allIssueNumbers.add(i.issueNumber));
      
      // Add issues from URLs (only if from same repo)
      for (const issueUrl of issueUrls) {
        if (issueUrl.owner === config.github.owner && issueUrl.repo === config.github.repo) {
          allIssueNumbers.add(issueUrl.number);
        }
      }
      
      // Skip if no GitHub issues or PRs connected
      if (allIssueNumbers.size === 0 && prUrls.length === 0) {
        summary.skippedNoLinks++;
        summary.details.push({
          linearIdentifier: identifier,
          action: "skipped",
          reason: "No GitHub issues or PRs linked",
          githubIssues: [],
          prs: [],
        });
        continue;
      }
      
      // Check GitHub issue states (from cached DB data)
      const issueStates: Array<{ number: number; state: string }> = [];
      
      for (const issueNumber of allIssueNumbers) {
        // First check our DB cache
        const dbIssue = dbIssues.find(i => i.issueNumber === issueNumber);
        if (dbIssue) {
          issueStates.push({
            number: issueNumber,
            state: dbIssue.issueState || "unknown",
          });
        } else {
          // Check DB for issues not in the dbIssues result (from URL extraction)
          const cachedIssue = await prisma.gitHubIssue.findUnique({
            where: { issueNumber },
            select: { issueState: true },
          });
          
          if (cachedIssue) {
            issueStates.push({
              number: issueNumber,
              state: cachedIssue.issueState || "unknown",
            });
          } else {
            // Issue not in our DB - mark as unknown
            issueStates.push({
              number: issueNumber,
              state: "unknown",
            });
          }
        }
      }
      
      // Check PR states (only if we have PRs to check)
      const prStates: Array<{ url: string; merged: boolean }> = [];
      
      if (prUrls.length > 0) {
        const tm = await getTokenManager();
        if (tm) {
          for (const pr of prUrls) {
            const prStatus = await checkPRMerged(pr.owner, pr.repo, pr.number, tm);
            prStates.push({
              url: pr.url,
              merged: prStatus.merged,
            });
          }
        }
      }
      
      // Determine if ticket should be marked Done
      // Rule 1: ALL GitHub issues are closed
      const hasIssues = issueStates.length > 0;
      const allIssuesClosed = hasIssues && issueStates.every(i => i.state === "closed");
      
      // Rule 2: ANY PR is merged
      const hasPRs = prStates.length > 0;
      const anyPRMerged = hasPRs && prStates.some(p => p.merged);
      
      // Decision: mark Done if (all issues closed) OR (any PR merged)
      const shouldMarkDone = allIssuesClosed || anyPRMerged;
      
      if (shouldMarkDone) {
        let reason = "";
        if (allIssuesClosed && anyPRMerged) {
          reason = `All ${issueStates.length} issues closed AND ${prStates.filter(p => p.merged).length} PR(s) merged`;
        } else if (allIssuesClosed) {
          reason = `All ${issueStates.length} GitHub issue(s) closed`;
        } else if (anyPRMerged) {
          reason = `${prStates.filter(p => p.merged).length} PR(s) merged`;
        }
        
        if (!dryRun) {
          await linear.updateIssueState(ticket.id, doneState.id);
          
          // Update our DB records
          for (const issue of dbIssues) {
            await prisma.gitHubIssue.update({
              where: { issueNumber: issue.issueNumber },
              data: {
                linearStatus: "done",
                linearStatusSyncedAt: new Date(),
              },
            });
          }
        }
        
        summary.markedDone++;
        summary.synced++;
        summary.details.push({
          linearIdentifier: identifier,
          action: "marked_done",
          reason: dryRun ? `[DRY RUN] ${reason}` : reason,
          githubIssues: issueStates,
          prs: prStates,
        });
        
        log(`[Sync] ${dryRun ? "[DRY RUN] " : ""}${identifier}: -> Done (${reason})`);
      } else {
        // Not ready to mark done - build reason
        let reason = "";
        if (hasIssues) {
          const openCount = issueStates.filter(i => i.state !== "closed").length;
          reason = `${openCount}/${issueStates.length} issues still open`;
        }
        if (hasPRs && !anyPRMerged) {
          const prReason = `0/${prStates.length} PRs merged`;
          reason = reason ? `${reason}, ${prReason}` : prReason;
        }
        
        summary.unchanged++;
        summary.details.push({
          linearIdentifier: identifier,
          action: "unchanged",
          reason: reason || "No closed issues or merged PRs",
          githubIssues: issueStates,
          prs: prStates,
        });
      }
      
    } catch (error) {
      logError(`[Sync] Error processing ${identifier}:`, error);
      summary.errors++;
      summary.details.push({
        linearIdentifier: identifier,
        action: "error",
        reason: error instanceof Error ? error.message : String(error),
        githubIssues: [],
        prs: [],
      });
    }
  }
  
  await prisma.$disconnect();
  
  log(`[Sync] Complete: ${summary.markedDone} marked done, ${summary.unchanged} unchanged, ${summary.skippedNoLinks} skipped (no links), ${summary.errors} errors`);
  
  return summary;
}
