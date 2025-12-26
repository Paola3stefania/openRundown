# GitHub API Rate Limits

## Current Issue

The classification system hit GitHub API rate limits because:

- **Without GitHub token**: 60 requests/hour
- **With GitHub token**: 5000 requests/hour

When analyzing 20+ messages, you'll hit the limit without a token.

## Solution: Add GitHub Token

### Option 1: Add to Cursor Config

Edit `/Users/user/.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "discord": {
      "command": "/Users/user/Projects/discord-mcp/run-mcp.sh",
      "env": {
        "DISCORD_TOKEN": "...",
        "GITHUB_TOKEN": "your_github_token_here"
      }
    }
  }
}
```

### Option 2: Create GitHub Token

1. Go to: https://github.com/settings/tokens
2. Click "Generate new token" → "Generate new token (classic)"
3. Name it: "Discord MCP Classifier"
4. Select scope: **No scope needed** (public repo access is enough)
5. Copy the token
6. Add it to the config above
7. Restart Cursor

### Option 3: Environment Variable

```bash
export GITHUB_TOKEN=your_token_here
```

## Rate Limit Handling

The system now includes:
- **Automatic delays** between requests (2 seconds without token, 200ms with token)
- **Error handling** for rate limit errors
- **Graceful degradation** (continues processing other messages if some fail)

## Recommendations

1. **Small batches first**: Try 5-10 messages to test
2. **Use GitHub token**: For production use, definitely add a token
3. **Process in chunks**: For large channels, process in smaller batches

## Current Status

Without a token, you can process about 30-40 messages before hitting limits (with delays).
With a token, you can process hundreds of messages quickly.

