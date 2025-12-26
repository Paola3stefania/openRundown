#!/usr/bin/env tsx
/**
 * Validation script for Linear export setup
 * Checks if all required environment variables and dependencies are configured
 */

import "dotenv/config";
import { existsSync } from "fs";
import { join } from "path";
import { getConfig } from "../src/config.js";

interface ValidationResult {
  valid: boolean;
  errors: string[];
  warnings: string[];
  info: string[];
}

function validateSetup(): ValidationResult {
  const result: ValidationResult = {
    valid: true,
    errors: [],
    warnings: [],
    info: [],
  };

  console.log("🔍 Validating Linear Export Setup...\n");

  // Check PM Integration enabled
  if (process.env.PM_INTEGRATION_ENABLED !== "true") {
    result.warnings.push("PM_INTEGRATION_ENABLED is not set to 'true'");
  } else {
    result.info.push("✓ PM integration is enabled");
  }

  // Check PM Tool Type
  if (process.env.PM_TOOL_TYPE !== "linear") {
    result.errors.push("PM_TOOL_TYPE must be 'linear' for Linear export");
    result.valid = false;
  } else {
    result.info.push("✓ PM tool type is set to Linear");
  }

  // Check Linear API Key
  if (!process.env.PM_TOOL_API_KEY) {
    result.errors.push("PM_TOOL_API_KEY is required. Get it from https://linear.app/settings/api");
    result.valid = false;
  } else {
    result.info.push("✓ Linear API key is configured");
  }

  // Check Team ID (optional)
  if (!process.env.PM_TOOL_TEAM_ID) {
    result.info.push("ℹ PM_TOOL_TEAM_ID not set - UNMute team will be auto-created");
  } else {
    result.info.push("✓ Team ID is configured");
  }

  // Check Documentation URLs
  if (!process.env.DOCUMENTATION_URLS) {
    result.errors.push("DOCUMENTATION_URLS is required. Set URLs or file paths to documentation");
    result.valid = false;
  } else {
    const urls = process.env.DOCUMENTATION_URLS.split(",").map((u) => u.trim()).filter(Boolean);
    result.info.push(`✓ Documentation URLs configured (${urls.length} URL(s))`);
    
    // Check if local files exist
    urls.forEach((url) => {
      if (!url.startsWith("http") && !existsSync(url) && !existsSync(join(process.cwd(), url))) {
        result.warnings.push(`Documentation URL might not exist: ${url}`);
      }
    });
  }

  // Check OpenAI API Key (for semantic classification)
  if (!process.env.OPENAI_API_KEY) {
    result.warnings.push("OPENAI_API_KEY not set - semantic classification will not work");
  } else {
    result.info.push("✓ OpenAI API key configured (for semantic classification)");
  }

  // Check Discord/Classification prerequisites
  if (!process.env.DISCORD_TOKEN) {
    result.warnings.push("DISCORD_TOKEN not set - classification will not work");
  } else {
    result.info.push("✓ Discord token configured");
  }

  if (!process.env.GITHUB_TOKEN) {
    result.warnings.push("GITHUB_TOKEN not set - GitHub integration may have rate limits");
  } else {
    result.info.push("✓ GitHub token configured");
  }

  // Check if classified data exists
  const config = getConfig();
  const resultsDir = join(process.cwd(), config.paths.resultsDir || "results");
  const defaultChannelId = config.discord.defaultChannelId;

  if (defaultChannelId) {
    const classifiedFile = join(resultsDir, `discord-classified-${defaultChannelId}.json`);
    if (existsSync(classifiedFile)) {
      result.info.push(`✓ Classified data found: ${classifiedFile}`);
    } else {
      result.warnings.push(
        `Classified data not found. Run classification first: ${classifiedFile}`
      );
    }
  } else {
    result.warnings.push("DISCORD_DEFAULT_CHANNEL_ID not set - you'll need to provide classified_data_path when exporting");
  }

  return result;
}

// Run validation
const result = validateSetup();

console.log("\n📋 Validation Results:\n");

// Print info messages
if (result.info.length > 0) {
  console.log("✅ Info:");
  result.info.forEach((msg) => console.log(`   ${msg}`));
  console.log();
}

// Print warnings
if (result.warnings.length > 0) {
  console.log("⚠️  Warnings:");
  result.warnings.forEach((msg) => console.log(`   ${msg}`));
  console.log();
}

// Print errors
if (result.errors.length > 0) {
  console.log("❌ Errors:");
  result.errors.forEach((msg) => console.log(`   ${msg}`));
  console.log();
}

// Summary
if (result.valid) {
  console.log("✨ Setup looks good! You can proceed with testing.\n");
  console.log("Next steps:");
  console.log("1. Run classification if needed: classify_discord_messages MCP tool");
  console.log("2. Export to Linear: export_to_pm_tool MCP tool");
  process.exit(0);
} else {
  console.log("❌ Setup has errors. Please fix them before testing.\n");
  process.exit(1);
}

