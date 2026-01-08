#!/usr/bin/env tsx
/**
 * Clean up Linear tickets for closed GitHub issues
 * Archives Linear tickets that correspond to closed GitHub issues
 */

import "dotenv/config";
import { prisma } from "../src/storage/db/prisma.js";
import { LinearIntegration } from "../src/export/linear/client.js";

async function main() {
  const dryRun = process.argv.includes("--dry-run") || process.argv.includes("--execute") === false;
  const execute = process.argv.includes("--execute");

  if (!execute && !dryRun) {
    console.log("Usage:");
    console.log("  --dry-run    : Show what would be cleaned up (default)");
    console.log("  --execute    : Actually archive the Linear tickets");
    console.log("\nRun with --dry-run first to see what will be cleaned up.\n");
  }

  console.log("Finding closed GitHub issues with Linear IDs...\n");

  // Check required config
  if (!process.env.PM_TOOL_API_KEY) {
    throw new Error("PM_TOOL_API_KEY is required");
  }

  const pmToolConfig = {
    type: "linear" as const,
    api_key: process.env.PM_TOOL_API_KEY,
    team_id: process.env.PM_TOOL_TEAM_ID || undefined,
  };

  const linearTool = new LinearIntegration(pmToolConfig);

  // Get all closed issues with Linear IDs
  const closedIssues = await prisma.gitHubIssue.findMany({
    where: {
      linearIssueId: { not: null },
      issueState: "closed",
    },
    select: {
      issueNumber: true,
      issueTitle: true,
      issueUrl: true,
      linearIssueId: true,
      linearIssueIdentifier: true,
      linearIssueUrl: true,
      groupId: true,
    },
    orderBy: { issueNumber: 'desc' },
  });

  console.log(`Found ${closedIssues.length} closed GitHub issues with Linear IDs`);

  // Get all groups that only have closed issues (should also be cleaned up)
  const allGroups = await prisma.group.findMany({
    where: {
      linearIssueId: { not: null },
    },
    select: {
      id: true,
      suggestedTitle: true,
      linearIssueId: true,
      linearIssueIdentifier: true,
      linearIssueUrl: true,
    },
  });

  const groupsToCleanup: Array<{
    id: string;
    title: string;
    linearIssueId: string;
    linearIssueIdentifier: string | null;
    linearIssueUrl: string | null;
    issueCount: number;
    openIssueCount: number;
  }> = [];

  for (const group of allGroups) {
    const groupIssues = await prisma.gitHubIssue.findMany({
      where: { groupId: group.id },
      select: { issueState: true },
    });

    const openIssueCount = groupIssues.filter(i => i.issueState === "open").length;
    
    // Only cleanup groups that have NO open issues (all closed)
    if (openIssueCount === 0 && groupIssues.length > 0) {
      groupsToCleanup.push({
        id: group.id,
        title: group.suggestedTitle || `Group ${group.id}`,
        linearIssueId: group.linearIssueId!,
        linearIssueIdentifier: group.linearIssueIdentifier,
        linearIssueUrl: group.linearIssueUrl,
        issueCount: groupIssues.length,
        openIssueCount: 0,
      });
    }
  }

  console.log(`Found ${groupsToCleanup.length} groups with only closed issues\n`);

  const totalToCleanup = closedIssues.length + groupsToCleanup.length;
  console.log(`Total Linear tickets to archive: ${totalToCleanup}`);
  console.log(`  - ${closedIssues.length} ungrouped closed issues`);
  console.log(`  - ${groupsToCleanup.length} groups with only closed issues\n`);

  if (dryRun) {
    console.log("[DRY RUN] Would archive the following Linear tickets:\n");
    
    if (closedIssues.length > 0) {
      console.log("Ungrouped closed issues:");
      closedIssues.slice(0, 20).forEach(issue => {
        console.log(`  - ${issue.linearIssueIdentifier || issue.linearIssueId}: ${issue.issueTitle}`);
      });
      if (closedIssues.length > 20) {
        console.log(`  ... and ${closedIssues.length - 20} more`);
      }
      console.log();
    }

    if (groupsToCleanup.length > 0) {
      console.log("Groups with only closed issues:");
      groupsToCleanup.slice(0, 10).forEach(group => {
        console.log(`  - ${group.linearIssueIdentifier || group.linearIssueId}: ${group.title} (${group.issueCount} closed issues)`);
      });
      if (groupsToCleanup.length > 10) {
        console.log(`  ... and ${groupsToCleanup.length - 10} more`);
      }
      console.log();
    }

    console.log(`\nRun with --execute to actually archive these Linear tickets.`);
    console.log(`This will NOT delete them from Linear - they will be archived (moved to trash).`);
    
    await prisma.$disconnect();
    return;
  }

  // EXECUTE: Actually archive the Linear tickets
  console.log(`[EXECUTING] Archiving ${totalToCleanup} Linear tickets...\n`);
  console.log("This may take a while (processing in batches with delays)...\n");

  let archivedCount = 0;
  let errorCount = 0;
  const DELAY_BETWEEN_REQUESTS = 100; // 100ms delay (faster, but still safe for rate limits)
  const BATCH_SIZE = 10; // Process 10 issues in parallel batches

  // Archive ungrouped closed issues in parallel batches
  async function archiveIssue(issue: typeof closedIssues[0]): Promise<boolean> {
    try {
      const archiveQuery = `
        mutation ArchiveIssue($id: String!) {
          issueArchive(id: $id) {
            success
          }
        }
      `;

      const response = await fetch("https://api.linear.app/graphql", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": process.env.PM_TOOL_API_KEY!,
        },
        body: JSON.stringify({
          query: archiveQuery,
          variables: { id: issue.linearIssueId },
        }),
      });

      const result = await response.json() as {
        data?: { issueArchive?: { success: boolean } };
        errors?: Array<{ message: string }>;
      };

      if (result.data?.issueArchive?.success) {
        // Clear the Linear IDs from database
        await prisma.gitHubIssue.update({
          where: { issueNumber: issue.issueNumber },
          data: {
            linearIssueId: null,
            linearIssueUrl: null,
            linearIssueIdentifier: null,
            exportStatus: null,
          },
        });
        return true;
      } else {
        const errorMsg = result.errors?.map(e => e.message).join(", ") || "Unknown error";
        console.error(`  Failed to archive ${issue.linearIssueIdentifier || issue.linearIssueId}: ${errorMsg}`);
        return false;
      }
    } catch (error) {
      console.error(`  Error archiving ${issue.linearIssueIdentifier || issue.linearIssueId}:`, error);
      return false;
    }
  }

  // Process in batches
  for (let i = 0; i < closedIssues.length; i += BATCH_SIZE) {
    const batch = closedIssues.slice(i, i + BATCH_SIZE);
    const batchResults = await Promise.all(batch.map(issue => archiveIssue(issue)));
    
    const batchArchived = batchResults.filter(r => r === true).length;
    archivedCount += batchArchived;
    errorCount += batchResults.length - batchArchived;

    const processed = Math.min(i + BATCH_SIZE, closedIssues.length);
    if (processed % 50 === 0 || processed === closedIssues.length) {
      console.log(`[${processed}/${closedIssues.length}] Archived ${archivedCount} issues so far...`);
    }

    // Small delay between batches
    if (i + BATCH_SIZE < closedIssues.length) {
      await new Promise(resolve => setTimeout(resolve, DELAY_BETWEEN_REQUESTS));
    }
  }

  console.log(`\nArchived ${archivedCount} ungrouped closed issues. ${errorCount} errors.`);

  // Archive groups with only closed issues
  let groupArchivedCount = 0;
  let groupErrorCount = 0;

  async function archiveGroup(group: typeof groupsToCleanup[0]): Promise<boolean> {
    try {
      const archiveQuery = `
        mutation ArchiveIssue($id: String!) {
          issueArchive(id: $id) {
            success
          }
        }
      `;

      const response = await fetch("https://api.linear.app/graphql", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": process.env.PM_TOOL_API_KEY!,
        },
        body: JSON.stringify({
          query: archiveQuery,
          variables: { id: group.linearIssueId },
        }),
      });

      const result = await response.json() as {
        data?: { issueArchive?: { success: boolean } };
        errors?: Array<{ message: string }>;
      };

      if (result.data?.issueArchive?.success) {
        // Clear the Linear IDs from database
        await prisma.group.update({
          where: { id: group.id },
          data: {
            linearIssueId: null,
            linearIssueUrl: null,
            linearIssueIdentifier: null,
            status: "pending",
          },
        });
        return true;
      } else {
        const errorMsg = result.errors?.map(e => e.message).join(", ") || "Unknown error";
        console.error(`  Failed to archive group ${group.linearIssueIdentifier || group.linearIssueId}: ${errorMsg}`);
        return false;
      }
    } catch (error) {
      console.error(`  Error archiving group ${group.linearIssueIdentifier || group.linearIssueId}:`, error);
      return false;
    }
  }

  // Process groups in parallel
  const groupResults = await Promise.all(groupsToCleanup.map(group => archiveGroup(group)));
  groupArchivedCount = groupResults.filter(r => r === true).length;
  groupErrorCount = groupResults.length - groupArchivedCount;
  
  if (groupsToCleanup.length > 0) {
    console.log(`Archived ${groupArchivedCount} groups. ${groupErrorCount} errors.`);
  }

  console.log(`\nArchived ${groupArchivedCount} groups with only closed issues. ${groupErrorCount} errors.`);

  console.log(`\n[COMPLETE]`);
  console.log(`  Archived ${archivedCount + groupArchivedCount} Linear tickets total`);
  console.log(`  ${errorCount + groupErrorCount} errors`);
  console.log(`\nLinear tickets have been archived (moved to trash) and Linear IDs cleared from database.`);

  await prisma.$disconnect();
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});

