# Security Notes

## Token Management

This tool requires sensitive credentials that should **NEVER** be committed to version control:

### Required Tokens

1. **DISCORD_TOKEN** - Discord bot token
   - Get from: https://discord.com/developers/applications
   - Required for all Discord operations

2. **GITHUB_TOKEN** (optional but recommended)
   - Get from: https://github.com/settings/tokens
   - Recommended for higher API rate limits (5000/hour vs 60/hour)

### Security Best Practices

1. **Never commit tokens to git**
   - All sensitive files are in `.gitignore`:
     - `.env` - Contains your tokens
     - `cursor-mcp-config.json` - May contain tokens
     - `results/` - May contain cached data

2. **Use environment variables**
   - Store tokens in `.env` file (not committed)
   - Or set as environment variables in your shell/system

3. **Rotate tokens if exposed**
   - If a token is ever committed, immediately revoke and regenerate it
   - Discord: Revoke in Discord Developer Portal
   - GitHub: Revoke in GitHub Settings → Developer settings → Personal access tokens

4. **Use minimal permissions**
   - Discord bot: Only grant necessary intents (Guilds, Messages, MessageContent)
   - GitHub token: Only grant `public_repo` scope (or specific repo access)

5. **Don't share tokens**
   - Each user should have their own tokens
   - Use `.env.example` as a template, not with real values

### Files to Never Commit

- `.env` - Your local environment variables
- `cursor-mcp-config.json` - Your local Cursor MCP configuration
- `results/*.json` - Generated cache files (may contain issue data)

### Example Setup

1. Copy the example file:
   ```bash
   cp env.example .env
   ```

2. Edit `.env` with your tokens (never commit this file)

3. For Cursor MCP, manually set tokens in `cursor-mcp-config.json` or your global MCP config

