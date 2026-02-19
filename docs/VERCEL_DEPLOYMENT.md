# Vercel Deployment Guide

This guide explains how to deploy UNMute to Vercel with automated daily syncing.

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                         UNMute                                   │
├─────────────────────────────────────────────────────────────────┤
│  ┌─────────────┐     ┌─────────────────────────────────┐        │
│  │   MCP       │     │      HTTP API (Vercel)          │        │
│  │  (stdio)    │     │  /api/cron/daily-sync           │        │
│  │             │     │  /api/tools/tool (generic)      │        │
│  │  Cursor,    │     │  /api/tools/sync                │        │
│  │  Claude     │     │  /api/tools/export              │        │
│  │  Desktop    │     │  /api/tools/status              │        │
│  └──────┬──────┘     └──────────────┬──────────────────┘        │
│         │                           │                           │
│         └───────────┬───────────────┘                           │
│                     │                                           │
│           ┌─────────▼─────────┐                                 │
│           │  Core Business    │                                 │
│           │     Logic         │                                 │
│           │  (shared)         │                                 │
│           └───────────────────┘                                 │
└─────────────────────────────────────────────────────────────────┘
```

## Prerequisites

1. **Vercel Pro account** (for 60s function timeout)
2. **PostgreSQL database** (Vercel Postgres, Neon, Supabase, etc.)
3. **Discord Bot Token**
4. **GitHub Token or App**
5. **Linear API Key** (for export)
6. **OpenAI API Key** (for classification)

## Setup Steps

### 1. Install Dependencies

```bash
npm install
```

### 2. Run Database Migrations

```bash
# Apply all migrations including Better Auth tables
npm run db:migrate
```

### 3. Generate Secrets

```bash
# Generate cron secret
openssl rand -base64 32

# Generate API key
openssl rand -base64 32
```

### 4. Configure Environment Variables

Add these to your `.env` file locally and in Vercel Dashboard:

```env
# Required
DATABASE_URL=postgresql://...
CRON_SECRET=<generated secret>
UNMUTE_API_KEY=<generated secret>

# Discord
DISCORD_TOKEN=<your bot token>
DISCORD_DEFAULT_CHANNEL_ID=<channel to sync>

# GitHub  
GITHUB_TOKEN=<your token>
GITHUB_REPO_URL=owner/repo

# Linear (for export)
PM_TOOL_TYPE=linear
PM_TOOL_API_KEY=<your linear api key>

# OpenAI (for classification)
OPENAI_API_KEY=<your openai key>
```

### 5. Deploy to Vercel

```bash
# Install Vercel CLI
npm i -g vercel

# Deploy
vercel

# Or link to existing project
vercel link
vercel --prod
```

### 6. Set Environment Variables in Vercel

Go to your project settings in Vercel Dashboard → Environment Variables and add all the variables from step 4.

## API Endpoints

### Cron Endpoint (Internal)

```
GET/POST /api/cron/daily-sync
```

- **Authentication**: `Authorization: Bearer <CRON_SECRET>` (Vercel adds automatically)
- **Schedule**: Daily at 6 AM UTC (configurable in `vercel.json`)
- **Actions**: 
  1. Sync Discord messages (incremental)
  2. Sync GitHub issues (incremental)
  3. Classify new messages
  4. Export to Linear (if new classifications)

### Generic Tool Endpoint

```
POST /api/tools/tool
```

- **Authentication**: `Authorization: Bearer <UNMUTE_API_KEY>` or `x-api-key: <UNMUTE_API_KEY>`
- **Body**:
  ```json
  {
    "tool": "tool_name",
    "args": { ... }
  }
  ```
- **Example**:
  ```bash
  curl -X POST https://your-app.vercel.app/api/tools/tool \
    -H "Authorization: Bearer $UNMUTE_API_KEY" \
    -H "Content-Type: application/json" \
    -d '{"tool": "group_github_issues", "args": {"min_similarity": 80}}'
  ```
- **List all tools**: `GET /api/tools/tool`

### Manual Sync Endpoint

```
POST /api/tools/sync
```

- **Authentication**: `Authorization: Bearer <UNMUTE_API_KEY>` or `x-api-key: <UNMUTE_API_KEY>`
- **Body** (optional):
  ```json
  {
    "channel_id": "optional_channel_id"
  }
  ```
- **Response**:
  ```json
  {
    "success": true,
    "message": "Sync completed in 5.23s",
    "discord": { "total": 1500, "new_updated": 25, "threads": 5 },
    "github": { "total": 200, "open": 150, "closed": 50, "new_updated": 3 },
    "classification": { "processed": 5, "matched": 3, "below_threshold": 2 }
  }
  ```

### Manual Export Endpoint

```
POST /api/tools/export
```

- **Authentication**: Same as sync
- **Body** (optional):
  ```json
  {
    "channel_id": "optional_channel_id",
    "include_closed": false
  }
  ```
- **Response**:
  ```json
  {
    "success": true,
    "message": "Export completed in 2.15s",
    "issues_created": 5,
    "issues_updated": 2,
    "issues_skipped": 10
  }
  ```

### Status Endpoint

```
GET /api/tools/status
```

- **Authentication**: Same as sync
- **Response**:
  ```json
  {
    "success": true,
    "status": "healthy",
    "statistics": {
      "discord": { "total_messages": 1500, "last_message_at": "..." },
      "github": { "total_issues": 200, "open_issues": 150, "last_updated_at": "..." },
      "classification": { "total_classified": 100, "matched": 75 },
      "export": { "exported_to_linear": 50 }
    }
  }
  ```

## Cron Schedule

The cron job is configured in `vercel.json`:

```json
{
  "crons": [
    {
      "path": "/api/cron/daily-sync",
      "schedule": "0 6 * * *"
    }
  ]
}
```

This runs daily at 6:00 AM UTC. Adjust as needed:

- `"0 6 * * *"` - Daily at 6 AM UTC
- `"0 */6 * * *"` - Every 6 hours
- `"0 9 * * 1-5"` - Weekdays at 9 AM UTC

## Cursor MCP Configuration

**Recommended: Use local MCP for interactive use**

The local MCP server provides the full interactive experience with all tools:

```json
{
  "mcpServers": {
    "unmute": {
      "command": "node",
      "args": ["/path/to/openrundown/dist/index.js"],
      "env": {
        "DISCORD_TOKEN": "${DISCORD_TOKEN}",
        "DATABASE_URL": "${DATABASE_URL}",
        "GITHUB_TOKEN": "${GITHUB_TOKEN}",
        "OPENAI_API_KEY": "${OPENAI_API_KEY}"
      }
    }
  }
}
```

The Vercel deployment handles:
- **Daily cron jobs** - Automated sync without manual intervention
- **HTTP API** - For external integrations or manual triggers

The local MCP handles:
- **Interactive queries** - Ask questions about issues, threads
- **Manual operations** - Trigger specific tools on demand
- **Exploratory work** - Search, filter, analyze

## Monitoring

### Vercel Dashboard

- View cron job execution history
- Check function logs
- Monitor errors

### Custom Logging

All endpoints log to console, which appears in Vercel logs:

```
[Cron] Starting daily sync...
[Workflow] Step 1: Syncing Discord messages...
[Discord] Fetching messages since: 2024-12-29T15:30:00Z
[Discord] Fetched 25 new/updated messages
...
```

## Troubleshooting

### Cron Job Not Running

1. Check Vercel Dashboard → Settings → Cron Jobs
2. Verify `CRON_SECRET` is set in environment variables
3. Check function logs for errors

### API Key Invalid

1. Verify `UNMUTE_API_KEY` is set in environment variables
2. Check the key matches what you're sending in the request
3. Ensure you're using the correct header format

### Function Timeout

- Vercel Pro has 60s limit
- Initial full sync may timeout; run locally first
- Incremental syncs are fast (~5-10 seconds)

### Discord Client Issues

- Discord client initializes on cold start (~2-3s)
- If persistent issues, check `DISCORD_TOKEN` is valid
- Verify bot has correct permissions in channel

## Security Notes

1. **Never expose `CRON_SECRET`** - it's for Vercel internal use only
2. **Keep `UNMUTE_API_KEY` secret** - treat it like a password
3. **Rotate keys periodically** - generate new secrets if compromised
4. **Use HTTPS only** - Vercel enforces this by default

