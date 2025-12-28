/**
 * Linear integration
 * Exports issues to Linear project management tool
 */

import { BasePMTool } from "../base.js";
import { PMToolIssue, PMToolConfig, ExportResult } from "../types.js";
import { log, logError } from "../../mcp/logger.js";

export class LinearIntegration extends BasePMTool {
  private apiUrl: string;
  private apiKey: string;
  public teamId?: string; // Make accessible for updating after auto-creation
  private projectCache: Map<string, string> = new Map(); // feature_id -> project_id
  private projectNameCache: Map<string, string> = new Map(); // project_name (lowercase) -> project_id

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

    const response = await this.graphqlRequest<{
      issueCreate?: {
        success: boolean;
        issue?: {
          id: string;
          identifier: string;
          url: string;
        };
      };
    }>(query, variables);
    
    if (!response.data?.issueCreate?.success) {
      throw new Error(`Failed to create Linear issue: ${JSON.stringify(response.errors)}`);
    }

    const createdIssue = response.data?.issueCreate?.issue;
    if (!createdIssue) {
      throw new Error("Failed to create Linear issue: no issue data returned");
    }
    
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

    const input: Record<string, unknown> = {};
    
    if (updates.title) input.title = updates.title;
    if (updates.description) input.description = this.formatDescription(updates as PMToolIssue);
    if (updates.labels) input.labelIds = this.mapLabels(updates.labels);
    if (updates.priority) input.priority = this.mapPriority(updates.priority);
    if (updates.project_id) input.projectId = updates.project_id;

    const variables = {
      id: issueId,
      input,
    };

    const response = await this.graphqlRequest<{
      issueUpdate?: {
        success: boolean;
      };
    }>(query, variables);
    
    if (!response.data?.issueUpdate?.success) {
      throw new Error(`Failed to update Linear issue: ${JSON.stringify(response.errors)}`);
    }
  }

  /**
   * Create or get Linear Project for a feature
   * Projects represent product features in Linear
   * Always creates projects, including for "General" features
   * Checks for duplicate project names before creating
   */
  async createOrGetProject(featureId: string, featureName: string, featureDescription?: string): Promise<string> {
    // Sanitize feature ID - Linear project IDs must be valid UUIDs or short strings
    // If featureId is too long or contains invalid chars, use a hash or truncate
    let sanitizedFeatureId = featureId;
    if (featureId.length > 50 || !/^[a-zA-Z0-9_-]+$/.test(featureId)) {
      // Create a shorter, sanitized ID from the feature name
      sanitizedFeatureId = featureName.toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .substring(0, 50);
    }

    // Check cache by feature ID first
    if (this.projectCache.has(sanitizedFeatureId)) {
      return this.projectCache.get(sanitizedFeatureId)!;
    }

    // Sanitize project name - Linear has limits on project name length
    // Linear project names should be max 255 characters, but we'll be conservative
    const sanitizedName = featureName.trim().substring(0, 100);
    if (!sanitizedName) {
      throw new Error(`Invalid project name: "${featureName}"`);
    }

    // Check cache by project name (case-insensitive) to avoid duplicates
    const nameKey = sanitizedName.toLowerCase().trim();
    if (this.projectNameCache.has(nameKey)) {
      const existingProjectId = this.projectNameCache.get(nameKey)!;
      // Also cache by feature ID for faster future lookups
      this.projectCache.set(sanitizedFeatureId, existingProjectId);
      log(`Found existing Linear project by name: ${sanitizedName} (${existingProjectId})`);
      return existingProjectId;
    }

    // Try to find existing project by name in Linear
    const existingProject = await this.findProjectByName(sanitizedName);
    if (existingProject) {
      const projectId = existingProject.id;
      // Cache by both feature ID and name
      this.projectCache.set(sanitizedFeatureId, projectId);
      this.projectNameCache.set(nameKey, projectId);
      log(`Found existing Linear project: ${existingProject.name} (${projectId})`);
      return projectId;
    }

    // No existing project found - create new one
    const query = `
      mutation CreateProject($input: ProjectCreateInput!) {
        projectCreate(input: $input) {
          success
          project {
            id
            name
            url
          }
          error {
            message
          }
        }
      }
    `;

    // Sanitize description too
    const sanitizedDescription = (featureDescription || `Project for ${sanitizedName} feature`)
      .trim()
      .substring(0, 1000); // Linear description limit

    const variables = {
      input: {
        name: sanitizedName,
        description: sanitizedDescription,
        // Note: teamIds is optional - projects are workspace-level in Linear
        // If teamId is provided, we can associate the project with the team
        ...(this.teamId && { teamIds: [this.teamId] }),
      },
    };

    try {
      const response = await this.graphqlRequest<{
        projectCreate?: {
          success: boolean;
          error?: { message?: string };
          project?: {
            id: string;
            name: string;
          };
        };
      }>(query, variables);
      
      if (!response.data?.projectCreate?.success) {
        const errorMsg = response.data?.projectCreate?.error?.message 
          || (response.errors ? JSON.stringify(response.errors) : "Unknown error");
        throw new Error(`Failed to create Linear project "${sanitizedName}": ${errorMsg}`);
      }

      const project = response.data.projectCreate.project;
      if (!project) {
        throw new Error(`Linear API returned success but no project data for "${sanitizedName}"`);
      }

      const projectId = project.id;
      
      // Cache by both feature ID and name
      this.projectCache.set(sanitizedFeatureId, projectId);
      this.projectNameCache.set(nameKey, projectId);
      
      log(`Created Linear project: ${project.name} (${projectId})`);
      
      return projectId;
    } catch (error) {
      logError(`Failed to create Linear project for feature "${sanitizedName}" (ID: ${sanitizedFeatureId}):`, error);
      // If it's a duplicate name error, try to find the existing project
      if (error instanceof Error && (error.message.includes('duplicate') || error.message.includes('already exists'))) {
        try {
          const existingProject = await this.findProjectByName(sanitizedName);
          if (existingProject) {
            const projectId = existingProject.id;
            this.projectCache.set(sanitizedFeatureId, projectId);
            this.projectNameCache.set(nameKey, projectId);
            log(`Found existing Linear project after duplicate error: ${existingProject.name} (${projectId})`);
            return projectId;
          }
        } catch (findError) {
          // Ignore find error, throw original error
        }
      }
      throw error;
    }
  }

  /**
   * List all projects in the workspace
   */
  async listProjects(): Promise<Array<{ id: string; name: string }>> {
    try {
      const query = `
        query GetProjects {
          projects {
            nodes {
              id
              name
            }
          }
        }
      `;
      
      const response = await this.graphqlRequest<{
        projects?: {
          nodes?: Array<{
            id: string;
            name: string;
          }>;
        };
      }>(query, {});
      
      if (response.data?.projects?.nodes) {
        // Update name cache with all projects
        for (const project of response.data.projects.nodes) {
          const normalizedName = project.name.toLowerCase().trim();
          if (!this.projectNameCache.has(normalizedName)) {
            this.projectNameCache.set(normalizedName, project.id);
          }
        }
        
        return response.data.projects.nodes.map((p: { id: string; name: string }) => ({
          id: p.id,
          name: p.name,
        }));
      }
      
      return [];
    } catch (error) {
      logError("Failed to list Linear projects:", error);
      throw error;
    }
  }

  /**
   * Find Linear project by name
   * Linear projects query - uses workspace scope (projects are workspace-level, not team-level)
   * Also updates the name cache with all found projects to avoid future duplicate lookups
   */
  private async findProjectByName(projectName: string): Promise<{ id: string; name: string } | null> {
    try {
      // Linear projects are workspace-level, not team-level
      // Query all projects in the workspace
      const query = `
        query GetProjects {
          projects {
            nodes {
              id
              name
            }
          }
        }
      `;
      
      const response = await this.graphqlRequest<{
        projects?: {
          nodes?: Array<{
            id: string;
            name: string;
          }>;
        };
      }>(query, {});
      
      if (response.data?.projects?.nodes) {
        const normalizedSearchName = projectName.toLowerCase().trim();
        
        // Update name cache with all projects found
        for (const project of response.data.projects.nodes) {
          const normalizedName = project.name.toLowerCase().trim();
          if (!this.projectNameCache.has(normalizedName)) {
            this.projectNameCache.set(normalizedName, project.id);
          }
        }
        
        // Find the matching project
        const project = response.data.projects.nodes.find(
          (p: { name: string }) => p.name.toLowerCase().trim() === normalizedSearchName
        );
        
        if (project) {
          return { id: project.id, name: project.name };
        }
      }
      
      return null;
    } catch (error) {
      logError(`Failed to find Linear project by name ${projectName}:`, error);
      return null;
    }
  }

  async findIssueBySourceId(sourceId: string, title?: string): Promise<{ id: string; url: string } | null> {
    // Linear doesn't have a built-in way to search by custom source ID
    // We maintain a mapping table externally (in export results or mapping file)
    // This method is primarily used when no stored ID exists
    
    // As a fallback, try searching by title if provided
    if (title) {
      try {
        const found = await this.searchIssueByTitle(title);
        if (found) {
          return found;
        }
      } catch (error) {
        // Log but don't fail - this is a fallback
        logError(`Failed to search Linear issue by title "${title}":`, error);
      }
    }
    
    return null;
  }
  
  /**
   * Search for Linear issue by title (used for duplicate detection)
   * Returns the first matching issue found
   */
  private async searchIssueByTitle(title: string): Promise<{ id: string; url: string } | null> {
    // Linear GraphQL API: Use issueSearch with title filter
    // Note: Linear's search may require workspace-level access
    const query = `
      query SearchIssues($query: String!) {
        issueSearch(query: $query, first: 10) {
          nodes {
            id
            identifier
            url
            title
          }
        }
      }
    `;

    try {
      // Search for exact title match (Linear search supports quoted strings for exact match)
      const searchQuery = `"${title}"`;
      const response = await this.graphqlRequest<{
        issueSearch?: {
          nodes?: Array<{
            id: string;
            title: string;
            url: string;
          }>;
        };
      }>(query, { query: searchQuery });
      
      if (response.data?.issueSearch?.nodes) {
        // Find exact title match (case-insensitive)
        const exactMatch = response.data.issueSearch.nodes.find(
          (issue) => issue.title.toLowerCase() === title.toLowerCase()
        );
        
        if (exactMatch) {
          return {
            id: exactMatch.id,
            url: exactMatch.url,
          };
        }
      }
      
      return null;
    } catch (error) {
      logError(`Failed to search Linear issue by title "${title}":`, error);
      return null;
    }
  }
  
  /**
   * List all teams in the Linear workspace
   * Useful for finding the correct team ID to use
   */
  async listTeams(): Promise<Array<{ id: string; name: string; key: string }>> {
    const query = `
      query GetTeams {
        teams {
          nodes {
            id
            name
            key
          }
        }
      }
    `;

    try {
      const response = await this.graphqlRequest<{
        teams?: {
          nodes?: Array<{
            id: string;
            name: string;
            key: string;
          }>;
        };
      }>(query, {});
      
      if (response.data?.teams?.nodes) {
        return response.data.teams.nodes.map((team) => ({
          id: team.id,
          name: team.name,
          key: team.key,
        }));
      }
      
      return [];
    } catch (error) {
      logError("Failed to list Linear teams:", error);
      throw error;
    }
  }

  /**
   * Get team by ID or key
   * Validates that the team exists and is accessible
   */
  async getTeam(teamIdOrKey: string): Promise<{ id: string; name: string; key: string } | null> {
    const query = `
      query GetTeam($id: String) {
        team(id: $id) {
          id
          name
          key
        }
      }
    `;

    try {
      const response = await this.graphqlRequest<{
        team?: {
          id: string;
          name: string;
          key: string;
        };
      }>(query, { id: teamIdOrKey });
      
      if (response.data?.team) {
        return {
          id: response.data.team.id,
          name: response.data.team.name,
          key: response.data.team.key,
        };
      }
      
      return null;
    } catch (error) {
      logError(`Failed to get Linear team ${teamIdOrKey}:`, error);
      return null;
    }
  }

  /**
   * Create or get Linear team by name/key
   * If team doesn't exist, creates it automatically
   */
  async createOrGetTeam(teamName: string, teamKey?: string): Promise<string> {
    // If teamKey not provided, generate from teamName (e.g., "UNMute" -> "UNMUTE")
    const key = teamKey || teamName.toUpperCase().replace(/[^A-Z0-9]/g, "").substring(0, 20);
    
    // First, try to find existing team by name or key
    const teams = await this.listTeams();
    const existingTeam = teams.find(
      t => t.name.toLowerCase() === teamName.toLowerCase() || t.key.toLowerCase() === key.toLowerCase()
    );
    
    if (existingTeam) {
      log(`Found existing Linear team: ${existingTeam.name} (${existingTeam.key})`);
      return existingTeam.id;
    }

    // Team doesn't exist, create it
    log(`Creating Linear team: ${teamName} (${key})`);
    
    const query = `
      mutation CreateTeam($input: TeamCreateInput!) {
        teamCreate(input: $input) {
          success
          team {
            id
            name
            key
          }
        }
      }
    `;

    const variables = {
      input: {
        name: teamName,
        key: key,
        description: `Auto-created team for ${teamName}`,
      },
    };

    try {
      const response = await this.graphqlRequest<{
        teamCreate?: {
          success: boolean;
          team?: {
            id: string;
            name: string;
            key: string;
          };
        };
      }>(query, variables);
      
      if (!response.data?.teamCreate?.success) {
        throw new Error(`Failed to create Linear team: ${JSON.stringify(response.errors)}`);
      }

      const team = response.data?.teamCreate?.team;
      if (!team) {
        throw new Error("Failed to create Linear team: no team data returned");
      }
      log(`Created Linear team: ${team.name} (${team.key}) - ${team.id}`);
      
      return team.id;
    } catch (error) {
      logError(`Failed to create Linear team ${teamName}:`, error);
      throw error;
    }
  }

  /**
   * Validate that the configured team ID exists
   * If no team ID is configured, optionally create a default team
   */
  async validateTeam(createIfMissing: boolean = false, defaultTeamName: string = "UNMute"): Promise<boolean> {
    if (!this.teamId) {
      if (createIfMissing) {
        log(`No team ID configured, creating default team: ${defaultTeamName}`);
        try {
          const teamId = await this.createOrGetTeam(defaultTeamName);
          this.teamId = teamId;
          log(`Using auto-created team: ${defaultTeamName} (${teamId})`);
          return true;
        } catch (error) {
          logError(`Failed to create default team ${defaultTeamName}:`, error);
          log("Projects and issues will be created without team association");
          return false;
        }
      } else {
        log("No team ID configured - projects and issues will be created without team association");
        return false;
      }
    }

    const team = await this.getTeam(this.teamId);
    if (!team) {
      logError(`Configured team ID ${this.teamId} not found or not accessible`);
      return false;
    }

    log(`Validated Linear team: ${team.name} (${team.key})`);
    return true;
  }

  /**
   * Get Linear issue by ID (for reading status/updates)
   * Useful for back-propagating Linear state to internal tracking
   */
  async getIssue(issueId: string): Promise<{ id: string; identifier: string; url: string; title: string; state: string; projectId?: string; projectName?: string } | null> {
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
          project {
            id
            name
          }
        }
      }
    `;

    try {
      const response = await this.graphqlRequest<{
        issue?: {
          id: string;
          identifier: string;
          url: string;
          title: string;
          state?: { name: string };
          project?: { id: string; name: string } | null;
        };
      }>(query, { id: issueId });
      
      if (response.data?.issue) {
        return {
          id: response.data.issue.id,
          identifier: response.data.issue.identifier,
          url: response.data.issue.url,
          title: response.data.issue.title,
          state: response.data.issue.state?.name || "Unknown",
          projectId: response.data.issue.project?.id ?? undefined,
          projectName: response.data.issue.project?.name ?? undefined,
        };
      }
      
      return null;
    } catch (error) {
      logError(`Failed to get Linear issue ${issueId}:`, error);
      return null;
    }
  }

  /**
   * List all issues from a Linear team
   * Returns issues with their project information
   */
  async listTeamIssues(teamId: string, limit: number = 250): Promise<Array<{
    id: string;
    identifier: string;
    url: string;
    title: string;
    description?: string;
    state: string;
    projectId?: string;
    projectName?: string;
    priority?: number;
    labels?: Array<{ id: string; name: string }>;
  }>> {
    const query = `
      query GetTeamIssues($teamId: String!, $first: Int!) {
        team(id: $teamId) {
          issues(first: $first) {
            nodes {
              id
              identifier
              url
              title
              description
              state {
                name
              }
              project {
                id
                name
              }
              priority
              labels {
                nodes {
                  id
                  name
                }
              }
            }
            pageInfo {
              hasNextPage
              endCursor
            }
          }
        }
      }
    `;

    try {
      interface LinearIssueResult {
        id: string;
        identifier: string;
        url: string;
        title: string;
        description?: string;
        state: string;
        projectId?: string;
        projectName?: string;
        priority?: number;
        labels?: Array<{ id: string; name: string }>;
      }
      
      const allIssues: LinearIssueResult[] = [];
      let hasNextPage = true;
      let cursor: string | undefined;

      while (hasNextPage && allIssues.length < limit) {
        const variables: { teamId: string; first: number; after?: string } = {
          teamId,
          first: Math.min(limit - allIssues.length, 100), // Linear API limit is typically 100 per page
        };

        if (cursor) {
          // For pagination, we'd need to modify the query to use after cursor
          // For now, we'll fetch in batches
          break; // Simplified - can be enhanced with proper pagination
        }

        const response = await this.graphqlRequest<{
          team?: {
            issues?: {
              nodes?: Array<{
                id: string;
                identifier: string;
                url: string;
                title: string;
                description: string | null;
                state?: { name: string };
                project?: { id: string; name: string } | null;
                priority: number | null;
                labels?: { nodes: Array<{ id: string; name: string }> };
              }>;
              pageInfo?: {
                hasNextPage: boolean;
                endCursor?: string;
              };
            };
          };
        }>(query, variables);
        
        if (response.data?.team?.issues?.nodes) {
          const issues = response.data.team.issues.nodes.map((issue) => ({
            id: issue.id,
            identifier: issue.identifier,
            url: issue.url,
            title: issue.title,
            description: issue.description ?? undefined,
            state: issue.state?.name || "Unknown",
            projectId: issue.project?.id ?? undefined,
            projectName: issue.project?.name ?? undefined,
            priority: issue.priority ?? undefined,
            labels: issue.labels?.nodes || [],
          }));
          
          allIssues.push(...issues);
          
          hasNextPage = response.data.team.issues.pageInfo?.hasNextPage || false;
          cursor = response.data.team.issues.pageInfo?.endCursor;
        } else {
          hasNextPage = false;
        }
      }

      return allIssues;
    } catch (error) {
      logError(`Failed to list Linear team issues for team ${teamId}:`, error);
      throw error;
    }
  }

  private async graphqlRequest<T = Record<string, unknown>>(query: string, variables: Record<string, unknown>): Promise<{ data?: T; errors?: Array<{ message: string }> }> {
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

