#!/usr/bin/env tsx
/**
 * Test script to debug duplicate deletion
 */

import "dotenv/config";

async function main() {
  if (!process.env.PM_TOOL_API_KEY) {
    console.error("Error: PM_TOOL_API_KEY is required");
    process.exit(1);
  }

  const teamId = process.env.PM_TOOL_TEAM_ID;
  if (!teamId) {
    console.error("Error: PM_TOOL_TEAM_ID is required");
    process.exit(1);
  }

  console.log(`Fetching issues for team ${teamId}...`);

  // Fetch first 10 issues to test
  const query = `
    query GetTeamIssues($teamId: String!, $first: Int!) {
      team(id: $teamId) {
        issues(first: $first, includeArchived: true) {
          nodes {
            id
            identifier
            url
            title
            state {
              name
            }
          }
        }
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
      query,
      variables: { teamId, first: 10 },
    }),
  });

  const result = await response.json() as {
    data?: {
      team?: {
        issues?: {
          nodes?: Array<{
            id: string;
            identifier: string;
            url: string;
            title: string;
            state?: { name: string };
          }>;
        };
      };
    };
    errors?: Array<{ message: string }>;
  };

  if (result.errors) {
    console.error("GraphQL errors:", result.errors);
    process.exit(1);
  }

  const issues = result.data?.team?.issues?.nodes || [];
  console.log(`Found ${issues.length} issues\n`);

  if (issues.length === 0) {
    console.log("No issues found");
    return;
  }

  // Test deletion on the first issue (CAREFUL!)
  const testIssue = issues[0];
  console.log(`Testing deletion on: ${testIssue.identifier} - ${testIssue.title}`);
  console.log(`ID: ${testIssue.id}`);
  console.log(`URL: ${testIssue.url}\n`);

  console.log("THIS WILL DELETE AN ISSUE! Uncomment below to proceed.");
  console.log("If you want to proceed, uncomment the deletion code below.\n");

  /*
  // First archive
  console.log("Step 1: Archiving issue...");
  const archiveQuery = `
    mutation ArchiveIssue($id: String!) {
      issueArchive(id: $id) {
        success
      }
    }
  `;

  const archiveResponse = await fetch("https://api.linear.app/graphql", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": process.env.PM_TOOL_API_KEY!,
    },
    body: JSON.stringify({
      query: archiveQuery,
      variables: { id: testIssue.id },
    }),
  });

  const archiveResult = await archiveResponse.json() as {
    data?: { issueArchive?: { success: boolean } };
    errors?: Array<{ message: string }>;
  };

  console.log("Archive result:", archiveResult);

  if (!archiveResult.data?.issueArchive?.success) {
    console.error("Failed to archive:", archiveResult.errors);
    process.exit(1);
  }

  console.log("Issue archived successfully. Waiting 1 second...");
  await new Promise(resolve => setTimeout(resolve, 1000));

  // Then delete
  console.log("\nStep 2: Permanently deleting issue...");
  const deleteQuery = `
    mutation DeleteIssue($id: String!) {
      issueDelete(id: $id) {
        success
      }
    }
  `;

  const deleteResponse = await fetch("https://api.linear.app/graphql", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": process.env.PM_TOOL_API_KEY!,
    },
    body: JSON.stringify({
      query: deleteQuery,
      variables: { id: testIssue.id },
    }),
  });

  const deleteResult = await deleteResponse.json() as {
    data?: { issueDelete?: { success: boolean } };
    errors?: Array<{ message: string }>;
  };

  console.log("Delete result:", deleteResult);

  if (deleteResult.data?.issueDelete?.success) {
    console.log(`\nSuccessfully deleted ${testIssue.identifier}!`);
  } else {
    console.error("Failed to delete:", deleteResult.errors);
  }
  */
}

main().catch(console.error);


