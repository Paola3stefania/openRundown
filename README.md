# Discord MCP Server

This MCP server allows you to read messages from Discord servers and classify them against GitHub issues using the Model Context Protocol.

## Project Structure

```
discord-mcp/
├── src/                    # Source code
│   ├── index.ts           # MCP server entry point
│   ├── github-integration.ts  # GitHub API integration
│   └── issue-classifier.ts    # Issue classification logic
├── scripts/                # Utility scripts
│   ├── classify-discord-issues.ts  # Main classification script
│   ├── fetch-all-issues.ts        # Fetch and cache GitHub issues
│   ├── list-servers.ts
│   ├── list-channels.ts
│   └── ...
├── docs/                   # Documentation
├── results/                # Output files (gitignored)
│   └── github-issues-cache.json  # Cached GitHub issues
├── dist/                   # Compiled output
└── package.json
```

## Setup

1. Install dependencies:
   ```bash
   npm install
   ```

2. Build the project:
   ```bash
   npm run build
   ```

3. Configure environment variables (see `CONFIG.md` for details):
   - `DISCORD_TOKEN`: Your Discord bot token (required)
   - `GITHUB_TOKEN`: Your GitHub personal access token (optional but recommended)
  - `GITHUB_OWNER`: GitHub organization/username (required)
  - `GITHUB_REPO`: GitHub repository name (required)
   - `DISCORD_SERVER_ID`: Your Discord server ID (optional)
   - `DISCORD_DEFAULT_CHANNEL_ID`: Default channel ID (optional)

   Create a `.env` file or export these variables in your shell.

4. The server is configured in `cursor-mcp-config.json` (or `~/.cursor/mcp.json`)

## Usage

### Fetching GitHub Issues

**Initial Fetch:**
Fetch and cache all GitHub issues (both open and closed):

```bash
npm run fetch-issues
```

This creates `cache/github-issues-cache.json` with all issues from the configured repository.

**Incremental Updates (Recommended for Daily/Weekly Updates):**
To update the cache with only new or updated issues since the last fetch:

```bash
npm run fetch-issues-incremental
```

Or use the flag:
```bash
npm run fetch-issues --incremental
```

This will:
- Find the most recently updated issue in your cache
- Only fetch issues updated since that date
- Merge new/updated issues with existing cache
- Much faster than re-fetching all issues!

### Classifying Discord Messages

Classify Discord messages against GitHub issues:

```bash
npm run classify-issues <channel_id> [limit] [minSimilarity] [output_file]
```

Example:
```bash
npm run classify-issues [channel_id] 30 20
```

Parameters:
- `channel_id`: Discord channel ID (required)
- `limit`: Number of messages to analyze (default: 30)
- `minSimilarity`: Minimum similarity score threshold (default: 20)
- `output_file`: Optional output file path (default: auto-generated in `results/`)

### Other Scripts

- `npm run list-servers` - List all Discord servers
- `npm run list-channels` - List channels in a server
- `npm run read-messages` - Read messages from a channel
- `npm run check-permissions` - Check bot permissions in a channel
- `npm run search-combined` - Search both Discord and GitHub

## MCP Tools

Once connected in Cursor, you can use these MCP tools:

### 1. List Servers
```json
{
  "tool": "list_servers"
}
```

### 2. List Channels
```json
{
  "tool": "list_channels",
  "server_id": "YOUR_SERVER_ID"
}
```

### 3. Read Messages
```json
{
  "tool": "read_messages",
  "channel_id": "YOUR_CHANNEL_ID",
  "limit": 50
}
```

### 4. Search Messages
```json
{
  "tool": "search_messages",
  "channel_id": "YOUR_CHANNEL_ID",
  "query": "search text",
  "limit": 100
}
```

### 5. Search GitHub Issues
```json
{
  "tool": "search_github_issues",
  "query": "stripe plugin"
}
```

### 6. Classify Discord Messages
```json
{
  "tool": "classify_discord_messages",
  "channel_id": "YOUR_CHANNEL_ID",
  "limit": 30,
  "min_similarity": 20
}
```

## Classification Algorithm

The classification uses a weighted similarity algorithm that considers:

1. **Phrase Matching**: Multi-word phrases (2-3 words) get the highest weight
2. **Exact Word Matches**: Technical terms get bonus points
3. **Partial Matches**: Similar words get lower scores
4. **Title Boost**: Matches in issue titles are weighted higher
5. **Technical Terms**: Special weighting for auth/security-related terms

## Restart Cursor

After configuration changes, **restart Cursor** for the MCP server to connect. The server will automatically connect when Cursor starts.

## Troubleshooting

- **Server not connecting**: Make sure Cursor has been restarted after configuration
- **Bot not in server**: The Discord bot must be invited to the server you want to read from
- **No messages**: Make sure the bot has "Read Message History" permission in the channel
- **Connection errors**: Check that your Discord bot token is valid and the bot is online
- **GitHub rate limits**: Use a GitHub token to increase rate limits (5000/hour vs 60/hour)

## Security Note

WARNING: Your Discord and GitHub tokens are stored in configuration files. Make sure these files are in your `.gitignore` if you're using git!

## Documentation

See the `docs/` folder for additional documentation:
- `GITHUB_INTEGRATION.md` - GitHub API integration details
- `CLASSIFICATION_EXPLAINED.md` - Classification algorithm details
- `explain-permissions.md` - Discord permissions guide
- `RATE_LIMIT_INFO.md` - Rate limiting information
