/**
 * Combined Sync Workflow
 * Runs both PR-based sync and Linear status sync in sequence
 * 
 * Workflow:
 * 1. PR-based sync: Sets Linear issues to "In Progress" when open PRs are found + assigns users
 * 2. Linear status sync: Marks Linear issues as "Done" when issues are closed or PRs are merged
 */

import { syncPRBasedStatus, type SyncSummary as PRSyncSummary } from "./prBasedSync.js";
import { syncLinearStatus, type SyncSummary as LinearSyncSummary } from "./linearStatusSync.js";
import { log } from "../mcp/logger.js";

export interface CombinedSyncOptions {
  dryRun?: boolean;
  force?: boolean;
  userMappings?: Array<{ githubUsername: string; linearUserId: string }>;
  organizationEngineers?: string[];
  defaultAssigneeId?: string;
}

export interface CombinedSyncResult {
  success: boolean;
  dryRun: boolean;
  prSync: PRSyncSummary;
  linearSync: LinearSyncSummary;
  summary: {
    totalIssuesChecked: number;
    totalLinearTicketsChecked: number;
    issuesSetToInProgress: number;
    ticketsMarkedAsDone: number;
    ticketsMarkedAsReview: number;
    totalUpdated: number;
  };
}

/**
 * Run combined sync workflow: PR-based sync + Linear status sync
 */
export async function runCombinedSync(
  options: CombinedSyncOptions = {}
): Promise<CombinedSyncResult> {
  const { dryRun = false, force = false, userMappings, organizationEngineers, defaultAssigneeId } = options;

  log("[Combined Sync] Starting combined sync workflow...");
  log("[Combined Sync] Step 1: Running PR-based sync (In Progress + Assignment)");
  
  // Step 1: PR-based sync - sets issues to In Progress and assigns users
  const prSyncResult = await syncPRBasedStatus({
    dryRun,
    userMappings,
    organizationEngineers,
    defaultAssigneeId,
  });

  log(`[Combined Sync] PR sync complete: ${prSyncResult.updated} updated (${prSyncResult.setToInProgress} In Progress, ${prSyncResult.setToReview} Review), ${prSyncResult.unchanged} unchanged, ${prSyncResult.skipped} skipped`);

  log("[Combined Sync] Step 2: Running Linear status sync (Done status)");
  
  // Step 2: Linear status sync - marks issues as Done when closed/merged
  const linearSyncResult = await syncLinearStatus({
    dryRun,
    force,
  });

  log(`[Combined Sync] Linear status sync complete: ${linearSyncResult.markedDone} marked done, ${linearSyncResult.markedReview || 0} marked review, ${linearSyncResult.unchanged} unchanged`);

  // Combine Review status from both PR sync (merged PRs) and Linear sync (comment analysis)
  const totalReview = prSyncResult.setToReview + (linearSyncResult.markedReview || 0);

  const summary = {
    totalIssuesChecked: prSyncResult.totalIssues,
    totalLinearTicketsChecked: linearSyncResult.totalLinearTickets,
    issuesSetToInProgress: prSyncResult.setToInProgress,
    ticketsMarkedAsDone: linearSyncResult.markedDone,
    ticketsMarkedAsReview: totalReview,
    totalUpdated: prSyncResult.updated + linearSyncResult.markedDone + (linearSyncResult.markedReview || 0),
  };

  log(`[Combined Sync] Workflow complete: ${summary.totalUpdated} total updates (${summary.issuesSetToInProgress} In Progress, ${summary.ticketsMarkedAsDone} Done, ${summary.ticketsMarkedAsReview} Review)`);

  return {
    success: true,
    dryRun,
    prSync: prSyncResult,
    linearSync: linearSyncResult,
    summary,
  };
}






