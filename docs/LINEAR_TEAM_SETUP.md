# Linear Team Setup

How to configure and use Linear teams with UNMute.

## Overview

Linear teams organize issues within a workspace. When exporting to Linear, you can optionally associate projects and issues with a specific team.

## Configuration

### Environment Variable

Set `PM_TOOL_TEAM_ID` in your `.env` file (optional):

```
PM_TOOL_TEAM_ID=your-linear-team-id
```

The team ID can be:
- **Team UUID**: The full Linear team ID (recommended for API usage)
- **Team Key**: The team's short key/identifier (e.g., "ENG", "PROD")

### Auto-Creation

**If `PM_TOOL_TEAM_ID` is not set:**
- The system will automatically create a team named "UNMute" on first export
- The team will be created with key "UNMUTE"
- This ensures projects and issues are properly organized even without manual configuration

### Finding Your Team ID

**Option 1: Use Linear API**

You can list all teams using Linear's GraphQL API:

```graphql
query GetTeams {
  teams {
    nodes {
      id
      name
      key
    }
  }
}
```

**Option 2: From Linear UI**

1. Go to Linear Settings → Teams
2. Click on your team
3. The team ID can be found in the URL or team settings

**Option 3: Use UNMute's Team Listing** (if implemented)

The Linear integration can list teams programmatically. Check the implementation for available methods.

## Team Usage

### With Team ID Configured

When `PM_TOOL_TEAM_ID` is set:
- Projects are created and associated with the specified team
- Issues are created in the specified team
- Team validation occurs during export

### Without Team ID

If `PM_TOOL_TEAM_ID` is not set:
- Projects are created without team association (workspace-level)
- Issues are created without team association
- You may need to manually assign them to teams in Linear UI

## Best Practices

1. **Use Team UUID**: More reliable than team key for API operations
2. **Validate Team**: The system validates the team ID exists during export
3. **Consistent Team**: Use the same team for all exports from the same project/workspace

## Error Handling

If an invalid team ID is configured:
- A warning is logged during export
- Projects and issues are still created (without team association)
- Check Linear workspace permissions if team validation fails

