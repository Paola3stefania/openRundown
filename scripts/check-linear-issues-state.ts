#!/usr/bin/env tsx
/**
 * Check how many GitHub issues have Linear IDs and their states
 */

import "dotenv/config";
import { prisma } from "../src/storage/db/prisma.js";

async function main() {
  console.log("Checking GitHub issues with Linear IDs...\n");

  // Count all issues with linearIssueId
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

  // Count grouped vs ungrouped
  const grouped = await prisma.gitHubIssue.count({
    where: {
      linearIssueId: { not: null },
      groupId: { not: null },
    },
  });

  const ungrouped = await prisma.gitHubIssue.count({
    where: {
      linearIssueId: { not: null },
      groupId: null,
    },
  });

  // Count unique groups with linearIssueId
  const groupsWithLinearId = await prisma.group.count({
    where: {
      linearIssueId: { not: null },
    },
  });

  console.log(`Total GitHub issues with Linear ID: ${totalWithLinearId}`);
  console.log(`  Grouped issues: ${grouped}`);
  console.log(`  Ungrouped issues: ${ungrouped}`);
  console.log(`  Groups with Linear ID: ${groupsWithLinearId}`);
  console.log("\nIssues by state:");
  byState.forEach(item => {
    console.log(`  ${item.issueState || "null"}: ${item._count.issueNumber}`);
  });

  // Calculate estimated Linear tickets
  // Groups = 1 ticket per group
  // Ungrouped issues = 1 ticket per issue
  const estimatedLinearTickets = groupsWithLinearId + ungrouped;
  console.log(`\nEstimated Linear tickets: ${estimatedLinearTickets}`);
  console.log(`  (${groupsWithLinearId} groups + ${ungrouped} ungrouped issues)`);

  // Check closed issues with Linear IDs
  const closedWithLinearId = await prisma.gitHubIssue.count({
    where: {
      linearIssueId: { not: null },
      issueState: "closed",
    },
  });

  const openWithLinearId = await prisma.gitHubIssue.count({
    where: {
      linearIssueId: { not: null },
      issueState: "open",
    },
  });

  console.log(`\nOpen issues with Linear ID: ${openWithLinearId}`);
  console.log(`Closed issues with Linear ID: ${closedWithLinearId}`);
  
  if (closedWithLinearId > 0) {
    console.log(`\n[WARNING] Found ${closedWithLinearId} closed issues with Linear IDs!`);
    console.log("These should not have Linear tickets unless include_closed=true was used.");
  }

  await prisma.$disconnect();
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});

