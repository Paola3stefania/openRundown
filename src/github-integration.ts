/**
 * GitHub integration for searching repository issues
 */
import { getConfig } from "./config.js";
import { log } from "./logger.js";

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
 * Fetch all GitHub issues (both open and closed) from a repository
 * Handles pagination to get all issues
 * 
 * @param token - GitHub API token (optional but recommended)
 * @param includeClosed - Whether to include closed issues
 * @param owner - Repository owner (defaults to config)
 * @param repo - Repository name (defaults to config)
 * @param since - ISO date string - only fetch issues updated after this date (for incremental updates)
 */
export async function fetchAllGitHubIssues(
  token?: string,
  includeClosed = true,
  owner?: string,
  repo?: string,
  since?: string
): Promise<GitHubIssue[]> {
  const config = getConfig();
  const repoOwner = owner || config.github.owner;
  const repoName = repo || config.github.repo;
  const allIssues: GitHubIssue[] = [];
  
  const headers: Record<string, string> = {
    Accept: "application/vnd.github.v3+json",
  };

  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }

  // Fetch open issues
  let page = 1;
  let hasMore = true;
  
  // Reduced logging to avoid MCP client JSON parsing errors
  // log("Fetching open issues...");
  while (hasMore) {
    let url = `https://api.github.com/repos/${repoOwner}/${repoName}/issues?state=open&per_page=100&page=${page}&sort=updated&direction=desc`;
    if (since) {
      url += `&since=${encodeURIComponent(since)}`;
    }
    
    const response = await fetch(url, { headers });
    
    if (!response.ok) {
      throw new Error(
        `GitHub API error: ${response.status} ${response.statusText}`
      );
    }

    const issues: any[] = await response.json();
    
    // Filter out pull requests (issues have pull_request field set to null)
    const actualIssues = issues.filter(issue => !issue.pull_request);
    
    // Add actual issues to our collection
    if (actualIssues.length > 0) {
      allIssues.push(...actualIssues as GitHubIssue[]);
      // Reduced logging to avoid MCP client JSON parsing errors
      // log(`   Fetched ${actualIssues.length} open issues (total: ${allIssues.length})`);
    }
    
    // Continue to next page if we got a full page of results (even if they were all PRs)
    // Stop if we got less than 100 results (last page) or no results at all
    if (issues.length === 0 || issues.length < 100) {
      hasMore = false;
    } else {
      page++;
      // Rate limit: wait a bit between pages
      await new Promise((resolve) => setTimeout(resolve, token ? 100 : 1000));
    }
  }

  // Fetch closed issues if requested
  if (includeClosed) {
    page = 1;
    hasMore = true;
    
    // Reduced logging to avoid MCP client JSON parsing errors
    // log("Fetching closed issues...");
    while (hasMore) {
      let url = `https://api.github.com/repos/${repoOwner}/${repoName}/issues?state=closed&per_page=100&page=${page}&sort=updated&direction=desc`;
      if (since) {
        url += `&since=${encodeURIComponent(since)}`;
      }
      
      const response = await fetch(url, { headers });
      
      if (!response.ok) {
        throw new Error(
          `GitHub API error: ${response.status} ${response.statusText}`
        );
      }

      const issues: any[] = await response.json();
      
      // Filter out pull requests (issues have pull_request field set to null)
      const actualIssues = issues.filter(issue => !issue.pull_request);
      
      // Add actual issues to our collection
      if (actualIssues.length > 0) {
        allIssues.push(...actualIssues as GitHubIssue[]);
        // Reduced logging to avoid MCP client JSON parsing errors
        // log(`   Fetched ${actualIssues.length} closed issues (total: ${allIssues.length})`);
      }
      
      // Continue to next page if we got a full page of results (even if they were all PRs)
      // Stop if we got less than 100 results (last page) or no results at all
      if (issues.length === 0 || issues.length < 100) {
        hasMore = false;
      } else {
        page++;
        // Rate limit: wait a bit between pages
        await new Promise((resolve) => setTimeout(resolve, token ? 100 : 1000));
      }
    }
  }

  // Reduced logging to avoid MCP client JSON parsing errors
  // log(`Total issues fetched: ${allIssues.length} (${allIssues.filter(i => i.state === 'open').length} open, ${allIssues.filter(i => i.state === 'closed').length} closed)\n`);
  
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


