/**
 * Base interface for PM tool integrations
 * All PM tool integrations should implement this interface
 */

import { PMToolIssue, PMToolConfig, ExportResult } from "./types.js";

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
        // Check if issue already exists
        const existing = await this.findIssueBySourceId(issue.source_id);
        
        if (existing) {
          // Update existing issue
          await this.updateIssue(existing.id, issue);
          result.updated_issues++;
          if (existing.url) {
            result.issue_urls?.push(existing.url);
          }
        } else {
          // Create new issue
          const created = await this.createIssue(issue);
          result.created_issues++;
          result.issue_urls?.push(created.url);
          
          // Store Linear issue ID in the issue metadata for mapping
          if (created.identifier) {
            issue.linear_issue_id = created.id;
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

