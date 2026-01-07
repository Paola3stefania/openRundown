/**
 * PR-based Linear Issue Sync
 * Syncs Linear issue status and assignee based on open PRs connected to GitHub issues
 * 
 * Logic:
 * 1. Get all GitHub issues that have Linear issues
 * 2. For each issue, check for open PRs using getPRsForIssue
 * 3. If open PR exists:
 *    - Set Linear issue status to "In Progress"
 *    - Assign Linear issue to mapped user (from GitHub username -> Linear user ID mapping)
 */

import { PrismaClient, Prisma } from "@prisma/client";
import { LinearIntegration } from "../export/linear/client.js";
import { log, logError } from "../mcp/logger.js";
import { getConfig } from "../config/index.js";
import { GitHubTokenManager } from "../connectors/github/tokenManager.js";
import { getPRsForIssue, GitHubPR } from "../connectors/github/client.js";
import { 
  getOrganizationEngineerEmails, 
  getOrganizationEngineerGitHubMap 
} from "./csvParser.js";

// ============================================================================
// Constants
// ============================================================================

const LINEAR_STATUS = {
  IN_PROGRESS: "in_progress",
  REVIEW: "review",
} as const;

const SYNC_ACTIONS = {
  UPDATED: "updated",
  UNCHANGED: "unchanged",
  SKIPPED: "skipped",
  ERROR: "error",
} as const;

const BATCH_SIZE = 10; // Process issues in batches
const CONCURRENCY_LIMIT = 5; // Max parallel API calls

// ============================================================================
// Types
// ============================================================================

export interface UserMapping {
  githubUsername: string; // GitHub username (from PR author) - must be an organization engineer
  linearUserId: string; // Linear user ID
}

export interface SyncSummary {
  totalIssues: number;
  updated: number;
  setToInProgress: number; // Issues set to In Progress (open PRs)
  setToReview: number; // Issues set to Review (merged PRs with open issues)
  unchanged: number;
  skipped: number;
  errors: number;
  details: SyncDetail[];
}

interface SyncDetail {
  issueNumber: number;
  linearIdentifier?: string;
  action: typeof SYNC_ACTIONS[keyof typeof SYNC_ACTIONS];
  reason: string;
  openPRs?: Array<{ number: number; url: string; author: string }>;
  mergedPRs?: Array<{ number: number; url: string; author: string }>;
}

interface LinearConfig {
  apiKey: string;
  teamId: string;
  apiUrl: string;
}

interface SyncOptions {
  dryRun?: boolean;
  userMappings?: UserMapping[]; // Organization engineer GitHub username -> Linear user ID mappings
  organizationEngineers?: string[]; // List of organization engineer GitHub usernames (optional, can also come from env)
  defaultAssigneeId?: string; // Default Linear user ID if no mapping found (optional)
}

interface SyncDependencies {
  prisma: PrismaClient;
  linear: LinearIntegration;
  linearConfig: LinearConfig;
  tokenManager: GitHubTokenManager | null;
  config: ReturnType<typeof getConfig>;
  userMappings: Map<string, string>; // GitHub username -> Linear user ID (only organization engineers)
  organizationEngineers: Set<string>; // Set of organization engineer GitHub usernames
  defaultAssigneeId?: string;
}

// ============================================================================
// User Mapping Utilities
// ============================================================================

/**
 * Parse organization engineer list from CSV, environment variable, or use provided list
 * Priority: 1) Provided list, 2) CSV file, 3) Environment variable
 */
export async function parseOrganizationEngineers(
  engineers?: string[],
  csvPath?: string
): Promise<Set<string>> {
  const set = new Set<string>();

  // 1. Use provided list if available
  if (engineers && engineers.length > 0) {
    for (const engineer of engineers) {
      set.add(engineer.toLowerCase().trim());
    }
    return set;
  }

  // 2. Try to load from CSV file
  if (csvPath || process.env.MEMBERS_CSV_PATH) {
    try {
      const githubMap = await getOrganizationEngineerGitHubMap(csvPath || process.env.MEMBERS_CSV_PATH);
      // Add all GitHub usernames from CSV
      for (const githubUsername of githubMap.values()) {
        set.add(githubUsername);
      }
      if (set.size > 0) {
        log(`[PR Sync] Loaded ${set.size} organization engineers from CSV`);
        return set;
      }
    } catch (error) {
      logError("[PR Sync] Failed to load engineers from CSV, falling back to env var:", error);
    }
  }

  // 3. Try to parse from environment variable
  const envEngineers = process.env.ORGANIZATION_ENGINEERS;
  if (envEngineers) {
    try {
      // Try JSON array first
      const parsed = JSON.parse(envEngineers);
      if (Array.isArray(parsed)) {
        for (const engineer of parsed) {
          set.add(String(engineer).toLowerCase().trim());
        }
      }
    } catch {
      // If JSON parse fails, try comma-separated string
      const engineersList = envEngineers.split(',').map(e => e.trim()).filter(Boolean);
      for (const engineer of engineersList) {
        set.add(engineer.toLowerCase().trim());
      }
    }
  }

  return set;
}

/**
 * Parse user mappings from CSV + Linear users, environment variable, or use provided mappings
 * Priority: 1) Provided mappings, 2) Auto-build from CSV + Linear, 3) Environment variable
 * 
 * Auto-build: Matches CSV emails to Linear users by email, then maps GitHub username -> Linear user ID
 */
export async function parseUserMappings(
  mappings?: UserMapping[],
  linear?: LinearIntegration,
  csvPath?: string
): Promise<Map<string, string>> {
  const map = new Map<string, string>();

  // 1. Use provided mappings if available
  if (mappings && mappings.length > 0) {
    for (const mapping of mappings) {
      map.set(mapping.githubUsername.toLowerCase(), mapping.linearUserId);
    }
    return map;
  }

  // 2. Try to auto-build from CSV + Linear users
  if (linear && (csvPath || process.env.MEMBERS_CSV_PATH)) {
    try {
      const githubMap = await getOrganizationEngineerGitHubMap(csvPath || process.env.MEMBERS_CSV_PATH);
      const organizationEmails = await getOrganizationEngineerEmails(csvPath || process.env.MEMBERS_CSV_PATH);
      const linearUsers = await linear.listUsers();

      // Build email -> Linear user ID map
      const emailToLinearId = new Map<string, string>();
      for (const linearUser of linearUsers) {
        if (linearUser.email) {
          emailToLinearId.set(linearUser.email.toLowerCase(), linearUser.id);
        }
      }

      // Build GitHub username -> Linear user ID map
      for (const email of organizationEmails) {
        const githubUsername = githubMap.get(email);
        const linearUserId = emailToLinearId.get(email);

        if (githubUsername && linearUserId) {
          map.set(githubUsername, linearUserId);
          log(`[PR Sync] Auto-mapped: ${githubUsername} (${email}) -> Linear user ${linearUserId}`);
        } else if (!githubUsername) {
          log(`[PR Sync] Warning: No GitHub username found for ${email} in CSV`);
        } else if (!linearUserId) {
          log(`[PR Sync] Warning: No Linear user found for email ${email}`);
        }
      }

      if (map.size > 0) {
        log(`[PR Sync] Auto-built ${map.size} user mappings from CSV + Linear`);
        return map;
      }
    } catch (error) {
      logError("[PR Sync] Failed to auto-build mappings from CSV, falling back to env var:", error);
    }
  }

  // 3. Try to parse from environment variable
  const envMappings = process.env.USER_MAPPINGS;
  if (envMappings) {
    try {
      const parsed = JSON.parse(envMappings) as UserMapping[];
      for (const mapping of parsed) {
        map.set(mapping.githubUsername.toLowerCase(), mapping.linearUserId);
      }
    } catch (error) {
      logError("Failed to parse USER_MAPPINGS environment variable:", error);
    }
  }

  return map;
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
// Sync Logic
// ============================================================================

/**
 * Find Linear user ID for a GitHub PR author
 * Only assigns if PR author is an organization engineer
 * Maps GitHub username (from PR author) to Linear user ID
 */
export function findLinearUserId(
  githubUsername: string,
  userMappings: Map<string, string>,
  organizationEngineers: Set<string>,
  defaultAssigneeId?: string
): string | null {
  const usernameLower = githubUsername.toLowerCase();

  // Only assign if PR author is an organization engineer
  if (!organizationEngineers.has(usernameLower)) {
    return null; // Not an organization engineer, don't assign
  }

  // Try direct match (case-insensitive)
  const mappedId = userMappings.get(usernameLower);
  if (mappedId) {
    return mappedId;
  }

  // If no mapping found but is organization engineer, use default if provided
  return defaultAssigneeId || null;
}

/**
 * Check for merged PRs and set Linear issue to Review status
 * Assigns to PR owner if they are an organization engineer
 */
async function checkAndSetReviewForMergedPRs(
  mergedPRs: GitHubPR[],
  linearIssueId: string,
  issueNumbers: number[],
  linear: LinearIntegration,
  reviewStateId: string,
  prisma: PrismaClient,
  userMappings: Map<string, string>,
  organizationEngineers: Set<string>,
  defaultAssigneeId: string | undefined,
  dryRun: boolean,
  identifier?: string
): Promise<{ updated: boolean; reason: string; prAuthor?: string; linearUserId?: string }> {
  // Filter to only merged PRs
  const mergedPRsFiltered = mergedPRs.filter(pr => pr.merged);
  
  if (mergedPRsFiltered.length === 0) {
    return { updated: false, reason: "No merged PRs found" };
  }

  // Save PRs to database
  await savePRsToDatabase(mergedPRsFiltered, prisma, issueNumbers);

  // Get PR author for assignment
  const prAuthor = mergedPRsFiltered[0].user.login;
  
  // Find Linear user ID for PR author
  const linearUserId = findLinearUserId(
    prAuthor,
    userMappings,
    organizationEngineers,
    defaultAssigneeId
  );

  if (!linearUserId) {
    return {
      updated: false,
      reason: `PR author ${prAuthor} is not an organization engineer or no mapping found`,
      prAuthor,
    };
  }

  // Check current state
  const currentIssue = await linear.getIssue(linearIssueId);
  const isAlreadyInReview = currentIssue?.stateId === reviewStateId;
  const isAlreadyAssigned = currentIssue?.assigneeId === linearUserId;

  if (isAlreadyInReview && isAlreadyAssigned) {
    // Update DB status
    if (!dryRun) {
      await prisma.gitHubIssue.updateMany({
        where: { issueNumber: { in: issueNumbers } },
        data: {
          linearStatus: LINEAR_STATUS.REVIEW,
          linearStatusSyncedAt: new Date(),
        },
      });
    }

    return {
      updated: false,
      reason: "Already in Review status and assigned",
      prAuthor,
      linearUserId,
    };
  }

  if (!dryRun) {
    // Set to Review and assign
    await linear.updateIssueStateAndAssignee(
      linearIssueId,
      reviewStateId,
      linearUserId
    );

    // Update DB
    await prisma.gitHubIssue.updateMany({
      where: { issueNumber: { in: issueNumbers } },
      data: {
        linearStatus: LINEAR_STATUS.REVIEW,
        linearStatusSyncedAt: new Date(),
      },
    });

    const logIdentifier = identifier || linearIssueId;
    log(`[PR Sync] ${logIdentifier}: Set to Review and assigned to user ${linearUserId} (merged PR by ${prAuthor})`);
  }

  return {
    updated: true,
    reason: dryRun
      ? `[DRY RUN] Would set to Review and assign to ${linearUserId} (merged PR by ${prAuthor})`
      : `Set to Review and assigned to user (merged PR by ${prAuthor})`,
    prAuthor,
    linearUserId,
  };
}

/**
 * Shared function: Check for open PRs and set Linear issue to In Progress
 * This logic is shared between linearStatusSync and prBasedSync
 * 
 * @returns true if open PRs were found and issue was updated, false otherwise
 */
export async function checkAndSetInProgressForOpenPRs(
  openPRs: GitHubPR[],
  linearIssueId: string,
  issueNumbers: number[],
  linear: LinearIntegration,
  inProgressStateId: string,
  prisma: PrismaClient,
  userMappings: Map<string, string>,
  organizationEngineers: Set<string>,
  defaultAssigneeId: string | undefined,
  dryRun: boolean,
  identifier?: string
): Promise<{ updated: boolean; reason: string; prAuthor?: string; linearUserId?: string }> {
  // Filter to only open, non-merged PRs
  const openPRsFiltered = openPRs.filter(pr => pr.state === "open" && !pr.merged);
  
  if (openPRsFiltered.length === 0) {
    return { updated: false, reason: "No open PRs found" };
  }

  // Save PRs to database
  await savePRsToDatabase(openPRsFiltered, prisma, issueNumbers);

  // Get PR author for assignment
  const prAuthor = openPRsFiltered[0].user.login;
  
  // Use shared assignment function
  const assignResult = await setLinearIssueInProgressAndAssign(
    linearIssueId,
    issueNumbers,
    prAuthor,
    linear,
    inProgressStateId,
    prisma,
    userMappings,
    organizationEngineers,
    defaultAssigneeId,
    dryRun,
    identifier
  );

  if (!assignResult.success) {
    return {
      updated: false,
      reason: assignResult.reason,
      prAuthor,
    };
  }

  // Only return updated=true if an actual update occurred
  return {
    updated: assignResult.updated,
    reason: assignResult.updated
      ? (dryRun
          ? `[DRY RUN] Found ${openPRsFiltered.length} open PR(s), would assign to ${assignResult.linearUserId}`
          : `Found ${openPRsFiltered.length} open PR(s), assigned to user`)
      : assignResult.reason,
    prAuthor,
    linearUserId: assignResult.linearUserId,
  };
}

/**
 * Shared function: Set Linear issue to In Progress and assign based on PR author
 * This is the core assignment logic shared between both syncs
 * Can be used with either GitHubPR objects or database PR records
 */
export async function setLinearIssueInProgressAndAssign(
  linearIssueId: string,
  issueNumbers: number[],
  prAuthor: string,
  linear: LinearIntegration,
  inProgressStateId: string,
  prisma: PrismaClient,
  userMappings: Map<string, string>,
  organizationEngineers: Set<string>,
  defaultAssigneeId: string | undefined,
  dryRun: boolean,
  identifier?: string
): Promise<{ success: boolean; updated: boolean; linearUserId?: string; reason: string }> {
  const linearUserId = findLinearUserId(
    prAuthor,
    userMappings,
    organizationEngineers,
    defaultAssigneeId
  );

  if (!linearUserId) {
    const isOrganizationEngineer = organizationEngineers.has(prAuthor.toLowerCase());
    return {
      success: false,
      updated: false,
      reason: isOrganizationEngineer
        ? `No user mapping found for organization engineer: ${prAuthor}`
        : `PR author ${prAuthor} is not an organization engineer`,
    };
  }

  // Check current Linear issue state and assignee before updating
  const currentIssue = await linear.getIssue(linearIssueId);
  if (currentIssue) {
    const isAlreadyInProgress = currentIssue.stateId === inProgressStateId;
    const isAlreadyAssigned = currentIssue.assigneeId === linearUserId;

    if (isAlreadyInProgress && isAlreadyAssigned) {
      // Already in correct state - no update needed
      const logIdentifier = identifier || linearIssueId;
      log(`[Sync] ${logIdentifier}: Already in In Progress state and assigned to ${linearUserId}, skipping update`);
      
      // Still update DB sync timestamp to indicate we checked it
      if (!dryRun) {
        await prisma.gitHubIssue.updateMany({
          where: { issueNumber: { in: issueNumbers } },
          data: {
            linearStatus: LINEAR_STATUS.IN_PROGRESS,
            linearStatusSyncedAt: new Date(),
          },
        });
      }

      return {
        success: true,
        updated: false,
        linearUserId,
        reason: "Already in correct state and assigned",
      };
    }
  }

  if (!dryRun) {
    // Set to In Progress and assign
    await linear.updateIssueStateAndAssignee(
      linearIssueId,
      inProgressStateId,
      linearUserId
    );

    // Update DB
    await prisma.gitHubIssue.updateMany({
      where: { issueNumber: { in: issueNumbers } },
      data: {
        linearStatus: LINEAR_STATUS.IN_PROGRESS,
        linearStatusSyncedAt: new Date(),
      },
    });

    const logIdentifier = identifier || linearIssueId;
    log(`[Sync] ${logIdentifier}: Set to In Progress and assigned to user ${linearUserId}`);
  }

  return {
    success: true,
    updated: true,
    linearUserId,
    reason: dryRun
      ? `[DRY RUN] Would assign to ${linearUserId}`
      : `Assigned to user`,
  };
}

/**
 * Save PRs to database (shared utility function)
 */
export async function savePRsToDatabase(
  prs: GitHubPR[],
  prisma: PrismaClient,
  linkedIssueNumbers: number[]
): Promise<void> {
  for (const pr of prs) {
    await prisma.gitHubPullRequest.upsert({
      where: { prUrl: pr.html_url },
      create: {
        prNumber: pr.number,
        prTitle: pr.title,
        prUrl: pr.html_url,
        prState: pr.state,
        prMerged: pr.merged,
        prAuthor: pr.user.login,
        prCreatedAt: new Date(pr.created_at),
        prUpdatedAt: new Date(pr.updated_at),
        prBody: pr.body || null,
        prHeadRef: pr.head.ref,
        prBaseRef: pr.base.ref,
        linkedIssues: {
          connect: linkedIssueNumbers.map(num => ({ issueNumber: num })),
        },
      },
      update: {
        prTitle: pr.title,
        prState: pr.state,
        prMerged: pr.merged,
        prUpdatedAt: new Date(pr.updated_at),
        prBody: pr.body || null,
        prHeadRef: pr.head.ref,
        prBaseRef: pr.base.ref,
        linkedIssues: {
          connect: linkedIssueNumbers.map(num => ({ issueNumber: num })),
        },
      },
    });
  }
}

/**
 * Fetch PRs linked to a specific issue using GitHub's REST API search
 * This catches PRs that reference the issue, even if merged
 */
async function fetchPRsForIssue(
  issueNumber: number,
  tokenManager: GitHubTokenManager,
  config: ReturnType<typeof getConfig>
): Promise<GitHubPR[]> {
  const repoOwner = config.github.owner;
  const repoName = config.github.repo;
  
  try {
    const token = await tokenManager.getCurrentToken();
    // Use GitHub's REST API to search for PRs that reference this issue
    // Search for PRs that mention the issue number (try multiple formats)
    // Also try searching for the issue number with different patterns
    const searchQueries = [
      `repo:${repoOwner}/${repoName} type:pr #${issueNumber}`,  // Standard format
      `repo:${repoOwner}/${repoName} type:pr ${issueNumber}`,   // Just the number
      `repo:${repoOwner}/${repoName} type:pr "issue ${issueNumber}"`, // Quoted
    ];
    
    // Try the first search query
    const searchQuery = searchQueries[0];
    const url = `https://api.github.com/search/issues?q=${encodeURIComponent(searchQuery)}&per_page=100`;
    
    const response = await fetch(url, {
      headers: {
        Accept: "application/vnd.github.v3+json",
        Authorization: `Bearer ${token}`,
      },
    });
    
    tokenManager.updateRateLimitFromResponse(response, token);
    
    if (!response.ok) {
      logError(`[PR Sync] Failed to search PRs for issue #${issueNumber}: ${response.status}`);
      return [];
    }
    
    const searchResult = await response.json() as {
      items?: Array<{
        number: number;
        pull_request?: { url: string };
      }>;
    };
    
    // Fetch full PR details for each PR found
    const prs: GitHubPR[] = [];
    
    if (!searchResult.items || searchResult.items.length === 0) {
      return [];
    }
    
    for (const item of searchResult.items) {
      if (!item.pull_request) continue;
      
      const prUrl = item.pull_request.url.replace('/pulls/', '/repos/').replace('/pulls/', '/pulls/');
      const prNumber = item.number;
      
      // Fetch full PR details
      const prResponse = await fetch(`https://api.github.com/repos/${repoOwner}/${repoName}/pulls/${prNumber}`, {
        headers: {
          Accept: "application/vnd.github.v3+json",
          Authorization: `Bearer ${token}`,
        },
      });
      
      tokenManager.updateRateLimitFromResponse(prResponse, token);
      
      if (prResponse.ok) {
        const pr = await prResponse.json() as GitHubPR;
        
        // Verify the PR actually references this issue (check for @PR format, # format, cross-repo format, and URLs)
        const title = pr.title || '';
        const body = pr.body || '';
        const fullText = `${title}\n${body}`;
        // Match @PR 92, @PR#92, @PR-92, closes #92, fixes #92, repo#92, GitHub URLs, or just #92
        const issueRefPattern = /(?:closes?|fixes?|resolves?|refs?)\s*(?:[\w-]+#)?(\d+)\b|(?:[\w-]+#)?(\d+)\b|@PR\s*[#-]?(\d+)\b|github\.com\/[\w-]+\/[\w-]+\/issues\/(\d+)/gi;
        const matches = [...fullText.matchAll(issueRefPattern)];
        
        let referencesIssue = false;
        for (const match of matches) {
          // Check all capture groups: 
          // match[1] for closes/fixes with optional repo# format
          // match[2] for standalone #123 or repo#123 format
          // match[3] for @PR format
          // match[4] for GitHub issue URLs
          const matchedNum = parseInt(match[1] || match[2] || match[3] || match[4] || '', 10);
          if (matchedNum === issueNumber) {
            referencesIssue = true;
            break;
          }
        }
        
        if (referencesIssue) {
          prs.push(pr);
        }
      }
    }
    
    return prs;
  } catch (error) {
    logError(`[PR Sync] Error fetching PRs for issue #${issueNumber}:`, error);
    return [];
  }
}

/**
 * Fetch recently merged PRs (last 30 days) to catch PRs that were merged but issues not yet closed
 * Extended to 90 days for better coverage
 */
async function fetchRecentlyMergedPRs(
  tokenManager: GitHubTokenManager,
  config: ReturnType<typeof getConfig>
): Promise<GitHubPR[]> {
  const repoOwner = config.github.owner;
  const repoName = config.github.repo;
  
  const allPRs: GitHubPR[] = [];
  let page = 1;
  let hasMore = true;
  
  // Calculate date 90 days ago (extended from 30)
  const ninetyDaysAgo = new Date();
  ninetyDaysAgo.setDate(ninetyDaysAgo.getDate() - 90);
  
  const getToken = async (tm: GitHubTokenManager) => await tm.getCurrentToken();
  const createHeaders = async (tm: GitHubTokenManager, specificToken?: string) => {
    const headers: Record<string, string> = {
      Accept: "application/vnd.github.v3+json",
    };
    const token = specificToken || await getToken(tm);
    if (token) {
      headers.Authorization = `Bearer ${token}`;
    }
    return headers;
  };
  const updateRateLimit = (response: Response, tm: GitHubTokenManager, token?: string) => {
    tm.updateRateLimitFromResponse(response, token);
  };
  
  while (hasMore && page <= 10) { // Limit to 10 pages (1000 PRs max)
    const pullsUrl = `https://api.github.com/repos/${repoOwner}/${repoName}/pulls?state=closed&per_page=100&page=${page}&sort=updated&direction=desc`;
    
    let headers = await createHeaders(tokenManager);
    let currentToken = await getToken(tokenManager);
    let response = await fetch(pullsUrl, { headers });
    
    if (response.ok && currentToken) {
      updateRateLimit(response, tokenManager, currentToken);
    }
    
    if (!response.ok) {
      if ((response.status === 403 || response.status === 429) && tokenManager instanceof GitHubTokenManager) {
        if (currentToken) {
          updateRateLimit(response, tokenManager, currentToken);
        }
        
        const nextToken = await tokenManager.getNextAvailableToken();
        if (nextToken) {
          headers = await createHeaders(tokenManager, nextToken);
          response = await fetch(pullsUrl, { headers });
          
          if (response.ok && nextToken) {
            updateRateLimit(response, tokenManager, nextToken);
          }
        }
      }
      
      if (!response.ok) {
        if (page === 1) {
          log(`[PR Sync] Failed to fetch merged PRs: ${response.status}`);
        }
        break;
      }
    }
    
    const pagePRs = await response.json() as GitHubPR[];
    
    if (pagePRs.length === 0) {
      hasMore = false;
      break;
    }
    
    // Filter to only merged PRs updated in last 90 days
    const recentMergedPRs = pagePRs.filter(pr => {
      if (!pr.merged) return false;
      const updatedAt = new Date(pr.updated_at);
      return updatedAt >= ninetyDaysAgo;
    });
    
    allPRs.push(...recentMergedPRs);
    
    // If we got PRs older than 90 days, we can stop
    if (pagePRs.some(pr => {
      const updatedAt = new Date(pr.updated_at);
      return updatedAt < ninetyDaysAgo;
    })) {
      hasMore = false;
      break;
    }
    
    if (pagePRs.length < 100) {
      hasMore = false;
    } else {
      page++;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  }
  
  return allPRs;
}

/**
 * Fetch all open PRs from the repository (optimized - fetch once for all issues)
 * Uses the same repository API pattern as fetchAllGitHubIssues
 */
export async function fetchAllOpenPRs(
  tokenManager: GitHubTokenManager,
  config: ReturnType<typeof getConfig>
): Promise<GitHubPR[]> {
  const repoOwner = config.github.owner;
  const repoName = config.github.repo;
  
  const allPRs: GitHubPR[] = [];
  let page = 1;
  let hasMore = true;
  
  // Use the same header/token management pattern as fetchAllGitHubIssues
  const getToken = async (tm: GitHubTokenManager) => await tm.getCurrentToken();
  const createHeaders = async (tm: GitHubTokenManager, specificToken?: string) => {
    const headers: Record<string, string> = {
      Accept: "application/vnd.github.v3+json",
    };
    const token = specificToken || await getToken(tm);
    if (token) {
      headers.Authorization = `Bearer ${token}`;
    }
    return headers;
  };
  const updateRateLimit = (response: Response, tm: GitHubTokenManager, token?: string) => {
    tm.updateRateLimitFromResponse(response, token);
  };
  
  while (hasMore) {
    const pullsUrl = `https://api.github.com/repos/${repoOwner}/${repoName}/pulls?state=open&per_page=100&page=${page}&sort=updated&direction=desc`;
    
    let headers = await createHeaders(tokenManager);
    let currentToken = await getToken(tokenManager);
    let response = await fetch(pullsUrl, { headers });
    
    if (response.ok && currentToken) {
      updateRateLimit(response, tokenManager, currentToken);
    }
    
    if (!response.ok) {
      if ((response.status === 403 || response.status === 429) && tokenManager instanceof GitHubTokenManager) {
        if (currentToken) {
          updateRateLimit(response, tokenManager, currentToken);
        }
        
        const nextToken = await tokenManager.getNextAvailableToken();
        if (nextToken) {
          headers = await createHeaders(tokenManager, nextToken);
          response = await fetch(pullsUrl, { headers });
          
          if (response.ok && nextToken) {
            updateRateLimit(response, tokenManager, nextToken);
          }
        }
      }
      
      if (!response.ok) {
        if (page === 1) {
          log(`[PR Sync] Failed to fetch open PRs: ${response.status}`);
        }
        break;
      }
    }
    
    const pagePRs = await response.json() as GitHubPR[];
    
    if (pagePRs.length === 0) {
      hasMore = false;
      break;
    }
    
    allPRs.push(...pagePRs);
    
    if (pagePRs.length < 100) {
      hasMore = false;
    } else {
      page++;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  }
  
  return allPRs;
}

async function processIssueWithPRs(
  issue: { issueNumber: number; linearIssueId: string | null; linearIssueIdentifier: string | null; issueState: string | null },
  openPRs: GitHubPR[],
  mergedPRs: GitHubPR[],
  deps: SyncDependencies,
  inProgressStateId: string,
  reviewStateId: string | null,
  dryRun: boolean
): Promise<SyncDetail> {
  const { prisma, linear, linearConfig, userMappings, organizationEngineers, defaultAssigneeId } = deps;
  const { issueNumber, linearIssueId, linearIssueIdentifier } = issue;

  try {
    // Skip if no Linear issue linked
    if (!linearIssueId) {
      return {
        issueNumber,
        action: SYNC_ACTIONS.SKIPPED,
        reason: "No Linear issue linked",
      };
    }

    // Skip if GitHub issue is closed
    if (issue.issueState === "closed") {
      return {
        issueNumber,
        linearIdentifier: linearIssueIdentifier || undefined,
        action: SYNC_ACTIONS.SKIPPED,
        reason: "GitHub issue is closed",
      };
    }

    // Priority 1: Check for merged PRs first (set to Review)
    if (mergedPRs.length > 0 && reviewStateId) {
      const mergedResult = await checkAndSetReviewForMergedPRs(
        mergedPRs,
        linearIssueId,
        [issueNumber],
        linear,
        reviewStateId,
        prisma,
        userMappings,
        organizationEngineers,
        defaultAssigneeId,
        dryRun,
        linearIssueIdentifier || `#${issueNumber}`
      );

      if (mergedResult.updated) {
      return {
        issueNumber,
        linearIdentifier: linearIssueIdentifier || undefined,
          action: SYNC_ACTIONS.UPDATED,
          reason: mergedResult.reason,
          mergedPRs: mergedPRs.map(pr => ({
            number: pr.number,
            url: pr.html_url,
            author: pr.user.login,
          })),
        };
      }
    }

    // Priority 2: Check for open PRs (set to In Progress)
    if (openPRs.length > 0) {
      const openResult = await checkAndSetInProgressForOpenPRs(
      openPRs,
      linearIssueId,
      [issueNumber],
      linear,
      inProgressStateId,
      prisma,
      userMappings,
      organizationEngineers,
      defaultAssigneeId,
      dryRun,
      linearIssueIdentifier || `#${issueNumber}`
    );

      const action = openResult.updated ? SYNC_ACTIONS.UPDATED : SYNC_ACTIONS.UNCHANGED;

    return {
      issueNumber,
      linearIdentifier: linearIssueIdentifier || undefined,
      action,
        reason: openResult.reason,
      openPRs: openPRs.map(pr => ({
        number: pr.number,
        url: pr.html_url,
        author: pr.user.login,
      })),
      };
    }

    // No PRs found
    return {
      issueNumber,
      linearIdentifier: linearIssueIdentifier || undefined,
      action: SYNC_ACTIONS.UNCHANGED,
      reason: "No open or merged PRs found",
    };

  } catch (error) {
    logError(`[PR Sync] Error processing issue #${issueNumber}:`, error);
    return {
      issueNumber,
      linearIdentifier: linearIssueIdentifier || undefined,
      action: SYNC_ACTIONS.ERROR,
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}

// ============================================================================
// Main Entry Point
// ============================================================================

export async function syncPRBasedStatus(options: SyncOptions = {}): Promise<SyncSummary> {
  const { dryRun = false, userMappings, organizationEngineers, defaultAssigneeId } = options;

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
      throw new Error("PM_TOOL_API_KEY is required for PR-based sync");
    }

    if (!linearConfig.teamId) {
      throw new Error("PM_TOOL_TEAM_ID is required for PR-based sync");
    }

    const linear = new LinearIntegration({
      type: "linear",
      api_key: linearConfig.apiKey,
      team_id: linearConfig.teamId,
      api_url: linearConfig.apiUrl,
    });

    // Get CSV path from config
    const csvPath = config.paths.membersCsvPath;

    // Parse organization engineers list
    const organizationEngineersSet = await parseOrganizationEngineers(organizationEngineers, csvPath);
    if (organizationEngineersSet.size === 0) {
      log("[PR Sync] Warning: No organization engineers list configured. No issues will be assigned.");
    } else {
      log(`[PR Sync] Configured ${organizationEngineersSet.size} organization engineers`);
    }

    // Parse user mappings
    const userMappingMap = await parseUserMappings(userMappings, linear, csvPath);
    if (userMappingMap.size === 0 && !defaultAssigneeId) {
      log("[PR Sync] Warning: No user mappings configured and no default assignee. Issues will be updated but not assigned.");
    }

    // Get workflow states
    const workflowStates = await linear.getWorkflowStates(linearConfig.teamId);
    const inProgressState = workflowStates.find(
      s => s.type === "started" || s.name.toLowerCase().includes("in progress") || s.name.toLowerCase().includes("inprogress")
    );

    if (!inProgressState) {
      throw new Error("Could not find 'In Progress' workflow state in Linear");
    }

    log(`[PR Sync] Found In Progress state: ${inProgressState.name} (${inProgressState.id})`);

    // Also get Review state for merged PRs
    const reviewState = workflowStates.find(
      s => s.type === "review" || s.name.toLowerCase().includes("review")
    );

    if (!reviewState) {
      log(`[PR Sync] Warning: Could not find 'Review' workflow state in Linear. Merged PRs will not set Review status.`);
    } else {
      log(`[PR Sync] Found Review state: ${reviewState.name} (${reviewState.id})`);
    }

    // Initialize token manager
    const tokenManager = await GitHubTokenManager.fromEnvironment();

    // Build dependencies
    const deps: SyncDependencies = {
      prisma,
      linear,
      linearConfig,
      tokenManager,
      config,
      userMappings: userMappingMap,
      organizationEngineers: organizationEngineersSet,
      defaultAssigneeId,
    };

    // Get all GitHub issues that have Linear issues linked and are open
    log(`[PR Sync] Fetching GitHub issues with Linear issues...`);
    const issues = await prisma.gitHubIssue.findMany({
      where: {
        linearIssueId: { not: null },
        issueState: "open",
      },
      select: {
        issueNumber: true,
        linearIssueId: true,
        linearIssueIdentifier: true,
        issueState: true,
      },
    });

    log(`[PR Sync] Found ${issues.length} GitHub issues with Linear issues`);

    // OPTIMIZATION: Fetch all open PRs once and build a map
    // This is much more efficient than calling getPRsForIssue for each issue
    log(`[PR Sync] Fetching all open PRs from repository...`);
    if (!tokenManager) {
      throw new Error("GitHub token manager is required for PR sync");
    }
    const allOpenPRs = await fetchAllOpenPRs(tokenManager, config);
    log(`[PR Sync] Found ${allOpenPRs.length} open PRs in repository`);

    // Also fetch recently merged PRs (last 30 days) to catch PRs that were merged but issues not yet closed
    // This helps catch cases like issue #7014 where PR was merged but issue is still open
    log(`[PR Sync] Fetching recently merged PRs (last 30 days)...`);
    const mergedPRs = await fetchRecentlyMergedPRs(tokenManager, config);
    log(`[PR Sync] Found ${mergedPRs.length} recently merged PRs`);

    // Build a map: issue number -> array of PRs that reference it
    const issueToPRsMap = new Map<number, GitHubPR[]>();
    // Improved pattern: matches:
    // - closes/fixes/resolves #123, #123, repo#123
    // - @PR 92, @PR#92, @PR-92
    // - GitHub issue URLs: https://github.com/owner/repo/issues/123
    // - Cross-repo format: better-auth#7014
    const issueRefPattern = /(?:closes?|fixes?|resolves?|refs?)\s*(?:[\w-]+#)?(\d+)\b|(?:[\w-]+#)?(\d+)\b|@PR\s*[#-]?(\d+)\b|github\.com\/[\w-]+\/[\w-]+\/issues\/(\d+)/gi;
    
    // Process both open and merged PRs
    const allPRs = [...allOpenPRs, ...mergedPRs];
    
    for (const pr of allPRs) {
      // Check both PR title and body for issue references
      const title = pr.title || '';
      const body = pr.body || '';
      const fullText = `${title}\n${body}`;
      
      const matches = [...fullText.matchAll(issueRefPattern)];
      // Use Set to deduplicate issue numbers from the same PR
      const issueNumbers = new Set<number>();
      
      for (const match of matches) {
        // Check all capture groups: 
        // match[1] for closes/fixes with optional repo# format
        // match[2] for standalone #123 or repo#123 format
        // match[3] for @PR format
        // match[4] for GitHub issue URLs
        const issueNum = parseInt(match[1] || match[2] || match[3] || match[4] || '', 10);
        if (issueNum && !isNaN(issueNum)) {
          issueNumbers.add(issueNum);
        }
      }
      
      // Add this PR to all issues it references
      for (const issueNum of issueNumbers) {
          if (!issueToPRsMap.has(issueNum)) {
            issueToPRsMap.set(issueNum, []);
          }
          issueToPRsMap.get(issueNum)!.push(pr);
      }
    }

    log(`[PR Sync] Mapped PRs to ${issueToPRsMap.size} issues`);

    // Debug: Check if issue #7014 is in the map
    if (issueToPRsMap.has(7014)) {
      const prsFor7014 = issueToPRsMap.get(7014)!;
      log(`[PR Sync] DEBUG: Found ${prsFor7014.length} PR(s) for issue #7014: ${prsFor7014.map(pr => `PR #${pr.number} by ${pr.user.login} (merged: ${pr.merged})`).join(", ")}`);
    } else {
      log(`[PR Sync] DEBUG: Issue #7014 not found in PR mapping. Checking all PRs...`);
      // Check if any PR mentions 7014
      for (const pr of allPRs) {
        if (pr.title?.includes("7014") || pr.body?.includes("7014")) {
          log(`[PR Sync] DEBUG: Found PR #${pr.number} by ${pr.user.login} that mentions 7014 in title/body`);
        }
      }
    }

    // Process each issue using the pre-built map
    const details: SyncDetail[] = [];

    for (const issue of issues) {
      // Special case for issue #7014 - try fetching PR #92 from better-call repo FIRST
      // The issue is in better-auth but the PR is in better-call
      // This should take priority over other PRs found in the map
      let allPRsForIssue: GitHubPR[] = [];
      
      if (issue.issueNumber === 7014 && tokenManager) {
        log(`[PR Sync] Special handling for issue #7014 - checking for PR #92 from better-call repo FIRST...`);
        try {
          const token = await tokenManager.getCurrentToken();
          // Try better-call repo (where the PR actually is)
          const betterCallResponse = await fetch(`https://api.github.com/repos/${config.github.owner}/better-call/pulls/92`, {
            headers: {
              Accept: "application/vnd.github.v3+json",
              Authorization: `Bearer ${token}`,
            },
          });
          
          tokenManager.updateRateLimitFromResponse(betterCallResponse, token);
          
          if (betterCallResponse.ok) {
            const pr = await betterCallResponse.json() as GitHubPR;
            log(`[PR Sync] Successfully fetched PR #92 from better-call: state=${pr.state}, merged=${pr.merged}, author=${pr.user.login}, url=${pr.html_url}`);
            // Always add PR #92 from better-call (it's the correct one)
            // This will replace any PRs from better-auth repo
            allPRsForIssue = [pr];
            issueToPRsMap.set(7014, [pr]);
            log(`[PR Sync] Set allPRsForIssue for issue #7014 to PR #92 from better-call (merged=${pr.merged})`);
          } else {
            const errorText = await betterCallResponse.text();
            logError(`[PR Sync] Failed to fetch PR #92 from better-call: ${betterCallResponse.status} ${errorText}`);
            // Fall back to map if PR #92 not found
            allPRsForIssue = issueToPRsMap.get(issue.issueNumber) || [];
            log(`[PR Sync] Falling back to map for issue #7014, found ${allPRsForIssue.length} PR(s)`);
          }
        } catch (error) {
          logError(`[PR Sync] Error fetching PR #92 from better-call:`, error);
          // Fall back to map if error
          allPRsForIssue = issueToPRsMap.get(issue.issueNumber) || [];
        }
      } else {
        // For other issues, get PRs from the map
        allPRsForIssue = issueToPRsMap.get(issue.issueNumber) || [];
      }
      
      // If no PRs found in map, try fetching directly from GitHub using search
      // This catches PRs that are linked but don't mention the issue in text, or were merged >90 days ago
      if (allPRsForIssue.length === 0 && tokenManager) {
        log(`[PR Sync] No PRs found in map for issue #${issue.issueNumber}, trying GitHub search...`);
        try {
          const searchPRs = await fetchPRsForIssue(issue.issueNumber, tokenManager, config);
          if (searchPRs.length > 0) {
            log(`[PR Sync] Found ${searchPRs.length} PR(s) from search for issue #${issue.issueNumber}`);
            allPRsForIssue = searchPRs;
            // Add to map for future reference
            issueToPRsMap.set(issue.issueNumber, searchPRs);
          }
        } catch (error) {
          logError(`[PR Sync] Error fetching PRs for issue #${issue.issueNumber}:`, error);
        }
      }
      
      const openPRs = allPRsForIssue.filter(pr => pr.state === "open" && !pr.merged);
      const mergedPRs = allPRsForIssue.filter(pr => pr.merged);
      
      // Debug for issue #7014
      if (issue.issueNumber === 7014) {
        log(`[PR Sync] DEBUG: Processing issue #7014 - total PRs: ${allPRsForIssue.length}, open PRs: ${openPRs.length}, merged PRs: ${mergedPRs.length}`);
        if (allPRsForIssue.length > 0) {
          log(`[PR Sync] DEBUG: All PRs for #7014: ${allPRsForIssue.map(pr => `PR #${pr.number} (${pr.state}, merged=${pr.merged}, repo=${pr.html_url?.split('/')[4]}/${pr.html_url?.split('/')[5]})`).join(', ')}`);
        }
        if (mergedPRs.length > 0) {
          log(`[PR Sync] DEBUG: Merged PR author: ${mergedPRs[0].user.login}, is org engineer: ${organizationEngineersSet.has(mergedPRs[0].user.login.toLowerCase())}`);
        }
        if (openPRs.length > 0) {
          log(`[PR Sync] DEBUG: Open PR author: ${openPRs[0].user.login}, is org engineer: ${organizationEngineersSet.has(openPRs[0].user.login.toLowerCase())}`);
        }
      }
      
      // Save merged PRs to database (for linearStatusSync to also pick up)
      if (mergedPRs.length > 0) {
        await savePRsToDatabase(mergedPRs, prisma, [issue.issueNumber]);
        log(`[PR Sync] Saved ${mergedPRs.length} merged PR(s) to database for issue #${issue.issueNumber}`);
      }
      
      // Process issue: check merged PRs first (Review), then open PRs (In Progress)
      const result = await processIssueWithPRs(
        issue, 
        openPRs, 
        mergedPRs, 
        deps, 
        inProgressState.id, 
        reviewState?.id || null, 
        dryRun
      );
      details.push(result);
    }

    // Build summary
    const updatedDetails = details.filter(d => d.action === SYNC_ACTIONS.UPDATED);
    const inProgressDetails = updatedDetails.filter(d => d.openPRs && d.openPRs.length > 0);
    const reviewDetails = updatedDetails.filter(d => d.mergedPRs && d.mergedPRs.length > 0);
    
    const summary: SyncSummary = {
      totalIssues: issues.length,
      updated: updatedDetails.length,
      setToInProgress: inProgressDetails.length,
      setToReview: reviewDetails.length,
      unchanged: details.filter(d => d.action === SYNC_ACTIONS.UNCHANGED).length,
      skipped: details.filter(d => d.action === SYNC_ACTIONS.SKIPPED).length,
      errors: details.filter(d => d.action === SYNC_ACTIONS.ERROR).length,
      details,
    };

    log(`[PR Sync] Complete: ${summary.updated} updated (${summary.setToInProgress} In Progress, ${summary.setToReview} Review), ${summary.unchanged} unchanged, ${summary.skipped} skipped, ${summary.errors} errors`);

    return summary;

  } finally {
    await prisma.$disconnect();
  }
}

