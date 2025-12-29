/**
 * Base interface for PM tool integrations
 * All PM tool integrations should implement this interface
 */

import { PMToolIssue, PMToolConfig, ExportResult } from "./types.js";

/**
 * Linear-specific interface for methods not in base IPMTool
 */
export interface LinearPMTool {
  teamId?: string;
  validateTeam?(createIfMissing: boolean, defaultTeamName: string): Promise<boolean>;
  createOrGetProject?(featureId: string, featureName: string, featureDescription?: string): Promise<string>;
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
        // If it does, verify it exists before using it
        let existing: { id: string; url: string } | null = null;
        
        if (issue.linear_issue_id) {
          // Verify the stored ID exists in Linear
          if ('getIssue' in this && typeof this.getIssue === "function") {
            const verifiedIssue = await this.getIssue(issue.linear_issue_id);
            if (verifiedIssue) {
              existing = {
                id: verifiedIssue.id,
                url: verifiedIssue.url,
              };
            }
          }
        }
        
        // If no stored ID or verification failed, try finding by source ID
        // Only search if source_id is provided (duplicate detection)
        if (!existing && issue.source_id) {
          // Check if findIssueBySourceId accepts optional title parameter (Linear implementation)
          // Use bind to preserve 'this' context
          const findMethod = this.findIssueBySourceId.bind(this);
          // Check if the method signature accepts a second parameter (title)
          // We can't check function.length reliably due to TypeScript, so try with title first
          try {
            // Try calling with title parameter (Linear implementation)
            existing = await (findMethod as any)(issue.source_id, issue.title);
          } catch (error) {
            // If that fails or method doesn't accept title, try without
            existing = await this.findIssueBySourceId(issue.source_id);
          }
        }
        
        if (existing) {
          // Update existing issue
          await this.updateIssue(existing.id, issue);
          result.updated_issues++;
          if (existing.url) {
            result.issue_urls?.push(existing.url);
          }
          // Ensure the issue object has the ID stored
          issue.linear_issue_id = existing.id;
        } else {
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

