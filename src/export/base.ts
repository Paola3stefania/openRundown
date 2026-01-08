/**
 * Base interface for PM tool integrations
 * All PM tool integrations should implement this interface
 */

import { PMToolIssue, PMToolConfig, ExportResult } from "./types.js";
import { log, logError } from "../mcp/logger.js";

/**
 * Linear-specific interface for methods not in base IPMTool
 */
export interface LinearPMTool {
  teamId?: string;
  validateTeam?(createIfMissing: boolean, defaultTeamName: string): Promise<boolean>;
  createOrGetProject?(featureId: string, featureName: string, featureDescription?: string): Promise<string>;
  initializeLabels?(): Promise<void>;
  updateIssue?(issueId: string, updates: Partial<PMToolIssue>): Promise<void>;
  getIssue?(issueId: string): Promise<{ id: string; identifier: string; url: string; title: string; description?: string; state: string; stateId?: string; assigneeId?: string; projectId?: string; projectName?: string; priority?: number; labelNames?: string[]; teamId?: string; teamName?: string } | null>;
  updateProjectTeam?(projectId: string): Promise<boolean>;
}

export interface IPMTool {
  /**
   * Create an issue in the PM tool
   */
  createIssue(issue: PMToolIssue): Promise<{ id: string; identifier?: string; url: string }>;

  /**
   * Update an existing issue
   */
  updateIssue(issueId: string, updates: Partial<PMToolIssue>): Promise<void>;

  /**
   * Check if an issue already exists (by source ID)
   * Note: Most PM tools don't support this natively - use stored mapping instead
   */
  findIssueBySourceId(sourceId: string): Promise<{ id: string; url: string } | null>;

  /**
   * Get issue details by ID (for reading status/updates)
   */
  getIssue?(issueId: string): Promise<{ id: string; identifier?: string; url: string; title: string; state: string } | null>;

  /**
   * Export multiple issues
   */
  exportIssues(issues: PMToolIssue[]): Promise<ExportResult>;
}

/**
 * Abstract base class for PM tool implementations
 */
export abstract class BasePMTool implements IPMTool {
  protected config: PMToolConfig;

  constructor(config: PMToolConfig) {
    this.config = config;
  }

  abstract createIssue(issue: PMToolIssue): Promise<{ id: string; identifier?: string; url: string }>;
  abstract updateIssue(issueId: string, updates: Partial<PMToolIssue>): Promise<void>;
  abstract findIssueBySourceId(sourceId: string): Promise<{ id: string; url: string } | null>;

  /**
   * Default implementation for exporting multiple issues
   * Can be overridden by specific implementations
   */
  async exportIssues(issues: PMToolIssue[]): Promise<ExportResult> {
    const result: ExportResult = {
      success: true,
      created_issues: 0,
      updated_issues: 0,
      skipped_issues: 0,
      errors: [],
      issue_urls: [],
    };

    for (const issue of issues) {
      try {
        // Check if issue already has a stored ID (from previous export)
        // Prioritize stored ID to avoid duplicates when titles change
        let existing: { id: string; url: string } | null = null;
        
        if (issue.linear_issue_id) {
          // First try to verify the stored ID exists in Linear
          if ('getIssue' in this && typeof this.getIssue === "function") {
            try {
              const verifiedIssue = await this.getIssue(issue.linear_issue_id);
              if (verifiedIssue) {
                existing = {
                  id: verifiedIssue.id,
                  url: verifiedIssue.url,
                };
              }
            } catch (verifyError) {
              // Verification failed (issue might be archived/deleted)
              // Still try to use the stored ID - update might work even if getIssue fails
              // This prevents creating duplicates when titles change (e.g., "X days ago - Title")
              log(`Warning: Could not verify stored Linear issue ID ${issue.linear_issue_id}, but will try to update it anyway`);
            }
          }
          
          // If verification succeeded or we have a stored ID, use it directly
          // This ensures we update existing issues even when titles change
          if (!existing && issue.linear_issue_id) {
            // Try to use stored ID even if verification failed
            // The update might still work (e.g., for archived issues)
            existing = {
              id: issue.linear_issue_id,
              url: issue.linear_issue_url || `https://linear.app/issue/${issue.linear_issue_identifier || issue.linear_issue_id}`,
            };
          }
        }
        
        // If no stored ID available, try finding by source ID as fallback
        // Only search if source_id is provided (duplicate detection)
        // DO NOT use title as fallback - titles change (e.g., "X days ago - Title" format) and would create duplicates
        if (!existing && issue.source_id) {
          existing = await this.findIssueBySourceId(issue.source_id);
        }
        
        if (existing) {
          // Update existing issue
          try {
            await this.updateIssue(existing.id, issue);
            result.updated_issues++;
            if (existing.url) {
              result.issue_urls?.push(existing.url);
            }
            // Ensure the issue object has the ID stored
            issue.linear_issue_id = existing.id;
          } catch (updateError) {
            // Update failed - issue might have been deleted
            // Fall back to creating a new issue
            log(`Warning: Failed to update existing Linear issue ${existing.id}, creating new issue instead: ${updateError instanceof Error ? updateError.message : String(updateError)}`);
            existing = null; // Reset to trigger creation
          }
        }
        
        if (!existing) {
          // Create new issue
          const created = await this.createIssue(issue);
          result.created_issues++;
          result.issue_urls?.push(created.url);
          
          // Store Linear issue ID, identifier, and URL in the issue for mapping
          issue.linear_issue_id = created.id;
          if (created.identifier) {
            issue.linear_issue_identifier = created.identifier;
          }
          if (created.url) {
            issue.linear_issue_url = created.url;
          }
        }
      } catch (error) {
        result.errors?.push({
          source_id: issue.source_id,
          error: error instanceof Error ? error.message : String(error),
        });
        result.skipped_issues++;
      }
    }

    return result;
  }
}

