# Environment Variables Reference

This document lists all environment variables used by OpenRundown MCP Server, organized by category.

## Required Variables

### Core Configuration

| Variable | Description | Example |
|----------|-------------|---------|
| `DISCORD_TOKEN` | Discord bot token | `MTIzNDU2Nzg5MDEyMzQ1Njc4OQ.XXXXXX.XXXXXX` |
| `GITHUB_REPO_URL` | GitHub repository (owner/repo format) | `better-auth/better-auth` |
| `GITHUB_TOKEN` | GitHub Personal Access Token | `ghp_xxxxxxxxxxxx` |
| **OR** | | |
| `GITHUB_APP_ID` | GitHub App ID | `123456` |
| `GITHUB_APP_INSTALLATION_ID` | GitHub App Installation ID | `789012` |
| `GITHUB_APP_PRIVATE_KEY_PATH` | Path to GitHub App private key | `/path/to/app.pem` |

> **Note**: You can use either `GITHUB_TOKEN` OR GitHub App credentials. Using both enables automatic token rotation.

### Database (Recommended for Production)

| Variable | Description | Example |
|----------|-------------|---------|
| `DATABASE_URL` | PostgreSQL connection string | `postgresql://user:pass@host:5432/dbname` |

> **Note**: If not set, the system uses JSON file storage (try-it-out mode) with default limits.

### Vercel Deployment

| Variable | Description | How to Generate |
|----------|-------------|-----------------|
| `CRON_SECRET` | Secret for Vercel cron authentication | `openssl rand -base64 32` |
| `OPENRUNDOWN_API_KEY` | API key for HTTP endpoints | `openssl rand -base64 32` |

## Optional Variables

### Discord Configuration

| Variable | Description | Default |
|----------|-------------|---------|
| `DISCORD_SERVER_ID` | Default Discord server ID | None |
| `DISCORD_DEFAULT_CHANNEL_ID` | Default channel ID for operations | None |
| `DISCORD_CHANNEL_DEVELOPMENT` | Custom channel name | `development` |
| `DISCORD_CHANNEL_GENERAL` | Custom channel name | `general` |
| `DISCORD_CHANNEL_CHAT` | Custom channel name | `chat` |

### GitHub Configuration

| Variable | Description | Default |
|----------|-------------|---------|
| `GITHUB_OWNER` | Repository owner (auto-extracted from GITHUB_REPO_URL if not set) | Auto |
| `GITHUB_REPO` | Repository name (auto-extracted from GITHUB_REPO_URL if not set) | Auto |
| `LOCAL_REPO_PATH` | Local repository path for faster code indexing | None |

### Storage Configuration

| Variable | Description | Default |
|----------|-------------|---------|
| `STORAGE_BACKEND` | Storage backend: `auto`, `json`, `db` | `auto` |
| `DEFAULT_FETCH_LIMIT_ISSUES` | Max issues when using JSON storage | `100` |
| `DEFAULT_FETCH_LIMIT_MESSAGES` | Max messages when using JSON storage | `100` |

### Classification & AI

| Variable | Description | Default |
|----------|-------------|---------|
| `OPENAI_API_KEY` | OpenAI API key for semantic classification | None (required for classification) |
| `OPENAI_EMBEDDING_MODEL` | OpenAI embedding model | `text-embedding-3-small` |
| `USE_SEMANTIC_CLASSIFICATION` | Enable semantic classification | `true` (if OPENAI_API_KEY set) |

### PM Tool Integration (Linear/Jira)

| Variable | Description | Required For |
|----------|-------------|--------------|
| `PM_TOOL_TYPE` | PM tool type: `linear`, `jira`, `github`, `custom` | All PM features |
| `PM_TOOL_API_KEY` | PM tool API key | All PM features |
| `PM_TOOL_API_URL` | PM tool API URL | Jira (optional for Linear) |
| `PM_TOOL_TEAM_ID` | Team ID or Key | Linear (auto-created if not set) |
| `PM_TOOL_WORKSPACE_ID` | Workspace ID | Jira |
| `PM_TOOL_BOARD_ID` | Board ID | Jira |
| `DOCUMENTATION_URLS` | Comma-separated documentation URLs | Feature extraction |
| `FEATURE_EXTRACTION_ENABLED` | Enable feature extraction | `true` |
| `FEATURE_AUTO_UPDATE` | Auto-update features from docs | `false` |

### File Paths

| Variable | Description | Default |
|----------|-------------|---------|
| `RESULTS_DIR` | Results directory | `results` |
| `CACHE_DIR` | Cache directory | `cache` |
| `ISSUES_CACHE_FILE` | GitHub issues cache filename | `github-issues-cache.json` |

## Environment Setup by Use Case

### 1. Local Development (MCP Server)

**Minimum Required:**
```env
DISCORD_TOKEN=your_token
GITHUB_TOKEN=your_token
GITHUB_REPO_URL=owner/repo
```

**Recommended:**
```env
DISCORD_TOKEN=your_token
GITHUB_TOKEN=your_token
GITHUB_REPO_URL=owner/repo
DATABASE_URL=postgresql://...
OPENAI_API_KEY=your_key
DISCORD_DEFAULT_CHANNEL_ID=channel_id
```

### 2. Production (Vercel Deployment)

**Required:**
```env
# Core
DISCORD_TOKEN=your_token
GITHUB_TOKEN=your_token
GITHUB_REPO_URL=owner/repo
DATABASE_URL=postgresql://...

# Vercel
CRON_SECRET=generated_secret
OPENRUNDOWN_API_KEY=generated_secret

# Optional but recommended
OPENAI_API_KEY=your_key
PM_TOOL_TYPE=linear
PM_TOOL_API_KEY=your_linear_key
PM_TOOL_TEAM_ID=team_id
DOCUMENTATION_URLS=https://docs.example.com/docs
```

### 3. Full Feature Set (All Features Enabled)

```env
# Core
DISCORD_TOKEN=your_token
GITHUB_APP_ID=your_app_id
GITHUB_APP_INSTALLATION_ID=your_installation_id
GITHUB_APP_PRIVATE_KEY_PATH=/path/to/app.pem
GITHUB_REPO_URL=owner/repo
LOCAL_REPO_PATH=/path/to/repo

# Database
DATABASE_URL=postgresql://...

# Discord
DISCORD_SERVER_ID=server_id
DISCORD_DEFAULT_CHANNEL_ID=channel_id

# AI/Classification
OPENAI_API_KEY=your_key
OPENAI_EMBEDDING_MODEL=text-embedding-3-small
USE_SEMANTIC_CLASSIFICATION=true

# PM Tool (Linear)
PM_TOOL_TYPE=linear
PM_TOOL_API_KEY=your_linear_key
PM_TOOL_TEAM_ID=team_id
DOCUMENTATION_URLS=https://docs.example.com/docs,https://docs.example.com/api
FEATURE_EXTRACTION_ENABLED=true
FEATURE_AUTO_UPDATE=false

# Vercel
CRON_SECRET=generated_secret
OPENRUNDOWN_API_KEY=generated_secret

# Paths
RESULTS_DIR=results
CACHE_DIR=cache
```

## Quick Setup Commands

### Generate Secrets
```bash
# Generate CRON_SECRET
openssl rand -base64 32

# Generate OPENRUNDOWN_API_KEY
openssl rand -base64 32
```

### Copy Template
```bash
cp env.example .env
# Then edit .env with your values
```

## Variable Priority

1. **Environment variables** (highest priority)
2. **Default values** (as shown in tables above)
3. **Auto-detection** (e.g., GITHUB_OWNER/REPO from GITHUB_REPO_URL)

## Validation

The system validates required variables at startup. Missing required variables will cause the server to fail with a clear error message.

## Security Notes

- **Never commit `.env` files** to version control
- **Rotate secrets periodically** (especially CRON_SECRET and OPENRUNDOWN_API_KEY)
- **Use Vercel Environment Variables** for production deployments
- **Limit API key permissions** (GitHub tokens should have minimal required scopes)

