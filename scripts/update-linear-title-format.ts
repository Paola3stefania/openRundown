#!/usr/bin/env tsx
/**
 * Update existing Linear tickets to use new title format:
 * OLD: "Title - Last comment: X days ago"
 * NEW: "X days ago - Title"
 */

import "dotenv/config";
import { prisma } from "../src/storage/db/prisma.js";
import { LinearIntegration } from "../src/export/linear/client.js";

// Import the extractLastCommentText functions
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

  commentsWithDates.sort((a, b) => b.getTime() - a.getTime());
  const lastCommentDate = commentsWithDates[0];

  const now = new Date();
  const diffMs = now.getTime() - lastCommentDate.getTime();
  const daysAgo = Math.floor(diffMs / (1000 * 60 * 60 * 24));

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

function extractLastCommentTextFromIssues(issues: Array<{ issueComments?: unknown }>): string | null {
  const allCommentDates: Date[] = [];

  for (const issue of issues) {
    if (!issue.issueComments) continue;

    const comments = issue.issueComments as Array<{
      created_at?: string;
      updated_at?: string;
    }>;

    if (!Array.isArray(comments)) continue;

    const dates = comments
      .map(c => {
        const dateStr = c.created_at || c.updated_at;
        if (!dateStr) return null;
        return new Date(dateStr);
      })
      .filter((c): c is Date => c !== null);

    allCommentDates.push(...dates);
  }

  if (allCommentDates.length === 0) {
    return null;
  }

  allCommentDates.sort((a, b) => b.getTime() - a.getTime());
  const lastCommentDate = allCommentDates[0];

  const now = new Date();
  const diffMs = now.getTime() - lastCommentDate.getTime();
  const daysAgo = Math.floor(diffMs / (1000 * 60 * 60 * 24));

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

async function main() {
  const dryRun = process.argv.includes("--dry-run") || !process.argv.includes("--execute");

  if (!process.env.PM_TOOL_API_KEY) {
    throw new Error("PM_TOOL_API_KEY is required");
  }

  const pmToolConfig = {
    type: "linear" as const,
    api_key: process.env.PM_TOOL_API_KEY,
    team_id: process.env.PM_TOOL_TEAM_ID || undefined,
  };

  const linearTool = new LinearIntegration(pmToolConfig);

  console.log("Finding Linear tickets to update title format...\n");

  // Get all exported groups
  const exportedGroups = await prisma.group.findMany({
    where: {
      linearIssueId: { not: null },
    },
    select: {
      id: true,
      suggestedTitle: true,
      linearIssueId: true,
      linearIssueIdentifier: true,
    },
  });

  // Get all exported ungrouped issues
  const exportedIssues = await prisma.gitHubIssue.findMany({
    where: {
      linearIssueId: { not: null },
      groupId: null,
      issueState: "open", // Only update open issues
    },
    select: {
      issueNumber: true,
      issueTitle: true,
      linearIssueId: true,
      linearIssueIdentifier: true,
      issueComments: true,
    },
  });

  console.log(`Found ${exportedGroups.length} groups and ${exportedIssues.length} ungrouped issues to check\n`);

  const BATCH_SIZE = 10;
  const DELAY_BETWEEN_REQUESTS = 100;

  let updatedCount = 0;
  let skippedCount = 0;
  let errorCount = 0;

  // Update groups
  async function updateGroupTitle(group: typeof exportedGroups[0]): Promise<boolean> {
    try {
      // Get current Linear issue
      const currentIssue = await linearTool.getIssue(group.linearIssueId!);
      if (!currentIssue) {
        console.error(`  Group ${group.linearIssueIdentifier || group.linearIssueId}: Linear issue not found`);
        return false;
      }

      // Get all issues in the group
      const groupIssues = await prisma.gitHubIssue.findMany({
        where: { groupId: group.id },
        select: { issueComments: true },
      });

      // Build expected title with new format
      const lastCommentText = extractLastCommentTextFromIssues(groupIssues);
      const expectedTitleBase = group.suggestedTitle || `Issue Group ${group.id}`;
      const expectedTitle = lastCommentText ? `${lastCommentText} - ${expectedTitleBase}` : expectedTitleBase;

      // Check if title needs updating
      const currentTitle = currentIssue.title || "";
      if (currentTitle === expectedTitle) {
        return false; // Already correct
      }

      // Check if it's in old format
      const oldFormatPattern = /^(.+?)\s*-\s*Last comment:\s*(.+)$/;
      const match = currentTitle.match(oldFormatPattern);
      if (!match && currentTitle !== expectedTitleBase) {
        // Not in old format and not the base title - might already be updated or different
        console.log(`  Group ${group.linearIssueIdentifier || group.linearIssueId}: Title doesn't match expected pattern (current: "${currentTitle}")`);
        return false;
      }

      if (dryRun) {
        console.log(`  Would update group ${group.linearIssueIdentifier || group.linearIssueId}:`);
        console.log(`    FROM: "${currentTitle}"`);
        console.log(`    TO:   "${expectedTitle}"`);
        return true;
      }

      // Update title
      await linearTool.updateIssue(group.linearIssueId!, { title: expectedTitle });
      console.log(`  Updated group ${group.linearIssueIdentifier || group.linearIssueId}: "${expectedTitle}"`);
      return true;
    } catch (error) {
      console.error(`  Error updating group ${group.linearIssueIdentifier || group.linearIssueId}:`, error);
      return false;
    }
  }

  // Update ungrouped issues
  async function updateIssueTitle(issue: typeof exportedIssues[0]): Promise<boolean> {
    try {
      // Get current Linear issue
      const currentIssue = await linearTool.getIssue(issue.linearIssueId!);
      if (!currentIssue) {
        console.error(`  Issue ${issue.linearIssueIdentifier || issue.linearIssueId}: Linear issue not found`);
        return false;
      }

      // Build expected title with new format
      const lastCommentText = extractLastCommentText(issue.issueComments);
      const expectedTitleBase = issue.issueTitle || `GitHub Issue #${issue.issueNumber}`;
      const expectedTitle = lastCommentText ? `${lastCommentText} - ${expectedTitleBase}` : expectedTitleBase;

      // Check if title needs updating
      const currentTitle = currentIssue.title || "";
      if (currentTitle === expectedTitle) {
        return false; // Already correct
      }

      // Check if it's in old format
      const oldFormatPattern = /^(.+?)\s*-\s*Last comment:\s*(.+)$/;
      const match = currentTitle.match(oldFormatPattern);
      if (!match && currentTitle !== expectedTitleBase) {
        // Not in old format and not the base title - might already be updated or different
        console.log(`  Issue ${issue.linearIssueIdentifier || issue.linearIssueId}: Title doesn't match expected pattern (current: "${currentTitle}")`);
        return false;
      }

      if (dryRun) {
        console.log(`  Would update issue ${issue.linearIssueIdentifier || issue.linearIssueId}:`);
        console.log(`    FROM: "${currentTitle}"`);
        console.log(`    TO:   "${expectedTitle}"`);
        return true;
      }

      // Update title
      await linearTool.updateIssue(issue.linearIssueId!, { title: expectedTitle });
      console.log(`  Updated issue ${issue.linearIssueIdentifier || issue.linearIssueId}: "${expectedTitle}"`);
      return true;
    } catch (error) {
      console.error(`  Error updating issue ${issue.linearIssueIdentifier || issue.linearIssueId}:`, error);
      return false;
    }
  }

  if (dryRun) {
    console.log("[DRY RUN] Would update the following Linear tickets:\n");
  } else {
    console.log("[EXECUTING] Updating Linear ticket titles...\n");
  }

  // Process groups in batches
  for (let i = 0; i < exportedGroups.length; i += BATCH_SIZE) {
    const batch = exportedGroups.slice(i, i + BATCH_SIZE);
    const results = await Promise.all(batch.map(group => updateGroupTitle(group)));
    
    const batchUpdated = results.filter(r => r === true).length;
    updatedCount += batchUpdated;
    skippedCount += results.length - batchUpdated;
    errorCount += 0; // Errors are logged, not counted separately

    if (i + BATCH_SIZE < exportedGroups.length) {
      await new Promise(resolve => setTimeout(resolve, DELAY_BETWEEN_REQUESTS));
    }
  }

  // Process ungrouped issues in batches
  for (let i = 0; i < exportedIssues.length; i += BATCH_SIZE) {
    const batch = exportedIssues.slice(i, i + BATCH_SIZE);
    const results = await Promise.all(batch.map(issue => updateIssueTitle(issue)));
    
    const batchUpdated = results.filter(r => r === true).length;
    updatedCount += batchUpdated;
    skippedCount += results.length - batchUpdated;

    if ((i + BATCH_SIZE) % 50 === 0 || i + BATCH_SIZE >= exportedIssues.length) {
      const processed = Math.min(i + BATCH_SIZE, exportedIssues.length);
      if (!dryRun) {
        console.log(`[${processed}/${exportedIssues.length}] Processed ${processed} ungrouped issues...`);
      }
    }

    if (i + BATCH_SIZE < exportedIssues.length) {
      await new Promise(resolve => setTimeout(resolve, DELAY_BETWEEN_REQUESTS));
    }
  }

  console.log(`\n[${dryRun ? "DRY RUN" : "COMPLETE"}]`);
  console.log(`  ${updatedCount} tickets ${dryRun ? "would be" : ""} updated`);
  console.log(`  ${skippedCount} tickets skipped (already correct or different format)`);
  
  if (dryRun) {
    console.log(`\nRun with --execute to actually update the titles.`);
  }

  await prisma.$disconnect();
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});

