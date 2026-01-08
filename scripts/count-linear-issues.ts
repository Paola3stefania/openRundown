#!/usr/bin/env tsx
/**
 * Count how many Linear issues we have in the database
 */

import "dotenv/config";
import { prisma } from "../src/storage/db/prisma.js";

async function main() {
  console.log("Counting Linear issues in database...\n");

  // Count all GitHub issues with linearIssueId
  const totalWithLinearId = await prisma.gitHubIssue.count({
    where: {
      linearIssueId: { not: null },
    },
  });

  // Count by state
  const byState = await prisma.gitHubIssue.groupBy({
    by: ["issueState"],
    where: {
      linearIssueId: { not: null },
    },
    _count: { issueNumber: true },
  });

  // Count exported vs not exported
  const exportedCount = await prisma.gitHubIssue.count({
    where: {
      linearIssueId: { not: null },
      exportStatus: "exported",
    },
  });

  const pendingCount = await prisma.gitHubIssue.count({
    where: {
      linearIssueId: { not: null },
      exportStatus: { not: "exported" },
    },
  });

  // Count by Linear status
  const byLinearStatus = await prisma.gitHubIssue.groupBy({
    by: ["linearStatus"],
    where: {
      linearIssueId: { not: null },
    },
    _count: { issueNumber: true },
  });

  console.log("=== Linear Issues Count ===");
  console.log(`Total GitHub issues with Linear ID: ${totalWithLinearId}`);
  console.log(`\nBy Export Status:`);
  console.log(`  - Exported: ${exportedCount}`);
  console.log(`  - Pending/Other: ${pendingCount}`);

  console.log(`\nBy GitHub Issue State:`);
  for (const state of byState) {
    console.log(`  - ${state.issueState || "null"}: ${state._count.issueNumber}`);
  }

  console.log(`\nBy Linear Status:`);
  for (const status of byLinearStatus) {
    console.log(`  - ${status.linearStatus || "null"}: ${status._count.issueNumber}`);
  }

  // Count backlog specifically
  const backlogCount = await prisma.gitHubIssue.count({
    where: {
      linearIssueId: { not: null },
      linearStatus: "backlog",
    },
  });

  console.log(`\n=== Backlog Count ===`);
  console.log(`Issues in Linear backlog: ${backlogCount}`);

  // Total GitHub issues (for reference)
  const totalGitHubIssues = await prisma.gitHubIssue.count();
  console.log(`\n=== For Reference ===`);
  console.log(`Total GitHub issues in DB: ${totalGitHubIssues}`);
  console.log(`GitHub issues WITHOUT Linear ID: ${totalGitHubIssues - totalWithLinearId}`);

  await prisma.$disconnect();
}

main().catch(console.error);


