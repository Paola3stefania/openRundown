/**
 * Export grouping results to PM tools
 * Converts semantic grouping output to PM tool issues
 */

import { log, logError } from "../mcp/logger.js";
import { createPMTool } from "./factory.js";
import type { PMToolConfig, PMToolIssue } from "./types.js";
import type { ExportWorkflowResult } from "./workflow.js";
import { getConfig } from "../config/index.js";
import { join } from "path";

interface GroupingSignal {
  source: string;
  id: string;
  title: string;
  url: string;
}

interface GroupingGroup {
  id: string;
  suggested_title?: string; // Optional - may come from github_issue.title for issue-based grouping
  github_issue?: {
    number: number;
    title: string;
    url: string;
    state: string;
    labels?: string[];
  };
  similarity?: number;
  avg_similarity?: number; // Issue-based grouping uses avg_similarity
  is_cross_cutting?: boolean;
  affects_features?: Array<{ id: string; name: string }>;
  signals?: GroupingSignal[];
  threads?: Array<{ // Issue-based grouping format
    thread_id: string;
    thread_name?: string;
    similarity_score: number;
    url?: string;
    author?: string;
  }>;
  canonical_issue?: {
    source: string;
    id: string;
    title?: string;
    url: string;
  } | null;
  // Export tracking fields
  status?: "pending" | "exported";
  exported_at?: string;
  linear_issue_id?: string;
  linear_issue_url?: string;
  linear_issue_identifier?: string; // e.g., "LIN-123"
  linear_project_ids?: string[];
}

interface GroupingData {
  timestamp: string;
  channel_id: string;
  stats: {
    totalSignals: number;
    groupedSignals: number;
    crossCuttingGroups: number;
  };
  features: Array<{ id: string; name: string }>;
  groups: GroupingGroup[];
  ungrouped_threads?: Array<{
    thread_id: string;
    thread_name?: string;
    url?: string;
    author?: string;
    timestamp?: string;
    reason: "no_matches" | "below_threshold";
    export_status?: "pending" | "exported" | null;
    exported_at?: string;
    linear_issue_id?: string;
    linear_issue_url?: string;
    linear_issue_identifier?: string;
    top_issue?: {
      number: number;
      title: string;
      similarity_score: number;
    };
    affects_features?: Array<{ id: string; name: string }>;
  }>;
}

/**
 * Generate a proper title for a group using LLM
 * Creates concise, descriptive titles following PR naming conventions
 */
async function generateGroupTitleWithLLM(group: GroupingGroup): Promise<string> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    // Fallback to non-LLM title if API key not available
    return generateFallbackTitle(group);
  }

  // Collect content from GitHub issues and threads
  const contentParts: string[] = [];
  
  if (group.github_issue) {
    contentParts.push(`GitHub Issue #${group.github_issue.number}: ${group.github_issue.title}`);
  }
  
  if (group.threads && group.threads.length > 0) {
    const threadInfo = group.threads
      .map(t => t.thread_name || `Thread ${t.thread_id}`)
      .slice(0, 5) // Limit to first 5 threads to avoid token limits
      .join(", ");
    contentParts.push(`Discord Threads: ${threadInfo}`);
  }

  if (contentParts.length === 0) {
    return generateFallbackTitle(group);
  }

  const contentToAnalyze = contentParts.join("\n\n");

  try {
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
            content: `You are a technical writer creating concise issue titles. Generate a single, clear title (max 100 characters) that summarizes the problem or feature request.

Follow these guidelines:
- Be specific and actionable
- Use present tense ("Fix bug" not "Fixed bug")
- If it's a bug fix, start with "fix:"
- If it's a feature, start with "feat:"
- If it's documentation, start with "docs:"
- Keep it under 100 characters
- Don't include issue numbers or IDs
- Focus on the core problem or request

Return ONLY the title text, nothing else.`
          },
          {
            role: "user",
            content: `Generate a concise title for this group:\n\n${contentToAnalyze}`
          }
        ],
        temperature: 0.3,
        max_tokens: 150,
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      logError(`OpenAI API error for title generation: ${response.status} ${errorText}`);
      return generateFallbackTitle(group);
    }

    const data = await response.json() as { choices?: Array<{ message?: { content?: string } }> };
    const title = data.choices?.[0]?.message?.content?.trim();
    
    if (title && title.length > 0 && title.length <= 150) {
      // Truncate if slightly over limit
      return title.length > 100 ? title.substring(0, 97) + "..." : title;
    }
    
    return generateFallbackTitle(group);
  } catch (error) {
    logError("Error generating title with LLM:", error);
    return generateFallbackTitle(group);
  }
}

/**
 * Calculate priority based on labels, title, and other signals
 * Returns "urgent" | "high" | "medium" | "low"
 * Priority order: security > bugs > cross-cutting > regular
 */
/**
 * Extract last comment date text from issueComments JSON
 * Returns formatted text like "2 days ago" or null if no comments
 */
function extractLastCommentText(issueComments: unknown): string | null {
  if (!issueComments) {
    return null;
  }

  const comments = issueComments as Array<{
    created_at?: string;
    updated_at?: string;
    body?: string;
  }>;

  if (!Array.isArray(comments) || comments.length === 0) {
    return null;
  }

  // Find the most recent comment by created_at
  const commentsWithDates = comments
    .map(c => {
      const dateStr = c.created_at || c.updated_at;
      if (!dateStr) return null;
      return new Date(dateStr);
    })
    .filter((c): c is Date => c !== null);

  if (commentsWithDates.length === 0) {
    return null;
  }

  // Sort by date descending (most recent first)
  commentsWithDates.sort((a, b) => b.getTime() - a.getTime());
  const lastCommentDate = commentsWithDates[0];

  // Calculate days ago
  const now = new Date();
  const diffMs = now.getTime() - lastCommentDate.getTime();
  const daysAgo = Math.floor(diffMs / (1000 * 60 * 60 * 24));

  // Format display text (only days and above, since we update daily)
  if (daysAgo === 0) {
    return "today";
  } else if (daysAgo === 1) {
    return "yesterday";
  } else if (daysAgo < 7) {
    return `${daysAgo} days ago`;
  } else if (daysAgo < 30) {
    const weeksAgo = Math.floor(daysAgo / 7);
    return `${weeksAgo} week${weeksAgo === 1 ? "" : "s"} ago`;
  } else if (daysAgo < 365) {
    const monthsAgo = Math.floor(daysAgo / 30);
    return `${monthsAgo} month${monthsAgo === 1 ? "" : "s"} ago`;
  } else {
    const yearsAgo = Math.floor(daysAgo / 365);
    return `${yearsAgo} year${yearsAgo === 1 ? "" : "s"} ago`;
  }
}

/**
 * Extract last comment date text from multiple issues (for groups)
 * Returns the most recent comment date across all issues
 */
function extractLastCommentTextFromIssues(issues: Array<{ issueComments?: unknown }>): string | null {
  const allCommentDates: Date[] = [];

  for (const issue of issues) {
    if (!issue.issueComments) continue;
    const comments = issue.issueComments as Array<{
      created_at?: string;
      updated_at?: string;
    }>;

    if (!Array.isArray(comments) || comments.length === 0) {
      continue;
    }

    for (const comment of comments) {
      const dateStr = comment.created_at || comment.updated_at;
      if (dateStr) {
        const date = new Date(dateStr);
        if (!isNaN(date.getTime())) {
          allCommentDates.push(date);
        }
      }
    }
  }

  if (allCommentDates.length === 0) {
    return null;
  }

  // Find the most recent date across all issues
  allCommentDates.sort((a, b) => b.getTime() - a.getTime());
  const lastCommentDate = allCommentDates[0];

  // Calculate days ago
  const now = new Date();
  const diffMs = now.getTime() - lastCommentDate.getTime();
  const daysAgo = Math.floor(diffMs / (1000 * 60 * 60 * 24));

  // Format display text (only days and above, since we update daily)
  if (daysAgo === 0) {
    return "today";
  } else if (daysAgo === 1) {
    return "yesterday";
  } else if (daysAgo < 7) {
    return `${daysAgo} days ago`;
  } else if (daysAgo < 30) {
    const weeksAgo = Math.floor(daysAgo / 7);
    return `${weeksAgo} week${weeksAgo === 1 ? "" : "s"} ago`;
  } else if (daysAgo < 365) {
    const monthsAgo = Math.floor(daysAgo / 30);
    return `${monthsAgo} month${monthsAgo === 1 ? "" : "s"} ago`;
  } else {
    const yearsAgo = Math.floor(daysAgo / 365);
    return `${yearsAgo} year${yearsAgo === 1 ? "" : "s"} ago`;
  }
}

function calculatePriority(options: {
  labels?: string[];
  title?: string;
  is_cross_cutting?: boolean;
  thread_count?: number;
  is_ungrouped?: boolean;
}): "urgent" | "high" | "medium" | "low" {
  const { labels = [], title = "", is_cross_cutting = false, thread_count = 0, is_ungrouped = false } = options;
  
  // Normalize labels and title for matching
  const normalizedLabels = labels.map(l => l.toLowerCase().trim());
  const normalizedTitle = title.toLowerCase();
  
  // Security patterns - HIGHEST priority (urgent)
  const securityPatterns = [
    "security",
    "vulnerability",
    "cve",
    "exploit",
    "xss",
    "csrf",
    "injection",
    "auth bypass",
    "authentication bypass",
    "authorization bypass",
    "privilege escalation",
    "data leak",
    "data breach",
    "sensitive data",
    "credentials",
    "password leak",
    "token leak",
    "api key",
  ];
  
  // Regression patterns - HIGH priority (was working, now broken)
  const regressionPatterns = [
    "regression",
    "regressed",
    "broke after",
    "broken after",
    "stopped working",
    "no longer works",
    "used to work",
    "was working",
    "worked before",
    "after update",
    "after upgrade",
    "after release",
    "since update",
    "since upgrade",
    "since release",
    "after deploy",
    "since deploy",
  ];
  
  // Bug patterns - HIGH priority
  const bugPatterns = [
    "bug",
    "bug-report",
    "defect",
    "error",
    "crash",
    "broken",
    "not working",
    "doesn't work",
    "does not work",
    "fails",
    "failing",
    "failure",
    "critical",
    "blocker",
    "p0",
    "p1",
    "severity-critical",
    "severity-high",
  ];
  
  // Urgent patterns - can elevate any issue
  const urgentPatterns = [
    "urgent",
    "critical",
    "blocker",
    "production",
    "outage",
    "down",
    "emergency",
    "asap",
    "p0",
  ];
  
  // Enhancement/feature request patterns - LOW priority
  const enhancementPatterns = [
    "enhancement",
    "feature request",
    "feature-request",
    "new feature",
    "would be nice",
    "would be great",
    "suggestion",
    "idea",
    "proposal",
    "rfc",
    "wishlist",
    "nice to have",
    "nice-to-have",
    "could we have",
    "can we have",
    "please add",
    "requesting",
    "request for",
    "improvement",
    "improve",
  ];
  
  // Check for security issues (URGENT priority)
  for (const pattern of securityPatterns) {
    if (normalizedLabels.some(l => l.includes(pattern)) || normalizedTitle.includes(pattern)) {
      return "urgent";
    }
  }
  
  // Check for urgent patterns
  const isUrgent = urgentPatterns.some(pattern => 
    normalizedLabels.some(l => l.includes(pattern)) || normalizedTitle.includes(pattern)
  );
  
  // Check for regression patterns (HIGH priority - was working, now broken)
  for (const pattern of regressionPatterns) {
    if (normalizedLabels.some(l => l.includes(pattern)) || normalizedTitle.includes(pattern)) {
      return isUrgent ? "urgent" : "high";
    }
  }
  
  // Check for bug patterns (HIGH priority, or URGENT if also marked urgent)
  for (const pattern of bugPatterns) {
    if (normalizedLabels.some(l => l.includes(pattern)) || normalizedTitle.includes(pattern)) {
      return isUrgent ? "urgent" : "high";
    }
  }
  
  // Cross-cutting issues affect multiple features - HIGH priority
  if (is_cross_cutting) {
    return isUrgent ? "urgent" : "high";
  }
  
  // Issues with many threads (3+) indicate widespread impact - elevate to HIGH
  if (thread_count >= 3) {
    return isUrgent ? "urgent" : "high";
  }
  
  // Enhancement/feature requests - LOW priority (unless marked urgent)
  for (const pattern of enhancementPatterns) {
    if (normalizedLabels.some(l => l.includes(pattern)) || normalizedTitle.includes(pattern)) {
      return isUrgent ? "medium" : "low";
    }
  }
  
  // Documentation and assistance - LOW priority
  const lowPriorityPatterns = ["documentation", "assistance", "docs", "question", "how to", "help"];
  for (const pattern of lowPriorityPatterns) {
    if (normalizedLabels.some(l => l.includes(pattern)) || normalizedTitle.includes(pattern)) {
      return "low";
    }
  }
  
  // Ungrouped items are lower priority (less clear impact)
  if (is_ungrouped) {
    return isUrgent ? "medium" : "low";
  }
  
  // Default: medium priority
  return isUrgent ? "high" : "medium";
}

/**
 * Get auto-generated labels based on patterns detected in labels and title
 * Returns labels like "security", "bug", "regression", "urgent" that should be added
 * This is a fast fallback when LLM is not available
 */
function getAutoLabelsFromPatterns(options: {
  labels?: string[];
  title?: string;
}): string[] {
  const { labels = [], title = "" } = options;
  const autoLabels: string[] = [];
  
  // Normalize for matching
  const normalizedLabels = labels.map(l => l.toLowerCase().trim());
  const normalizedTitle = title.toLowerCase();
  
  // Security patterns
  const securityPatterns = [
    "security", "vulnerability", "cve", "exploit", "xss", "csrf", "injection",
    "auth bypass", "authentication bypass", "authorization bypass",
    "privilege escalation", "data leak", "data breach", "sensitive data",
    "credentials", "password leak", "token leak", "api key",
  ];
  
  // Regression patterns (was working, now broken after release/update)
  const regressionPatterns = [
    "regression", "regressed", "broke after", "broken after", "stopped working",
    "no longer works", "used to work", "was working", "worked before",
    "after update", "after upgrade", "after release", "since update",
    "since upgrade", "since release", "after deploy", "since deploy",
  ];
  
  // Bug patterns
  const bugPatterns = [
    "bug", "bug-report", "defect", "crash", "broken",
  ];
  
  // Urgent patterns  
  const urgentPatterns = [
    "urgent", "critical", "blocker", "production", "outage", "emergency",
  ];
  
  // Enhancement/feature request patterns
  const enhancementPatterns = [
    "enhancement", "feature request", "feature-request", "new feature",
    "would be nice", "would be great", "suggestion", "idea", "proposal",
    "rfc", "wishlist", "nice to have", "nice-to-have", "improvement",
  ];
  
  // Check for security
  if (securityPatterns.some(p => normalizedLabels.some(l => l.includes(p)) || normalizedTitle.includes(p))) {
    if (!normalizedLabels.includes("security")) {
      autoLabels.push("security");
    }
  }
  
  // Check for regression (was working, now broken)
  if (regressionPatterns.some(p => normalizedLabels.some(l => l.includes(p)) || normalizedTitle.includes(p))) {
    if (!normalizedLabels.includes("regression")) {
      autoLabels.push("regression");
    }
    // Regressions are also bugs
    if (!normalizedLabels.includes("bug")) {
      autoLabels.push("bug");
    }
  }
  
  // Check for bug
  if (bugPatterns.some(p => normalizedLabels.some(l => l.includes(p)) || normalizedTitle.includes(p))) {
    if (!normalizedLabels.includes("bug") && !autoLabels.includes("bug")) {
      autoLabels.push("bug");
    }
  }
  
  // Check for urgent
  if (urgentPatterns.some(p => normalizedLabels.some(l => l.includes(p)) || normalizedTitle.includes(p))) {
    if (!normalizedLabels.includes("urgent")) {
      autoLabels.push("urgent");
    }
  }
  
  // Check for enhancement/feature request
  if (enhancementPatterns.some(p => normalizedLabels.some(l => l.includes(p)) || normalizedTitle.includes(p))) {
    if (!normalizedLabels.includes("enhancement")) {
      autoLabels.push("enhancement");
    }
  }
  
  return autoLabels;
}

/**
 * Use LLM to detect which labels should be added to an issue
 * Analyzes title and content to determine: security, bug, regression, enhancement, urgent
 */
async function getAutoLabelsWithLLM(options: {
  labels?: string[];
  title?: string;
  description?: string;
  threadContent?: string;
}): Promise<string[]> {
  const { labels = [], title = "", description = "", threadContent = "" } = options;
  
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    // Fallback to pattern matching if no API key
    return getAutoLabelsFromPatterns({ labels, title });
  }
  
  // Build content to analyze
  const contentParts: string[] = [];
  if (title) contentParts.push(`Title: ${title}`);
  if (description) contentParts.push(`Description: ${description.substring(0, 500)}`);
  if (threadContent) contentParts.push(`Discussion: ${threadContent.substring(0, 1000)}`);
  if (labels.length > 0) contentParts.push(`Existing labels: ${labels.join(", ")}`);
  
  const contentToAnalyze = contentParts.join("\n\n");
  
  if (!contentToAnalyze.trim()) {
    return getAutoLabelsFromPatterns({ labels, title });
  }
  
  try {
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
            content: `You are a technical issue classifier. Analyze the issue and return applicable labels.

Available labels (return ONLY these, comma-separated):
- security: Security vulnerabilities, auth issues, data leaks, XSS, CSRF, injection attacks
- bug: Software defects, errors, crashes, things not working as expected
- regression: Something that was working before but broke after an update/release/deploy
- urgent: Critical issues needing immediate attention, production outages, blockers
- enhancement: Feature requests, improvements, new functionality suggestions

Rules:
1. Return ONLY applicable labels from the list above, comma-separated
2. If regression, also include bug (regressions are bugs)
3. If nothing clearly matches, return "none"
4. Be conservative - only label if confident
5. Security issues are always high priority
6. "Would be nice", "could we add", "feature request" = enhancement

Examples:
- "Login page crashes after clicking submit" -> bug
- "XSS vulnerability in user profile" -> security
- "Authentication stopped working after v2.0 release" -> regression, bug
- "Would be nice to have dark mode" -> enhancement
- "URGENT: Production database is down" -> urgent, bug
- "How do I configure OAuth?" -> none (this is a question, not an issue)

Return ONLY the labels, nothing else.`
          },
          {
            role: "user",
            content: contentToAnalyze
          }
        ],
        temperature: 0.1,
        max_tokens: 50,
      }),
    });
    
    if (!response.ok) {
      logError(`OpenAI API error for label detection: ${response.status}`);
      return getAutoLabelsFromPatterns({ labels, title });
    }
    
    const data = await response.json() as { choices?: Array<{ message?: { content?: string } }> };
    const result = data.choices?.[0]?.message?.content?.trim().toLowerCase() || "";
    
    if (result === "none" || !result) {
      return [];
    }
    
    // Parse the comma-separated labels
    const validLabels = ["security", "bug", "regression", "urgent", "enhancement"];
    const detectedLabels = result
      .split(",")
      .map((l: string) => l.trim())
      .filter((l: string) => validLabels.includes(l));
    
    // Filter out labels that already exist
    const normalizedExisting = labels.map(l => l.toLowerCase());
    const newLabels = detectedLabels.filter((l: string) => !normalizedExisting.includes(l));
    
    return newLabels;
  } catch (error) {
    logError("Error using LLM for label detection:", error);
    return getAutoLabelsFromPatterns({ labels, title });
  }
}

/**
 * Get auto-generated labels - uses LLM if available, falls back to pattern matching
 * Wrapper function for backward compatibility
 */
function getAutoLabels(options: {
  labels?: string[];
  title?: string;
}): string[] {
  // Synchronous version uses pattern matching only
  return getAutoLabelsFromPatterns(options);
}

/**
 * Batch process label detection using LLM for multiple issues
 * More efficient than calling LLM for each issue individually
 */
async function batchDetectLabelsWithLLM(issues: Array<{
  index: number;
  title: string;
  description?: string;
  existingLabels: string[];
}>): Promise<Map<number, string[]>> {
  const results = new Map<number, string[]>();
  
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    // Fallback to pattern matching for all
    for (const issue of issues) {
      results.set(issue.index, getAutoLabelsFromPatterns({ 
        labels: issue.existingLabels, 
        title: issue.title 
      }));
    }
    return results;
  }
  
  // Process in batches of 10 to avoid token limits
  const batchSize = 10;
  for (let i = 0; i < issues.length; i += batchSize) {
    const batch = issues.slice(i, i + batchSize);
    
    // Build batch content
    const batchContent = batch.map((issue, idx) => 
      `[${idx + 1}] Title: ${issue.title}${issue.description ? `\nDescription: ${issue.description.substring(0, 200)}` : ""}`
    ).join("\n\n---\n\n");
    
    try {
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
              content: `You are a technical issue classifier. Analyze each issue and return applicable labels.

Available labels:
- security: Security vulnerabilities, auth issues, data leaks, XSS, CSRF, injection
- bug: Software defects, errors, crashes, things not working
- regression: Something that worked before but broke after update/release
- urgent: Critical issues, production outages, blockers
- enhancement: Feature requests, improvements, suggestions

Rules:
1. Return one line per issue: "[number] label1, label2" or "[number] none"
2. If regression, also include bug
3. Be conservative - only label if confident
4. Questions/docs are "none"

Example output:
[1] bug
[2] security
[3] regression, bug
[4] enhancement
[5] none`
            },
            {
              role: "user",
              content: `Classify these ${batch.length} issues:\n\n${batchContent}`
            }
          ],
          temperature: 0.1,
          max_tokens: 200,
        }),
      });
      
      if (!response.ok) {
        // Fallback for this batch
        for (const issue of batch) {
          results.set(issue.index, getAutoLabelsFromPatterns({ 
            labels: issue.existingLabels, 
            title: issue.title 
          }));
        }
        continue;
      }
      
      const data = await response.json() as { choices?: Array<{ message?: { content?: string } }> };
      const result = data.choices?.[0]?.message?.content?.trim() || "";
      
      // Parse results
      const validLabels = ["security", "bug", "regression", "urgent", "enhancement"];
      const lines = result.split("\n").filter((l: string) => l.trim());
      
      for (const line of lines) {
        const match = line.match(/\[(\d+)\]\s*(.+)/);
        if (match) {
          const batchIdx = parseInt(match[1], 10) - 1;
          const labelsStr = match[2].trim().toLowerCase();
          
          if (batchIdx >= 0 && batchIdx < batch.length) {
            const issue = batch[batchIdx];
            
            if (labelsStr === "none" || !labelsStr) {
              results.set(issue.index, []);
            } else {
              const detectedLabels = labelsStr
                .split(",")
                .map((l: string) => l.trim())
                .filter((l: string) => validLabels.includes(l));
              
              // Filter out existing labels
              const normalizedExisting = issue.existingLabels.map(l => l.toLowerCase());
              const newLabels = detectedLabels.filter((l: string) => !normalizedExisting.includes(l));
              
              results.set(issue.index, newLabels);
            }
          }
        }
      }
      
      // Fill in any missing with pattern matching
      for (const issue of batch) {
        if (!results.has(issue.index)) {
          results.set(issue.index, getAutoLabelsFromPatterns({ 
            labels: issue.existingLabels, 
            title: issue.title 
          }));
        }
      }
      
    } catch (error) {
      logError("Error in batch label detection:", error);
      // Fallback for this batch
      for (const issue of batch) {
        results.set(issue.index, getAutoLabelsFromPatterns({ 
          labels: issue.existingLabels, 
          title: issue.title 
        }));
      }
    }
  }
  
  return results;
}

/**
 * Get numeric priority for sorting (lower = higher priority)
 */
function getPriorityOrder(priority?: "urgent" | "high" | "medium" | "low"): number {
  switch (priority) {
    case "urgent": return 0;
    case "high": return 1;
    case "medium": return 2;
    case "low": return 3;
    default: return 2; // Default to medium
  }
}

/**
 * Generate a fallback title when LLM is unavailable or fails
 */
function generateFallbackTitle(group: GroupingGroup): string {
  // Priority 1: GitHub issue title
  if (group.github_issue?.title && group.github_issue.title.trim()) {
    return group.github_issue.title.length > 100 
      ? group.github_issue.title.substring(0, 97) + "..." 
      : group.github_issue.title;
  }
  
  // Priority 2: Thread titles
  if (group.threads && group.threads.length > 0) {
    const threadTitles = group.threads
      .map(t => t.thread_name)
      .filter((name): name is string => !!name && name.trim().length > 0);
    
    if (threadTitles.length > 0) {
      const shortestTitle = threadTitles.reduce((shortest, current) => 
        current.length < shortest.length ? current : shortest
      );
      return shortestTitle.length > 100 
        ? shortestTitle.substring(0, 97) + "..." 
        : shortestTitle;
    }
  }
  
  return "Untitled Group";
}

/**
 * Export grouping results directly to PM tool
 * Assumes groups are already matched to features (via match_groups_to_features)
 */
export async function exportGroupingToPMTool(
  groupingData: GroupingData,
  pmToolConfig: PMToolConfig,
  options?: { include_closed?: boolean }
): Promise<ExportWorkflowResult> {
  const includeClosed = options?.include_closed ?? false;
  const result: ExportWorkflowResult = {
    success: false,
    features_extracted: groupingData.features?.length || 0,
    features_mapped: groupingData.groups.length,
    errors: [],
  };

  try {
    const pmTool = createPMTool(pmToolConfig);
    
    // Validate team for Linear
    if (pmToolConfig.type === "linear") {
      const linearTool = pmTool as import("./base.js").LinearPMTool;
      if (linearTool.validateTeam) {
        await linearTool.validateTeam(true, "UNMute");
        if (linearTool.teamId && !pmToolConfig.team_id) {
          pmToolConfig.team_id = linearTool.teamId;
        }
      }
      // Initialize labels for Linear (creates security, bug, etc. labels)
      if (linearTool.initializeLabels) {
        await linearTool.initializeLabels();
      }
    }

    // Use features from grouping data (already matched)
    const features = groupingData.features || [{ id: "general", name: "General" }];
    
    // Use groups from grouping data (already matched to features)
    // Filter: Only export groups with open GitHub issues or unresolved messages (no GitHub issue)
    // This ensures we don't export groups for closed/resolved issues (unless include_closed is true)
    // Also collect closed groups for statistics tracking
    const closedGroups: GroupingGroup[] = [];
    const groupsWithFeatures = groupingData.groups.filter(group => {
      // If group has a GitHub issue, check if it's open or closed
      if (group.github_issue) {
        // State should be "open" or "closed" - default to "open" if missing (conservative approach)
        const state = group.github_issue.state?.toLowerCase() || "open";
        if (state === "closed") {
          closedGroups.push(group);
          // Include closed groups if include_closed is true
          return includeClosed;
        }
        return true;
      }
      // If no GitHub issue, it's an unresolved Discord thread - export it
      return true;
    });
    
    // Check threads in groups for resolution status (even if GitHub issue is open, threads might be resolved)
    // Load Discord cache to check thread messages for resolution signals
    let discordCache: import("../storage/cache/discordCache.js").DiscordCache | null = null;
    try {
      const { loadDiscordCache } = await import("../storage/cache/discordCache.js");
      const { join } = await import("path");
      const { existsSync } = await import("fs");
      const config = getConfig();
      const cacheDir = join(process.cwd(), config.paths.cacheDir);
      const cacheFileName = `discord-messages-${groupingData.channel_id}.json`;
      const cachePath = join(cacheDir, cacheFileName);
      
      if (existsSync(cachePath)) {
        discordCache = await loadDiscordCache(cachePath);
      }
    } catch (error) {
      logError("Error loading Discord cache for thread resolution check:", error);
    }

    // Check and save resolution status for threads in groups
    const resolvedThreadIds = new Set<string>();
    if (discordCache && groupsWithFeatures.length > 0) {
      try {
        const { getThreadMessages } = await import("../storage/cache/discordCache.js");
        const { prisma } = await import("../storage/db/prisma.js");
        const resolvedAt = new Date();
        
        for (const group of groupsWithFeatures) {
          if (group.threads) {
            for (const thread of group.threads) {
              const threadId = thread.thread_id;
              if (resolvedThreadIds.has(threadId)) continue; // Already checked
              
              try {
                const threadMessages = getThreadMessages(discordCache, threadId);
                if (threadMessages && threadMessages.length > 0) {
                  let isResolved = false;
                  
                  // First try quick pattern matching
                  if (hasObviousResolutionSignals(threadMessages)) {
                    isResolved = true;
                  } else {
                    // Use LLM to analyze
                    const llmResult = await isThreadResolvedWithLLM(threadMessages);
                    if (llmResult === true) {
                      isResolved = true;
                    }
                  }
                  
                  if (isResolved) {
                    resolvedThreadIds.add(threadId);
                    // Save resolution status to database
                    await prisma.classifiedThread.update({
                      where: { threadId },
                      data: {
                        resolutionStatus: "conversation_resolved",
                        resolvedAt,
                      },
                    }).catch(error => {
                      logError(`Error saving resolution status for thread ${threadId}:`, error);
                    });
                  }
                }
              } catch (error) {
                logError(`Error checking resolution status for thread ${threadId}:`, error);
              }
            }
          }
        }
        
        if (resolvedThreadIds.size > 0) {
          log(`Marked ${resolvedThreadIds.size} threads in groups as resolved via conversation analysis`);
        }
      } catch (error) {
        logError("Error checking threads in groups for resolution status:", error);
      }
    }

    // Create projects for features (Linear only)
    const projectMappings = new Map<string, string>(); // feature_id -> project_id
    
    if (pmToolConfig.type === "linear") {
      const linearTool = pmTool as import("./base.js").LinearPMTool;
      if (linearTool.createOrGetProject) {
        // Ensure "general" feature is always in the list
        const hasGeneral = features.some(f => f.id === "general");
        if (!hasGeneral) {
          features.push({ id: "general", name: "General" });
        }
        
        for (const feature of features) {
          try {
            const projectId = await linearTool.createOrGetProject(
              feature.id,
              feature.name,
              `Feature: ${feature.name}`
            );
            projectMappings.set(feature.id, projectId);
            log(`Created/verified project for feature: ${feature.name}`);
          } catch (error) {
            logError(`Failed to create project for ${feature.name}:`, error);
            // Continue with other features even if one fails
          }
        }
      }
    }

    // Always generate proper titles using LLM for all groups
    // This ensures consistent, well-formatted titles following PR naming conventions
    log(`Generating titles for ${groupsWithFeatures.length} groups using LLM...`);
    for (const group of groupsWithFeatures) {
      // Always generate title using LLM to ensure proper naming conventions
      // Check if current title looks like an ID - if so, definitely regenerate
      const currentTitle = group.suggested_title;
      const looksLikeId = currentTitle && /^[a-z]{2,10}-\d{10,}$/i.test(currentTitle.trim());
      
      // Always regenerate using LLM (even if title exists) to ensure consistency
      // Only skip if title exists, doesn't look like ID, and we want to preserve it
      // For now, always regenerate to ensure proper format
      try {
        group.suggested_title = await generateGroupTitleWithLLM(group);
      } catch (error) {
        logError(`Failed to generate title for group ${group.id}, using fallback:`, error);
        group.suggested_title = generateFallbackTitle(group);
      }
    }
    log(`Title generation complete`);

    // Convert groups to PM tool issues
    const pmIssues: PMToolIssue[] = [];
    const groupToIssueMap = new Map<string, { id: string; url: string; identifier?: string }>(); // group.id -> Linear issue info
    const issueToGroupMap = new Map<number, GroupingGroup>(); // pmIssues index -> group
    
    for (const group of groupsWithFeatures) {
      // Extract title - now guaranteed to exist
      const title = group.suggested_title!;
      
      // Extract similarity - handle both formats
      const similarity = group.similarity ?? (group.avg_similarity ? group.avg_similarity / 100 : 0);
      
      // Extract signals/threads - handle both formats
      // URLs should already be present from classification, but construct if missing
      // Try to extract guild_id from existing URLs first, then fall back to config
      let guildId: string | undefined;
      
      // Extract guild_id from first available URL in any thread
      if (group.threads && group.threads.length > 0) {
        for (const thread of group.threads) {
          if (thread.url) {
            // Parse Discord URL: https://discord.com/channels/{guild_id}/{channel_id}/{message_id}
            const match = thread.url.match(/discord\.com\/channels\/(\d+)\/(\d+)\/(\d+)/);
            if (match && match[1]) {
              guildId = match[1];
              break;
            }
          }
        }
      }
      
      // Fall back to config if not found in URLs
      if (!guildId) {
        const config = getConfig();
        guildId = config.discord.serverId;
      }
      
      const signals = group.signals || (group.threads ? group.threads.map(t => {
        let url = t.url || "";
        // Construct Discord thread URL if missing (need guild_id, channel_id, and message_id)
        if (!url && t.thread_id && groupingData.channel_id && guildId) {
          // Discord thread URL format: https://discord.com/channels/{guild_id}/{channel_id}/{message_id}
          // For threads, we use the thread_id as the message_id
          url = `https://discord.com/channels/${guildId}/${groupingData.channel_id}/${t.thread_id}`;
        }
        return {
          source: "discord",
          id: t.thread_id,
          title: t.thread_name || `Thread ${t.thread_id}`,
          url: url,
        };
      }) : []);
      
      // If we have a github_issue, add it as a signal (URL should always be present)
      if (group.github_issue) {
        signals.unshift({
          source: "github",
          id: group.github_issue.number.toString(),
          title: group.github_issue.title,
          url: group.github_issue.url || `https://github.com/${group.github_issue.number}`, // Fallback if URL missing
        });
      }
      
      // Ensure threads have URLs (they should already from classification)
      // But also ensure threads array has URLs for the description builder
      // Reuse guildId extracted above
      const threadsWithUrls = group.threads ? group.threads.map(t => {
        let url = t.url || "";
        // Construct URL if missing (need guild_id, channel_id, and message_id)
        if (!url && t.thread_id && groupingData.channel_id && guildId) {
          // Discord thread URL format: https://discord.com/channels/{guild_id}/{channel_id}/{message_id}
          url = `https://discord.com/channels/${guildId}/${groupingData.channel_id}/${t.thread_id}`;
        }
        return {
          ...t,
          url: url,
        };
      }) : undefined;
      
      // Build description with sources and Discord summary
      const description = buildGroupDescription({
        ...group,
        suggested_title: title,
        similarity,
        signals,
        threads: threadsWithUrls, // Pass threads with guaranteed URLs
      });
      
      // Determine project ID (use first affected feature, or "general" if none)
      const affectsFeatures = group.affects_features || [];
      
      // Ensure we have at least one feature (default to "general")
      const primaryFeature = affectsFeatures[0] || { id: "general", name: "General" };
      const featureId = primaryFeature.id;
      
      // Get project ID for the primary feature
      // Always get project ID for single-feature issues, or for issues with no features (use "general")
      // For cross-cutting issues (multiple features), we'll tag them but not assign to a single project
      let projectId: string | undefined;
      if (affectsFeatures.length <= 1) {
        // Single feature or no features - use the project for that feature (or "general")
        projectId = projectMappings.get(featureId);
      }
      // For cross-cutting issues (multiple features), projectId remains undefined
      
      // Generate labels for cross-cutting issues
      const labels: string[] = [];
      if (group.is_cross_cutting) {
        labels.push("cross-cutting");
        // Add feature names as labels
        for (const feature of affectsFeatures) {
          labels.push(feature.name.toLowerCase().replace(/\s+/g, "-"));
        }
      }
      
      // Add GitHub issue labels if available
      if (group.github_issue?.labels) {
        labels.push(...group.github_issue.labels);
      }

      // Calculate priority based on labels, title, and cross-cutting status
      const calculatedPriority = calculatePriority({
        labels,
        title,
        is_cross_cutting: group.is_cross_cutting,
        thread_count: (group.threads?.length || 0) + (group.signals?.length || 0),
        is_ungrouped: false,
      });
      
      // Add auto-generated labels (security, bug, urgent)
      const autoLabels = getAutoLabels({ labels, title });
      const allLabels = [...labels, ...autoLabels];

      const issueIndex = pmIssues.length;
      pmIssues.push({
        title,
        description,
        feature_id: featureId,
        feature_name: primaryFeature.name,
        project_id: projectId,
        source: group.github_issue ? "github" : (group.canonical_issue?.source === "github" ? "github" : "discord"),
        source_url: group.github_issue?.url || group.canonical_issue?.url || signals[0]?.url || "",
        source_id: group.id,
        labels: allLabels, // Includes auto-detected security/bug/urgent labels
        priority: calculatedPriority, // Priority based on bugs, security, cross-cutting, thread count
        // Pass existing Linear issue ID if group already has one (from previous export)
        linear_issue_id: group.linear_issue_id,
        linear_issue_identifier: group.linear_issue_identifier,
        metadata: {
          similarity,
          is_cross_cutting: group.is_cross_cutting || false,
          affects_features: affectsFeatures.map(f => f.name),
          signal_count: signals.length,
          signals,
          github_issue_number: group.github_issue?.number,
        },
      });
      issueToGroupMap.set(issueIndex, group);
    }

    // STEP 2: Export ungrouped threads (threads that didn't match any issues)
    // Filter: Only export ungrouped threads with open top_issue or no top_issue
    // Also filter out threads that appear resolved based on conversation content
    // (discordCache is already loaded above for checking threads in groups)
    const allUngroupedThreads = groupingData.ungrouped_threads || [];
    
    // Look up issue states for ungrouped threads that have top_issue
    const topIssueNumbers = allUngroupedThreads
      .map(ut => ut.top_issue?.number)
      .filter((num): num is number => !!num);
    
    const topIssuesStateMap = new Map<number, string>();
    if (topIssueNumbers.length > 0) {
      try {
        const { prisma } = await import("../storage/db/prisma.js");
        const issues = await prisma.gitHubIssue.findMany({
          where: {
            issueNumber: { in: topIssueNumbers },
          },
          select: {
            issueNumber: true,
            issueState: true,
          },
        });
        
        for (const issue of issues) {
          topIssuesStateMap.set(issue.issueNumber, issue.issueState || "open");
        }
      } catch (error) {
        logError("Error looking up top_issue states for ungrouped threads:", error);
        // Continue with export even if lookup fails
      }
    }
    
    // Filter ungrouped threads: skip if top_issue is closed or thread appears resolved
    // Also collect closed/resolved ungrouped threads for statistics tracking
    const closedUngroupedThreads: typeof allUngroupedThreads = [];
    const resolvedUngroupedThreads: typeof allUngroupedThreads = [];
    const ungroupedThreads: typeof allUngroupedThreads = [];
    
    // Process threads (need to use loop instead of filter due to async LLM calls)
    for (const thread of allUngroupedThreads) {
      // Check if top_issue is closed
      if (thread.top_issue?.number) {
        const issueState = topIssuesStateMap.get(thread.top_issue.number)?.toLowerCase() || "open";
        if (issueState === "closed") {
          closedUngroupedThreads.push(thread);
          // Include closed threads if include_closed is true
          if (includeClosed) {
            ungroupedThreads.push(thread);
          }
          continue;
        }
      }
      
      // Check if thread appears resolved based on conversation content
      let isResolved = false;
      if (discordCache) {
        try {
          const { getThreadMessages } = await import("../storage/cache/discordCache.js");
          const threadMessages = getThreadMessages(discordCache, thread.thread_id);
          
          if (threadMessages && threadMessages.length > 0) {
            // First try quick pattern matching for obvious resolution signals
            if (hasObviousResolutionSignals(threadMessages)) {
              isResolved = true;
            } else {
              // If no obvious signals, use LLM to analyze the conversation
              const llmResult = await isThreadResolvedWithLLM(threadMessages);
              if (llmResult === true) {
                isResolved = true;
              }
              // If llmResult is null (LLM failed), continue (don't filter out - err on side of exporting)
            }
          }
        } catch (error) {
          // If we can't check messages, continue (don't filter out)
          logError(`Error checking resolution status for thread ${thread.thread_id}:`, error);
        }
      }
      
      if (isResolved) {
        resolvedUngroupedThreads.push(thread);
        // Include resolved threads if include_closed is true
        if (includeClosed) {
          ungroupedThreads.push(thread);
        }
        continue;
      }
      
      // No top_issue and not resolved - check if it's actually an issue vs just a question
      // Only export if it's a real issue, not just a question
      let isActualIssue = true; // Default to exporting (conservative approach)
      
      if (discordCache) {
        try {
          const { getThreadMessages } = await import("../storage/cache/discordCache.js");
          const threadMessages = getThreadMessages(discordCache, thread.thread_id);
          
          if (threadMessages && threadMessages.length > 0) {
            // Check if this is actually an issue vs just a question
            const issueCheck = await isThreadAnIssue(threadMessages);
            if (issueCheck === false) {
              // It's just a question, not an issue - skip it
              log(`Skipping thread ${thread.thread_id}: identified as question, not an issue`);
              continue;
            }
            // If issueCheck is null (LLM failed), continue (err on side of exporting)
          }
        } catch (error) {
          // If we can't check, continue (don't filter out - err on side of exporting)
          logError(`Error checking if thread ${thread.thread_id} is an issue:`, error);
        }
      }
      
      // No top_issue, not resolved, and is an actual issue - export it
      ungroupedThreads.push(thread);
    }
    
    log(`Preparing ${ungroupedThreads.length} ungrouped threads for export (filtered from ${allUngroupedThreads.length} total, excluding questions)...`);
    
    // Save closed/resolved ungrouped threads resolution status to database (batch update)
    if (closedUngroupedThreads.length > 0 || resolvedUngroupedThreads.length > 0) {
      try {
        const { prisma } = await import("../storage/db/prisma.js");
        const resolvedAt = new Date();
        const updates: Promise<any>[] = [];
        
        // Update closed threads
        for (const thread of closedUngroupedThreads) {
          updates.push(
            prisma.ungroupedThread.update({
              where: { threadId: thread.thread_id },
              data: {
                resolutionStatus: "closed_issue",
                resolvedAt,
              },
            }).catch(error => {
              logError(`Error saving resolution status for thread ${thread.thread_id}:`, error);
              return null;
            })
          );
        }
        
        // Update resolved threads
        for (const thread of resolvedUngroupedThreads) {
          updates.push(
            prisma.ungroupedThread.update({
              where: { threadId: thread.thread_id },
              data: {
                resolutionStatus: "conversation_resolved",
                resolvedAt,
              },
            }).catch(error => {
              logError(`Error saving resolution status for thread ${thread.thread_id}:`, error);
              return null;
            })
          );
        }
        
        await Promise.all(updates);
        log(`Saved resolution status for ${closedUngroupedThreads.length} closed and ${resolvedUngroupedThreads.length} resolved ungrouped threads to database`);
      } catch (error) {
        logError("Error saving ungrouped threads resolution status to database:", error);
      }
    }
    
    for (const ungroupedThread of ungroupedThreads) {
      // Generate title for ungrouped thread
      const threadTitle = ungroupedThread.thread_name || `Discord Thread ${ungroupedThread.thread_id}`;
      const title = ungroupedThread.thread_name 
        ? `[Ungrouped] ${threadTitle}`
        : `[Ungrouped Thread] ${ungroupedThread.thread_id}`;
      
      // Build description
      const descriptionParts: string[] = [];
      descriptionParts.push("## Problem Summary");
      descriptionParts.push("");
      descriptionParts.push(`This Discord thread did not match any GitHub issues.`);
      descriptionParts.push("");
      
      if (ungroupedThread.reason === "below_threshold" && ungroupedThread.top_issue) {
        descriptionParts.push(`**Closest match:** GitHub issue #${ungroupedThread.top_issue.number} "${ungroupedThread.top_issue.title}" (${Math.round(ungroupedThread.top_issue.similarity_score)}% similarity, below threshold)`);
        descriptionParts.push("");
      } else {
        descriptionParts.push(`**Reason:** No matching GitHub issues found.`);
        descriptionParts.push("");
      }
      
      descriptionParts.push("---");
      descriptionParts.push("");
      descriptionParts.push("## Discord Thread");
      descriptionParts.push("");
      if (ungroupedThread.url) {
        descriptionParts.push(`- [View Thread](${ungroupedThread.url})`);
      }
      if (ungroupedThread.author) {
        descriptionParts.push(`- **Author:** @${ungroupedThread.author}`);
      }
      if (ungroupedThread.timestamp) {
        descriptionParts.push(`- **Created:** ${new Date(ungroupedThread.timestamp).toLocaleString()}`);
      }
      
      // Use matched features if available, otherwise default to "General"
      const affectsFeatures = ungroupedThread.affects_features || [{ id: "general", name: "General" }];
      
      // Ensure we have at least one feature (default to "general")
      const primaryFeature = affectsFeatures[0] || { id: "general", name: "General" };
      const featureId = primaryFeature.id;
      
      // Get project ID for the primary feature
      let projectId = projectMappings.get(featureId);
      if (!projectId) {
        // Fallback to general if feature project not found
        projectId = projectMappings.get("general");
      }
      
      // Build labels
      const labels = ["ungrouped", "discord-thread"];
      if (affectsFeatures.length > 0) {
        // Add feature labels
        for (const feature of affectsFeatures) {
          labels.push(feature.name.toLowerCase().replace(/\s+/g, "-"));
        }
      }
      
      // Calculate priority - ungrouped threads can still be bugs/security issues
      const ungroupedThreadPriority = calculatePriority({
        labels,
        title,
        is_ungrouped: true,
      });
      
      // Add auto-generated labels (security, bug, urgent)
      const autoLabels = getAutoLabels({ labels, title });
      const allLabels = [...labels, ...autoLabels];

      const ungroupedThreadIssueIndex = pmIssues.length;
      pmIssues.push({
        title,
        description: descriptionParts.join("\n"),
        feature_id: featureId,
        feature_name: primaryFeature.name,
        project_id: projectId,
        source: "discord",
        source_url: ungroupedThread.url || "",
        source_id: `ungrouped-thread-${ungroupedThread.thread_id}`,
        labels: allLabels, // Includes auto-detected security/bug/urgent labels
        priority: ungroupedThreadPriority, // Priority based on bugs, security detection
        metadata: {
          thread_id: ungroupedThread.thread_id,
          reason: ungroupedThread.reason,
          top_issue: ungroupedThread.top_issue,
          affects_features: affectsFeatures.map(f => f.name),
        },
      });
      
      // Note: ungroupedThreadIssueIndex is stored in pmIssues array, no need to store on thread object
    }
    
    // STEP 3: Export ungrouped issues (GitHub issues that don't match any thread)
    log(`Finding ungrouped GitHub issues (issues not matched to any thread)...`);
    const ungroupedIssues: PMToolIssue[] = [];
    // Collect closed ungrouped issues for statistics tracking (declared outside try block for scope)
    const closedUngroupedIssues: Array<{
      number: number;
      title: string;
      url?: string;
      state: string;
      body?: string;
      labels?: string[];
      author?: string;
      created_at?: string;
    }> = [];
    
    try {
      // Get all GitHub issues from database
      const { prisma } = await import("../storage/db/prisma.js");
      const { getStorage } = await import("../storage/factory.js");
      const storage = getStorage();
      
      // Get all issue numbers that have been matched to threads
      const matchedIssues = await prisma.threadIssueMatch.findMany({
        select: {
          issueNumber: true,
        },
        distinct: ["issueNumber"],
      });
      
      const matchedIssueNumbers = new Set(matchedIssues.map(i => i.issueNumber));
      
      // Load all issues from cache (this is our source of truth for all fetched issues)
      const config = getConfig();
      const issuesCachePath = join(process.cwd(), config.paths.cacheDir, config.paths.issuesCacheFile);
      const { readFile } = await import("fs/promises");
      const { existsSync } = await import("fs");
      
      if (!existsSync(issuesCachePath)) {
        log(`No issues cache found at ${issuesCachePath}. Skipping ungrouped issues export.`);
      } else {
        const issuesCacheContent = await readFile(issuesCachePath, "utf-8");
        const issuesCache = JSON.parse(issuesCacheContent);
        const allCachedIssues = issuesCache.issues || [];
        
        log(`Loaded ${allCachedIssues.length} issues from cache. ${matchedIssueNumbers.size} are matched to threads.`);
        
        // Find issues in cache that are NOT matched to any thread
        // These are our ungrouped issues
        // Only export open issues (unresolved) unless include_closed is true
        // Also collect closed ungrouped issues for statistics tracking
        for (const issue of allCachedIssues) {
          if (!matchedIssueNumbers.has(issue.number)) {
            // Track closed issues for statistics (even if they'll be exported)
            if (issue.state === "closed") {
              closedUngroupedIssues.push({
                number: issue.number,
                title: issue.title || `GitHub Issue #${issue.number}`,
                url: issue.url,
                state: issue.state,
                body: issue.body,
                labels: issue.labels,
                author: issue.author,
                created_at: issue.created_at,
              });
            }
            
            if (issue.state === "open" || (includeClosed && issue.state === "closed")) {
            // This issue doesn't have any thread matches - it's ungrouped
            const issueTitle = issue.title || `GitHub Issue #${issue.number}`;
            const title = `[Ungrouped Issue] ${issueTitle}`;
            
            const descriptionParts: string[] = [];
            descriptionParts.push("## Problem Summary");
            descriptionParts.push("");
            descriptionParts.push(`This GitHub issue did not match any Discord threads.`);
            descriptionParts.push("");
            
            if (issue.body) {
              descriptionParts.push("---");
              descriptionParts.push("");
              descriptionParts.push("## Issue Description");
              descriptionParts.push("");
              descriptionParts.push(issue.body);
              descriptionParts.push("");
            }
            
            descriptionParts.push("---");
            descriptionParts.push("");
            descriptionParts.push("## GitHub Issue");
            descriptionParts.push("");
            if (issue.url) {
              descriptionParts.push(`- [View Issue](${issue.url})`);
            }
            descriptionParts.push(`- **Number:** #${issue.number}`);
            if (issue.state) {
              descriptionParts.push(`- **State:** ${issue.state}`);
            }
            if (issue.labels && issue.labels.length > 0) {
              descriptionParts.push(`- **Labels:** ${issue.labels.join(", ")}`);
            }
            if (issue.author) {
              descriptionParts.push(`- **Author:** ${issue.author}`);
            }
            
            // Try to match to features based on issue content
            let featureId = "general";
            let featureName = "General";
            let projectId = projectMappings.get("general");
            
            // Simple keyword matching for feature assignment (could be enhanced with embeddings)
            if (groupingData.features && groupingData.features.length > 0) {
              const issueText = `${issue.title} ${issue.body || ""}`.toLowerCase();
              for (const feature of groupingData.features) {
                if (feature.name && issueText.includes(feature.name.toLowerCase())) {
                  featureId = feature.id;
                  featureName = feature.name;
                  projectId = projectMappings.get(feature.id);
                  break;
                }
              }
            }
            
            // Calculate priority based on labels and title
            const issueLabels = ["ungrouped", "github-issue", ...(issue.labels || [])];
            const ungroupedIssuePriority = calculatePriority({
              labels: issueLabels,
              title: issue.title || "",
              is_ungrouped: true,
            });
            // Closed issues get lower priority unless they're security/bugs
            const finalPriority = issue.state === "closed" && ungroupedIssuePriority === "medium" 
              ? "low" 
              : ungroupedIssuePriority;
            
            // Add auto-generated labels (security, bug, urgent)
            const autoLabels = getAutoLabels({ labels: issueLabels, title: issue.title || "" });
            const allLabels = [...issueLabels, ...autoLabels];

            ungroupedIssues.push({
              title,
              description: descriptionParts.join("\n"),
              feature_id: featureId,
              feature_name: featureName,
              project_id: projectId,
              source: "github",
              source_url: issue.url || `https://github.com/issues/${issue.number}`,
              source_id: `ungrouped-issue-${issue.number}`,
              labels: allLabels, // Includes auto-detected security/bug/urgent labels
              priority: finalPriority, // Priority based on bugs, security detection
              metadata: {
                issue_number: issue.number,
                issue_state: issue.state,
                issue_author: issue.author,
              },
            });
            
            // Save ungrouped issue to database
            try {
              // Try to use UngroupedIssue model (should exist in Prisma client if schema is up to date)
              if (prisma.ungroupedIssue) {
                await prisma.ungroupedIssue.upsert({
                  where: { issueNumber: issue.number },
                  update: {
                    issueTitle: issue.title || `Issue #${issue.number}`,
                    issueUrl: issue.url || `https://github.com/issues/${issue.number}`,
                    issueState: issue.state || null,
                    issueBody: issue.body || null,
                    issueLabels: issue.labels || [],
                    issueAuthor: issue.author || null,
                    issueCreatedAt: issue.created_at ? new Date(issue.created_at) : null,
                    exportStatus: "pending",
                    affectsFeatures: [], // Will be populated when matched to features
                  },
                  create: {
                    issueNumber: issue.number,
                    issueTitle: issue.title || `Issue #${issue.number}`,
                    issueUrl: issue.url || `https://github.com/issues/${issue.number}`,
                    issueState: issue.state || null,
                    issueBody: issue.body || null,
                    issueLabels: issue.labels || [],
                    issueAuthor: issue.author || null,
                    issueCreatedAt: issue.created_at ? new Date(issue.created_at) : null,
                    exportStatus: "pending",
                    affectsFeatures: [], // Will be populated when matched to features
                  },
                });
              } else {
                // Fallback: save to GitHubIssue table if UngroupedIssue model doesn't exist yet
                // This can happen if Prisma client hasn't been regenerated after schema update
                logError(`UngroupedIssue model not available in Prisma client. Please run 'npx prisma generate'. Saving to GitHubIssue table instead.`);
                // Type assertion needed until Prisma client is regenerated
                await prisma.gitHubIssue.upsert({
                  where: { issueNumber: issue.number },
                  update: {
                    issueTitle: issue.title || `Issue #${issue.number}`,
                    issueUrl: issue.url || `https://github.com/issues/${issue.number}`,
                    issueState: issue.state || null,
                    issueBody: issue.body || null,
                    issueLabels: issue.labels || [],
                    issueAuthor: issue.author || null,
                    issueCreatedAt: issue.created_at ? new Date(issue.created_at) : null,
                  },
                  create: {
                    issueNumber: issue.number,
                    issueTitle: issue.title || `Issue #${issue.number}`,
                    issueUrl: issue.url || `https://github.com/issues/${issue.number}`,
                    issueState: issue.state || null,
                    issueBody: issue.body || null,
                    issueLabels: issue.labels || [],
                    issueAuthor: issue.author || null,
                    issueCreatedAt: issue.created_at ? new Date(issue.created_at) : null,
                  },
                });
              }
            } catch (dbError) {
              logError(`Error saving ungrouped issue ${issue.number} to database:`, dbError);
              // Continue even if database save fails
            }
            }
          }
        }
        
        log(`Found ${ungroupedIssues.length} ungrouped GitHub issues (${closedUngroupedIssues.length} closed)`);
      }
    } catch (error) {
      logError("Error finding ungrouped issues:", error);
      // Continue with export even if we can't find ungrouped issues
    }
    
    // Add ungrouped issues to export list
    pmIssues.push(...ungroupedIssues);
    
    // Save closed items to a statistics file
    const closedItemsData = {
      timestamp: new Date().toISOString(),
      channel_id: groupingData.channel_id,
      counts: {
        groups: closedGroups.length,
        ungrouped_threads: closedUngroupedThreads.length + resolvedUngroupedThreads.length,
        ungrouped_threads_closed: closedUngroupedThreads.length,
        ungrouped_threads_resolved: resolvedUngroupedThreads.length,
        ungrouped_issues: closedUngroupedIssues.length,
      },
      closed_groups: closedGroups.map(group => ({
        id: group.id,
        suggested_title: group.suggested_title,
        github_issue: group.github_issue,
        thread_count: group.threads?.length || 0,
        affects_features: group.affects_features || [],
      })),
      closed_ungrouped_threads: closedUngroupedThreads.map(thread => ({
        thread_id: thread.thread_id,
        thread_name: thread.thread_name,
        url: thread.url,
        top_issue: thread.top_issue,
        reason: thread.reason,
        affects_features: thread.affects_features || [],
        resolution_reason: "closed_issue",
      })),
      resolved_ungrouped_threads: resolvedUngroupedThreads.map(thread => ({
        thread_id: thread.thread_id,
        thread_name: thread.thread_name,
        url: thread.url,
        top_issue: thread.top_issue,
        reason: thread.reason,
        affects_features: thread.affects_features || [],
        resolution_reason: "conversation_resolved",
      })),
      closed_ungrouped_issues: closedUngroupedIssues,
    };
    
    let closedItemsFilePath: string | undefined;
    try {
      const { writeFile, mkdir } = await import("fs/promises");
      const { existsSync } = await import("fs");
      const config = getConfig();
      const closedItemsDir = join(process.cwd(), config.paths.cacheDir);
      
      // Ensure directory exists
      if (!existsSync(closedItemsDir)) {
        await mkdir(closedItemsDir, { recursive: true });
      }
      
      const timestamp = new Date().toISOString().replace(/[:.]/g, "-").split("T")[0];
      closedItemsFilePath = join(closedItemsDir, `closed-items-${timestamp}.json`);
      await writeFile(closedItemsFilePath, JSON.stringify(closedItemsData, null, 2), "utf-8");
      log(`Saved ${closedGroups.length} closed groups, ${closedUngroupedThreads.length} closed ungrouped threads, ${resolvedUngroupedThreads.length} resolved ungrouped threads, and ${closedUngroupedIssues.length} closed ungrouped issues to ${closedItemsFilePath}`);
    } catch (error) {
      logError("Error saving closed items statistics file:", error);
      // Continue even if file save fails
    }
    
    // Use LLM to detect labels for all issues in batch
    log(`Detecting labels for ${pmIssues.length} issues using LLM...`);
    const issuesToClassify = pmIssues.map((issue, index) => ({
      index,
      title: issue.title,
      description: issue.description?.substring(0, 300),
      existingLabels: issue.labels || [],
    }));
    
    const detectedLabelsMap = await batchDetectLabelsWithLLM(issuesToClassify);
    
    // Add detected labels to issues and recalculate priority based on labels
    let labelsAdded = 0;
    for (let i = 0; i < pmIssues.length; i++) {
      const detectedLabels = detectedLabelsMap.get(i) || [];
      if (detectedLabels.length > 0) {
        pmIssues[i].labels = [...(pmIssues[i].labels || []), ...detectedLabels];
        labelsAdded += detectedLabels.length;
        
        // Recalculate priority based on new labels
        const newPriority = calculatePriority({
          labels: pmIssues[i].labels,
          title: pmIssues[i].title,
          is_cross_cutting: pmIssues[i].metadata?.is_cross_cutting as boolean,
          thread_count: pmIssues[i].metadata?.signal_count as number,
          is_ungrouped: pmIssues[i].source_id?.startsWith("ungrouped-"),
        });
        pmIssues[i].priority = newPriority;
      }
    }
    log(`Added ${labelsAdded} labels via LLM detection`);

    // Sort issues by priority before export (urgent > high > medium > low)
    // Within same priority, sort by signal count (more signals = more important)
    pmIssues.sort((a, b) => {
      const priorityA = getPriorityOrder(a.priority as "urgent" | "high" | "medium" | "low");
      const priorityB = getPriorityOrder(b.priority as "urgent" | "high" | "medium" | "low");
      
      if (priorityA !== priorityB) {
        return priorityA - priorityB; // Lower order = higher priority
      }
      
      // Secondary sort: by signal/thread count (more = higher priority)
      const signalsA = (a.metadata?.signal_count as number) || 0;
      const signalsB = (b.metadata?.signal_count as number) || 0;
      return signalsB - signalsA;
    });
    
    // Log priority breakdown
    const priorityCounts = {
      urgent: pmIssues.filter(i => i.priority === "urgent").length,
      high: pmIssues.filter(i => i.priority === "high").length,
      medium: pmIssues.filter(i => i.priority === "medium").length,
      low: pmIssues.filter(i => i.priority === "low").length,
    };
    log(`Priority breakdown: ${priorityCounts.urgent} urgent, ${priorityCounts.high} high, ${priorityCounts.medium} medium, ${priorityCounts.low} low`);

    // Export to PM tool
    log(`Exporting ${pmIssues.length} issues to ${pmToolConfig.type} (${groupsWithFeatures.length} groups, ${ungroupedThreads.length} ungrouped threads, ${ungroupedIssues.length} ungrouped issues)...`);
    const exportResult = await pmTool.exportIssues(pmIssues);

    // Track which items were exported and update their status
    const ungroupedThreadToIssueMap = new Map<string, { id: string; url: string; identifier?: string }>();
    const ungroupedIssueToIssueMap = new Map<number, { id: string; url: string; identifier?: string }>();
    
    for (let i = 0; i < pmIssues.length; i++) {
      const issue = pmIssues[i];
      
      // Check if this is a group
      const group = issueToGroupMap.get(i);
      if (group) {
        if (issue.linear_issue_id) {
          // Get URL from issue object (set by base class) or construct from identifier
          const issueUrl = issue.linear_issue_url || 
            (issue.linear_issue_identifier ? `https://linear.app/${pmToolConfig.workspace_id || 'workspace'}/issue/${issue.linear_issue_identifier}` : '');
          
          groupToIssueMap.set(group.id, {
            id: issue.linear_issue_id,
            url: issueUrl,
            identifier: issue.linear_issue_identifier || undefined, // Linear identifier like "LIN-123"
          });
          
          // Mark group as exported
          group.status = "exported";
          group.exported_at = new Date().toISOString();
          group.linear_issue_id = issue.linear_issue_id;
          group.linear_issue_url = issueUrl;
          if (issue.linear_issue_identifier) {
            group.linear_issue_identifier = issue.linear_issue_identifier;
          }
        }
        continue;
      }
      
      // Check if this is an ungrouped thread
      if (issue.source_id && issue.source_id.startsWith("ungrouped-thread-")) {
        const threadId = issue.source_id.replace("ungrouped-thread-", "");
        if (issue.linear_issue_id) {
          const issueUrl = issue.linear_issue_url || 
            (issue.linear_issue_identifier ? `https://linear.app/${pmToolConfig.workspace_id || 'workspace'}/issue/${issue.linear_issue_identifier}` : '');
          
          ungroupedThreadToIssueMap.set(threadId, {
            id: issue.linear_issue_id,
            url: issueUrl,
            identifier: issue.linear_issue_identifier || undefined,
          });
          
          // Update ungrouped thread in grouping data
          const ungroupedThread = ungroupedThreads.find(ut => ut.thread_id === threadId);
          if (ungroupedThread) {
            ungroupedThread.export_status = "exported";
            ungroupedThread.exported_at = new Date().toISOString();
            ungroupedThread.linear_issue_id = issue.linear_issue_id;
            ungroupedThread.linear_issue_url = issueUrl;
            if (issue.linear_issue_identifier) {
              ungroupedThread.linear_issue_identifier = issue.linear_issue_identifier;
            }
          }
        }
        continue;
      }
      
      // Check if this is an ungrouped issue
      if (issue.source_id && issue.source_id.startsWith("ungrouped-issue-")) {
        const issueNumber = parseInt(issue.source_id.replace("ungrouped-issue-", ""), 10);
        if (!isNaN(issueNumber) && issue.linear_issue_id) {
          const issueUrl = issue.linear_issue_url || 
            (issue.linear_issue_identifier ? `https://linear.app/${pmToolConfig.workspace_id || 'workspace'}/issue/${issue.linear_issue_identifier}` : '');
          
          ungroupedIssueToIssueMap.set(issueNumber, {
            id: issue.linear_issue_id,
            url: issueUrl,
            identifier: issue.linear_issue_identifier || undefined,
          });
        }
      }
    }
    
    // Update database with export status
    try {
      const { prisma } = await import("../storage/db/prisma.js");
      
      // Update ungrouped threads in database
      for (const [threadId, issueInfo] of ungroupedThreadToIssueMap.entries()) {
        try {
          // Use update with unique identifier (threadId is the primary key)
          // Type assertion needed: exportStatus exists in schema but Prisma client types may be out of sync
          // Run 'npx prisma generate' to regenerate client types
          await prisma.ungroupedThread.update({
            where: { threadId },
            data: {
              exportStatus: "exported",
              exportedAt: new Date(),
              linearIssueId: issueInfo.id,
              linearIssueUrl: issueInfo.url,
              linearIssueIdentifier: issueInfo.identifier || null,
            },
          });
        } catch (error) {
          // If update fails (record might not exist), try upsert
          try {
            // Type assertion needed: exportStatus exists in schema but Prisma client types may be out of sync
            await prisma.ungroupedThread.upsert({
              where: { threadId },
              update: {
                exportStatus: "exported",
                exportedAt: new Date(),
                linearIssueId: issueInfo.id,
                linearIssueUrl: issueInfo.url,
                linearIssueIdentifier: issueInfo.identifier || null,
              },
              create: {
                threadId,
                channelId: groupingData.channel_id,
                reason: "no_matches", // Default reason
                exportStatus: "exported",
                exportedAt: new Date(),
                linearIssueId: issueInfo.id,
                linearIssueUrl: issueInfo.url,
                linearIssueIdentifier: issueInfo.identifier || null,
              },
            });
          } catch (upsertError) {
            logError(`Error updating ungrouped thread ${threadId} export status:`, upsertError);
          }
        }
        
        // Also update the classified_thread
        try {
          // Use update with unique identifier (threadId is the primary key)
          // Type assertion needed: exportStatus exists in schema but Prisma client types may be out of sync
          await prisma.classifiedThread.update({
            where: { threadId },
            data: {
              exportStatus: "exported",
              exportedAt: new Date(),
              linearIssueId: issueInfo.id,
              linearIssueUrl: issueInfo.url,
              linearIssueIdentifier: issueInfo.identifier || null,
            },
          });
        } catch (error) {
          // If update fails, log but don't fail - thread might not be classified yet
          logError(`Error updating classified thread ${threadId} export status (thread may not exist):`, error);
        }
      }
      
      // Update ungrouped issues in database
      for (const [issueNumber, issueInfo] of ungroupedIssueToIssueMap.entries()) {
        try {
          // Try to use UngroupedIssue model (should exist in Prisma client if schema is up to date)
          if (prisma.ungroupedIssue) {
            await prisma.ungroupedIssue.upsert({
              where: { issueNumber },
              update: {
                exportStatus: "exported",
                exportedAt: new Date(),
                linearIssueId: issueInfo.id,
                linearIssueUrl: issueInfo.url,
                linearIssueIdentifier: issueInfo.identifier || null,
              },
              create: {
                issueNumber,
                issueTitle: `Issue #${issueNumber}`, // Will be updated when we have full issue data
                issueUrl: `https://github.com/issues/${issueNumber}`,
                exportStatus: "exported",
                exportedAt: new Date(),
                linearIssueId: issueInfo.id,
                linearIssueUrl: issueInfo.url,
                linearIssueIdentifier: issueInfo.identifier || null,
              },
            });
          } else {
            // Fallback: update GitHubIssue model export status using update (single record)
            // Type assertion needed: exportStatus exists in schema but Prisma client types may be out of sync
            await prisma.gitHubIssue.update({
              where: { issueNumber },
              data: {
                exportStatus: "exported",
                exportedAt: new Date(),
                linearIssueId: issueInfo.id,
                linearIssueUrl: issueInfo.url,
                linearIssueIdentifier: issueInfo.identifier || null,
              },
            });
          }
        } catch (error) {
          logError(`Error updating ungrouped issue ${issueNumber} export status:`, error);
        }
      }
      
      log(`Updated export status in database for ${ungroupedThreadToIssueMap.size} ungrouped threads and ${ungroupedIssueToIssueMap.size} ungrouped issues`);
    } catch (error) {
      logError("Error updating export status in database:", error);
      // Continue even if database update fails
    }

    result.success = true;
    result.issues_exported = {
      created: exportResult.created_issues,
      updated: exportResult.updated_issues,
      skipped: exportResult.skipped_issues,
    };

    if (exportResult.errors && exportResult.errors.length > 0) {
      result.errors = exportResult.errors.map(e => `${e.source_id}: ${e.error}`);
    }

    log(`Export complete: ${exportResult.created_issues} created, ${exportResult.updated_issues} updated, ${exportResult.skipped_issues} skipped`);
    log(`  - Groups: ${groupsWithFeatures.length}`);
    log(`  - Ungrouped threads: ${ungroupedThreads.length}`);
    log(`  - Ungrouped issues: ${ungroupedIssues.length}`);

    // Return result with export mappings for updating the JSON file
    return {
      ...result,
      group_export_mappings: Array.from(groupToIssueMap.entries()).map(([group_id, issue_info]) => ({
        group_id,
        ...issue_info,
      })),
      ungrouped_thread_export_mappings: Array.from(ungroupedThreadToIssueMap.entries()).map(([thread_id, issue_info]) => ({
        thread_id,
        ...issue_info,
      })),
      ungrouped_issue_export_mappings: Array.from(ungroupedIssueToIssueMap.entries()).map(([issue_number, issue_info]) => ({
        issue_number,
        ...issue_info,
      })),
      closed_items_count: {
        groups: closedGroups.length,
        ungrouped_threads: closedUngroupedThreads.length + resolvedUngroupedThreads.length,
        ungrouped_threads_closed: closedUngroupedThreads.length,
        ungrouped_threads_resolved: resolvedUngroupedThreads.length,
        ungrouped_issues: closedUngroupedIssues.length,
      },
      closed_items_file: closedItemsFilePath,
    };
  } catch (error) {
    logError("Grouping export failed:", error);
    result.success = false;
    result.errors = result.errors || [];
    result.errors.push(error instanceof Error ? error.message : String(error));
    return result;
  }
}

/**
 * Check if a thread appears resolved based on the last few messages using pattern matching
 * Looks for resolution signals like "thank you", "got it", "resolved", etc.
 * @param messages Discord messages from the thread
 */
function hasObviousResolutionSignals(messages: Array<{ content: string; author?: { username: string } }>): boolean {
  if (!messages || messages.length === 0) {
    return false;
  }
  
  // Check if a maintainer answered (if author info is available)
  const maintainers = getMaintainerUsernames();
  const firstMessage = messages[0];
  if (firstMessage?.author) {
    const maintainerAnswered = messages.some(m => 
      m.author && maintainers.includes(m.author.username.toLowerCase())
    );
    
    // If maintainer answered and conversation seems to conclude, likely resolved
    if (maintainerAnswered) {
      const lastMessages = messages.slice(-3);
      const lastMessagesText = lastMessages
        .map(m => m.content.toLowerCase().trim())
        .join(" ");
      
      // Check for acknowledgment after maintainer answer
      const acknowledgmentPatterns = [
        /\b(thank you|thanks|thx|ty)\b/i,
        /\b(got it|gotcha|understand|understood)\b/i,
        /\b(perfect|great|awesome|cool)\b/i,
        /\b(works|working|fixed|solved)\b/i,
      ];
      
      for (const pattern of acknowledgmentPatterns) {
        if (pattern.test(lastMessagesText)) {
          return true; // Maintainer answered + acknowledgment = resolved
        }
      }
    }
  }
  
  // Check the last 3-5 messages for resolution signals
  const lastMessages = messages.slice(-5);
  const lastMessagesText = lastMessages
    .map(m => m.content.toLowerCase().trim())
    .join(" ");
  
  // Common resolution patterns
  const resolutionPatterns = [
    /\b(thank you|thanks|thx|ty)\b/i,
    /\b(got it|gotcha|understand|understood)\b/i,
    /\b(resolved|fixed|done|sorted|solved)\b/i,
    /\b(perfect|great|awesome|cool)\s*(thanks|thx|ty)?\b/i,
    /\b(that's? (it|what|exactly) (i|we) (needed|wanted)|exactly (what|what i needed))\b/i,
    /\b(all good|all set|works now|working now)\b/i,
    /\b(no (more|further) (questions|issues|problems))\b/i,
    /\b(i'?m (all set|good|done)|we'?re (all set|good|done))\b/i,
  ];
  
  // Check if any resolution pattern matches
  for (const pattern of resolutionPatterns) {
    if (pattern.test(lastMessagesText)) {
      return true;
    }
  }
  
  return false;
}

/**
 * Get list of maintainer/expert usernames who typically answer questions
 * These are people who, if they answer, likely resolved the issue
 */
function getMaintainerUsernames(): string[] {
  // Default maintainers for Better Auth (can be overridden via env var)
  const envMaintainers = process.env.MAINTAINER_USERNAMES;
  if (envMaintainers) {
    return envMaintainers.split(',').map(u => u.trim().toLowerCase());
  }
  
  // Default Better Auth maintainers
  return ['bekaru', 'alex', 'taesu', 'max'].map(u => u.toLowerCase());
}

/**
 * Use LLM to analyze if a Discord thread conversation indicates the issue was resolved
 * Analyzes Discord messages from the thread to determine if the discussion reached a resolution
 * Reads ALL messages to understand full context, especially if maintainers answered
 * Returns true if resolved, false if not, or null if analysis failed
 * @param messages Discord messages from the thread (DiscordMessage[] from discordCache)
 */
async function isThreadResolvedWithLLM(messages: Array<{ content: string; author: { username: string } }>): Promise<boolean | null> {
  if (!messages || messages.length === 0) {
    return false;
  }
  
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    log("OpenAI API key not available, skipping LLM-based resolution detection");
    return null;
  }
  
  // Read ALL messages to understand full context
  const maintainers = getMaintainerUsernames();
  const conversationText = messages
    .map((m, index) => {
      const username = m.author.username.toLowerCase();
      const isMaintainer = maintainers.includes(username);
      const maintainerTag = isMaintainer ? ' [MAINTAINER]' : '';
      return `[${index + 1}] ${m.author.username}${maintainerTag}: ${m.content}`;
    })
    .join("\n\n");
  
  // Check if any maintainer participated
  const maintainerParticipated = messages.some(m => 
    maintainers.includes(m.author.username.toLowerCase())
  );
  
  // Limit conversation text to reasonable size (about 4000 chars)
  // But prioritize recent messages if thread is very long
  let conversationPreview: string;
  if (conversationText.length > 4000) {
    // Take first 1000 chars (initial problem/question) + last 3000 chars (ongoing discussion/resolution)
    const start = conversationText.substring(0, 1000);
    const end = conversationText.substring(conversationText.length - 3000);
    conversationPreview = `${start}\n\n[... ${messages.length - Math.floor(messages.length * 0.3)} messages in between ...]\n\n${end}`;
  } else {
    conversationPreview = conversationText;
  }
  
  try {
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
            content: `You are analyzing a COMPLETE Discord thread conversation to determine if the issue or question discussed has been resolved.

Read the ENTIRE conversation to understand:
- Did a maintainer/expert (marked with [MAINTAINER]) answer the question?
- If a maintainer answered, the issue is likely RESOLVED (they typically provide correct solutions)
- Is the original question/problem answered or solved?
- Do participants express satisfaction (thanks, got it, works now, etc.)?
- Does the conversation naturally conclude with resolution?

A thread is considered RESOLVED if:
- A maintainer/expert (marked [MAINTAINER]) answered and the conversation seems concluded
- The original question/problem has been answered or solved
- Participants express satisfaction (thanks, got it, works now, etc.)
- The conversation naturally concludes with resolution
- It was just a simple question that got answered
- Multiple people confirm the solution works

A thread is NOT resolved if:
- The question remains unanswered (even if maintainer participated but didn't answer)
- There are still ongoing problems or errors
- The conversation ends without clear resolution
- The issue is deferred or postponed
- People are still asking follow-up questions about the same problem

IMPORTANT: If a maintainer (marked [MAINTAINER]) provided an answer and the conversation seems to conclude, it's likely RESOLVED. Maintainers are experts who typically provide correct solutions.

Respond with ONLY "RESOLVED" or "NOT_RESOLVED" (no other text).`
          },
          {
            role: "user",
            content: `Analyze this COMPLETE Discord thread conversation (${messages.length} messages${maintainerParticipated ? ', maintainer participated' : ''}) and determine if the issue is resolved. Read all messages to understand the full context:\n\n${conversationPreview}`
          }
        ],
        temperature: 0.3,
        max_tokens: 10,
      }),
    });
    
    if (!response.ok) {
      const errorText = await response.text();
      logError(`OpenAI API error for resolution detection: ${response.status} ${errorText}`);
      return null;
    }
    
    const data = await response.json() as { choices?: Array<{ message?: { content?: string } }> };
    const result = data.choices?.[0]?.message?.content?.trim().toUpperCase();
    
    return result === "RESOLVED";
  } catch (error) {
    logError("Error using LLM for resolution detection:", error);
    return null;
  }
}

/**
 * Use LLM to determine if a Discord thread is actually an issue (bug/problem/feature request) 
 * vs just a question that doesn't need to be tracked as an issue
 * 
 * Analyzes the full conversation to understand context, ongoing problems, and whether
 * there's an actual bug or issue that needs tracking.
 * 
 * Returns:
 * - true: It's an actual issue that should be exported
 * - false: It's just a question, don't export
 * - null: LLM check failed, err on side of exporting
 */
async function isThreadAnIssue(messages: Array<{ content: string; author: { username: string } }>): Promise<boolean | null> {
  if (!messages || messages.length === 0) {
    return true; // Default to exporting if no messages
  }
  
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    log("OpenAI API key not available, defaulting to export (conservative approach)");
    return true; // Default to exporting if no API key
  }
  
  // Read ALL messages to understand the full context of the conversation
  // This helps identify ongoing bugs, problems that persist, or actual issues vs simple questions
  const conversationText = messages
    .map((m, index) => `[${index + 1}] ${m.author.username}: ${m.content}`)
    .join("\n\n");
  
  // Limit conversation text to reasonable size (about 4000 chars to get more context)
  // But prioritize recent messages if thread is very long
  let conversationPreview: string;
  if (conversationText.length > 4000) {
    // Take first 1000 chars (initial problem/question) + last 3000 chars (ongoing discussion/resolution)
    const start = conversationText.substring(0, 1000);
    const end = conversationText.substring(conversationText.length - 3000);
    conversationPreview = `${start}\n\n[... ${messages.length - Math.floor(messages.length * 0.3)} messages in between ...]\n\n${end}`;
  } else {
    conversationPreview = conversationText;
  }
  
  try {
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
            content: `You are analyzing a complete Discord thread conversation to determine if it's an actual ISSUE that needs tracking vs just a QUESTION or casual discussion.

Read the ENTIRE conversation to understand:
- Is there an ongoing bug or problem that persists?
- Are people reporting errors, crashes, or broken functionality?
- Is there a feature request or improvement that needs implementation?
- Is this an active problem that requires tracking and resolution?

An ISSUE (export it) is:
- A bug report or error that needs fixing ("I'm getting error X", "This is broken", "It crashes when...")
- An ongoing problem that persists across multiple messages
- A feature request that needs implementation ("We should add...", "It would be great if...")
- A security concern or vulnerability
- A problem that requires action, tracking, or resolution
- Multiple people discussing the same problem
- A conversation where the problem is not resolved

A QUESTION (don't export) is:
- Just asking "how do I..." or "what is..." or "is there..." without reporting a problem
- Asking for clarification or information ("Or was there any critical bugs I should update to?")
- Simple questions that get answered quickly
- Questions that don't require tracking or action items
- General discussion or help requests
- Questions where the answer is provided and conversation ends

Examples:
- "How do I configure OAuth?" -> QUESTION (don't export)
- "I'm getting an error when I try to login" -> ISSUE (export it)
- "Or was there any critical bugs I should definitely update to?" -> QUESTION (don't export)
- "The login is broken for me too" -> ISSUE (export it)
- "Can you explain how X works?" -> QUESTION (don't export)
- Multiple messages discussing the same error -> ISSUE (export it)

Analyze the FULL conversation context, not just the first message. Look for:
- Ongoing problems that persist
- Multiple people experiencing the same issue
- Unresolved bugs or errors
- Active discussions about problems

Respond with ONLY "ISSUE" or "QUESTION" (no other text).`
          },
          {
            role: "user",
            content: `Analyze this COMPLETE Discord thread conversation (${messages.length} messages) and determine if it's an ISSUE that needs tracking or just a QUESTION. Read all messages to understand the full context:\n\n${conversationPreview}`
          }
        ],
        temperature: 0.3,
        max_tokens: 10,
      }),
    });
    
    if (!response.ok) {
      const errorText = await response.text();
      logError(`OpenAI API error for issue classification: ${response.status} ${errorText}`);
      return null; // Default to exporting if API fails
    }
    
    const data = await response.json() as { choices?: Array<{ message?: { content?: string } }> };
    const result = data.choices?.[0]?.message?.content?.trim().toUpperCase();
    
    // Return true if it's an ISSUE, false if it's a QUESTION
    return result === "ISSUE";
  } catch (error) {
    logError("Error using LLM for issue classification:", error);
    return null; // Default to exporting if check fails
  }
}

/**
 * Build description for a group issue
 */
function buildGroupDescription(group: {
  suggested_title?: string;
  similarity?: number;
  is_cross_cutting?: boolean;
  affects_features?: Array<{ id: string; name: string }>;
  signals: GroupingSignal[];
  threads?: Array<{
    thread_id: string;
    thread_name?: string;
    similarity_score?: number;
    url?: string;
    author?: string;
  }>;
}): string {
  const parts: string[] = [];
  
  // Get Discord threads early (used in multiple places)
  const discordThreads = group.threads || [];
  
  // Problem summary
  parts.push("## Problem Summary");
  parts.push("");
  const signalCount = group.signals?.length || 0;
  const githubCount = (group.signals || []).filter(s => s.source === "github").length;
  const discordCount = discordThreads.length || (group.signals || []).filter(s => s.source === "discord").length;
  const similarityPercent = group.similarity ? Math.round(group.similarity * 100) : 0;
  
  // Build summary based on what's in the group
  const summaryParts: string[] = [];
  if (githubCount > 0 && discordCount > 0) {
    summaryParts.push(`${githubCount} GitHub issue${githubCount !== 1 ? 's' : ''} and ${discordCount} Discord thread${discordCount !== 1 ? 's' : ''}`);
  } else if (githubCount > 0) {
    summaryParts.push(`${githubCount} GitHub issue${githubCount !== 1 ? 's' : ''}`);
  } else if (discordCount > 0) {
    summaryParts.push(`${discordCount} Discord thread${discordCount !== 1 ? 's' : ''}`);
  }
  
  if (summaryParts.length > 0) {
    const summary = `This issue was identified from ${summaryParts.join(' and ')}`;
    if (similarityPercent > 0) {
      parts.push(`${summary} with ${similarityPercent}% similarity.`);
    } else {
      parts.push(`${summary}.`);
    }
  } else {
    parts.push("This issue was identified from related discussions.");
  }
  parts.push("");
  
  // Discord discussions summary
  if (discordThreads.length > 0) {
    parts.push("### Discord Discussions Summary");
    parts.push("");
    parts.push(`**${discordThreads.length} Discord thread${discordThreads.length !== 1 ? 's' : ''}** discussed this issue:`);
    parts.push("");
    
    // Group threads by similarity to show patterns
    const highSimilarity = discordThreads.filter(t => (t.similarity_score || 0) >= 80);
    const mediumSimilarity = discordThreads.filter(t => {
      const score = t.similarity_score || 0;
      return score >= 60 && score < 80;
    });
    
    if (highSimilarity.length > 0) {
      parts.push(`**High similarity (≥80%):** ${highSimilarity.length} thread${highSimilarity.length !== 1 ? 's' : ''}`);
      for (const thread of highSimilarity.slice(0, 5)) { // Show top 5
        const title = thread.thread_name || `Thread ${thread.thread_id}`;
        const score = thread.similarity_score ? Math.round(thread.similarity_score) : 0;
        parts.push(`- ${title} (${score}% match)${thread.url ? ` - [View](${thread.url})` : ''}`);
      }
      if (highSimilarity.length > 5) {
        parts.push(`- ... and ${highSimilarity.length - 5} more`);
      }
      parts.push("");
    }
    
    if (mediumSimilarity.length > 0) {
      parts.push(`**Medium similarity (60-79%):** ${mediumSimilarity.length} thread${mediumSimilarity.length !== 1 ? 's' : ''}`);
      if (mediumSimilarity.length <= 3) {
        for (const thread of mediumSimilarity) {
          const title = thread.thread_name || `Thread ${thread.thread_id}`;
          const score = thread.similarity_score ? Math.round(thread.similarity_score) : 0;
          parts.push(`- ${title} (${score}% match)${thread.url ? ` - [View](${thread.url})` : ''}`);
        }
      } else {
        parts.push(`- ${mediumSimilarity.length} threads with medium similarity`);
      }
      parts.push("");
    }
    
    // Common themes from thread titles
    const threadTitles = discordThreads
      .map(t => t.thread_name)
      .filter((name): name is string => !!name && name.trim().length > 0);
    
    if (threadTitles.length > 1) {
      // Extract common keywords
      const stopWords = new Set(['the', 'a', 'an', 'and', 'or', 'but', 'in', 'on', 'at', 'to', 'for', 'of', 'with', 'by', 'how', 'what', 'when', 'where', 'why', 'can', 'should', 'would']);
      const wordFreq = new Map<string, number>();
      
      for (const title of threadTitles) {
        const words = title.toLowerCase()
          .replace(/[^\w\s]/g, ' ')
          .split(/\s+/)
          .filter(w => w.length > 3 && !stopWords.has(w));
        
        for (const word of words) {
          wordFreq.set(word, (wordFreq.get(word) || 0) + 1);
        }
      }
      
      const commonWords = Array.from(wordFreq.entries())
        .filter(([_, count]) => count >= 2)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 5)
        .map(([word]) => word);
      
      if (commonWords.length > 0) {
        parts.push(`**Common themes:** ${commonWords.join(", ")}`);
        parts.push("");
      }
    }
  }
  
  // Cross-cutting notice
  if (group.is_cross_cutting && group.affects_features && group.affects_features.length > 0) {
    parts.push("### Cross-Cutting Issue");
    parts.push("");
    parts.push(`This affects multiple features: **${group.affects_features.map(f => f.name).join(", ")}**`);
    parts.push("");
  }
  
  // Sources - only show section if there are links
  const githubSignals = (group.signals || []).filter(s => s.source === "github");
  const discordSignals = (group.signals || []).filter(s => s.source === "discord");
  const hasAnyLinks = githubSignals.length > 0 || discordThreads.length > 0 || discordSignals.length > 0;
  
  if (hasAnyLinks) {
    parts.push("---");
    parts.push("");
    parts.push("## Related Links");
    parts.push("");
    
    // GitHub sources - always show links (URLs should always be present)
    if (githubSignals.length > 0) {
      parts.push("### GitHub Issues");
      for (const signal of githubSignals) {
        // URL should always be present, but handle gracefully if missing
        if (signal.url) {
          parts.push(`- [#${signal.id} ${signal.title}](${signal.url})`);
        } else {
          parts.push(`- #${signal.id} ${signal.title} (URL missing)`);
        }
      }
      parts.push("");
      parts.push("> **Tip:** Reference this Linear issue in your PR with `Fixes LIN-XXX` or `Closes LIN-XXX` to auto-close when merged.");
      parts.push("");
    }
    
    // Discord sources (detailed list with all threads)
    // Use threads if available (more complete info), otherwise fall back to signals
    // URLs should always be present after construction above
    if (discordThreads.length > 0) {
      parts.push("### All Discord Threads");
      parts.push("");
      for (const thread of discordThreads) {
        const title = thread.thread_name || `Thread ${thread.thread_id}`;
        const threadId = thread.thread_id || "";
        const url = thread.url || "";
        const author = thread.author ? ` by @${thread.author}` : "";
        const score = thread.similarity_score ? ` (${Math.round(thread.similarity_score)}% match)` : "";
        
        // Always show as link if URL is present (should be after construction)
        if (url) {
          parts.push(`- [${title}](${url})${author}${score}`);
        } else {
          // Fallback: show title and thread ID if URL is still missing
          parts.push(`- ${title}${author}${score}`);
        }
        
        // Always show thread ID for reference
        if (threadId) {
          parts.push(`  - Thread ID: \`${threadId}\``);
        }
      }
    } else if (discordSignals.length > 0) {
      parts.push("### All Discord Threads");
      parts.push("");
      for (const signal of discordSignals) {
        // Always show as link if URL is present
        if (signal.url) {
          parts.push(`- [${signal.title}](${signal.url})`);
        } else {
          parts.push(`- ${signal.title}`);
        }
        if (signal.id) {
          parts.push(`  - Thread ID: \`${signal.id}\``);
        }
      }
    }
  }
  
  return parts.join("\n");
}

/**
 * Classify a GitHub issue by analyzing its content
 * Returns category, type, and other classification metadata
 */
async function classifyGitHubIssue(issue: {
  issueNumber: number;
  issueTitle: string;
  issueBody?: string | null;
  issueLabels?: string[];
}): Promise<{
  category: string;
  type: "bug" | "feature" | "question" | "documentation" | "enhancement" | "other";
  severity?: "critical" | "high" | "medium" | "low";
  requiresAction: boolean;
}> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    // Fallback classification based on labels
    const labels = issue.issueLabels || [];
    const isBug = labels.some(l => l.toLowerCase().includes("bug"));
    const isFeature = labels.some(l => l.toLowerCase().includes("feature") || l.toLowerCase().includes("enhancement"));
    const isQuestion = labels.some(l => l.toLowerCase().includes("question"));
    
    return {
      category: isBug ? "bug" : isFeature ? "feature" : isQuestion ? "question" : "other",
      type: isBug ? "bug" : isFeature ? "feature" : isQuestion ? "question" : "other",
      severity: labels.some(l => l.toLowerCase().includes("critical")) ? "critical" : 
                labels.some(l => l.toLowerCase().includes("high")) ? "high" : 
                labels.some(l => l.toLowerCase().includes("low")) ? "low" : "medium",
      requiresAction: isBug || isFeature,
    };
  }

  const content = `${issue.issueTitle}\n\n${issue.issueBody || ""}`.substring(0, 3000);
  
  try {
    const response = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": `Bearer ${apiKey}` },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        messages: [
          {
            role: "system",
            content: `Classify this GitHub issue. Respond with JSON only:
{
  "category": "bug" | "feature" | "question" | "documentation" | "enhancement" | "other",
  "type": "bug" | "feature" | "question" | "documentation" | "enhancement" | "other",
  "severity": "critical" | "high" | "medium" | "low" (only for bugs),
  "requiresAction": boolean
}`
          },
          {
            role: "user",
            content: `Classify this GitHub issue:\n\n${content}`
          }
        ],
        temperature: 0.3,
        max_tokens: 200,
      }),
    });

    if (!response.ok) {
      throw new Error(`OpenAI API error: ${response.status}`);
    }

    const data = await response.json() as { choices?: Array<{ message?: { content?: string } }> };
    const result = JSON.parse(data.choices?.[0]?.message?.content || "{}");
    return result;
  } catch (error) {
    logError("Error classifying issue with LLM:", error);
    // Fallback to label-based classification
    const labels = issue.issueLabels || [];
    return {
      category: "other",
      type: "other",
      severity: "medium",
      requiresAction: true,
    };
  }
}

/**
 * Group similar GitHub issues together based on semantic similarity
 */
async function groupGitHubIssues(
  issues: Array<{
    issueNumber: number;
    issueTitle: string;
    issueBody?: string | null;
    issueLabels?: string[];
    classification?: {
      category: string;
      type: string;
      severity?: string;
    };
  }>,
  similarityThreshold: number = 0.7
): Promise<{
  groups: Array<{
    id: string;
    issues: number[];
    title: string;
    category: string;
    type: string;
  }>;
  ungrouped: number[];
}> {
  // Simple grouping based on classification and title similarity
  // For production, use embeddings for semantic similarity
  const groups: Array<{
    id: string;
    issues: number[];
    title: string;
    category: string;
    type: string;
  }> = [];
  const groupedIssueNumbers = new Set<number>();
  const ungrouped: number[] = [];

  // Group by category and type first
  const categoryGroups = new Map<string, number[]>();
  
  for (const issue of issues) {
    const category = issue.classification?.category || "other";
    const type = issue.classification?.type || "other";
    const key = `${category}:${type}`;
    
    if (!categoryGroups.has(key)) {
      categoryGroups.set(key, []);
    }
    categoryGroups.get(key)!.push(issue.issueNumber);
  }

  // Create groups from category groupings
  for (const [key, issueNumbers] of categoryGroups.entries()) {
    if (issueNumbers.length > 1) {
      const [category, type] = key.split(":");
      const groupId = `group-${category}-${type}-${Date.now()}`;
      groups.push({
        id: groupId,
        issues: issueNumbers,
        title: `${category} - ${type}`,
        category,
        type,
      });
      issueNumbers.forEach(num => groupedIssueNumbers.add(num));
    } else {
      ungrouped.push(issueNumbers[0]);
    }
  }

  // Add remaining ungrouped issues
  for (const issue of issues) {
    if (!groupedIssueNumbers.has(issue.issueNumber)) {
      ungrouped.push(issue.issueNumber);
    }
  }

  return { groups, ungrouped };
}

/**
 * Match ungrouped issues to product features using documentation/code context
 */
async function matchUngroupedIssuesToFeatures(
  issueNumbers: number[],
  features: Array<{ id: string; name: string; description?: string; related_keywords?: string[] }>,
  issues: Map<number, { issueTitle: string; issueBody?: string | null }>
): Promise<Map<number, { featureId: string; featureName: string; similarity: number }>> {
  const matches = new Map<number, { featureId: string; featureName: string; similarity: number }>();
  
  // Simple keyword-based matching
  // For production, use embeddings for semantic matching
  for (const issueNumber of issueNumbers) {
    const issue = issues.get(issueNumber);
    if (!issue) continue;

    const issueText = `${issue.issueTitle} ${issue.issueBody || ""}`.toLowerCase();
    let bestMatch: { featureId: string; featureName: string; similarity: number } | null = null;
    let bestScore = 0;

    for (const feature of features) {
      let score = 0;
      const featureText = `${feature.name} ${feature.description || ""} ${(feature.related_keywords || []).join(" ")}`.toLowerCase();
      
      // Check for keyword matches
      const keywords = feature.related_keywords || [];
      for (const keyword of keywords) {
        if (issueText.includes(keyword.toLowerCase())) {
          score += 0.3;
        }
      }
      
      // Check for feature name match
      if (issueText.includes(feature.name.toLowerCase())) {
        score += 0.5;
      }

      if (score > bestScore && score > 0.3) {
        bestScore = score;
        bestMatch = {
          featureId: feature.id,
          featureName: feature.name,
          similarity: Math.min(score, 1.0),
        };
      }
    }

    if (bestMatch) {
      matches.set(issueNumber, bestMatch);
    }
  }

  return matches;
}

/**
 * Assign priority to an issue based on classification, labels, and context
 */
function assignIssuePriority(
  issue: {
    issueLabels?: string[];
    classification?: {
      type: string;
      severity?: string;
    };
    hasDiscordContext?: boolean;
    isInGroup?: boolean;
  }
): "urgent" | "high" | "medium" | "low" {
  const labels = issue.issueLabels || [];
  const classification = issue.classification;
  
  // Critical/urgent indicators
  if (labels.some(l => l.toLowerCase().includes("critical") || l.toLowerCase().includes("security"))) {
    return "urgent";
  }
  
  if (classification?.severity === "critical") {
    return "urgent";
  }
  
  // High priority indicators
  if (labels.some(l => l.toLowerCase().includes("bug") && !l.toLowerCase().includes("low"))) {
    return "high";
  }
  
  if (classification?.type === "bug" && classification.severity === "high") {
    return "high";
  }
  
  // Medium priority (default)
  if (classification?.type === "feature" || classification?.type === "enhancement") {
    return "medium";
  }
  
  if (issue.hasDiscordContext || issue.isInGroup) {
    return "medium";
  }
  
  // Low priority
  if (labels.some(l => l.toLowerCase().includes("low") || l.toLowerCase().includes("nice-to-have"))) {
    return "low";
  }
  
  return "medium";
}

/**
 * Find relevant Discord messages for an issue using similarity matching
 */
async function findRelevantDiscordMessages(
  issue: {
    issueNumber: number;
    issueTitle: string;
    issueBody?: string | null;
  },
  discordCache: import("../storage/cache/discordCache.js").DiscordCache | null,
  existingMatches: Array<{ threadId: string; similarityScore: number }>
): Promise<Array<{
  threadId: string;
  threadName: string;
  messages: Array<{ content: string; author: string; timestamp: string }>;
  similarity: number;
}>> {
  const results: Array<{
    threadId: string;
    threadName: string;
    messages: Array<{ content: string; author: string; timestamp: string }>;
    similarity: number;
  }> = [];

  if (!discordCache) {
    return results;
  }

  // Use existing matches if available
  if (existingMatches.length > 0) {
    const { getThreadMessages } = await import("../storage/cache/discordCache.js");
    
    for (const match of existingMatches.slice(0, 5)) {
      const threadMessages = getThreadMessages(discordCache, match.threadId);
      if (threadMessages && threadMessages.length > 0) {
        const threadData = discordCache.threads?.[match.threadId];
        const threadName = threadData && typeof threadData === 'object' && 'name' in threadData 
          ? (threadData as any).name 
          : `Thread ${match.threadId}`;
        results.push({
          threadId: match.threadId,
          threadName,
          messages: threadMessages.map(m => ({
            content: m.content,
            author: m.author.username,
            timestamp: m.timestamp || "",
          })),
          similarity: Number(match.similarityScore),
        });
      }
    }
  }

  return results;
}

/**
 * Export GitHub issues to PM tool (issue-centric approach)
 * Issues are primary - Discord threads/messages are attached as context
 * 
 * This is the new approach where:
 * 1. GitHub issues are the main items to export
 * 2. Discord threads/messages are attached to issues if they match
 * 3. Only open issues are exported (unless include_closed is true)
 * 
 * NEW WORKFLOW:
 * 1. Classify issues
 * 2. Group similar issues
 * 3. Match ungrouped issues to features
 * 4. Assign priority
 * 5. Attach Discord messages
 */
export async function exportIssuesToPMTool(
  pmToolConfig: PMToolConfig,
  options?: { 
    include_closed?: boolean;
    channelId?: string;
    dry_run?: boolean;
    update_projects?: boolean; // Update existing Linear issues with correct project (feature) assignments (deprecated, use update)
    update?: boolean; // Update existing Linear issues with all differences (projects, labels, priority, title, description)
    update_all_titles?: boolean; // One-time migration: Update ALL existing Linear issues with last comment info in titles (format: "X days ago - Title")
  }
): Promise<ExportWorkflowResult> {
  const includeClosed = options?.include_closed ?? false;
  const channelId = options?.channelId;
  const dryRun = options?.dry_run ?? false;
  // Support both update_projects (legacy) and update (new) - update takes precedence
  const update = options?.update ?? options?.update_projects ?? false;
  const updateProjects = update; // Keep for backward compatibility in the code
  const updateAllTitles = options?.update_all_titles ?? false;
  const result: ExportWorkflowResult = {
    success: false,
    features_extracted: 0,
    features_mapped: 0,
    errors: [],
  };

  try {
    const pmTool = createPMTool(pmToolConfig);
    
    // Validate team for Linear
    let linearTool: import("./base.js").LinearPMTool | null = null;
    if (pmToolConfig.type === "linear") {
      linearTool = pmTool as import("./base.js").LinearPMTool;
      if (linearTool.validateTeam) {
        await linearTool.validateTeam(true, "UNMute");
        if (linearTool.teamId && !pmToolConfig.team_id) {
          pmToolConfig.team_id = linearTool.teamId;
        }
      }
      // Initialize labels for Linear
      if (linearTool.initializeLabels) {
        await linearTool.initializeLabels();
      }
    }

    // Verify database is available
    const { hasDatabaseConfig, getStorage } = await import("../storage/factory.js");
    const useDatabase = hasDatabaseConfig() && await getStorage().isAvailable();
    
    if (!useDatabase) {
      throw new Error("Database is required for issue-centric export. Please configure DATABASE_URL.");
    }

    const { prisma } = await import("../storage/db/prisma.js");

    // =============================================================
    // STEP 1: Get GROUPS from GitHub issues (each unique groupId becomes 1 Linear issue)
    // Only get groups that haven't been exported yet (incremental)
    // =============================================================
    log("Loading unexported grouped issues from database...");
    
    // Get all issues that have a groupId set (these are our grouped issues)
    // Filter out issues in groups that are already exported
    const groupedIssues = await prisma.gitHubIssue.findMany({
      where: {
        groupId: { not: null },
        ...(includeClosed ? {} : { issueState: "open" }),
      },
      orderBy: { issueNumber: 'desc' },
    });
    log(`Found ${groupedIssues.length} issues with groupId set`);

    // Derive unique groups from the issues
    const uniqueGroupIds = [...new Set(groupedIssues.map(i => i.groupId).filter((id): id is string => id !== null))];
    log(`Found ${uniqueGroupIds.length} unique groups from issues`);

    // Load ALL group metadata from Group table (for titles, features, etc.)
    const allGroupMetadata = await prisma.group.findMany({
      where: { id: { in: uniqueGroupIds } },
    });
    const groupMetadataMap = new Map(allGroupMetadata.map(g => [g.id, g]));
    
    // Filter to only unexported groups (status = "pending" OR no linearIssueId)
    const unexportedGroupIds = new Set(
      allGroupMetadata
        .filter(g => g.status === "pending" || !g.linearIssueId)
        .map(g => g.id)
    );
    
    // Also include groups not in the Group table (they're implicitly unexported)
    for (const groupId of uniqueGroupIds) {
      if (!groupMetadataMap.has(groupId)) {
        unexportedGroupIds.add(groupId);
      }
    }
    
    log(`Found ${unexportedGroupIds.size} unexported groups (${uniqueGroupIds.length - unexportedGroupIds.size} already exported)`);
    log(`Unexported group IDs: ${Array.from(unexportedGroupIds).join(', ') || 'NONE'}`);

    // Build groups array - ONLY include unexported groups
    const groups = uniqueGroupIds.filter(id => unexportedGroupIds.has(id)).map(groupId => {
      const metadata = groupMetadataMap.get(groupId);
      const issuesInGroup = groupedIssues.filter(i => i.groupId === groupId);
      const primaryIssue = issuesInGroup[0];
      
      return {
        id: groupId,
        channelId: metadata?.channelId || channelId || "",
        suggestedTitle: metadata?.suggestedTitle || primaryIssue?.issueTitle || `Group ${groupId}`,
        avgSimilarity: metadata?.avgSimilarity || null,
        threadCount: metadata?.threadCount || 0,
        isCrossCutting: metadata?.isCrossCutting || false,
        status: metadata?.status || "pending",
        createdAt: metadata?.createdAt || new Date(),
        updatedAt: metadata?.updatedAt || new Date(),
        exportedAt: metadata?.exportedAt || null,
        linearIssueId: metadata?.linearIssueId || null,
        linearIssueUrl: metadata?.linearIssueUrl || null,
        linearIssueIdentifier: metadata?.linearIssueIdentifier || null,
        linearProjectIds: metadata?.linearProjectIds || [],
        affectsFeatures: metadata?.affectsFeatures || [],
        githubIssueNumber: metadata?.githubIssueNumber || primaryIssue?.issueNumber || null,
      };
    });
    log(`Built ${groups.length} groups for export`);

    // =============================================================
    // STEP 2: Get UNGROUPED ISSUES (each becomes 1 Linear issue)
    // Only get issues that haven't been exported yet (incremental)
    // =============================================================
    log("Loading unexported ungrouped issues from database...");
    const ungroupedIssues = await prisma.gitHubIssue.findMany({
      where: {
        groupId: null, // Issues without a groupId are ungrouped
        ...(includeClosed ? {} : { issueState: "open" }),
        // Only get unexported issues (incremental export)
        OR: [
          { exportStatus: null },
          { exportStatus: "pending" },
        ],
      },
      orderBy: { issueNumber: 'desc' },
    });
    log(`Found ${ungroupedIssues.length} unexported ungrouped issues`);
    if (ungroupedIssues.length > 0 && ungroupedIssues.length <= 20) {
      log(`Unexported issue numbers: ${ungroupedIssues.map(i => i.issueNumber).join(', ')}`);
    }

    // Verify we have all issues
    const allIssues = [...groupedIssues, ...ungroupedIssues];
    log(`Total issues to export: ${allIssues.length} (${groupedIssues.length} grouped + ${ungroupedIssues.length} ungrouped)`);

    // =============================================================
    // STEP 1.5: Ensure all issues are labeled before export
    // =============================================================
    const unlabeledIssues = allIssues.filter(issue => !issue.detectedLabels || issue.detectedLabels.length === 0);
    if (unlabeledIssues.length > 0) {
      log(`Labeling ${unlabeledIssues.length} unlabeled issues before export...`);
      
      // Prepare issues for batch labeling
      const issuesToLabel = unlabeledIssues.map((issue, idx) => ({
        index: idx,
        issueNumber: issue.issueNumber,
        title: issue.issueTitle || `Issue #${issue.issueNumber}`,
        description: issue.issueBody?.substring(0, 300),
        existingLabels: issue.issueLabels || [],
      }));
      
      // Batch detect labels
      const detectedLabelsMap = await batchDetectLabelsWithLLM(issuesToLabel);
      
      // Save detected labels to database
      let labeledCount = 0;
      for (let i = 0; i < unlabeledIssues.length; i++) {
        const issue = unlabeledIssues[i];
        const detectedLabels = detectedLabelsMap.get(i) || [];
        
        if (detectedLabels.length > 0) {
          await prisma.gitHubIssue.update({
            where: { issueNumber: issue.issueNumber },
            data: { detectedLabels },
          });
          
          // Update the issue object in memory so it's available for export
          issue.detectedLabels = detectedLabels;
          labeledCount++;
        }
      }
      
      log(`Labeled ${labeledCount} issues before export`);
    } else {
      log("All issues already have labels");
    }

    // STEP 2: Load Discord messages from database
    let discordCache: import("../storage/cache/discordCache.js").DiscordCache | null = null;
    if (channelId) {
      try {
        // Load messages from database
        const dbMessages = await prisma.discordMessage.findMany({
          where: { channelId },
          orderBy: { createdAt: 'asc' },
        });
        
        if (dbMessages.length > 0) {
          // Convert database messages to DiscordCache format
          const threads: Record<string, import("../storage/cache/discordCache.js").ThreadMessages> = {};
          const mainMessages: import("../storage/cache/discordCache.js").DiscordMessage[] = [];
          
          for (const msg of dbMessages) {
            const discordMsg: import("../storage/cache/discordCache.js").DiscordMessage = {
              id: msg.id,
              content: msg.content,
              author: {
                id: msg.authorId,
                username: msg.authorUsername || "unknown",
                discriminator: msg.authorDiscriminator || "0",
                bot: msg.authorBot,
                avatar: msg.authorAvatar || null,
              },
              timestamp: msg.timestamp,
              created_at: msg.createdAt.toISOString(),
              edited_at: msg.editedAt?.toISOString() || null,
              channel_id: msg.channelId,
              channel_name: msg.channelName || undefined,
              guild_id: msg.guildId || undefined,
              guild_name: msg.guildName || undefined,
              attachments: msg.attachments as import("../storage/cache/discordCache.js").DiscordMessage["attachments"],
              embeds: msg.embeds,
              mentions: msg.mentions,
              reactions: msg.reactions as import("../storage/cache/discordCache.js").DiscordMessage["reactions"],
              url: msg.url || undefined,
            };
            
            if (msg.threadId) {
              // Message belongs to a thread
              if (!threads[msg.threadId]) {
                threads[msg.threadId] = {
                  thread_id: msg.threadId,
                  thread_name: msg.threadName || "Unknown Thread",
                  message_count: 0,
                  oldest_message_date: null,
                  newest_message_date: null,
                  messages: [],
                };
              }
              threads[msg.threadId].messages.push(discordMsg);
              threads[msg.threadId].message_count = threads[msg.threadId].messages.length;
              // Update date range
              const msgDate = msg.createdAt.toISOString();
              if (!threads[msg.threadId].oldest_message_date || msgDate < threads[msg.threadId].oldest_message_date!) {
                threads[msg.threadId].oldest_message_date = msgDate;
              }
              if (!threads[msg.threadId].newest_message_date || msgDate > threads[msg.threadId].newest_message_date!) {
                threads[msg.threadId].newest_message_date = msgDate;
              }
            } else {
              // Main channel message
              mainMessages.push(discordMsg);
            }
          }
          
          // Build the cache object
          const dates = dbMessages.map(m => m.createdAt);
          discordCache = {
            fetched_at: new Date().toISOString(),
            channel_id: channelId,
            channel_name: dbMessages[0]?.channelName || undefined,
            total_count: dbMessages.length,
            oldest_message_date: dates.length > 0 ? new Date(Math.min(...dates.map(d => d.getTime()))).toISOString() : null,
            newest_message_date: dates.length > 0 ? new Date(Math.max(...dates.map(d => d.getTime()))).toISOString() : null,
            threads,
            main_messages: mainMessages,
          };
          
          log(`Loaded ${dbMessages.length} Discord messages from database (${Object.keys(threads).length} threads)`);
        } else {
          log(`No Discord messages found in database for channel ${channelId}`);
        }
      } catch (error) {
        logError("Error loading Discord messages from database:", error);
        // Continue without Discord context
      }
    }

    // =============================================================
    // STEP 3: Build PM Issues - GROUPS (1 Linear issue per group)
    // =============================================================
    const pmIssues: PMToolIssue[] = [];
    const groupIssueNumbers = new Set<number>(); // Track which issues are in groups

    log(`Processing ${groups.length} groups...`);
    for (const group of groups) {
      try {
        // Get all GitHub issues in this group
        const groupIssueList = groupedIssues.filter(i => i.groupId === group.id);
        groupIssueList.forEach(i => groupIssueNumbers.add(i.issueNumber));
        
        if (groupIssueList.length === 0) {
          log(`Skipping group ${group.id} - no issues found`);
          continue;
        }

        // Get all thread matches for issues in this group
        const groupThreadMatches = await prisma.issueThreadMatch.findMany({
          where: {
            issueNumber: { in: groupIssueList.map(i => i.issueNumber) },
          },
          orderBy: { similarityScore: 'desc' },
        });

        // Get Discord messages for matched threads
        const threadIds = [...new Set(groupThreadMatches.map(m => m.threadId))];
        const discordThreads = discordCache?.threads || {};
        
        // Build description with ALL issues in the group + ALL threads
        const descriptionParts: string[] = [];
        
        descriptionParts.push(`# ${group.suggestedTitle}`);
        descriptionParts.push("");
        descriptionParts.push(`**Group ID:** ${group.id}`);
        descriptionParts.push(`**Issues in group:** ${groupIssueList.length}`);
        descriptionParts.push(`**Related Discord threads:** ${threadIds.length}`);
        descriptionParts.push("");

        // List all GitHub issues in the group
        descriptionParts.push("## GitHub Issues");
        descriptionParts.push("");
        for (const issue of groupIssueList.slice(0, 20)) { // Limit to first 20
          descriptionParts.push(`- [#${issue.issueNumber}](${issue.issueUrl}) - ${issue.issueTitle}`);
          if (issue.issueLabels && issue.issueLabels.length > 0) {
            descriptionParts.push(`  Labels: ${issue.issueLabels.join(", ")}`);
          }
        }
        if (groupIssueList.length > 20) {
          descriptionParts.push(`- ... and ${groupIssueList.length - 20} more issues`);
        }
        descriptionParts.push("");

        // Add Discord thread context
        if (threadIds.length > 0) {
          descriptionParts.push("## Related Discord Discussions");
          descriptionParts.push("");
          
          for (const threadId of threadIds.slice(0, 5)) { // Limit to top 5 threads
            const threadMatch = groupThreadMatches.find(m => m.threadId === threadId);
            const threadData = discordThreads[threadId];
            const threadName = threadMatch?.threadName || threadId;
            
            if (threadMatch?.threadUrl) {
              descriptionParts.push(`### [${threadName}](${threadMatch.threadUrl})`);
              descriptionParts.push(`> **Discord Thread:** ${threadMatch.threadUrl}`);
            } else {
              descriptionParts.push(`### ${threadName}`);
            }
            descriptionParts.push(`- **Similarity:** ${threadMatch?.similarityScore || 0}%`);
            descriptionParts.push(`- **Messages:** ${threadMatch?.messageCount || threadData?.message_count || 0}`);
            
            // Add sample messages if available
            if (threadData?.messages && threadData.messages.length > 0) {
              const firstMsg = threadData.messages[0];
              descriptionParts.push(`- **First message:** ${firstMsg.author.username}: ${firstMsg.content.substring(0, 150)}...`);
            }
            descriptionParts.push("");
          }
          if (threadIds.length > 5) {
            descriptionParts.push(`... and ${threadIds.length - 5} more threads`);
          }
        }

        // Add PR context - fetch PRs linked to any issue in the group
        const issueNumbers = groupIssueList.map(i => i.issueNumber);
        const linkedPRs = await prisma.gitHubPullRequest.findMany({
          where: {
            linkedIssues: {
              some: {
                issueNumber: { in: issueNumbers },
              },
            },
          },
          select: {
            prNumber: true,
            prUrl: true,
            prTitle: true,
            prState: true,
            prMerged: true,
            prBody: true,
            linkedIssues: {
              select: {
                issueNumber: true,
              },
            },
          },
          orderBy: {
            prCreatedAt: 'desc',
          },
        });

        if (linkedPRs.length > 0) {
          descriptionParts.push("## Related Pull Requests");
          descriptionParts.push("");
          
          for (const pr of linkedPRs) {
            const prStateLabel = pr.prMerged ? "merged" : pr.prState;
            const relatedIssueNumbers = pr.linkedIssues.map(i => i.issueNumber);
            const relatedIssuesText = relatedIssueNumbers.map(num => `#${num}`).join(", ");
            descriptionParts.push(`- Related to ${relatedIssuesText} - [PR #${pr.prNumber}](${pr.prUrl}) - ${pr.prTitle} (${prStateLabel})`);
          }
          
          // Also check PR bodies for additional issue numbers
          const additionalIssues = new Set<number>();
          for (const pr of linkedPRs) {
            if (pr.prBody) {
              // Extract issue numbers from PR body (e.g., #6810, closes #6810, fixes #6810)
              const issueMatches = pr.prBody.matchAll(/#(\d+)/g);
              for (const match of issueMatches) {
                const issueNum = parseInt(match[1], 10);
                if (!issueNumbers.includes(issueNum)) {
                  additionalIssues.add(issueNum);
                }
              }
            }
          }
          
          if (additionalIssues.size > 0) {
            descriptionParts.push("");
            const issueBaseUrl = groupIssueList[0]?.issueUrl?.replace(/\d+$/, "") || "";
            const relatedIssuesLinks = Array.from(additionalIssues).map(num => {
              const issueUrl = issueBaseUrl ? `${issueBaseUrl}${num}` : `#${num}`;
              return `[#${num}](${issueUrl})`;
            }).join(", ");
            descriptionParts.push(`**Also relates to:** ${relatedIssuesLinks}`);
          }
          
          descriptionParts.push("");
        }

        // Collect all labels from issues in the group (GitHub labels + detected labels)
        const allLabels = new Set<string>();
        allLabels.add("issue-group");
        if (threadIds.length > 0) allLabels.add("discord");
        for (const issue of groupIssueList) {
          issue.issueLabels?.forEach(l => allLabels.add(l));
          // Add LLM-detected labels from database
          issue.detectedLabels?.forEach(l => allLabels.add(l));
        }

        // Calculate priority based on labels and title
        const groupPriority = calculatePriority({
          labels: Array.from(allLabels),
          title: group.suggestedTitle || groupIssueList[0]?.issueTitle || "",
          is_cross_cutting: group.isCrossCutting,
          thread_count: threadIds.length,
        });

        // Get features from issues in the group (use first issue's features, or aggregate)
        const primaryIssue = groupIssueList[0];
        const issueFeatures = primaryIssue?.affectsFeatures as Array<{ id: string; name: string }> | null;
        const topFeature = issueFeatures && issueFeatures.length > 0 
          ? issueFeatures[0] 
          : { id: "general", name: "General" };

        // Build discord_threads array with full details
        const discordThreadsMetadata = groupThreadMatches.slice(0, 10).map(m => ({
          thread_id: m.threadId,
          thread_name: m.threadName || m.threadId,
          thread_url: m.threadUrl,
          similarity: Number(m.similarityScore),
          message_count: m.messageCount || 0,
        }));

        // Extract last comment date from all issues in the group
        const lastCommentText = extractLastCommentTextFromIssues(groupIssueList);
        const groupTitle = group.suggestedTitle || `Issue Group ${group.id}`;
        const titleWithComment = lastCommentText ? `${lastCommentText} - ${groupTitle}` : groupTitle;

        pmIssues.push({
          title: titleWithComment,
          description: descriptionParts.join("\n"),
          feature_id: topFeature.id,
          feature_name: topFeature.name,
          source: "github",
          source_url: groupIssueList[0]?.issueUrl || "",
          source_id: `group-${group.id}`,
          labels: Array.from(allLabels),
          priority: groupPriority,
          metadata: {
            group_id: group.id,
            issue_count: groupIssueList.length,
            issue_numbers: groupIssueList.map(i => i.issueNumber),
            discord_threads_count: threadIds.length,
            discord_thread_ids: threadIds,
            discord_threads: discordThreadsMetadata,
          },
          linear_issue_id: group.linearIssueId || undefined,
          linear_issue_identifier: group.linearIssueIdentifier || undefined,
        });

        log(`Prepared group ${group.id} with ${groupIssueList.length} issues, ${threadIds.length} threads`);

      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : String(error);
        logError(`Error processing group ${group.id}:`, error);
        result.errors?.push(`Group ${group.id}: ${errorMsg}`);
      }
    }

    // =============================================================
    // STEP 4: Build PM Issues - UNGROUPED (1 Linear issue per issue)
    // =============================================================
    log(`Processing ${ungroupedIssues.length} ungrouped issues...`);
    for (const issue of ungroupedIssues) {
      try {
        // Get thread matches for this issue
        const threadMatches = await prisma.issueThreadMatch.findMany({
          where: { issueNumber: issue.issueNumber },
          orderBy: { similarityScore: 'desc' },
        });

        const threadIds = threadMatches.map(m => m.threadId);
        const discordThreads = discordCache?.threads || {};

        // Build description
        const descriptionParts: string[] = [];
        
        descriptionParts.push("## GitHub Issue");
        descriptionParts.push("");
        descriptionParts.push(`**Issue:** [#${issue.issueNumber}](${issue.issueUrl}) - ${issue.issueTitle}`);
        descriptionParts.push(`**State:** ${issue.issueState || "open"}`);
        descriptionParts.push(`**Author:** ${issue.issueAuthor || "unknown"}`);
        if (issue.issueLabels && issue.issueLabels.length > 0) {
          descriptionParts.push(`**Labels:** ${issue.issueLabels.join(", ")}`);
        }
        descriptionParts.push("");
        
        if (issue.issueBody) {
          descriptionParts.push("### Description");
          descriptionParts.push(issue.issueBody.substring(0, 2000));
          descriptionParts.push("");
        }

        // Add Discord context
        if (threadMatches.length > 0) {
          descriptionParts.push("## Related Discord Discussions");
          descriptionParts.push("");
          
          for (const match of threadMatches.slice(0, 3)) {
            const threadData = discordThreads[match.threadId];
            const threadName = match.threadName || match.threadId;
            
            if (match.threadUrl) {
              descriptionParts.push(`### [${threadName}](${match.threadUrl})`);
              descriptionParts.push(`> **Discord Thread:** ${match.threadUrl}`);
            } else {
              descriptionParts.push(`### ${threadName}`);
            }
            descriptionParts.push(`- **Similarity:** ${match.similarityScore}%`);
            descriptionParts.push(`- **Messages:** ${match.messageCount || threadData?.message_count || 0}`);
            
            if (threadData?.messages && threadData.messages.length > 0) {
              const firstMsg = threadData.messages[0];
              descriptionParts.push(`- **First message:** ${firstMsg.author.username}: ${firstMsg.content.substring(0, 150)}...`);
            }
            descriptionParts.push("");
          }
        }

        // Add PR context - fetch PRs linked to this issue
        const linkedPRs = await prisma.gitHubPullRequest.findMany({
          where: {
            linkedIssues: {
              some: {
                issueNumber: issue.issueNumber,
              },
            },
          },
          select: {
            prNumber: true,
            prUrl: true,
            prTitle: true,
            prState: true,
            prMerged: true,
            prBody: true,
          },
          orderBy: {
            prCreatedAt: 'desc',
          },
        });

        if (linkedPRs.length > 0) {
          descriptionParts.push("## Related Pull Requests");
          descriptionParts.push("");
          
          for (const pr of linkedPRs) {
            const prStateLabel = pr.prMerged ? "merged" : pr.prState;
            descriptionParts.push(`- Related to [#${issue.issueNumber}](${issue.issueUrl}) - [PR #${pr.prNumber}](${pr.prUrl}) - ${pr.prTitle} (${prStateLabel})`);
          }
          
          // Also check PR bodies for additional issue numbers
          const additionalIssues = new Set<number>();
          for (const pr of linkedPRs) {
            if (pr.prBody) {
              // Extract issue numbers from PR body (e.g., #6810, closes #6810, fixes #6810)
              const issueMatches = pr.prBody.matchAll(/#(\d+)/g);
              for (const match of issueMatches) {
                const issueNum = parseInt(match[1], 10);
                if (issueNum !== issue.issueNumber) {
                  additionalIssues.add(issueNum);
                }
              }
            }
          }
          
          if (additionalIssues.size > 0) {
            descriptionParts.push("");
            const issueBaseUrl = issue.issueUrl.replace(String(issue.issueNumber), "");
            const relatedIssuesLinks = Array.from(additionalIssues).map(num => {
              const issueUrl = `${issueBaseUrl}${num}`;
              return `[#${num}](${issueUrl})`;
            }).join(", ");
            descriptionParts.push(`**Also relates to:** ${relatedIssuesLinks}`);
          }
          
          descriptionParts.push("");
        }

        // Collect labels (GitHub labels + LLM-detected labels from database)
        const labels = [...(issue.issueLabels || []), ...(issue.detectedLabels || [])];
        if (threadMatches.length > 0) labels.push("discord");

        // Calculate priority - ungrouped issues can still be security/bugs
        const issuePriority = calculatePriority({
          labels,
          title: issue.issueTitle || "",
          is_ungrouped: true,
        });

        // Get features from issue's affectsFeatures field
        const issueFeatures = issue.affectsFeatures as Array<{ id: string; name: string }> | null;
        const topFeature = issueFeatures && issueFeatures.length > 0 
          ? issueFeatures[0] 
          : { id: "general", name: "General" };

        // Build discord_threads array with full details
        const discordThreadsMetadata = threadMatches.slice(0, 10).map(m => ({
          thread_id: m.threadId,
          thread_name: m.threadName || m.threadId,
          thread_url: m.threadUrl,
          similarity: Number(m.similarityScore),
          message_count: m.messageCount || 0,
        }));

        // Extract last comment date from database (issueComments JSON)
        const lastCommentText = extractLastCommentText(issue.issueComments);
        const title = issue.issueTitle || `GitHub Issue #${issue.issueNumber}`;
        const titleWithComment = lastCommentText ? `${lastCommentText} - ${title}` : title;

        pmIssues.push({
          title: titleWithComment,
          description: descriptionParts.join("\n"),
          feature_id: topFeature.id,
          feature_name: topFeature.name,
          source: "github",
          source_url: issue.issueUrl,
          source_id: `github-issue-${issue.issueNumber}`,
          labels,
          priority: issuePriority,
          metadata: {
            issue_number: issue.issueNumber,
            issue_state: issue.issueState,
            discord_threads_count: threadMatches.length,
            discord_thread_ids: threadIds,
            discord_threads: discordThreadsMetadata,
          },
          linear_issue_id: issue.linearIssueId || undefined,
          linear_issue_identifier: issue.linearIssueIdentifier || undefined,
        });

      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : String(error);
        logError(`Error processing issue #${issue.issueNumber}:`, error);
        result.errors?.push(`Issue #${issue.issueNumber}: ${errorMsg}`);
      }
    }

    log(`Prepared ${pmIssues.length} PM issues for export (${groups.length} groups + ${ungroupedIssues.length} ungrouped)`);
    if (pmIssues.length > 0 && pmIssues.length <= 20) {
      log(`PM issue source_ids: ${pmIssues.map(i => i.source_id).join(', ')}`);
    }

    // =============================================================
    // STEP 4.5: Create Linear projects for features and map project_id
    // =============================================================
    const projectMappings = new Map<string, string>(); // feature_id -> project_id
    
    if (linearTool?.createOrGetProject && (pmIssues.length > 0 || update)) {
      log("Creating/mapping Linear projects for features...");
      
      // Collect unique features from pmIssues AND from database (for update)
      const featureMap = new Map<string, string>(); // feature_id -> feature_name
      
      // From pmIssues (new exports)
      for (const issue of pmIssues) {
        if (issue.feature_id && issue.feature_name) {
          featureMap.set(issue.feature_id, issue.feature_name);
        }
      }
      
      // From database features (for update - need all features to map projects)
      if (update) {
        const allFeatures = await prisma.feature.findMany();
        for (const feature of allFeatures) {
          if (!featureMap.has(feature.id)) {
            featureMap.set(feature.id, feature.name);
          }
        }
      }
      
      // Ensure "general" feature exists
      if (!featureMap.has("general")) {
        featureMap.set("general", "General");
      }
      
      // Create/get Linear projects for each feature
      for (const [featureId, featureName] of featureMap) {
        try {
          const projectId = await linearTool.createOrGetProject(
            featureId,
            featureName,
            `Feature: ${featureName}`
          );
          projectMappings.set(featureId, projectId);
          log(`  Mapped feature "${featureName}" -> project ${projectId}`);
        } catch (error) {
          logError(`  Failed to create project for ${featureName}:`, error);
        }
      }
      
      // Update pmIssues with project_id
      for (const issue of pmIssues) {
        if (issue.feature_id) {
          const projectId = projectMappings.get(issue.feature_id) || projectMappings.get("general");
          if (projectId) {
            issue.project_id = projectId;
          }
        }
      }
      
      log(`Mapped ${projectMappings.size} features to Linear projects`);
      
      // =============================================================
      // STEP 4.6: Update existing Linear issues with differences (if update flag set)
      // OR update all titles (if update_all_titles flag set)
      // =============================================================
      const updateIssueMethod = linearTool.updateIssue;
      const getIssueMethod = linearTool.getIssue;
      if ((update || updateAllTitles) && updateIssueMethod && getIssueMethod) {
        if (updateAllTitles) {
          log("Updating ALL existing Linear issues with last comment info in titles (one-time migration)...");
        } else {
          log("Updating existing Linear issues with all differences from database...");
        }
        
        // Get all exported issues (groups and ungrouped) that have a linearIssueId
        // Only include open issues (unless includeClosed is true) to avoid updating titles for closed issues
        const exportedGroups = await prisma.group.findMany({
          where: { linearIssueId: { not: null } },
        });
        
        const exportedIssues = await prisma.gitHubIssue.findMany({
          where: { 
            linearIssueId: { not: null },
            groupId: null, // Only ungrouped issues (grouped ones are handled via groups)
            ...(includeClosed ? {} : { issueState: "open" }), // Only open issues unless includeClosed is true
          },
        });
        
        log(`Found ${exportedGroups.length} exported groups and ${exportedIssues.length} exported ungrouped issues`);
        
        let updatedCount = 0;
        let skippedCount = 0;
        let errorCount = 0;
        
        // Update groups
        for (const group of exportedGroups) {
          try {
            if (!group.linearIssueId) continue;
            
            // Get all issues in the group to build expected state
            const groupIssues = await prisma.gitHubIssue.findMany({
              where: { groupId: group.id },
            });
            
            if (groupIssues.length === 0) {
              skippedCount++;
              continue;
            }
            
            // Build expected labels from all issues in group
            const allLabels = new Set<string>();
            allLabels.add("issue-group");
            
            // Check if group has related Discord threads
            const groupThreadMatches = await prisma.issueThreadMatch.findMany({
              where: {
                issueNumber: { in: groupIssues.map(i => i.issueNumber) },
              },
              select: { threadId: true },
            });
            const threadIds = [...new Set(groupThreadMatches.map(m => m.threadId))];
            if (threadIds.length > 0) {
              allLabels.add("discord");
            }
            
            for (const issue of groupIssues) {
              issue.issueLabels?.forEach(l => allLabels.add(l));
              issue.detectedLabels?.forEach(l => allLabels.add(l));
            }
            
            // Calculate expected priority
            const expectedPriority = calculatePriority({
              labels: Array.from(allLabels),
              title: group.suggestedTitle || groupIssues[0]?.issueTitle || "",
              is_cross_cutting: group.isCrossCutting || false,
              thread_count: group.threadCount || 0,
            });
            
            // Get expected feature/project
            const primaryIssue = groupIssues[0];
            const issueFeatures = primaryIssue?.affectsFeatures as Array<{ id: string; name: string }> | null;
            const featureId = issueFeatures?.[0]?.id || "general";
            const expectedProjectId = projectMappings.get(featureId) || projectMappings.get("general");
            
            // Use DB labels as source of truth instead of fetching from Linear every time
            // But we still need to fetch from Linear to check title/priority/project
            let currentLabelNames = new Set<string>(group.linearLabels || []);
            let currentLinearIssue: Awaited<ReturnType<typeof getIssueMethod>> | null = null;
            
            // Always fetch from Linear when updating (to check title/priority/project)
            // The optimization is using DB labels instead of API labels for comparison
            currentLinearIssue = await getIssueMethod.call(linearTool, group.linearIssueId);
            if (!currentLinearIssue) {
              logError(`  Linear issue ${group.linearIssueId} not found`);
              errorCount++;
              continue;
            }
            
            // Update DB labels from Linear ONLY if they were missing in DB (first time sync)
            // Otherwise, use DB labels as source of truth
            if (group.linearLabels.length === 0 && currentLinearIssue.labelNames && Array.isArray(currentLinearIssue.labelNames)) {
              currentLabelNames = new Set(currentLinearIssue.labelNames);
              // Save to DB
              await prisma.group.update({
                where: { id: group.id },
                data: { linearLabels: Array.from(currentLabelNames) },
              });
            }
            
            // Build expected title with last comment info
            const lastCommentText = extractLastCommentTextFromIssues(groupIssues);
            const expectedTitleBase = group.suggestedTitle || `Issue Group ${group.id}`;
            const expectedTitle = lastCommentText ? `${lastCommentText} - ${expectedTitleBase}` : expectedTitleBase;
            
            // Build update object with only changed fields
            const updates: Partial<PMToolIssue> = {};
            let hasChanges = false;
            
            // Check if title needs updating (only if we fetched from Linear)
            if (currentLinearIssue && currentLinearIssue.title) {
              if (currentLinearIssue.title !== expectedTitle) {
                updates.title = expectedTitle;
                hasChanges = true;
              }
            }
            
            // If update_all_titles, only update title (skip other fields)
            if (updateAllTitles) {
              if (hasChanges) {
                // Only update title
              } else {
                // Title is already correct, skip
                skippedCount++;
                continue;
              }
            } else {
              // Normal update: check all fields
              if (currentLinearIssue && expectedProjectId && currentLinearIssue.projectId !== expectedProjectId) {
                updates.project_id = expectedProjectId;
                hasChanges = true;
              }
              
              // Merge labels: combine existing DB labels with expected labels (from GitHub + detected)
              // Only add new labels, don't remove existing ones
              const expectedLabelNames = Array.from(allLabels);
              const mergedLabels = new Set([...currentLabelNames, ...expectedLabelNames]);
              
              // Only update if there are new labels to add
              const hasNewLabels = expectedLabelNames.some(label => !currentLabelNames.has(label));
              if (hasNewLabels) {
                updates.labels = Array.from(mergedLabels).sort();
                hasChanges = true;
              }
              
              // Map priority to Linear number format for comparison (only if we fetched from Linear)
              if (currentLinearIssue && currentLinearIssue.priority !== undefined) {
                const linearPriorityMap: Record<string, number> = { urgent: 1, high: 2, medium: 3, low: 4 };
                const expectedPriorityNumber = linearPriorityMap[expectedPriority] || 0;
                if (currentLinearIssue.priority !== expectedPriorityNumber) {
                  updates.priority = expectedPriority;
                  hasChanges = true;
                }
              }
            }
            
            if (hasChanges) {
              if (dryRun) {
                log(`  [DRY RUN] Would update group ${group.id} (${group.linearIssueId}) with: ${JSON.stringify(updates)}`);
                updatedCount++;
              } else {
                try {
                  await updateIssueMethod.call(linearTool, group.linearIssueId, updates);
                  
                  // Save updated labels to DB
                  if (updates.labels) {
                    await prisma.group.update({
                      where: { id: group.id },
                      data: { linearLabels: updates.labels },
                    });
                  }
                  
                  log(`  Updated group ${group.id} (${group.linearIssueId}) with changes: ${Object.keys(updates).join(", ")}`);
                  updatedCount++;
                } catch (updateError) {
                  // If project assignment fails due to team mismatch, try to fix the project
                  const errorMsg = updateError instanceof Error ? updateError.message : String(updateError);
                  if (errorMsg.includes("Discrepancy between issue team") && updates.project_id && currentLinearIssue) {
                    const issueTeam = currentLinearIssue.teamName || currentLinearIssue.teamId || "unknown";
                    log(`  Project assignment failed for group ${group.id} (team mismatch: issue belongs to team "${issueTeam}"), attempting to update project to associate with UnMute team...`);
                    
                    // Try to update the project to associate with UnMute team
                    const updateProjectMethod = (linearTool as any).updateProjectTeam;
                    if (updateProjectMethod && typeof updateProjectMethod === 'function') {
                      try {
                        const projectUpdated = await updateProjectMethod.call(linearTool, updates.project_id);
                        if (projectUpdated) {
                          log(`  Successfully updated project ${updates.project_id} to associate with UnMute team, retrying group update...`);
                          // Retry the full update now that project is workspace-level
                          try {
                            await updateIssueMethod.call(linearTool, group.linearIssueId, updates);
                            log(`  Updated group ${group.id} (${group.linearIssueId}) with changes: ${Object.keys(updates).join(", ")}`);
                            updatedCount++;
                            continue; // Success, skip to next iteration
                          } catch (retryError) {
                            logError(`  Failed to update group ${group.id} after fixing project:`, retryError);
                            errorCount++;
                            continue;
                          }
                        }
                      } catch (projectUpdateError) {
                        logError(`  Failed to update project ${updates.project_id} team:`, projectUpdateError);
                      }
                    }
                    
                    // If project update failed or method doesn't exist, fall back to updating without project
                    log(`  Project update failed or unavailable, updating other fields only`);
                    const updatesWithoutProject = { ...updates };
                    delete updatesWithoutProject.project_id;
                    if (Object.keys(updatesWithoutProject).length > 0) {
                      try {
                        await updateIssueMethod.call(linearTool, group.linearIssueId, updatesWithoutProject);
                        log(`  Updated group ${group.id} (${group.linearIssueId}) with changes (without project): ${Object.keys(updatesWithoutProject).join(", ")}`);
                        updatedCount++;
                      } catch (retryError) {
                        logError(`  Failed to update group ${group.id} (even without project):`, retryError);
                        errorCount++;
                      }
                    } else {
                      log(`  Skipping group ${group.id} - only project changed and it's incompatible`);
                      skippedCount++;
                    }
                  } else {
                    throw updateError; // Re-throw if it's a different error
                  }
                }
              }
            } else {
              skippedCount++;
            }
          } catch (error) {
            logError(`  Failed to update group ${group.id}:`, error);
            errorCount++;
          }
        }
        
        // Update ungrouped issues
        for (const issue of exportedIssues) {
          try {
            if (!issue.linearIssueId) continue;
            
            // Build expected labels - check for Discord thread matches
            const threadMatches = await prisma.issueThreadMatch.findMany({
              where: { issueNumber: issue.issueNumber },
              select: { threadId: true },
            });
            
            const labels = [...(issue.issueLabels || []), ...(issue.detectedLabels || [])];
            if (threadMatches.length > 0) {
              labels.push("discord");
            }
            
            // Calculate expected priority
            const expectedPriority = calculatePriority({
              labels,
              title: issue.issueTitle || "",
              is_ungrouped: true,
            });
            
            // Get expected feature/project
            const issueFeatures = issue.affectsFeatures as Array<{ id: string; name: string }> | null;
            const featureId = issueFeatures?.[0]?.id || "general";
            const expectedProjectId = projectMappings.get(featureId) || projectMappings.get("general");
            
            // Use DB labels as source of truth instead of fetching from Linear every time
            // But we still need to fetch from Linear to check title/priority/project
            let currentLabelNames = new Set<string>(issue.linearLabels || []);
            let currentLinearIssue: Awaited<ReturnType<typeof getIssueMethod>> | null = null;
            
            // Always fetch from Linear when updating (to check title/priority/project)
            // The optimization is using DB labels instead of API labels for comparison
            currentLinearIssue = await getIssueMethod.call(linearTool, issue.linearIssueId);
            if (!currentLinearIssue) {
              logError(`  Linear issue ${issue.linearIssueId} not found`);
              errorCount++;
              continue;
            }
            
            // Update DB labels from Linear ONLY if they were missing in DB (first time sync)
            // Otherwise, use DB labels as source of truth
            if (issue.linearLabels.length === 0 && currentLinearIssue.labelNames && Array.isArray(currentLinearIssue.labelNames)) {
              currentLabelNames = new Set(currentLinearIssue.labelNames);
              // Save to DB
              await prisma.gitHubIssue.update({
                where: { issueNumber: issue.issueNumber },
                data: { linearLabels: Array.from(currentLabelNames) },
              });
            }
            
            // Build expected title with last comment info
            const lastCommentText = extractLastCommentText(issue.issueComments);
            const expectedTitleBase = issue.issueTitle || `GitHub Issue #${issue.issueNumber}`;
            const expectedTitle = lastCommentText ? `${lastCommentText} - ${expectedTitleBase}` : expectedTitleBase;
            
            // Build update object with only changed fields
            const updates: Partial<PMToolIssue> = {};
            let hasChanges = false;
            
            // Check if title needs updating (only if we fetched from Linear)
            if (currentLinearIssue && currentLinearIssue.title) {
              if (currentLinearIssue.title !== expectedTitle) {
                updates.title = expectedTitle;
                hasChanges = true;
              }
            }
            
            // If update_all_titles, only update title (skip other fields)
            if (updateAllTitles) {
              if (hasChanges) {
                // Only update title
              } else {
                // Title is already correct, skip
                skippedCount++;
                continue;
              }
            } else {
              // Normal update: check all fields
              if (currentLinearIssue && expectedProjectId && currentLinearIssue.projectId !== expectedProjectId) {
                updates.project_id = expectedProjectId;
                hasChanges = true;
              }
              
              // Merge labels: combine existing DB labels with expected labels (from GitHub + detected)
              // Only add new labels, don't remove existing ones
              const mergedLabels = new Set([...currentLabelNames, ...labels]);
              
              // Only update if there are new labels to add
              const hasNewLabels = labels.some(label => !currentLabelNames.has(label));
              if (hasNewLabels) {
                updates.labels = Array.from(mergedLabels).sort();
                hasChanges = true;
              }
              
              // Map priority to Linear number format for comparison (only if we fetched from Linear)
              if (currentLinearIssue && currentLinearIssue.priority !== undefined) {
                const linearPriorityMap: Record<string, number> = { urgent: 1, high: 2, medium: 3, low: 4 };
                const expectedPriorityNumber = linearPriorityMap[expectedPriority] || 0;
                if (currentLinearIssue.priority !== expectedPriorityNumber) {
                  updates.priority = expectedPriority;
                  hasChanges = true;
                }
              }
            }
            
            if (hasChanges) {
              if (dryRun) {
                log(`  [DRY RUN] Would update issue #${issue.issueNumber} (${issue.linearIssueId}) with: ${JSON.stringify(updates)}`);
                updatedCount++;
              } else {
                try {
                  await updateIssueMethod.call(linearTool, issue.linearIssueId, updates);
                  
                  // Save updated labels to DB
                  if (updates.labels) {
                    await prisma.gitHubIssue.update({
                      where: { issueNumber: issue.issueNumber },
                      data: { linearLabels: updates.labels },
                    });
                  }
                  
                  log(`  Updated issue #${issue.issueNumber} (${issue.linearIssueId}) with changes: ${Object.keys(updates).join(", ")}`);
                  updatedCount++;
                } catch (updateError) {
                  // If project assignment fails due to team mismatch, try to fix the project
                  const errorMsg = updateError instanceof Error ? updateError.message : String(updateError);
                  if (errorMsg.includes("Discrepancy between issue team") && updates.project_id && currentLinearIssue) {
                    const issueTeam = currentLinearIssue.teamName || currentLinearIssue.teamId || "unknown";
                    log(`  Project assignment failed for issue #${issue.issueNumber} (team mismatch: issue belongs to team "${issueTeam}"), attempting to update project to associate with UnMute team...`);
                    
                    // Try to update the project to associate with UnMute team
                    const updateProjectMethod = (linearTool as any).updateProjectTeam;
                    if (updateProjectMethod && typeof updateProjectMethod === 'function') {
                      try {
                        const projectUpdated = await updateProjectMethod.call(linearTool, updates.project_id);
                        if (projectUpdated) {
                          log(`  Successfully updated project ${updates.project_id} to associate with UnMute team, retrying issue update...`);
                          // Retry the full update now that project is workspace-level
                          try {
                            await updateIssueMethod.call(linearTool, issue.linearIssueId, updates);
                            log(`  Updated issue #${issue.issueNumber} (${issue.linearIssueId}) with changes: ${Object.keys(updates).join(", ")}`);
                            updatedCount++;
                            continue; // Success, skip to next iteration
                          } catch (retryError) {
                            logError(`  Failed to update issue #${issue.issueNumber} after fixing project:`, retryError);
                            errorCount++;
                            continue;
                          }
                        }
                      } catch (projectUpdateError) {
                        logError(`  Failed to update project ${updates.project_id} team:`, projectUpdateError);
                      }
                    }
                    
                    // If project update failed or method doesn't exist, fall back to updating without project
                    log(`  Project update failed or unavailable, updating other fields only`);
                    const updatesWithoutProject = { ...updates };
                    delete updatesWithoutProject.project_id;
                    if (Object.keys(updatesWithoutProject).length > 0) {
                      try {
                        await updateIssueMethod.call(linearTool, issue.linearIssueId, updatesWithoutProject);
                        log(`  Updated issue #${issue.issueNumber} (${issue.linearIssueId}) with changes (without project): ${Object.keys(updatesWithoutProject).join(", ")}`);
                        updatedCount++;
                      } catch (retryError) {
                        logError(`  Failed to update issue #${issue.issueNumber} (even without project):`, retryError);
                        errorCount++;
                      }
                    } else {
                      log(`  Skipping issue #${issue.issueNumber} - only project changed and it's incompatible`);
                      skippedCount++;
                    }
                  } else {
                    throw updateError; // Re-throw if it's a different error
                  }
                }
              }
            } else {
              skippedCount++;
            }
          } catch (error) {
            logError(`  Failed to update issue #${issue.issueNumber}:`, error);
            errorCount++;
          }
        }
        
        log(`Update complete: ${updatedCount} updated, ${skippedCount} unchanged, ${errorCount} errors`);
        
        // Add to result
        (result as ExportWorkflowResult & { issues_updated?: number; issues_unchanged?: number; issues_errors?: number }).issues_updated = updatedCount;
        (result as ExportWorkflowResult & { issues_updated?: number; issues_unchanged?: number; issues_errors?: number }).issues_unchanged = skippedCount;
        (result as ExportWorkflowResult & { issues_updated?: number; issues_unchanged?: number; issues_errors?: number }).issues_errors = errorCount;
      }
    }

    // =============================================================
    // STEP 5: Export to PM tool (or dry run)
    // =============================================================
    if (dryRun) {
      log(`[DRY RUN] Would export ${pmIssues.length} issues to ${pmToolConfig.type}`);
      
      // Return dry run result without actually exporting
      result.success = true;
      result.issues_exported = {
        created: 0,
        updated: 0,
        skipped: pmIssues.length,
      };
      
      // Add dry run details
      const dryRunDetails = {
        dry_run: true,
        would_export: pmIssues.length,
        groups_to_export: groups.length,
        ungrouped_issues_to_export: ungroupedIssues.length,
        items: pmIssues.map(i => ({
          source_id: i.source_id,
          title: i.title,
          labels: i.labels,
          feature: i.feature_name,
          has_discord_context: ((i.metadata as Record<string, unknown>)?.discord_threads_count as number || 0) > 0,
        })),
      };
      
      return {
        ...result,
        dry_run_details: dryRunDetails,
      } as ExportWorkflowResult & { dry_run_details: typeof dryRunDetails };
    }

    const exportResult = await pmTool.exportIssues(pmIssues);

    // =============================================================
    // STEP 6: Update database with export status
    // =============================================================
    if (exportResult.success) {
      try {
        log(`Updating export status for ${pmIssues.length} issues...`);
        let updatedCount = 0;
        for (const pmIssue of pmIssues) {
          log(`  Issue ${pmIssue.source_id}: linear_issue_id=${pmIssue.linear_issue_id || 'NOT SET'}`);
            if (pmIssue.linear_issue_id) {
              if (pmIssue.source_id.startsWith("group-")) {
                // Update group export status
                const groupId = pmIssue.source_id.replace("group-", "");
                await prisma.group.update({
                  where: { id: groupId },
                  data: {
                    status: "exported",
                    exportedAt: new Date(),
                    linearIssueId: pmIssue.linear_issue_id,
                    linearLabels: pmIssue.labels || [],
                  linearIssueUrl: pmIssue.linear_issue_url || null,
                  linearIssueIdentifier: pmIssue.linear_issue_identifier || null,
                },
              });
              updatedCount++;
              log(`    Updated group ${groupId} -> exported`);
            } else if (pmIssue.source_id.startsWith("github-issue-")) {
              // Update issue export status
              const issueNumber = parseInt(pmIssue.source_id.replace("github-issue-", ""), 10);
              if (!isNaN(issueNumber)) {
                await prisma.gitHubIssue.update({
                  where: { issueNumber },
                  data: {
                    exportStatus: "exported",
                    exportedAt: new Date(),
                    linearIssueId: pmIssue.linear_issue_id,
                    linearIssueUrl: pmIssue.linear_issue_url || null,
                    linearIssueIdentifier: pmIssue.linear_issue_identifier || null,
                    linearLabels: pmIssue.labels || [],
                  },
                });
                updatedCount++;
                log(`    Updated issue #${issueNumber} -> exported`);
              }
            }
          }
        }
        log(`Updated export status for ${updatedCount}/${pmIssues.length} items in database`);
      } catch (error) {
        logError("Error updating database with export status:", error);
      }
    }

    result.success = exportResult.success;
    result.issues_exported = {
      created: exportResult.created_issues,
      updated: exportResult.updated_issues,
      skipped: exportResult.skipped_issues,
    };
    result.errors = exportResult.errors?.map(e => e.error) || [];

    return result;
  } catch (error) {
    logError("Export issues to PM tool failed:", error);
    result.errors = [error instanceof Error ? error.message : String(error)];
    return result;
  }
}

