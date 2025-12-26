/**
 * Jira integration
 * Exports issues to Jira project management tool
 */

import { BasePMTool } from "./base-pm-tool.js";
import { PMToolIssue, PMToolConfig, ExportResult } from "./types.js";
import { log, logError } from "../logger.js";

export class JiraIntegration extends BasePMTool {
  private apiUrl: string;
  private apiKey: string;
  private email?: string;
  private projectId?: string;

  constructor(config: PMToolConfig) {
    super(config);
    
    if (!config.api_key) {
      throw new Error("Jira API key is required");
    }

    this.apiKey = config.api_key;
    this.email = config.api_url; // Jira uses email + API key
    this.projectId = config.project_id;
    
    // Jira API URL format: https://{domain}.atlassian.net/rest/api/3
    if (!config.api_url || !config.api_url.includes("atlassian.net")) {
      throw new Error("Jira API URL must be in format: https://{domain}.atlassian.net");
    }
    
    this.apiUrl = config.api_url.endsWith("/rest/api/3") 
      ? config.api_url 
      : `${config.api_url.replace(/\/$/, "")}/rest/api/3`;
  }

  async createIssue(issue: PMToolIssue): Promise<{ id: string; url: string }> {
    const issueData: any = {
      fields: {
        project: {
          key: this.projectId || "PROJ", // Default project key
        },
        summary: issue.title,
        description: {
          type: "doc",
          version: 1,
          content: [
            {
              type: "paragraph",
              content: [
                {
                  type: "text",
                  text: issue.description || "",
                },
              ],
            },
            {
              type: "paragraph",
              content: [
                {
                  type: "text",
                  text: `\n---\nSource: ${issue.source === "discord" ? "💬 Discord" : "🐙 GitHub"}\nLink: ${issue.source_url}`,
                },
              ],
            },
          ],
        },
        issuetype: {
          name: "Bug", // Default to Bug, can be configured
        },
      },
    };

    if (issue.priority) {
      issueData.fields.priority = {
        name: issue.priority === "high" ? "Highest" : issue.priority === "medium" ? "High" : "Medium",
      };
    }

    if (issue.labels && issue.labels.length > 0) {
      issueData.fields.labels = issue.labels;
    }

    const response = await fetch(`${this.apiUrl}/issue`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Basic ${btoa(`${this.email}:${this.apiKey}`)}`,
      },
      body: JSON.stringify(issueData),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Jira API error: ${response.status} ${errorText}`);
    }

    const data = await response.json();
    
    return {
      id: data.id,
      url: `${this.apiUrl.replace("/rest/api/3", "")}/browse/${data.key}`,
    };
  }

  async updateIssue(issueId: string, updates: Partial<PMToolIssue>): Promise<void> {
    const updateData: any = {
      fields: {},
    };

    if (updates.title) {
      updateData.fields.summary = updates.title;
    }

    if (updates.description) {
      updateData.fields.description = {
        type: "doc",
        version: 1,
        content: [
          {
            type: "paragraph",
            content: [
              {
                type: "text",
                text: updates.description,
              },
            ],
          },
        ],
      };
    }

    if (updates.priority) {
      updateData.fields.priority = {
        name: updates.priority === "high" ? "Highest" : updates.priority === "medium" ? "High" : "Medium",
      };
    }

    if (updates.labels) {
      updateData.fields.labels = updates.labels;
    }

    const response = await fetch(`${this.apiUrl}/issue/${issueId}`, {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Basic ${btoa(`${this.email}:${this.apiKey}`)}`,
      },
      body: JSON.stringify(updateData),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Jira API error: ${response.status} ${errorText}`);
    }
  }

  async findIssueBySourceId(sourceId: string): Promise<{ id: string; url: string } | null> {
    // Jira: Search for issues by source ID in description or custom field
    // This would require a custom field or searching by description content
    // For now, return null - should be enhanced with proper search
    return null;
  }
}

