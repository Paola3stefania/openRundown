# GitHub Integration for Discord MCP

## Overview

The Discord MCP server includes GitHub integration to search repository issues and correlate them with Discord discussions.

## New Tools

### 1. `search_github_issues`

Search GitHub issues in the configured repository (set via GITHUB_OWNER and GITHUB_REPO environment variables).

**Parameters:**
- `query` (required): Search query (e.g., "bug", "stripe plugin", "password reset")
- `state` (optional): Filter by state - "open", "closed", or "all" (default: "all")

**Example:**
```json
{
  "query": "stripe plugin",
  "state": "open"
}
```

**Returns:**
- Total count of matching issues
- List of issues with:
  - Issue number and title
  - State (open/closed)
  - URL
  - Author
  - Creation and update dates
  - Labels
  - Body preview

### 2. `search_discord_and_github`

Search both Discord messages and GitHub issues for a topic, allowing you to see related discussions and issues together.

**Parameters:**
- `query` (required): Search query to search in both Discord and GitHub
- `channel_id` (required): Discord channel ID to search in
- `discord_limit` (optional): Number of Discord messages to search (1-100, default: 50)
- `github_state` (optional): GitHub issue state filter - "open", "closed", or "all" (default: "all")

**Example:**
```json
{
  "query": "password reset",
  "channel_id": "1288403910284935182",
  "discord_limit": 30,
  "github_state": "open"
}
```

**Returns:**
- Discord search results (messages matching the query)
- GitHub search results (issues matching the query)
- Combined view of both sources

## Configuration

### Optional: GitHub Token

For higher rate limits (5000 requests/hour instead of 60), you can add a GitHub personal access token:

1. Create a GitHub personal access token at: https://github.com/settings/tokens
2. Add it to your environment variables:
   ```bash
   export GITHUB_TOKEN=your_token_here
   ```
3. Or add it to your `cursor-mcp-config.json`:
   ```json
   {
     "mcpServers": {
       "discord": {
         "command": "/Users/user/Projects/discord-mcp/run-mcp.sh",
         "env": {
           "DISCORD_TOKEN": "...",
           "GITHUB_TOKEN": "your_token_here"
         }
       }
     }
   }
   ```

**Note:** The GitHub API works without a token, but rate limits are lower (60 requests/hour). With a token, you get 5000 requests/hour.

## Usage Examples

### Search for Stripe Plugin Issues
```
search_github_issues: {
  "query": "stripe plugin",
  "state": "open"
}
```

### Search Both Discord and GitHub for Bug Reports
```
search_discord_and_github: {
  "query": "password reset error",
  "channel_id": "1288403910284935182",
  "github_state": "open"
}
```

### Find Related Discussions
```
search_discord_and_github: {
  "query": "email verification",
  "channel_id": "1296058482289676320",  // #development channel
  "discord_limit": 100
}
```

## Benefits

1. **Correlate Issues**: Find related GitHub issues when discussing problems in Discord
2. **Track Discussions**: See both Discord discussions and GitHub issues for a topic
3. **Better Context**: Understand if an issue is already reported or being discussed
4. **Link Discussions**: Get direct links to both Discord messages and GitHub issues


