# Configuration Guide

This tool is configurable via environment variables. Create a `.env` file in the project root or set environment variables in your shell.

## Required Configuration

### Discord
- `DISCORD_TOKEN` - Your Discord bot token (required)
- `DISCORD_SERVER_ID` - Your Discord server/guild ID (optional, can be passed as argument)
- `DISCORD_DEFAULT_CHANNEL_ID` - Default channel ID for scripts (optional)

### GitHub
- `GITHUB_TOKEN` - GitHub personal access token (optional but recommended for higher rate limits)
- `GITHUB_OWNER` - GitHub organization or username (required)
- `GITHUB_REPO` - GitHub repository name (required)

## Optional Configuration

### Discord Channel Names
These help scripts find channels by name:
- `DISCORD_CHANNEL_DEVELOPMENT` - Development channel name (default: "development")
- `DISCORD_CHANNEL_GENERAL` - General channel name (default: "general")
- `DISCORD_CHANNEL_CHAT` - Chat channel name (default: "chat")

### File Paths
- `RESULTS_DIR` - Directory for output files (default: "results")
- `ISSUES_CACHE_FILE` - Name of the issues cache file (default: "github-issues-cache.json")

## Example .env File

```env
# Discord Configuration
DISCORD_TOKEN=your_discord_bot_token_here
DISCORD_SERVER_ID=your_discord_server_id
DISCORD_DEFAULT_CHANNEL_ID=your_default_channel_id

# GitHub Configuration
GITHUB_TOKEN=your_github_personal_access_token_here
GITHUB_OWNER=your-org
GITHUB_REPO=your-repo
```

## Using Different Repositories

To use this tool with a different GitHub repository:

1. Set environment variables:
   ```bash
   export GITHUB_OWNER=your-organization
   export GITHUB_REPO=your-repository
   ```

2. Or create a `.env` file:
   ```env
   GITHUB_OWNER=your-organization
   GITHUB_REPO=your-repository
   ```

3. Fetch issues for your repository:
   ```bash
   npm run fetch-issues
   ```

4. Classify Discord messages:
   ```bash
   npm run classify-issues <channel_id> 50
   ```

## Configuration Priority

Configuration values are loaded in this order:
1. Environment variables (highest priority)
2. Default values (fallback)

The config is loaded at runtime, so you can override defaults without modifying code.


