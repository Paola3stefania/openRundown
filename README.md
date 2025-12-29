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

- Fetch repository issues and comments (with retry mechanism)
- Correlate Discord discussions with GitHub issues
- Cache issues for offline analysis
- Incremental issue updates

### Classification

- **Keyword-based**: Fast, free classification using keyword matching (default when OpenAI not configured)
- **Semantic (LLM-based)**: Context-aware classification using OpenAI embeddings (enabled by default when `OPENAI_API_KEY` is set)
- **Persistent embedding cache with lazy loading**: All embeddings (issues, threads, groups, code sections, features) are cached to database/disk and only recomputed when content changes (contentHash validation)
- **Lazy embedding computation**: Embeddings are computed on-demand and cached. If content hasn't changed (same contentHash), cached embeddings are reused - no redundant API calls
- Thread-aware classification
- Classification history tracking
- Automatically syncs issues and messages before classifying

**Similarity Scales:**

UNMute uses **two different similarity scales** depending on the operation:

1. **Issue Matching (Classification)** — **0-100 scale** (percentage-based)
   - `80-100`: **Strong match** — Thread is very likely related to this issue
   - `60-79`: **Moderate match** — Thread may be related, worth reviewing
   - `40-59`: **Weak match** — Possibly related, but needs verification
   - `0-39`: **Unlikely match** — Probably unrelated
   - **Default threshold: `60`** — Only matches ≥60 are considered for grouping
   - **Recommended tiers:**
     - `min_similarity: 80` — High confidence only (fewer false positives)
     - `min_similarity: 60` — Balanced (default, good precision/recall)
     - `min_similarity: 40` — More inclusive (may include false positives)

2. **Feature Matching (Group-to-Feature)** — **0.0-1.0 scale** (cosine similarity)
   - `0.7-1.0`: **Strong feature match** — Group clearly relates to this feature
   - `0.5-0.7`: **Moderate feature match** — Group may relate to this feature
   - `0.0-0.5`: **Weak feature match** — Unlikely to relate
   - **Default threshold: `0.5`** — Only matches ≥0.5 are considered
   - **Recommended tiers:**
     - `min_similarity: 0.7` — High confidence only
     - `min_similarity: 0.5` — Balanced (default)
     - `min_similarity: 0.3` — More inclusive

### Semantic Grouping

- **Issue-based grouping**: Group threads by their matched GitHub issues (fast, no LLM calls)
- **Feature matching**: Separate step to map groups to product features using three-tier matching:
  - **Rule-based matching**: Keyword/name matching (highest priority, works without embeddings)
  - **Semantic similarity**: Cosine similarity between embeddings (when embeddings available)
  - **Code-based matching**: Function-level code matching using saved code section embeddings (strong signal, works even if group embeddings fail)
- **Cross-cutting detection**: Identify issues affecting multiple product features
- **Shared embedding cache with lazy loading**: All embeddings (groups, threads, issues, code sections, features) are cached and only recomputed when content changes
- **Graceful degradation**: If embedding computation fails, still attempts rule-based and code-based matching
- **Reviewable workflow**: Match groups to features, review, then export

### PM Tool Export

- Extract product features from documentation (URLs or local file paths)
- Map conversations to features using semantic similarity
- Export to Linear, Jira, and other PM tools
- **Documentation fetching**: Supports HTTP/HTTPS URLs and local file paths. For URLs, fetches the page content (basic HTML parsing). **Note:** Complex sites with authentication, JavaScript-rendered content, or robots.txt restrictions may not work.
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
  - Messages are saved in batches to prevent transaction timeouts
  - See [docs/DATABASE_SETUP.md](docs/DATABASE_SETUP.md) for setup

Switch between backends by setting or removing `DATABASE_URL` environment variable.

**Note:** When `DATABASE_URL` is set, all operations automatically save to PostgreSQL instead of JSON files. Database saves are **required** - if the database is unavailable, operations will fail (no silent fallback to JSON). This includes:
- Discord messages → `discord_messages` table
- Classified threads → `classified_threads` table
- Thread-issue matches → `thread_issue_matches` table
- Groups → `groups` table
- Documentation cache → `documentation_cache` table
- Features cache → `features_cache` table
- **Embeddings** (with contentHash for lazy loading):
  - Thread embeddings → `thread_embeddings` table
  - Issue embeddings → `issue_embeddings` table
  - Group embeddings → `group_embeddings` table
  - Code section embeddings → `code_section_embeddings` table (function/class/interface level)
  - Code file embeddings → `code_file_embeddings` table
  - Feature embeddings → `feature_embeddings` table
- **Code indexing**:
  - Code searches → `code_searches` table
  - Code files → `code_files` table
  - Code sections → `code_sections` table (functions, classes, interfaces)
  - Feature-code mappings → `feature_code_mappings` table

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

   **For local usage**: Create a `.env` file in the discord-mcp repository or export these variables.
   
   **For cross-repo usage** (calling from another repository like Better Auth): All environment variables must be in the MCP config's `env` section (see "Using from Another Repository" section below). The MCP server doesn't read `.env` files when called from another repo.

4. **(Optional) Set up PostgreSQL database:**
   
   By default, UNMute uses JSON files for storage. To use PostgreSQL:
   
   ```bash
   # Install PostgreSQL (if not already installed)
   # macOS: brew install postgresql@14
   # Linux: sudo apt-get install postgresql
   # Docker: docker run --name unmute-postgres -e POSTGRES_PASSWORD=password -p 5432:5432 -d postgres:14
   
   # Create database
   createdb unmute_mcp
   
   # Set DATABASE_URL in .env
   DATABASE_URL=postgresql://user:password@localhost:5432/unmute_mcp
   
   # Run migrations to create tables
   npx prisma migrate deploy
   
   # (Optional) Import existing JSON cache files into database
   # This imports: GitHub issues, issue embeddings, and Discord messages
   npm run db:import
   ```
   
   **Importing existing data:**
   
   If you have existing JSON cache files (`cache/github-issues-cache.json`, `cache/issue-embeddings-cache.json`, `cache/discord-messages-*.json`), you can import them into PostgreSQL:
   
   ```bash
   npm run db:import
   ```
   
   This will:
   - Create tables for GitHub issues, issue embeddings, and Discord messages
   - Import all cached GitHub issues
   - Import all issue embeddings
   - Import all Discord messages from cache files
   
   **Setting up documentation and features cache:**
   
   After setting up the database, you can populate the documentation and features cache:
   
   ```bash
   # Using MCP tools (recommended):
   # 1. Fetch documentation
   manage_documentation_cache(action: "fetch")
   
   # 2. Extract features from documentation
   manage_documentation_cache(action: "extract_features")
   
   # 3. Compute embeddings (separate step - not done during fetch)
   manage_documentation_cache(action: "compute_embeddings")
   ```
   
   **Important:** Embeddings are **not** computed automatically when fetching documentation. You must run `compute_embeddings` as a separate step after fetching docs and extracting features.
   
   Or use the MCP tools directly:
   - `manage_documentation_cache` with `action: "fetch"` - Fetches and caches documentation (does NOT compute embeddings)
   - `manage_documentation_cache` with `action: "extract_features"` - Extracts product features from cached documentation
   - `manage_documentation_cache` with `action: "compute_embeddings"` - Computes embeddings for all documentation, sections, and features (requires `OPENAI_API_KEY`)
   - `manage_documentation_cache` with `action: "compute_docs_embeddings"` - Computes embeddings for documentation pages only
   - `manage_documentation_cache` with `action: "compute_sections_embeddings"` - Computes embeddings for documentation sections only
   - `manage_documentation_cache` with `action: "compute_features_embeddings"` - Computes embeddings for features only
   
   See [docs/DATABASE_SETUP.md](docs/DATABASE_SETUP.md) for detailed setup instructions.

5. Configure MCP server in `cursor-mcp-config.json` (or `~/.cursor/mcp.json`)

## Usage

### Fetching GitHub Issues

Use the `fetch_github_issues` MCP tool to fetch and cache GitHub issues. Comments are always fetched with automatic retry on failures.

**Configuration:** Set `GITHUB_TOKEN` or GitHub App credentials (see [docs/GITHUB_INTEGRATION.md](docs/GITHUB_INTEGRATION.md))

### Classifying Discord Messages

The `classify_discord_messages` MCP tool automatically:
1. Fetches/syncs GitHub issues (incremental)
2. Fetches/syncs Discord messages (incremental)
3. Classifies messages with issues

You can also fetch separately:
- `fetch_github_issues`: Fetch and cache GitHub issues (saves to database if `DATABASE_URL` is set)
- `fetch_discord_messages`: Fetch and cache Discord messages (saves to database if `DATABASE_URL` is set, or JSON cache if not)

**Note:** 
- Classification requires cached issues. The classification tool will automatically fetch them if needed.
- When `DATABASE_URL` is set, `fetch_discord_messages` saves messages to PostgreSQL in batches (500 messages per batch) to ensure reliable storage for large datasets.

**Incremental Saving:**
- Processes messages in batches of 50
- Saves results to JSON file **after each batch** (crash-safe)
- Merges new results into existing file if one exists
- Output file: `results/discord-classified-{channelName}-{channelId}-{timestamp}.json`

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

**File Management:**
- Creates a new timestamped file on first run
- Subsequent runs **merge** new groups into the same file (deduplicates by group ID)
- Each run updates the file with newly grouped threads

**Options:**
- `min_similarity`: Minimum similarity score for issue matching (**0-100 scale**, default 60). Only threads with similarity ≥60 are grouped with an issue.
- `max_groups`: Maximum groups to return (optional, no limit if not specified)
- `re_classify`: Force re-classification before grouping
- `semantic_only`: Use pure semantic similarity instead of issue-based grouping

### Matching Groups to Features

After grouping, use `match_groups_to_features` to map groups to product features extracted from documentation:

**Workflow:**
1. Loads grouping results from file
2. Extracts product features from documentation (using `DOCUMENTATION_URLS`)
3. Maps each group to relevant features using **three-tier matching**:
   - **Rule-based**: Feature names/keywords in group text (similarity: 0.8-0.9)
   - **Semantic**: Cosine similarity between group and feature embeddings (0.0-1.0)
   - **Code-based**: Function-level code matching - searches codebase, indexes functions/classes, matches using code section embeddings (0.0-1.0, 90% weight when >0.5)
4. Updates the grouping JSON file with `affects_features` and `is_cross_cutting` flags

```
match_groups_to_features → updates grouping file with feature mappings
```

**Why separate step?**
- **Reviewable**: Inspect matches before exporting
- **Re-matchable**: Update matches without re-exporting
- **Faster grouping**: No feature extraction during grouping
- **Clearer workflow**: Explicit analysis → action separation

**Embedding Performance:**
- **Lazy loading**: Group embeddings are loaded from database if content unchanged (contentHash validation)
- **Code indexing**: Code is indexed at function/class/interface level, embeddings saved to database
- **Reuse**: Code section embeddings are reused if code unchanged - no redundant computation
- **Graceful degradation**: If embedding computation fails, still uses rule-based and code-based matching

**Options:**
- `grouping_data_path`: Path to grouping file (optional, uses latest if not provided)
- `channel_id`: Channel ID to find latest grouping file (if path not provided)
- `min_similarity`: Minimum similarity for feature matching (**0.0-1.0 scale**, default 0.6). Uses cosine similarity between group embeddings and feature embeddings.

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

Use the `export_to_pm_tool` MCP tool to export classified data or grouped issues to Linear, Jira, or other PM tools.

**For Classification Results:**
- Extracts features from documentation
- Maps conversations to features
- Exports to PM tool

**For Grouping Results:**
- **Requires groups to be matched first** using `match_groups_to_features`
- Reads feature mappings from grouping file
- Creates Linear projects for features
- Exports groups as issues

**Complete Workflow:**
```
1. suggest_grouping → Create groups
2. match_groups_to_features → Map groups to features
3. export_to_pm_tool → Export to Linear/Jira
```

Configure `DOCUMENTATION_URLS` in `.env` (can be URLs like `https://docs.example.com/docs` which will be crawled, or local file paths).

## Using from Another Repository (e.g., Better Auth)

You can configure this MCP tool to be available when working in another repository (like Better Auth). This provides powerful benefits:

### Benefits

1. **Full Codebase Context**: When called from within the Better Auth repo, the agent has access to the entire codebase via Cursor's codebase search
2. **Better Matching**: The agent can use semantic code search to find relevant code files and pass them as code context for more accurate feature matching
3. **Real-time Code**: Uses the actual current codebase, not just what's on GitHub

### Setup

1. **Configure MCP in Better Auth repo**:
   
   Add to `cursor-mcp-config.json` (or `~/.cursor/mcp.json`) in the Better Auth repository:
   
   **Important**: All environment variables must be in the MCP config's `env` section. The MCP server doesn't read `.env` files from the discord-mcp repository when called from another repo.
   
   ```json
   {
     "mcpServers": {
       "UnMute": {
         "command": "/absolute/path/to/discord-mcp/run-mcp.sh",
         "env": {
           "DISCORD_TOKEN": "your_discord_bot_token",
           "GITHUB_TOKEN": "your_github_token",
           "GITHUB_OWNER": "better-auth",
           "GITHUB_REPO": "better-auth",
           "OPENAI_API_KEY": "your_openai_key",
           "DATABASE_URL": "postgresql://user:password@localhost:5432/unmute_mcp",
           "DOCUMENTATION_URLS": "https://better-auth.com/docs",
           "GITHUB_REPO_URL": "https://github.com/better-auth/better-auth",
           "PM_TOOL_TYPE": "linear",
           "PM_TOOL_API_KEY": "your_linear_api_key",
           "PM_TOOL_TEAM_ID": "your_linear_team_id"
         }
       }
     }
   }
   ```
   
   **GitHub Authentication:** Use `GITHUB_TOKEN` OR GitHub App credentials:
   - Token: `"GITHUB_TOKEN": "your_token"`
   - GitHub App: `"GITHUB_APP_ID": "...", "GITHUB_APP_INSTALLATION_ID": "...", "GITHUB_APP_PRIVATE_KEY_PATH": "/path/to/app.pem"`
   
   **Required variables** (minimum):
   - `DISCORD_TOKEN` - Discord bot token
   - `GITHUB_OWNER` - GitHub org/username
   - `GITHUB_REPO` - GitHub repository name
   
   **Recommended variables**:
   - `GITHUB_TOKEN` or GitHub App credentials - For higher rate limits (see [docs/GITHUB_INTEGRATION.md](docs/GITHUB_INTEGRATION.md))
   - `OPENAI_API_KEY` - For semantic classification
   - `DATABASE_URL` - For production use (PostgreSQL)
   
   **Optional variables** (for PM integration):
   - `DOCUMENTATION_URLS` - Documentation URLs for feature extraction
   - `GITHUB_REPO_URL` - Repository URL for code context (if not using `code_context` parameter)
   - `PM_TOOL_TYPE`, `PM_TOOL_API_KEY`, `PM_TOOL_TEAM_ID` - For Linear/Jira export
   
   See `env.example` in the discord-mcp repository for all available variables.

2. **Automatic Code Context**:
   
   **The agent automatically handles code context!** When you call `compute_feature_embeddings` from within a codebase (like Better Auth), the agent will:
   
   1. **Automatically use `codebase_search`** to find relevant code files related to the features
   2. **Automatically pass that code context** to the tool via the `code_context` parameter
   3. The code context is available in the agent's conversation memory, so it doesn't need to search again
   
   You don't need to manually search - just call the tool and the agent handles it automatically:
   
   ```typescript
   // Agent automatically does this:
   // 1. Searches codebase for relevant code (authentication, features, etc.)
   // 2. Passes code context to the tool
   await compute_feature_embeddings({
     force: true
     // code_context is automatically added by the agent
   });
   ```
   
   The tool description guides the agent to automatically search for code related to:
   - Core features and functionality
   - Authentication and security
   - Main API routes and handlers
   - Key business logic

### Example Workflow

When classifying Discord messages about Better Auth features:

1. **Agent searches Better Auth codebase** for relevant code:
   - "How does session management work?"
   - "Where is OAuth implemented?"
   - "How are database queries structured?"

2. **Agent calls MCP tool** with code context:
   ```typescript
   compute_feature_embeddings({
     code_context: "// Session management code...\n// OAuth implementation...\n// etc."
   })
   ```

3. **Feature embeddings** now include actual code context, leading to:
   - More accurate matching between Discord threads and features
   - Better understanding of what each feature actually does
   - Improved grouping and classification

### Code Context Parameter

The `compute_feature_embeddings` tool accepts an optional `code_context` parameter:

- **When provided**: Uses the provided code context (from agent's codebase search)
- **When not provided**: Falls back to fetching from GitHub API (if `GITHUB_REPO_URL` is configured)
- **Size limit**: Automatically truncated to 10,000 characters to avoid token limits

This gives you the best of both worlds: accurate code context when available, with fallback to GitHub API when not.

## MCP Tools (Stable API)

These tool names are **stable** and will not change. Semantics may evolve, but names are fixed. New tools are additive only.

### Primary Entry Point

**Start here:** `sync_and_classify` — Full workflow: sync messages, sync issues, classify. This is the recommended entry point for most users.

### Core Workflow Tools

| Tool | Description |
|------|-------------|
| `sync_and_classify` | **Primary entry point** — Full workflow: sync messages, sync issues, classify |
| `classify_discord_messages` | Classify messages with GitHub issues (auto-syncs first) |
| `suggest_grouping` | Group threads by matched issues (runs classification if needed) |
| `match_groups_to_features` | Map groups to product features using semantic similarity |
| `export_to_pm_tool` | Export classified data or grouped issues to Linear, Jira |

### Building Block Tools

These tools are used internally by the workflow tools, but can also be called directly for advanced use cases:

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
| `manage_documentation_cache` | Manage documentation cache: `fetch` (fetch docs), `extract_features` (extract features), `compute_embeddings` (compute all embeddings), `compute_docs_embeddings` (docs only), `compute_sections_embeddings` (sections only), `compute_features_embeddings` (features only), `list` (list cached docs), `clear` (clear cache) |
| `compute_feature_embeddings` | Compute embeddings for product features with code context. Accepts optional `code_context` parameter for passing code from agent's codebase search (recommended when called from within a repository). Also accepts `force` to recompute all embeddings. |
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
│   ├── grouping-*.json                # Grouping results (with feature mappings)
│   ├── classification-history.json   # Classification tracking
│   └── export-*.json                 # PM export history
├── dist/                  # Compiled output
└── package.json
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
