# Prisma Migrations

This directory contains Prisma migrations for the OpenRundown database.

## Initial Setup

The `0_init` migration contains the baseline schema. Since the database already exists with this schema, it has been marked as applied.

## Using Migrations

### Mark Initial Migration as Applied

Since your database already has the schema, mark the initial migration as applied:

```bash
DATABASE_URL=postgresql://user@localhost:5432/openrundown npx prisma migrate resolve --applied 0_init
```

### Create New Migrations

For future schema changes:

```bash
# 1. Update prisma/schema.prisma
# 2. Create migration
DATABASE_URL=postgresql://user@localhost:5432/openrundown npx prisma migrate dev --name your_migration_name

# 3. Apply in production
DATABASE_URL=postgresql://user@localhost:5432/openrundown npx prisma migrate deploy
```

### Check Migration Status

```bash
DATABASE_URL=postgresql://user@localhost:5432/openrundown npx prisma migrate status
```

## Migration History

- `0_init` - Baseline migration with all tables (channels, classified_threads, groups, embeddings, etc.)
- `20241228200000_add_match_status` - Added match_status field to ClassifiedThread
- `20241228210000_add_export_status` - Added export status fields
- `20251228195349_add_github_issues_table` - Added GitHubIssues table for issue caching
- `20251228202015_add_thread_embeddings_table` - Added ThreadEmbeddings table for semantic search
- `20251228210300_add_discord_messages_table` - Added DiscordMessage table for storing Discord messages

## Quick Reference

**Apply migrations (production):**
```bash
npx prisma migrate deploy
```

**Create new migration (development):**
```bash
npx prisma migrate dev --name descriptive_name
```

**Check migration status:**
```bash
npx prisma migrate status
```

