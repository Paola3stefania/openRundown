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

### Classification
- `OPENAI_API_KEY` - OpenAI API key for semantic classification (enabled by default when set)
- `USE_SEMANTIC_CLASSIFICATION` - Set to "false" to disable semantic classification even when API key is set (default: enabled if API key is set)
- `OPENAI_EMBEDDING_MODEL` - OpenAI embedding model to use (default: "text-embedding-3-small")
  - `text-embedding-3-small` - Fast, cost-effective, 1536 dimensions (default, recommended)
  - `text-embedding-3-large` - Higher quality, more expensive, 3072 dimensions
  - `text-embedding-ada-002` - Legacy model, 1536 dimensions
  - **Note:** Changing the model will invalidate existing embedding caches (they'll be regenerated)

### Discord Channel Names
These help scripts find channels by name:
- `DISCORD_CHANNEL_DEVELOPMENT` - Development channel name (default: "development")
- `DISCORD_CHANNEL_GENERAL` - General channel name (default: "general")
- `DISCORD_CHANNEL_CHAT` - Chat channel name (default: "chat")

### Storage Backend
- `STORAGE_BACKEND` - Storage backend to use (default: "auto")
  - `"auto"` - Auto-detect: use PostgreSQL if `DATABASE_URL` is set, otherwise JSON (default)
  - `"database"` - Always use PostgreSQL (will fail if not configured)
  - `"json"` - Always use JSON files (useful for testing/development)
  
**Default behavior:** If `DATABASE_URL` is set → PostgreSQL, otherwise → JSON files

### Database Configuration (for PostgreSQL backend)
- `DATABASE_URL` - PostgreSQL connection string (e.g., `postgresql://user:password@localhost:5432/openrundown`)
- OR use individual variables:
  - `DB_HOST` - Database host (default: "localhost")
  - `DB_PORT` - Database port (default: 5432)
  - `DB_NAME` - Database name
  - `DB_USER` - Database user
  - `DB_PASSWORD` - Database password

### File Paths (for JSON backend)
- `CACHE_DIR` - Directory for all cache files (default: "cache")
- `RESULTS_DIR` - Directory for output files (default: "results")
- `ISSUES_CACHE_FILE` - Name of the issues cache file (default: "github-issues-cache.json")

### Cache Files (stored in `CACHE_DIR`)
- `github-issues-cache.json` - Cached GitHub issues
- `issue-embeddings-cache.json` - Persistent LLM embeddings for issues
- `discord-messages-{channelId}.json` - Cached Discord messages per channel

### Results Files (stored in `RESULTS_DIR`)
- `discord-classified-{channelId}.json` - Classification results
- `classification-history.json` - Tracks which messages have been classified
- `export-{pmTool}-{timestamp}.json` - PM tool export history

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

# Classification (Optional)
OPENAI_API_KEY=your_openai_api_key_here
# OPENAI_EMBEDDING_MODEL=text-embedding-3-small  # Optional: change embedding model

# Storage Backend (Optional)
# Default: Auto-detect (PostgreSQL if DATABASE_URL set, otherwise JSON)
# For testing: STORAGE_BACKEND=json
# STORAGE_BACKEND=auto

# Database Configuration (for PostgreSQL)
# If DATABASE_URL is set, PostgreSQL will be used automatically
# Otherwise, JSON files will be used
DATABASE_URL=postgresql://user:password@localhost:5432/openrundown
# OR use individual variables:
# DB_HOST=localhost
# DB_PORT=5432
# DB_NAME=openrundown
# DB_USER=your_user
# DB_PASSWORD=your_password
# USE_SEMANTIC_CLASSIFICATION=false  # Uncomment to disable semantic classification
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

3. The `classify_discord_messages` MCP tool will automatically fetch issues and messages before classifying. You can also fetch manually:
   ```bash
   npm run fetch-issues
   ```

4. Classify Discord messages (automatically syncs issues and messages first):
   - Use the `classify_discord_messages` MCP tool
   - Or use `sync_and_classify` for the full workflow

## Configuration Priority

Configuration values are loaded in this order:
1. Environment variables (highest priority)
2. Default values (fallback)

The config is loaded at runtime, so you can override defaults without modifying code.


