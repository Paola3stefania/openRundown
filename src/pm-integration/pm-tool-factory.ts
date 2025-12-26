/**
 * Factory for creating PM tool integrations
 */

import { PMToolConfig } from "./types.js";
import { IPMTool } from "./base-pm-tool.js";
import { LinearIntegration } from "./linear-integration.js";
import { JiraIntegration } from "./jira-integration.js";
import { logError } from "../logger.js";

/**
 * Create a PM tool integration instance based on configuration
 */
export function createPMTool(config: PMToolConfig): IPMTool {
  if (!config.type) {
    throw new Error("PM tool type is required");
  }

  switch (config.type) {
    case "linear":
      return new LinearIntegration(config);
    
    case "jira":
      return new JiraIntegration(config);
    
    case "github":
      // GitHub integration could reuse existing GitHub API
      throw new Error("GitHub integration not yet implemented");
    
    case "custom":
      throw new Error("Custom PM tool integration not yet implemented");
    
    default:
      throw new Error(`Unknown PM tool type: ${config.type}`);
  }
}

/**
 * Validate PM tool configuration
 */
export function validatePMToolConfig(config: PMToolConfig): { valid: boolean; error?: string } {
  if (!config.type) {
    return { valid: false, error: "PM tool type is required" };
  }

  switch (config.type) {
    case "linear":
      if (!config.api_key) {
        return { valid: false, error: "Linear API key is required" };
      }
      break;
    
    case "jira":
      if (!config.api_key || !config.api_url) {
        return { valid: false, error: "Jira API key and URL are required" };
      }
      if (!config.api_url.includes("atlassian.net")) {
        return { valid: false, error: "Jira API URL must be in format: https://{domain}.atlassian.net" };
      }
      break;
  }

  return { valid: true };
}

