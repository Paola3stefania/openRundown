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

  async createIssue(issue: PMToolIssue): Promise<{ id: string; url: string }> {
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
        ...(issue.feature_id && {
          // Custom fields can be added here if Linear workspace has custom fields
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
    // We'll need to store the mapping or use issue comments/metadata
    // For now, return null - this should be enhanced with a mapping table
    return null;
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
    
    // Add source information
    description += `\n\n---\n\n`;
    description += `**Source:** ${issue.source === "discord" ? "💬 Discord" : "🐙 GitHub"}\n`;
    description += `**Link:** ${issue.source_url}\n`;
    
    if (issue.feature_name) {
      description += `**Related Feature:** ${issue.feature_name}\n`;
    }
    
    if (issue.metadata) {
      description += `\n**Metadata:**\n`;
      for (const [key, value] of Object.entries(issue.metadata)) {
        description += `- ${key}: ${value}\n`;
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

