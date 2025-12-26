# UNMute

UNMute is an MCP server that integrates communication platforms (Discord, GitHub, and more) to help manage projects by classifying conversations, correlating discussions with issues, and exporting insights to project management tools.

## Current Integrations

- **Discord**: Read messages, classify conversations, detect threads
- **GitHub**: Search issues, correlate with Discord discussions
- **PM Tools**: Export classified data to Linear, Jira (via documentation-based feature extraction)

## Planned Integrations

- **Slack**: Message classification and issue correlation
- **Additional platforms**: Coming soon

## Features

### Discord Integration

- Read messages from Discord channels
- Organize messages by threads
- Classify messages using keyword-based or semantic (LLM) matching
- Incremental message fetching with caching

### GitHub Integration

- Search repository issues
- Correlate Discord discussions with GitHub issues
- Cache issues for offline analysis
- Incremental issue updates

### Classification

- **Keyword-based**: Fast, free classification using keyword matching
- **Semantic (LLM-based)**: Context-aware classification using OpenAI embeddings
- Thread-aware classification
- Classification history tracking

### PM Tool Export

- Extract product features from documentation (URLs or local files)
- Map conversations to features using semantic similarity
- Export to Linear, Jira, and other PM tools
- Automatic documentation crawling for comprehensive feature extraction

## Setup

1. Install dependencies:
   ```bash
   npm install
   ```

2. Build the project:
   ```bash
   npm run build
   ```

3. Configure environment variables (see `env.example`):
   - `DISCORD_TOKEN`: Discord bot token (required)
   - `GITHUB_TOKEN`: GitHub personal access token (optional, recommended)
   - `GITHUB_OWNER`: GitHub organization/username (required)
   - `GITHUB_REPO`: GitHub repository name (required)
   - `OPENAI_API_KEY`: OpenAI API key (optional, for semantic classification)
   - `DOCUMENTATION_URLS`: URLs or file paths to product documentation (optional, for PM export)
   - `PM_TOOL_*`: PM tool configuration (optional, for PM export)

   Create a `.env` file or export these variables.

4. Configure MCP server in `cursor-mcp-config.json` (or `~/.cursor/mcp.json`)

## Usage

### Fetching GitHub Issues

**Initial Fetch:**
```bash
npm run fetch-issues
```

Creates `cache/github-issues-cache.json` with all issues.

**Incremental Updates:**
```bash
npm run fetch-issues -- --incremental
```

Fetches only new or updated issues since last fetch.

### Classifying Discord Messages

```bash
npm run classify-issues <channel_id> [limit] [minSimilarity]
```

Example:
```bash
npm run classify-issues [channel_id] 30 20
```

Parameters:
- `channel_id`: Discord channel ID (required)
- `limit`: Number of messages to analyze (default: 30)
- `minSimilarity`: Minimum similarity score threshold (default: 20)

### Automated Workflow

Use the `sync_and_classify` MCP tool to:
1. Sync Discord messages (incremental)
2. Sync GitHub issues (incremental)
3. Classify messages with issues

### PM Tool Export

Use the `export_to_pm_tool` MCP tool to:
1. Extract features from documentation
2. Map conversations to features
3. Export to Linear, Jira, or other PM tools

Configure `DOCUMENTATION_URLS` in `.env` (can be URLs like `https://docs.example.com/docs` which will be crawled, or local file paths).

## MCP Tools

Available tools via Model Context Protocol:

- `list_servers`: List Discord servers
- `list_channels`: List channels in a server
- `read_messages`: Read messages from a channel
- `search_messages`: Search messages in a channel
- `search_github_issues`: Search GitHub issues
- `search_discord_and_github`: Search both Discord and GitHub
- `fetch_github_issues`: Fetch and cache GitHub issues
- `fetch_discord_messages`: Fetch and cache Discord messages
- `classify_discord_messages`: Classify messages with GitHub issues
- `sync_and_classify`: Automated sync and classification workflow
- `export_to_pm_tool`: Export to PM tools (Linear, Jira)

## Project Structure

```
unmute/
├── src/                    # Source code
│   ├── index.ts           # MCP server entry point
│   ├── github-integration.ts
│   ├── discord-cache.ts
│   ├── issue-classifier.ts
│   ├── semantic-classifier.ts
│   └── pm-integration/    # PM tool export system
├── docs/                   # Documentation
├── cache/                  # Cached data (gitignored)
├── discord/                # Discord message cache (gitignored)
├── results/                # Classification results (gitignored)
├── dist/                   # Compiled output
└── package.json
```

## Documentation

See the `docs/` folder for detailed documentation:
- `GITHUB_INTEGRATION.md`: GitHub API integration
- `CLASSIFICATION_EXPLAINED.md`: Classification process
- `SEMANTIC_CLASSIFICATION.md`: LLM-based semantic classification
- `THREAD_DETECTION.md`: Discord thread handling
- `RATE_LIMIT_INFO.md`: GitHub API rate limits
- `explain-permissions.md`: Discord bot permissions

