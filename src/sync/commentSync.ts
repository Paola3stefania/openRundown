/**
 * Comment-Based Linear Issue Sync
 * Syncs Linear issue status and assignee when organization engineers comment on GitHub issues
 * 
 * Logic:
 * 1. Get all open GitHub issues that have Linear issues
 * 2. Check comments for responses from organization engineers
 * 3. If an engineer commented:
 *    - Set Linear issue status to "In Progress"
 *    - Assign Linear issue to that engineer
 */

import { PrismaClient } from "@prisma/client";
import { LinearIntegration } from "../export/linear/client.js";
import { log, logError } from "../mcp/logger.js";
import { 
  getOrganizationEngineerGitHubMap 
} from "./csvParser.js";

// ============================================================================
// Types
// ============================================================================

export interface UserMapping {
  githubUsername: string;
  linearUserId: string;
}

export interface CommentSyncResult {
  totalChecked: number;
  updated: number;
  unchanged: number;
  skipped: number;
  errors: number;
  details: Array<{
    issueNumber: number;
    linearIdentifier?: string;
    action: string;
    engineer?: string;
    reason: string;
  }>;
}

interface CommentSyncOptions {
  dryRun?: boolean;
  userMappings?: UserMapping[];
  organizationEngineers?: string[];
}

// ============================================================================
// Main Function
// ============================================================================

/**
 * Sync Linear issues based on engineer comments
 * If an organization engineer commented on a GitHub issue, assign them and set to In Progress
 */
export async function syncEngineerComments(options: CommentSyncOptions = {}): Promise<CommentSyncResult> {
  const { dryRun = false, userMappings = [], organizationEngineers = [] } = options;
  const prisma = new PrismaClient();
  
  const result: CommentSyncResult = {
    totalChecked: 0,
    updated: 0,
    unchanged: 0,
    skipped: 0,
    errors: 0,
    details: [],
  };

  try {
    // Get organization engineers from CSV if not provided
    let engineers = [...organizationEngineers];
    let mappings = [...userMappings];
    
    if (engineers.length === 0) {
      // CSV map is email -> githubUsername, we need GitHub usernames as engineers
      const csvMap = await getOrganizationEngineerGitHubMap();
      engineers = Array.from(csvMap.values()).filter(Boolean);
      
      log(`[CommentSync] Loaded ${engineers.length} engineers from CSV: ${engineers.join(", ")}`);
    }
    
    if (engineers.length === 0) {
      log("[CommentSync] No organization engineers configured. Skipping.");
      return result;
    }
    
    log(`[CommentSync] Starting sync with ${engineers.length} organization engineers...`);
    log(`[CommentSync] Engineers: ${engineers.join(", ")}`);
    
    // Initialize Linear client
    const linearConfig = {
      type: "linear" as const,
      api_key: process.env.PM_TOOL_API_KEY || "",
      team_id: process.env.PM_TOOL_TEAM_ID || "",
      api_url: "https://api.linear.app/graphql",
    };
    
    if (!linearConfig.api_key || !linearConfig.team_id) {
      throw new Error("Linear API key and team ID are required");
    }
    
    const linear = new LinearIntegration(linearConfig);
    
    // Get "In Progress" state
    const inProgressState = await linear.findWorkflowState("In Progress");
    if (!inProgressState) {
      throw new Error("Could not find 'In Progress' state in Linear");
    }
    
    // Get all GitHub issues with Linear IDs that are open
    const issues = await prisma.gitHubIssue.findMany({
      where: {
        linearIssueId: { not: null },
        issueState: "open",
      },
      select: {
        issueNumber: true,
        issueTitle: true,
        issueComments: true,
        linearIssueId: true,
        linearIssueIdentifier: true,
        linearStatus: true,
      },
    });
    
    log(`[CommentSync] Found ${issues.length} open issues with Linear IDs`);
    result.totalChecked = issues.length;
    
    // Build username to Linear ID map
    const userMap = new Map<string, string>();
    for (const mapping of mappings) {
      userMap.set(mapping.githubUsername.toLowerCase(), mapping.linearUserId);
    }
    
    for (const issue of issues) {
      try {
        // Skip if already in progress
        if (issue.linearStatus === "in_progress") {
          result.unchanged++;
          continue;
        }
        
        // Parse comments
        const comments = issue.issueComments as Array<{ author?: string; body?: string }> || [];
        
        // Find first comment from an organization engineer
        let assignedEngineer: string | null = null;
        let assignedLinearUserId: string | null = null;
        
        for (const comment of comments) {
          const author = comment.author?.toLowerCase();
          if (author && engineers.map(e => e.toLowerCase()).includes(author)) {
            assignedEngineer = comment.author || author;
            assignedLinearUserId = userMap.get(author) || null;
            break; // Use first engineer who commented
          }
        }
        
        if (!assignedEngineer) {
          result.skipped++;
          continue;
        }
        
        // Found an engineer comment - update Linear
        if (!dryRun) {
          await linear.updateIssueStateAndAssignee(
            issue.linearIssueId!,
            inProgressState.id,
            assignedLinearUserId
          );
          
          // Update database
          await prisma.gitHubIssue.updateMany({
            where: { issueNumber: issue.issueNumber },
            data: {
              linearStatus: "in_progress",
              linearStatusSyncedAt: new Date(),
            },
          });
        }
        
        result.updated++;
        result.details.push({
          issueNumber: issue.issueNumber,
          linearIdentifier: issue.linearIssueIdentifier || undefined,
          action: dryRun ? "would_update" : "updated",
          engineer: assignedEngineer,
          reason: `Engineer ${assignedEngineer} commented on issue`,
        });
        
        log(`[CommentSync] ${dryRun ? "[DRY RUN] Would update" : "Updated"} #${issue.issueNumber} - assigned to ${assignedEngineer}${assignedLinearUserId ? ` (Linear: ${assignedLinearUserId})` : ""}`);
        
      } catch (error) {
        result.errors++;
        logError(`[CommentSync] Error processing issue #${issue.issueNumber}:`, error);
      }
    }
    
    log(`[CommentSync] Complete: ${result.updated} updated, ${result.unchanged} unchanged, ${result.skipped} skipped, ${result.errors} errors`);
    
    return result;
    
  } finally {
    await prisma.$disconnect();
  }
}
