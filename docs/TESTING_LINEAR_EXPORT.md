# Testing Linear Export

## Prerequisites

Set required environment variables in `.env`:

```bash
PM_INTEGRATION_ENABLED=true
PM_TOOL_TYPE=linear
PM_TOOL_API_KEY=your_linear_api_key_here  # Get from https://linear.app/settings/api
PM_TOOL_TEAM_ID=your_team_id  # Optional: auto-creates "UNMute" team if not set
DOCUMENTATION_URLS=https://docs.example.com/docs  # Required for feature extraction
OPENAI_API_KEY=your_openai_key
DISCORD_TOKEN=your_discord_token
GITHUB_TOKEN=your_github_token
GITHUB_OWNER=your-org
GITHUB_REPO=your-repo
DISCORD_DEFAULT_CHANNEL_ID=your_channel_id
```

**Test Data Required:**
- Classified Discord messages (`results/discord-classified-*.json`)
- Accessible documentation URLs

## Testing Steps

### 1. Validate Setup
```bash
npm run validate-linear
```
Checks environment variables, API keys, and classified data.

### 2. Prepare Classified Data
Run classification workflow:
- `fetch_discord_messages` → `fetch_github_issues` → `classify_discord_messages`
- Or use `sync_and_classify` MCP tool
- Verify `results/discord-classified-{channelId}.json` exists

### 3. Run Export
Use `export_to_pm_tool` MCP tool. This will:
1. Fetch documentation and extract features
2. Map issues to features
3. Create Linear Projects (one per feature)
4. Create/verify Linear team (auto-creates "UNMute" if needed)
5. Create Linear Issues linked to projects

### 4. Verify in Linear
Check workspace for:
- "UNMute" team (or configured team)
- Projects named after features
- Issues linked to projects with Discord/GitHub source links

### 5. Test PR Linking (Optional)
- Create PR with `Resolves LIN-{number}` in description
- Verify Linear links PR and updates status (if auto-close enabled)

## Troubleshooting

| Issue | Solution |
|-------|----------|
| "Linear API key is required" | Set `PM_TOOL_API_KEY` in `.env` |
| "No documentation URLs configured" | Set `DOCUMENTATION_URLS` in `.env` |
| "Classified data file not found" | Run classification first |
| "Failed to create Linear project" | Check API key permissions |
| Projects created but no issues | Check export logs for mapping errors |
| Team not auto-created | Ensure API key has admin permissions |

## Checklist

- [ ] Environment variables configured
- [ ] Classified data exists
- [ ] Export completes successfully
- [ ] Team, projects, and issues created in Linear
- [ ] PR linking works with `Resolves LIN-{number}` format

