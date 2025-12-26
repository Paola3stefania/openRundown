/**
 * Configuration for UNMute MCP Server
 * 
 * Set these via environment variables or update the defaults below.
 */
import type { GitHubConfig } from "./github.js";
import type { DiscordConfig } from "./discord.js";
import type { PathsConfig } from "./paths.js";
import type { ClassificationConfig } from "./classification.js";
import type { PMIntegrationConfig } from "./pm-integration.js";
import type { StorageConfig } from "./storage.js";
import { getGitHubConfig } from "./github.js";
import { getDiscordConfig } from "./discord.js";
import { getPathsConfig } from "./paths.js";
import { getClassificationConfig } from "./classification.js";
import { getPMIntegrationConfig } from "./pm-integration.js";
import { getStorageConfig } from "./storage.js";

export interface Config {
  github: GitHubConfig;
  discord: DiscordConfig;
  paths: PathsConfig;
  classification: ClassificationConfig;
  storage: StorageConfig;
  pmIntegration?: PMIntegrationConfig;
}

/**
 * Get configuration from environment variables or use defaults
 */
export function getConfig(): Config {
  return {
    github: getGitHubConfig(),
    discord: getDiscordConfig(),
    paths: getPathsConfig(),
    classification: getClassificationConfig(),
    storage: getStorageConfig(),
    pmIntegration: getPMIntegrationConfig(),
  };
}

/**
 * Get the default config (useful for scripts that need it without env vars)
 */
export const defaultConfig = getConfig();

// Re-export domain-specific configs for convenience
export type { GitHubConfig } from "./github.js";
export type { DiscordConfig } from "./discord.js";
export type { PathsConfig } from "./paths.js";
export type { ClassificationConfig } from "./classification.js";
export type { PMIntegrationConfig, PMToolConfig } from "./pm-integration.js";
