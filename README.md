# UNMute

UNMute is an MCP server that integrates communication platforms (Discord, GitHub, and more) to help manage projects by classifying conversations, correlating discussions with issues, and exporting insights to project management tools.

## Current Integrations

- **Discord**: Read messages, classify conversations, detect threads
- **GitHub**: Search issues, correlate with Discord discussions
- **PM Tools**: Export classified data to Linear, Jira (via documentation-based feature extraction)

## Planned Integrations

- **Slack**: Message classification and issue correlation
- **Additional platforms**: Coming soon

## Non-Goals

UNMute intentionally does **not**:

- **Auto-close issues** — Linear owns the issue lifecycle. UNMute surfaces and groups signals, but closing happens via PR merge (Linear's native GitHub integration)
- **Infer PR fixes** — We don't guess which PR fixes which issue. Engineers explicitly reference Linear issue IDs (`LIN-123`) in PRs
- **Auto-merge duplicates** — Grouping is suggestive, not automatic. Humans confirm merges
- **Replace your PM tool** — UNMute feeds data into Linear/Jira; it doesn't replace them

See [docs/LINEAR_GITHUB_CONTRACT.md](docs/LINEAR_GITHUB_CONTRACT.md) for the full contract.

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

### Semantic Grouping

- **Hybrid grouping**: Group related signals by semantic similarity, then map to features
- **Cross-cutting detection**: Identify issues affecting multiple product features
- **Shared embedding cache**: Embeddings computed once, reused by classification and grouping
- **Feature mapping**: Map groups to product features extracted from documentation

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

### Grouping Related Threads

Use the `suggest_grouping` MCP tool to group Discord threads by their matched GitHub issues:

**Workflow:**
1. Checks for existing 1-to-1 classification results
2. If not found, runs `classify_discord_messages` first
3. Groups threads by their matched GitHub issues (threads matching the same issue → same group)
4. Outputs groups with issue metadata

```
suggest_grouping → results/grouping-{channelId}-{timestamp}.json
```

**Options:**
- `min_similarity`: Minimum score for issue matching (0-100, default 60)
- `max_groups`: Maximum groups to return (default 50)
- `re_classify`: Force re-classification before grouping
- `semantic_only`: Use pure semantic similarity instead of issue-based grouping

**Output (issue-based grouping):**
```json
{
  "grouping_method": "issue-based",
  "groups": [{
    "id": "issue-4555",
    "github_issue": {
      "number": 4555,
      "title": "ElysiaJS session not working",
      "state": "open",
      "labels": ["bug", "elysia"]
    },
    "thread_count": 3,
    "threads": [
      { "thread_id": "...", "similarity_score": 81.5 },
      { "thread_id": "...", "similarity_score": 79.2 }
    ]
  }]
}
```

**Why issue-based?**
- More accurate: Groups are anchored to real GitHub issues
- Reuses classification: No extra embeddings needed
- Action-ready: Each group links to an existing issue

### PM Tool Export

Use the `export_to_pm_tool` MCP tool to:
1. Extract features from documentation
2. Map conversations to features
3. Export to Linear, Jira, or other PM tools

Configure `DOCUMENTATION_URLS` in `.env` (can be URLs like `https://docs.example.com/docs` which will be crawled, or local file paths).

## MCP Tools (Stable API)

These tool names are **stable** and will not change. Semantics may evolve, but names are fixed. New tools are additive only.

### Core Workflow Tools

| Tool | Description |
|------|-------------|
| `sync_and_classify` | Full workflow: sync messages, sync issues, classify |
| `classify_discord_messages` | Classify messages with GitHub issues (auto-syncs first) |
| `suggest_grouping` | Group threads by matched issues (runs classification if needed) |
| `export_to_pm_tool` | Export classified data to Linear, Jira |

### Data Fetching Tools

| Tool | Description |
|------|-------------|
| `fetch_discord_messages` | Fetch and cache Discord messages (incremental) |
| `fetch_github_issues` | Fetch and cache GitHub issues (incremental) |

### Discovery Tools

| Tool | Description |
|------|-------------|
| `list_servers` | List Discord servers the bot can access |
| `list_channels` | List channels in a Discord server |
| `read_messages` | Read messages from a channel |
| `search_messages` | Search messages in a channel |
| `search_github_issues` | Search GitHub issues |
| `search_discord_and_github` | Search both Discord and GitHub |

### PM Tool Management

| Tool | Description |
|------|-------------|
| `list_linear_teams` | List Linear teams (for configuration) |
| `validate_pm_setup` | Validate PM tool configuration |

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

### Contracts & Architecture
- `LINEAR_GITHUB_CONTRACT.md`: How UNMute integrates with Linear's GitHub integration
- `LINEAR_TEAM_SETUP.md`: Setting up Linear teams and projects

### Features
- `CLASSIFICATION_EXPLAINED.md`: Classification process
- `SEMANTIC_CLASSIFICATION.md`: LLM-based semantic classification
- `THREAD_DETECTION.md`: Discord thread handling

### Integration Guides
- `GITHUB_INTEGRATION.md`: GitHub API integration
- `RATE_LIMIT_INFO.md`: GitHub API rate limits
- `explain-permissions.md`: Discord bot permissions
- `TESTING_LINEAR_EXPORT.md`: Testing the Linear export workflow

## License

MIT License - see [LICENSE](LICENSE) for details.
