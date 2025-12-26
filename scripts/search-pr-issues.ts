#!/usr/bin/env node
/**
 * Search for specific PR/issue numbers mentioned in Discord
 */
import "dotenv/config";
import { searchGitHubIssues } from "../src/github-integration.js";
import { getConfig } from "../src/config.js";

const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
// Note: GITHUB_TOKEN is optional but recommended for higher rate limits
const config = getConfig();

async function searchSpecificPRs() {
  console.log("Searching for specific issues/PRs mentioned in Discord...\n");
  
  // PR numbers mentioned in Discord message #8 and #9
  const prNumbers = [6114, 6954];
  
  for (const prNum of prNumbers) {
    try {
      console.log(`\nSearching for PR/Issue #${prNum}`);
      // Search by number in title/body
      const results = await searchGitHubIssues(`#${prNum}`, GITHUB_TOKEN, config.github.owner, config.github.repo);
      
      if (results.total_count === 0) {
        // Try searching in body/title
        const altResults = await searchGitHubIssues(`${prNum}`, GITHUB_TOKEN, config.github.owner, config.github.repo);
        if (altResults.total_count > 0) {
          console.log(`   Found ${altResults.total_count} result(s):\n`);
          altResults.items.forEach((issue) => {
            console.log(`   #${issue.number}: ${issue.title}`);
            console.log(`   State: ${issue.state}`);
            console.log(`   URL: ${issue.html_url}`);
            if (issue.body) {
              const bodyPreview = issue.body.substring(0, 200);
              console.log(`   Preview: ${bodyPreview}...`);
            }
            console.log("");
          });
        } else {
          console.log("   Error: Not found");
        }
      } else {
        results.items.forEach((issue) => {
          console.log(`   Found: #${issue.number}: ${issue.title}`);
          console.log(`   State: ${issue.state}`);
          console.log(`   URL: ${issue.html_url}\n`);
        });
      }
      
      await new Promise((resolve) => setTimeout(resolve, 300));
    } catch (error) {
      console.error(`   Error: Error: ${error instanceof Error ? error.message : error}`);
    }
  }
}

searchSpecificPRs().catch(console.error);

