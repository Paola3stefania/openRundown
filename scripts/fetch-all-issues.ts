#!/usr/bin/env node
/**
 * Fetch all GitHub issues (open and closed) and save them to a JSON file
 * Supports incremental updates - only fetches issues updated since last fetch
 * Run with: npm run fetch-issues [output_file] [--incremental]
 */
import "dotenv/config";
import { writeFile, mkdir, access } from "fs/promises";
import { join } from "path";
import { 
  fetchAllGitHubIssues, 
  loadIssuesFromCache,
  getMostRecentUpdateDate,
  mergeIssues,
  type GitHubIssue,
  type IssuesCache 
} from "../src/github-integration.js";
import { getConfig } from "../src/config.js";

const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
// Note: GITHUB_TOKEN is optional but recommended for higher rate limits
const config = getConfig();
const DEFAULT_OUTPUT_FILE = join(config.paths.cacheDir, config.paths.issuesCacheFile);

// Parse arguments
const args = process.argv.slice(2);
const forceIncremental = args.includes("--incremental") || args.includes("-i");
const forceFull = args.includes("--full") || args.includes("-f");
const outputFile = args.find(arg => !arg.startsWith("--") && !arg.startsWith("-")) || DEFAULT_OUTPUT_FILE;

async function main() {
  try {
    if (!config.github.owner || !config.github.repo) {
      console.error("Error: GITHUB_OWNER and GITHUB_REPO must be set in environment variables");
      process.exit(1);
    }

    // Always check if cache exists first
    let existingCache: IssuesCache | null = null;
    let sinceDate: string | undefined = undefined;
    let actuallyIncremental = false;

    try {
      const cachePath = outputFile.startsWith("/")
        ? outputFile
        : join(process.cwd(), outputFile);
      
      await access(cachePath);
      existingCache = await loadIssuesFromCache(cachePath);
      
      // If cache exists and not forcing full fetch, use incremental mode by default
      if (existingCache && !forceFull) {
        actuallyIncremental = true;
        sinceDate = getMostRecentUpdateDate(existingCache);
        
        if (sinceDate) {
          console.log(`Cache found: ${existingCache.total_count} issues. Incremental update: Fetching issues created or updated since ${sinceDate}\n`);
          console.log(`Existing cache: ${existingCache.total_count} issues (${existingCache.open_count} open, ${existingCache.closed_count} closed)\n`);
        } else {
          console.log("Cache exists but is empty, fetching all issues...\n");
          actuallyIncremental = false;
        }
      } else if (existingCache && forceFull) {
        console.log(`Cache exists (${existingCache.total_count} issues) but --full flag set, fetching all issues...\n`);
        actuallyIncremental = false;
      }
    } catch (error) {
      console.log("No existing cache found, fetching all issues...\n");
      actuallyIncremental = false;
    }

    // Override with explicit --incremental flag if set
    if (forceIncremental) {
      actuallyIncremental = true;
      if (existingCache && !sinceDate) {
        sinceDate = getMostRecentUpdateDate(existingCache);
      }
    }

    if (!actuallyIncremental) {
      console.log(`Fetching all GitHub issues from ${config.github.owner}/${config.github.repo}...\n`);
    }
    
    const newIssues = await fetchAllGitHubIssues(GITHUB_TOKEN, true, undefined, undefined, sinceDate);

    // Merge with existing cache if doing incremental update
    let finalIssues: GitHubIssue[];
    if (existingCache && newIssues.length > 0) {
      console.log(`\nMerging ${newIssues.length} new/updated issues with ${existingCache.issues.length} existing issues...`);
      finalIssues = mergeIssues(existingCache.issues, newIssues);
      console.log(`Total after merge: ${finalIssues.length} issues\n`);
    } else if (existingCache && newIssues.length === 0) {
      console.log("\nNo new or updated issues found. Using existing cache.\n");
      finalIssues = existingCache.issues;
    } else {
      finalIssues = newIssues;
    }

    const cacheData = {
      fetched_at: new Date().toISOString(),
      total_count: finalIssues.length,
      open_count: finalIssues.filter((i) => i.state === "open").length,
      closed_count: finalIssues.filter((i) => i.state === "closed").length,
      issues: finalIssues,
    };

    // Ensure cache directory exists
    const cacheDir = join(process.cwd(), config.paths.cacheDir);
    try {
      await mkdir(cacheDir, { recursive: true });
    } catch (error) {
      // Directory might already exist, that's fine
    }

    // Determine output path
    const filePath = outputFile.startsWith("/")
      ? outputFile
      : join(process.cwd(), outputFile);

    await writeFile(filePath, JSON.stringify(cacheData, null, 2), "utf-8");

    console.log("Successfully saved issues to:", filePath);
    console.log(`   Total: ${cacheData.total_count}`);
    console.log(`   Open: ${cacheData.open_count}`);
    console.log(`   Closed: ${cacheData.closed_count}`);
    if (actuallyIncremental && newIssues.length > 0) {
      console.log(`   New/Updated: ${newIssues.length}\n`);
    } else {
      console.log("");
    }
  } catch (error) {
    console.error("Error: Error:", error instanceof Error ? error.message : error);
    if (error instanceof Error && error.stack) {
      console.error(error.stack);
    }
    process.exit(1);
  }
}

main();

