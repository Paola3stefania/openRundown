# Results Directory

This directory contains output files from classification and export workflows.

## Contents

- `discord-classified-{channelId}.json` - Classification results mapping Discord messages to GitHub issues
- `classification-history.json` - Tracks which messages/threads have been classified
- `export-{pmTool}-{timestamp}.json` - PM tool export history (Linear, Jira, etc.)

## Privacy Notice

⚠️ **Do not commit results files** - They may contain private data from your Discord server or GitHub repository.

All `.json` files in this directory are gitignored by default.

## Regenerating Results

Results are created when you run:
- `classify_discord_messages` - Creates classification results
- `export_to_pm_tool` - Creates export history

