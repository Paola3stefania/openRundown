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

- **Auto-close issues** - Linear owns the issue lifecycle. UNMute surfaces and groups signals, but closing happens via PR merge (Linear's native GitHub integration)
- **Infer PR fixes** - We don't guess which PR fixes which issue. Engineers explicitly reference Linear issue IDs (`LIN-123`) in PRs
- **Auto-merge duplicates** - Grouping is suggestive, not automatic. Humans confirm merges
- **Replace your PM tool** - UNMute feeds data into Linear/Jira; it doesn't replace them

See [docs/LINEAR_GITHUB_CONTRACT.md](docs/LINEAR_GITHUB_CONTRACT.md) for the full contract.

## Features

### Discord Integration

- Read messages from Discord channels
- Organize messages by threads
- Classify messages using keyword-based or semantic (LLM) matching
- Incremental message fetching with caching

### GitHub Integration

- Fetch repository issues and comments (with retry mechanism)
- Correlate Discord discussions with GitHub issues
- Cache issues for offline analysis
- Incremental issue updates

### Classification

- **Keyword-based**: Fast, free classification using keyword matching (default when OpenAI not configured)
- **Semantic (LLM-based)**: Context-aware classification using OpenAI embeddings (enabled by default when `OPENAI_API_KEY` is set)
- **Persistent embedding cache with lazy loading**: All embeddings (issues, threads, groups, code sections, features) are cached to database/disk and only recomputed when content changes (contentHash validation)
- Thread-aware classification
- Classification history tracking
- Automatically syncs issues and messages before classifying

**Similarity Scales:**

UNMute uses **two different similarity scales** depending on the operation:

1. **Issue Matching (Classification)** - **0-100 scale** (percentage-based)
   - `80-100`: **Strong match** - Thread is very likely related to this issue
   - `60-79`: **Moderate match** - Thread may be related, worth reviewing
   - `40-59`: **Weak match** - Possibly related, but needs verification
   - `0-39`: **Unlikely match** - Probably unrelated
   - **Default threshold: `60`** - Only matches >= 60 are considered for grouping
   - **Recommended tiers:**
     - `min_similarity: 80` - High confidence only (fewer false positives)
     - `min_similarity: 60` - Balanced (default, good precision/recall)
     - `min_similarity: 40` - More inclusive (may include false positives)

2. **Feature Matching (Group-to-Feature)** - **0.0-1.0 scale** (cosine similarity)
   - `0.7-1.0`: **Strong feature match** - Group clearly relates to this feature
   - `0.5-0.7`: **Moderate feature match** - Group may relate to this feature
   - `0.0-0.5`: **Weak feature match** - Unlikely to relate
   - **Default threshold: `0.5`** - Only matches >= 0.5 are considered
   - **Recommended tiers:**
     - `min_similarity: 0.7` - High confidence only
     - `min_similarity: 0.5` - Balanced (default)
     - `min_similarity: 0.3` - More inclusive

### Two Workflow Approaches

UNMute supports two approaches for organizing and exporting data:

#### Issue-Centric Workflow (Recommended)

GitHub issues are the primary entity. Discord threads are attached as context.

```
fetch_github_issues -> group_github_issues -> match_issues_to_features -> label_github_issues -> export_to_pm_tool
                                                                                                        |
                                           match_issues_to_threads (optional) ---------------------------+
```

- **Best for**: Teams that primarily track work via GitHub issues
- **Output**: 1 GitHub issue group = 1 Linear issue (with Discord context attached)

#### Thread-Centric Workflow

Discord threads are the primary entity. GitHub issues are used for grouping.

```
sync_and_classify -> suggest_grouping -> match_groups_to_features -> export_to_pm_tool
```

- **Best for**: Teams where Discord is the primary source of feedback
- **Output**: Discord thread groups = Linear issues

### Semantic Grouping

- **Issue-based grouping**: Group threads by their matched GitHub issues (fast, no LLM calls)
- **Feature matching**: Map groups to product features using three-tier matching:
  - **Rule-based matching**: Keyword/name matching (highest priority, works without embeddings)
  - **Semantic similarity**: Cosine similarity between embeddings (when embeddings available)
  - **Code-based matching**: Function-level code matching using saved code section embeddings
- **Cross-cutting detection**: Identify issues affecting multiple product features
- **Graceful degradation**: If embedding computation fails, still attempts rule-based and code-based matching

### PM Tool Export

- Extract product features from documentation (URLs or local file paths)
- Map conversations to features using semantic similarity
- Export to Linear, Jira, and other PM tools
- Export results saved to `results/` for tracking history

### Storage Backends

UNMute supports two storage backends:

- **JSON Files (Default)**: Simple file-based storage, perfect for testing and small datasets
  - No setup required
  - Data stored in `cache/` and `results/` directories
  - Works out of the box

- **PostgreSQL (Optional)**: Production-ready database storage
  - Better performance for large datasets
  - SQL queries for advanced analysis
  - Concurrent access support
  - Auto-detected when `DATABASE_URL` is set
  - **Required when configured**: When `DATABASE_URL` is set, all data is saved to PostgreSQL (no fallback to JSON)
  - See [docs/DATABASE_SETUP.md](docs/DATABASE_SETUP.md) for setup

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
   - `GITHUB_OWNER`: GitHub organization/username (required)
   - `GITHUB_REPO`: GitHub repository name (required)
   - **GitHub Authentication** (choose one):
     - `GITHUB_TOKEN`: Personal access token (get from https://github.com/settings/tokens)
     - OR GitHub App: `GITHUB_APP_ID`, `GITHUB_APP_INSTALLATION_ID`, `GITHUB_APP_PRIVATE_KEY_PATH` (see [docs/GITHUB_INTEGRATION.md](docs/GITHUB_INTEGRATION.md))
   - `OPENAI_API_KEY`: OpenAI API key (optional, for semantic classification)
   - `DOCUMENTATION_URLS`: URLs or file paths to product documentation (optional, for PM export)
   - `PM_TOOL_*`: PM tool configuration (optional, for PM export)

4. **(Optional) Set up PostgreSQL database:**
   
   ```bash
   # Create database
   createdb unmute_mcp
   
   # Set DATABASE_URL in .env
   DATABASE_URL=postgresql://user:password@localhost:5432/unmute_mcp
   
   # Run migrations
   npx prisma migrate deploy
   ```
   
   See [docs/DATABASE_SETUP.md](docs/DATABASE_SETUP.md) for detailed setup instructions.

5. Configure MCP server in `cursor-mcp-config.json` (or `~/.cursor/mcp.json`)

## MCP Tools

These tool names are **stable** and will not change. Semantics may evolve, but names are fixed.

### Primary Entry Points

| Tool | Description |
|------|-------------|
| `sync_and_classify` | **Thread-centric entry point** - Sync messages, sync issues, classify |
| `export_to_pm_tool` | **Issue-centric entry point** - Export GitHub issues to Linear/Jira with Discord context |

### Issue-Centric Workflow Tools

| Tool | Description |
|------|-------------|
| `group_github_issues` | Group related GitHub issues together (1 group = 1 Linear issue) |
| `match_issues_to_features` | Match GitHub issues to product features using embeddings |
| `label_github_issues` | Detect and assign labels (bug, security, regression, etc.) to issues |
| `match_issues_to_threads` | Match GitHub issues to related Discord threads |

### Thread-Centric Workflow Tools

| Tool | Description |
|------|-------------|
| `classify_discord_messages` | Classify Discord messages with GitHub issues (auto-syncs first) |
| `suggest_grouping` | Group threads by matched issues (runs classification if needed) |
| `match_groups_to_features` | Map thread groups to product features |

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

### Embedding Tools

| Tool | Description |
|------|-------------|
| `compute_discord_embeddings` | Pre-compute embeddings for Discord threads |
| `compute_github_issue_embeddings` | Pre-compute embeddings for GitHub issues |
| `compute_feature_embeddings` | Compute embeddings for product features with code context |

### Code Indexing Tools

| Tool | Description |
|------|-------------|
| `index_codebase` | Index code from repository for a specific query |
| `index_code_for_features` | Proactively index code for all features |

### PM Tool Management

| Tool | Description |
|------|-------------|
| `manage_documentation_cache` | Manage documentation cache: `fetch`, `extract_features`, `compute_embeddings`, `list`, `clear` |
| `list_linear_teams` | List Linear teams (for configuration) |
| `validate_pm_setup` | Validate PM tool configuration |

### Linear-Specific Tools

| Tool | Description |
|------|-------------|
| `sync_linear_status` | Sync GitHub issue states to Linear tickets (GitHub -> Linear) |
| `classify_linear_issues` | Classify Linear issues into projects/features |
| `label_linear_issues` | Add missing labels to Linear issues using LLM |

### Validation Tools

| Tool | Description |
|------|-------------|
| `check_github_issues_completeness` | Verify all GitHub issues have been fetched |
| `check_discord_classification_completeness` | Verify all Discord messages have been classified |

## Usage Examples

### Issue-Centric Workflow (Recommended)

```bash
# 1. Fetch GitHub issues
fetch_github_issues

# 2. Group related issues
group_github_issues

# 3. Match issues to product features
match_issues_to_features

# 4. Add labels for priority
label_github_issues

# 5. Export to Linear
export_to_pm_tool
```

### Thread-Centric Workflow

```bash
# 1. Sync and classify Discord messages
sync_and_classify

# 2. Group threads by matched issues
suggest_grouping

# 3. Match groups to features
match_groups_to_features

# 4. Export to Linear
export_to_pm_tool
```

### Documentation Setup

```bash
# 1. Fetch documentation
manage_documentation_cache(action: "fetch")

# 2. Extract features from documentation
manage_documentation_cache(action: "extract_features")

# 3. Compute embeddings
manage_documentation_cache(action: "compute_embeddings")
```

## Using from Another Repository

You can configure UNMute to be available when working in another repository (like Better Auth).

### Setup

Add to `cursor-mcp-config.json` (or `~/.cursor/mcp.json`) in your repository:

```json
{
  "mcpServers": {
    "UnMute": {
      "command": "/absolute/path/to/discord-mcp/run-mcp.sh",
      "env": {
        "DISCORD_TOKEN": "your_discord_bot_token",
        "GITHUB_TOKEN": "your_github_token",
        "GITHUB_OWNER": "your-org",
        "GITHUB_REPO": "your-repo",
        "OPENAI_API_KEY": "your_openai_key",
        "DATABASE_URL": "postgresql://user:password@localhost:5432/unmute_mcp",
        "DOCUMENTATION_URLS": "https://your-docs.com/docs",
        "PM_TOOL_TYPE": "linear",
        "PM_TOOL_API_KEY": "your_linear_api_key",
        "PM_TOOL_TEAM_ID": "your_linear_team_id"
      }
    }
  }
}
```

**Required variables** (minimum):
- `DISCORD_TOKEN` - Discord bot token
- `GITHUB_OWNER` - GitHub org/username
- `GITHUB_REPO` - GitHub repository name

**Recommended variables**:
- `GITHUB_TOKEN` or GitHub App credentials - For higher rate limits
- `OPENAI_API_KEY` - For semantic classification
- `DATABASE_URL` - For production use (PostgreSQL)

See `env.example` for all available variables.

## Project Structure

```
unmute-mcp/
├── src/
│   ├── mcp/               # MCP server and tool handlers
│   ├── connectors/        # External service connectors (GitHub, Discord)
│   ├── core/              # Core business logic (classify, correlate)
│   ├── storage/           # Data persistence (cache, db, json)
│   ├── export/            # PM tool export system (Linear, Jira)
│   ├── sync/              # Status synchronization
│   ├── types/             # Type definitions
│   └── config/            # Configuration
├── scripts/               # CLI utilities
├── docs/                  # Documentation
├── cache/                 # Cached data (gitignored)
├── results/               # Output files (gitignored)
├── prisma/                # Database schema and migrations
└── dist/                  # Compiled output
```

## Documentation

See the `docs/` folder for detailed documentation:

- `GITHUB_INTEGRATION.md`: GitHub authentication setup (Token or GitHub App)
- `DATABASE_SETUP.md`: PostgreSQL database setup
- `LINEAR_GITHUB_CONTRACT.md`: How UNMute integrates with Linear's GitHub integration
- `LINEAR_TEAM_SETUP.md`: Setting up Linear teams and projects
- `explain-permissions.md`: Discord bot permissions setup

## License

MIT License - see [LICENSE](LICENSE) for details.
