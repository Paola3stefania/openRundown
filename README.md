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

- **Keyword-based**: Fast, free classification using keyword matching (default when OpenAI not configured)
- **Semantic (LLM-based)**: Context-aware classification using OpenAI embeddings (enabled by default when `OPENAI_API_KEY` is set)
- **Persistent embedding cache**: Issue embeddings are cached to disk, avoiding redundant API calls
- Thread-aware classification
- Classification history tracking
- Automatically syncs issues and messages before classifying

### PM Tool Export

- Extract product features from documentation (URLs or local files)
- Map conversations to features using semantic similarity
- Export to Linear, Jira, and other PM tools
- Automatic documentation crawling for comprehensive feature extraction
- Export results saved to `results/` for tracking history

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

The `classify_discord_messages` MCP tool automatically:
1. Fetches/syncs GitHub issues (incremental)
2. Fetches/syncs Discord messages (incremental)
3. Classifies messages with issues

You can also fetch separately:
- `fetch_github_issues`: Fetch and cache GitHub issues
- `fetch_discord_messages`: Fetch and cache Discord messages

**Note:** Classification requires cached issues. The classification tool will automatically fetch them if needed.

### Automated Workflow

The `classify_discord_messages` tool automatically syncs before classifying.

Alternatively, use `sync_and_classify` MCP tool which provides a unified workflow:
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
- `classify_discord_messages`: Classify messages with GitHub issues (automatically syncs issues and messages first)
- `sync_and_classify`: Automated sync and classification workflow
- `export_to_pm_tool`: Export to PM tools (Linear, Jira)

## Project Structure

```
unmute-mcp/
├── src/
│   ├── mcp/               # MCP server and tool handlers
│   │   ├── server.ts      # Main MCP server entry point
│   │   └── logger.ts
│   ├── connectors/        # External service connectors
│   │   ├── github/
│   │   │   └── client.ts
│   │   └── discord/       # (planned)
│   ├── core/              # Core business logic
│   │   └── classify/      # Classification engine
│   │       ├── classifier.ts
│   │       └── semantic.ts
│   ├── storage/           # Data persistence
│   │   └── cache/         # Caching layer
│   │       ├── discordCache.ts
│   │       └── classificationHistory.ts
│   ├── export/            # PM tool export system
│   │   ├── linear/
│   │   ├── jira/
│   │   ├── workflow.ts
│   │   └── ...
│   ├── types/             # Type definitions
│   │   └── signal.ts      # Normalized Signal type
│   ├── config/            # Configuration
│   │   └── index.ts
│   └── index.ts           # Entry point (re-exports mcp/server)
├── scripts/               # CLI utilities
├── docs/                  # Documentation
├── cache/                 # All cached data (gitignored)
│   ├── github-issues-cache.json      # GitHub issues
│   ├── issue-embeddings-cache.json   # LLM embeddings (persistent)
│   └── discord-messages-*.json       # Discord messages
├── results/               # Output files (gitignored)
│   ├── discord-classified-*.json     # Classification results
│   ├── classification-history.json   # Classification tracking
│   └── export-*.json                 # PM export history
├── dist/                  # Compiled output
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

## License

MIT License - see [LICENSE](LICENSE) for details.
