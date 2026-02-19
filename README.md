# OpenRundown

**Project context and session memory for AI agents.** OpenRundown distills signals from Discord, GitHub, and past agent sessions into structured briefings so agents never start blind.

## What It Does

### Agent Briefing System
- Generates compact **project context** (~300-500 tokens) at session start
- Tracks **agent sessions** with decisions, files edited, and open items
- Passes **open items** from one session to the next automatically
- Scopes briefings dynamically based on what the agent is working on

### Understands Your Product
- Scans your **entire codebase** via git blame to know who owns what
- Parses your **documentation** to extract product features
- Computes **semantic embeddings** for intelligent matching

### Collects Feedback
- Fetches **GitHub issues** with all comments
- Fetches **Discord messages** from support channels
- Tracks **Pull Requests** linked to issues

### Organizes Everything
- **Groups** related issues together (1 Linear ticket per problem, not per report)
- **Matches** Discord threads to GitHub issues they're discussing
- **Maps** issues to product features based on content
- **Detects labels** (bug, security, regression, enhancement) using AI
- **Removes duplicates** automatically

### Prioritizes Intelligently  
- **Urgent**: Security issues, bugs, regressions
- **High**: Many community reports (5+ threads)
- **Medium**: Feature requests, enhancements
- **Low**: Questions, documentation

### Assigns & Syncs
- **Recommends assignees** based on code ownership percentages
- **Auto-assigns** when engineer comments on issue or opens PR
- **Sets "In Progress"** when PR is opened
- **Sets "Done"** when PR is merged or issue is closed
- **Adds PR links** to Linear descriptions

### Generates Fixes (AI-Powered)
- **Investigates issues** - Gathers full context, triages bug vs config vs feature
- **Learns from history** - Finds similar closed issues and their merged PRs
- **Generates fixes** - AI creates fix based on context and similar fixes
- **Opens draft PRs** - Creates properly formatted PRs following project conventions
- **Updates Linear** - Adds PR link and status updates automatically

### Exports to Linear
- Creates issues with rich descriptions (GitHub link, Discord threads, PRs)
- Organizes into **projects** matching your features
- Formats titles with **last activity** ("3 days ago - Issue title")
- Keeps everything in sync incrementally

One command does it all:
```bash
sync_classify_and_export
```

---

## Setup

1. Install: `npm install && npm run build`
2. Configure: Copy `env.example` to `.env` and set:
   - `DISCORD_TOKEN` (required)
   - `GITHUB_OWNER`, `GITHUB_REPO`, `GITHUB_TOKEN` (required)
   - `OPENAI_API_KEY` (optional, for semantic classification)
   - `DATABASE_URL` (optional, for PostgreSQL storage)
   - `PM_TOOL_*` (optional, for Linear/Jira export)
   - `LOCAL_REPO_PATH` (optional, for code ownership and PR fix tools)
3. Database (optional): `createdb openrundown && npx prisma migrate deploy`

See `cursor-mcp-config.json.example` for MCP configuration.

## Quick Start

**Recommended: Use the complete workflow:**
```bash
sync_classify_and_export  # Does everything: fetch -> embed -> group -> label -> match -> export -> sync
```

This single tool runs the complete workflow:
1. Fetch GitHub issues
2. Check Discord messages
3. Compute all embeddings (issues, threads, features, groups)
4. Group related issues
5. Match Discord threads to issues
6. Label issues
7. Match to features (ungrouped issues, grouped issues, and groups)
8. Export to Linear
9. Sync Linear status
10. Sync PR-based status

## All Tools

### Complete Workflow
- `sync_classify_and_export` - **Complete workflow** (recommended): Fetch, compute embeddings, group, label, match features, export, sync status

### Agent Briefing
- `get_agent_briefing` - Get project context briefing for the current session
- `start_agent_session` - Start tracking an agent work session
- `update_agent_session` - Record mid-session progress
- `end_agent_session` - End session with decisions, files edited, open items
- `get_session_history` - Get recent session history

### Data Fetching
- `fetch_github_issues` - Fetch and cache GitHub issues (incremental)
- `fetch_discord_messages` - Fetch and cache Discord messages (incremental)

### Discovery
- `list_servers` - List Discord servers
- `list_channels` - List Discord channels
- `list_linear_teams` - List Linear teams
- `read_messages` - Read messages from a channel
- `search_messages` - Search Discord messages
- `search_github_issues` - Search GitHub issues
- `search_discord_and_github` - Search both Discord and GitHub

### Grouping & Classification
- `group_github_issues` - Group related GitHub issues (issue-centric)
- `suggest_grouping` - Group Discord threads by matched issues (thread-centric)
- `classify_discord_messages` - Classify Discord messages with GitHub issues

### Feature Matching
- `match_issues_to_features` - Match GitHub issues to product features
- `match_ungrouped_issues_to_features` - Match ungrouped issues to features
- `match_database_groups_to_features` - Match groups to features (issue-centric)
- `match_groups_to_features` - Match groups to features (thread-centric, JSON-based)

### Thread/Issue Matching
- `match_issues_to_threads` - Match GitHub issues to Discord threads

### Labeling
- `label_github_issues` - Detect and assign labels to GitHub issues (bug, security, etc.)
- `label_linear_issues` - Add labels to Linear issues

### Embeddings
- `compute_discord_embeddings` - Compute Discord thread embeddings
- `compute_github_issue_embeddings` - Compute GitHub issue embeddings
- `compute_feature_embeddings` - Compute feature embeddings (with code context)
- `compute_group_embeddings` - Compute group embeddings

### Code Indexing
- `index_codebase` - Index code for a specific query
- `index_code_for_features` - Index code for all features

### Code Ownership
- `analyze_code_ownership` - Analyze git blame to determine code ownership by engineer
- `view_feature_ownership` - View feature ownership table (who owns what % of each feature)

### Documentation
- `manage_documentation_cache` - Manage documentation cache (fetch, extract features, compute embeddings, list, clear)

### Export & Sync
- `export_to_pm_tool` - Export to Linear/Jira (use `update_descriptions=true` to add recommended assignees based on code ownership)
- `sync_linear_status` - Sync GitHub -> Linear (closed/merged -> Done)
- `sync_pr_based_status` - Sync PRs -> Linear (open PRs -> In Progress with assignee)
- `sync_combined` - Combined sync (PR sync + status sync)

### Linear Management
- `classify_linear_issues` - Classify Linear issues into projects/features

### Validation & Stats
- `validate_pm_setup` - Validate PM tool configuration
- `validate_export_sync` - Compare DB export tracking with Linear issues
- `export_stats` - View comprehensive statistics
- `check_github_issues_completeness` - Verify all issues fetched
- `check_discord_classification_completeness` - Verify all messages classified

### PR Fix Tools (AI-Powered)
- `fix_github_issue` - **Full workflow**: Investigate issue -> AI generates fix -> Open draft PR
- `seed_pr_learnings` - One-time: Populate learning DB with historical closed issues + merged PRs
- `learn_from_pr` - Learn from a specific merged PR
- `investigate_issue` - Gather issue context, triage, find similar historical fixes
- `open_pr_with_fix` - Create branch, commit changes, push, open draft PR

**Workflow:**
```
# One-time setup: Seed the learning database
seed_pr_learnings()

# For each issue you want to fix:
# Step 1: Investigate (returns context for AI to generate fix)
fix_github_issue(issue_number: 1234)

# Step 2: AI generates fix based on context, then apply it
fix_github_issue(issue_number: 1234, fix: { file_changes: [...], ... })
```

See [PR Fix Tool Documentation](docs/OPEN_PR_WITH_FIX_TOOL.md) for details.

## Documentation

- [Environment Variables](docs/ENVIRONMENT_VARIABLES.md)
- [Database Setup](docs/DATABASE_SETUP.md)
- [GitHub Integration](docs/GITHUB_INTEGRATION.md)
- [Linear Setup](docs/LINEAR_TEAM_SETUP.md)
- [PR Fix Tool](docs/OPEN_PR_WITH_FIX_TOOL.md) - AI-powered fix generation
