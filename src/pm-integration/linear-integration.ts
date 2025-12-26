/**
 * Linear integration
 * Exports issues to Linear project management tool
 */

import { BasePMTool } from "./base-pm-tool.js";
import { PMToolIssue, PMToolConfig, ExportResult } from "./types.js";
import { log, logError } from "../logger.js";

export class LinearIntegration extends BasePMTool {
  private apiUrl: string;
  private apiKey: string;
  private teamId?: string;

  constructor(config: PMToolConfig) {
    super(config);
    
    if (!config.api_key) {
      throw new Error("Linear API key is required");
    }

    this.apiKey = config.api_key;
    this.teamId = config.team_id;
    this.apiUrl = config.api_url || "https://api.linear.app/graphql";
  }

  async createIssue(issue: PMToolIssue): Promise<{ id: string; identifier?: string; url: string }> {
    const query = `
      mutation CreateIssue($input: IssueCreateInput!) {
        issueCreate(input: $input) {
          success
          issue {
            id
            identifier
            url
            title
          }
        }
      }
    `;

    const variables = {
      input: {
        teamId: this.teamId || undefined,
        title: issue.title,
        description: this.formatDescription(issue),
        labelIds: this.mapLabels(issue.labels || []),
        priority: this.mapPriority(issue.priority),
        ...(issue.project_id && {
          projectId: issue.project_id, // Link to Linear project (feature)
        }),
      },
    };

    const response = await this.graphqlRequest(query, variables);
    
    if (!response.data?.issueCreate?.success) {
      throw new Error(`Failed to create Linear issue: ${JSON.stringify(response.errors)}`);
    }

    const createdIssue = response.data.issueCreate.issue;
    
    return {
      id: createdIssue.id,
      identifier: createdIssue.identifier, // e.g., "LIN-123"
      url: createdIssue.url,
    };
  }

  async updateIssue(issueId: string, updates: Partial<PMToolIssue>): Promise<void> {
    const query = `
      mutation UpdateIssue($id: String!, $input: IssueUpdateInput!) {
        issueUpdate(id: $id, input: $input) {
          success
        }
      }
    `;

    const input: any = {};
    
    if (updates.title) input.title = updates.title;
    if (updates.description) input.description = this.formatDescription(updates as PMToolIssue);
    if (updates.labels) input.labelIds = this.mapLabels(updates.labels);
    if (updates.priority) input.priority = this.mapPriority(updates.priority);

    const variables = {
      id: issueId,
      input,
    };

    const response = await this.graphqlRequest(query, variables);
    
    if (!response.data?.issueUpdate?.success) {
      throw new Error(`Failed to update Linear issue: ${JSON.stringify(response.errors)}`);
    }
  }

  async findIssueBySourceId(sourceId: string): Promise<{ id: string; url: string } | null> {
    // Linear doesn't have a built-in way to search by custom source ID
    // We maintain a mapping table externally (in export results or mapping file)
    // This method should be called with the stored linear_issue_id from mapping
    // For now, return null - caller should use stored mapping from previous exports
    return null;
  }
  
  /**
   * Get Linear issue by ID (for reading status/updates)
   * Useful for back-propagating Linear state to internal tracking
   */
  async getIssue(issueId: string): Promise<{ id: string; identifier: string; url: string; title: string; state: string } | null> {
    const query = `
      query GetIssue($id: String!) {
        issue(id: $id) {
          id
          identifier
          url
          title
          state {
            name
          }
        }
      }
    `;

    try {
      const response = await this.graphqlRequest(query, { id: issueId });
      
      if (response.data?.issue) {
        return {
          id: response.data.issue.id,
          identifier: response.data.issue.identifier,
          url: response.data.issue.url,
          title: response.data.issue.title,
          state: response.data.issue.state?.name || "Unknown",
        };
      }
      
      return null;
    } catch (error) {
      logError(`Failed to get Linear issue ${issueId}:`, error);
      return null;
    }
  }

  private async graphqlRequest(query: string, variables: any): Promise<any> {
    const response = await fetch(this.apiUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": this.apiKey,
      },
      body: JSON.stringify({
        query,
        variables,
      }),
    });

    if (!response.ok) {
      throw new Error(`Linear API error: ${response.status} ${response.statusText}`);
    }

    return await response.json();
  }

  private formatDescription(issue: PMToolIssue): string {
    let description = issue.description || "";
    
    // Add source links section
    description += `\n\n---\n\n`;
    description += `## Sources\n\n`;
    
    // Discord/Slack sources
    if (issue.source === "discord" && issue.source_url) {
      description += `**Discord:** [View discussion](${issue.source_url})\n`;
    }
    
    // GitHub issues (for context only - Linear PR linking happens via Linear issue ID)
    if (issue.metadata?.github_issues) {
      const githubIssues = issue.metadata.github_issues as Array<{
        issue_number: number;
        issue_url: string;
        issue_title: string;
      }>;
      if (githubIssues.length > 0) {
        description += `\n**Related GitHub Issues (for context):**\n`;
        for (const ghIssue of githubIssues) {
          description += `- [#${ghIssue.issue_number} ${ghIssue.issue_title}](${ghIssue.issue_url})\n`;
        }
      }
    }
    
    // Discord threads (if multiple)
    if (issue.metadata?.discord_threads) {
      const discordThreads = issue.metadata.discord_threads as Array<{
        thread_name: string;
        thread_url: string;
      }>;
      if (discordThreads.length > 1) {
        description += `\n**Additional Discord Discussions:**\n`;
        for (const thread of discordThreads) {
          description += `- [${thread.thread_name}](${thread.thread_url})\n`;
        }
      }
    }

    return description;
  }

  private mapPriority(priority?: "high" | "medium" | "low"): number {
    // Linear uses: 0 = No priority, 1 = Urgent, 2 = High, 3 = Medium, 4 = Low
    switch (priority) {
      case "high":
        return 2;
      case "medium":
        return 3;
      case "low":
        return 4;
      default:
        return 0;
    }
  }

  private mapLabels(labels: string[]): string[] {
    // Linear uses label IDs, not names
    // This would need to be implemented by fetching labels first
    // For now, return empty array - labels would need to be pre-created in Linear
    return [];
  }
}

