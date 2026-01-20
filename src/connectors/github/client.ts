/**
 * GitHub integration for searching repository issues
 */
import { getConfig } from "../../config/index.js";
import { log } from "../../mcp/logger.js";
import { GitHubTokenManager } from "./tokenManager.js";

export interface GitHubComment {
  id: number;
  body: string;
  user: {
    login: string;
    avatar_url: string;
  };
  created_at: string;
  updated_at: string;
  html_url: string;
  reactions?: {
    total_count: number;
    "+1": number;
    "-1": number;
    laugh: number;
    hooray: number;
    confused: number;
    heart: number;
    rocket: number;
    eyes: number;
  };
}

export interface GitHubIssue {
  id: number;
  number: number;
  title: string;
  body: string;
  state: "open" | "closed";
  created_at: string;
  updated_at: string;
  user: {
    login: string;
    avatar_url: string;
  };
  labels: Array<{
    name: string;
    color: string;
  }>;
  html_url: string;
  assignees?: Array<{
    login: string;
    avatar_url: string;
  }>;
  milestone?: {
    title: string;
    state: string;
  } | null;
  reactions?: {
    total_count: number;
    "+1": number;
    "-1": number;
    laugh: number;
    hooray: number;
    confused: number;
    heart: number;
    rocket: number;
    eyes: number;
  };
  comments_count?: number;
  comments?: GitHubComment[];
  pull_request?: {
    url: string;
    html_url: string;
    diff_url: string;
    patch_url: string;
  } | null;
}

export interface GitHubSearchResult {
  total_count: number;
  items: GitHubIssue[];
}

/**
 * Search GitHub issues for a repository
 */
export async function searchGitHubIssues(
  query: string,
  token?: string,
  owner?: string,
  repo?: string
): Promise<GitHubSearchResult> {
  const config = getConfig();
  const repoOwner = owner || config.github.owner;
  const repoName = repo || config.github.repo;
  const searchQuery = `repo:${repoOwner}/${repoName} ${query} type:issue`;

  const url = `https://api.github.com/search/issues?q=${encodeURIComponent(searchQuery)}&per_page=20&sort=updated`;

  const headers: Record<string, string> = {
    Accept: "application/vnd.github.v3+json",
  };

  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }

  const response = await fetch(url, { headers });

  if (!response.ok) {
    throw new Error(
      `GitHub API error: ${response.status} ${response.statusText}`
    );
  }

  const data = await response.json() as GitHubSearchResult;
  return data;
}

/**
 * Retry helper function with exponential backoff
 */
async function retryWithBackoff<T>(
  fn: () => Promise<T>,
  maxRetries: number = 3,
  initialDelay: number = 1000,
  retryableErrors: (error: unknown) => boolean = (error) => {
    const errorMsg = error instanceof Error ? error.message : String(error);
    // Retry on network errors, 5xx errors, and rate limit errors (but not 403/429 which need token rotation)
    return errorMsg.includes('fetch') ||
           errorMsg.includes('ECONNRESET') ||
           errorMsg.includes('ETIMEDOUT') ||
           errorMsg.includes('500') ||
           errorMsg.includes('502') ||
           errorMsg.includes('503') ||
           errorMsg.includes('504');
  }
): Promise<T> {
  let lastError: unknown;
  
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      
      // Don't retry on rate limit errors (403/429) - these need token rotation
      const errorMsg = error instanceof Error ? error.message : String(error);
      if (errorMsg.includes('403') || errorMsg.includes('429')) {
        throw error; // Re-throw immediately for rate limit errors
      }
      
      // Don't retry if not a retryable error
      if (!retryableErrors(error)) {
        throw error;
      }
      
      // Don't retry on last attempt
      if (attempt < maxRetries) {
        const delay = initialDelay * Math.pow(2, attempt);
        log(`Retry attempt ${attempt + 1}/${maxRetries} after ${delay}ms delay...`);
        await new Promise(resolve => setTimeout(resolve, delay));
      }
    }
  }
  
  throw lastError;
}

/**
 * Fetch comments for a specific GitHub issue with retry logic
 */
export async function fetchIssueComments(
  issueNumber: number,
  token?: string,
  owner?: string,
  repo?: string,
  retryOnFailure: boolean = true
): Promise<GitHubComment[]> {
  const config = getConfig();
  const repoOwner = owner || config.github.owner;
  const repoName = repo || config.github.repo;
  const allComments: GitHubComment[] = [];
  
  const headers: Record<string, string> = {
    Accept: "application/vnd.github.v3+json",
  };

  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }

  let page = 1;
  let hasMore = true;

  while (hasMore) {
    const fetchPage = async () => {
      const url = `https://api.github.com/repos/${repoOwner}/${repoName}/issues/${issueNumber}/comments?per_page=100&page=${page}`;
      const response = await fetch(url, { headers });
      
      if (!response.ok) {
        const rateLimitRemaining = response.headers.get('X-RateLimit-Remaining');
        const rateLimitReset = response.headers.get('X-RateLimit-Reset');
        const rateLimitLimit = response.headers.get('X-RateLimit-Limit');
        
        let errorMessage = `GitHub API error fetching comments: ${response.status} ${response.statusText}`;
        
        if (response.status === 403 || response.status === 429) {
          errorMessage += '\n\nRate limit information:';
          if (rateLimitLimit) errorMessage += `\n  Limit: ${rateLimitLimit} requests/hour`;
          if (rateLimitRemaining !== null) errorMessage += `\n  Remaining: ${rateLimitRemaining} requests`;
          if (rateLimitReset) {
            const resetDate = new Date(parseInt(rateLimitReset) * 1000);
            const resetIn = Math.ceil((parseInt(rateLimitReset) * 1000 - Date.now()) / 1000 / 60);
            errorMessage += `\n  Resets at: ${resetDate.toISOString()} (in ~${resetIn} minutes)`;
          }
          // Check if token is set by looking at the limit (5000 = token, 60 = no token)
          const hasToken = rateLimitLimit && parseInt(rateLimitLimit) >= 5000;
          if (hasToken) {
            errorMessage += '\n\nRate limit exhausted. Please wait for the limit to reset, or use a different GitHub token.';
            errorMessage += '\nThe fetch will automatically resume from where it left off when you try again.';
          } else {
            errorMessage += '\n\nTip: Set GITHUB_TOKEN environment variable for higher rate limits (5000/hour vs 60/hour)';
          }
        }
        
        throw new Error(errorMessage);
      }

      return await response.json() as GitHubComment[];
    };

    let comments: GitHubComment[];
    try {
      if (retryOnFailure) {
        comments = await retryWithBackoff(fetchPage, 3, 1000);
      } else {
        comments = await fetchPage();
      }
    } catch (error) {
      // If retry failed, log and re-throw
      const errorMsg = error instanceof Error ? error.message : String(error);
      log(`[ERROR] Failed to fetch comments for issue #${issueNumber}, page ${page} after retries: ${errorMsg}`);
      throw error;
    }
    
    if (comments.length > 0) {
      allComments.push(...comments);
    }
    
    if (comments.length === 0 || comments.length < 100) {
      hasMore = false;
    } else {
      page++;
      // Rate limit: wait a bit between pages
      await new Promise((resolve) => setTimeout(resolve, token ? 100 : 1000));
    }
  }

  return allComments;
}

/**
 * Fetch full details for a single GitHub issue (including comments, reactions, etc.)
 */
export async function fetchIssueDetails(
  issueNumber: number,
  token?: string,
  owner?: string,
  repo?: string,
  includeComments = true
): Promise<GitHubIssue> {
  const config = getConfig();
  const repoOwner = owner || config.github.owner;
  const repoName = repo || config.github.repo;
  
  const headers: Record<string, string> = {
    Accept: "application/vnd.github.v3+json",
  };

  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }

  // Fetch issue details
  const issueUrl = `https://api.github.com/repos/${repoOwner}/${repoName}/issues/${issueNumber}`;
  const issueResponse = await fetch(issueUrl, { headers });
  
  if (!issueResponse.ok) {
    const rateLimitRemaining = issueResponse.headers.get('X-RateLimit-Remaining');
    const rateLimitReset = issueResponse.headers.get('X-RateLimit-Reset');
    const rateLimitLimit = issueResponse.headers.get('X-RateLimit-Limit');
    
    let errorMessage = `GitHub API error: ${issueResponse.status} ${issueResponse.statusText}`;
    
    if (issueResponse.status === 403 || issueResponse.status === 429) {
      errorMessage += '\n\nRate limit information:';
      if (rateLimitLimit) errorMessage += `\n  Limit: ${rateLimitLimit} requests/hour`;
      if (rateLimitRemaining !== null) errorMessage += `\n  Remaining: ${rateLimitRemaining} requests`;
      if (rateLimitReset) {
        const resetDate = new Date(parseInt(rateLimitReset) * 1000);
        const resetIn = Math.ceil((parseInt(rateLimitReset) * 1000 - Date.now()) / 1000 / 60);
        errorMessage += `\n  Resets at: ${resetDate.toISOString()} (in ~${resetIn} minutes)`;
      }
      errorMessage += '\n\nTip: Set GITHUB_TOKEN environment variable for higher rate limits (5000/hour vs 60/hour)';
    }
    
    throw new Error(errorMessage);
  }

  const issue = await issueResponse.json() as GitHubIssue;

  // Always fetch comments if requested (removed comments_count check to ensure we get all comments)
  // This ensures we catch comments that were added after the issue was last fetched
  if (includeComments) {
    try {
      issue.comments = await fetchIssueComments(issueNumber, token, owner, repo, true);
      // Only log if there are comments (to reduce log noise)
      if (issue.comments.length > 0) {
        log(`[SUCCESS] Fetched ${issue.comments.length} comments for issue #${issueNumber}`);
      }
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      
      // Check if it's a rate limit error - these should be re-thrown to trigger token rotation
      if (errorMsg.includes('403') || errorMsg.includes('429')) {
        log(`[ERROR] Rate limit error fetching comments for issue #${issueNumber}: ${errorMsg}`);
        throw error; // Re-throw rate limit errors so they can trigger token rotation
      }
      
      // For other errors, log but don't fail the entire issue fetch
      // We'll save the issue without comments so it can be retried later
      log(`[WARNING] Failed to fetch comments for issue #${issueNumber} after retries: ${errorMsg}`);
      log(`[INFO] Issue #${issueNumber} will be saved without comments. Run fetch_github_issues again to retry.`);
      issue.comments = [];
    }
  } else {
    issue.comments = [];
  }

  return issue;
}

/**
 * Batch fetch issue details in parallel with resume capability
 * @param issueNumbers - Array of issue numbers to fetch
 * @param token - GitHub API token (optional)
 * @param owner - Repository owner (optional)
 * @param repo - Repository name (optional)
 * @param includeComments - Whether to fetch comments for each issue
 * @param batchSize - Number of issues to fetch in parallel (default: 5)
 * @param existingIssues - Map of already-fetched issues (issue number -> issue) to skip
 * @param onBatchComplete - Optional callback after each batch completes (for saving progress)
 */
async function batchFetchIssueDetails(
  issueNumbers: number[],
  tokenOrManager: string | GitHubTokenManager | undefined,
  owner: string | undefined,
  repo: string | undefined,
  includeComments: boolean,
  batchSize = 5,
  existingIssues: Map<number, GitHubIssue> = new Map(),
  onBatchComplete?: (issues: GitHubIssue[]) => Promise<void>
): Promise<GitHubIssue[]> {
  const results: GitHubIssue[] = [];
  
  // Filter out already-fetched issues
  const issuesToFetch = issueNumbers.filter(num => !existingIssues.has(num));
  const skippedCount = issueNumbers.length - issuesToFetch.length;
  
  if (skippedCount > 0) {
    console.error(`[GitHub] Resuming: Skipping ${skippedCount} already-fetched issues, fetching ${issuesToFetch.length} remaining...`);
    // Add existing issues to results
    for (const num of issueNumbers) {
      const existing = existingIssues.get(num);
      if (existing) {
        results.push(existing);
      }
    }
  }
  
  let currentBatchSize = batchSize;
  
  for (let i = 0; i < issuesToFetch.length; i += currentBatchSize) {
    const batch = issuesToFetch.slice(i, i + currentBatchSize);
    const batchNum = Math.floor(i / currentBatchSize) + 1;
    const totalBatches = Math.ceil(issuesToFetch.length / currentBatchSize);
    
    console.error(`[GitHub] Fetching batch ${batchNum}/${totalBatches} (${batch.length} issues, batch size: ${currentBatchSize})...`);
    
    // Get current token before batch - use proactive rotation to avoid hitting limits
    let currentToken = await getToken(tokenOrManager);
    
    // If using token manager, use proactive rotation (rotate when <= 2 remaining)
    if (tokenOrManager && tokenOrManager instanceof GitHubTokenManager) {
      currentToken = await tokenOrManager.getTokenWithProactiveRotation(2);
      
      // Check if all tokens are exhausted
      if (tokenOrManager.areAllTokensExhausted()) {
        const status = tokenOrManager.getStatus();
        const nextReset = Math.min(...status.map(s => s.resetIn));
        
        throw new Error(`All GitHub tokens exhausted. Next reset in ~${nextReset} minutes.`);
      }
    }
    
    const batchPromises = batch.map(async (issueNumber) => {
      try {
        return await fetchIssueDetails(issueNumber, currentToken, owner, repo, includeComments);
      } catch (error) {
        // If rate limit error and using token manager, try to rotate
        if (tokenOrManager && tokenOrManager instanceof GitHubTokenManager) {
          const errorMsg = error instanceof Error ? error.message : String(error);
          if (errorMsg.includes('403') || errorMsg.includes('429')) {
            // Log current token status before rotation
            const currentTokenType = tokenOrManager.getTokenType(currentToken || '');
            const status = tokenOrManager.getStatus();
            console.error(`[GitHub] Rate limit hit on ${currentTokenType} token for issue #${issueNumber}`);
            console.error(`[GitHub] Token status: ${status.map(t => `Token ${t.index}: ${t.remaining}/${t.limit} (resets in ${t.resetIn} min)`).join(', ')}`);
            
            // Try next token
            const nextToken = await tokenOrManager.getNextAvailableToken();
            if (nextToken) {
              const nextTokenType = tokenOrManager.getTokenType(nextToken);
              console.error(`[GitHub] Rotating from ${currentTokenType} to ${nextTokenType} token...`);
              try {
                return await fetchIssueDetails(issueNumber, nextToken, owner, repo, includeComments);
              } catch (retryError) {
                log(`Warning: Failed to fetch details for issue #${issueNumber} even after token rotation: ${retryError}`);
              }
            } else {
              // All tokens exhausted
              const resetTimes = tokenOrManager.getResetTimesByType();
              const allResets = [...resetTimes.appTokens, ...resetTimes.regularTokens];
              const nextReset = allResets.length > 0 ? Math.min(...allResets.map(t => t.resetIn)) : 0;
              console.error(`[GitHub] All tokens exhausted! Next reset in ~${nextReset} minutes`);
              console.error(`[GitHub] Note: Tokens from the same GitHub account share rate limits (5000/hour)`);
            }
          }
        }
        log(`Warning: Failed to fetch details for issue #${issueNumber}: ${error}`);
        return null;
      }
    });
    
    const batchResults = await Promise.all(batchPromises);
    const validResults = batchResults.filter((issue): issue is GitHubIssue => issue !== null);
    results.push(...validResults);
    
    
    // Save progress after each batch (if callback provided)
    if (onBatchComplete && validResults.length > 0) {
      try {
        await onBatchComplete(validResults);
      } catch (error) {
        log(`Warning: Failed to save progress after batch: ${error}`);
      }
    }
    
    // Small delay between batches to respect rate limits
    // Delay increases if we're processing large batches to be more conservative
    const hasToken = !!(await getToken(tokenOrManager));
    const delay = hasToken ? (currentBatchSize > 5 ? 200 : 100) : (currentBatchSize > 3 ? 1000 : 500);
    if (i + currentBatchSize < issuesToFetch.length) {
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
  
  return results;
}

/**
 * Fetch all GitHub issues (both open and closed) from a repository
 * Uses two-phase approach: first paginates to collect issue numbers, then batch fetches details in parallel
 * Now includes full details: comments, reactions, assignees, etc.
 * Supports resume: if existingIssues provided, skips already-fetched issues
 * 
 * @param token - GitHub API token (optional but recommended)
 * @param includeClosed - Whether to include closed issues
 * @param owner - Repository owner (defaults to config)
 * @param repo - Repository name (defaults to config)
 * @param since - ISO date string - only fetch issues updated after this date (for incremental updates)
 * @param limit - Maximum number of issues to fetch (undefined = no limit)
 * @param includeComments - Whether to fetch comments for each issue (default: true)
 * @param existingIssues - Array of already-fetched issues to skip (for resume capability)
 * @param onBatchComplete - Optional callback after each batch completes (for saving progress)
 */
/**
 * Helper to get token from either string or token manager
 */
async function getToken(tokenOrManager: string | GitHubTokenManager | undefined): Promise<string | undefined> {
  if (!tokenOrManager) return undefined;
  if (typeof tokenOrManager === 'string') return tokenOrManager;
  return await tokenOrManager.getCurrentToken();
}

/**
 * Helper to create headers with token
 * @param tokenOrManager - Token string or manager
 * @param specificToken - If provided, use this specific token instead of getting from manager
 */
async function createHeaders(tokenOrManager: string | GitHubTokenManager | undefined, specificToken?: string): Promise<Record<string, string>> {
  const headers: Record<string, string> = {
    Accept: "application/vnd.github.v3+json",
  };
  
  // Use specific token if provided (e.g., after a switch), otherwise get from manager
  const token = specificToken || await getToken(tokenOrManager);
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }
  
  return headers;
}

/**
 * Helper to update rate limit from response
 */
function updateRateLimit(
  response: Response,
  tokenOrManager: string | GitHubTokenManager | undefined,
  tokenString?: string
): void {
  if (tokenOrManager && tokenOrManager instanceof GitHubTokenManager) {
    tokenOrManager.updateRateLimitFromResponse(response, tokenString);
  }
}

export async function fetchAllGitHubIssues(
  tokenOrManager?: string | GitHubTokenManager,
  includeClosed = true,
  owner?: string,
  repo?: string,
  since?: string,
  limit?: number,
  includeComments = true,
  existingIssues: GitHubIssue[] = [],
  onBatchComplete?: (issues: GitHubIssue[]) => Promise<void>,
  existingIssueNumbers?: number[] // For resume: skip these issue numbers during Phase 1 collection
): Promise<GitHubIssue[]> {
  const config = getConfig();
  const repoOwner = owner || config.github.owner;
  const repoName = repo || config.github.repo;
  const allIssueNumbers: number[] = existingIssueNumbers ? [...existingIssueNumbers] : [];
  
  // Check for available token before starting (if using token manager)
  if (tokenOrManager && tokenOrManager instanceof GitHubTokenManager) {
    const status = tokenOrManager.getStatus();
    const allTokens = tokenOrManager.getAllTokens();
    const hasApp = !!(process.env.GITHUB_APP_ID && process.env.GITHUB_APP_INSTALLATION_ID);
    const hasRegular = !!(process.env.GITHUB_TOKEN);
    
    console.error(`[GitHub] Checking token availability before starting...`);
    console.error(`[GitHub]   - GitHub App configured: ${hasApp ? 'Yes' : 'No'}`);
    console.error(`[GitHub]   - Regular token configured: ${hasRegular ? 'Yes' : 'No'}`);
    console.error(`[GitHub]   - Tokens in manager: ${allTokens.length}`);
    console.error(`[GitHub]   - Token status: ${status.map(t => `Token ${t.index}: ${t.remaining}/${t.limit} (resets in ${t.resetIn} min)`).join(', ')}`);
    
    const availableToken = await tokenOrManager.getNextAvailableToken();
    if (!availableToken) {
      const resetTimes = tokenOrManager.getResetTimesByType();
      let errorMsg = `All GitHub tokens exhausted before starting fetch.\n\n`;
      
      if (resetTimes.appTokens.length > 0) {
        errorMsg += `GitHub App tokens (${resetTimes.appTokens.length}):\n`;
        resetTimes.appTokens.forEach(token => {
          const resetDate = new Date(token.resetAt).toISOString();
          errorMsg += `  - Token ${token.index}: Resets at ${resetDate} (in ~${token.resetIn} minutes)\n`;
        });
      } else {
        errorMsg += `GitHub App tokens: ${hasApp ? 'configured but no tokens in cache' : 'not configured'}\n`;
      }
      
      if (resetTimes.regularTokens.length > 0) {
        errorMsg += `\nRegular tokens (${resetTimes.regularTokens.length}):\n`;
        resetTimes.regularTokens.forEach(token => {
          const resetDate = new Date(token.resetAt).toISOString();
          errorMsg += `  - Token ${token.index}: Resets at ${resetDate} (in ~${token.resetIn} minutes)\n`;
        });
      } else {
        errorMsg += `\nRegular tokens: ${hasRegular ? 'configured but no tokens in cache' : 'not configured'}\n`;
      }
      
      const allResetTimes = [...resetTimes.appTokens, ...resetTimes.regularTokens].map(t => t.resetAt);
      const earliestReset = allResetTimes.length > 0 ? Math.min(...allResetTimes) : Date.now();
      const earliestResetIn = Math.ceil((earliestReset - Date.now()) / 1000 / 60);
      const earliestResetDate = new Date(earliestReset).toISOString();
      
      errorMsg += `\nEarliest reset: ${earliestResetDate} (in ~${earliestResetIn} minutes)\n`;
      errorMsg += `\nNote: If tokens are from the same GitHub account, they share the same rate limit.`;
      
      throw new Error(errorMsg);
    }
    console.error(`[GitHub] Starting with available token: ${availableToken.substring(0, 10)}...`);
  }

  let headers = await createHeaders(tokenOrManager);

  // Phase 1: Paginate through all pages to collect issue numbers
  if (existingIssueNumbers && existingIssueNumbers.length > 0) {
    console.error(`[GitHub] Phase 1: Resuming - ${existingIssueNumbers.length} issue numbers already collected, continuing collection...`);
  } else {
    console.error(`[GitHub] Phase 1: Paginating through issue lists...`);
  }
  console.error(`[GitHub] Fetching open issues from ${repoOwner}/${repoName}...`);
  if (since) {
    console.error(`[GitHub] Filtering by updated date: ${since}`);
  }
  if (limit) {
    console.error(`[GitHub] Limit: ${limit} issues`);
  }
  
  // Fetch open issues (paginate to collect issue numbers)
  let page = 1;
  let hasMore = true;
  let switchInfo = ''; // Track token switching information for error messages
  
  while (hasMore && (limit === undefined || allIssueNumbers.length < limit)) {
    let url = `https://api.github.com/repos/${repoOwner}/${repoName}/issues?state=open&per_page=100&page=${page}&sort=updated&direction=desc`;
    if (since) {
      url += `&since=${encodeURIComponent(since)}`;
    }
    
    console.error(`[GitHub] Fetching open issues page ${page}...`);
    
      // Get current token with proactive rotation (rotate when <= 2 remaining)
      let currentToken: string | undefined;
      if (tokenOrManager && tokenOrManager instanceof GitHubTokenManager) {
        currentToken = await tokenOrManager.getTokenWithProactiveRotation(2);
      } else {
        currentToken = await getToken(tokenOrManager);
      }
      headers = await createHeaders(tokenOrManager, currentToken); // Use specific token
      
      // Determine token type for logging
      let currentTokenType: 'app' | 'regular' | 'unknown' = 'unknown';
      if (currentToken && tokenOrManager && tokenOrManager instanceof GitHubTokenManager) {
        currentTokenType = tokenOrManager.getTokenType(currentToken);
      }
      
      const response = await fetch(url, { headers });
    
    // Update rate limit info if using token manager
    if (response.ok && currentToken) {
      updateRateLimit(response, tokenOrManager, currentToken);
    }
    
    // Log rate limit status periodically (every 5 pages)
    if (page % 5 === 1 && response.ok) {
      const rateLimitRemaining = response.headers.get('X-RateLimit-Remaining');
      const rateLimitLimit = response.headers.get('X-RateLimit-Limit');
      if (rateLimitRemaining !== null && rateLimitLimit) {
        const remaining = parseInt(rateLimitRemaining);
        const limit = parseInt(rateLimitLimit);
        const percentage = ((remaining / limit) * 100).toFixed(1);
        console.error(`[GitHub] Rate limit status: ${remaining}/${limit} remaining (${percentage}%)`);
        if (remaining < 100) {
          console.error(`[GitHub] Warning: Rate limit getting low! Consider using GITHUB_TOKEN for higher limits.`);
        }
      }
    }
    
    if (!response.ok) {
      const rateLimitRemaining = response.headers.get('X-RateLimit-Remaining');
      const rateLimitReset = response.headers.get('X-RateLimit-Reset');
      const rateLimitLimit = response.headers.get('X-RateLimit-Limit');
      
      // If rate limit error and using token manager, try to rotate token
      if ((response.status === 403 || response.status === 429) && tokenOrManager && tokenOrManager instanceof GitHubTokenManager) {
        // Update rate limit info for current token before rotating
        if (currentToken) {
          updateRateLimit(response, tokenOrManager, currentToken);
        }
        
        // Try to get next available token from existing tokens or GitHub Apps
        // Note: Rate limits are per GitHub user account for OAuth/PAT, per installation for GitHub Apps
        console.error(`[GitHub] Rate limit hit on current token, attempting to switch to next available token...`);
        const currentTokenType = tokenOrManager.getTokenType(currentToken || '');
        const currentTokenTypeName = currentTokenType === 'app' ? 'GitHub App' : currentTokenType === 'regular' ? 'regular' : 'unknown';
        const nextToken = await tokenOrManager.getNextAvailableToken();
        
        if (!nextToken) {
          console.error(`[GitHub] No available tokens found after attempting switch. All tokens exhausted.`);
          switchInfo = `\n  Switch attempted: Yes (from ${currentTokenTypeName} token)\n  Switch result: Failed - all tokens exhausted`;
          // All tokens exhausted - show detailed reset times
          const resetTimes = tokenOrManager.getResetTimesByType();
          const hasApp = !!(process.env.GITHUB_APP_ID && process.env.GITHUB_APP_INSTALLATION_ID);
          const hasRegular = !!(process.env.GITHUB_TOKEN);
          
          console.error(`[GitHub] All tokens exhausted.`);
          
          if (resetTimes.appTokens.length > 0) {
            console.error(`[GitHub] GitHub App tokens (${resetTimes.appTokens.length}):`);
            resetTimes.appTokens.forEach(token => {
              const resetDate = new Date(token.resetAt).toISOString();
              console.error(`[GitHub]   - Token ${token.index}: Resets at ${resetDate} (in ~${token.resetIn} minutes)`);
            });
          } else {
            console.error(`[GitHub] GitHub App tokens: ${hasApp ? 'configured but no tokens in cache' : 'not configured'}`);
          }
          
          if (resetTimes.regularTokens.length > 0) {
            console.error(`[GitHub] Regular tokens (${resetTimes.regularTokens.length}):`);
            resetTimes.regularTokens.forEach(token => {
              const resetDate = new Date(token.resetAt).toISOString();
              console.error(`[GitHub]   - Token ${token.index}: Resets at ${resetDate} (in ~${token.resetIn} minutes)`);
            });
          } else {
            console.error(`[GitHub] Regular tokens: ${hasRegular ? 'configured but no tokens in cache' : 'not configured'}`);
          }
          
          const allResetTimes = [...resetTimes.appTokens, ...resetTimes.regularTokens].map(t => t.resetAt);
          const earliestReset = allResetTimes.length > 0 ? Math.min(...allResetTimes) : Date.now();
          const earliestResetIn = Math.ceil((earliestReset - Date.now()) / 1000 / 60);
          const earliestResetDate = new Date(earliestReset).toISOString();
          
          console.error(`[GitHub] Earliest reset: ${earliestResetDate} (in ~${earliestResetIn} minutes)`);
          console.error(`[GitHub] Note: If tokens are from the same GitHub account, they share the same rate limit.`);
          console.error(`[GitHub] To get separate rate limits, use tokens from different GitHub accounts via GITHUB_TOKEN (comma-separated).`);
        }
        
        if (nextToken) {
          const nextTokenType = tokenOrManager.getTokenType(nextToken);
          const nextTokenTypeName = nextTokenType === 'app' ? 'GitHub App installation token' : nextTokenType === 'regular' ? 'Regular user token (PAT/OAuth)' : 'Unknown token type';
          const nextTokenTypeShort = nextTokenType === 'app' ? 'GitHub App' : nextTokenType === 'regular' ? 'regular' : 'unknown';
          switchInfo = `\n  Switch attempted: Yes (from ${currentTokenTypeName} token)\n  Switch result: Success - switched to ${nextTokenTypeShort} token`;
          console.error(`[GitHub] Successfully switched from ${currentTokenTypeName} token to ${nextTokenTypeName}`);
          console.error(`[GitHub] Rate limit hit, rotating to next token...`);
          headers = await createHeaders(tokenOrManager, nextToken); // Use the specific new token
          // Retry the same request with new token
          const retryResponse = await fetch(url, { headers });
          
          // Update rate limit info for new token
          if (retryResponse.ok && nextToken) {
            updateRateLimit(retryResponse, tokenOrManager, nextToken);
          }
          
          if (retryResponse.ok) {
            // Success with new token, continue processing
            const issues = await retryResponse.json() as GitHubIssue[];
            const actualIssues = issues.filter(issue => !issue.pull_request);
            console.error(`[GitHub] Page ${page}: Found ${actualIssues.length} issues (${issues.length - actualIssues.length} PRs filtered out) after token rotation`);
            
            const issueNumbers = actualIssues.map(issue => issue.number);
            if (limit !== undefined && allIssueNumbers.length + issueNumbers.length > limit) {
              const remaining = limit - allIssueNumbers.length;
              if (remaining > 0) {
                allIssueNumbers.push(...issueNumbers.slice(0, remaining));
              }
              console.error(`[GitHub] Reached limit of ${limit} issues. Stopping pagination.`);
              hasMore = false;
              break;
            }
            
            allIssueNumbers.push(...issueNumbers);
            console.error(`[GitHub] Page ${page} complete: Collected ${issueNumbers.length} issue numbers (total: ${allIssueNumbers.length})`);
            
            if (issues.length === 0 || issues.length < 100) {
              hasMore = false;
              console.error(`[GitHub] Reached end of open issues (last page had ${issues.length} items)`);
            } else {
              page++;
              const hasToken = !!(await getToken(tokenOrManager));
              await new Promise((resolve) => setTimeout(resolve, hasToken ? 100 : 1000));
            }
            continue; // Continue to next iteration
          }
          // If retry also failed, fall through to error handling
        }
      }
      
      let errorMessage = `GitHub API error: ${response.status} ${response.statusText}`;
      
      if (response.status === 403 || response.status === 429) {
        errorMessage += '\n\nRate limit information:';
        if (rateLimitLimit) errorMessage += `\n  Limit: ${rateLimitLimit} requests/hour`;
        if (rateLimitRemaining !== null) errorMessage += `\n  Remaining: ${rateLimitRemaining} requests`;
        if (rateLimitReset) {
          const resetDate = new Date(parseInt(rateLimitReset) * 1000);
          const resetIn = Math.ceil((parseInt(rateLimitReset) * 1000 - Date.now()) / 1000 / 60);
          errorMessage += `\n  Resets at: ${resetDate.toISOString()} (in ~${resetIn} minutes)`;
        }
        
        // Show which token type was used when rate limit was hit
        if (currentToken && tokenOrManager && tokenOrManager instanceof GitHubTokenManager) {
          const tokenType = tokenOrManager.getTokenType(currentToken);
          const tokenTypeName = tokenType === 'app' ? 'GitHub App installation token' : tokenType === 'regular' ? 'Regular user token (PAT/OAuth)' : 'Unknown token type';
          errorMessage += `\n  Token used: ${tokenTypeName}`;
          
          // Add switch attempt information if available
          if (switchInfo) {
            errorMessage += switchInfo;
          }
        }
        
        // If using token manager, show detailed reset times for each token type
        if (tokenOrManager && tokenOrManager instanceof GitHubTokenManager) {
          const resetTimes = tokenOrManager.getResetTimesByType();
          const hasApp = !!(process.env.GITHUB_APP_ID && process.env.GITHUB_APP_INSTALLATION_ID);
          const hasRegular = !!(process.env.GITHUB_TOKEN);
          
          errorMessage += '\n\nToken reset times:';
          
          if (resetTimes.appTokens.length > 0) {
            errorMessage += `\n\nGitHub App tokens (${resetTimes.appTokens.length}):`;
            resetTimes.appTokens.forEach(token => {
              const resetDate = new Date(token.resetAt).toISOString();
              errorMessage += `\n  - Token ${token.index}: Resets at ${resetDate} (in ~${token.resetIn} minutes)`;
            });
          } else {
            errorMessage += `\n\nGitHub App tokens: ${hasApp ? 'configured but no tokens in cache' : 'not configured'}`;
          }
          
          if (resetTimes.regularTokens.length > 0) {
            errorMessage += `\n\nRegular tokens (${resetTimes.regularTokens.length}):`;
            resetTimes.regularTokens.forEach(token => {
              const resetDate = new Date(token.resetAt).toISOString();
              errorMessage += `\n  - Token ${token.index}: Resets at ${resetDate} (in ~${token.resetIn} minutes)`;
            });
          } else {
            errorMessage += `\n\nRegular tokens: ${hasRegular ? 'configured but no tokens in cache' : 'not configured'}`;
          }
          
          const allResetTimes = [...resetTimes.appTokens, ...resetTimes.regularTokens].map(t => t.resetAt);
          const earliestReset = allResetTimes.length > 0 ? Math.min(...allResetTimes) : Date.now();
          const earliestResetIn = Math.ceil((earliestReset - Date.now()) / 1000 / 60);
          const earliestResetDate = new Date(earliestReset).toISOString();
          
          errorMessage += `\n\nEarliest reset: ${earliestResetDate} (in ~${earliestResetIn} minutes)`;
          errorMessage += `\n\nNote: If tokens are from the same GitHub account, they share the same rate limit.`;
        }
        
        // Check if token is set by looking at the limit (5000 = token, 60 = no token)
        const hasToken = rateLimitLimit && parseInt(rateLimitLimit) >= 5000;
        if (hasToken) {
          errorMessage += '\n\nRate limit exhausted. Please wait for the limit to reset, or use a different GitHub token.';
          errorMessage += '\nThe fetch will automatically resume from where it left off when you try again.';
        } else {
          errorMessage += '\n\nTip: Set GITHUB_TOKEN environment variable for higher rate limits (5000/hour vs 60/hour)';
        }
        errorMessage += `\nProgress: Collected ${allIssueNumbers.length} issue numbers before hitting rate limit`;
      }
      
      throw new Error(errorMessage);
    }

    const issues = await response.json() as GitHubIssue[];
    
    // Filter out pull requests (issues have pull_request field set to null)
    const actualIssues = issues.filter(issue => !issue.pull_request);
    console.error(`[GitHub] Page ${page}: Found ${actualIssues.length} issues (${issues.length - actualIssues.length} PRs filtered out)`);
    
    // Collect issue numbers
    const issueNumbers = actualIssues.map(issue => issue.number);
    
    // Apply limit if specified
    if (limit !== undefined && allIssueNumbers.length + issueNumbers.length > limit) {
      const remaining = limit - allIssueNumbers.length;
      if (remaining > 0) {
        allIssueNumbers.push(...issueNumbers.slice(0, remaining));
      }
      console.error(`[GitHub] Reached limit of ${limit} issues. Stopping pagination.`);
      hasMore = false;
      break;
    }
    
    allIssueNumbers.push(...issueNumbers);
    console.error(`[GitHub] Page ${page} complete: Collected ${issueNumbers.length} issue numbers (total: ${allIssueNumbers.length})`);
    
    // Continue to next page if we got a full page of results (even if they were all PRs)
    // Stop if we got less than 100 results (last page) or no results at all
    if (issues.length === 0 || issues.length < 100) {
      hasMore = false;
      console.error(`[GitHub] Reached end of open issues (last page had ${issues.length} items)`);
    } else {
      page++;
      // Rate limit: wait a bit between pages
      const hasToken = !!(await getToken(tokenOrManager));
      await new Promise((resolve) => setTimeout(resolve, hasToken ? 100 : 1000));
    }
  }
  
  console.error(`[GitHub] Phase 1 complete: Collected ${allIssueNumbers.length} open issue numbers`);

  // Fetch closed issues if requested
  if (includeClosed) {
    page = 1;
    hasMore = true;
    switchInfo = ''; // Reset switch info for closed issues section
    
    console.error(`[GitHub] Fetching closed issues from ${repoOwner}/${repoName}...`);
    while (hasMore && (limit === undefined || allIssueNumbers.length < limit)) {
      let url = `https://api.github.com/repos/${repoOwner}/${repoName}/issues?state=closed&per_page=100&page=${page}&sort=updated&direction=desc`;
      if (since) {
        url += `&since=${encodeURIComponent(since)}`;
      }
      
      console.error(`[GitHub] Fetching closed issues page ${page}...`);
      
      // Get current token with proactive rotation (rotate when <= 2 remaining)
      let currentToken: string | undefined;
      if (tokenOrManager && tokenOrManager instanceof GitHubTokenManager) {
        currentToken = await tokenOrManager.getTokenWithProactiveRotation(2);
      } else {
        currentToken = await getToken(tokenOrManager);
      }
      headers = await createHeaders(tokenOrManager, currentToken); // Use specific token
      
      // Determine token type for logging
      let currentTokenType: 'app' | 'regular' | 'unknown' = 'unknown';
      if (currentToken && tokenOrManager && tokenOrManager instanceof GitHubTokenManager) {
        currentTokenType = tokenOrManager.getTokenType(currentToken);
      }
      
      const response = await fetch(url, { headers });
      
      // Update rate limit info if using token manager
      if (response.ok && currentToken) {
        updateRateLimit(response, tokenOrManager, currentToken);
      }
      
      // Log rate limit status periodically (every 5 pages)
      if (page % 5 === 1 && response.ok) {
        const rateLimitRemaining = response.headers.get('X-RateLimit-Remaining');
        const rateLimitLimit = response.headers.get('X-RateLimit-Limit');
        if (rateLimitRemaining !== null && rateLimitLimit) {
          const remaining = parseInt(rateLimitRemaining);
          const limit = parseInt(rateLimitLimit);
          const percentage = ((remaining / limit) * 100).toFixed(1);
          console.error(`[GitHub] Rate limit status: ${remaining}/${limit} remaining (${percentage}%)`);
          if (remaining < 100) {
            console.error(`[GitHub] Warning: Rate limit getting low! Consider using GITHUB_TOKEN for higher limits.`);
          }
        }
      }
      
      if (!response.ok) {
        const rateLimitRemaining = response.headers.get('X-RateLimit-Remaining');
        const rateLimitReset = response.headers.get('X-RateLimit-Reset');
        const rateLimitLimit = response.headers.get('X-RateLimit-Limit');
        
        // If rate limit error and using token manager, try to rotate token
        if ((response.status === 403 || response.status === 429) && tokenOrManager && tokenOrManager instanceof GitHubTokenManager) {
          // Update rate limit info for current token before rotating
          if (currentToken) {
            updateRateLimit(response, tokenOrManager, currentToken);
          }
          
          // Try to get next available token from existing tokens or GitHub Apps
          // Note: Rate limits are per GitHub user account for OAuth/PAT, per installation for GitHub Apps
          console.error(`[GitHub] Rate limit hit on current token, attempting to switch to next available token...`);
          const currentTokenType = tokenOrManager.getTokenType(currentToken || '');
          const currentTokenTypeName = currentTokenType === 'app' ? 'GitHub App' : currentTokenType === 'regular' ? 'regular' : 'unknown';
          const nextToken = await tokenOrManager.getNextAvailableToken();
          
          if (!nextToken) {
            console.error(`[GitHub] No available tokens found after attempting switch. All tokens exhausted.`);
            console.error(`[GitHub] All tokens exhausted. Rate limits are per GitHub user account.`);
            console.error(`[GitHub] To get separate rate limits, use tokens from different GitHub accounts via GITHUB_TOKEN (comma-separated).`);
            switchInfo = `\n  Switch attempted: Yes (from ${currentTokenTypeName} token)\n  Switch result: Failed - all tokens exhausted`;
          }
          
          if (nextToken) {
            const nextTokenType = tokenOrManager.getTokenType(nextToken);
            const nextTokenTypeName = nextTokenType === 'app' ? 'GitHub App installation token' : nextTokenType === 'regular' ? 'Regular user token (PAT/OAuth)' : 'Unknown token type';
            const nextTokenTypeShort = nextTokenType === 'app' ? 'GitHub App' : nextTokenType === 'regular' ? 'regular' : 'unknown';
            switchInfo = `\n  Switch attempted: Yes (from ${currentTokenTypeName} token)\n  Switch result: Success - switched to ${nextTokenTypeShort} token`;
            console.error(`[GitHub] Successfully switched from ${currentTokenTypeName} token to ${nextTokenTypeName}`);
            console.error(`[GitHub] Rate limit hit, rotating to next token...`);
            headers = await createHeaders(tokenOrManager, nextToken); // Use the specific new token
            // Retry the same request with new token
            const retryResponse = await fetch(url, { headers });
            
            // Update rate limit info for new token
            if (retryResponse.ok && nextToken) {
              updateRateLimit(retryResponse, tokenOrManager, nextToken);
            }
            
            if (retryResponse.ok) {
              // Success with new token, continue processing
              const issues = await retryResponse.json() as GitHubIssue[];
              const actualIssues = issues.filter(issue => !issue.pull_request);
              console.error(`[GitHub] Page ${page}: Found ${actualIssues.length} closed issues (${issues.length - actualIssues.length} PRs filtered out) after token rotation`);
              
              const issueNumbers = actualIssues.map(issue => issue.number);
              if (limit !== undefined && allIssueNumbers.length + issueNumbers.length > limit) {
                const remaining = limit - allIssueNumbers.length;
                if (remaining > 0) {
                  allIssueNumbers.push(...issueNumbers.slice(0, remaining));
                }
                console.error(`[GitHub] Reached limit of ${limit} issues. Stopping pagination.`);
                hasMore = false;
                break;
              }
              
              allIssueNumbers.push(...issueNumbers);
              console.error(`[GitHub] Page ${page} complete: Collected ${issueNumbers.length} issue numbers (total: ${allIssueNumbers.length})`);
              
              if (issues.length === 0 || issues.length < 100) {
                hasMore = false;
                console.error(`[GitHub] Reached end of closed issues (last page had ${issues.length} items)`);
              } else {
                page++;
                const hasToken = !!(await getToken(tokenOrManager));
                await new Promise((resolve) => setTimeout(resolve, hasToken ? 100 : 1000));
              }
              continue; // Continue to next iteration
            }
            // If retry also failed, fall through to error handling
          }
        }
        
      let errorMessage = `GitHub API error: ${response.status} ${response.statusText}`;
      
      if (response.status === 403 || response.status === 429) {
        errorMessage += '\n\nRate limit information:';
        if (rateLimitLimit) errorMessage += `\n  Limit: ${rateLimitLimit} requests/hour`;
        if (rateLimitRemaining !== null) errorMessage += `\n  Remaining: ${rateLimitRemaining} requests`;
        if (rateLimitReset) {
          const resetDate = new Date(parseInt(rateLimitReset) * 1000);
          const resetIn = Math.ceil((parseInt(rateLimitReset) * 1000 - Date.now()) / 1000 / 60);
          errorMessage += `\n  Resets at: ${resetDate.toISOString()} (in ~${resetIn} minutes)`;
        }
        
        // Show which token type was used when rate limit was hit
        if (currentToken && tokenOrManager && tokenOrManager instanceof GitHubTokenManager) {
          const tokenType = tokenOrManager.getTokenType(currentToken);
          const tokenTypeName = tokenType === 'app' ? 'GitHub App installation token' : tokenType === 'regular' ? 'Regular user token (PAT/OAuth)' : 'Unknown token type';
          errorMessage += `\n  Token used: ${tokenTypeName}`;
          
          // Add switch attempt information if available
          if (switchInfo) {
            errorMessage += switchInfo;
          }
        }
          
          // If using token manager, show detailed reset times for each token type
          if (tokenOrManager && tokenOrManager instanceof GitHubTokenManager) {
            const resetTimes = tokenOrManager.getResetTimesByType();
            const hasApp = !!(process.env.GITHUB_APP_ID && process.env.GITHUB_APP_INSTALLATION_ID);
            const hasRegular = !!(process.env.GITHUB_TOKEN);
            
            errorMessage += '\n\nToken reset times:';
            
            if (resetTimes.appTokens.length > 0) {
              errorMessage += `\n\nGitHub App tokens (${resetTimes.appTokens.length}):`;
              resetTimes.appTokens.forEach(token => {
                const resetDate = new Date(token.resetAt).toISOString();
                errorMessage += `\n  - Token ${token.index}: Resets at ${resetDate} (in ~${token.resetIn} minutes)`;
              });
            } else {
              errorMessage += `\n\nGitHub App tokens: ${hasApp ? 'configured but no tokens in cache' : 'not configured'}`;
            }
            
            if (resetTimes.regularTokens.length > 0) {
              errorMessage += `\n\nRegular tokens (${resetTimes.regularTokens.length}):`;
              resetTimes.regularTokens.forEach(token => {
                const resetDate = new Date(token.resetAt).toISOString();
                errorMessage += `\n  - Token ${token.index}: Resets at ${resetDate} (in ~${token.resetIn} minutes)`;
              });
            } else {
              errorMessage += `\n\nRegular tokens: ${hasRegular ? 'configured but no tokens in cache' : 'not configured'}`;
            }
            
            const allResetTimes = [...resetTimes.appTokens, ...resetTimes.regularTokens].map(t => t.resetAt);
            const earliestReset = allResetTimes.length > 0 ? Math.min(...allResetTimes) : Date.now();
            const earliestResetIn = Math.ceil((earliestReset - Date.now()) / 1000 / 60);
            const earliestResetDate = new Date(earliestReset).toISOString();
            
            errorMessage += `\n\nEarliest reset: ${earliestResetDate} (in ~${earliestResetIn} minutes)`;
            errorMessage += `\n\nNote: If tokens are from the same GitHub account, they share the same rate limit.`;
          }
          
          // Check if token is set by looking at the limit (5000 = token, 60 = no token)
          const hasToken = rateLimitLimit && parseInt(rateLimitLimit) >= 5000;
          if (hasToken) {
            errorMessage += '\n\nRate limit exhausted. Please wait for the limit to reset, or use a different GitHub token.';
            errorMessage += '\nThe fetch will automatically resume from where it left off when you try again.';
          } else {
            errorMessage += '\n\nTip: Set GITHUB_TOKEN environment variable for higher rate limits (5000/hour vs 60/hour)';
          }
          errorMessage += `\nProgress: Collected ${allIssueNumbers.length} issue numbers before hitting rate limit`;
        }
        
        throw new Error(errorMessage);
      }

      const issues = await response.json() as GitHubIssue[];
      
      // Filter out pull requests (issues have pull_request field set to null)
      const actualIssues = issues.filter(issue => !issue.pull_request);
      console.error(`[GitHub] Page ${page}: Found ${actualIssues.length} closed issues (${issues.length - actualIssues.length} PRs filtered out)`);
      
      // Collect issue numbers
      const issueNumbers = actualIssues.map(issue => issue.number);
      
      // Apply limit if specified
      if (limit !== undefined && allIssueNumbers.length + issueNumbers.length > limit) {
        const remaining = limit - allIssueNumbers.length;
        if (remaining > 0) {
          allIssueNumbers.push(...issueNumbers.slice(0, remaining));
        }
        console.error(`[GitHub] Reached limit of ${limit} issues. Stopping pagination.`);
        hasMore = false;
        break;
      }
      
      allIssueNumbers.push(...issueNumbers);
      console.error(`[GitHub] Page ${page} complete: Collected ${issueNumbers.length} issue numbers (total: ${allIssueNumbers.length})`);
      
      // Continue to next page if we got a full page of results (even if they were all PRs)
      // Stop if we got less than 100 results (last page) or no results at all
      if (issues.length === 0 || issues.length < 100) {
        hasMore = false;
        console.error(`[GitHub] Reached end of closed issues (last page had ${issues.length} items)`);
      } else {
        page++;
        // Rate limit: wait a bit between pages
        const hasToken = !!(await getToken(tokenOrManager));
        await new Promise((resolve) => setTimeout(resolve, hasToken ? 100 : 1000));
      }
    }
    
    console.error(`[GitHub] Phase 1 complete: Collected ${allIssueNumbers.length} total issue numbers (open + closed)`);
  }
  
  // Phase 2: Batch fetch issue details in parallel
  console.error(`[GitHub] Phase 2: Batch fetching issue details for ${allIssueNumbers.length} issues...`);
  
  // Determine initial batch size based on whether we have a token
  // Will be adjusted dynamically based on rate limit
  const hasToken = !!(await getToken(tokenOrManager));
  const initialBatchSize = hasToken ? 10 : 3;
  console.error(`[GitHub] Using initial batch size: ${initialBatchSize} issues per batch`);
  
  // Create map of existing issues for fast lookup
  const existingIssuesMap = new Map<number, GitHubIssue>();
  if (existingIssues.length > 0) {
    for (const issue of existingIssues) {
      existingIssuesMap.set(issue.number, issue);
    }
    console.error(`[GitHub] Resume mode: ${existingIssues.length} issues already in cache`);
  }
  
  const allIssues = await batchFetchIssueDetails(
    allIssueNumbers,
    tokenOrManager,
    owner,
    repo,
    includeComments,
    initialBatchSize,
    existingIssuesMap,
    onBatchComplete
  );
  
  const openCount = allIssues.filter(i => i.state === 'open').length;
  const closedCount = allIssues.filter(i => i.state === 'closed').length;
  console.error(`[GitHub] Phase 2 complete: Fetched ${allIssues.length} issues with full details (${openCount} open, ${closedCount} closed)`);
  
  return allIssues;
}

/**
 * Get pull requests linked to a GitHub issue
 * Uses GitHub's search API to find PRs that reference the issue
 * PRs are linked via "Closes #123", "Fixes #123", "Resolves #123" in PR description
 */
export interface GitHubPR {
  number: number;
  title: string;
  state: "open" | "closed";
  merged: boolean;
  html_url: string;
  user: {
    login: string;
    avatar_url: string;
  };
  created_at: string;
  updated_at: string;
  head: {
    ref: string;
  };
  base: {
    ref: string;
  };
  body?: string;
}

/**
 * Get pull requests linked to a GitHub issue
 * Uses the issue timeline API to find PRs that reference the issue
 * This uses the same repository API endpoint pattern as fetchAllGitHubIssues
 */
export async function getPRsForIssue(
  issueNumber: number,
  tokenOrManager?: string | GitHubTokenManager,
  owner?: string,
  repo?: string
): Promise<GitHubPR[]> {
  const config = getConfig();
  const repoOwner = owner || config.github.owner;
  const repoName = repo || config.github.repo;
  
  let headers = await createHeaders(tokenOrManager);
  
  // Use repository pulls API to find PRs that reference the issue (same pattern as fetchAllGitHubIssues)
  // We'll paginate through open PRs and check their body for issue references
  // This uses the same repository API endpoint pattern, avoiding the search API
  const linkedPRs: GitHubPR[] = [];
  let page = 1;
  let hasMore = true;
  
  // Filter pattern: PRs reference issues with patterns like: "Closes #123", "Fixes #123", "Resolves #123", or just "#123"
  const issueRefPattern = new RegExp(`(?:closes?|fixes?|resolves?|refs?)\\s*#${issueNumber}\\b|#${issueNumber}\\b`, 'i');
  
  try {
    while (hasMore) {
      const pullsUrl = `https://api.github.com/repos/${repoOwner}/${repoName}/pulls?state=open&per_page=100&page=${page}&sort=updated&direction=desc`;
      
      let currentToken = await getToken(tokenOrManager);
      headers = await createHeaders(tokenOrManager);
      let response = await fetch(pullsUrl, { headers });
      
      // Update rate limit info if using token manager
      if (response.ok && currentToken) {
        updateRateLimit(response, tokenOrManager, currentToken);
      }
      
      if (!response.ok) {
        // Handle rate limits and token rotation (same pattern as fetchAllGitHubIssues)
        if ((response.status === 403 || response.status === 429) && tokenOrManager && tokenOrManager instanceof GitHubTokenManager) {
          if (currentToken) {
            updateRateLimit(response, tokenOrManager, currentToken);
          }
          
          const nextToken = await tokenOrManager.getNextAvailableToken();
          if (nextToken) {
            headers = await createHeaders(tokenOrManager, nextToken);
            response = await fetch(pullsUrl, { headers });
            
            if (response.ok && nextToken) {
              updateRateLimit(response, tokenOrManager, nextToken);
            }
          }
        }
        
        if (!response.ok) {
          if (page === 1) {
            log(`Failed to fetch PRs for issue #${issueNumber}: ${response.status}`);
          }
          break;
        }
      }
      
      const pagePRs = await response.json() as GitHubPR[];
      
      if (pagePRs.length === 0) {
        hasMore = false;
        break;
      }
      
      // Filter PRs that reference this issue in their body/description
      for (const pr of pagePRs) {
        const body = pr.body || '';
        if (issueRefPattern.test(body)) {
          linkedPRs.push(pr);
        }
      }
      
      // Stop if we got fewer than 100 PRs (last page)
      if (pagePRs.length < 100) {
        hasMore = false;
      } else {
        page++;
        // Add a small delay between pages to be respectful
        await new Promise(resolve => setTimeout(resolve, 100));
      }
    }
    
    return linkedPRs;
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    log(`[ERROR] Failed to fetch PRs for issue #${issueNumber}: ${errorMsg}`);
    return [];
  }
}

/**
 * Fetch full PR details for a list of PR numbers
 */
async function fetchPRDetails(
  prNumbers: number[],
  owner: string,
  repo: string,
  headers: Record<string, string>,
  tokenOrManager?: string | GitHubTokenManager
): Promise<GitHubPR[]> {
  const prs: GitHubPR[] = [];
  
  for (const prNumber of prNumbers) {
    try {
      const prUrl = `https://api.github.com/repos/${owner}/${repo}/pulls/${prNumber}`;
      let prResponse = await fetch(prUrl, { headers });
      
      if (!prResponse.ok) {
        if (prResponse.status === 403 || prResponse.status === 429) {
          // Try token rotation
          if (tokenOrManager && tokenOrManager instanceof GitHubTokenManager) {
            const nextToken = await tokenOrManager.getNextAvailableToken();
            if (nextToken) {
              headers.Authorization = `Bearer ${nextToken}`;
              prResponse = await fetch(prUrl, { headers });
            }
          }
        }
        
        if (!prResponse.ok) {
          continue;
        }
      }
      
      const pr = await prResponse.json() as GitHubPR;
      prs.push(pr);
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      log(`Warning: Failed to fetch PR #${prNumber}: ${errorMsg}`);
      continue;
    }
  }
  
  return prs;
}

/**
 * Format GitHub issue for display
 */
export function formatGitHubIssue(issue: GitHubIssue): string {
  const labels = issue.labels.map((l) => l.name).join(", ");
  const createdAt = new Date(issue.created_at).toLocaleDateString();
  const updatedAt = new Date(issue.updated_at).toLocaleDateString();

  return `#${issue.number}: ${issue.title}
State: ${issue.state}
Labels: ${labels || "none"}
Created: ${createdAt} | Updated: ${updatedAt}
Author: ${issue.user.login}
URL: ${issue.html_url}
${issue.body ? `\n${issue.body.substring(0, 200)}${issue.body.length > 200 ? "..." : ""}` : ""}`;
}

/**
 * Issues cache file structure
 */
export interface IssuesCache {
  fetched_at: string;
  total_count: number;
  open_count: number;
  closed_count: number;
  issues: GitHubIssue[];
}

/**
 * Load issues from JSON cache file
 */
export async function loadIssuesFromCache(
  cachePath: string
): Promise<IssuesCache> {
  const { readFile } = await import("fs/promises");
  const { join } = await import("path");
  
  const filePath = cachePath.startsWith("/")
    ? cachePath
    : join(process.cwd(), cachePath);

  const content = await readFile(filePath, "utf-8");
  return JSON.parse(content) as IssuesCache;
}

/**
 * Get the most recent date from cache (checks both created_at and updated_at)
 * Returns the ISO date string of the most recent date, or undefined if cache is empty
 * This ensures we don't miss any issues (new or updated)
 */
export function getMostRecentUpdateDate(cache: IssuesCache): string | undefined {
  if (!cache.issues || cache.issues.length === 0) {
    return undefined;
  }

  // Find the most recent timestamp from either created_at or updated_at
  let mostRecentTime = 0;

  cache.issues.forEach(issue => {
    const createdTime = new Date(issue.created_at).getTime();
    const updatedTime = new Date(issue.updated_at).getTime();
    const maxTime = Math.max(createdTime, updatedTime);
    
    if (maxTime > mostRecentTime) {
      mostRecentTime = maxTime;
    }
  });

  return new Date(mostRecentTime).toISOString();
}

/**
 * Merge new issues with existing cache
 * Updates existing issues (by ID) and adds new ones
 */
export function mergeIssues(existing: GitHubIssue[], newIssues: GitHubIssue[]): GitHubIssue[] {
  const issueMap = new Map<number, GitHubIssue>();
  
  // Add all existing issues to map
  existing.forEach(issue => {
    issueMap.set(issue.number, issue);
  });
  
  // Update or add new issues
  newIssues.forEach(issue => {
    issueMap.set(issue.number, issue);
  });
  
  // Convert back to array and sort by number
  return Array.from(issueMap.values()).sort((a, b) => b.number - a.number);
}


