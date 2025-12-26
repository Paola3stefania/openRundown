# Cache Directory

This directory contains cached data files used for local development and classification.

## Contents

- `github-issues-cache.json` - Cached GitHub issues from the configured repository
- `issue-embeddings-cache.json` - Persistent LLM embeddings for semantic classification
- `discord-messages-{channelId}.json` - Cached Discord messages per channel

## Privacy Notice

⚠️ **Do not commit cache files** - They may contain private data from your Discord server or GitHub repository.

All `.json` files in this directory are gitignored by default.

## Regenerating Cache

Cache files are automatically created/updated when you run:
- `fetch_github_issues` - Updates GitHub issues cache
- `fetch_discord_messages` - Updates Discord messages cache  
- `classify_discord_messages` - Updates both caches before classification

To force a full refresh, delete the cache files and re-run the commands.

