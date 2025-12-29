/**
 * GitHub integration for searching repository issues
 */
import { getConfig } from "../../config/index.js";
import { log } from "../../mcp/logger.js";

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

  const data = await response.json();
  return data;
}

/**
 * Fetch comments for a specific GitHub issue
 */
export async function fetchIssueComments(
  issueNumber: number,
  token?: string,
  owner?: string,
  repo?: string
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
        errorMessage += '\n\nTip: Set GITHUB_TOKEN environment variable for higher rate limits (5000/hour vs 60/hour)';
      }
      
      throw new Error(errorMessage);
    }

    const comments: GitHubComment[] = await response.json();
    
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

  const issue: GitHubIssue = await issueResponse.json();

  // Fetch comments if requested (always try to fetch, even if comments_count is 0 or missing)
  if (includeComments) {
    try {
      issue.comments = await fetchIssueComments(issueNumber, token, owner, repo);
    } catch (error) {
      log(`Warning: Failed to fetch comments for issue #${issueNumber}: ${error}`);
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
  token: string | undefined,
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
  
  for (let i = 0; i < issuesToFetch.length; i += batchSize) {
    const batch = issuesToFetch.slice(i, i + batchSize);
    const batchNum = Math.floor(i / batchSize) + 1;
    const totalBatches = Math.ceil(issuesToFetch.length / batchSize);
    
    console.error(`[GitHub] Fetching batch ${batchNum}/${totalBatches} (${batch.length} issues)...`);
    
    const batchPromises = batch.map(async (issueNumber) => {
      try {
        return await fetchIssueDetails(issueNumber, token, owner, repo, includeComments);
      } catch (error) {
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
    if (i + batchSize < issuesToFetch.length) {
      await new Promise((resolve) => setTimeout(resolve, token ? 100 : 500));
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
export async function fetchAllGitHubIssues(
  token?: string,
  includeClosed = true,
  owner?: string,
  repo?: string,
  since?: string,
  limit?: number,
  includeComments = true,
  existingIssues: GitHubIssue[] = [],
  onBatchComplete?: (issues: GitHubIssue[]) => Promise<void>
): Promise<GitHubIssue[]> {
  const config = getConfig();
  const repoOwner = owner || config.github.owner;
  const repoName = repo || config.github.repo;
  const allIssueNumbers: number[] = [];
  
  const headers: Record<string, string> = {
    Accept: "application/vnd.github.v3+json",
  };

  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }

  // Phase 1: Paginate through all pages to collect issue numbers
  console.error(`[GitHub] Phase 1: Paginating through issue lists...`);
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
  
  while (hasMore && (limit === undefined || allIssueNumbers.length < limit)) {
    let url = `https://api.github.com/repos/${repoOwner}/${repoName}/issues?state=open&per_page=100&page=${page}&sort=updated&direction=desc`;
    if (since) {
      url += `&since=${encodeURIComponent(since)}`;
    }
    
    console.error(`[GitHub] Fetching open issues page ${page}...`);
    const response = await fetch(url, { headers });
    
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
        errorMessage += '\n\nTip: Set GITHUB_TOKEN environment variable for higher rate limits (5000/hour vs 60/hour)';
        errorMessage += `\nProgress: Collected ${allIssueNumbers.length} issue numbers before hitting rate limit`;
      }
      
      throw new Error(errorMessage);
    }

    const issues: GitHubIssue[] = await response.json();
    
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
      await new Promise((resolve) => setTimeout(resolve, token ? 100 : 1000));
    }
  }
  
  console.error(`[GitHub] Phase 1 complete: Collected ${allIssueNumbers.length} open issue numbers`);

  // Fetch closed issues if requested
  if (includeClosed) {
    page = 1;
    hasMore = true;
    
    console.error(`[GitHub] Fetching closed issues from ${repoOwner}/${repoName}...`);
    while (hasMore && (limit === undefined || allIssueNumbers.length < limit)) {
      let url = `https://api.github.com/repos/${repoOwner}/${repoName}/issues?state=closed&per_page=100&page=${page}&sort=updated&direction=desc`;
      if (since) {
        url += `&since=${encodeURIComponent(since)}`;
      }
      
      console.error(`[GitHub] Fetching closed issues page ${page}...`);
      const response = await fetch(url, { headers });
      
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
          errorMessage += '\n\nTip: Set GITHUB_TOKEN environment variable for higher rate limits (5000/hour vs 60/hour)';
          errorMessage += `\nProgress: Collected ${allIssueNumbers.length} issue numbers before hitting rate limit`;
        }
        
        throw new Error(errorMessage);
      }

      const issues: GitHubIssue[] = await response.json();
      
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
        await new Promise((resolve) => setTimeout(resolve, token ? 100 : 1000));
      }
    }
    
    console.error(`[GitHub] Phase 1 complete: Collected ${allIssueNumbers.length} total issue numbers (open + closed)`);
  }
  
  // Phase 2: Batch fetch issue details in parallel
  console.error(`[GitHub] Phase 2: Batch fetching issue details for ${allIssueNumbers.length} issues...`);
  const batchSize = token ? 10 : 3; // More aggressive batching with token
  console.error(`[GitHub] Using batch size: ${batchSize} issues per batch`);
  
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
    token,
    owner,
    repo,
    includeComments,
    batchSize,
    existingIssuesMap,
    onBatchComplete
  );
  
  const openCount = allIssues.filter(i => i.state === 'open').length;
  const closedCount = allIssues.filter(i => i.state === 'closed').length;
  console.error(`[GitHub] Phase 2 complete: Fetched ${allIssues.length} issues with full details (${openCount} open, ${closedCount} closed)`);
  
  return allIssues;
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


