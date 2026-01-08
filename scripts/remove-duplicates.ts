#!/usr/bin/env tsx
/**
 * Script to remove duplicate Linear issues
 * Uses the same logic as the remove_linear_duplicates MCP tool
 */

import "dotenv/config";

async function main() {
  const dryRun = process.argv.includes("--dry-run") || !process.argv.includes("--execute");
  
  if (!dryRun && !process.argv.includes("--execute")) {
    console.log("Usage: npx tsx scripts/remove-duplicates.ts [--dry-run] [--execute]");
    console.log("  --dry-run: Show what would be deleted (default)");
    console.log("  --execute: Actually delete duplicates");
    process.exit(1);
  }
  
  console.log(`Running duplicate removal${dryRun ? " (DRY RUN)" : " (EXECUTING)"}...`);
  
  // Import the MCP server handler logic
  // We'll need to extract the logic or call it directly
  // For now, let's use the Linear API directly like the MCP tool does
  
  if (!process.env.PM_TOOL_API_KEY) {
    console.error("Error: PM_TOOL_API_KEY is required");
    process.exit(1);
  }
  
  const teamId = process.env.PM_TOOL_TEAM_ID;
  if (!teamId) {
    console.error("Error: PM_TOOL_TEAM_ID is required");
    process.exit(1);
  }
  
  // Fetch all issues
  const allIssues: Array<{
    id: string;
    identifier: string;
    url: string;
    title: string;
    description?: string;
    state: string;
  }> = [];
  
  let hasNextPage = true;
  let cursor: string | null = null;
  const pageSize = 100;
  
  console.log(`Fetching all Linear issues for team ${teamId}...`);
  
  while (hasNextPage) {
    const query = `
      query GetTeamIssues($teamId: String!, $first: Int!, $after: String) {
        team(id: $teamId) {
          issues(first: $first, after: $after, includeArchived: true) {
            nodes {
              id
              identifier
              url
              title
              description
              state {
                name
              }
            }
            pageInfo {
              hasNextPage
              endCursor
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
        variables: { teamId, first: pageSize, after: cursor },
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
              description?: string | null;
              state?: { name: string };
            }>;
            pageInfo?: { hasNextPage: boolean; endCursor: string | null };
          };
        };
      };
      errors?: Array<{ message: string }>;
    };
    
    if (result.errors) {
      throw new Error(`GraphQL errors: ${result.errors.map(e => e.message).join(", ")}`);
    }
    
    const nodes = result.data?.team?.issues?.nodes || [];
    allIssues.push(...nodes.map(i => ({
      id: i.id,
      identifier: i.identifier,
      url: i.url,
      title: i.title,
      description: i.description || undefined,
      state: i.state?.name || "Unknown",
    })));
    
    hasNextPage = result.data?.team?.issues?.pageInfo?.hasNextPage || false;
    cursor = result.data?.team?.issues?.pageInfo?.endCursor || null;
    
    if (hasNextPage) {
      console.log(`Fetched ${allIssues.length} issues so far...`);
    }
  }
  
  console.log(`Found ${allIssues.length} total issues`);
  
  // Normalize title for comparison
  // Strips " - Last comment: ..." part before comparing, so "Title" and "Title - Last comment: X days ago" match
  const normalizeTitle = (title: string): string => {
    if (!title) return "";
    // Remove " - Last comment: ..." pattern (with variations)
    let normalized = title
      .replace(/\s*-\s*Last comment:\s*[^"]*$/i, "") // Remove " - Last comment: X days ago"
      .replace(/\s*-\s*Last comment\s*$/i, ""); // Handle incomplete patterns
    return normalized
      .toLowerCase()
      .trim()
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/\s+/g, " ")
      .replace(/[.,!?;:'"`\-_()\[\]{}]/g, "")
      .replace(/\s+/g, " ")
      .trim();
  };
  
  // Check if title has "Last comment" info
  const hasLastComment = (title: string): boolean => {
    return /-\s*Last comment:/i.test(title);
  };
  
  // Group by normalized title
  const titleGroups = new Map<string, Array<typeof allIssues[0]>>();
  for (const issue of allIssues) {
    const normalized = normalizeTitle(issue.title);
    if (!titleGroups.has(normalized)) {
      titleGroups.set(normalized, []);
    }
    titleGroups.get(normalized)!.push(issue);
  }
  
  // Find duplicates
  const duplicates: Array<{
    title: string;
    keep: { id: string; identifier: string };
    remove: Array<{ id: string; identifier: string; url: string }>;
  }> = [];
  
  for (const [normalizedTitle, issues] of titleGroups.entries()) {
    if (issues.length > 1) {
      // Sort: prefer issues with "Last comment" info, then open issues, then more description, then older
      const sorted = [...issues].sort((a, b) => {
        // First priority: prefer issues WITH "Last comment" info
        const aHasComment = hasLastComment(a.title);
        const bHasComment = hasLastComment(b.title);
        if (aHasComment !== bHasComment) return bHasComment ? 1 : -1; // bHasComment first (true = 1, false = -1)
        
        // Second priority: prefer open issues
        const aOpen = a.state.toLowerCase() !== "done" && a.state.toLowerCase() !== "canceled";
        const bOpen = b.state.toLowerCase() !== "done" && b.state.toLowerCase() !== "canceled";
        if (aOpen !== bOpen) return aOpen ? -1 : 1;
        
        // Third priority: prefer more description
        const aDescLen = a.description?.length || 0;
        const bDescLen = b.description?.length || 0;
        if (aDescLen !== bDescLen) return bDescLen - aDescLen;
        
        // Fourth priority: prefer older (lower identifier)
        return a.identifier.localeCompare(b.identifier);
      });
      
      duplicates.push({
        title: sorted[0].title,
        keep: { id: sorted[0].id, identifier: sorted[0].identifier },
        remove: sorted.slice(1).map(i => ({ id: i.id, identifier: i.identifier, url: i.url })),
      });
    }
  }
  
  const totalToRemove = duplicates.reduce((sum, d) => sum + d.remove.length, 0);
  console.log(`\nFound ${duplicates.length} sets of duplicates (${totalToRemove} issues to remove)`);
  
  if (dryRun) {
    console.log("\n[DRY RUN] Would remove the following duplicates:");
    duplicates.forEach((dup, i) => {
      console.log(`\n${i + 1}. "${dup.title}"`);
      console.log(`   Keep: ${dup.keep.identifier}`);
      console.log(`   Remove: ${dup.remove.map(r => r.identifier).join(", ")}`);
    });
    console.log(`\nRun with --execute to actually remove duplicates`);
  } else {
    console.log(`\n[EXECUTING] Removing ${totalToRemove} duplicate issues...`);
    console.log(`This may take a while (processing ${totalToRemove} issues, 2 API calls each)...\n`);
    
    // Helper function to make API calls with rate limit handling
    async function makeLinearRequest(query: string, variables: Record<string, any>, retries = 3): Promise<{ success: boolean; errors?: Array<{ message: string }>; retryAfter?: number }> {
      for (let attempt = 0; attempt < retries; attempt++) {
        const response = await fetch("https://api.linear.app/graphql", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Authorization": process.env.PM_TOOL_API_KEY!,
          },
          body: JSON.stringify({ query, variables }),
        });
        
        const result = await response.json() as {
          data?: any;
          errors?: Array<{ message: string; extensions?: { code?: string } }>;
        };
        
        // Check for rate limiting (429 or rate limit errors)
        const isRateLimited = response.status === 429 || 
          result.errors?.some(e => 
            e.message?.toLowerCase().includes("rate limit") || 
            e.message?.toLowerCase().includes("too many requests") ||
            e.extensions?.code === "RATE_LIMIT_EXCEEDED"
          );
        
        if (isRateLimited) {
          // Check for Retry-After header
          const retryAfterHeader = response.headers.get("Retry-After");
          const retryAfterSeconds = retryAfterHeader ? parseInt(retryAfterHeader, 10) : Math.min(60 * (attempt + 1), 300); // Max 5 minutes
          
          if (attempt < retries - 1) {
            console.log(`[RATE LIMIT] Hit rate limit, waiting ${retryAfterSeconds}s before retry ${attempt + 1}/${retries}...`);
            await new Promise(resolve => setTimeout(resolve, retryAfterSeconds * 1000));
            continue;
          } else {
            return { success: false, errors: result.errors, retryAfter: retryAfterSeconds };
          }
        }
        
        // Check for other errors
        if (result.errors) {
          return { success: false, errors: result.errors };
        }
        
        // Success
        return { success: true };
      }
      
      return { success: false, errors: [{ message: "Max retries exceeded" }] };
    }
    
    let deleted = 0;
    let errors = 0;
    let processed = 0;
    const totalIssues = totalToRemove;
    const DELAY_BETWEEN_REQUESTS = 300; // 300ms = ~3.3 requests/second (200 requests/minute)
    
    for (const dup of duplicates) {
      for (const issueToRemove of dup.remove) {
        processed++;
        try {
          // First archive (soft delete)
          const archiveQuery = `
            mutation ArchiveIssue($id: String!) {
              issueArchive(id: $id) {
                success
              }
            }
          `;
          
          const archiveResult = await makeLinearRequest(archiveQuery, { id: issueToRemove.id });
          
          if (!archiveResult.success) {
            const errorMsg = archiveResult.errors?.map(e => e.message).join(", ") || "Unknown error";
            if (archiveResult.retryAfter) {
              console.error(`[RATE LIMIT] [${processed}/${totalIssues}] Rate limited while archiving ${issueToRemove.identifier}. Please wait ${archiveResult.retryAfter}s and retry.`);
              errors++;
              // Skip this issue for now, but continue with others
              continue;
            } else {
              errors++;
              console.error(`[ERROR] [${processed}/${totalIssues}] Failed to archive ${issueToRemove.identifier}: ${errorMsg}`);
              continue;
            }
          }
          
          // Delay before delete request
          await new Promise(resolve => setTimeout(resolve, DELAY_BETWEEN_REQUESTS));
          
          // Now permanently delete
          const deleteQuery = `
            mutation DeleteIssue($id: String!) {
              issueDelete(id: $id) {
                success
              }
            }
          `;
          
          const deleteResult = await makeLinearRequest(deleteQuery, { id: issueToRemove.id });
          
          if (deleteResult.success) {
            deleted++;
            // Show progress every 10 deletions, or always for small batches
            if (deleted % 10 === 0 || totalIssues <= 50) {
              console.log(`[PROGRESS] [${processed}/${totalIssues}] Deleted ${deleted} issues so far... (${issueToRemove.identifier})`);
            }
          } else {
            const errorMsg = deleteResult.errors?.map(e => e.message).join(", ") || "Unknown error";
            if (deleteResult.retryAfter) {
              console.error(`[RATE LIMIT] [${processed}/${totalIssues}] Rate limited while deleting ${issueToRemove.identifier}. Please wait ${deleteResult.retryAfter}s and retry.`);
              errors++;
              // Issue is archived but not deleted - will need manual cleanup
              continue;
            } else {
              errors++;
              console.error(`[ERROR] [${processed}/${totalIssues}] Failed to permanently delete ${issueToRemove.identifier}: ${errorMsg}`);
            }
          }
          
          // Delay between issues to respect rate limits
          if (processed < totalIssues) {
            await new Promise(resolve => setTimeout(resolve, DELAY_BETWEEN_REQUESTS));
          }
        } catch (error) {
          errors++;
          console.error(`[ERROR] [${processed}/${totalIssues}] Error processing ${issueToRemove.identifier}:`, error);
        }
      }
    }
    
    console.log(`\n[COMPLETE] Permanently deleted ${deleted} duplicate issues, ${errors} errors`);
    if (errors > 0) {
      console.log(`\nNote: Some issues may have been archived but not deleted due to rate limits.`);
      console.log(`You can run the script again to retry failed deletions.`);
    }
  }
  
  process.exit(0);
}

main().catch(console.error);

