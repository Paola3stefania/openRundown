#!/usr/bin/env tsx
/**
 * One-time migration script to update ALL existing Linear issues with last comment info in titles
 * Adds "Last comment: X days ago" to all Linear issue titles based on GitHub issue comments
 */

import "dotenv/config";
import { exportIssuesToPMTool } from "../src/export/groupingExporter.js";
import { getConfig } from "../src/config/index.js";

async function main() {
  const dryRun = process.argv.includes("--dry-run");
  
  console.log(`Running title update migration${dryRun ? " (DRY RUN)" : ""}...`);
  
  const config = getConfig();
  
  if (!config.pmIntegration?.enabled) {
    console.error("Error: PM integration is not enabled. Set PM_TOOL_TYPE, PM_TOOL_API_KEY, and PM_TOOL_TEAM_ID in environment variables.");
    process.exit(1);
  }
  
  if (!config.pmIntegration.pm_tool) {
    console.error("Error: PM tool configuration not found.");
    process.exit(1);
  }
  
  const pmToolConfig = {
    type: config.pmIntegration.pm_tool.type,
    api_key: config.pmIntegration.pm_tool.api_key!,
    api_url: config.pmIntegration.pm_tool.api_url,
    team_id: config.pmIntegration.pm_tool.team_id,
  };
  
  const channelId = config.discord.defaultChannelId;
  if (!channelId) {
    console.error("Error: channel_id is required. Set DISCORD_DEFAULT_CHANNEL_ID in environment variables.");
    process.exit(1);
  }
  
  try {
    const result = await exportIssuesToPMTool(pmToolConfig, {
      include_closed: true, // Include closed issues too
      channelId: channelId,
      dry_run: dryRun,
      update_all_titles: true, // One-time migration flag
    });
    
    if (result.success) {
      console.log(`\n[SUCCESS] Title update migration complete!`);
      console.log(`Updated ${result.issues_exported?.updated || 0} Linear issues with last comment info in titles`);
      console.log(`Skipped ${result.issues_exported?.skipped || 0} issues (already up to date or no comments)`);
      
      if (result.errors && result.errors.length > 0) {
        console.log(`\nErrors encountered: ${result.errors.length}`);
        result.errors.forEach((error, i) => {
          console.log(`  ${i + 1}. ${error}`);
        });
      }
    } else {
      console.error("\n[ERROR] Title update migration failed!");
      if (result.errors) {
        result.errors.forEach((error, i) => {
          console.error(`  ${i + 1}. ${error}`);
        });
      }
      process.exit(1);
    }
  } catch (error) {
    console.error("\n[ERROR] Failed to run title update migration:", error);
    process.exit(1);
  }
}

main().catch(console.error);

