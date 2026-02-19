/**
 * Linear integration
 * Exports issues to Linear project management tool
 */

import { BasePMTool } from "../base.js";
import { PMToolIssue, PMToolConfig, ExportResult } from "../types.js";
import { log, logError } from "../../mcp/logger.js";

// Standard labels for priority detection
const STANDARD_LABELS = {
  // Security labels - red color
  security: { name: "security", color: "#DC2626", description: "Security vulnerability or concern" },
  vulnerability: { name: "vulnerability", color: "#DC2626", description: "Security vulnerability" },
  
  // Bug labels - orange color  
  bug: { name: "bug", color: "#EA580C", description: "Bug or defect" },
  regression: { name: "regression", color: "#EA580C", description: "Regression - previously working functionality broken" },
  crash: { name: "crash", color: "#EA580C", description: "Application crash" },
  
  // Priority labels - various colors
  urgent: { name: "urgent", color: "#B91C1C", description: "Urgent - needs immediate attention" },
  critical: { name: "critical", color: "#DC2626", description: "Critical issue" },
  blocker: { name: "blocker", color: "#991B1B", description: "Blocker - prevents progress" },
  
  // Source labels - blue/purple colors
  "discord": { name: "discord", color: "#5865F2", description: "Has related Discord discussions" },
  "discord-thread": { name: "discord-thread", color: "#5865F2", description: "Originated from Discord" },
  "github-issue": { name: "github-issue", color: "#6E5494", description: "Related to GitHub issue" },
  
  // Grouping labels - gray colors
  ungrouped: { name: "ungrouped", color: "#6B7280", description: "Not matched to existing issues" },
  "cross-cutting": { name: "cross-cutting", color: "#7C3AED", description: "Affects multiple features" },
  
  // Feature request labels - green color (low priority)
  enhancement: { name: "enhancement", color: "#16A34A", description: "Feature request or enhancement" },
  "feature-request": { name: "feature-request", color: "#16A34A", description: "New feature request" },
} as const;

export class LinearIntegration extends BasePMTool {
  private apiUrl: string;
  private apiKey: string;
  public teamId?: string; // Make accessible for updating after auto-creation
  private projectCache: Map<string, string> = new Map(); // feature_id -> project_id
  private projectNameCache: Map<string, string> = new Map(); // project_name (lowercase) -> project_id
  private labelCache: Map<string, string> = new Map(); // label_name (lowercase) -> label_id
  private labelsInitialized: boolean = false;

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

    // Use mapLabelsAsync to auto-create missing labels
    const labelIds = await this.mapLabelsAsync(issue.labels || []);

    const variables = {
      input: {
        teamId: this.teamId || undefined,
        title: issue.title,
        description: this.formatDescription(issue),
        labelIds,
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
    // Use mapLabelsAsync to auto-create missing labels
    if (updates.labels) input.labelIds = await this.mapLabelsAsync(updates.labels);
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
        // Associate project with OpenRundown team to ensure compatibility with issues
        // Only include teamIds if teamId is valid (non-empty string)
        ...(this.teamId && this.teamId.trim() && { teamIds: [this.teamId] }),
      },
    };

    try {
      const response = await this.graphqlRequest<{
        projectCreate?: {
          success: boolean;
          project?: {
            id: string;
            name: string;
            url?: string;
          };
        };
      }>(query, variables);
      
      if (!response.data?.projectCreate?.success) {
        const errorMsg = response.errors 
          ? response.errors.map(e => e.message).join(", ")
          : "Unknown error";
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
   * Get project details including teamIds
   */
  private async getProject(projectId: string): Promise<{ id: string; name: string; teamIds: string[] } | null> {
    const query = `
      query GetProject($id: String!) {
        project(id: $id) {
          id
          name
          teams {
            nodes {
              id
            }
          }
        }
      }
    `;

    try {
      const response = await this.graphqlRequest<{
        project?: {
          id: string;
          name: string;
          teams?: {
            nodes?: Array<{ id: string }>;
          };
        };
      }>(query, { id: projectId });

      if (response.data?.project) {
        const teamIds = response.data.project.teams?.nodes?.map(t => t.id) || [];
        return {
          id: response.data.project.id,
          name: response.data.project.name,
          teamIds,
        };
      }
      return null;
    } catch (error) {
      logError(`Failed to get project ${projectId}:`, error);
      return null;
    }
  }

  /**
   * Update project to associate with OpenRundown team
   * Adds OpenRundown team to existing teams (doesn't remove existing teams)
   * This makes projects compatible with issues from the OpenRundown team
   */
  async updateProjectTeam(projectId: string): Promise<boolean> {
    if (!this.teamId) {
      logError(`Cannot update project team - no teamId configured`);
      return false;
    }

    // First, get the current project to see existing teams
    const currentProject = await this.getProject(projectId);
    if (!currentProject) {
      logError(`Cannot update project ${projectId} - project not found`);
      return false;
    }

    // Check if OpenRundown team is already in the project's teams
    if (currentProject.teamIds.includes(this.teamId)) {
      log(`Project ${projectId} already associated with team ${this.teamId}`);
      return true;
    }

    // Add OpenRundown team to existing teams (don't remove existing teams)
    const updatedTeamIds = [...new Set([...currentProject.teamIds, this.teamId])];

    const query = `
      mutation UpdateProject($id: String!, $input: ProjectUpdateInput!) {
        projectUpdate(id: $id, input: $input) {
          success
          project {
            id
            name
          }
        }
      }
    `;

    try {
      const response = await this.graphqlRequest<{
        projectUpdate?: {
          success: boolean;
          project?: {
            id: string;
            name: string;
          };
        };
      }>(query, {
        id: projectId,
        input: {
          teamIds: updatedTeamIds, // Add OpenRundown team to existing teams
        },
      });

      if (response.data?.projectUpdate?.success) {
        log(`Updated project ${projectId} to include team ${this.teamId} (teams: ${updatedTeamIds.join(", ")})`);
        return true;
      } else {
        logError(`Failed to update project ${projectId}: ${JSON.stringify(response.errors)}`);
        return false;
      }
    } catch (error) {
      logError(`Error updating project ${projectId} team:`, error);
      return false;
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
    
    // First, try searching by source_id in description (most reliable)
    // This is the primary way to find existing issues - never rely on title
    // because title can change (e.g., when we add "X days ago - Title" format)
    try {
      const foundById = await this.searchIssueBySourceId(sourceId);
      if (foundById) {
        return foundById;
      }
    } catch (error) {
      logError(`Failed to search Linear issue by source_id "${sourceId}":`, error);
    }
    
    // DO NOT use title as fallback - titles change (e.g., "X days ago - Title" format)
    // If source_id search fails, the issue doesn't exist yet
    // Title search would create duplicates when titles are updated
    
    return null;
  }
  
  /**
   * Search for Linear issue by source_id in description
   * We store source_id in the description for duplicate detection
   */
  private async searchIssueBySourceId(sourceId: string): Promise<{ id: string; url: string } | null> {
    if (!this.teamId) {
      // Can't search without team context - try to get team issues directly
      return null;
    }

    // First, try to get all team issues and search in their descriptions
    // This is more reliable than using issueSearch which may not search descriptions
    try {
      const teamIssues = await this.listTeamIssues(this.teamId, 250);
      
      // Search for source_id in description
      const exactMatch = teamIssues.find(
        (issue) => {
          const desc = issue.description || "";
          // Look for source_id in the description (we store it as HTML comment)
          return desc.includes(`source_id: ${sourceId}`);
        }
      );
      
      if (exactMatch) {
        // Get full issue details to return URL
        const fullIssue = await this.getIssue(exactMatch.id);
        if (fullIssue) {
          return {
            id: fullIssue.id,
            url: fullIssue.url,
          };
        }
      }
    } catch (error) {
      logError(`Failed to search Linear issue by source_id "${sourceId}":`, error);
    }
    
    // Fallback: try Linear's search API (may not search descriptions)
    try {
      const query = `
        query SearchIssues($query: String!) {
          issueSearch(query: $query, first: 20) {
            nodes {
              id
              identifier
              url
              title
              description
            }
          }
        }
      `;

      // Search for source_id - Linear search may not support description search
      const searchQuery = `"${sourceId}"`;
      const response = await this.graphqlRequest<{
        issueSearch?: {
          nodes?: Array<{
            id: string;
            title: string;
            url: string;
            description?: string;
          }>;
        };
      }>(query, { query: searchQuery });
      
      if (response.data?.issueSearch?.nodes) {
        // Find exact source_id match in description
        const exactMatch = response.data.issueSearch.nodes.find(
          (issue) => {
            const desc = issue.description || "";
            // Look for source_id in the description
            return desc.includes(`source_id: ${sourceId}`);
          }
        );
        
        if (exactMatch) {
          return {
            id: exactMatch.id,
            url: exactMatch.url,
          };
        }
      }
    } catch (error) {
      logError(`Failed to search Linear issue by source_id using search API "${sourceId}":`, error);
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
      query GetTeam($id: String!) {
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
    // If teamKey not provided, generate from teamName (e.g., "OpenRundown" -> "OPENRUNDOWN")
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
  async validateTeam(createIfMissing: boolean = false, defaultTeamName: string = "OpenRundown"): Promise<boolean> {
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
  async getIssue(issueId: string): Promise<{ id: string; identifier: string; url: string; title: string; description?: string; state: string; stateId?: string; assigneeId?: string; projectId?: string; projectName?: string; priority?: number; labelNames?: string[]; teamId?: string; teamName?: string } | null> {
    const query = `
      query GetIssue($id: String!) {
        issue(id: $id) {
          id
          identifier
          url
          title
          description
          state {
            id
            name
          }
          assignee {
            id
          }
          team {
            id
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
      }
    `;

    try {
      const response = await this.graphqlRequest<{
        issue?: {
          id: string;
          identifier: string;
          url: string;
          title: string;
          description?: string;
          state?: { id: string; name: string };
          assignee?: { id: string } | null;
          team?: { id: string; name: string } | null;
          project?: { id: string; name: string } | null;
          priority?: number | null;
          labels?: { nodes: Array<{ id: string; name: string }> };
        };
      }>(query, { id: issueId });
      
      if (response.data?.issue) {
        return {
          id: response.data.issue.id,
          identifier: response.data.issue.identifier,
          url: response.data.issue.url,
          title: response.data.issue.title,
          description: response.data.issue.description,
          state: response.data.issue.state?.name || "Unknown",
          stateId: response.data.issue.state?.id,
          assigneeId: response.data.issue.assignee?.id,
          teamId: response.data.issue.team?.id,
          teamName: response.data.issue.team?.name,
          projectId: response.data.issue.project?.id ?? undefined,
          projectName: response.data.issue.project?.name ?? undefined,
          priority: response.data.issue.priority ?? undefined,
          labelNames: response.data.issue.labels?.nodes.map(l => l.name) ?? [],
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

  /**
   * Get workflow states for a team
   * Returns states like "Backlog", "Todo", "In Progress", "Done", "Canceled"
   */
  async getWorkflowStates(teamId?: string): Promise<Array<{ id: string; name: string; type: string }>> {
    const targetTeamId = teamId || this.teamId;
    if (!targetTeamId) {
      throw new Error("Team ID is required to get workflow states");
    }

    const query = `
      query GetWorkflowStates($teamId: String!) {
        team(id: $teamId) {
          states {
            nodes {
              id
              name
              type
            }
          }
        }
      }
    `;

    try {
      const response = await this.graphqlRequest<{
        team?: {
          states?: {
            nodes?: Array<{ id: string; name: string; type: string }>;
          };
        };
      }>(query, { teamId: targetTeamId });

      return response.data?.team?.states?.nodes || [];
    } catch (error) {
      logError(`Failed to get workflow states for team ${targetTeamId}:`, error);
      throw error;
    }
  }

  /**
   * Update issue state (workflow status)
   * @param issueId - Linear issue ID
   * @param stateId - Workflow state ID (get from getWorkflowStates)
   */
  async updateIssueState(issueId: string, stateId: string): Promise<void> {
    const query = `
      mutation UpdateIssueState($id: String!, $stateId: String!) {
        issueUpdate(id: $id, input: { stateId: $stateId }) {
          success
          issue {
            id
            identifier
            state {
              name
            }
          }
        }
      }
    `;

    const response = await this.graphqlRequest<{
      issueUpdate?: {
        success: boolean;
        issue?: {
          id: string;
          identifier: string;
          state?: { name: string };
        };
      };
    }>(query, { id: issueId, stateId });

    if (!response.data?.issueUpdate?.success) {
      throw new Error(`Failed to update Linear issue state: ${JSON.stringify(response.errors)}`);
    }

    log(`Updated Linear issue ${response.data.issueUpdate.issue?.identifier} to state: ${response.data.issueUpdate.issue?.state?.name}`);
  }

  /**
   * Update issue assignee
   * @param issueId - Linear issue ID
   * @param assigneeId - Linear user ID (null to unassign)
   */
  async updateIssueAssignee(issueId: string, assigneeId: string | null): Promise<void> {
    const query = `
      mutation UpdateIssueAssignee($id: String!, $assigneeId: String) {
        issueUpdate(id: $id, input: { assigneeId: $assigneeId }) {
          success
          issue {
            id
            identifier
            assignee {
              id
              name
            }
          }
        }
      }
    `;

    const response = await this.graphqlRequest<{
      issueUpdate?: {
        success: boolean;
        issue?: {
          id: string;
          identifier: string;
          assignee?: { id: string; name: string } | null;
        };
      };
    }>(query, { id: issueId, assigneeId });

    if (!response.data?.issueUpdate?.success) {
      throw new Error(`Failed to update Linear issue assignee: ${JSON.stringify(response.errors)}`);
    }

    const assigneeName = response.data.issueUpdate.issue?.assignee?.name || "unassigned";
    log(`Updated Linear issue ${response.data.issueUpdate.issue?.identifier} assignee: ${assigneeName}`);
  }

  /**
   * Update issue state and assignee in one call
   * @param issueId - Linear issue ID
   * @param stateId - Workflow state ID (optional)
   * @param assigneeId - Linear user ID (optional, null to unassign)
   */
  async updateIssueStateAndAssignee(
    issueId: string,
    stateId?: string,
    assigneeId?: string | null
  ): Promise<void> {
    const input: Record<string, unknown> = {};
    if (stateId !== undefined) input.stateId = stateId;
    if (assigneeId !== undefined) input.assigneeId = assigneeId;

    const query = `
      mutation UpdateIssue($id: String!, $input: IssueUpdateInput!) {
        issueUpdate(id: $id, input: $input) {
          success
          issue {
            id
            identifier
            state {
              name
            }
            assignee {
              id
              name
            }
          }
        }
      }
    `;

    const response = await this.graphqlRequest<{
      issueUpdate?: {
        success: boolean;
        issue?: {
          id: string;
          identifier: string;
          state?: { name: string };
          assignee?: { id: string; name: string } | null;
        };
      };
    }>(query, { id: issueId, input });

    if (!response.data?.issueUpdate?.success) {
      throw new Error(`Failed to update Linear issue state/assignee: ${JSON.stringify(response.errors)}`);
    }

    const stateName = response.data.issueUpdate.issue?.state?.name || "unknown";
    const assigneeName = response.data.issueUpdate.issue?.assignee?.name || "unassigned";
    log(`Updated Linear issue ${response.data.issueUpdate.issue?.identifier}: state=${stateName}, assignee=${assigneeName}`);
  }

  /**
   * List all users in the Linear workspace
   * Returns users with their ID, name, and email
   */
  async listUsers(): Promise<Array<{ id: string; name: string; email: string }>> {
    const query = `
      query GetUsers {
        users {
          nodes {
            id
            name
            email
          }
        }
      }
    `;

    try {
      const response = await this.graphqlRequest<{
        users?: {
          nodes?: Array<{
            id: string;
            name: string;
            email: string;
          }>;
        };
      }>(query, {});

      return response.data?.users?.nodes || [];
    } catch (error) {
      logError("Failed to list Linear users:", error);
      throw error;
    }
  }

  /**
   * Find workflow state by name or type
   * @param nameOrType - State name ("Done", "In Progress") or type ("completed", "started", "backlog", "canceled")
   */
  async findWorkflowState(nameOrType: string, teamId?: string): Promise<{ id: string; name: string; type: string } | null> {
    const states = await this.getWorkflowStates(teamId);
    const searchLower = nameOrType.toLowerCase();
    
    // First try exact name match
    const exactMatch = states.find(s => s.name.toLowerCase() === searchLower);
    if (exactMatch) return exactMatch;
    
    // Then try type match
    const typeMatch = states.find(s => s.type.toLowerCase() === searchLower);
    if (typeMatch) return typeMatch;
    
    // Partial match on name
    const partialMatch = states.find(s => s.name.toLowerCase().includes(searchLower));
    if (partialMatch) return partialMatch;
    
    return null;
  }

  /**
   * Get all issues for team that are NOT in completed/canceled states
   * Uses pagination to fetch all issues (Linear API max is ~250 per page)
   */
  async getOpenIssues(teamId?: string): Promise<Array<{
    id: string;
    identifier: string;
    title: string;
    description?: string;
    state: string;
    stateType: string;
    url: string;
  }>> {
    const targetTeamId = teamId || this.teamId;
    if (!targetTeamId) {
      throw new Error("Team ID is required to get open issues");
    }

    const allIssues: Array<{
      id: string;
      identifier: string;
      title: string;
      description?: string;
      url: string;
      state?: { name: string; type: string };
    }> = [];

    let hasMore = true;
    let cursor: string | null = null;
    const pageSize = 100; // Safe page size for Linear API

    const query = `
      query GetOpenIssues($teamId: String!, $first: Int!, $after: String) {
        team(id: $teamId) {
          issues(first: $first, after: $after) {
            pageInfo {
              hasNextPage
              endCursor
            }
            nodes {
              id
              identifier
              title
              description
              url
              state {
                name
                type
              }
            }
          }
        }
      }
    `;

    type IssuesResponse = {
      team?: {
        issues?: {
          pageInfo?: {
            hasNextPage: boolean;
            endCursor: string | null;
          };
          nodes?: Array<{
            id: string;
            identifier: string;
            title: string;
            description?: string;
            url: string;
            state?: { name: string; type: string };
          }>;
        };
      };
    };

    while (hasMore) {
      try {
        const response: { data?: IssuesResponse; errors?: Array<{ message: string }> } = 
          await this.graphqlRequest<IssuesResponse>(query, { teamId: targetTeamId, first: pageSize, after: cursor });

        const pageIssues = response.data?.team?.issues?.nodes || [];
        allIssues.push(...pageIssues);

        const pageInfo = response.data?.team?.issues?.pageInfo;
        hasMore = pageInfo?.hasNextPage || false;
        cursor = pageInfo?.endCursor || null;

        if (hasMore) {
          log(`[Linear] Fetched ${allIssues.length} issues, fetching more...`);
        }
      } catch (error) {
        logError(`Failed to get open issues for team ${targetTeamId}:`, error);
        throw error;
      }
    }

    log(`[Linear] Fetched ${allIssues.length} total issues`);
    
    // Filter out completed and canceled states (check both name and type)
    const openIssues = allIssues.filter(issue => {
      const stateName = issue.state?.name?.toLowerCase() || "";
      const stateType = issue.state?.type?.toLowerCase() || "";
      
      // Exclude if state is done/completed or canceled
      const isDone = stateName === "done" || stateType === "completed";
      const isCanceled = stateName === "canceled" || stateName === "cancelled" || stateType === "canceled";
      
      return !isDone && !isCanceled;
    });

    log(`[Linear] ${openIssues.length} open issues after filtering`);
    
    return openIssues.map(issue => ({
      id: issue.id,
      identifier: issue.identifier,
      title: issue.title,
      description: issue.description,
      state: issue.state?.name || "Unknown",
      stateType: issue.state?.type || "unknown",
      url: issue.url,
    }));
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
      // Try to get error details from response body
      let errorDetails = response.statusText;
      try {
        const errorBody = await response.text();
        if (errorBody) {
          const parsed = JSON.parse(errorBody);
          if (parsed.errors && Array.isArray(parsed.errors)) {
            errorDetails = parsed.errors.map((e: { message?: string }) => e.message || JSON.stringify(e)).join(", ");
          } else if (parsed.message) {
            errorDetails = parsed.message;
          } else {
            errorDetails = errorBody.substring(0, 500); // Limit length
          }
        }
      } catch {
        // If parsing fails, use statusText
      }
      throw new Error(`Linear API error: ${response.status} ${response.statusText}. Details: ${errorDetails}`);
    }

    return await response.json() as { data?: T; errors?: Array<{ message: string }> };
  }

  private formatDescription(issue: PMToolIssue): string {
    let description = issue.description || "";
    
    // Add source_id for duplicate detection (at the top, hidden in a comment-like format)
    if (issue.source_id) {
      description = `<!-- source_id: ${issue.source_id} -->\n\n${description}`;
    }
    
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
    
    // Discord threads - always show if present
    if (issue.metadata?.discord_threads) {
      const discordThreads = issue.metadata.discord_threads as Array<{
        thread_id: string;
        thread_name: string;
        thread_url: string | null;
        similarity?: number;
        message_count?: number;
      }>;
      if (discordThreads.length > 0) {
        description += `\n**Related Discord Discussions:**\n`;
        for (const thread of discordThreads) {
          if (thread.thread_url) {
            description += `- [${thread.thread_name}](${thread.thread_url})`;
            if (thread.message_count) {
              description += ` (${thread.message_count} messages)`;
            }
            description += `\n`;
          } else {
            description += `- ${thread.thread_name}\n`;
          }
        }
      }
    }

    return description;
  }

  private mapPriority(priority?: "urgent" | "high" | "medium" | "low"): number {
    // Linear uses: 0 = No priority, 1 = Urgent, 2 = High, 3 = Medium, 4 = Low
    switch (priority) {
      case "urgent":
        return 1; // Urgent - highest priority
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

  /**
   * Initialize labels - fetch existing labels and create standard ones
   * Should be called before exporting issues
   */
  async initializeLabels(): Promise<void> {
    if (this.labelsInitialized) {
      return;
    }
    
    try {
      // First, fetch all existing labels
      await this.fetchExistingLabels();
      
      // Create standard labels that don't exist
      for (const [key, labelDef] of Object.entries(STANDARD_LABELS)) {
        const normalizedName = labelDef.name.toLowerCase();
        if (!this.labelCache.has(normalizedName)) {
          try {
            const labelId = await this.createLabel(labelDef.name, labelDef.color, labelDef.description);
            this.labelCache.set(normalizedName, labelId);
            log(`Created Linear label: ${labelDef.name}`);
          } catch (error) {
            // Label might already exist with different casing, try to find it
            logError(`Failed to create label ${labelDef.name}:`, error);
          }
        }
      }
      
      this.labelsInitialized = true;
      log(`Initialized ${this.labelCache.size} labels in Linear`);
    } catch (error) {
      logError("Failed to initialize labels:", error);
      // Continue without labels - not critical
    }
  }

  /**
   * Fetch existing labels from Linear for our team
   * Only fetches team-specific labels to avoid "incorrect team" errors
   */
  private async fetchExistingLabels(): Promise<void> {
    // If we have a team ID, fetch labels for that team specifically
    if (this.teamId) {
      const teamQuery = `
        query GetTeamLabels($teamId: String!) {
          team(id: $teamId) {
            labels {
              nodes {
                id
                name
              }
            }
          }
        }
      `;
      
      try {
        const response = await this.graphqlRequest<{
          team?: {
            labels?: {
              nodes?: Array<{
                id: string;
                name: string;
              }>;
            };
          };
        }>(teamQuery, { teamId: this.teamId });
        
        if (response.data?.team?.labels?.nodes) {
          for (const label of response.data.team.labels.nodes) {
            const normalizedName = label.name.toLowerCase();
            this.labelCache.set(normalizedName, label.id);
          }
          log(`Fetched ${response.data.team.labels.nodes.length} labels for team ${this.teamId}`);
        }
        return;
      } catch (error) {
        logError("Failed to fetch team labels, falling back to workspace labels:", error);
      }
    }

    // Fallback: fetch all workspace labels (may cause issues with team-specific labels)
    const query = `
      query GetLabels {
        issueLabels {
          nodes {
            id
            name
          }
        }
      }
    `;
    
    try {
      const response = await this.graphqlRequest<{
        issueLabels?: {
          nodes?: Array<{
            id: string;
            name: string;
          }>;
        };
      }>(query, {});
      
      if (response.data?.issueLabels?.nodes) {
        for (const label of response.data.issueLabels.nodes) {
          const normalizedName = label.name.toLowerCase();
          this.labelCache.set(normalizedName, label.id);
        }
        log(`Fetched ${response.data.issueLabels.nodes.length} existing labels from Linear`);
      }
    } catch (error) {
      logError("Failed to fetch existing labels:", error);
    }
  }

  /**
   * Create a new label in Linear
   */
  private async createLabel(name: string, color: string, description?: string): Promise<string> {
    const query = `
      mutation CreateLabel($input: IssueLabelCreateInput!) {
        issueLabelCreate(input: $input) {
          success
          issueLabel {
            id
            name
          }
        }
      }
    `;
    
    const variables = {
      input: {
        name,
        color,
        description,
        // Associate with team if we have one
        ...(this.teamId && { teamId: this.teamId }),
      },
    };
    
    const response = await this.graphqlRequest<{
      issueLabelCreate?: {
        success: boolean;
        issueLabel?: {
          id: string;
          name: string;
        };
      };
    }>(query, variables);
    
    if (!response.data?.issueLabelCreate?.success || !response.data.issueLabelCreate.issueLabel) {
      throw new Error(`Failed to create label: ${JSON.stringify(response.errors)}`);
    }
    
    return response.data.issueLabelCreate.issueLabel.id;
  }

  /**
   * Get or create a label by name
   * Returns the label ID
   */
  async getOrCreateLabel(name: string, color?: string, description?: string): Promise<string | null> {
    const normalizedName = name.toLowerCase();
    
    // Check cache first
    if (this.labelCache.has(normalizedName)) {
      return this.labelCache.get(normalizedName)!;
    }
    
    // Check if it's a standard label
    const standardLabel = Object.values(STANDARD_LABELS).find(
      l => l.name.toLowerCase() === normalizedName
    );
    
    try {
      const labelId = await this.createLabel(
        name,
        color || standardLabel?.color || "#6B7280", // Default gray
        description || standardLabel?.description
      );
      this.labelCache.set(normalizedName, labelId);
      return labelId;
    } catch (error) {
      logError(`Failed to create label ${name}:`, error);
      return null;
    }
  }

  /**
   * Map label names to Linear label IDs
   * Creates labels if they don't exist
   * Returns unique label IDs (no duplicates)
   */
  private mapLabels(labels: string[]): string[] {
    const labelIdSet = new Set<string>();
    
    for (const label of labels) {
      const normalizedName = label.toLowerCase();
      const labelId = this.labelCache.get(normalizedName);
      if (labelId) {
        labelIdSet.add(labelId);
      }
    }
    
    return Array.from(labelIdSet);
  }

  /**
   * Map labels asynchronously - creates missing labels
   * Use this when you need to ensure labels exist
   * Returns unique label IDs (no duplicates)
   */
  async mapLabelsAsync(labels: string[]): Promise<string[]> {
    const labelIdSet = new Set<string>();
    
    for (const label of labels) {
      const normalizedName = label.toLowerCase();
      let labelId = this.labelCache.get(normalizedName);
      
      if (!labelId) {
        // Try to create it
        labelId = await this.getOrCreateLabel(label) || undefined;
      }
      
      if (labelId) {
        labelIdSet.add(labelId);
      }
    }
    
    return Array.from(labelIdSet);
  }
}

