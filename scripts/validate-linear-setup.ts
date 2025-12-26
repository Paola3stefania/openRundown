#!/usr/bin/env tsx
/**
 * Validation script for Linear export setup (convenience wrapper)
 * Uses the same validation logic as the validate_pm_setup MCP tool
 */

import "dotenv/config";
import { validatePMSetup } from "../src/pm-validation.js";

// Run validation
const result = validatePMSetup();

console.log("\nValidation Results:\n");

// Print info messages
if (result.info.length > 0) {
  console.log("Info:");
  result.info.forEach((msg) => console.log(`   ${msg}`));
  console.log();
}

// Print warnings
if (result.warnings.length > 0) {
  console.log("Warnings:");
  result.warnings.forEach((msg) => console.log(`   ${msg}`));
  console.log();
}

// Print errors
if (result.errors.length > 0) {
  console.log("Errors:");
  result.errors.forEach((msg) => console.log(`   ${msg}`));
  console.log();
}

// Summary
if (result.valid) {
  console.log("Setup looks good! You can proceed with testing.\n");
  console.log("Next steps:");
  console.log("1. Run classification if needed: classify_discord_messages MCP tool");
  console.log("2. Export to Linear: export_to_pm_tool MCP tool");
  process.exit(0);
} else {
  console.log("Setup has errors. Please fix them before testing.\n");
  process.exit(1);
}

